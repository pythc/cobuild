BEGIN;

CREATE TABLE IF NOT EXISTS requirement_update_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id varchar(255) NOT NULL,
  expected_updated_at text,
  input_json text NOT NULL,
  actor_user_id varchar(255) NOT NULL,
  actor_user_name varchar(255) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lock_token varchar(255),
  lock_expires_at TIMESTAMP(3) WITH TIME ZONE,
  started_at TIMESTAMP(3) WITH TIME ZONE,
  finished_at TIMESTAMP(3) WITH TIME ZONE,
  result_json text,
  error_message text,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

ALTER TABLE requirement_update_job ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON requirement_update_job
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON requirement_update_job
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON requirement_update_job
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON requirement_update_job
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

CREATE INDEX IF NOT EXISTS idx_requirement_update_job_status_available
  ON requirement_update_job(status, available_at);

CREATE INDEX IF NOT EXISTS idx_requirement_update_job_lock_expiry
  ON requirement_update_job(status, lock_expires_at);

CREATE INDEX IF NOT EXISTS idx_requirement_update_job_requirement
  ON requirement_update_job(requirement_id, _created_at DESC);

COMMENT ON TABLE requirement_update_job IS '需求字段异步更新任务';
COMMENT ON COLUMN requirement_update_job.input_json IS 'RequirementUpdateInput JSON';
COMMENT ON COLUMN requirement_update_job.result_json IS 'MutationResult JSON';

COMMIT;
