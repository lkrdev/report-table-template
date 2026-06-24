/* tslint:disable */
import * as parse from "csv-parse";
import { GaxiosResponse } from "gaxios";
import { Credentials, OAuth2Client } from "google-auth-library";
import { docs_v1, drive_v3, google } from "googleapis";
import * as https from "request-promise-native";
import * as winston from "winston";
import { HTTP_ERROR } from "../../../error_types/http_errors";
import { getHttpErrorType } from "../../../error_types/utils";
import * as Hub from "../../../hub";
import { Error, errorWith } from "../../../hub/action_response";
import { DomainValidator } from "./domain_validator";
import Drive = drive_v3.Drive;
import Docs = docs_v1.Docs;

const MAX_RETRY_COUNT = 5;
const RETRY_BASE_DELAY = process.env.GOOGLE_DOCS_BASE_DELAY
  ? Number(process.env.GOOGLE_DOCS_BASE_DELAY)
  : 3;
const LOG_PREFIX = "[GOOGLE_DOCS]";
const ROOT = "root";
const FOLDERID_REGEX = /\/folders\/(?<folderId>[^\/?]+)/;
const RETRIABLE_CODES = [429, 409, 500, 504, 503];
const MAX_REQUEST_BATCH = process.env.GOOGLE_DOCS_WRITE_BATCH
  ? Number(process.env.GOOGLE_DOCS_WRITE_BATCH)
  : 100;

const PT = 72;
const FIRST_TABLE_COLUMN_WIDTH = PT * 0.5;
const DOCUMENT_WIDTH = PT * 8.5;
const DOCUMENT_HEIGHT = PT * 11;
const DOCUMENT_MARGIN = PT * 0.5;
const DOCUMENT_PORTRAIT = false;

interface OauthState {
  tokenurl?: string;
  stateurl?: string;
}

export class GoogleDocsAction extends Hub.OAuthActionV2 {
  name = "google_docs";
  label = "Google Docs";
  iconName = "google/docs/docs.svg";
  description = "Create a new Google Doc with data in a table.";
  supportedActionTypes = [Hub.ActionType.Query];
  supportedFormats = [Hub.ActionFormat.Csv];
  executeInOwnProcess = true;
  mimeType = "application/vnd.google-apps.document";

  usesStreaming = true;
  usesCsrfProtection = true;
  minimumSupportedLookerVersion = "7.3.0";
  requiredFields = [];
  params = [
    {
      name: "domain_allowlist",
      label: "Domain Allowlist",
      required: false,
      sensitive: false,
      description:
        "Comma separated domain allowlist ex: facts.com,car.com. Be advised that if this is enabled after, all existing accounts will have to reauth due to an additional scope needed to check the email address.",
    },
  ];

