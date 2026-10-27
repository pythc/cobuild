BEGIN;
-- Additive operation journal; no old records or jobs are replayed.
ALTER TABLE requirement_update_job
  ADD COLUMN IF NOT EXISTS client_mutation_id varchar(128),
  ADD COLUMN IF NOT EXISTS request_hash varchar(64),
  ADD COLUMN IF NOT EXISTS source varchar(32),
  ADD COLUMN IF NOT EXISTS execution_stage varchar(32),
  ADD COLUMN IF NOT EXISTS trace_id varchar(64),
  ADD COLUMN IF NOT EXISTS workflow_version varchar(128),
  ADD COLUMN IF NOT EXISTS before_json text,
  ADD COLUMN IF NOT EXISTS after_json text,
  ADD COLUMN IF NOT EXISTS remote_receipt_json text,
  ADD COLUMN IF NOT EXISTS error_code varchar(80),
  ADD COLUMN IF NOT EXISTS batch_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_update_job_mutation_key
  ON requirement_update_job(actor_user_id,client_mutation_id) WHERE client_mutation_id IS NOT NULL;

CREATE TABLE requirement_business_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key varchar(200) NOT NULL UNIQUE,
  operation_id uuid NOT NULL UNIQUE,
  requirement_id varchar(255) NOT NULL,
  actor_user_id varchar(255) NOT NULL,
  actor_name varchar(255) NOT NULL,
  kind varchar(64) NOT NULL,
  workflow_version varchar(128),
  occurred_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  before_json text NOT NULL,
  after_json text NOT NULL,
  fields_json text NOT NULL,
  request_id varchar(128),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL
);
ALTER TABLE requirement_business_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON requirement_business_event TO service_role USING(true) WITH CHECK(true);
CREATE POLICY "修改全部数据" ON requirement_business_event FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON requirement_business_event FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON requirement_business_event FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE INDEX idx_business_event_requirement_time ON requirement_business_event(requirement_id,confirmed_at);

CREATE TABLE requirement_operation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES requirement_business_event(id),
  operation_id uuid NOT NULL,
  consumer varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code varchar(80),
  finished_at timestamptz,
  UNIQUE(event_id,consumer),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL
);
ALTER TABLE requirement_operation_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON requirement_operation_outbox TO service_role USING(true) WITH CHECK(true);
CREATE POLICY "修改全部数据" ON requirement_operation_outbox FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON requirement_operation_outbox FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON requirement_operation_outbox FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE INDEX idx_operation_outbox_pending ON requirement_operation_outbox(status,available_at);

CREATE TABLE requirement_update_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id varchar(255) NOT NULL,
  client_mutation_id varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'preview',
  patch_json text NOT NULL,
  preview_json text NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(actor_user_id,client_mutation_id),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL
);
ALTER TABLE requirement_update_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON requirement_update_batch TO service_role USING(true) WITH CHECK(true);
CREATE POLICY "修改全部数据" ON requirement_update_batch FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON requirement_update_batch FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON requirement_update_batch FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE INDEX idx_update_batch_actor ON requirement_update_batch(actor_user_id,_created_at);


-- Included by the root migration in a single transaction. No existing data changes.
CREATE TABLE workspace_saved_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id varchar(255) NOT NULL,
  scope varchar(16) NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'team')),
  name varchar(120) NOT NULL,
  config_json text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
COMMENT ON TABLE workspace_saved_view IS '个人跨设备与团队需求视图；只保存白名单筛选配置，不授予需求访问权限';
CREATE INDEX idx_workspace_saved_view_owner_scope ON workspace_saved_view(owner_user_id, scope);
CREATE INDEX idx_workspace_saved_view_scope_updated ON workspace_saved_view(scope, _updated_at);
ALTER TABLE workspace_saved_view ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON workspace_saved_view TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON workspace_saved_view AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON workspace_saved_view AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON workspace_saved_view AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE requirement_cache_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id varchar(255) NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  operation_id uuid,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
COMMENT ON TABLE requirement_cache_revision IS '需求缓存跨实例失效水位；不是第二份需求主数据';
ALTER TABLE requirement_cache_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON requirement_cache_revision TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON requirement_cache_revision AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON requirement_cache_revision AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON requirement_cache_revision AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Additive insights storage. Apply through the platform DDL workflow; no production data backfill.
ALTER TABLE requirement_ai_review ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE requirement_ai_review ADD COLUMN IF NOT EXISTS trigger_mode varchar(16);
ALTER TABLE requirement_ai_review ADD COLUMN IF NOT EXISTS superseded_at timestamptz(3);

