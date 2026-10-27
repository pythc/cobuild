BEGIN;

CREATE TABLE IF NOT EXISTS mcp_personal_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_hash varchar(64) NOT NULL UNIQUE
    CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  revoked_at TIMESTAMP(3) WITH TIME ZONE,
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

ALTER TABLE mcp_personal_credential ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON mcp_personal_credential
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE mcp_personal_credential IS
  '需求平台 MCP 个人长期凭据状态；业务身份仅保存在签名令牌中';
COMMENT ON COLUMN mcp_personal_credential.subject_hash IS
  '环境内不可逆用户摘要，仅用于稳定查找个人凭据状态';
COMMENT ON COLUMN mcp_personal_credential.token_version IS
  '递增后使该用户旧 Token 失效';
COMMENT ON COLUMN mcp_personal_credential.revoked_at IS
  '非空时拒绝该用户所有 MCP 请求';

COMMIT;