  async execute(request: Hub.ActionRequest) {
    const resp = new Hub.ActionResponse();

    if (!request.params.state_json) {
      winston.info("No state json found", { webhookId: request.webhookId });
      resp.success = false;
      resp.message = "No state found with oauth credentials.";
      resp.state = new Hub.ActionState();
      resp.state.data = "reset";
      return resp;
    }

    const stateJson = JSON.parse(request.params.state_json);

    if (stateJson.tokens && stateJson.redirect) {
      await this.validateUserInDomainAllowlist(
        request.params.domain_allowlist,
        stateJson.redirect,
        stateJson.tokens,
        request.webhookId,
      ).catch((error) => {
        winston.info(error + " - invalidating token", {
          webhookId: request.webhookId,
        });
        resp.success = false;
        resp.state = new Hub.ActionState();
        resp.message = "User Domain validation failed";
        resp.state.data = "reset";
        return resp;
      });

      const drive = await this.driveClientFromRequest(
        stateJson.redirect,
        stateJson.tokens,
      );
      const docs = await this.docsClientFromRequest(
        stateJson.redirect,
        stateJson.tokens,
      );

      const filename =
        request.formParams.filename || request.suggestedFilename();
      if (!filename) {
        const error: Hub.Error = Hub.errorWith(
          HTTP_ERROR.bad_request,
          `${LOG_PREFIX} Error creating file name`,
        );
        resp.error = error;
        resp.success = false;
        resp.message = error.message;
        resp.webhookId = request.webhookId;
        winston.error(`${error.message}`, {
          error,
          webhookId: request.webhookId,
        });
        return resp;
      }

      try {
        await this.createDocWithTable(filename, request, drive, docs);
        resp.success = true;
      } catch (e: any) {
        this.sanitizeGaxiosError(e);

        const errorType = getHttpErrorType(e, this.name);
        let error: Error = errorWith(
          errorType,
          `${LOG_PREFIX} ${e.toString()}`,
        );

        if (e.code && e.errors && e.errors[0] && e.errors[0].message) {
          error = {
            ...error,
            http_code: e.code,
            message: `${errorType.description} ${LOG_PREFIX} ${e.errors[0].message}`,
          };
          resp.message = e.errors[0].message;
        } else {
          resp.message = e.toString();
        }

        resp.success = false;
        resp.webhookId = request.webhookId;
        resp.error = error;
        winston.error(`${error.message}`, {
          error,
          webhookId: request.webhookId,
        });
      }
    } else {
      winston.info("Request did not have oauth tokens present", {
        webhookId: request.webhookId,
      });
      resp.success = false;
      resp.message =
        "Request did not have necessary oauth tokens saved. Fast failing";
      resp.state = new Hub.ActionState();
      resp.state.data = "reset";
    }
    return resp;
  }

