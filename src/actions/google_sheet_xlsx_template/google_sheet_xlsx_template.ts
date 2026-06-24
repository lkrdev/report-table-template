import * as ExcelJS from "exceljs"
import { GaxiosResponse } from "gaxios"
import { Credentials, OAuth2Client } from "google-auth-library"
import { drive_v3, google } from "googleapis"
import * as oboe from "oboe"
import * as https from "request-promise-native"
import { Readable } from "stream"
import * as winston from "winston"
import Drive = drive_v3.Drive
import { getHttpErrorType } from "../../error_types/utils"
import * as Hub from "../../hub"
import { Error, errorWith } from "../../hub/action_response"
import { DomainValidator } from "./domain_validator"

const sanitizeFilename = require("sanitize-filename")
const LOG_PREFIX = "[GOOGLE_SHEET_XLSX_TEMPLATE]"
const FOLDERID_REGEX = /\/folders\/(?<folderId>[^\/?]+)/

interface OauthState {
  tokenurl?: string
  stateurl?: string
}

export class GoogleSheetXlsxTemplateAction extends Hub.OAuthActionV2 {
  name = "google-sheet-xlsx-template"
  label = "Google Sheets Excel Template"
  iconName = "google_sheet_xlsx_template/xlsx_icon.svg"
  description = "Generate an Excel spreadsheet from a template using dynamic data."
  supportedActionTypes = [Hub.ActionType.Query]
  supportedFormats = [Hub.ActionFormat.JsonDetailLiteStream]
  executeInOwnProcess = true
  usesStreaming = true
  usesCsrfProtection = true
  minimumSupportedLookerVersion = "7.3.0"
  requiredFields = []
  params = [
    {
      name: "domain_allowlist",
      label: "Domain Allowlist",
      required: false,
      sensitive: false,
      description:
        "Comma separated domain allowlist ex: facts.com,car.com.",
    },
  ]

