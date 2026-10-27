-- Included by the root migration in a single transaction. No existing data changes.
CREATE TABLE workspace_saved_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id varchar(255) NOT NULL,
  scope varchar(16) NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'team')),
  name varchar(120) NOT NULL,
  config_json text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
COMMENT ON TABLE workspace_saved_view IS '个人跨设备与团队需求视图；只保存白名单筛选配置，不授予需求访问权限';
CREATE INDEX idx_workspace_saved_view_owner_scope ON workspace_saved_view(owner_user_id, scope);
CREATE INDEX idx_workspace_saved_view_scope_updated ON workspace_saved_view(scope, _updated_at);
ALTER TABLE workspace_saved_view ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON workspace_saved_view TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON workspace_saved_view AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON workspace_saved_view AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON workspace_saved_view AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE requirement_cache_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id varchar(255) NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  operation_id uuid,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
COMMENT ON TABLE requirement_cache_revision IS '需求缓存跨实例失效水位；不是第二份需求主数据';
ALTER TABLE requirement_cache_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON requirement_cache_revision TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON requirement_cache_revision AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON requirement_cache_revision AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON requirement_cache_revision AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
