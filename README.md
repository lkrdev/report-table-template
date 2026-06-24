# Google Sheets Excel Template Looker Action Hub

A lightweight, fully minimized standalone Looker Action Hub hosting **only** the Google Sheets Excel Template action (`google-sheet-xlsx-template`).

This action allows Looker users to generate beautifully formatted Excel (`.xlsx`) files by merging dynamic Looker query data with a pre-formatted Excel template stored in Google Drive. This is ideal for generating highly branded, customized reports with complex layouts, formulas, and formatting that standard CSV or Excel exports cannot achieve.

---

## What It Does

When Looker sends a query payload via webhook, this service:
1. **Validates OAuth2 User Credentials**: Authenticates the user against Google Drive APIs (requiring `drive` and `userinfo.email` scopes), enforcing optional domain allowlists (`domain_allowlist`).
2. **Downloads the Excel Template**: Retrieves a selected `.xlsx` template file from a specified folder in Google Drive.
3. **Populates the Template**:
   - Uses [ExcelJS](https://github.com/exceljs/exceljs) to parse the template.
   - Detects the **repeating data row** automatically by scanning for cells containing `{{ data.field_name }}` or `{{ data._columns[i] }}`.
   - Automatically duplicates and shifts rows to insert the entire Looker query result table while preserving cell styles, heights, and formulas.
   - Resolves all other single-value placeholders in the sheet (e.g., in headers, titles, or footers) using query metadata, execution details, or filters.
   - If any placeholders cannot be resolved, it appends a list of errors to a special `_errors` sheet in the workbook.
4. **Uploads the Populated Excel File**: Saves the final populated spreadsheet back to your Google Drive (or Shared Drive) in the chosen destination folder.

---

## Handlebars / Template Placeholders Reference

You can design your Excel templates with the following placeholder patterns inside any cells:

| Expression Pattern | Description | Example |
| :--- | :--- | :--- |
| `{{ _built_in.run_at }}` | The timestamp when the query was executed. | `2026-06-24T18:20:22Z` |
| `{{ _built_in.title }}` | The title of the scheduled plan. | `Weekly Sales Report` |
| `{{ _built_in.description }}` | The description of the scheduled plan. | *Optional description text* |
| `{{ _filters.view_name.field_name }}` | The value of a specific filter applied to the query. | `{{ _filters.users.state }}` $\rightarrow$ `California` |
| `{{ fields.view_name.field_name.label }}` | The human-readable label of a specific field. | `{{ fields.users.state.label }}` $\rightarrow$ `State` |
| `{{ data[index].view_name.field_name }}` | An explicit, absolute row lookup from the results (0-indexed). | `{{ data[0].products.brand }}` |
| `{{ data.view_name.field_name }}` | The value of the field for the current row (used in the repeating row). | `{{ data.users.state }}` |
| `{{ data._columns[index] }}` | The value of the N-th column in the current row (used in the repeating row). | `{{ data._columns[0] }}` |

> [!NOTE]
> **Repeating Rows**: The action automatically identifies the row containing repeating cell patterns (e.g., `{{ data.users.state }}`) and replicates it for every row in the dataset. Any rows below it are shifted down, and formulas referencing those rows are automatically adjusted by Excel.

---

## Prerequisites

For **local development and testing**:
- [Node.js (>= 20.16.0)](https://nodejs.org/) and [Yarn (>= 1.19.1)](https://yarnpkg.com/).
- [Astral uv](https://docs.astral.sh/uv/getting-started/installation/) for managing Python environments and scripts.

For **deploying to Google Cloud**:
- Install the [Google Cloud SDK (gcloud CLI)](https://cloud.google.com/sdk/docs/install) locally, or use [Google Cloud Shell](https://cloud.google.com/shell).

---

## Connecting to Looker

Register the deployed Action Hub within Looker:
1. Navigate to **Admin** > **Platform** > **Actions**.
2. Click **Add Action Hub**.
3. Enter your deployed Cloud Run URL (e.g., `https://google-sheets-excel-template-xxx-uc.a.run.app`).
4. Supply your **Authorization Token** (`ACTION_HUB_SECRET` or authorization headers).
5. Click **Add Hub** and enable the **Google Sheets Excel Template** action.

---

## Google OAuth Client Setup

To allow Looker users to authenticate with Google Drive, you must create Google OAuth 2.0 credentials:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Select your Google Cloud project or create a new one.
3. Configure the OAuth Consent Screen:
   - Navigate to **APIs & Services** > **OAuth consent screen**.
   - Choose **Internal** (if you want to limit access to users in your Google Workspace organization) or **External**, then click **Create**.
   - Fill in the required application details and click **Save and Continue**.
   - In the **Scopes** page, add:
     - `https://www.googleapis.com/auth/drive` (to access and save files)
     - `https://www.googleapis.com/auth/userinfo.email` (to fetch the user's email address)
   - Click **Save and Continue**.
4. Generate OAuth Credentials:
   - Navigate to **APIs & Services** > **Credentials**.
   - Click **+ Create Credentials** at the top of the page, and select **OAuth client ID**.
   - Set **Application type** to **Web application**.
   - In the **Authorized redirect URIs** section, click **+ Add URI**:
     - **For local development**: `http://localhost:8080/actions/google-sheet-xlsx-template/oauth_redirect`
     - **For Cloud Run deployment**: `https://<your-cloud-run-domain>/actions/google-sheet-xlsx-template/oauth_redirect`
   - Click **Create**.
5. Save the generated **Client ID** and **Client Secret**. These will be used for the `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` environment variables.

---

## Deploying to Google Cloud Run

### Option A: Deploying via Google Cloud Shell (Recommended)

You can deploy this integration directly to Cloud Run using Google Cloud Shell. This opens Google Cloud Shell, clones the repository, and runs the interactive setup script:

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://ssh.cloud.google.com/cloudshell/editor?shellonly=true&cloudshell_git_repo=https://github.com/lkrdev/google-sheets-excel-template)

After the Cloud Shell environment finishes loading, execute the deployment script. You can run it interactively (the script will prompt you for any missing options) or run it fully unattended by passing command-line arguments:

```bash
# Run interactively (will prompt for missing credentials)
./deploy.sh

# Or run non-interactively by passing arguments directly
./deploy.sh --project-id="my-project-id" --drive-client-id="my-client-id" --drive-client-secret="my-client-secret"
```

*(Note: The script will automatically install `uv` if it is not already present on your system, and then launch the Python wizard. Any arguments you pass to `./deploy.sh` are automatically forwarded directly to the underlying `bin/deploy.py` script.)*

This script will automatically:
* Enable the required Google Cloud APIs (Cloud Run, Secret Manager, and Google Drive).
* Prompt you for (or accept via arguments) your Google Drive Client ID and Client Secret.
* Generate and store secure encryption keys in Secret Manager (`cipher-master` and `action-hub-secret`).
* Deploy the integration to Google Cloud Run.
* Optionally register the Action Hub automatically in your Looker instance.
* Output the final URL and API Token details.

### CLI Options Reference

The deployment script (`./deploy.sh` / `bin/deploy.py`) supports the following command-line options:

| Option | Shorthand | Type | Description |
| :--- | :--- | :--- | :--- |
| `--project-id` | `-p` | `TEXT` | Google Cloud Project ID |
| `--drive-client-id` | | `TEXT` | Google Drive Client ID |
| `--drive-client-secret` | | `TEXT` | Google Drive Client Secret |
| `--region` | `-r` | `TEXT` | Cloud Run region (e.g. `us-central1`) |
| `--service-account-email` | | `TEXT` | Specific pre-existing service account email to run the Cloud Run service. (Note: If specified, the script will automatically grant the necessary Secret Accessor and Log Writer roles to it.) |
| `--register-looker` / `--no-register-looker` | | `FLAG` | Automatically register the action in Looker |
| `--looker-url` | | `TEXT` | Looker Base URL (e.g., `https://yourcompany.looker.com`) |
| `--looker-client-id` | | `TEXT` | Looker Client ID |
| `--looker-client-secret` | | `TEXT` | Looker Client Secret |
| `--help` | | `FLAG` | Show help message and exit |

---

### Option B: Deploying via CLI (gcloud)

1. Enable the Google Drive API in your Google Cloud Project:
```bash
gcloud services enable drive.googleapis.com
```

2. Deploy the standalone action integration to Google Cloud Run:
```bash
export GOOGLE_DRIVE_CLIENT_ID=<your generated client id>
export GOOGLE_DRIVE_CLIENT_SECRET=<your generated secret>
export CIPHER_MASTER=$(openssl rand -hex 32)
export ACTION_HUB_SECRET=$(openssl rand -hex 32)

gcloud secrets create cipher-master \
  --data-file <(echo $CIPHER_MASTER)

gcloud secrets create action-hub-secret \
  --data-file <(echo $ACTION_HUB_SECRET)

gcloud run deploy google-sheets-excel-template \
  --image=us-central1-docker.pkg.dev/lkr-dev-production/looker-action/google-sheets-excel-template:latest \
  --platform=managed \
  --region=us-central1 \
  --no-invoker-iam-check \
  --set-env-vars="GOOGLE_DRIVE_CLIENT_ID=your_id,GOOGLE_DRIVE_CLIENT_SECRET=your_secret,ACTION_HUB_SECRET=your_action_hub_secret,ACTION_HUB_BASE_URL=https://your-cloud-run-url,ACTION_HUB_LABEL=Google Sheets Excel Template,CIPHER_MASTER=your_cipher_master"
```

---

### Option C: Deploying via Google Cloud Web Console (UI)

1. **Enable APIs**:
   - Go to **APIs & Services** > **Library** in the GCP Console.
   - Search for **Google Drive API** and click **Enable**.

2. **Create Secrets**:
   - Navigate to **Security** > **Secret Manager** and click **Create Secret**.
   - Name it `cipher-master`, enter a randomly generated 32-byte hex string (e.g. from `openssl rand -hex 32` locally) as the secret value, and click **Create Secret**.
   - Click **Create Secret** again. Name it `action-hub-secret`, enter a randomly generated secret value (to authenticate Looker), and click **Create Secret**.

3. **Deploy Cloud Run Service**:
   - Navigate to **Cloud Run** and click **Create Service**.
   - Select **Deploy one revision from an existing container image**.
   - Paste the container image URL: `us-central1-docker.pkg.dev/lkr-dev-production/looker-action/google-sheets-excel-template:latest`
   - Name your service (e.g., `google-sheets-excel-template`) and select your **Region**.
   - Under **Authentication**, select **Allow unauthenticated invocations**.
   - Expand the **Container, Volumes, Connections, Security** section:
     - Under **Variables & Secrets**, add the following environment variables:
       - `GOOGLE_DRIVE_CLIENT_ID`: Your Google OAuth Client ID.
       - `GOOGLE_DRIVE_CLIENT_SECRET`: Your Google OAuth Client Secret.
       - `ACTION_HUB_LABEL`: `Google Sheets Excel Template`
       - `ACTION_HUB_BASE_URL`: The URL of your deployed Cloud Run service. (Note: You can update this environment variable with the generated URL after deployment).
     - Reference your secrets as environment variables:
       - Reference secret `cipher-master` (version `latest`) and expose it as environment variable `CIPHER_MASTER`.
       - Reference secret `action-hub-secret` (version `latest`) and expose it as environment variable `ACTION_HUB_SECRET`.
    - Click **Create** to deploy.

---

### Option D: Deploying via Terraform

If you prefer Infrastructure-as-Code (IaC), you can provision all necessary Google Cloud resources (APIs, Service Account, Secrets, IAM policies, Artifact Registry, and Cloud Run) using Terraform.

1. Navigate to the `terraform` directory:
   ```bash
   cd terraform
   ```

2. Copy the example variables file:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```

3. Open `terraform.tfvars` and fill in your configuration (your Google Cloud project ID, preferred region, and Google Drive OAuth credentials).

4. Initialize and apply the Terraform configuration:
   ```bash
   terraform init
   ```
   ```bash
   terraform apply
   ```
   *(This will initially deploy a lightweight placeholder container because your custom integration container has not yet been built and pushed to the repository.)*

5. Build and push your integration container to the newly created Artifact Registry using Google Cloud Build:
   ```bash
   gcloud builds submit --tag $(terraform output -raw suggested_docker_image_tag) ..
   ```

6. Update the Cloud Run service with the newly built image and the final service URL:
   ```bash
   terraform apply -var="image=$(terraform output -raw suggested_docker_image_tag)" -var="action_hub_base_url=$(terraform output -raw service_url)"
   ```

7. Add the OAuth redirect URI to your Google Cloud Console OAuth Client ID:
   ```
   <your_service_url>/actions/google-sheet-xlsx-template/oauth_redirect
   ```

---

## Local Development

### Setup & Run
```bash
# Install dependencies
yarn install

# Configure environment variables
cp .env.example .env
# Set GOOGLE_DRIVE_CLIENT_ID & GOOGLE_DRIVE_CLIENT_SECRET in .env

# Start production server
yarn start

# Run development server with hot-reloading
yarn dev
```

---

## Testing

Run the test suite (Mocha unit/integration tests, TypeScript compilation, and linter):
```bash
yarn test
```
