BEGIN;

ALTER TABLE pull_request_reviewer
  ADD COLUMN IF NOT EXISTS assigned_by_name varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMP(3) WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS notification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notification_error text;

COMMENT ON COLUMN pull_request_reviewer.notified_at IS
  '平台评审人私聊通知成功时间；为空时由服务重试';

COMMIT;
