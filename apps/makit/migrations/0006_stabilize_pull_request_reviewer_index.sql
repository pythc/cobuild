BEGIN;

ALTER TABLE pull_request_reviewer
  ADD COLUMN IF NOT EXISTS reviewer_user_id varchar(255);

UPDATE pull_request_reviewer
SET reviewer_user_id = ((reviewer).user_id)::text
WHERE reviewer_user_id IS NULL;

ALTER TABLE pull_request_reviewer
  ALTER COLUMN reviewer_user_id SET NOT NULL;

DROP INDEX IF EXISTS uk_pull_request_reviewer_user;

CREATE UNIQUE INDEX uk_pull_request_reviewer_user
  ON pull_request_reviewer(repository, pull_number, reviewer_user_id);

COMMENT ON COLUMN pull_request_reviewer.reviewer_user_id IS
  '妙搭用户 ID，与 reviewer.user_id 同值，用于稳定唯一索引';

COMMIT;
