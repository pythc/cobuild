BEGIN;

CREATE TABLE IF NOT EXISTS pull_request_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  pull_number integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  state varchar(32) NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  url text NOT NULL,
  author_login varchar(255) NOT NULL DEFAULT '',
  author_avatar_url text NOT NULL DEFAULT '',
  head_ref varchar(255) NOT NULL DEFAULT '',
  base_ref varchar(255) NOT NULL DEFAULT '',
  mergeable varchar(32) NOT NULL DEFAULT 'UNKNOWN',
  review_decision varchar(64) NOT NULL DEFAULT '',
  checks_status varchar(32) NOT NULL DEFAULT 'UNKNOWN',
  additions integer NOT NULL DEFAULT 0,
  deletions integer NOT NULL DEFAULT 0,
  changed_files integer NOT NULL DEFAULT 0,
  commit_count integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  review_count integer NOT NULL DEFAULT 0,
  review_thread_count integer NOT NULL DEFAULT 0,
  comments_json text NOT NULL DEFAULT '[]',
  reviews_json text NOT NULL DEFAULT '[]',
  review_threads_json text NOT NULL DEFAULT '[]',
  checks_json text NOT NULL DEFAULT '[]',
  github_created_at TIMESTAMP(3) WITH TIME ZONE,
  github_updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  closed_at TIMESTAMP(3) WITH TIME ZONE,
  merged_at TIMESTAMP(3) WITH TIME ZONE,
  synced_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

ALTER TABLE pull_request_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON pull_request_snapshot
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON pull_request_snapshot
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON pull_request_snapshot
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON pull_request_snapshot
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_snapshot_repository_number
  ON pull_request_snapshot(repository, pull_number);

CREATE INDEX IF NOT EXISTS idx_pull_request_snapshot_state_updated
  ON pull_request_snapshot(repository, state, github_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pull_request_snapshot_synced
  ON pull_request_snapshot(repository, synced_at DESC);

COMMENT ON TABLE pull_request_snapshot IS 'GitHub 合并请求及评论评审快照缓存';
COMMENT ON COLUMN pull_request_snapshot.comments_json IS 'GitHub issue comments JSON';
COMMENT ON COLUMN pull_request_snapshot.reviews_json IS 'GitHub pull request reviews JSON';
COMMENT ON COLUMN pull_request_snapshot.review_threads_json IS 'GitHub review threads JSON';
COMMENT ON COLUMN pull_request_snapshot.checks_json IS 'GitHub status checks JSON';

CREATE TABLE IF NOT EXISTS pull_request_reviewer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  pull_number integer NOT NULL,
  reviewer_user_id varchar(255) NOT NULL,
  reviewer_employee_id varchar(255) NOT NULL DEFAULT '',
  reviewer user_profile NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  assigned_by_name varchar(255) NOT NULL DEFAULT '',
  notified_at TIMESTAMP(3) WITH TIME ZONE,
  notification_attempts integer NOT NULL DEFAULT 0,
  notification_error text,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

ALTER TABLE pull_request_reviewer ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON pull_request_reviewer
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON pull_request_reviewer
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON pull_request_reviewer
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON pull_request_reviewer
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_user
  ON pull_request_reviewer(repository, pull_number, reviewer_user_id);

CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_pull
  ON pull_request_reviewer(repository, pull_number, _created_at);

COMMENT ON TABLE pull_request_reviewer IS '需求平台内合并请求评审人，不同步到 GitHub';

COMMIT;
