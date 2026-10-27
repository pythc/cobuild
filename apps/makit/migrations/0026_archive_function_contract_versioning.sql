BEGIN;

-- Repair development environments that briefly replaced the original list
-- function with a wider return row. The final schema preserves the legacy
-- signature and adds a versioned v2 RPC, which the Miaoda schema differ can
-- publish without interpreting a changed result contract.
DROP FUNCTION IF EXISTS requirement_archive_list();

CREATE FUNCTION requirement_archive_list()
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
  SELECT archive.requirement_id, archive.requirement_code,
    archive.requirement_title, archive.archived_at,
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
  SELECT archive.requirement_id, archive.requirement_code,
    archive.requirement_title, archive.archived_at,
    archive.archived_by_name, archive.deletion_status,
    archive.deletion_error
  FROM requirement_archive AS archive
  WHERE archive.restored_at IS NULL AND archive.deleted_at IS NULL
  ORDER BY archive.archived_at DESC;
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
DECLARE schema_name text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_list_v2() SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.requirement_archive_mark_deleted(varchar, varchar, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$$;

COMMIT;