  async execute(request: Hub.ActionRequest) {
    const resp = new Hub.ActionResponse()

    if (!request.params.state_json) {
      winston.info("No state json found", { webhookId: request.webhookId })
      resp.success = false
      resp.message = "No state found with oauth credentials."
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
      return resp
    }

    const stateJson = JSON.parse(request.params.state_json)

    if (stateJson.tokens && stateJson.redirect) {
      await this.validateUserInDomainAllowlist(
        request.params.domain_allowlist,
        stateJson.redirect,
        stateJson.tokens,
        request.webhookId,
      ).catch((error) => {
        winston.info(error + " - invalidating token", {
          webhookId: request.webhookId,
        })
        resp.success = false
        resp.state = new Hub.ActionState()
        resp.message = "User Domain validation failed"
        resp.state.data = "reset"
        return resp
      })

      const drive = await this.driveClientFromRequest(
        stateJson.redirect,
        stateJson.tokens,
      )

      try {
        // 1. Harvest stream data in memory
        winston.info(`${LOG_PREFIX} Harvesting stream from Looker`, { webhookId: request.webhookId })
        let fields: any = null
        let appliedFilters: any = null
        const data: any[] = []

        await request.stream(async (downloadStream: Readable) => {
          return new Promise<void>((streamResolve, streamReject) => {
            oboe(downloadStream)
              .node({
                "!.fields": (fieldData: any) => {
                  fields = fieldData
                  return oboe.drop
                },
                "!.applied_filters": (filters: any) => {
                  appliedFilters = filters
                  return oboe.drop
                },
                "!.data.*": (row: any) => {
                  data.push(row)
                  return oboe.drop
                },
              })
              .done(() => {
                winston.info(`${LOG_PREFIX} Harvested ${data.length} rows of data`, { webhookId: request.webhookId })
                streamResolve()
              })
              .fail((errorReport: any) => {
                streamReject(new Error(`Stream parse error: ${errorReport.message || JSON.stringify(errorReport)}`))
              })
          })
        })

        // 2. Setup resolution context
        const context = {
          webhookId: request.webhookId,
          lookerVersion: request.lookerVersion,
          type: request.type,
          params: request.params,
          formParams: request.formParams,
          scheduledPlan: request.scheduledPlan,
          fields,
          appliedFilters,
          data,
          _built_in: {
            run_at: new Date().toISOString(),
            title: request.scheduledPlan?.title ? request.scheduledPlan.title : "Report",
            description: "",
          },
        }

        // 3. Resolve filename
        const errors = new Set<string>()
        const suggestedFilename = request.suggestedFilename()
        const rawFilename = request.formParams.filename
          ? request.formParams.filename
          : (suggestedFilename ? suggestedFilename : "Report")
        const resolvedFilename = this.resolveString(rawFilename, context, undefined, errors)
        const sanitizedFilename = sanitizeFilename(resolvedFilename)

        // 4. Load Excel template
        if (!request.formParams.template_file_id) {
          throw new Error("No template file selected.")
        }
        winston.info(`${LOG_PREFIX} Downloading template from Google Drive (ID: ${request.formParams.template_file_id})`, {
          webhookId: request.webhookId,
        })
        const templateResponse = await drive.files.get(
          {
            fileId: request.formParams.template_file_id,
            alt: "media",
          },
          { responseType: "stream" },
        )
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.read(templateResponse.data)

        // 5. Populate template with data
        winston.info(`${LOG_PREFIX} Populating Excel template`, { webhookId: request.webhookId })
        this.populateTemplate(workbook, context, errors)

        if (errors.size > 0) {
          winston.info(
            `${LOG_PREFIX} Creating _errors sheet with ${errors.size} errors`,
            { webhookId: request.webhookId },
          )
          const errorsSheet = workbook.addWorksheet("_errors")
          Array.from(errors).forEach((err) => {
            errorsSheet.addRow([`Could not find ${err}`])
          })
        }

        // 6. Write to Buffer
        const outputBuffer = await workbook.xlsx.writeBuffer()

        // 7. Determine destination folder
        let folder: string | undefined
        if (request.formParams.folderid) {
          if (request.formParams.folderid.includes("my-drive")) {
            folder = "root"
          } else {
            const match = request.formParams.folderid.match(FOLDERID_REGEX)
            if (match && match.groups) {
              folder = match.groups.folderId
            } else {
              folder = "root"
            }
          }
        } else {
          folder = request.formParams.folder
        }

        // 8. Upload to Google Drive
        winston.info(
          `${LOG_PREFIX} Uploading to Google Drive as ${sanitizedFilename}`,
          { webhookId: request.webhookId },
        )
        const fileMetadata: drive_v3.Schema$File = {
          name: sanitizedFilename.endsWith(".xlsx") ? sanitizedFilename : `${sanitizedFilename}.xlsx`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          parents: folder ? [folder] : undefined,
        }

        const driveParams: drive_v3.Params$Resource$Files$Create = {
          requestBody: fileMetadata,
          media: {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: Readable.from([outputBuffer]),
          },
          fields: "id",
        }

        if (
          request.formParams.drive !== undefined &&
          request.formParams.drive !== "mydrive"
        ) {
          driveParams.requestBody!.driveId! = request.formParams.drive
          driveParams.supportsAllDrives = true
        }

        const file = await drive.files.create(driveParams)
        winston.info(
          `${LOG_PREFIX} File uploaded successfully with ID: ${file.data.id}`,
          { webhookId: request.webhookId },
        )

        resp.success = true
        resp.message = `Successfully uploaded spreadsheet ${sanitizedFilename} to Google Drive`
      } catch (e: any) {
        this.sanitizeGaxiosError(e)

        const errorType = getHttpErrorType(e, this.name)
        let error: Error = errorWith(
          errorType,
          `${LOG_PREFIX} ${e.toString()}`,
        )

        if (e.code && e.errors && e.errors[0] && e.errors[0].message) {
          error = {
            ...error,
            http_code: e.code,
            message: `${errorType.description} ${LOG_PREFIX} ${e.errors[0].message}`,
          }
          resp.message = e.errors[0].message
        } else {
          resp.message = e.toString()
        }

        resp.success = false
        resp.webhookId = request.webhookId
        resp.error = error
        winston.error(`${error.message}`, {
          error,
          webhookId: request.webhookId,
        })
      }
    } else {
      winston.info("Request did not have oauth tokens present", {
        webhookId: request.webhookId,
      })
      resp.success = false
      resp.message =
        "Request did not have necessary oauth tokens saved. Fast failing"
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
    }
    return resp
  }

