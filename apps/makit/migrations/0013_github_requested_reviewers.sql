BEGIN;

ALTER TABLE pull_request_snapshot
  ADD COLUMN IF NOT EXISTS requested_reviewers_json text NOT NULL DEFAULT '[]';

COMMENT ON COLUMN pull_request_snapshot.requested_reviewers_json IS
  'GitHub requested reviewers JSON';

COMMIT;
