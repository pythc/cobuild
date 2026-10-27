BEGIN;

ALTER TABLE pull_request_reviewer
  ADD COLUMN IF NOT EXISTS reviewer_employee_id varchar(255) NOT NULL DEFAULT '';

COMMENT ON COLUMN pull_request_reviewer.reviewer_employee_id IS
  '飞书 user_id，仅供服务端私聊通知使用';

COMMIT;