  async form(request: Hub.ActionRequest) {
    const form = new Hub.ActionForm()

    if (request.params.state_json) {
      try {
        const tokenPayload = await this.oauthExtractTokensFromStateJson(
          request.params.state_json,
          request.webhookId,
        )
        if (tokenPayload) {
          await this.validateUserInDomainAllowlist(
            request.params.domain_allowlist,
            tokenPayload.redirect,
            tokenPayload.tokens,
            request.webhookId,
          ).catch((error) => {
            winston.info(error + " - invalidating token", {
              webhookId: request.webhookId,
            })
            form.state = new Hub.ActionState()
            form.state.data = "reset"
            throw "Domain Verification Failed"
          })

          const drive = await this.driveClientFromRequest(
            tokenPayload.redirect,
            tokenPayload.tokens,
          )

          const paginatedDrives = await this.getDrives(
            drive,
            [],
            await drive.drives.list({ pageSize: 50 }),
          )
          const driveSelections = paginatedDrives
            .filter(
              (_drive) =>
                !(_drive.id === undefined) && !(_drive.name === undefined),
            )
            .map((folder) => ({ name: folder.id!, label: folder.name! }))
          driveSelections.unshift({ name: "mydrive", label: "My Drive" })

          form.fields.push({
            description: "Google Drive where your Excel file will be saved",
            label: "Select Drive to save file",
            name: "drive",
            options: driveSelections,
            default: driveSelections[0].name,
            interactive: true,
            required: true,
            type: "select",
          })

          let folders: any[] = []
          if (request.formParams.fetchpls) {
            const options: any = {
              fields: "files(id,name,parents),nextPageToken",
              orderBy: "recency desc",
              pageSize: 1000,
              q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
              spaces: "drive",
            }
            if (
              request.formParams.drive !== undefined &&
              request.formParams.drive !== "mydrive"
            ) {
              options.driveId = request.formParams.drive
              options.includeItemsFromAllDrives = true
              options.supportsAllDrives = true
              options.corpora = "drive"
            } else {
              options.corpora = "user"
            }

            const pagedFileList = async (
              accumulatedFiles: drive_v3.Schema$File[],
              response: GaxiosResponse<drive_v3.Schema$FileList>,
            ): Promise<drive_v3.Schema$File[]> => {
              const mergedFiles = accumulatedFiles.concat(response.data.files!)

              if (response.data.nextPageToken) {
                const pageOptions = { ...options }
                pageOptions.pageToken = response.data.nextPageToken
                return pagedFileList(
                  mergedFiles,
                  await drive.files.list(pageOptions),
                )
              }
              return mergedFiles
            }
            const paginatedFiles = await pagedFileList(
              [],
              await drive.files.list(options),
            )
            folders = paginatedFiles
              .filter(
                (folder) =>
                  !(folder.id === undefined) && !(folder.name === undefined),
              )
              .map((folder) => ({ name: folder.id!, label: folder.name! }))
            folders.unshift({ name: "root", label: "Drive Root" })

            form.fields.push({
              description: "Google Drive folder where your Excel file will be saved",
              label: "Select folder to save file",
              name: "folder",
              options: folders,
              default: folders[0].name,
              required: true,
              type: "select",
              interactive: true,
            })
          } else {
            form.fields.push({
              description:
                "Enter the full Google Drive URL of the folder where you want to save your data. It should look something like https://drive.google.com/corp/drive/folders/xyz. If this is inaccessible, your data will be saved to the root folder of your Google Drive. You do not need to enter a URL if you have already chosen a folder in the dropdown menu.\n",
              label: "Google Drive Destination URL",
              name: "folderid",
              type: "string",
              required: false,
              interactive: true,
            })
            form.fields.push({
              description: "Fetch folders",
              name: "fetchpls",
              type: "select",
              interactive: true,
              label: "Select Fetch to fetch a list of folders in this drive",
              options: [{ label: "Fetch", name: "fetch" }],
            })
          }

          // Determine current folder ID for template loading
          let templateFolderId: string | undefined
          if (request.formParams.folder) {
            templateFolderId = request.formParams.folder
          } else if (request.formParams.folderid) {
            if (request.formParams.folderid.includes("my-drive")) {
              templateFolderId = "root"
            } else {
              const match = request.formParams.folderid.match(FOLDERID_REGEX)
              if (match && match.groups) {
                templateFolderId = match.groups.folderId
              } else {
                templateFolderId = "root"
              }
            }
          } else if (request.formParams.fetchpls) {
            if (folders && folders.length > 0) {
              templateFolderId = folders[0].name
            } else {
              templateFolderId = "root"
            }
          }

          if (templateFolderId) {
            try {
              const templates = await this.getTemplatesInFolder(drive, templateFolderId)
              if (templates.length > 0) {
                form.fields.push({
                  description: "Select the Excel (.xlsx) template to populate",
                  label: "Select Template File",
                  name: "template_file_id",
                  options: templates,
                  default: templates[0].name,
                  required: true,
                  type: "select",
                })
              } else {
                form.fields.push({
                  name: "template_file_error",
                  type: "message",
                  value: "⚠️ No .xlsx template files found in the selected folder. Please upload a template first.",
                })
              }
            } catch (e: any) {
              winston.error(`Failed to fetch templates in folder ${templateFolderId}: ${e.message}`)
              form.fields.push({
                name: "template_file_error",
                type: "message",
                value: `⚠️ Failed to fetch templates from folder: ${e.message || e}`,
              })
            }
          } else {
            form.fields.push({
              name: "template_file_info",
              type: "message",
              value: "ℹ️ Paste a Google Drive folder URL or click 'Fetch' to select a folder and load templates.",
            })
          }

          form.fields.push({
            label: "Enter a filename",
            name: "filename",
            type: "string",
            required: true,
            description: "Supports handlebar placeholders like {{ _filters.users.state }}",
          })
        }
      } catch (e: any) {
        const errorType = getHttpErrorType(e, this.name)
        let error = errorWith(errorType, `${LOG_PREFIX} ${e.toString()}`)
        if (e.code && e.errors && e.errors[0] && e.errors[0].message) {
          error = {
            ...error,
            http_code: e.code,
            message: `${errorType.description} [GOOGLE_SHEET_XLSX_TEMPLATE] ${e.errors[0].message}`,
          }
        }
        winston.error("Can not sign in to Google", {
          error,
          webhookId: request.webhookId,
        })
        return this.loginForm(request, error.message)
      }
    }
    if (form.fields.length === 0) {
      return this.loginForm(request)
    }
    return form
  }

