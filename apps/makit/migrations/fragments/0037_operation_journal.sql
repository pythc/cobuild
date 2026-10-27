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
