#!/usr/bin/env uv run
# /// script
# dependencies = [
#     "typer>=0.9.0",
#     "rich>=13.0.0",
#     "questionary>=2.0.0",
# ]
# ///

import hashlib
import hmac
import os
import secrets
import subprocess
import sys
import time
from typing import Optional

import questionary
import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()

def run_cmd(
    cmd: list[str], 
    check: bool = True, 
    capture_output: bool = False, 
    env: Optional[dict] = None
) -> subprocess.CompletedProcess:
    """Helper to run a shell command with consistent logging and error handling."""
    try:
        res = subprocess.run(
            cmd,
            check=check,
            text=True,
            capture_output=capture_output,
            env=env,
            stdin=subprocess.DEVNULL
        )
        return res
    except subprocess.CalledProcessError as e:
        console.print(f"\n[bold red]Error running command:[/bold red] {' '.join(cmd)}")
        if e.stderr:
            console.print(f"[red]{e.stderr.strip()}[/red]")
        sys.exit(1)

def get_secret_value(secret_name: str) -> str:
    """Retrieve the latest value of a secret from Secret Manager."""
    res = run_cmd(
        ["gcloud", "secrets", "versions", "access", "latest", f"--secret={secret_name}"], 
        capture_output=True
    )
    return res.stdout.strip()

def secret_exists(secret_name: str) -> bool:
    """Check if a secret exists in Secret Manager."""
    res = subprocess.run(
        ["gcloud", "secrets", "describe", secret_name],
        capture_output=True,
        stdin=subprocess.DEVNULL
    )
    return res.returncode == 0

def run_cmd_with_retry(
    cmd: list[str], error_substrings: list[str], max_retries: int = 12, delay: int = 5
):
    """Run a command, retrying if the stderr contains any of the error_substrings."""
    for attempt in range(1, max_retries + 1):
        res = run_cmd(cmd, check=False, capture_output=True)
        if res.returncode == 0:
            return res
        
        stderr_msg = res.stderr or ""
        should_retry = any(sub in stderr_msg for sub in error_substrings)
        
        if should_retry and attempt < max_retries:
            console.print(f"  [yellow]Command failed, retrying in {delay}s... (attempt {attempt}/{max_retries})[/yellow]")
            time.sleep(delay)
        else:
            console.print(f"\n[bold red]Error running command after {attempt} attempts:[/bold red] {' '.join(cmd)}")
            console.print(f"[red]{stderr_msg.strip()}[/red]")
            sys.exit(1)

