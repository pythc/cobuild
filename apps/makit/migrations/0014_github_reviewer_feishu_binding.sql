BEGIN;

CREATE TABLE IF NOT EXISTS github_reviewer_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  github_login varchar(255) NOT NULL,
  reviewer_employee_id varchar(255) NOT NULL,
  reviewer_name varchar(128) NOT NULL,
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

ALTER TABLE github_reviewer_binding ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON github_reviewer_binding
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON github_reviewer_binding
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON github_reviewer_binding
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON github_reviewer_binding
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

CREATE POLICY github_reviewer_binding_anon_no_access
  ON github_reviewer_binding
  AS RESTRICTIVE FOR SELECT TO anon USING (false);

DROP INDEX IF EXISTS uk_github_reviewer_binding_login;
CREATE UNIQUE INDEX uk_github_reviewer_binding_login
  ON github_reviewer_binding(repository, github_login);

CREATE UNIQUE INDEX IF NOT EXISTS uk_github_reviewer_binding_user
  ON github_reviewer_binding(repository, reviewer_employee_id);

COMMENT ON TABLE github_reviewer_binding IS
  'GitHub reviewer 与飞书通知接收人的全局映射';
COMMENT ON COLUMN github_reviewer_binding.github_login IS
  'GitHub login，按仓库大小写不敏感唯一';
COMMENT ON COLUMN github_reviewer_binding.reviewer_employee_id IS
  '飞书 user_id，用于机器人私聊';

ALTER TABLE pull_request_reviewer
  ADD COLUMN IF NOT EXISTS github_login varchar(255);

DROP INDEX IF EXISTS uk_pull_request_reviewer_github_login;
CREATE UNIQUE INDEX uk_pull_request_reviewer_github_login
  ON pull_request_reviewer(repository, pull_number, github_login)
  WHERE github_login IS NOT NULL;

COMMENT ON COLUMN pull_request_reviewer.github_login IS
  '触发飞书通知的 GitHub reviewer login';
COMMENT ON TABLE pull_request_reviewer IS
  'GitHub reviewer 的飞书通知投递状态';

COMMIT;
