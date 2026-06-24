output "service_url" {
  value       = google_cloud_run_v2_service.service.uri
  description = "The URL of the deployed Excel Template Action Hub service."
}

output "artifact_registry_repository_url" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}"
  description = "The Artifact Registry repository URL for pushing your container image."
}

output "suggested_docker_image_tag" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}/excel-template-action:latest"
  description = "The recommended image tag to use when building and pushing your Docker container."
}

output "instructions" {
  value       = <<EOF
To complete the setup:
1. If you used the default placeholder image, build and push your real Docker image using:
   gcloud builds submit --tag ${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}/excel-template-action:latest ..

2. Re-run `terraform apply` with the following variables:
   - image               = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}/excel-template-action:latest"
   - action_hub_base_url = "<the service_url output above>"

3. Add the OAuth redirect URI to your Google Cloud Console OAuth Client ID:
   ${google_cloud_run_v2_service.service.uri}/actions/google_docs/oauth_redirect
EOF
  description = "Next steps to complete deployment."
}