def create_secret_if_missing(secret_name: str, secret_val: str | None = None):
    """Create a secret in Secret Manager if it doesn't exist, and add the value as the latest version."""
    if secret_exists(secret_name):
        console.print(f"Secret [bold green]{secret_name}[/bold green] already exists.")
        return

    console.print(f"Creating secret [bold cyan]{secret_name}[/bold cyan]...")
    run_cmd(["gcloud", "secrets", "create", secret_name, "--replication-policy=automatic"])
    
    # Add version securely via stdin to avoid exposing in process lists
    proc = subprocess.Popen(
        ["gcloud", "secrets", "versions", "add", secret_name, "--data-file=-"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    stdout, stderr = proc.communicate(input=secret_val)
    if proc.returncode != 0:
        console.print(f"[bold red]Failed to add version to secret {secret_name}:[/bold red] {stderr}")
        sys.exit(1)

def main(
    project_id: Optional[str] = typer.Option(None, "--project-id", "-p", help="Google Cloud Project ID"),
    drive_client_id: Optional[str] = typer.Option(None, "--drive-client-id", help="Google Drive Client ID"),
    drive_client_secret: Optional[str] = typer.Option(None, "--drive-client-secret", help="Google Drive Client Secret"),
    region: Optional[str] = typer.Option(None, "--region", "-r", help="Cloud Run region (e.g. us-central1)"),
    service_account_email: Optional[str] = typer.Option(None, "--service-account-email", help="Specific service account email to run the service"),
    register_looker: Optional[bool] = typer.Option(None, "--register-looker/--no-register-looker", help="Automatically register the action in Looker"),
    looker_url: Optional[str] = typer.Option(None, "--looker-url", help="Looker Base URL"),
    looker_client_id: Optional[str] = typer.Option(None, "--looker-client-id", help="Looker Client ID"),
    looker_client_secret: Optional[str] = typer.Option(None, "--looker-client-secret", help="Looker Client Secret"),
):
    console.print(Panel.fit(
        "[bold green]🚀 Google Docs Action Hub Deployment Wizard[/bold green]",
        border_style="green",
        padding=(0, 5)
    ))

    # 1. Verify gcloud authentication & retrieve/verify Project ID
    try:
        current_project = run_cmd(["gcloud", "config", "get-value", "project"], capture_output=True).stdout.strip()
    except Exception:
        console.print("[bold red]Error: gcloud is not authenticated or not installed.[/bold red]")
        console.print("Please run [bold yellow]gcloud auth login[/bold yellow] first.")
        raise typer.Exit(1)

    if not project_id:
        if current_project:
            project_id = questionary.text("Enter Google Cloud Project ID:", default=current_project).ask()
        else:
            project_id = questionary.text("Enter Google Cloud Project ID:").ask()
            
    if not project_id:
        console.print("[bold red]Error: Project ID is required.[/bold red]")
        raise typer.Exit(1)

    # Set project for all child processes using the official environment variable override
    os.environ["CLOUDSDK_CORE_PROJECT"] = project_id

    # 2. Check if Google Drive Client Secret is already in Secret Manager
    has_drive_secret = secret_exists("google-drive-client-secret")
    if has_drive_secret:
        console.print("[bold green]✔[/bold green] Found existing [bold cyan]google-drive-client-secret[/bold cyan] in Secret Manager.")

    # 3. Prompt for missing credentials/parameters
    if not drive_client_id:
        drive_client_id = questionary.text("Enter GOOGLE_DRIVE_CLIENT_ID:").ask()
    if not drive_client_id:
        console.print("[bold red]Error: GOOGLE_DRIVE_CLIENT_ID is required.[/bold red]")
        raise typer.Exit(1)

    if not has_drive_secret and not drive_client_secret:
        drive_client_secret = questionary.password("Enter GOOGLE_DRIVE_CLIENT_SECRET:").ask()
    if not has_drive_secret and not drive_client_secret:
        console.print("[bold red]Error: GOOGLE_DRIVE_CLIENT_SECRET is required to initialize the secret.[/bold red]")
        raise typer.Exit(1)

    # Prompt for Cloud Run Region
    if not region:
        region = questionary.select(
            "Select Cloud Run region:",
            choices=[
                "us-central1",
                "us-east1",
                "us-west1",
                "europe-west1",
                "asia-east1",
                "Other (type manually)"
            ],
            default="us-central1"
        ).ask()
        if region == "Other (type manually)":
            region = questionary.text("Enter Cloud Run region:").ask()
            
    if not region:
        region = "us-central1"

    # Prompt for Looker Registration (if not explicitly passed as flag)
    if register_looker is None:
        register_looker = questionary.confirm("Do you want to automatically register this action in Looker?", default=False).ask()



    if register_looker:
        console.print("\n[bold yellow]Note:[/bold yellow] We will not save or store your Looker API credentials.")
        if not looker_url:
            looker_url = questionary.text("Enter Looker Base URL (e.g. https://yourcompany.looker.com):").ask()
        if not looker_client_id:
            looker_client_id = questionary.text("Enter Looker Client ID:").ask()
        if not looker_client_secret:
            looker_client_secret = questionary.password("Enter Looker Client Secret:").ask()

    # 4. Enable required APIs
    apis = [
        "run.googleapis.com",
        "secretmanager.googleapis.com",
        "drive.googleapis.com",
        "docs.googleapis.com"
    ]


    with console.status("[bold green]Enabling Google Cloud APIs (this may take a minute)..."):
        run_cmd(["gcloud", "services", "enable"] + apis, capture_output=True)
    console.print("[bold green]✔[/bold green] Google Cloud APIs enabled successfully.")

    # 5. Configure Service Account
    if not service_account_email:
        # Retrieve Project Number for default Compute Engine service account fallback
        project_number_res = run_cmd(
            ["gcloud", "projects", "describe", project_id, "--format=value(projectNumber)"],
            capture_output=True
        )
        project_number = project_number_res.stdout.strip()
        service_account_email = f"{project_number}-compute@developer.gserviceaccount.com"

    max_retries = 12
    retry_delay = 5
    runtime_roles = [
        "roles/secretmanager.secretAccessor",
        "roles/logging.logWriter"
    ]
    console.print(f"Granting required runtime roles to [bold cyan]{service_account_email}[/bold cyan] on the project...")
    for role in runtime_roles:
        run_cmd_with_retry(
            ["gcloud", "projects", "add-iam-policy-binding", project_id, f"--member=serviceAccount:{service_account_email}", f"--role={role}"],
            error_substrings=["does not exist", "INVALID_ARGUMENT"],
            max_retries=max_retries,
            delay=retry_delay
        )
    with console.status("[bold green]Waiting 30 seconds for IAM permissions to propagate..."):
        time.sleep(30)
    console.print("[bold green]✔[/bold green] IAM permissions propagated.")



    # 6. Create Secrets in Secret Manager if they do not exist
    if not secret_exists("cipher-master"):
        create_secret_if_missing("cipher-master", secrets.token_hex(32))

    if secret_exists("action-hub-secret"):
        console.print("Retrieving existing [bold cyan]action-hub-secret[/bold cyan] secret...")
        action_hub_secret_val = get_secret_value("action-hub-secret")
    else:
        action_hub_secret_val = secrets.token_hex(32)
        create_secret_if_missing("action-hub-secret", action_hub_secret_val)

    # Handle google-drive-client-secret
    if not has_drive_secret:
        create_secret_if_missing("google-drive-client-secret", drive_client_secret)

    # 7. Deploy to Google Cloud Run
    console.print("\n[bold cyan]Deploying service to Google Cloud Run...[/bold cyan]")

    action_hub_label = "lkr.dev actions (excel template)"

    deploy_cmd = [
        "gcloud",
        "run",
        "deploy",
        "excel-template-action",
        "--platform",
        "managed",
        f"--region={region}",
        "--no-invoker-iam-check",
        "--cpu=2",
        "--memory=4Gi",
        "--timeout=60m",
        "--concurrency=10",
        f"--set-env-vars=GOOGLE_DRIVE_CLIENT_ID={drive_client_id},ACTION_HUB_LABEL={action_hub_label},ACTION_HUB_BASE_URL=http://placeholder",
        "--set-secrets=CIPHER_MASTER=cipher-master:latest,ACTION_HUB_SECRET=action-hub-secret:latest,GOOGLE_DRIVE_CLIENT_SECRET=google-drive-client-secret:latest",
    ]
    
    if service_account_email:
        deploy_cmd.append(f"--service-account={service_account_email}")
    
    deploy_cmd.extend([
        "--image", "us-central1-docker.pkg.dev/lkr-dev-production/looker-action/excel-template-action:latest"
    ])
    
    # Run the deployment and stream output to console
    run_cmd(deploy_cmd)

    # 8. Post-deployment configuration (Update URL)
    console.print("\n[bold cyan]Retrieving Deployed Service URL...[/bold cyan]")
    url_res = run_cmd([
        "gcloud", "run", "services", "describe", "excel-template-action",
        "--platform", "managed",
        f"--region={region}",
        "--format=value(status.url)"
    ], capture_output=True)
    service_url = url_res.stdout.strip()

    console.print(f"Deployed Service URL: [bold green]{service_url}[/bold green]")
    console.print(f"Updating ACTION_HUB_BASE_URL env var on Cloud Run to [bold green]{service_url}[/bold green]...")
    run_cmd([
        "gcloud", "run", "services", "update", "excel-template-action",
        "--platform", "managed",
        f"--region={region}",
        f"--update-env-vars=ACTION_HUB_BASE_URL={service_url}"
    ], capture_output=True)

    # Natively generate the API Key Token (HMAC SHA512)
    nonce = secrets.token_bytes(32).hex()
    digest = hmac.new(
        action_hub_secret_val.encode("utf-8"),
        nonce.encode("utf-8"),
        hashlib.sha512
    ).hexdigest()
    api_key_token = f"{nonce}/{digest}"

    # 9. Register in Looker if selected
    if register_looker:
        console.print("\n[bold cyan]Registering action with Looker Instance...[/bold cyan]")
        
        assert looker_client_id is not None
        assert looker_client_secret is not None
        assert looker_url is not None

        env = os.environ.copy()
        env["SERVICE_URL"] = service_url
        env["API_KEY_TOKEN"] = api_key_token
        env["LOOKERSDK_CLIENT_ID"] = looker_client_id
        env["LOOKERSDK_CLIENT_SECRET"] = looker_client_secret
        env["LOOKERSDK_BASE_URL"] = looker_url

        script_dir = os.path.dirname(os.path.abspath(__file__))
        register_script = os.path.join(script_dir, "register_integration.py")

        # Run registration script via uv
        run_cmd([
            "uv", "run", register_script
        ], env=env)

    # 10. Display Registration Details
    table = Table(title="Looker Action Hub Registration Details", show_header=True, header_style="bold magenta")
    table.add_column("Parameter", style="cyan", width=30)
    table.add_column("Value", style="green")
    
    table.add_row("Action Hub URL", service_url)
    table.add_row("Authorization Token (API Key)", api_key_token)
    table.add_row("OAuth Redirect URI", f"{service_url}/actions/google_docs/oauth_redirect")
    
    console.print("\n")
    console.print(Panel.fit(
        table,
        title="[bold green]🎉 Deployment & Configuration Successful![/bold green]",
        border_style="green",
        padding=(1, 2)
    ))
    
    console.print("\n[bold yellow]Important: [/bold yellow]Make sure to add the OAuth Redirect URI to your Google OAuth Client ID credentials at:")
    console.print(f"https://console.cloud.google.com/auth/clients?project={project_id}\n")

if __name__ == "__main__":
    typer.run(main)
