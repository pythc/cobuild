BEGIN;

ALTER TABLE requirement_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass_policy ON requirement_archive;
CREATE POLICY service_role_bypass_policy ON requirement_archive
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "需求归档登录用户禁止直接访问" ON requirement_archive;
CREATE POLICY "需求归档登录用户禁止直接访问" ON requirement_archive
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "需求归档匿名用户禁止直接访问" ON requirement_archive;
CREATE POLICY "需求归档匿名用户禁止直接访问" ON requirement_archive
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- DataPaas injects the authenticated user's platform role IDs into
-- app.role_ids for every database statement. The database cannot read the
-- Node.js environment variables, so this boundary deliberately trusts only
-- the platform-issued IDs in that GUC. The application's verified role IDs
-- are the stable literals admin/editor/viewer. Role aliases are intentionally
-- unsupported by both Node.js and SQL; changing an ID requires an explicit,
-- reviewed code and database migration.
CREATE OR REPLACE FUNCTION requirement_archive_caller_has_any_role(
  p_allowed_roles text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  request_role_ids text := COALESCE(
    NULLIF(current_setting('app.role_ids', TRUE), ''),
    ''
  );
BEGIN
  IF caller_role ~ '^service_role(_|$)' THEN
    RETURN true;
  END IF;
  IF caller_role !~ '^authenticated(_|$)' OR request_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM unnest(string_to_array(request_role_ids, ',')) AS platform_role(role_id)
    WHERE btrim(platform_role.role_id) = ANY(p_allowed_roles)
  );
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_active_ids()
RETURNS TABLE (requirement_id varchar)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
BEGIN
  -- Every signed-in platform member needs this minimal ID set so normal
  -- requirement queries can hide archived records. It exposes no archive
  -- metadata and cannot mutate state.
  IF caller_role ~ '^service_role(_|$)' THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)' AND request_user_id IS NOT NULL THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive IDs are not available to this role';
  END IF;
  RETURN QUERY
  SELECT archive.requirement_id
  FROM requirement_archive AS archive
  WHERE archive.restored_at IS NULL AND archive.deleted_at IS NULL;
END;
$$;

