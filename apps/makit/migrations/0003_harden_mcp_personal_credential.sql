BEGIN;

-- 这是未发布功能的最终加固迁移。旧结构若仍有无法归属的行则立即中止，
-- 不静默删除凭据，也不猜测用户身份。
ALTER TABLE mcp_personal_credential
  ADD COLUMN IF NOT EXISTS subject_hash varchar(64);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mcp_personal_credential
    WHERE subject_hash IS NULL OR _created_by IS NULL
  ) THEN
    RAISE EXCEPTION
      'mcp_personal_credential contains legacy rows that require explicit migration';
  END IF;
END;
$$;

ALTER TABLE mcp_personal_credential
  ALTER COLUMN subject_hash SET NOT NULL;

ALTER TABLE mcp_personal_credential
  DROP COLUMN IF EXISTS miaoda_user_id,
  DROP COLUMN IF EXISTS employee_id,
  DROP COLUMN IF EXISTS open_id,
  DROP COLUMN IF EXISTS user_name;

ALTER TABLE mcp_personal_credential
  DROP CONSTRAINT IF EXISTS mcp_personal_credential_subject_hash_check;
ALTER TABLE mcp_personal_credential
  ADD CONSTRAINT mcp_personal_credential_subject_hash_check
  CHECK (subject_hash ~ '^[0-9a-f]{64}$');

DROP INDEX IF EXISTS uk_mcp_personal_credential_subject_hash;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'mcp_personal_credential'::regclass
      AND conname = 'mcp_personal_credential_subject_hash_key'
  ) THEN
    ALTER TABLE mcp_personal_credential
      ADD CONSTRAINT mcp_personal_credential_subject_hash_key
      UNIQUE (subject_hash);
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_mcp_personal_credential_active;

DROP POLICY IF EXISTS "用户查看自己的MCP凭据" ON mcp_personal_credential;
DROP POLICY IF EXISTS "用户创建自己的MCP凭据" ON mcp_personal_credential;
DROP POLICY IF EXISTS "用户更新自己的MCP凭据" ON mcp_personal_credential;
DROP POLICY IF EXISTS "修改全部数据" ON mcp_personal_credential;
DROP POLICY IF EXISTS "查看全部数据" ON mcp_personal_credential;
DROP POLICY IF EXISTS "修改本人数据" ON mcp_personal_credential;

ALTER TABLE mcp_personal_credential ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass_policy ON mcp_personal_credential;
CREATE POLICY service_role_bypass_policy ON mcp_personal_credential
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "MCP登录用户禁止直接访问" ON mcp_personal_credential;
CREATE POLICY "MCP登录用户禁止直接访问" ON mcp_personal_credential
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "MCP匿名用户禁止直接访问" ON mcp_personal_credential;
CREATE POLICY "MCP匿名用户禁止直接访问" ON mcp_personal_credential
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION mcp_personal_credential_get(
  p_subject_hash varchar
)
RETURNS TABLE (
  credential_id uuid,
  token_version integer,
  revoked_at TIMESTAMP(3) WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, workspace_aadknhjojzqdw, pg_temp
AS $$
DECLARE
  actor_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
BEGIN
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_subject_hash IS NULL OR p_subject_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid MCP subject hash' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id, c.token_version, c.revoked_at
  FROM mcp_personal_credential AS c
  WHERE c.subject_hash = p_subject_hash
    AND ((c._created_by).user_id)::text = actor_user_id
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION mcp_personal_credential_issue(
  p_subject_hash varchar,
  p_rotate boolean DEFAULT false
)
RETURNS TABLE (
  credential_id uuid,
  token_version integer,
  revoked_at TIMESTAMP(3) WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, workspace_aadknhjojzqdw, pg_temp
AS $$
DECLARE
  actor_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
  actor_profile user_profile;
BEGIN
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_subject_hash IS NULL OR p_subject_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid MCP subject hash' USING ERRCODE = '22023';
  END IF;
  actor_profile := concat('(', actor_user_id, ')')::user_profile;

  IF p_rotate THEN
    RETURN QUERY
    INSERT INTO mcp_personal_credential AS c (
      subject_hash,
      token_version,
      revoked_at,
      _created_by,
      _updated_by
    )
    VALUES (p_subject_hash, 1, NULL, actor_profile, actor_profile)
    ON CONFLICT (subject_hash) DO UPDATE
    SET token_version = c.token_version + 1,
        revoked_at = NULL,
        _updated_at = CURRENT_TIMESTAMP,
        _updated_by = actor_profile
    WHERE ((c._created_by).user_id)::text = actor_user_id
    RETURNING c.id, c.token_version, c.revoked_at;
  ELSE
    RETURN QUERY
    INSERT INTO mcp_personal_credential AS c (
      subject_hash,
      token_version,
      revoked_at,
      _created_by,
      _updated_by
    )
    VALUES (p_subject_hash, 1, NULL, actor_profile, actor_profile)
    ON CONFLICT (subject_hash) DO UPDATE
    SET _updated_at = CURRENT_TIMESTAMP,
        _updated_by = actor_profile
    WHERE ((c._created_by).user_id)::text = actor_user_id
    RETURNING c.id, c.token_version, c.revoked_at;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mcp_personal_credential_verify(
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, workspace_aadknhjojzqdw, pg_temp
AS $$
BEGIN
  IF p_subject_hash IS NULL OR p_subject_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM mcp_personal_credential AS c
    WHERE c.id = p_credential_id
      AND c.token_version = p_token_version
      AND c.subject_hash = p_subject_hash
      AND c.revoked_at IS NULL
  );
END;
$$;

COMMENT ON FUNCTION mcp_personal_credential_get(varchar) IS
  '仅向已登录用户返回其本人的不可识别凭据状态';
COMMENT ON FUNCTION mcp_personal_credential_issue(varchar, boolean) IS
  '按当前登录用户原子签发或轮换个人 MCP 凭据状态';
COMMENT ON FUNCTION mcp_personal_credential_verify(uuid, integer, varchar) IS
  '仅返回 MCP 凭据是否有效，不暴露凭据表内容';

COMMIT;
