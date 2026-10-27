BEGIN;

ALTER TABLE requirement_archive
  ADD COLUMN IF NOT EXISTS deletion_status varchar(32) NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS deletion_claim_token uuid,
  ADD COLUMN IF NOT EXISTS deletion_claim_expires_at TIMESTAMP(3) WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS deletion_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'requirement_archive_deletion_state_check'
      AND conrelid = 'requirement_archive'::regclass
  ) THEN
    ALTER TABLE requirement_archive
      ADD CONSTRAINT requirement_archive_deletion_state_check CHECK (
        (
          deletion_status = 'deleting'
          AND deletion_claim_token IS NOT NULL
          AND deletion_claim_expires_at IS NOT NULL
        )
        OR (
          deletion_status IN ('idle', 'failed')
          AND deletion_claim_token IS NULL
          AND deletion_claim_expires_at IS NULL
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_requirement_archive_deletion
  ON requirement_archive(deletion_status, deletion_claim_expires_at)
  WHERE restored_at IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN requirement_archive.deletion_status IS
  '永久删除状态：idle/deleting/failed；一旦开始删除就不能恢复';
COMMENT ON COLUMN requirement_archive.deletion_claim_token IS
  '永久删除租约 token，防止恢复与多个删除操作并发';
COMMENT ON COLUMN requirement_archive.deletion_claim_expires_at IS
  '永久删除租约到期时间，进程异常后允许安全续跑';
COMMENT ON COLUMN requirement_archive.deletion_error IS
  '最近一次未完成删除的错误摘要，供管理员重试和排查';

-- This migration is independently safe to publish before 0023. Never leave
-- the newly introduced archive RPCs exposed to every authenticated user,
-- even for the short interval between two migration files.
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

-- Keep the legacy list function's return contract unchanged for the Miaoda
-- dev-to-online schema differ. The application uses the versioned v2 RPC.
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
      MESSAGE = 'requirement archive restore requires an editor role and matching actor';
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
    AND requirement_archive_caller_has_any_role(
      ARRAY['admin']::text[]
    )
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive deletion requires an administrator';
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
      MESSAGE = 'requirement archive deletion requires an administrator';
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
  IF caller_is_service THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(
      ARRAY['admin']::text[]
    )
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive deletion requires an administrator';
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
      OR ((_updated_by).user_id)::text = request_user_id
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
  IF caller_is_service THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)'
    AND request_user_id = p_actor_user_id
    AND requirement_archive_caller_has_any_role(
      ARRAY['admin']::text[]
    )
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'requirement archive deletion requires an administrator';
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
      OR ((_updated_by).user_id)::text = request_user_id
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
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list_v2() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_upsert(varchar, varchar, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_restore(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_claim(varchar, varchar, varchar, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_renew(varchar, uuid, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_complete(varchar, uuid, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_delete_fail(varchar, uuid, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$$;

COMMIT;