  async form(request: Hub.ActionRequest) {
    const form = new Hub.ActionForm();

    if (request.params.state_json) {
      try {
        const tokenPayload = await this.oauthExtractTokensFromStateJson(
          request.params.state_json,
          request.webhookId,
        );
        if (tokenPayload) {
          await this.validateUserInDomainAllowlist(
            request.params.domain_allowlist,
            tokenPayload.redirect,
            tokenPayload.tokens,
            request.webhookId,
          ).catch((error) => {
            winston.info(error + " - invalidating token", {
              webhookId: request.webhookId,
            });
            form.state = new Hub.ActionState();
            form.state.data = "reset";
            throw "Domain Verification Failed";
          });

          const drive = await this.driveClientFromRequest(
            tokenPayload.redirect,
            tokenPayload.tokens,
          );

          const paginatedDrives = await this.getDrives(
            drive,
            [],
            await drive.drives.list({ pageSize: 50 }),
          );
          const driveSelections = paginatedDrives
            .filter(
              (_drive) =>
                !(_drive.id === undefined) && !(_drive.name === undefined),
            )
            .map((folder) => ({ name: folder.id!, label: folder.name! }));
          driveSelections.unshift({ name: "mydrive", label: "My Drive" });

          form.fields.push({
            description: "Google Drive where your file will be saved",
            label: "Select Drive to save file",
            name: "drive",
            options: driveSelections,
            default: driveSelections[0].name,
            interactive: true,
            required: true,
            type: "select",
          });

          if (request.formParams.fetchpls) {
            // drive.files.list() options
            const options: any = {
              fields: "files(id,name,parents),nextPageToken",
              orderBy: "recency desc",
              pageSize: 1000,
              q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
              spaces: "drive",
            };
            if (
              request.formParams.drive !== undefined &&
              request.formParams.drive !== "mydrive"
            ) {
              options.driveId = request.formParams.drive;
              options.includeItemsFromAllDrives = true;
              options.supportsAllDrives = true;
              options.corpora = "drive";
            } else {
              options.corpora = "user";
            }

            const pagedFileList = async (
              accumulatedFiles: drive_v3.Schema$File[],
              response: GaxiosResponse<drive_v3.Schema$FileList>,
            ): Promise<drive_v3.Schema$File[]> => {
              const mergedFiles = accumulatedFiles.concat(response.data.files!);

              // When a `nextPageToken` exists, recursively call this function to get the next page.
              if (response.data.nextPageToken) {
                const pageOptions = { ...options };
                pageOptions.pageToken = response.data.nextPageToken;
                return pagedFileList(
                  mergedFiles,
                  await drive.files.list(pageOptions),
                );
              }
              return mergedFiles;
            };
            const paginatedFiles = await pagedFileList(
              [],
              await drive.files.list(options),
            );
            const folders = paginatedFiles
              .filter(
                (folder) =>
                  !(folder.id === undefined) && !(folder.name === undefined),
              )
              .map((folder) => ({ name: folder.id!, label: folder.name! }));
            folders.unshift({ name: "root", label: "Drive Root" });

            form.fields.push({
              description: "Google Drive folder where your file will be saved",
              label: "Select folder to save file",
              name: "folder",
              options: folders,
              default: folders[0].name,
              required: true,
              type: "select",
            });
            // We did not fetch the folder, offer to fetch or to enter a folderid
          } else {
            form.fields.push({
              description:
                "Enter the full Google Drive URL of the folder where you want to save your data. It should look something like https://drive.google.com/corp/drive/folders/xyz. If this is inaccessible, your data will be saved to the root folder of your Google Drive. You do not need to enter a URL if you have already chosen a folder in the dropdown menu.\n",
              label: "Google Drive Destination URL",
              name: "folderid",
              type: "string",
              required: false,
            });
            form.fields.push({
              description: "Fetch folders",
              name: "fetchpls",
              type: "select",
              interactive: true,
              label: "Select Fetch to fetch a list of folders in this drive",
              options: [{ label: "Fetch", name: "fetch" }],
            });
          }
          form.fields.push({
            label: "Enter a filename",
            name: "filename",
            type: "string",
            required: true,
          });
          const encryptedPayload = await this.oauthMaybeEncryptTokens(
            tokenPayload,
            new Hub.ActionCrypto(),
            request.webhookId,
          );
          form.state = new Hub.ActionState();
          form.state.data = JSON.stringify(encryptedPayload);
          return form;
        }
      } catch (e: any) {
        const errorType = getHttpErrorType(e, this.name);
        let error: Error = errorWith(errorType, `[GOOGLE_DOCS] ${e.message}`);
        const errorObjectKeys: any = [];
        for (const [key, _] of Object.entries(e)) {
          errorObjectKeys.push(key);
        }
        if (e.code && e.errors && e.errors[0] && e.errors[0].message) {
          error = {
            ...error,
            http_code: e.code,
            message: `${errorType.description} [GOOGLE_DOCS] ${e.errors[0].message}`,
          };
        }
        winston.error("Can not sign in to Google", {
          errorKeys: errorObjectKeys,
          error,
          webhookId: request.webhookId,
        });
        return this.loginForm(request, error.message);
      }
    }
    return this.loginForm(request);
  }

