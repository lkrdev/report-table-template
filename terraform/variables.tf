variable "project_id" {
  type        = string
  description = "The Google Cloud Project ID to deploy to."
}

variable "region" {
  type        = string
  description = "The Google Cloud region to deploy resources to."
  default     = "us-central1"
}

variable "google_drive_client_id" {
  type        = string
  description = "The Google Drive Client ID for OAuth."
}

variable "google_drive_client_secret" {
  type        = string
  description = "The Google Drive Client Secret for OAuth."
  sensitive   = true
}

variable "image" {
  type        = string
  description = "The Docker image to deploy. If deploying for the first time, you can leave the default placeholder, build/push your container, and then update this variable."
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "action_hub_base_url" {
  type        = string
  description = "The URL of the deployed Cloud Run service. Leave empty on the first run, then populate with the outputted service URL and re-apply."
  default     = ""
}
