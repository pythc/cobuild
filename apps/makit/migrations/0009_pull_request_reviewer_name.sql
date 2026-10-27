BEGIN;

ALTER TABLE pull_request_reviewer
  ADD COLUMN IF NOT EXISTS reviewer_name varchar(128) NOT NULL DEFAULT '';

COMMENT ON COLUMN pull_request_reviewer.reviewer_name IS
  '评审人姓名快照，用于平台与 MCP 展示';

COMMIT;
