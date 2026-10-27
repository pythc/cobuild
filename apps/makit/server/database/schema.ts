/* eslint-disable */
/** auto generated, do not edit */
import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, integer, numeric, pgSequence, pgTable, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

export function escapeLiteral(str: string): string {
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const notificationDeliveryDeliverySequenceSeq = pgSequence("notification_delivery_delivery_sequence_seq");

export const requirementOperationSequenceV2 = pgSequence("requirement_operation_sequence_v2");

export const portalProject = pgTable("portal_project", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  summary: text("summary").notNull(),
  sourceUrl: varchar("source_url", { length: 300 }).notNull(),
  snapshotJson: text("snapshot_json"),
  sourceRevision: integer("source_revision").notNull().default(0),
  sourceDigest: varchar("source_digest", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const notificationRetryPreview = pgTable("notification_retry_preview", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: varchar("actor_user_id", { length: 128 }).notNull(),
  deliveryIdsJson: text("delivery_ids_json").notNull(),
  projectionDigest: varchar("projection_digest", { length: 64 }).notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  usedAt: customTimestamptz("used_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const githubWebhookDelivery = pgTable("github_webhook_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: varchar("delivery_id", { length: 128 }).notNull().unique(),
  repository: varchar("repository", { length: 255 }).notNull(),
  eventName: varchar("event_name", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  pullNumbersJson: text("pull_numbers_json").notNull().default('[]'),
  status: varchar("status", { length: 32 }).notNull(),
  receivedAt: customTimestamptz("received_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_github_webhook_delivery_delivery").on(table.deliveryId),
]);

export const githubSyncRequest = pgTable("github_sync_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  state: varchar("state", { length: 32 }).notNull().default('pending'),
  requestedGeneration: integer("requested_generation").notNull().default(1),
  completedGeneration: integer("completed_generation").notNull().default(0),
  claimedGeneration: integer("claimed_generation"),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: customTimestamptz("lease_expires_at", { precision: 3 }),
  attempts: integer("attempts").notNull().default(0),
  availableAt: customTimestamptz("available_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  requestedAt: customTimestamptz("requested_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_github_sync_request_pull").on(table.repository, table.pullNumber),
  index("idx_github_sync_request_claim").on(table.state, table.availableAt),
]);

export const githubResourceCache = pgTable("github_resource_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  resourceKey: varchar("resource_key", { length: 512 }).notNull(),
  etag: text("etag"),
  bodyJson: text("body_json").notNull(),
  checkedAt: customTimestamptz("checked_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_github_resource_cache_resource").on(table.repository, table.resourceKey),
]);

export const notificationDeliveryAttempt = pgTable("notification_delivery_attempt", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  leaseToken: uuid("lease_token").notNull(),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  outcome: varchar("outcome", { length: 32 }).notNull().default('pending'),
  messageId: varchar("message_id", { length: 128 }),
  providerRequestId: varchar("provider_request_id", { length: 128 }),
  errorCode: varchar("error_code", { length: 80 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_notification_delivery_attempt_number").on(table.deliveryId, table.attemptNumber),
  foreignKey({
    columns: [table.deliveryId],
    foreignColumns: [notificationDelivery.id],
    name: "notification_delivery_attempt_delivery_id_fkey",
  }),
]);

export const notificationDelivery = pgTable("notification_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 200 }).notNull(),
  operationId: varchar("operation_id", { length: 100 }),
  source: varchar("source", { length: 40 }).notNull(),
  owner: varchar("owner", { length: 32 }).notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  templateVersion: varchar("template_version", { length: 40 }).notNull(),
  requirementId: varchar("requirement_id", { length: 100 }),
  repository: varchar("repository", { length: 255 }),
  pullNumber: integer("pull_number"),
  channel: varchar("channel", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 128 }).notNull(),
  targetName: varchar("target_name", { length: 255 }).notNull(),
  platformUrl: text("platform_url").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  policyMode: varchar("policy_mode", { length: 32 }).notNull(),
  policyAllowed: boolean("policy_allowed").notNull().default(false),
  policyReason: varchar("policy_reason", { length: 255 }).notNull(),
  state: varchar("state", { length: 32 }).notNull().default('shadow'),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  availableAt: customTimestamptz("available_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: customTimestamptz("lease_expires_at", { precision: 3 }),
  firstAttemptAt: customTimestamptz("first_attempt_at", { precision: 3 }),
  messageId: varchar("message_id", { length: 128 }),
  providerRequestId: varchar("provider_request_id", { length: 128 }),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  confirmedAt: customTimestamptz("confirmed_at", { precision: 3 }),
  deliverySequence: bigint("delivery_sequence", { mode: 'number' }).generatedByDefaultAsIdentity().notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_notification_delivery_event_target").on(table.eventId, table.channel, table.targetId, table.templateVersion),
  index("idx_notification_delivery_claim").on(table.owner, table.state, table.availableAt),
  index("idx_notification_delivery_operation").on(table.operationId, table.createdAt),
  index("idx_notification_delivery_requirement").on(table.requirementId, table.createdAt),
  index("idx_notification_delivery_order").on(table.requirementId, table.channel, table.targetId, table.deliverySequence),
]);

export const operationsAlertIncident = pgTable("operations_alert_incident", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprint: varchar("fingerprint", { length: 160 }).notNull().unique(),
  ruleKey: varchar("rule_key", { length: 64 }).notNull(),
  scope: varchar("scope", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  firstSeenAt: customTimestamptz("first_seen_at", { precision: 3 }).notNull(),
  lastSeenAt: customTimestamptz("last_seen_at", { precision: 3 }).notNull(),
  openedAt: customTimestamptz("opened_at", { precision: 3 }),
  recoveredAt: customTimestamptz("recovered_at", { precision: 3 }),
  lastNotifiedAt: customTimestamptz("last_notified_at", { precision: 3 }),
  consecutiveWindows: integer("consecutive_windows").notNull().default(0),
  evaluatedWindow: customTimestamptz("evaluated_window", { precision: 3 }).notNull(),
  evidenceJson: text("evidence_json").notNull().default('{}'),
  notificationState: varchar("notification_state", { length: 32 }).notNull().default('disabled'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_operations_alert_fingerprint").on(table.fingerprint),
  index("idx_operations_alert_status_time").on(table.status, table.lastSeenAt),
]);

export const operationsSetting = pgTable("operations_setting", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  revision: integer("revision").notNull().default(1),
  configJson: text("config_json").notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 255 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_operations_setting_key").on(table.key),
]);

export const operationsScannerHeartbeat = pgTable("operations_scanner_heartbeat", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanner: varchar("scanner", { length: 64 }).notNull(),
  instanceId: varchar("instance_id", { length: 128 }).notNull(),
  lastStartedAt: customTimestamptz("last_started_at", { precision: 3 }),
  lastFinishedAt: customTimestamptz("last_finished_at", { precision: 3 }),
  lastSuccessAt: customTimestamptz("last_success_at", { precision: 3 }),
  status: varchar("status", { length: 16 }).notNull().default('idle'),
  errorCode: varchar("error_code", { length: 64 }),
  buildVersion: varchar("build_version", { length: 128 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_operations_scanner_instance").on(table.scanner, table.instanceId),
  index("idx_operations_scanner_heartbeat_updated").on(table.scanner, table.updatedAt),
]);

export const operationsDependencySample = pgTable("operations_dependency_sample", {
  id: uuid("id").primaryKey().defaultRandom(),
  dependency: varchar("dependency", { length: 32 }).notNull(),
  operation: varchar("operation", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 32 }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  statusCode: integer("status_code"),
  errorCode: varchar("error_code", { length: 64 }),
  requestId: varchar("request_id", { length: 128 }),
  occurredAt: customTimestamptz("occurred_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  index("idx_operations_dependency_sample_time").on(table.occurredAt),
  index("idx_operations_dependency_sample_kind").on(table.dependency, table.operation, table.occurredAt),
]);

export const requirementAiReviewExecution = pgTable("requirement_ai_review_execution", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  attempt: integer("attempt").notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  ruleSetVersion: varchar("rule_set_version", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  providerRequestId: varchar("provider_request_id", { length: 255 }),
  inputTokens: bigint("input_tokens", { mode: 'number' }),
  outputTokens: bigint("output_tokens", { mode: 'number' }),
  cacheHitTokens: bigint("cache_hit_tokens", { mode: 'number' }),
  cacheMissTokens: bigint("cache_miss_tokens", { mode: 'number' }),
  pricingVersion: varchar("pricing_version", { length: 64 }),
  estimatedCost: numeric("estimated_cost"),
  currency: varchar("currency", { length: 8 }),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: varchar("error_message", { length: 500 }),
  feedback: varchar("feedback", { length: 16 }),
  feedbackReason: varchar("feedback_reason", { length: 1000 }),
  feedbackUserId: varchar("feedback_user_id", { length: 255 }),
  feedbackAt: customTimestamptz("feedback_at", { precision: 3 }),
  pricingSnapshotJson: text("pricing_snapshot_json"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_ai_review_execution_attempt").on(table.reviewId, table.attempt),
  index("idx_ai_review_execution_time").on(table.startedAt, table.id),
  index("idx_ai_review_execution_batch").on(table.batchId, table.startedAt),
]);

export const requirementCacheRevision = pgTable("requirement_cache_revision", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull().unique(),
  revision: integer("revision").notNull().default(1),
  operationId: uuid("operation_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("requirement_cache_revision_requirement_id_key").on(table.requirementId),
]);

export const workspaceSavedView = pgTable("workspace_saved_view", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
  scope: varchar("scope", { length: 16 }).notNull().default('personal'),
  name: varchar("name", { length: 120 }).notNull(),
  configJson: text("config_json").notNull(),
  version: integer("version").notNull().default(1),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_workspace_saved_view_owner_scope").on(table.ownerUserId, table.scope),
  index("idx_workspace_saved_view_scope_updated").on(table.scope, table.updatedAt),
]);

export const requirementUpdateBatch = pgTable("requirement_update_batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: varchar("actor_user_id", { length: 255 }).notNull(),
  clientMutationId: varchar("client_mutation_id", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default('preview'),
  patchJson: text("patch_json").notNull(),
  previewJson: text("preview_json").notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 6 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("requirement_update_batch_actor_user_id_client_mutation_id_key").on(table.actorUserId, table.clientMutationId),
  index("idx_update_batch_actor").on(table.actorUserId, table.createdAt),
]);

export const requirementOperationOutbox = pgTable("requirement_operation_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  consumer: varchar("consumer", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  attempts: integer("attempts").notNull().default(0),
  availableAt: customTimestamptz("available_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: customTimestamptz("lease_expires_at", { precision: 6 }),
  errorCode: varchar("error_code", { length: 80 }),
  finishedAt: customTimestamptz("finished_at", { precision: 6 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("requirement_operation_outbox_event_id_consumer_key").on(table.eventId, table.consumer),
  index("idx_operation_outbox_pending").on(table.status, table.availableAt),
  foreignKey({
    columns: [table.eventId],
    foreignColumns: [requirementBusinessEvent.id],
    name: "requirement_operation_outbox_event_id_fkey",
  }),
]);

export const requirementBusinessEvent = pgTable("requirement_business_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventKey: varchar("event_key", { length: 200 }).notNull().unique(),
  operationId: uuid("operation_id").notNull().unique(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 255 }).notNull(),
  actorName: varchar("actor_name", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  workflowVersion: varchar("workflow_version", { length: 128 }),
  occurredAt: customTimestamptz("occurred_at", { precision: 6 }).notNull(),
  confirmedAt: customTimestamptz("confirmed_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  fieldsJson: text("fields_json").notNull(),
  requestId: varchar("request_id", { length: 128 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("requirement_business_event_event_key_key").on(table.eventKey),
  uniqueIndex("requirement_business_event_operation_id_key").on(table.operationId),
  index("idx_business_event_requirement_time").on(table.requirementId, table.confirmedAt),
]);

export const iterationConfiguration = pgTable("iteration_configuration", {
  id: uuid("id").primaryKey().defaultRandom(),
  iterationId: varchar("iteration_id", { length: 255 }).notNull().unique(),
  revision: integer("revision").notNull().default(1),
  draftJson: text("draft_json").notNull(),
  publishedJson: text("published_json"),
  historyJson: text("history_json").notNull().default('[]'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("iteration_configuration_iteration_id_key").on(table.iterationId),
]);

export const requirementAiReview = pgTable("requirement_ai_review", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull(),
  reviewType: varchar("review_type", { length: 64 }).notNull(),
  sourceKind: varchar("source_kind", { length: 64 }).notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  sourceSnapshot: text("source_snapshot").notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull().unique(),
  status: varchar("status", { length: 32 }).notNull().default('queued'),
  verdict: varchar("verdict", { length: 32 }),
  score: integer("score"),
  summary: text("summary").notNull(),
  dimensionsJson: text("dimensions_json").notNull().default('[]'),
  findingsJson: text("findings_json").notNull().default('[]'),
  model: varchar("model", { length: 100 }).notNull().default('deepseek-v4-flash'),
  ruleSetVersion: varchar("rule_set_version", { length: 64 }).notNull().default('2026-08-30-v1'),
  attempts: integer("attempts").notNull().default(0),
  availableAt: customTimestamptz("available_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  lockToken: varchar("lock_token", { length: 255 }),
  lockExpiresAt: customTimestamptz("lock_expires_at", { precision: 3 }),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  errorMessage: text("error_message").notNull(),
  overriddenAt: customTimestamptz("overridden_at", { precision: 3 }),
  overriddenByName: varchar("overridden_by_name", { length: 255 }).notNull(),
  overrideReason: text("override_reason").notNull(),
  createdByName: varchar("created_by_name", { length: 255 }).notNull(),
  batchId: uuid("batch_id"),
  triggerMode: varchar("trigger_mode", { length: 16 }),
  supersededAt: customTimestamptz("superseded_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_requirement_ai_review_dedupe").on(table.dedupeKey),
  index("idx_requirement_ai_review_requirement").on(table.requirementId, table.reviewType, table.createdAt),
  index("idx_requirement_ai_review_pending").on(table.availableAt, table.createdAt),
]);

export const requirementArtifact = pgTable("requirement_artifact", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  content: text("content").notNull(),
  documentUrl: text("document_url").notNull(),
  documentTitle: varchar("document_title", { length: 500 }).notNull(),
  sourceSnapshot: text("source_snapshot").notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  readable: boolean("readable").notNull().default(true),
  errorMessage: text("error_message").notNull(),
  updatedByName: varchar("updated_by_name", { length: 255 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_requirement_artifact_kind").on(table.requirementId, table.kind),
  index("idx_requirement_artifact_requirement").on(table.requirementId, table.updatedAt),
]);

export const pullRequestRefreshLease = pgTable("pull_request_refresh_lease", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull().unique(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: customTimestamptz("lease_expires_at", { precision: 3 }),
  lastSucceededAt: customTimestamptz("last_succeeded_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_pull_request_refresh_lease_repository").on(table.repository),
  index("idx_pull_request_refresh_lease_expiry").on(table.leaseExpiresAt),
]);

export const pullRequestReviewerNotificationEvent = pgTable("pull_request_reviewer_notification_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  githubLogin: varchar("github_login", { length: 255 }).notNull(),
  assignmentGeneration: integer("assignment_generation").notNull(),
  reviewerUserId: varchar("reviewer_user_id", { length: 255 }).notNull(),
  reviewerEmployeeId: varchar("reviewer_employee_id", { length: 255 }).notNull(),
  reviewerName: varchar("reviewer_name", { length: 128 }).notNull(),
  assignedByName: varchar("assigned_by_name", { length: 255 }).notNull(),
  assignedByUserId: varchar("assigned_by_user_id", { length: 255 }).notNull(),
  deliveryPolicyMode: varchar("delivery_policy_mode", { length: 32 }).notNull(),
  deliveryEligible: boolean("delivery_eligible").notNull().default(false),
  suppressionReason: text("suppression_reason"),
  suppressedAt: customTimestamptz("suppressed_at", { precision: 3 }),
  notifiedAt: customTimestamptz("notified_at", { precision: 3 }),
  maxNotificationAttempts: integer("max_notification_attempts").notNull().default(8),
  notificationAttempts: integer("notification_attempts").notNull().default(0),
  notificationError: text("notification_error"),
  notificationClaimToken: uuid("notification_claim_token"),
  notificationClaimExpiresAt: customTimestamptz("notification_claim_expires_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_pull_request_reviewer_notification_event_generation").on(table.repository, table.pullNumber, table.githubLogin, table.assignmentGeneration),
  index("idx_pull_request_reviewer_notification_event_pull").on(table.repository, table.pullNumber, table.createdAt),
  index("idx_pull_request_reviewer_notification_event_pending").on(table.repository, table.deliveryEligible, table.notifiedAt, table.suppressedAt, table.notificationClaimExpiresAt, table.createdAt),
]);

export const pullRequestReviewerState = pgTable("pull_request_reviewer_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  githubLogin: varchar("github_login", { length: 255 }).notNull(),
  assignmentGeneration: integer("assignment_generation").notNull().default(0),
  notifiedGeneration: integer("notified_generation").notNull().default(0),
  active: boolean("active").notNull().default(false),
  assignedByName: varchar("assigned_by_name", { length: 255 }).notNull(),
  assignedByUserId: varchar("assigned_by_user_id", { length: 255 }).notNull(),
  pendingPolicyMode: varchar("pending_policy_mode", { length: 32 }),
  pendingDeliveryEligible: boolean("pending_delivery_eligible"),
  pendingSuppressionReason: text("pending_suppression_reason"),
  pendingReviewerEmployeeId: varchar("pending_reviewer_employee_id", { length: 255 }),
  pendingReviewerName: varchar("pending_reviewer_name", { length: 128 }),
  pendingOperationGeneration: integer("pending_operation_generation"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_pull_request_reviewer_state").on(table.repository, table.pullNumber, table.githubLogin),
  index("idx_pull_request_reviewer_state_pending").on(table.repository, table.active, table.notifiedGeneration, table.assignmentGeneration),
]);

export const pullRequestReviewerOperation = pgTable("pull_request_reviewer_operation", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  generation: integer("generation").notNull().default(0),
  operationToken: uuid("operation_token"),
  lastCompletedOperationToken: uuid("last_completed_operation_token"),
  lastCompletedActorUserId: varchar("last_completed_actor_user_id", { length: 255 }),
  operationExpiresAt: customTimestamptz("operation_expires_at", { precision: 3 }),
  reconciliationClaimToken: uuid("reconciliation_claim_token"),
  reconciliationClaimExpiresAt: customTimestamptz("reconciliation_claim_expires_at", { precision: 3 }),
  actorUserId: varchar("actor_user_id", { length: 255 }),
  desiredLoginsJson: text("desired_logins_json").notNull().default('[]'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("uk_pull_request_reviewer_operation").on(table.repository, table.pullNumber),
  index("idx_pull_request_reviewer_operation_lease").on(table.repository, table.operationExpiresAt, table.reconciliationClaimExpiresAt),
]);

export const requirementArchive = pgTable("requirement_archive", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull().unique(),
  requirementCode: varchar("requirement_code", { length: 255 }).notNull(),
  requirementTitle: text("requirement_title").notNull(),
  archivedAt: customTimestamptz("archived_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  archivedBy: userProfile("archived_by").notNull(),
  archivedByName: varchar("archived_by_name", { length: 255 }).notNull(),
  restoredAt: customTimestamptz("restored_at", { precision: 3 }),
  restoredBy: userProfile("restored_by"),
  restoredByName: varchar("restored_by_name", { length: 255 }),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  deletedBy: userProfile("deleted_by"),
  deletedByName: varchar("deleted_by_name", { length: 255 }),
  deletionStatus: varchar("deletion_status", { length: 32 }).notNull().default('idle'),
  deletionClaimToken: uuid("deletion_claim_token"),
  deletionClaimExpiresAt: customTimestamptz("deletion_claim_expires_at", { precision: 3 }),
  deletionError: text("deletion_error"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_requirement_archive_requirement").on(table.requirementId),
  index("idx_requirement_archive_active").on(table.archivedAt),
  index("idx_requirement_archive_deletion").on(table.deletionStatus, table.deletionClaimExpiresAt),
]);

export const githubReviewerBinding = pgTable("github_reviewer_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  githubLogin: varchar("github_login", { length: 255 }).notNull(),
  reviewerEmployeeId: varchar("reviewer_employee_id", { length: 255 }).notNull(),
  reviewerName: varchar("reviewer_name", { length: 128 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_github_reviewer_binding_login").on(table.repository, table.githubLogin),
  uniqueIndex("uk_github_reviewer_binding_user").on(table.repository, table.reviewerEmployeeId),
]);

export const pullRequestReviewer = pgTable("pull_request_reviewer", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  reviewer: userProfile("reviewer"),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  reviewerUserId: varchar("reviewer_user_id", { length: 255 }).notNull(),
  assignedByName: varchar("assigned_by_name", { length: 255 }).notNull(),
  notifiedAt: customTimestamptz("notified_at", { precision: 3 }),
  notificationAttempts: integer("notification_attempts").notNull().default(0),
  notificationError: text("notification_error"),
  reviewerEmployeeId: varchar("reviewer_employee_id", { length: 255 }).notNull(),
  reviewerName: varchar("reviewer_name", { length: 128 }).notNull(),
  githubLogin: varchar("github_login", { length: 255 }),
  notificationClaimToken: uuid("notification_claim_token"),
  notificationClaimExpiresAt: customTimestamptz("notification_claim_expires_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_pull_request_reviewer_pull").on(table.repository, table.pullNumber, table.createdAt),
  index("idx_pull_request_reviewer_pending").on(table.repository, table.notifiedAt, table.notificationClaimExpiresAt, table.createdAt),
  uniqueIndex("uk_pull_request_reviewer_user").on(table.repository, table.pullNumber, table.reviewerUserId),
  uniqueIndex("uk_pull_request_reviewer_github_login").on(table.repository, table.pullNumber, table.githubLogin),
]);

export const pullRequestSnapshot = pgTable("pull_request_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: varchar("repository", { length: 255 }).notNull(),
  pullNumber: integer("pull_number").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  state: varchar("state", { length: 32 }).notNull(),
  draft: boolean("draft").notNull().default(false),
  url: text("url").notNull(),
  authorLogin: varchar("author_login", { length: 255 }).notNull(),
  authorAvatarUrl: text("author_avatar_url").notNull(),
  headRef: varchar("head_ref", { length: 255 }).notNull(),
  baseRef: varchar("base_ref", { length: 255 }).notNull(),
  mergeable: varchar("mergeable", { length: 32 }).notNull().default('UNKNOWN'),
  reviewDecision: varchar("review_decision", { length: 64 }).notNull(),
  checksStatus: varchar("checks_status", { length: 32 }).notNull().default('UNKNOWN'),
  additions: integer("additions").notNull().default(0),
  deletions: integer("deletions").notNull().default(0),
  changedFiles: integer("changed_files").notNull().default(0),
  commitCount: integer("commit_count").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  reviewThreadCount: integer("review_thread_count").notNull().default(0),
  commentsJson: text("comments_json").notNull().default('[]'),
  reviewsJson: text("reviews_json").notNull().default('[]'),
  reviewThreadsJson: text("review_threads_json").notNull().default('[]'),
  checksJson: text("checks_json").notNull().default('[]'),
  githubCreatedAt: customTimestamptz("github_created_at", { precision: 3 }),
  githubUpdatedAt: customTimestamptz("github_updated_at", { precision: 3 }).notNull(),
  closedAt: customTimestamptz("closed_at", { precision: 3 }),
  mergedAt: customTimestamptz("merged_at", { precision: 3 }),
  syncedAt: customTimestamptz("synced_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  requestedReviewersJson: text("requested_reviewers_json").notNull().default('[]'),
  reviewersUpdatedAt: customTimestamptz("reviewers_updated_at", { precision: 3 }).notNull().default(sql`to_timestamp((0)::double precision)`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_pull_request_snapshot_repository_number").on(table.repository, table.pullNumber),
  index("idx_pull_request_snapshot_state_updated").on(table.repository, table.state, table.githubUpdatedAt),
  index("idx_pull_request_snapshot_synced").on(table.repository, table.syncedAt),
]);

export const mcpPersonalCredential = pgTable("mcp_personal_credential", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenVersion: integer("token_version").notNull().default(1),
  revokedAt: customTimestamptz("revoked_at", { precision: 3 }),
  subjectHash: varchar("subject_hash", { length: 64 }).notNull().unique(),
  reviewerRoleIds: text("reviewer_role_ids").notNull(),
  reviewerRoleVersion: integer("reviewer_role_version").notNull().default(0),
  reviewerRolesVerifiedAt: customTimestamptz("reviewer_roles_verified_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("mcp_personal_credential_subject_hash_key").on(table.subjectHash),
]);

export const requirementUpdateJob = pgTable("requirement_update_job", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: varchar("requirement_id", { length: 255 }).notNull(),
  expectedUpdatedAt: text("expected_updated_at"),
  inputJson: text("input_json").notNull(),
  actorUserId: varchar("actor_user_id", { length: 255 }).notNull(),
  actorUserName: varchar("actor_user_name", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default('queued'),
  attempts: integer("attempts").notNull().default(0),
  availableAt: customTimestamptz("available_at", { precision: 3 }).notNull().default(sql`date_trunc('milliseconds'::text, CURRENT_TIMESTAMP)`),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  lockToken: varchar("lock_token", { length: 255 }),
  lockExpiresAt: customTimestamptz("lock_expires_at", { precision: 3 }),
  clientMutationId: varchar("client_mutation_id", { length: 128 }),
  requestHash: varchar("request_hash", { length: 64 }),
  source: varchar("source", { length: 32 }),
  executionStage: varchar("execution_stage", { length: 32 }),
  traceId: varchar("trace_id", { length: 64 }),
  workflowVersion: varchar("workflow_version", { length: 128 }),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  remoteReceiptJson: text("remote_receipt_json"),
  errorCode: varchar("error_code", { length: 80 }),
  batchId: uuid("batch_id"),
  operationSequence: bigint("operation_sequence", { mode: 'number' }).default(sql`nextval('requirement_operation_sequence_v2'::regclass)`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_requirement_update_job_status_available").on(table.status, table.availableAt),
  index("idx_requirement_update_job_requirement").on(table.requirementId, table.createdAt),
  index("idx_requirement_update_job_lock_expiry").on(table.status, table.lockExpiresAt),
  index("idx_requirement_update_job_actor_status").on(table.actorUserId, table.status),
  uniqueIndex("idx_update_job_mutation_key").on(table.actorUserId, table.clientMutationId),
  index("idx_requirement_operation_order").on(table.requirementId, table.operationSequence),
]);

// table aliases
export const githubResourceCacheTable = githubResourceCache;
export const githubReviewerBindingTable = githubReviewerBinding;
export const githubSyncRequestTable = githubSyncRequest;
export const githubWebhookDeliveryTable = githubWebhookDelivery;
export const iterationConfigurationTable = iterationConfiguration;
export const mcpPersonalCredentialTable = mcpPersonalCredential;
export const notificationDeliveryTable = notificationDelivery;
export const notificationDeliveryAttemptTable = notificationDeliveryAttempt;
export const notificationRetryPreviewTable = notificationRetryPreview;
export const operationsAlertIncidentTable = operationsAlertIncident;
export const operationsDependencySampleTable = operationsDependencySample;
export const operationsScannerHeartbeatTable = operationsScannerHeartbeat;
export const operationsSettingTable = operationsSetting;
export const portalProjectTable = portalProject;
export const pullRequestRefreshLeaseTable = pullRequestRefreshLease;
export const pullRequestReviewerTable = pullRequestReviewer;
export const pullRequestReviewerNotificationEventTable = pullRequestReviewerNotificationEvent;
export const pullRequestReviewerOperationTable = pullRequestReviewerOperation;
export const pullRequestReviewerStateTable = pullRequestReviewerState;
export const pullRequestSnapshotTable = pullRequestSnapshot;
export const requirementAiReviewTable = requirementAiReview;
export const requirementAiReviewExecutionTable = requirementAiReviewExecution;
export const requirementArchiveTable = requirementArchive;
export const requirementArtifactTable = requirementArtifact;
export const requirementBusinessEventTable = requirementBusinessEvent;
export const requirementCacheRevisionTable = requirementCacheRevision;
export const requirementOperationOutboxTable = requirementOperationOutbox;
export const requirementUpdateBatchTable = requirementUpdateBatch;
export const requirementUpdateJobTable = requirementUpdateJob;
export const workspaceSavedViewTable = workspaceSavedView;