-- Preserve the original five-column function contract so the platform schema
-- differ never has to reinterpret an existing function's result row type.
CREATE OR REPLACE FUNCTION requirement_archive_list()
RETURNS TABLE (
  requirement_id varchar,
  requirement_code varchar,
  requirement_title text,
  archived_at TIMESTAMP(3) WITH TIME ZONE,
  archived_by_name varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  IF NOT requirement_archive_caller_has_any_role(
    ARRAY['admin', 'editor']::text[]
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive list requires an editor role';
  END IF;
  RETURN QUERY
  SELECT
    archive.requirement_id,
    archive.requirement_code,
    archive.requirement_title,
    archive.archived_at,
    archive.archived_by_name
  FROM requirement_archive AS archive
  WHERE archive.restored_at IS NULL AND archive.deleted_at IS NULL
  ORDER BY archive.archived_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_list_v2()
RETURNS TABLE (
  requirement_id varchar,
  requirement_code varchar,
  requirement_title text,
  archived_at TIMESTAMP(3) WITH TIME ZONE,
  archived_by_name varchar,
  deletion_status varchar,
  deletion_error text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  IF NOT requirement_archive_caller_has_any_role(
    ARRAY['admin', 'editor']::text[]
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive list requires an editor role';
  END IF;
  RETURN QUERY
  SELECT
    archive.requirement_id,
    archive.requirement_code,
    archive.requirement_title,
    archive.archived_at,
    archive.archived_by_name,
    archive.deletion_status,
    archive.deletion_error
  FROM requirement_archive AS archive
  WHERE archive.restored_at IS NULL AND archive.deleted_at IS NULL
  ORDER BY archive.archived_at DESC;
END;
$$;

-- Retain the historical signature for schema compatibility, but make the
-- non-leased deletion shortcut unusable. Permanent deletion must use the
-- claim/renew/complete saga below.
CREATE OR REPLACE FUNCTION requirement_archive_mark_deleted(
  p_requirement_id varchar,
  p_actor_user_id varchar,
  p_actor_name varchar
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RAISE feature_not_supported USING
    MESSAGE = 'use the leased requirement archive deletion workflow';
END;
$$;

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

CREATE OR REPLACE FUNCTION requirement_archive_restore(
  p_requirement_id varchar,
  p_actor_user_id varchar,
  p_actor_name varchar
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  actor_profile user_profile;
  affected_count integer;
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
      MESSAGE = 'requirement restore requires an editor role and matching actor';
  END IF;
  actor_profile := concat('(', p_actor_user_id, ')')::user_profile;
  UPDATE requirement_archive
  SET restored_at = CURRENT_TIMESTAMP,
      restored_by = actor_profile,
      restored_by_name = COALESCE(p_actor_name, ''),
      _updated_at = CURRENT_TIMESTAMP,
      _updated_by = actor_profile
  WHERE requirement_id = p_requirement_id
    AND restored_at IS NULL
    AND deleted_at IS NULL
    AND deletion_status = 'idle';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_delete_claim(
  p_requirement_id varchar,
  p_actor_user_id varchar,
  p_actor_name varchar,
  p_lease_seconds integer
)
RETURNS TABLE(claim_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  actor_profile user_profile;
  next_token uuid := gen_random_uuid();
BEGIN
  IF NULLIF(p_actor_user_id, '') IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF caller_role ~ '^service_role(_|$)' THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(ARRAY['admin']::text[])
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement permanent deletion requires an admin role';
  END IF;
  actor_profile := concat('(', p_actor_user_id, ')')::user_profile;
  RETURN QUERY
  UPDATE requirement_archive AS archive
  SET deletion_status = 'deleting',
      deletion_claim_token = next_token,
      deletion_claim_expires_at = CURRENT_TIMESTAMP
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900)),
      deletion_error = NULL,
      _updated_at = CURRENT_TIMESTAMP,
      _updated_by = actor_profile
  WHERE archive.requirement_id = p_requirement_id
    AND archive.restored_at IS NULL
    AND archive.deleted_at IS NULL
    AND (
      archive.deletion_status IN ('idle', 'failed')
      OR (
        archive.deletion_status = 'deleting'
        AND archive.deletion_claim_expires_at <= CURRENT_TIMESTAMP
      )
    )
  RETURNING next_token;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_delete_renew(
  p_requirement_id varchar,
  p_claim_token uuid,
  p_lease_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  caller_is_service boolean := caller_role ~ '^service_role(_|$)';
  affected_count integer;
BEGIN
  IF NOT caller_is_service
    AND NOT requirement_archive_caller_has_any_role(ARRAY['admin']::text[])
  THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement permanent deletion requires an admin role';
  END IF;
  UPDATE requirement_archive
  SET deletion_claim_expires_at = CURRENT_TIMESTAMP
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900)),
      _updated_at = CURRENT_TIMESTAMP
  WHERE requirement_id = p_requirement_id
    AND deletion_status = 'deleting'
    AND deletion_claim_token = p_claim_token
    AND deletion_claim_expires_at > CURRENT_TIMESTAMP
    AND (
      caller_is_service
      OR ((_updated_by).user_id)::text = request_user_id
    );
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_delete_complete(
  p_requirement_id varchar,
  p_claim_token uuid,
  p_actor_user_id varchar,
  p_actor_name varchar
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  caller_is_service boolean := caller_role ~ '^service_role(_|$)';
  actor_profile user_profile;
  affected_count integer;
BEGIN
  IF NULLIF(p_actor_user_id, '') IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF caller_is_service THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(ARRAY['admin']::text[])
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement permanent deletion requires an admin role';
  END IF;
  actor_profile := concat('(', p_actor_user_id, ')')::user_profile;
  UPDATE requirement_archive
  SET deleted_at = CURRENT_TIMESTAMP,
      deleted_by = actor_profile,
      deleted_by_name = COALESCE(p_actor_name, ''),
      deletion_status = 'idle',
      deletion_claim_token = NULL,
      deletion_claim_expires_at = NULL,
      deletion_error = NULL,
      _updated_at = CURRENT_TIMESTAMP,
      _updated_by = actor_profile
  WHERE requirement_id = p_requirement_id
    AND restored_at IS NULL
    AND deleted_at IS NULL
    AND deletion_status = 'deleting'
    AND deletion_claim_token = p_claim_token
    AND (
      caller_is_service
      OR ((_updated_by).user_id)::text = p_actor_user_id
    );
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_archive_delete_fail(
  p_requirement_id varchar,
  p_claim_token uuid,
  p_error_message text,
  p_actor_user_id varchar,
  p_actor_name varchar
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  caller_is_service boolean := caller_role ~ '^service_role(_|$)';
  actor_profile user_profile;
  affected_count integer;
BEGIN
  IF NULLIF(p_actor_user_id, '') IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF caller_is_service THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(ARRAY['admin']::text[])
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement permanent deletion requires an admin role';
  END IF;
  actor_profile := concat('(', p_actor_user_id, ')')::user_profile;
  UPDATE requirement_archive
  SET deletion_status = 'failed',
      deletion_claim_token = NULL,
      deletion_claim_expires_at = NULL,
      deletion_error = LEFT(COALESCE(p_error_message, ''), 2000),
      _updated_at = CURRENT_TIMESTAMP,
      _updated_by = actor_profile
  WHERE requirement_id = p_requirement_id
    AND restored_at IS NULL
    AND deleted_at IS NULL
    AND deletion_status = 'deleting'
    AND deletion_claim_token = p_claim_token
    AND (
      caller_is_service
      OR ((_updated_by).user_id)::text = p_actor_user_id
    );
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_caller_has_any_role(text[]) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_active_ids() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list_v2() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_mark_deleted(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_upsert(varchar, varchar, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_restore(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_claim(varchar, varchar, varchar, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_renew(varchar, uuid, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_complete(varchar, uuid, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_fail(varchar, uuid, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$$;

-- Miaoda manages function execution privileges; application SQL must not
-- change them. Direct table access remains closed by the restrictive policies
-- above. Every usable SECURITY DEFINER entry point validates the injected
-- caller role, app.user_id, platform role IDs and deletion lease internally;
-- the retained legacy deletion entry point always rejects the call.

COMMENT ON FUNCTION requirement_archive_caller_has_any_role(text[]) IS
  'Boolean-only caller role check; it reads no archive business data';
COMMENT ON FUNCTION requirement_archive_active_ids() IS
  'Minimal archived ID set for signed-in requirement queries and service workers';
COMMENT ON FUNCTION requirement_archive_list() IS
  'Legacy five-column archive list restricted to platform admin/editor roles';
COMMENT ON FUNCTION requirement_archive_list_v2() IS
  'Archive metadata and deletion state restricted to platform admin/editor roles';
COMMENT ON FUNCTION requirement_archive_mark_deleted(varchar, varchar, varchar) IS
  'Disabled legacy shortcut; permanent deletion requires the leased saga';
COMMENT ON FUNCTION requirement_archive_delete_claim(varchar, varchar, varchar, integer) IS
  'Admin/service-only lease claim for permanent deletion';

COMMIT;
