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

CREATE TABLE IF NOT EXISTS notification_retry_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id varchar(128) NOT NULL,
  delivery_ids_json text NOT NULL,
  projection_digest varchar(64) NOT NULL,
  expires_at TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  CONSTRAINT notification_retry_preview_ids_check CHECK (jsonb_typeof(delivery_ids_json::jsonb) = 'array' AND jsonb_array_length(delivery_ids_json::jsonb) BETWEEN 1 AND 100)
);
ALTER TABLE notification_retry_preview ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON notification_retry_preview FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON notification_retry_preview AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON notification_retry_preview AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON notification_retry_preview AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
