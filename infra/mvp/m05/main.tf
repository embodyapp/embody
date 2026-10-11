terraform {
  required_version = "~> 1.16.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.6.0"
    }
  }
  backend "gcs" {}
}

provider "google" {
  project = var.project
  region  = var.region
}

variable "project" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project))
    error_message = "Use the approved dedicated project ID."
  }
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "prefix" {
  type    = string
  default = "embody-test-m05"
  validation {
    condition     = can(regex("^embody-test-[a-z0-9-]+$", var.prefix)) && length(var.prefix) <= 15
    error_message = "Use a dedicated embody-test- prefix of at most 15 characters."
  }
}
variable "approved_budget_usd" {
  type = number
  validation {
    condition     = var.approved_budget_usd > 0 && var.approved_budget_usd <= 10
    error_message = "This fixture requires explicit approval, at most $10 USD; this is not a billing cap."
  }
}
variable "enable_postgres" {
  type    = bool
  default = false
}

locals {
  labels = { managed_by = "embody-m05-foundation", fixture = var.prefix }
  apis = toset([
    "run.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com", "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com", "cloudbuild.googleapis.com", "cloudtasks.googleapis.com",
    "storage.googleapis.com"
  ])
}
resource "google_project_service" "api" {
  for_each           = local.apis
  project            = var.project
  service            = each.key
  disable_on_destroy = false
}
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "${var.prefix}-images"
  format        = "DOCKER"
  labels        = local.labels
  # Empty repository has no image-storage baseline; uploaded bytes may be billed.
  depends_on = [google_project_service.api]
}
resource "google_service_account" "platform" {
  for_each     = toset(["gateway", "builder", "deployer", "platform-mig"])
  account_id   = "${var.prefix}-${each.key}"
  display_name = "M05 fixture ${each.key}"
  description  = "Terraform-owned M05 foundation; no customer app identity."
  depends_on   = [google_project_service.api]
}
resource "google_secret_manager_secret" "gateway" {
  for_each  = toset(["signer", "platform-db"])
  secret_id = "${var.prefix}-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_iam_member" "gateway_read" {
  for_each  = google_secret_manager_secret.gateway
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform["gateway"].email}"
}
resource "google_artifact_registry_repository_iam_member" "builder_upload" {
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.platform["builder"].email}"
}
resource "google_cloud_tasks_queue" "deployments" {
  name     = "${var.prefix}-deployments"
  location = var.region
  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 1
  }
  retry_config {
    max_attempts  = 3
    min_backoff   = "10s"
    max_backoff   = "60s"
    max_doublings = 2
  }
  depends_on = [google_project_service.api]
}
# Optional paid baseline, disabled until cost review. No users/passwords/DSNs in state.
resource "google_project_service" "sql" {
  count              = var.enable_postgres ? 1 : 0
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}
resource "google_sql_database_instance" "postgres" {
  count               = var.enable_postgres ? 1 : 0
  name                = "${var.prefix}-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = false
  settings {
    tier              = "db-f1-micro"
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_HDD"
    disk_size         = 10
    disk_autoresize   = false
    user_labels       = local.labels
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      # No public authorized networks; connect through IAM-authorized Auth Proxy.
    }
    backup_configuration { enabled = false }
  }
  depends_on = [google_project_service.sql]
}
output "foundation" {
  value = {
    project        = var.project
    region         = var.region
    prefix         = var.prefix
    repository     = google_artifact_registry_repository.images.id
    identities     = { for k, v in google_service_account.platform : k => v.email }
    secret_names   = { for k, v in google_secret_manager_secret.gateway : k => v.id }
    queue          = google_cloud_tasks_queue.deployments.id
    sql_connection = try(google_sql_database_instance.postgres[0].connection_name, null)
  }
}
