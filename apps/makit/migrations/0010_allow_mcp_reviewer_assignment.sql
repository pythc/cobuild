BEGIN;

ALTER TABLE pull_request_reviewer
  ALTER COLUMN reviewer DROP NOT NULL;

COMMENT ON COLUMN pull_request_reviewer.reviewer IS
  '兼容妙搭用户字段；评审人主身份以 reviewer_user_id、reviewer_employee_id 为准';

COMMIT;
