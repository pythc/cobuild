BEGIN;
CREATE TABLE iteration_configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iteration_id varchar(255) NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  draft_json text NOT NULL,
  published_json text,
  history_json text NOT NULL DEFAULT '[]',
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END)
);
COMMENT ON TABLE iteration_configuration IS '迭代工作流草稿、发布版本与里程碑配置';
ALTER TABLE iteration_configuration ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass_policy ON iteration_configuration TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON iteration_configuration AS PERMISSIVE FOR ALL TO authenticated USING (true);
CREATE POLICY "查看全部数据" ON iteration_configuration AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "修改本人数据" ON iteration_configuration AS PERMISSIVE FOR ALL TO authenticated USING (false);
CREATE POLICY iteration_configuration_login ON iteration_configuration AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (COALESCE(current_setting('app.user_id', TRUE), '') <> '')
  WITH CHECK (COALESCE(current_setting('app.user_id', TRUE), '') <> '');
CREATE POLICY iteration_configuration_admin_insert ON iteration_configuration AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ('admin' = ANY(string_to_array(COALESCE(current_setting('app.role_ids', TRUE), ''), ',')));
CREATE POLICY iteration_configuration_admin_update ON iteration_configuration AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ('admin' = ANY(string_to_array(COALESCE(current_setting('app.role_ids', TRUE), ''), ',')))
  WITH CHECK ('admin' = ANY(string_to_array(COALESCE(current_setting('app.role_ids', TRUE), ''), ',')));
CREATE POLICY iteration_configuration_no_delete ON iteration_configuration AS RESTRICTIVE FOR DELETE TO authenticated USING (false);
COMMIT;