  async oauthUrl(redirectUri: string, encryptedState: string) {
    const oauth2Client = this.oauth2Client(redirectUri);

    // generate a url that asks permissions for Google Drive and Docs scope
    const scopes = [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/userinfo.email",
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      state: encryptedState,
    });
    return url.toString();
  }

  async oauthHandleRedirect(
    urlParams: { [key: string]: string },
    redirectUri: string,
  ) {
    const actionCrypto = new Hub.ActionCrypto();
    const plaintext = await actionCrypto
      .decrypt(urlParams.state)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured" + err);
        throw err;
      });
    const statePayload: OauthState = JSON.parse(plaintext);

    if (statePayload.tokenurl) {
      // redirect user back to Looker with context
      winston.info("Redirected with V2 flow");
      return this.oauthCreateLookerRedirectUrl(
        urlParams,
        redirectUri,
        actionCrypto,
        statePayload,
      );
    } else {
      // Pass back context to Looker
      winston.info("Redirected with V1 flow");
      await this.oauthFetchAndStoreInfo(
        urlParams,
        redirectUri,
        statePayload,
        undefined,
      );
      return "";
    }
  }

  async oauthFetchAccessToken(request: Hub.ActionRequest) {
    if (request.fetchTokenState) {
      const actionCrypto = new Hub.ActionCrypto();
      const plaintext = await actionCrypto
        .decrypt(request.fetchTokenState)
        .catch((err: string) => {
          winston.error("Encryption not correctly configured", { error: err });
          throw err;
        });
      const state = JSON.parse(plaintext);

      const tokens = await this.getAccessTokenCredentialsFromCode(
        state.redirecturi,
        state.code,
      );
      if (this.validTokens(tokens, request.webhookId)) {
        const tokenPayload = new Hub.ActionToken(tokens, state.redirecturi);
        const encryptedPayload = await this.oauthMaybeEncryptTokens(
          tokenPayload,
          new Hub.ActionCrypto(),
          request.webhookId,
        );
        return encryptedPayload;
      } else {
        throw new Error("OAuth tokens are invalid.");
      }
    } else {
      throw new Error("Request is missing state parameter.");
    }
  }

  async oauthCheck(request: Hub.ActionRequest) {
    if (request.params.state_json) {
      const tokenPayload = await this.oauthExtractTokensFromStateJson(
        request.params.state_json,
        request.webhookId,
      );
      if (tokenPayload) {
        const drive = await this.driveClientFromRequest(
          tokenPayload.redirect,
          tokenPayload.tokens,
        );
        await drive.files.list({
          pageSize: 10,
        });
        return true;
      }
    }
    return false;
  }

  oauth2Client(redirectUri: string | undefined): OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      redirectUri,
    );
  }

  async getDrives(
    drive: Drive,
    accumulatedFolders: drive_v3.Schema$Drive[],
    response: GaxiosResponse<drive_v3.Schema$DriveList>,
  ): Promise<drive_v3.Schema$Drive[]> {
    const driveList = accumulatedFolders.concat(response.data.drives!);

    if (response.data.nextPageToken) {
      const pageOptions = {
        pageSize: 50,
        pageToken: response.data.nextPageToken,
      };
      return this.getDrives(
        drive,
        driveList,
        await drive.drives.list(pageOptions),
      );
    }

    return driveList;
  }

  sanitizeGaxiosError(err: any) {
    const configObjs = [];
    if (err.config) {
      configObjs.push(err.config);
    }
    if (err.response && err.response.config) {
      configObjs.push(err.response.config);
    }
    for (const config of configObjs) {
      for (const prop of ["data", "body"]) {
        if (config[prop]) {
          config[prop] = "[REDACTED]";
        }
      }
    }
  }

  protected async getAccessTokenCredentialsFromCode(
    redirect: string,
    code: string,
  ) {
    const client = this.oauth2Client(redirect);
    const { tokens } = await client.getToken(code);
    return tokens;
  }

  protected async driveClientFromRequest(
    redirect: string,
    tokens: Credentials,
  ) {
    const client = this.oauth2Client(redirect);
    client.setCredentials(tokens);
    return google.drive({ version: "v3", auth: client });
  }

  protected async getUserEmail(redirect: string, tokens: Credentials) {
    const client = this.oauth2Client(redirect);
    client.setCredentials(tokens);
    const authy = google.oauth2({ version: "v2", auth: client });
    const response = await authy.tokeninfo();
    const email = response.data.email ? response.data.email : "INVALID";

    return email;
  }

  protected async validateUserInDomainAllowlist(
    domainAllowlist: string | undefined,
    redirect: string,
    tokens: Credentials,
    requestWebhookId: string | undefined,
  ) {
    // validating against optional domain allowlist
    if (domainAllowlist) {
      const domainValidator = new DomainValidator(domainAllowlist);
      // check for valid domain allowlist before fetching user email address
      if (domainValidator.hasValidDomains()) {
        const userEmail = await this.getUserEmail(redirect, tokens);

        if (domainValidator.isValidEmailDomain(userEmail)) {
          winston.info("Domain Verification successful", {
            webhookId: requestWebhookId,
          });
        } else {
          throw "Domain Verification unsuccessful";
        }
      } else {
        winston.info("No Domain Verification performed", {
          webhookId: requestWebhookId,
        });
      }
    }
  }

  protected async oauthExtractTokensFromStateJson(
    stateJson: string,
    requestWebhookId: string | undefined,
  ): Promise<Hub.ActionToken | null> {
    if (!stateJson || stateJson === "reset" || stateJson === "null") {
      winston.info("State is reset or empty", { webhookId: requestWebhookId });
      return null;
    }
    let state: any;
    try {
      state = JSON.parse(stateJson);
    } catch (e: any) {
      winston.error(`Failed to parse state_json: ${e.message}`, {
        webhookId: requestWebhookId,
      });
      return null;
    }
    let tokenPayload: Hub.ActionToken | null = null;
    if (state.cid && state.payload) {
      winston.info("Extracting encrypted state_json", {
        webhookId: requestWebhookId,
      });
      const encryptedPayload = new Hub.EncryptedPayload(
        state.cid,
        state.payload,
      );
      try {
        tokenPayload = await this.oauthDecryptTokens(
          encryptedPayload,
          new Hub.ActionCrypto(),
          requestWebhookId,
        );
      } catch (e: any) {
        winston.error(
          `Failed to decrypt or parse encrypted payload: ${e.message}`,
          { webhookId: requestWebhookId },
        );
        // tokenPayload remains null
      }
    } else if (state.tokens && state.redirect) {
      winston.info("Extracting unencrypted state_json", {
        webhookId: requestWebhookId,
      });
      tokenPayload = new Hub.ActionToken(state.tokens, state.redirect);
    }
    if (tokenPayload === null) {
      winston.info("No valid tokens found in state_json", { webhookId: requestWebhookId });
    }
    return tokenPayload;
  }

  protected validTokens(
    tokens: Credentials,
    requestWebhookId: string | undefined,
  ): boolean {
    if (tokens.refresh_token) {
      return true;
    } else {
      winston.error("Invalid OAuth token payload", {
        webhookId: requestWebhookId,
      });
      return false;
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
      );
    } else {
      return tokenPayload;
    }
  }

  protected async oauthEncryptTokens(
    tokenPayload: Hub.ActionToken,
    actionCrypto: Hub.ActionCrypto,
    requestWebhookId: string | undefined,
  ): Promise<Hub.EncryptedPayload> {
    const jsonPayload = JSON.stringify(tokenPayload);
    const encrypted = await actionCrypto
      .encrypt(jsonPayload)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured", {
          webhookId: requestWebhookId,
        });
        throw err;
      });
    return new Hub.EncryptedPayload(actionCrypto.cipherId(), encrypted);
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
        });
        throw err;
      });
    const tokenPayload: Hub.ActionToken = JSON.parse(jsonPayload);
    return tokenPayload;
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
    );
    if (this.validTokens(tokens, requestWebhookId)) {
      const tokenPayload = new Hub.ActionToken(tokens, redirectUri);
      const encryptedPayload = await this.oauthMaybeEncryptTokens(
        tokenPayload,
        new Hub.ActionCrypto(),
        requestWebhookId,
      );
      await https
        .post({
          url: statePayload.stateurl!,
          body: JSON.stringify(encryptedPayload),
        })
        .catch((_err) => {
          winston.error(_err.toString());
        });
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
    };
    const jsonString = JSON.stringify(newState);
    const ciphertextBlob = await actionCrypto
      .encrypt(jsonString)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured");
        throw err;
      });

    return `${statePayload.tokenurl!}?state=${ciphertextBlob}`;
  }

  private async loginForm(request: Hub.ActionRequest, errorMessage?: string) {
    const form = new Hub.ActionForm();
    form.fields = [];

    if (errorMessage) {
      form.fields.push({
        name: "error_message",
        type: "message",
        value: `⚠️ Login failed: ${errorMessage}`,
      });
    }

    const hasTokenUrl = request.params.hasOwnProperty("state_redir_url");
    winston.info(`Using ${hasTokenUrl ? "V2" : "V1"} flow`);
    const state: OauthState = hasTokenUrl
      ? { tokenurl: request.params.state_redir_url }
      : { stateurl: request.params.state_url };
    const jsonString = JSON.stringify(state);

    const actionCrypto = new Hub.ActionCrypto();
    const ciphertextBlob = await actionCrypto
      .encrypt(jsonString)
      .catch((err: string) => {
        winston.error("Encryption not correctly configured");
        throw err;
      });
    form.state = new Hub.ActionState();
    form.fields.push({
      name: "login",
      type: "oauth_link_google",
      label: "Log in",
      description:
        "In order to send to Google Docs, you will need to log in once to your Google account. " +
        "(If you just completed the login and still see this screen, please close and reopen or refresh this window.)\n\n" +
        `Diagnostics - Webhook ID: ${request.webhookId || "none"}`,
      oauth_url: `${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    });
    winston.debug(
      `Login form, OAuthURL${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    );
    return form;
  }

  // private getTableCellLocation(row: number, col: number, numColumns: number): number {
  //     // Each cell has a newline character, so we need to account for that in the index calculation
  //     // The +1 at the start is for the initial newline before the table
  //     return 1 + (row * numColumns + col)
  // }

  sanitizeFilename(filename: string) {
    return filename.split("'").join("\\'");
  }

  protected async delay(time: number) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, time);
    });
  }

  protected async docsClientFromRequest(redirect: string, tokens: Credentials) {
    const client = this.oauth2Client(redirect);
    client.setCredentials(tokens);
    return google.docs({ version: "v1", auth: client });
  }

  private async createDocWithTable(
    filename: string,
    request: Hub.ActionRequest,
    drive: Drive,
    docs: Docs,
  ) {
    let folder: string | undefined;

    if (request.formParams.folderid) {
      if (request.formParams.folderid.includes("my-drive")) {
        folder = ROOT;
      } else {
        const match = request.formParams.folderid.match(FOLDERID_REGEX);
        if (match && match.groups) {
          folder = match.groups.folderId;
        } else {
          folder = ROOT;
        }
      }
    } else {
      folder = request.formParams.folder;
    }

    const available_width =
      (DOCUMENT_PORTRAIT ? DOCUMENT_WIDTH : DOCUMENT_HEIGHT) -
      DOCUMENT_MARGIN * 2;
    // First create an empty document
    const fileMetadata: drive_v3.Schema$File = {
      name: this.sanitizeFilename(filename),
      mimeType: this.mimeType,
      parents: folder ? [folder] : undefined,
    };

    const driveParams: drive_v3.Params$Resource$Files$Create = {
      requestBody: fileMetadata,
      fields: "id",
    };

    if (
      request.formParams.drive !== undefined &&
      request.formParams.drive !== "mydrive"
    ) {
      driveParams.requestBody!.driveId! = request.formParams.drive;
      driveParams.supportsAllDrives = true;
    }

    const file = await drive.files.create(driveParams);
    const documentId = file.data.id;

    if (!documentId) {
      throw new Error("Failed to create document");
    }

    return new Promise<void>((resolve, reject) => {
      const rows: string[][] = [];
      const csvparser = parse({
        rtrim: true,
        ltrim: true,
        bom: true,
        relax_column_count: true,
      });

      csvparser.on("data", (line: string[]) => {
        rows.push(line);
      });

      csvparser.on("end", async () => {
        try {
          if (rows.length === 0) {
            throw new Error("No data to insert");
          }

          const headers = rows[0];

          // Create table with headers
          const init_requests: docs_v1.Schema$Request[] = [
            // Set landscape orientation
            {
              updateDocumentStyle: {
                documentStyle: {
                  pageSize: {
                    height: {
                      magnitude: DOCUMENT_HEIGHT,
                      unit: "PT",
                    },
                    width: {
                      magnitude: DOCUMENT_WIDTH,
                      unit: "PT",
                    },
                  },
                  marginLeft: {
                    magnitude: DOCUMENT_MARGIN,
                    unit: "PT",
                  },
                  marginRight: {
                    magnitude: DOCUMENT_MARGIN,
                    unit: "PT",
                  },
                  marginTop: {
                    magnitude: DOCUMENT_MARGIN,
                    unit: "PT",
                  },
                  marginBottom: {
                    magnitude: DOCUMENT_MARGIN,
                    unit: "PT",
                  },
                  // @ts-ignore
                  // flipPageOrientation: !DOCUMENT_PORTRAIT,
                },
                fields:
                  "pageSize,marginLeft,marginRight,marginTop,marginBottom,flipPageOrientation",
              },
            },
            // Create table
            {
              insertTable: {
                rows: rows.length,
                columns: headers.length,
                location: {
                  index: 1,
                },
              },
            },
          ];

          // First create the document structure and get the footer ID
          await this.retriableDocumentUpdate(
            documentId,
            docs,
            init_requests,
            0,
            request.webhookId!,
          );

          // Insert the data
          const batchedRequests: docs_v1.Schema$Request[][] = [[]];
          let currentBatch = 0;
          let index =
            5 +
            (rows.length - 1) * (headers.length * 2 + 1) +
            (headers.length - 1) * 2;
          let end_index = index + 0;
          const header_range: { start: number; end: number } = {
            start: 5,
            end: 5,
          };
          for (let row = rows.length - 1; row >= 0; row--) {
            for (let col = headers.length - 1; col >= 0; col--) {
              const cellText = rows[row][col] || " ";
              const cellLength = cellText.length;
              const insertRequest = {
                insertText: {
                  text: cellText,
                  location: {
                    index,
                  },
                },
              };
              if (batchedRequests[currentBatch].length >= MAX_REQUEST_BATCH) {
                currentBatch++;
                batchedRequests[currentBatch] = [];
              }
              batchedRequests[currentBatch].push(insertRequest);
              if (row === 0) {
                if (col === headers.length - 1) {
                  header_range.end = index + 0;
                }
                header_range.end += cellLength;
                batchedRequests[currentBatch].push({
                  updateTextStyle: {
                    textStyle: {
                      bold: true,
                    },
                    range: {
                      startIndex: index,
                      endIndex: index + cellLength,
                    },
                    fields: "bold",
                  },
                });
              }
              end_index += cellLength;
              index -= 2;
            }
            index -= 1;
          }
          // Apply the changes in batches
          for (const batch of batchedRequests) {
            await this.retriableDocumentUpdate(
              documentId,
              docs,
              batch,
              0,
              request.webhookId!,
            );
          }
          const after_requests: docs_v1.Schema$Request[] = [
            {
              // pin rows
              // @ts-ignore
              pinTableHeaderRows: {
                tableStartLocation: {
                  index: 2,
                },
                pinnedHeaderRowsCount: 1,
              },
            },
            {
              updateTableCellStyle: {
                tableCellStyle: {
                  backgroundColor: {
                    color: {
                      rgbColor: {
                        red: 0.95,
                        green: 0.95,
                        blue: 0.95,
                      },
                    },
                  },
                },
                fields: "backgroundColor",
                tableRange: {
                  columnSpan: headers.length,
                  rowSpan: 1,
                  tableCellLocation: {
                    columnIndex: 0,
                    rowIndex: 0,
                    tableStartLocation: {
                      index: 2,
                    },
                  },
                },
              },
            },
            // update first column width
            {
              updateTableColumnProperties: {
                tableStartLocation: {
                  index: 2,
                },
                columnIndices: [0],
                tableColumnProperties: {
                  widthType: "FIXED_WIDTH",
                  width: {
                    magnitude: FIRST_TABLE_COLUMN_WIDTH,
                    unit: "PT",
                  },
                },
                fields: "widthType,width",
              },
            },
            // update other column widths
            {
              updateTableColumnProperties: {
                tableStartLocation: {
                  index: 2,
                },
                columnIndices: Array.from(
                  { length: headers.length },
                  (_, i) => i,
                ).filter((i) => i !== 0),
                tableColumnProperties: {
                  widthType: "FIXED_WIDTH",
                  width: {
                    magnitude:
                      (available_width - FIRST_TABLE_COLUMN_WIDTH) /
                      (headers.length - 1),
                    unit: "PT",
                  },
                },
                fields: "widthType,width",
              },
            },
            {
              updateParagraphStyle: {
                paragraphStyle: {
                  namedStyleType: "NORMAL_TEXT",
                  lineSpacing: 50,
                },
                fields: "namedStyleType,lineSpacing",
                range: {
                  startIndex: 1,
                  endIndex: end_index,
                },
              },
            },
            {
              updateTextStyle: {
                textStyle: {
                  fontSize: {
                    magnitude: 8,
                    unit: "PT",
                  },
                },
                fields: "fontSize",
                range: {
                  startIndex: header_range.end,
                  endIndex: end_index,
                },
              },
            },
            {
              updateSectionStyle: {
                sectionStyle: {
                  // @ts-ignore
                  flipPageOrientation: !DOCUMENT_PORTRAIT,
                },
                fields: "flipPageOrientation",
                range: {
                  startIndex: 0,
                  endIndex: 1,
                },
              },
            },
          ];
          await this.retriableDocumentUpdate(
            documentId,
            docs,
            after_requests,
            0,
            request.webhookId!,
          );

          resolve();
        } catch (e) {
          reject(e);
        }
      });

      csvparser.on("error", (e) => {
        reject(e);
      });

      request.stream(async (readable) => {
        readable.pipe(csvparser);
        return Promise.resolve();
      });
    });
  }

  private async retriableDocumentUpdate(
    documentId: string,
    docs: Docs,
    requests: docs_v1.Schema$Request[],
    attempt: number,
    webhookId: string,
  ): Promise<any> {
    return docs.documents
      .batchUpdate({
        documentId,
        requestBody: {
          requests,
        },
      })
      .catch(async (e: any) => {
        this.sanitizeGaxiosError(e);
        winston.debug(`Document update error: ${e}`, { webhookId });
        if (
          RETRIABLE_CODES.includes(e.code) &&
          process.env.GOOGLE_DOCS_RETRY &&
          attempt < MAX_RETRY_COUNT
        ) {
          winston.warn("Queueing retry for document update", { webhookId });
          await this.delay(RETRY_BASE_DELAY ** attempt * 1000);
          // Try again and increment attempt
          return this.retriableDocumentUpdate(
            documentId,
            docs,
            requests,
            attempt + 1,
            webhookId,
          );
        } else {
          throw e;
        }
      });
  }

  private async retriableFileList(
    drive: Drive,
    options: any,
    attempt: number,
    webhookId: string,
  ): Promise<any> {
    return await drive.files.list(options).catch(async (e: any) => {
      this.sanitizeGaxiosError(e);
      winston.debug(`File list error: ${e}`, { webhookId });
      if (
        RETRIABLE_CODES.includes(e.code) &&
        process.env.GOOGLE_DOCS_RETRY &&
        attempt < MAX_RETRY_COUNT
      ) {
        winston.warn("Queueing retry for file list", { webhookId });
        await this.delay(RETRY_BASE_DELAY ** attempt * 1000);
        // Try again and increment attempt
        return this.retriableFileList(drive, options, attempt + 1, webhookId);
      } else {
        throw e;
      }
    });
  }
}

Hub.addAction(new GoogleDocsAction());
