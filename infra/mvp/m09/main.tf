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
  validation {
    condition     = var.region == "us-central1"
    error_message = "MD04: the MVP runs in us-central1 only."
  }
}
variable "prefix" {
  type    = string
  default = "embody-test-m09"
  validation {
    condition     = can(regex("^embody-test-[a-z0-9-]+$", var.prefix)) && length(var.prefix) <= 15
    error_message = "Use a dedicated embody-test- prefix of at most 15 characters."
  }
}
variable "approved_budget_usd" {
  type = number
  validation {
    condition     = var.approved_budget_usd > 0 && var.approved_budget_usd <= 25
    error_message = "MD06: the one-off M09 qualification budget is at most $25 USD; this is not a billing cap."
  }
}
# Paid resources stay off until the owner approves spend; see docs/mvp/M09-QUALIFICATION.md.
variable "enable_postgres" {
  type    = bool
  default = false
}
variable "postgres_tier" {
  type    = string
  default = "db-f1-micro"
  validation {
    condition     = contains(["db-f1-micro", "db-g1-small"], var.postgres_tier)
    error_message = "MD05/MD06: one shared small Cloud SQL instance (shared-core tier)."
  }
}
variable "enable_backups" {
  type    = bool
  default = true
}
# Optional: a monthly budget alert needs Billing Account Administrator or Costs Manager.
variable "billing_account" {
  type    = string
  default = ""
  validation {
    condition     = var.billing_account == "" || can(regex("^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$", var.billing_account))
    error_message = "Billing account ID like 000000-000000-000000, or empty to skip the budget."
  }
}
variable "monthly_ceiling_usd" {
  type    = number
  default = 50
  validation {
    condition     = var.monthly_ceiling_usd > 0 && var.monthly_ceiling_usd <= 50
    error_message = "MD06: the running MVP ceiling is $50/month."
  }
}

locals {
  labels = { managed_by = "embody-m09-baseline", fixture = var.prefix }
  apis = toset([
    "run.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com", "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com", "cloudtasks.googleapis.com", "monitoring.googleapis.com",
    "logging.googleapis.com", "sqladmin.googleapis.com"
  ])
}
resource "google_project_service" "api" {
  for_each           = local.apis
  project            = var.project
  service            = each.key
  disable_on_destroy = false
}
resource "google_project_service" "budgets" {
  count              = var.billing_account == "" ? 0 : 1
  service            = "billingbudgets.googleapis.com"
  disable_on_destroy = false
}
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "${var.prefix}-images"
  format        = "DOCKER"
  labels        = local.labels
  # Bound image storage: keep the five newest versions per package, delete untagged after 1 day.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "drop-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "86400s"
    }
  }
  depends_on = [google_project_service.api]
}
# Platform identities. App runtime/migrator/wake-invoker identities are adapter-owned
# (infra/mvp/provider), never Terraform-owned, so app teardown never touches this state.
resource "google_service_account" "platform" {
  for_each     = toset(["gateway", "builder", "deployer", "platform-mig"])
  account_id   = "${var.prefix}-${each.key}"
  display_name = "M09 baseline ${each.key}"
  description  = "Terraform-owned M09 baseline; no customer app identity."
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
# The builder may push images and nothing else: no secrets, SQL, queues or Run admin.
resource "google_artifact_registry_repository_iam_member" "builder_upload" {
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.platform["builder"].email}"
}
# MD05: one shared small instance, one database and least-privilege roles per app.
# No users, passwords or DSNs in Terraform state: roles are created by the M09 SQL step.
resource "google_sql_database_instance" "postgres" {
  count               = var.enable_postgres ? 1 : 0
  name                = "${var.prefix}-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = false
  settings {
    tier              = var.postgres_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_HDD"
    disk_size         = 10
    disk_autoresize   = false
    user_labels       = local.labels
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      # No authorized networks: only IAM-authorized Cloud SQL connectors/Auth Proxy reach it.
    }
    backup_configuration {
      enabled                        = var.enable_backups
      start_time                     = "08:00"
      point_in_time_recovery_enabled = false
      backup_retention_settings {
        retained_backups = 1
        retention_unit   = "COUNT"
      }
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
  }
  depends_on = [google_project_service.api]
}
# MD06 alerts at 50/80/100% of the running ceiling. Alerts are not a hard cap.
resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "${var.prefix}-monthly"
  budget_filter {
    projects = ["projects/${var.project}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_ceiling_usd)
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.5, 0.8, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }
  depends_on = [google_project_service.budgets]
}
data "google_project" "this" {
  project_id = var.project
}
output "baseline" {
  value = {
    project        = var.project
    project_number = data.google_project.this.number
    region         = var.region
    prefix         = var.prefix
    repository     = google_artifact_registry_repository.images.id
    identities     = { for k, v in google_service_account.platform : k => v.email }
    secret_names   = { for k, v in google_secret_manager_secret.gateway : k => v.id }
    sql_connection = try(google_sql_database_instance.postgres[0].connection_name, null)
    budget         = try(google_billing_budget.monthly[0].id, null)
  }
}
