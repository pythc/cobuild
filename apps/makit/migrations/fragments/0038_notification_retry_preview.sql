CREATE TABLE IF NOT EXISTS notification_retry_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id varchar(128) NOT NULL,
  delivery_ids_json text NOT NULL,
  projection_digest varchar(64) NOT NULL,
  expires_at TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END),
  CONSTRAINT notification_retry_preview_ids_check CHECK (jsonb_typeof(delivery_ids_json::jsonb) = 'array' AND jsonb_array_length(delivery_ids_json::jsonb) BETWEEN 1 AND 100)
);
ALTER TABLE notification_retry_preview ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass_policy ON notification_retry_preview;
CREATE POLICY service_role_bypass_policy ON notification_retry_preview FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON notification_retry_preview;
CREATE POLICY "修改全部数据" ON notification_retry_preview AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "查看全部数据" ON notification_retry_preview;
CREATE POLICY "查看全部数据" ON notification_retry_preview AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
DROP POLICY IF EXISTS "修改本人数据" ON notification_retry_preview;
CREATE POLICY "修改本人数据" ON notification_retry_preview AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
