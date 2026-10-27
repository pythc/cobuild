BEGIN;

CREATE TABLE IF NOT EXISTS requirement_artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id varchar(255) NOT NULL,
  kind varchar(64) NOT NULL,
  source_type varchar(32) NOT NULL,
  content text NOT NULL DEFAULT '',
  document_url text NOT NULL DEFAULT '',
  document_title varchar(500) NOT NULL DEFAULT '',
  source_snapshot text NOT NULL DEFAULT '',
  source_hash varchar(64) NOT NULL DEFAULT '',
  readable boolean NOT NULL DEFAULT true,
  error_message text NOT NULL DEFAULT '',
  updated_by_name varchar(255) NOT NULL DEFAULT '',
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END
  ),
  CONSTRAINT requirement_artifact_kind_check
    CHECK (kind IN ('technical_design', 'self_test_report')),
  CONSTRAINT requirement_artifact_source_type_check
    CHECK (source_type IN ('inline', 'feishu_doc')),
  CONSTRAINT requirement_artifact_source_check CHECK (
    (source_type = 'inline' AND btrim(content) <> '' AND document_url = '') OR
    (source_type = 'feishu_doc' AND content = '' AND btrim(document_url) <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_requirement_artifact_kind
  ON requirement_artifact(requirement_id, kind);
CREATE INDEX IF NOT EXISTS idx_requirement_artifact_requirement
  ON requirement_artifact(requirement_id, _updated_at DESC);

CREATE TABLE IF NOT EXISTS requirement_ai_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id varchar(255) NOT NULL,
  review_type varchar(64) NOT NULL,
  source_kind varchar(64) NOT NULL,
  source_hash varchar(64) NOT NULL,
  source_snapshot text NOT NULL,
  dedupe_key varchar(160) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  verdict varchar(32),
  score integer,
  summary text NOT NULL DEFAULT '',
  dimensions_json text NOT NULL DEFAULT '[]',
  findings_json text NOT NULL DEFAULT '[]',
  model varchar(100) NOT NULL DEFAULT 'deepseek-v4-flash',
  rule_set_version varchar(64) NOT NULL DEFAULT '2026-08-30-v1',
  attempts integer NOT NULL DEFAULT 0,
  available_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lock_token varchar(255),
  lock_expires_at TIMESTAMP(3) WITH TIME ZONE,
  started_at TIMESTAMP(3) WITH TIME ZONE,
  finished_at TIMESTAMP(3) WITH TIME ZONE,
  error_message text NOT NULL DEFAULT '',
  overridden_at TIMESTAMP(3) WITH TIME ZONE,
  overridden_by_name varchar(255) NOT NULL DEFAULT '',
  override_reason text NOT NULL DEFAULT '',
  created_by_name varchar(255) NOT NULL DEFAULT '',
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile END
  ),
  CONSTRAINT requirement_ai_review_type_check CHECK (
    review_type IN ('clarity', 'technical_stability', 'delivery_readiness')
  ),
  CONSTRAINT requirement_ai_review_source_kind_check CHECK (
    source_kind IN ('requirement_detail', 'technical_design', 'self_test_report')
  ),
  CONSTRAINT requirement_ai_review_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
  ),
  CONSTRAINT requirement_ai_review_verdict_check CHECK (
    verdict IS NULL OR verdict IN ('passed', 'needs_attention', 'blocked')
  ),
  CONSTRAINT requirement_ai_review_score_check CHECK (
    score IS NULL OR (score >= 0 AND score <= 100)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_requirement_ai_review_dedupe
  ON requirement_ai_review(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_requirement_ai_review_requirement
  ON requirement_ai_review(requirement_id, review_type, _created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_ai_review_pending
  ON requirement_ai_review(available_at, _created_at)
  WHERE status IN ('queued', 'running');

ALTER TABLE requirement_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_ai_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON requirement_artifact
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_bypass_policy ON requirement_ai_review
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "研发资料登录用户可读写" ON requirement_artifact
  AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "研发资料匿名用户只读" ON requirement_artifact
  AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "AI评审登录用户可读写" ON requirement_ai_review
  AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "AI评审匿名用户只读" ON requirement_ai_review
  AS PERMISSIVE FOR SELECT TO anon USING (true);

COMMIT;
