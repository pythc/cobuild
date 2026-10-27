BEGIN;

-- 0015 reached the shared development database before its policies were
-- tightened. Remove the generated permissive policies there as well.
DROP POLICY IF EXISTS "修改全部数据" ON requirement_archive;
DROP POLICY IF EXISTS "查看全部数据" ON requirement_archive;
DROP POLICY IF EXISTS "修改本人数据" ON requirement_archive;
DROP POLICY IF EXISTS requirement_archive_anon_no_access ON requirement_archive;
DROP POLICY IF EXISTS service_role_bypass_policy ON requirement_archive;

CREATE POLICY service_role_bypass_policy ON requirement_archive
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "修改全部数据" ON requirement_archive
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON requirement_archive
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON requirement_archive
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

DROP POLICY IF EXISTS "需求归档登录用户禁止直接访问" ON requirement_archive;
CREATE POLICY "需求归档登录用户禁止直接访问" ON requirement_archive
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "需求归档匿名用户禁止直接访问" ON requirement_archive;
CREATE POLICY "需求归档匿名用户禁止直接访问" ON requirement_archive
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

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
  IF caller_role ~ '^service_role(_|$)' THEN RETURN true; END IF;
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
  IF caller_role ~ '^service_role(_|$)' THEN
    NULL;
  ELSIF caller_role ~ '^authenticated(_|$)' AND request_user_id IS NOT NULL THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING MESSAGE = 'requirement archive is not available to this role';
  END IF;
  RETURN QUERY
  SELECT archive.requirement_id
  FROM requirement_archive AS archive
  WHERE archive.restored_at IS NULL AND archive.deleted_at IS NULL;
END;
$$;

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
    _updated_at, _updated_by
  ) VALUES (
    p_requirement_id, COALESCE(p_requirement_code, ''),
    COALESCE(p_requirement_title, ''), CURRENT_TIMESTAMP,
    actor_profile, COALESCE(p_actor_name, ''),
    NULL, NULL, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, actor_profile
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
    _updated_at = CURRENT_TIMESTAMP,
    _updated_by = actor_profile;
  RETURN true;
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
    AND deleted_at IS NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

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

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_caller_has_any_role(text[]) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_active_ids() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_upsert(varchar, varchar, text, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_restore(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_mark_deleted(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$$;

COMMIT;
