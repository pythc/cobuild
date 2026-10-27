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
  pricing_snapshot_json text,
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
