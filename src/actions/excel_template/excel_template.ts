import { GaxiosResponse } from "gaxios"
import { Credentials, OAuth2Client } from "google-auth-library"
import { drive_v3, google } from "googleapis"
import * as oboe from "oboe"
import * as path from "path"
import * as https from "request-promise-native"
import { Readable } from "stream"
import * as winston from "winston"
import Drive = drive_v3.Drive
import * as XLSX from "xlsx"
import { getHttpErrorType } from "../../error_types/utils"
import * as Hub from "../../hub"
import { Error, errorWith } from "../../hub/action_response"
import { DomainValidator } from "../google/docs/domain_validator"

const sanitizeFilename = require("sanitize-filename")
const LOG_PREFIX = "[EXCEL_TEMPLATE]"
const FOLDERID_REGEX = /\/folders\/(?<folderId>[^\/?]+)/

interface OauthState {
  tokenurl?: string
  stateurl?: string
}

export class ExcelTemplateAction extends Hub.OAuthActionV2 {
  name = "excel_template"
  label = "Excel Template"
  iconName = "google/docs/docs.svg"
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
        const templatePath = path.resolve(__dirname, "../../../template-example.xlsx")
        winston.info(`${LOG_PREFIX} Reading template from ${templatePath}`, { webhookId: request.webhookId })
        const workbook = XLSX.readFile(templatePath)

        // 5. Populate template with data
        winston.info(`${LOG_PREFIX} Populating Excel template`, { webhookId: request.webhookId })
        this.populateTemplate(workbook, context, errors)

        if (errors.size > 0) {
          winston.info(
            `${LOG_PREFIX} Creating _errors sheet with ${errors.size} errors`,
            { webhookId: request.webhookId },
          )
          const errorRows = Array.from(errors).map((err) => [`Could not find ${err}`])
          const errorsSheet = XLSX.utils.aoa_to_sheet(errorRows)
          XLSX.utils.book_append_sheet(workbook, errorsSheet, "_errors")
        }

        // 6. Write to Buffer
        const outputBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })

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
            body: Readable.from(outputBuffer),
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
            const folders = paginatedFiles
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
            })
          } else {
            form.fields.push({
              description:
                "Enter the full Google Drive URL of the folder where you want to save your data. It should look something like https://drive.google.com/corp/drive/folders/xyz. If this is inaccessible, your data will be saved to the root folder of your Google Drive. You do not need to enter a URL if you have already chosen a folder in the dropdown menu.\n",
              label: "Google Drive Destination URL",
              name: "folderid",
              type: "string",
              required: false,
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
            message: `${errorType.description} [EXCEL_TEMPLATE] ${e.errors[0].message}`,
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

  // --- Spreadsheet Population Engine (SheetJS) ---

  private populateTemplate(workbook: XLSX.WorkBook, context: any, errors: Set<string>) {
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName] as XLSX.WorkSheet | undefined
    if (!sheet) { return }

    const repeatingRowIdx = this.findRepeatingRow(sheet)
    if (repeatingRowIdx !== null) {
      // 1. Extract cell templates for this row
      const cellTemplates: { [col: number]: XLSX.CellObject } = {}
      const ref = sheet["!ref"]
      const range = XLSX.utils.decode_range(ref ? ref : "A1:A1")
      for (let c = range.s.c; c <= range.e.c; ++c) {
        const cellAddress = XLSX.utils.encode_cell({ r: repeatingRowIdx, c })
        const cell = sheet[cellAddress]
        if (cell) {
          cellTemplates[c] = { ...cell }
        }
      }

      // 2. Remove the template cells
      for (let c = range.s.c; c <= range.e.c; ++c) {
        const cellAddress = XLSX.utils.encode_cell({ r: repeatingRowIdx, c })
        delete sheet[cellAddress]
      }

      // 3. Shift the rows below down
      const numNewRows = context.data.length
      if (numNewRows > 1) {
        this.shiftRows(sheet, repeatingRowIdx + 1, numNewRows - 1)
      } else if (numNewRows === 0) {
        this.shiftRows(sheet, repeatingRowIdx + 1, -1)
      }

      // 4. Populate rows with dynamic data
      for (let i = 0; i < numNewRows; ++i) {
        const targetRowIdx = repeatingRowIdx + i
        const rowData = context.data[i]
        for (const [colStr, cellTpl] of Object.entries(cellTemplates)) {
          const c = parseInt(colStr, 10)
          const newCell = { ...cellTpl }
          this.resolveCell(newCell, context, rowData, errors)
          const cellAddress = XLSX.utils.encode_cell({ r: targetRowIdx, c })
          sheet[cellAddress] = newCell
        }
      }
    }

    // 5. Resolve all other non-repeating cells in place
    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) { continue }
      this.resolveCell(sheet[key], context, undefined, errors)
    }
  }

  private findRepeatingRow(sheet: XLSX.WorkSheet): number | null {
    const ref = sheet["!ref"]
    const range = XLSX.utils.decode_range(ref ? ref : "A1:A1")
    for (let r = range.s.r; r <= range.e.r; ++r) {
      for (let c = range.s.c; c <= range.e.c; ++c) {
        const cellAddress = XLSX.utils.encode_cell({ r, c })
        const cell = sheet[cellAddress]
        if (cell && cell.v) {
          const str = String(cell.v)
          if (str.includes("{{ data.") && !str.includes("{{ data[")) {
            return r
          }
        }
      }
    }
    return null
  }

  private shiftRows(sheet: XLSX.WorkSheet, startRow: number, numRows: number) {
    const ref = sheet["!ref"]
    const range = XLSX.utils.decode_range(ref ? ref : "A1:A1")
    const newSheet: any = {
      "!ref": sheet["!ref"],
      "!margins": sheet["!margins"],
      "!merges": sheet["!merges"],
    }

    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) { continue }
      const cell = XLSX.utils.decode_cell(key)
      if (cell.r >= startRow) {
        const newAddress = XLSX.utils.encode_cell({ r: cell.r + numRows, c: cell.c })
        newSheet[newAddress] = sheet[key]
      } else {
        newSheet[key] = sheet[key]
      }
    }

    for (const key of Object.keys(sheet)) {
      if (!key.startsWith("!")) { delete sheet[key] }
    }
    Object.assign(sheet, newSheet)

    range.e.r += numRows
    sheet["!ref"] = XLSX.utils.encode_range(range)
  }

  private resolveCell(cell: XLSX.CellObject | undefined, context: any, rowData?: any, errors?: Set<string>) {
    if (!cell || cell.v === undefined) { return }
    const strVal = String(cell.v)

    const match = strVal.match(/^\{\{([^}]+)\}\}$/)
    if (match) {
      const expr = match[1]
      const resolved = this.evaluateExpression(expr, context, rowData, errors)

      let numVal = Number(resolved)
      if (isNaN(numVal) && typeof resolved === "string") {
        if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(resolved)) {
          const cleanNumStr = resolved.replace(/,/g, "")
          numVal = Number(cleanNumStr)
        }
      }

      if (resolved !== "" && !isNaN(numVal)) {
        cell.t = "n"
        cell.v = numVal
      } else {
        cell.t = "s"
        cell.v = resolved
      }
    } else if (strVal.includes("{{")) {
      cell.t = "s"
      cell.v = this.resolveString(strVal, context, rowData, errors)
    }
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
Hub.addAction(new ExcelTemplateAction())
