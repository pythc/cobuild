BEGIN;

-- Repair already-migrated environments without changing the public RPC
-- identity. Archive admission and asynchronous update admission share the
-- same requirement-scoped transaction lock, closing the archive/PUT race.
CREATE OR REPLACE FUNCTION requirement_archive_upsert(
  p_requirement_id varchar,
  p_requirement_code varchar,
  p_requirement_title text,
  p_actor_user_id varchar,
  p_actor_name varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  actor_profile user_profile;
  affected_count integer;
  active_job_count integer;
BEGIN
  IF NULLIF(p_actor_user_id, '') IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF caller_role ~ '^service_role(_|$)' THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(
      ARRAY['admin', 'editor']::text[]
    )
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive requires an editor role and matching actor';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('requirement_mutation:' || p_requirement_id, 0)
  );
  SELECT count(*) INTO active_job_count
  FROM requirement_update_job AS job
  WHERE job.requirement_id = p_requirement_id
    AND (
      job.status = 'queued'
      OR (
        job.status = 'running'
        AND job.lock_expires_at > CURRENT_TIMESTAMP
      )
    );
  IF active_job_count > 0 THEN
    RAISE EXCEPTION 'requirement has active update jobs'
      USING ERRCODE = '55000';
  END IF;
  actor_profile := concat('(', p_actor_user_id, ')')::user_profile;
  INSERT INTO requirement_archive AS archive (
    requirement_id, requirement_code, requirement_title,
    archived_at, archived_by, archived_by_name,
    restored_at, restored_by, restored_by_name,
    deleted_at, deleted_by, deleted_by_name,
    deletion_status, deletion_claim_token,
    deletion_claim_expires_at, deletion_error,
    _updated_at, _updated_by
  ) VALUES (
    p_requirement_id, COALESCE(p_requirement_code, ''),
    COALESCE(p_requirement_title, ''), CURRENT_TIMESTAMP,
    actor_profile, COALESCE(p_actor_name, ''),
    NULL, NULL, NULL, NULL, NULL, NULL,
    'idle', NULL, NULL, NULL,
    CURRENT_TIMESTAMP, actor_profile
  )
  ON CONFLICT (requirement_id) DO UPDATE SET
    requirement_code = EXCLUDED.requirement_code,
    requirement_title = EXCLUDED.requirement_title,
    archived_at = CURRENT_TIMESTAMP,
    archived_by = EXCLUDED.archived_by,
    archived_by_name = EXCLUDED.archived_by_name,
    restored_at = NULL,
    restored_by = NULL,
    restored_by_name = NULL,
    deleted_at = NULL,
    deleted_by = NULL,
    deleted_by_name = NULL,
    deletion_status = 'idle',
    deletion_claim_token = NULL,
    deletion_claim_expires_at = NULL,
    deletion_error = NULL,
    _updated_at = CURRENT_TIMESTAMP,
    _updated_by = actor_profile
  WHERE archive.restored_at IS NOT NULL OR archive.deleted_at IS NOT NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count = 1;
END;
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.requirement_archive_upsert(varchar, varchar, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
END;
$$;

COMMENT ON FUNCTION requirement_archive_upsert(varchar, varchar, text, varchar, varchar)
  IS 'Archive admission serialized against queued and running requirement updates';

COMMIT;
