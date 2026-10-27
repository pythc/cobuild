CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  browser_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  resource TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE REFERENCES oauth_requests(id),
  enrollment_id UUID NOT NULL REFERENCES enrollments(id),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '2 minutes'),
  used_at TIMESTAMPTZ
);
CREATE TABLE oauth_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  mcp_token_id UUID NOT NULL UNIQUE REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);
CREATE INDEX oauth_access_grant_idx ON oauth_access_tokens(grant_id);
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id);
