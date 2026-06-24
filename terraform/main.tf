terraform {
  required_version = ">= 1.3.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# 1. Enable Google Cloud APIs
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "drive.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com"
  ])
  service            = each.key
  disable_on_destroy = false
}

# 2. Create a dedicated Service Account for Cloud Run
resource "google_service_account" "sa" {
  account_id   = "google-sheets-excel-temp-sa"
  display_name = "Google Sheets Excel Template Service Account"
  description  = "Dedicated service account for Google Sheets Excel Template"
  depends_on   = [google_project_service.services]
}

# 3. Generate and store Cipher Master Key
resource "random_id" "cipher_master" {
  byte_length = 32
}

resource "google_secret_manager_secret" "cipher_master" {
  secret_id = "cipher-master"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "cipher_master" {
  secret      = google_secret_manager_secret.cipher_master.id
  secret_data = random_id.cipher_master.hex
}

# 4. Generate and store Action Hub Secret Key
resource "random_id" "action_hub_secret" {
  byte_length = 32
}

resource "google_secret_manager_secret" "action_hub_secret" {
  secret_id = "action-hub-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "action_hub_secret" {
  secret      = google_secret_manager_secret.action_hub_secret.id
  secret_data = random_id.action_hub_secret.hex
}

# 5. Store Google Drive Client Secret
resource "google_secret_manager_secret" "drive_client_secret" {
  secret_id = "google-drive-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "drive_client_secret" {
  secret      = google_secret_manager_secret.drive_client_secret.id
  secret_data = var.google_drive_client_secret
}

# 6. Grant Secret Manager Secret Accessor role to the Service Account
resource "google_secret_manager_secret_iam_member" "cipher_master_accessor" {
  secret_id = google_secret_manager_secret.cipher_master.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa.email}"
}

resource "google_secret_manager_secret_iam_member" "action_hub_secret_accessor" {
  secret_id = google_secret_manager_secret.action_hub_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa.email}"
}

resource "google_secret_manager_secret_iam_member" "drive_client_secret_accessor" {
  secret_id = google_secret_manager_secret.drive_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa.email}"
}

# 7. Create Artifact Registry Repository for the Docker image
resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = "google-sheets-excel-template"
  description   = "Docker repository for Google Sheets Excel Template"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]
}

# 8. Deploy Cloud Run Service
resource "google_cloud_run_v2_service" "service" {
  name                 = "google-sheets-excel-template"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account = google_service_account.sa.email

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "2.0"
          memory = "4Gi"
        }
      }

      env {
        name  = "GOOGLE_DRIVE_CLIENT_ID"
        value = var.google_drive_client_id
      }

      env {
        name  = "ACTION_HUB_LABEL"
        value = "lkr.dev actions (excel template)"
      }

      env {
        name  = "ACTION_HUB_BASE_URL"
        value = var.action_hub_base_url != "" ? var.action_hub_base_url : "http://placeholder"
      }

      env {
        name = "CIPHER_MASTER"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cipher_master.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ACTION_HUB_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.action_hub_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_DRIVE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.drive_client_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_version.cipher_master,
    google_secret_manager_secret_version.action_hub_secret,
    google_secret_manager_secret_version.drive_client_secret,
    google_secret_manager_secret_iam_member.cipher_master_accessor,
    google_secret_manager_secret_iam_member.action_hub_secret_accessor,
    google_secret_manager_secret_iam_member.drive_client_secret_accessor,
  ]
}

# 9. Public access is handled via invoker_iam_disabled = true on the service resource itself,
# which is compatible with Domain Restricted Sharing organization policies.

# 10. Grant Cloud Build Editor role to the Service Account
resource "google_project_iam_member" "sa_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.sa.email}"
}

# 11. Grant Storage Object Admin role to the Service Account
resource "google_project_iam_member" "sa_storage_object_admin" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.sa.email}"
}

# 12. Grant Logs Writer role to the Service Account
resource "google_project_iam_member" "sa_logging_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.sa.email}"
}

# 13. Grant Artifact Registry Writer role to the Service Account
resource "google_project_iam_member" "sa_artifact_registry_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.sa.email}"
}