  // --- Google OAuth V2 Boilerplate ---

  async oauthUrl(redirectUri: string, encryptedState: string) {
    const oauth2Client = this.oauth2Client(redirectUri)
    const scopes = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/userinfo.email",
    ]

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      state: encryptedState,
    })
    return url.toString()
  }

  async oauthHandleRedirect(
    urlParams: { [key: string]: string },
    redirectUri: string,
  ) {
    const actionCrypto = new Hub.ActionCrypto()
    const plaintext = await actionCrypto
      .decrypt(urlParams.state)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured" + err)
        throw err
      })
    const statePayload: OauthState = JSON.parse(plaintext)

    if (statePayload.tokenurl) {
      winston.info("Redirected with V2 flow")
      return this.oauthCreateLookerRedirectUrl(
        urlParams,
        redirectUri,
        actionCrypto,
        statePayload,
      )
    } else {
      winston.info("Redirected with V1 flow")
      await this.oauthFetchAndStoreInfo(
        urlParams,
        redirectUri,
        statePayload,
        undefined,
      )
      return ""
    }
  }

  async oauthFetchAccessToken(request: Hub.ActionRequest) {
    if (request.fetchTokenState) {
      const actionCrypto = new Hub.ActionCrypto()
      const plaintext = await actionCrypto
        .decrypt(request.fetchTokenState)
        .catch((err: string) => {
          winston.error("Encryption not correctly configured", { error: err })
          throw err
        })
      const state = JSON.parse(plaintext)

      const tokens = await this.getAccessTokenCredentialsFromCode(
        state.redirecturi,
        state.code,
      )
      if (this.validTokens(tokens, request.webhookId)) {
        const tokenPayload = new Hub.ActionToken(tokens, state.redirecturi)
        const encryptedPayload = await this.oauthMaybeEncryptTokens(
          tokenPayload,
          new Hub.ActionCrypto(),
          request.webhookId,
        )
        return encryptedPayload
      } else {
        throw new Error("OAuth tokens are invalid.")
      }
    } else {
      throw new Error("Request is missing state parameter.")
    }
  }

  async oauthCheck(request: Hub.ActionRequest) {
    if (request.params.state_json) {
      const tokenPayload = await this.oauthExtractTokensFromStateJson(
        request.params.state_json,
        request.webhookId,
      )
      if (tokenPayload) {
        const drive = await this.driveClientFromRequest(
          tokenPayload.redirect,
          tokenPayload.tokens,
        )
        await drive.files.list({
          pageSize: 10,
        })
        return true
      }
    }
    return false
  }

  oauth2Client(redirectUri: string | undefined): OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      redirectUri,
    )
  }

  async getDrives(
    drive: Drive,
    accumulatedFolders: drive_v3.Schema$Drive[],
    response: GaxiosResponse<drive_v3.Schema$DriveList>,
  ): Promise<drive_v3.Schema$Drive[]> {
    const driveList = accumulatedFolders.concat(response.data.drives!)

    if (response.data.nextPageToken) {
      const pageOptions = {
        pageSize: 50,
        pageToken: response.data.nextPageToken,
      }
      return this.getDrives(
        drive,
        driveList,
        await drive.drives.list(pageOptions),
      )
    }

    return driveList
  }

  async getTemplatesInFolder(
    drive: Drive,
    folderId: string,
  ): Promise<{ name: string; label: string }[]> {
    const options: any = {
      fields: "files(id,name),nextPageToken",
      orderBy: "name",
      pageSize: 1000,
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }

    const pagedFileList = async (
      accumulatedFiles: drive_v3.Schema$File[],
      response: GaxiosResponse<drive_v3.Schema$FileList>,
    ): Promise<drive_v3.Schema$File[]> => {
      const mergedFiles = accumulatedFiles.concat(response.data.files || [])

      if (response.data.nextPageToken) {
        const pageOptions = { ...options }
        pageOptions.pageToken = response.data.nextPageToken
        return pagedFileList(
          mergedFiles,
          await drive.files.list(pageOptions),
        )
      }
      return mergedFiles
    }

    const files = await pagedFileList([], await drive.files.list(options))
    return files
      .filter((f) => f.id && f.name && f.name.toLowerCase().endsWith(".xlsx"))
      .map((f) => ({ name: f.id!, label: f.name! }))
  }

  sanitizeGaxiosError(err: any) {
    const configObjs = []
    if (err.config) {
      configObjs.push(err.config)
    }
    if (err.response && err.response.config) {
      configObjs.push(err.response.config)
    }
    for (const config of configObjs) {
      for (const prop of ["data", "body"]) {
        if (config[prop]) {
          config[prop] = "[REDACTED]"
        }
      }
    }
  }

  protected async getAccessTokenCredentialsFromCode(
    redirect: string,
    code: string,
  ) {
    const client = this.oauth2Client(redirect)
    const { tokens } = await client.getToken(code)
    return tokens
  }

  protected async driveClientFromRequest(
    redirect: string,
    tokens: Credentials,
  ) {
    const client = this.oauth2Client(redirect)
    client.setCredentials(tokens)
    return google.drive({ version: "v3", auth: client })
  }

  protected async getUserEmail(redirect: string, tokens: Credentials) {
    const client = this.oauth2Client(redirect)
    client.setCredentials(tokens)
    const authy = google.oauth2({ version: "v2", auth: client })
    const response = await authy.tokeninfo()
    const email = response.data.email ? response.data.email : "INVALID"

    return email
  }

  protected async validateUserInDomainAllowlist(
    domainAllowlist: string | undefined,
    redirect: string,
    tokens: Credentials,
    requestWebhookId: string | undefined,
  ) {
    if (domainAllowlist) {
      const domainValidator = new DomainValidator(domainAllowlist)
      if (domainValidator.hasValidDomains()) {
        const userEmail = await this.getUserEmail(redirect, tokens)

        if (domainValidator.isValidEmailDomain(userEmail)) {
          winston.info("Domain Verification successful", {
            webhookId: requestWebhookId,
          })
        } else {
          throw "Domain Verification unsuccessful"
        }
      } else {
        winston.info("No Domain Verification performed", {
          webhookId: requestWebhookId,
        })
      }
    }
  }

  protected async oauthExtractTokensFromStateJson(
    stateJson: string,
    requestWebhookId: string | undefined,
  ): Promise<Hub.ActionToken | null> {
    if (!stateJson || stateJson === "reset" || stateJson === "null") {
      winston.info("State is reset or empty", { webhookId: requestWebhookId })
      return null
    }
    let state: any
    try {
      state = JSON.parse(stateJson)
    } catch (e: any) {
      winston.error(`Failed to parse state_json: ${e.message}`, {
        webhookId: requestWebhookId,
      })
      return null
    }
    let tokenPayload: Hub.ActionToken | null = null
    if (state.cid && state.payload) {
      winston.info("Extracting encrypted state_json", {
        webhookId: requestWebhookId,
      })
      const encryptedPayload = new Hub.EncryptedPayload(
        state.cid,
        state.payload,
      )
      try {
        tokenPayload = await this.oauthDecryptTokens(
          encryptedPayload,
          new Hub.ActionCrypto(),
          requestWebhookId,
        )
      } catch (e: any) {
        winston.error(
          `Failed to decrypt or parse encrypted payload: ${e.message}`,
          { webhookId: requestWebhookId },
        )
      }
    } else if (state.tokens && state.redirect) {
      winston.info("Extracting unencrypted state_json", {
        webhookId: requestWebhookId,
      })
      tokenPayload = new Hub.ActionToken(state.tokens, state.redirect)
    }
    if (tokenPayload === null) {
      winston.info("No valid tokens found in state_json", { webhookId: requestWebhookId })
    }
    return tokenPayload
  }

  protected validTokens(
    tokens: Credentials,
    requestWebhookId: string | undefined,
  ): boolean {
    if (tokens.refresh_token) {
      return true
    } else {
      winston.error("Invalid OAuth token payload", {
        webhookId: requestWebhookId,
      })
      return false
    }
  }

  protected async oauthMaybeEncryptTokens(
    tokenPayload: Hub.ActionToken,
    actionCrypto: Hub.ActionCrypto,
    requestWebhookId: string | undefined,
  ): Promise<Hub.EncryptedPayload | Hub.ActionToken> {
    if (process.env.ENCRYPT_PAYLOAD === "true") {
      return this.oauthEncryptTokens(
        tokenPayload,
        actionCrypto,
        requestWebhookId,
      )
    } else {
      return tokenPayload
    }
  }

  protected async oauthEncryptTokens(
    tokenPayload: Hub.ActionToken,
    actionCrypto: Hub.ActionCrypto,
    requestWebhookId: string | undefined,
  ): Promise<Hub.EncryptedPayload> {
    const jsonPayload = JSON.stringify(tokenPayload)
    const encrypted = await actionCrypto
      .encrypt(jsonPayload)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured", {
          webhookId: requestWebhookId,
        })
        throw err
      })
    return new Hub.EncryptedPayload(actionCrypto.cipherId(), encrypted)
  }

  protected async oauthDecryptTokens(
    encryptedPayload: Hub.EncryptedPayload,
    actionCrypto: Hub.ActionCrypto,
    requestWebhookId: string | undefined,
  ): Promise<Hub.ActionToken> {
    const jsonPayload = await actionCrypto
      .decrypt(encryptedPayload.payload)
      .catch((err: string) => {
        winston.error("Failed to decrypt state_json", {
          webhookId: requestWebhookId,
        })
        throw err
      })
    const tokenPayload: Hub.ActionToken = JSON.parse(jsonPayload)
    return tokenPayload
  }

  protected async oauthFetchAndStoreInfo(
    urlParams: { [key: string]: string },
    redirectUri: string,
    statePayload: OauthState,
    requestWebhookId: string | undefined,
  ) {
    const tokens = await this.getAccessTokenCredentialsFromCode(
      redirectUri,
      urlParams.code,
    )
    if (this.validTokens(tokens, requestWebhookId)) {
      const tokenPayload = new Hub.ActionToken(tokens, redirectUri)
      const encryptedPayload = await this.oauthMaybeEncryptTokens(
        tokenPayload,
        new Hub.ActionCrypto(),
        requestWebhookId,
      )
      await https
        .post({
          url: statePayload.stateurl!,
          body: JSON.stringify(encryptedPayload),
        })
        .catch((_err) => {
          winston.error(_err.toString())
        })
    }
  }

  protected async oauthCreateLookerRedirectUrl(
    urlParams: { [key: string]: string },
    redirectUri: string,
    actionCrypto: Hub.ActionCrypto,
    statePayload: OauthState,
  ) {
    const newState = {
      code: urlParams.code,
      redirecturi: redirectUri,
    }
    const jsonString = JSON.stringify(newState)
    const ciphertextBlob = await actionCrypto
      .encrypt(jsonString)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured")
        throw err
      })

    return `${statePayload.tokenurl!}?state=${ciphertextBlob}`
  }

  // --- Spreadsheet Population Engine (ExcelJS) ---

  // ponytail: logo is programmatically placed at D1 with hardcoded dimensions to preserve template visuals
  private populateTemplate(workbook: ExcelJS.Workbook, context: any, errors: Set<string>) {
    const worksheet = workbook.worksheets[0] as ExcelJS.Worksheet | undefined
    if (worksheet === undefined) { return }

    const repeatingRowIdx = this.findRepeatingRow(worksheet)
    let numNewRows = 0

    if (repeatingRowIdx !== null) {
      const templateRow = worksheet.getRow(repeatingRowIdx)

      // 1. Extract cell templates (value and style) for this row
      const cellTemplates: { [col: number]: { value: any; style: any; height: number } } = {}
      templateRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cellTemplates[colNumber] = {
          value: cell.value,
          style: cell.style,
          height: templateRow.height,
        }
      })

      numNewRows = context.data.length

      // 2. Shift the rows below and insert new rows if needed
      if (numNewRows > 1) {
        // Shift rows starting at repeatingRowIdx + 1 down by numNewRows - 1
        worksheet.spliceRows(repeatingRowIdx + 1, 0, ...Array.from({ length: numNewRows - 1 }, () => []))
      } else if (numNewRows === 0) {
        // Delete the template row and shift rows up
        worksheet.spliceRows(repeatingRowIdx, 1)
      }

      // 3. Populate rows with dynamic data
      if (numNewRows > 0) {
        for (let i = 0; i < numNewRows; ++i) {
          const targetRowIdx = repeatingRowIdx + i
          const targetRow = worksheet.getRow(targetRowIdx)
          const rowData = context.data[i]

          for (const [colStr, tpl] of Object.entries(cellTemplates)) {
            const colNumber = parseInt(colStr, 10)
            const targetCell = targetRow.getCell(colNumber)

            // Deep clone/copy the template value to avoid sharing references
            let valCopy = typeof tpl.value === "object" && tpl.value !== null
              ? JSON.parse(JSON.stringify(tpl.value))
              : tpl.value

            valCopy = this.resolveCellValue(valCopy, context, rowData, errors)
            targetCell.value = valCopy
            targetCell.style = tpl.style
          }
          if (templateRow.height > 0) {
            targetRow.height = templateRow.height
          }
          targetRow.commit()
        }
      }
    }

    // 4. Resolve all other non-repeating cells in place
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      // Skip the repeating rows we just populated
      if (repeatingRowIdx !== null && rowNumber >= repeatingRowIdx && rowNumber < repeatingRowIdx + numNewRows) {
        return
      }
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.value = this.resolveCellValue(cell.value, context, undefined, errors)
      })
    })
  }

  private findRepeatingRow(worksheet: ExcelJS.Worksheet): number | null {
    let repeatingRowNumber: number | null = null
    worksheet.eachRow((row, rowNumber) => {
      if (repeatingRowNumber !== null) { return }
      row.eachCell((cell) => {
        if (repeatingRowNumber !== null) { return }
        const val = cell.value
        if (val !== undefined && val !== null && typeof val === "string") {
          if (val.includes("{{ data.") && !val.includes("{{ data[")) {
            repeatingRowNumber = rowNumber
          }
        }
      })
    })
    return repeatingRowNumber
  }

  private resolveCellValue(val: any, context: any, rowData?: any, errors?: Set<string>): any {
    if (val === undefined || val === null) {
      return val
    }

    if (typeof val === "string") {
      const match = val.match(/^\{\{([^}]+)\}\}$/)
      if (match) {
        const expr = match[1]
        const resolved = this.evaluateExpression(expr, context, rowData, errors)

        let numVal = Number(resolved)
        if (isNaN(numVal)) {
          if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(resolved)) {
            const cleanNumStr = resolved.replace(/,/g, "")
            numVal = Number(cleanNumStr)
          }
        }

        if (resolved !== "" && !isNaN(numVal)) {
          return numVal
        } else {
          return resolved
        }
      } else if (val.includes("{{")) {
        return this.resolveString(val, context, rowData, errors)
      }
      return val
    }

    if (typeof val === "object" && val !== null && "formula" in val) {
      const formulaStr = String(val.formula)
      if (formulaStr.includes("{{")) {
        val.formula = this.resolveString(formulaStr, context, rowData, errors)
      }
      return val
    }

    return val
  }

  private resolveString(str: string, context: any, rowData?: any, errors?: Set<string>): string {
    return str.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      return this.evaluateExpression(expr, context, rowData, errors)
    })
  }

  private stripHtml(val: string): string {
    if (!val) {
      return ""
    }
    if (val.includes("<") && val.includes(">")) {
      return val
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }
    return val
  }

  private evaluateExpression(expr: string, context: any, rowData?: any, errors?: Set<string>): string {
    const rawVal = this.evaluateExpressionRaw(expr, context, rowData, errors)
    return this.stripHtml(rawVal)
  }

  private evaluateExpressionRaw(expr: string, context: any, rowData?: any, errors?: Set<string>): string {
    expr = expr.trim()

    // 1. _built_in
    if (expr.startsWith("_built_in.")) {
      const key = expr.substring("_built_in.".length)
      const val = context._built_in?.[key]
      if (val === undefined || val === null) {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
      return String(val)
    }

    // 2. _filters
    if (expr.startsWith("_filters.")) {
      const key = expr.substring("_filters.".length)
      const filter = context.appliedFilters?.[key]
      if (filter === undefined) {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
      const val = filter.value
      return val !== undefined && val !== null ? String(val) : ""
    }

    // 3. fields.*.label
    if (expr.startsWith("fields.") && expr.endsWith(".label")) {
      const fieldName = expr.substring("fields.".length, expr.length - ".label".length)
      const dimensions = context.fields?.dimensions ? context.fields.dimensions : []
      const measures = context.fields?.measures ? context.fields.measures : []
      const allFields = [...dimensions, ...measures]

      // Dynamic column label lookup: fields._columns[idx].label
      if (fieldName.startsWith("_columns[")) {
        const colIdxMatch = fieldName.match(/^_columns\[(\d+)\]$/)
        if (colIdxMatch) {
          const idx = parseInt(colIdxMatch[1], 10)
          const colField = allFields[idx]
          if (!colField) {
            errors?.add(`{{ ${expr} }}`)
            return ""
          }
          return colField.label
        }
      }

      const field = allFields.find((f) => f.name === fieldName)
      if (!field) {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
      return field.label
    }

    // 4. data[i].path (explicit row lookup)
    const dataIndexedMatch = expr.match(/^data\[(\d+)\]\.(.+)$/)
    if (dataIndexedMatch) {
      const idx = parseInt(dataIndexedMatch[1], 10)
      const pathStr = dataIndexedMatch[2]
      const row = context.data?.[idx]
      if (!row) {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
      const valObj = row[pathStr]
      if (valObj === undefined) {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
      const val = valObj.value
      return val !== undefined && val !== null ? String(val) : ""
    }

    // 5. data._columns[i] (dynamic column lookup)
    if (expr.startsWith("data._columns[")) {
      const colIdxMatch = expr.match(/^data\._columns\[(\d+)\]$/)
      if (colIdxMatch) {
        const idx = parseInt(colIdxMatch[1], 10)
        const dimensions = context.fields?.dimensions ? context.fields.dimensions : []
        const measures = context.fields?.measures ? context.fields.measures : []
        const allFields = [...dimensions, ...measures]
        const fieldName = allFields[idx]?.name
        if (!fieldName) {
          errors?.add(`{{ ${expr} }}`)
          return ""
        }
        if (rowData) {
          const valObj = rowData[fieldName]
          if (valObj === undefined) {
            errors?.add(`{{ ${expr} }}`)
            return ""
          }
          const val = valObj.value
          return val !== undefined && val !== null ? String(val) : ""
        }
      }
      errors?.add(`{{ ${expr} }}`)
      return ""
    }

    // 6. data.path (row-level)
    if (expr.startsWith("data.")) {
      if (rowData) {
        const pathStr = expr.substring("data.".length)
        const valObj = rowData[pathStr]
        if (valObj === undefined) {
          errors?.add(`{{ ${expr} }}`)
          return ""
        }
        const val = valObj.value
        return val !== undefined && val !== null ? String(val) : ""
      } else {
        errors?.add(`{{ ${expr} }}`)
        return ""
      }
    }

    // Default: unrecognized/unresolved
    errors?.add(`{{ ${expr} }}`)
    return ""
  }

  private async loginForm(request: Hub.ActionRequest, errorMessage?: string) {
    const form = new Hub.ActionForm()
    form.fields = []

    if (errorMessage) {
      form.fields.push({
        name: "error_message",
        type: "message",
        value: `⚠️ Login failed: ${errorMessage}`,
      })
    }

    const hasTokenUrl = request.params.hasOwnProperty("state_redir_url")
    winston.info(`Using ${hasTokenUrl ? "V2" : "V1"} flow`)
    const state: OauthState = hasTokenUrl
      ? { tokenurl: request.params.state_redir_url }
      : { stateurl: request.params.state_url }
    const jsonString = JSON.stringify(state)

    const actionCrypto = new Hub.ActionCrypto()
    const ciphertextBlob = await actionCrypto
      .encrypt(jsonString)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured")
        throw err
      })
    form.state = new Hub.ActionState()
    form.fields.push({
      name: "login",
      type: "oauth_link_google",
      label: "Log in",
      description:
        "In order to send to Excel Template, you will need to log in once to your Google account. " +
        "(If you just completed the login and still see this screen, please close and reopen or refresh this window.)\n\n" +
        `Diagnostics - Webhook ID: ${request.webhookId ? request.webhookId : "none"}`,
      oauth_url: `${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    })
    winston.debug(
      `Login form, OAuthURL${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    )
    return form
  }
}

// ponytail: register the action in the hub
Hub.addAction(new GoogleSheetXlsxTemplateAction())
