BEGIN;

-- An early draft of 0017 changed the table contract used by the currently
-- deployed application. Restore the legacy unique indexes and temporarily
-- remove authenticated write denies so old Pods can keep serving during the
-- rolling release. Migration 0022 closes direct access after every Pod has
-- switched to the additive operation/state/event contract.
DROP POLICY IF EXISTS pull_request_reviewer_history_no_insert
  ON pull_request_reviewer;
DROP POLICY IF EXISTS pull_request_reviewer_history_no_update
  ON pull_request_reviewer;
DROP POLICY IF EXISTS pull_request_reviewer_history_no_delete
  ON pull_request_reviewer;

DROP POLICY IF EXISTS pull_request_reviewer_anon_no_access
  ON pull_request_reviewer;
CREATE POLICY pull_request_reviewer_anon_no_access
  ON pull_request_reviewer
  AS RESTRICTIVE FOR SELECT TO anon
  USING (false);

-- Remove the non-unique draft indexes when the original unique contracts are
-- already present. This is a schema cleanup only; it does not loosen access.
DROP INDEX IF EXISTS idx_pull_request_reviewer_user;
DROP INDEX IF EXISTS idx_pull_request_reviewer_github_login;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pull_request_reviewer
    GROUP BY repository, pull_number, reviewer_user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot restore legacy reviewer user uniqueness: duplicate rows exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pull_request_reviewer
    WHERE github_login IS NOT NULL
    GROUP BY repository, pull_number, github_login
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot restore legacy reviewer login uniqueness: duplicate rows exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_user
  ON pull_request_reviewer(repository, pull_number, reviewer_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_github_login
  ON pull_request_reviewer(repository, pull_number, github_login)
  WHERE github_login IS NOT NULL;

-- Legacy Pods use direct table DML. Do not recreate the broad historical
-- definer helpers; the new application exclusively uses the additive 0021
-- operation/state/event contract.

COMMENT ON TABLE pull_request_reviewer IS
  '旧版应用兼容表；新版评审通知改用独立状态与事件表';

COMMIT;