CREATE TABLE IF NOT EXISTS requirement_ai_review_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  source_hash varchar(64) NOT NULL,
  model varchar(100) NOT NULL,
  rule_set_version varchar(64) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('running','completed','failed','stale')),
  started_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz(3),
  provider_request_id varchar(255),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cache_hit_tokens bigint CHECK (cache_hit_tokens >= 0),
  cache_miss_tokens bigint CHECK (cache_miss_tokens >= 0),
  pricing_version varchar(64),
  estimated_cost numeric(20,8) CHECK (estimated_cost >= 0),
  currency varchar(8),
  error_code varchar(64),
  error_message varchar(500),
  feedback varchar(16) CHECK (feedback IN ('adopted','ignored')),
  feedback_reason varchar(1000),
  feedback_user_id varchar(255),
  feedback_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_review_execution_attempt
  ON requirement_ai_review_execution(review_id, attempt);
CREATE INDEX IF NOT EXISTS idx_ai_review_execution_time
  ON requirement_ai_review_execution(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_review_execution_batch
  ON requirement_ai_review_execution(batch_id, started_at);

CREATE TABLE IF NOT EXISTS operations_dependency_sample (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dependency varchar(32) NOT NULL,
  operation varchar(64) NOT NULL,
  outcome varchar(32) NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  status_code integer,
  error_code varchar(64),
  request_id varchar(128),
  occurred_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
CREATE INDEX IF NOT EXISTS idx_operations_dependency_sample_time
  ON operations_dependency_sample(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_dependency_sample_kind
  ON operations_dependency_sample(dependency, operation, occurred_at DESC);

CREATE TABLE IF NOT EXISTS operations_scanner_heartbeat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scanner varchar(64) NOT NULL,
  instance_id varchar(128) NOT NULL,
  last_started_at timestamptz(3),
  last_finished_at timestamptz(3),
  last_success_at timestamptz(3),
  status varchar(16) NOT NULL DEFAULT 'idle',
  error_code varchar(64),
  build_version varchar(128),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_operations_scanner_instance
  ON operations_scanner_heartbeat(scanner, instance_id);
CREATE INDEX IF NOT EXISTS idx_operations_scanner_heartbeat_updated
  ON operations_scanner_heartbeat(scanner, _updated_at DESC);

CREATE TABLE IF NOT EXISTS operations_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config_json text NOT NULL,
  updated_by_user_id varchar(255) NOT NULL,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_operations_setting_key ON operations_setting(key);

CREATE TABLE IF NOT EXISTS operations_alert_incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint varchar(160) NOT NULL,
  rule_key varchar(64) NOT NULL,
  scope varchar(128) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('pending','open','recovered')),
  first_seen_at timestamptz(3) NOT NULL,
  last_seen_at timestamptz(3) NOT NULL,
  opened_at timestamptz(3),
  recovered_at timestamptz(3),
  last_notified_at timestamptz(3),
  consecutive_windows integer NOT NULL DEFAULT 0,
  evaluated_window timestamptz(3) NOT NULL,
  evidence_json text NOT NULL DEFAULT '{}',
  notification_state varchar(32) NOT NULL DEFAULT 'disabled',
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_operations_alert_fingerprint
  ON operations_alert_incident(fingerprint);
CREATE INDEX IF NOT EXISTS idx_operations_alert_status_time
  ON operations_alert_incident(status, last_seen_at DESC);

ALTER TABLE requirement_ai_review_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_dependency_sample ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_scanner_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_alert_incident ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON requirement_ai_review_execution
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_bypass_policy ON operations_dependency_sample
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_bypass_policy ON operations_scanner_heartbeat
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_bypass_policy ON operations_setting
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_bypass_policy ON operations_alert_incident
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "修改全部数据" ON requirement_ai_review_execution FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON requirement_ai_review_execution FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON requirement_ai_review_execution FOR ALL TO authenticated USING(false) WITH CHECK(false);

CREATE POLICY "修改全部数据" ON operations_dependency_sample FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON operations_dependency_sample FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON operations_dependency_sample FOR ALL TO authenticated USING(false) WITH CHECK(false);

CREATE POLICY "修改全部数据" ON operations_scanner_heartbeat FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON operations_scanner_heartbeat FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON operations_scanner_heartbeat FOR ALL TO authenticated USING(false) WITH CHECK(false);

CREATE POLICY "修改全部数据" ON operations_setting FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON operations_setting FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON operations_setting FOR ALL TO authenticated USING(false) WITH CHECK(false);

CREATE POLICY "修改全部数据" ON operations_alert_incident FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON operations_alert_incident FOR SELECT TO authenticated,anon USING(false);
CREATE POLICY "修改本人数据" ON operations_alert_incident FOR ALL TO authenticated USING(false) WITH CHECK(false);

-- Additive reliable-delivery and targeted GitHub synchronization tables.
-- No automatic replay, notification enablement, or existing-row migration.

CREATE TABLE IF NOT EXISTS notification_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(200) NOT NULL, operation_id varchar(100),
  source varchar(40) NOT NULL, owner varchar(32) NOT NULL,
  kind varchar(64) NOT NULL, template_version varchar(40) NOT NULL,
  requirement_id varchar(100), repository varchar(255), pull_number integer,
  channel varchar(32) NOT NULL, target_id varchar(128) NOT NULL, target_name varchar(255) NOT NULL,
  platform_url text NOT NULL, payload_json text NOT NULL, payload_hash varchar(64) NOT NULL,
  policy_mode varchar(32) NOT NULL, policy_allowed boolean NOT NULL DEFAULT false, policy_reason varchar(255) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'shadow',
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 8,
  available_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token uuid, lease_expires_at TIMESTAMP(3) WITH TIME ZONE,
  first_attempt_at TIMESTAMP(3) WITH TIME ZONE, message_id varchar(128),
  provider_request_id varchar(128), last_error_code varchar(80), confirmed_at TIMESTAMP(3) WITH TIME ZONE,
  CONSTRAINT notification_delivery_state_check CHECK (state IN ('shadow','pending','sending','sent','retry_wait','failed','suppressed','unknown')),
  CONSTRAINT notification_delivery_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT notification_delivery_channel_check CHECK (channel IN ('feishu_private','feishu_group')),
  CONSTRAINT notification_delivery_payload_check CHECK (octet_length(payload_json) <= 1000000 AND jsonb_typeof(payload_json::jsonb) = 'object'),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_policy" ON notification_delivery;
CREATE POLICY "service_role_bypass_policy" ON notification_delivery FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON notification_delivery;
CREATE POLICY "修改全部数据" ON notification_delivery AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON notification_delivery;
CREATE POLICY "查看全部数据" ON notification_delivery AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON notification_delivery;
CREATE POLICY "修改本人数据" ON notification_delivery AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS notification_delivery_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES notification_delivery(id),
  attempt_number integer NOT NULL, lease_token uuid NOT NULL,
  started_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP(3) WITH TIME ZONE, outcome varchar(32) NOT NULL DEFAULT 'pending',
  message_id varchar(128), provider_request_id varchar(128), error_code varchar(80),
  CONSTRAINT notification_delivery_attempt_outcome_check CHECK (outcome IN ('pending','sent','rejected','unknown','suppressed')),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
ALTER TABLE notification_delivery_attempt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_policy" ON notification_delivery_attempt;
CREATE POLICY "service_role_bypass_policy" ON notification_delivery_attempt FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON notification_delivery_attempt;
CREATE POLICY "修改全部数据" ON notification_delivery_attempt AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON notification_delivery_attempt;
CREATE POLICY "查看全部数据" ON notification_delivery_attempt AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON notification_delivery_attempt;
CREATE POLICY "修改本人数据" ON notification_delivery_attempt AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS github_resource_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL, resource_key varchar(512) NOT NULL,
  etag text, body_json text NOT NULL,
  checked_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT github_resource_cache_body_check CHECK (octet_length(body_json) <= 10000000),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
ALTER TABLE github_resource_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_policy" ON github_resource_cache;
CREATE POLICY "service_role_bypass_policy" ON github_resource_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON github_resource_cache;
CREATE POLICY "修改全部数据" ON github_resource_cache AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON github_resource_cache;
CREATE POLICY "查看全部数据" ON github_resource_cache AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON github_resource_cache;
CREATE POLICY "修改本人数据" ON github_resource_cache AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS github_sync_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL, pull_number integer NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'pending',
  requested_generation integer NOT NULL DEFAULT 1, completed_generation integer NOT NULL DEFAULT 0,
  claimed_generation integer, lease_token uuid, lease_expires_at TIMESTAMP(3) WITH TIME ZONE,
  attempts integer NOT NULL DEFAULT 0,
  available_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error_code varchar(80),
  requested_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT github_sync_request_state_check CHECK (state IN ('pending','running','retry_wait','failed','done')),
  CONSTRAINT github_sync_request_number_check CHECK (pull_number > 0),
  CONSTRAINT github_sync_request_generation_check CHECK (completed_generation >= 0 AND requested_generation >= completed_generation),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
ALTER TABLE github_sync_request ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_policy" ON github_sync_request;
CREATE POLICY "service_role_bypass_policy" ON github_sync_request FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON github_sync_request;
CREATE POLICY "修改全部数据" ON github_sync_request AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON github_sync_request;
CREATE POLICY "查看全部数据" ON github_sync_request AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON github_sync_request;
CREATE POLICY "修改本人数据" ON github_sync_request AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS github_webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id varchar(128) NOT NULL, repository varchar(255) NOT NULL,
  event_name varchar(80) NOT NULL, action varchar(80),
  payload_hash varchar(64) NOT NULL, pull_numbers_json text NOT NULL DEFAULT '[]',
  status varchar(32) NOT NULL,
  received_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT github_webhook_delivery_status_check CHECK (status IN ('queued','ignored')),
  CONSTRAINT github_webhook_delivery_numbers_check CHECK (jsonb_typeof(pull_numbers_json::jsonb) = 'array' AND jsonb_array_length(pull_numbers_json::jsonb) <= 100),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
ALTER TABLE github_webhook_delivery ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_policy" ON github_webhook_delivery;
CREATE POLICY "service_role_bypass_policy" ON github_webhook_delivery FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON github_webhook_delivery;
CREATE POLICY "修改全部数据" ON github_webhook_delivery AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON github_webhook_delivery;
CREATE POLICY "查看全部数据" ON github_webhook_delivery AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON github_webhook_delivery;
CREATE POLICY "修改本人数据" ON github_webhook_delivery AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE UNIQUE INDEX IF NOT EXISTS uk_notification_delivery_event_target ON notification_delivery(event_id, channel, target_id, template_version);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_claim ON notification_delivery(owner, state, available_at);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_operation ON notification_delivery(operation_id, _created_at);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_requirement ON notification_delivery(requirement_id, _created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uk_notification_delivery_attempt_number ON notification_delivery_attempt(delivery_id, attempt_number);
CREATE UNIQUE INDEX IF NOT EXISTS uk_github_resource_cache_resource ON github_resource_cache(repository, resource_key);
CREATE UNIQUE INDEX IF NOT EXISTS uk_github_sync_request_pull ON github_sync_request(repository, pull_number);
CREATE INDEX IF NOT EXISTS idx_github_sync_request_claim ON github_sync_request(state, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS uk_github_webhook_delivery_delivery ON github_webhook_delivery(delivery_id);


COMMIT;
