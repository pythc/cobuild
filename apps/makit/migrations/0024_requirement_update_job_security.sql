BEGIN;

-- Phase 1 is deliberately additive so it can be applied before a rolling
-- application deployment. Phase 2 (0025) revokes direct table access after
-- every pod has switched to these functions.

CREATE OR REPLACE FUNCTION requirement_update_job_enqueue(
  p_requirement_id varchar,
  p_expected_updated_at text,
  p_input jsonb,
  p_actor_user_name varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  active_job_count integer;
  archived_requirement_count integer;
  job_row requirement_update_job%ROWTYPE;
BEGIN
  IF caller_role !~ '^authenticated(_|$)' OR request_user_id IS NULL THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update enqueue requires an authenticated user';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'requirement update input must be an object'
      USING ERRCODE = '22023';
  END IF;
  IF p_requirement_id IS NULL
    OR btrim(p_requirement_id) = ''
    OR octet_length(p_requirement_id) > 255
  THEN
    RAISE EXCEPTION 'invalid requirement update requirement id'
      USING ERRCODE = '22023';
  END IF;
  IF octet_length(request_user_id) > 255 THEN
    RAISE EXCEPTION 'invalid requirement update actor id'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_updated_at IS NOT NULL
    AND octet_length(p_expected_updated_at) > 128
  THEN
    RAISE EXCEPTION 'requirement update expected timestamp is too large'
      USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_input::text) > 262144 THEN
    RAISE EXCEPTION 'requirement update input is too large'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize with archive first, then enforce the per-actor admission cap.
  -- The same requirement lock is held by requirement_archive_upsert, so a job
  -- and an archive operation cannot both be admitted for one requirement.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('requirement_mutation:' || btrim(p_requirement_id), 0)
  );
  SELECT count(*) INTO archived_requirement_count
  FROM requirement_archive AS archive
  WHERE archive.requirement_id = btrim(p_requirement_id)
    AND archive.restored_at IS NULL
    AND archive.deleted_at IS NULL;
  IF archived_requirement_count > 0 THEN
    RAISE EXCEPTION 'requirement is archived' USING ERRCODE = '55000';
  END IF;

  -- Serialize admission per actor so concurrent requests cannot race past the
  -- active-job cap. The display name is deliberately not accepted from the
  -- caller; the worker resolves it from Feishu immediately before execution.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('requirement_update_job:' || request_user_id, 0)
  );
  SELECT count(*)
  INTO active_job_count
  FROM requirement_update_job AS job
  WHERE job.actor_user_id = request_user_id
    AND job.status IN ('queued', 'running');
  IF active_job_count >= 50 THEN
    RAISE EXCEPTION 'too many active requirement update jobs'
      USING ERRCODE = '54000';
  END IF;

  INSERT INTO requirement_update_job (
    requirement_id,
    expected_updated_at,
    input_json,
    actor_user_id,
    actor_user_name
  ) VALUES (
    btrim(p_requirement_id),
    p_expected_updated_at,
    jsonb_build_object('input', p_input)::text,
    request_user_id,
    '待解析'
  )
  RETURNING requirement_update_job.* INTO job_row;
  RETURN to_jsonb(job_row);
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_get(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  job_row requirement_update_job%ROWTYPE;
BEGIN
  IF caller_role !~ '^authenticated(_|$)' OR request_user_id IS NULL THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update status requires an authenticated user';
  END IF;
  SELECT job.*
  INTO job_row
  FROM requirement_update_job AS job
  WHERE job.id = p_job_id
    AND job.actor_user_id = request_user_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(job_row);
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_pending_ids(p_limit integer)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update pending scan is worker-only';
  END IF;
  RETURN QUERY SELECT job.id
  FROM requirement_update_job AS job
  WHERE (
      job.status = 'queued'
      AND job.available_at <= CURRENT_TIMESTAMP
    ) OR (
      job.status = 'running'
      AND job.lock_expires_at <= CURRENT_TIMESTAMP
    )
  ORDER BY job._created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_claim(
  p_job_id uuid,
  p_lock_token varchar,
  p_lock_expires_at TIMESTAMP(3) WITH TIME ZONE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  job_row requirement_update_job%ROWTYPE;
BEGIN
  IF caller_role !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update claim is worker-only';
  END IF;
  IF NULLIF(p_lock_token, '') IS NULL
    OR octet_length(p_lock_token) > 255
    OR p_lock_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid requirement update job lease'
      USING ERRCODE = '22023';
  END IF;
  UPDATE requirement_update_job AS job
  SET status = 'running',
      lock_token = p_lock_token,
      -- Preserve the rolling-compatible parameter signature, but derive the
      -- authoritative lease from database time so Pod clock skew cannot make
      -- a healthy worker lose (or over-extend) its lease.
      lock_expires_at = CURRENT_TIMESTAMP + interval '15 minutes',
      started_at = CURRENT_TIMESTAMP,
      attempts = job.attempts + 1,
      _updated_at = CURRENT_TIMESTAMP
  WHERE job.id = p_job_id
    AND (
      job.status = 'queued'
      OR (
        job.status = 'running'
        AND job.lock_expires_at <= CURRENT_TIMESTAMP
      )
    )
  RETURNING job.* INTO job_row;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(job_row);
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_finish(
  p_job_id uuid,
  p_lock_token varchar,
  p_status varchar,
  p_result_json text,
  p_error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected_count integer;
  caller_role text := current_setting('role', TRUE);
BEGIN
  IF caller_role !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update finish is worker-only';
  END IF;
  IF NULLIF(p_lock_token, '') IS NULL OR octet_length(p_lock_token) > 255 THEN
    RAISE EXCEPTION 'invalid requirement update job lease token'
      USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid requirement update job result status'
      USING ERRCODE = '22023';
  END IF;
  UPDATE requirement_update_job AS job
  SET status = p_status,
      result_json = CASE WHEN p_status = 'succeeded' THEN p_result_json ELSE NULL END,
      error_message = CASE
        WHEN p_status = 'failed' THEN LEFT(COALESCE(p_error_message, ''), 4000)
        ELSE NULL
      END,
      finished_at = CURRENT_TIMESTAMP,
      lock_token = NULL,
      lock_expires_at = NULL,
      _updated_at = CURRENT_TIMESTAMP
  WHERE job.id = p_job_id
    AND job.status = 'running'
    AND job.lock_token = p_lock_token
    AND job.lock_expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_renew(
  p_job_id uuid,
  p_lock_token varchar,
  p_lock_expires_at TIMESTAMP(3) WITH TIME ZONE
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected_count integer;
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement update lease renewal is worker-only';
  END IF;
  IF NULLIF(p_lock_token, '') IS NULL
    OR octet_length(p_lock_token) > 255
    OR p_lock_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid requirement update job lease renewal'
      USING ERRCODE = '22023';
  END IF;
  UPDATE requirement_update_job AS job
  SET lock_expires_at = CURRENT_TIMESTAMP + interval '15 minutes',
      _updated_at = CURRENT_TIMESTAMP
  WHERE job.id = p_job_id
    AND job.status = 'running'
    AND job.lock_token = p_lock_token
    AND job.lock_expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count = 1;
END;
$$;

-- Miaoda owns database grants and rejects GRANT/REVOKE in application SQL.
-- Every SECURITY DEFINER entry point therefore enforces its caller role,
-- app.user_id ownership and lease token inside the function body. Phase 2
-- additionally denies all direct authenticated/anonymous table access.

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_enqueue(varchar, text, jsonb, varchar) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_get(uuid) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_pending_ids(integer) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_claim(uuid, varchar, timestamp with time zone) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_finish(uuid, varchar, varchar, text, text) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_update_job_renew(uuid, varchar, timestamp with time zone) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
END;
$$;

COMMENT ON FUNCTION requirement_update_job_enqueue(varchar, text, jsonb, varchar)
  IS '由登录用户为自己创建需求更新任务；主体来自 app.user_id，姓名由 worker 实时解析';
COMMENT ON FUNCTION requirement_update_job_get(uuid)
  IS '仅允许创建该任务的登录用户读取状态';

COMMIT;
