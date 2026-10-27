CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('CANDIDATE', 'ADMIN')),
  name TEXT NOT NULL,
  student_no TEXT UNIQUE,
  college TEXT,
  major TEXT,
  phone TEXT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  accepted_policy_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS email_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'RESET')),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_challenges_lookup_idx
  ON email_challenges (email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL,
  PRIMARY KEY (bucket, subject, window_start)
);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES rounds (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  opens_at TIMESTAMPTZ NOT NULL,
  start_closes_at TIMESTAMPTZ NOT NULL,
  duration_hours INT NOT NULL DEFAULT 24 CHECK (duration_hours = 24),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, name),
  CHECK (start_closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stored_name TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 20971520),
  sha256 TEXT NOT NULL,
  uploaded_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches (id),
  direction TEXT NOT NULL CHECK (direction IN ('PRODUCT', 'DEVELOPMENT_TEST')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_pool_idx ON questions (batch_id, direction, published);

CREATE TABLE IF NOT EXISTS question_attachments (
  question_id UUID NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments (id),
  position INT NOT NULL,
  PRIMARY KEY (question_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS question_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES questions (id),
  version_no INT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  attachment_ids UUID[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, version_no)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  round_id UUID NOT NULL REFERENCES rounds (id),
  batch_id UUID NOT NULL REFERENCES batches (id),
  direction TEXT NOT NULL CHECK (direction IN ('PRODUCT', 'DEVELOPMENT_TEST')),
  consent_version TEXT CHECK (consent_version IS NULL OR consent_version = 'assessment-consent-v1'),
  consent_accepted_at TIMESTAMPTZ,
  mcp_connected BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  deadline TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  question_version_id UUID REFERENCES question_versions (id),
  repository_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, round_id),
  CHECK (started_at IS NOT NULL OR deadline IS NULL),
  CHECK (started_at IS NOT NULL OR finalized_at IS NULL),
  CHECK (started_at IS NOT NULL OR question_version_id IS NULL)
);
CREATE INDEX IF NOT EXISTS enrollments_batch_idx ON enrollments (batch_id);
CREATE INDEX IF NOT EXISTS enrollments_user_idx ON enrollments (user_id);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_tokens_enrollment_idx ON mcp_tokens (enrollment_id);

CREATE TABLE IF NOT EXISTS repository_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id),
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  preview_id UUID NOT NULL REFERENCES repository_previews (id),
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_one_current
  ON repositories (enrollment_id) WHERE superseded_at IS NULL;

ALTER TABLE enrollments
  DROP CONSTRAINT IF EXISTS enrollments_repository_id_fkey;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_repository_id_fkey
  FOREIGN KEY (repository_id) REFERENCES repositories (id);

CREATE TABLE IF NOT EXISTS material_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  manifest JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  repo_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'USED', 'SUPERSEDED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS material_approvals_enrollment_idx ON material_approvals (enrollment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  approval_id UUID NOT NULL UNIQUE REFERENCES material_approvals (id),
  sha256 TEXT NOT NULL,
  repo_sha TEXT NOT NULL,
  payload JSONB,
  client_count INT NOT NULL,
  file_count INT NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('export', 'partial', 'mixed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purged_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS materials_enrollment_idx ON materials (enrollment_id, received_at DESC);

CREATE TABLE IF NOT EXISTS finalize_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL UNIQUE REFERENCES enrollments (id),
  repository_id UUID NOT NULL REFERENCES repositories (id),
  materials_id UUID NOT NULL REFERENCES materials (id),
  sha TEXT NOT NULL,
  materials_hash TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  enrollment_id UUID PRIMARY KEY REFERENCES enrollments (id),
  score INT NOT NULL CHECK (score >= 0 AND score <= 100),
  feedback TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  enrollment_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);

CREATE TABLE IF NOT EXISTS email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
  ON email_outbox (next_attempt_at)
  WHERE status = 'PENDING';
