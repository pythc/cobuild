-- Registration proof-of-work, mail budgets, and candidate start review.
-- Network/browser identifiers are hashed; proof email binding expires with the challenge.
-- No raw IP, browser token, or ALTCHA solution is stored.

ALTER TABLE email_challenges
  ADD COLUMN IF NOT EXISTS registration_proof_id UUID;

CREATE TABLE IF NOT EXISTS registration_challenges (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  challenge_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  verify_attempts INT NOT NULL DEFAULT 0 CHECK (verify_attempts >= 0 AND verify_attempts <= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_challenges_email_idx
  ON registration_challenges (email, created_at DESC);

CREATE INDEX IF NOT EXISTS registration_challenges_expiry_idx
  ON registration_challenges (expires_at);

CREATE TABLE IF NOT EXISTS registration_buckets (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  tokens DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bucket, subject)
);

CREATE TABLE IF NOT EXISTS user_registration_risk (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  risk_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_state TEXT NOT NULL CHECK (review_state IN ('PENDING', 'CLEARED')),
  start_restricted BOOLEAN NOT NULL DEFAULT false,
  restriction_reason TEXT,
  restricted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(risk_reasons) = 'array'),
  CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  CHECK (char_length(browser_hash) BETWEEN 32 AND 128),
  CHECK (restriction_reason IS NULL OR char_length(restriction_reason) BETWEEN 1 AND 500),
  CHECK (start_restricted = false OR restriction_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS user_registration_risk_browser_idx
  ON user_registration_risk (browser_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS user_registration_risk_ip_idx
  ON user_registration_risk (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS email_outbox_registration_created_idx
  ON email_outbox (created_at DESC) WHERE idempotency_key LIKE 'register-code:%';
CREATE INDEX IF NOT EXISTS email_outbox_registration_recipient_idx
  ON email_outbox (to_email, created_at DESC) WHERE idempotency_key LIKE 'register-code:%';
