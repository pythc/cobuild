BEGIN;

-- 妙搭的 dev -> online 结构同步可能不保留普通 UNIQUE 约束。
-- 使用 subject_hash 级事务锁保证签发原子性，避免依赖 ON CONFLICT 的索引推断。
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
  existing_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_subject_hash IS NULL OR p_subject_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid MCP subject hash' USING ERRCODE = '22023';
  END IF;

  actor_profile := concat('(', actor_user_id, ')')::user_profile;

  -- 同一 subject_hash 的并发签发必须串行，锁在当前事务结束时自动释放。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject_hash, 0));

  SELECT c.id
  INTO existing_id
  FROM mcp_personal_credential AS c
  WHERE c.subject_hash = p_subject_hash
    AND ((c._created_by).user_id)::text = actor_user_id
  ORDER BY c._created_at ASC, c.id ASC
  LIMIT 1
  FOR UPDATE;

  IF existing_id IS NOT NULL THEN
    RETURN QUERY
    UPDATE mcp_personal_credential AS c
    SET token_version = CASE
          WHEN COALESCE(p_rotate, false) THEN c.token_version + 1
          ELSE c.token_version
        END,
        revoked_at = CASE
          WHEN COALESCE(p_rotate, false) THEN NULL
          ELSE c.revoked_at
        END,
        _updated_at = CURRENT_TIMESTAMP,
        _updated_by = actor_profile
    WHERE c.id = existing_id
      AND ((c._created_by).user_id)::text = actor_user_id
    RETURNING c.id, c.token_version, c.revoked_at;
    RETURN;
  END IF;

  -- 摘要碰撞或异常脏数据不得静默创建第二条凭据。
  IF EXISTS (
    SELECT 1
    FROM mcp_personal_credential AS c
    WHERE c.subject_hash = p_subject_hash
  ) THEN
    RAISE EXCEPTION 'MCP subject hash belongs to another user'
      USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  INSERT INTO mcp_personal_credential (
    subject_hash,
    token_version,
    revoked_at,
    _created_by,
    _updated_by
  )
  VALUES (p_subject_hash, 1, NULL, actor_profile, actor_profile)
  RETURNING
    mcp_personal_credential.id,
    mcp_personal_credential.token_version,
    mcp_personal_credential.revoked_at;
END;
$$;

COMMENT ON FUNCTION mcp_personal_credential_issue(varchar, boolean) IS
  '按当前登录用户原子签发或轮换个人 MCP 凭据状态，不依赖唯一索引同步';

COMMIT;
