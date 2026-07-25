/**
 * Drizzle table definitions for the `core` schema. These MIRROR the SQL migration
 * (packages/core/migrations/0001_init.sql) and exist purely for typed queries — the
 * migration, not this file, is the source of truth for DDL/RLS/indexes.
 */
import { pgSchema, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const core = pgSchema("core");

export const orgs = core.table("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = core.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = core.table("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const parties = core.table("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  customFields: jsonb("custom_fields").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = core.table("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  sku: text("sku"),
  name: text("name").notNull(),
  customFields: jsonb("custom_fields").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = core.table("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  title: text("title").notNull(),
  uri: text("uri"),
  customFields: jsonb("custom_fields").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entities = core.table("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  type: text("type").notNull(),
  sourceSchema: text("source_schema").notNull(),
  sourceTable: text("source_table").notNull(),
  sourceId: uuid("source_id").notNull(),
  displayLabel: text("display_label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entityRelationships = core.table("entity_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  fromEntityId: uuid("from_entity_id").notNull(),
  toEntityId: uuid("to_entity_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = core.table("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  entityId: uuid("entity_id"),
  action: text("action").notNull(),
  actorUserId: uuid("actor_user_id"),
  diff: jsonb("diff").notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
