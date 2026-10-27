-- Optional first-party public-account bridge. No examination data is exposed.
CREATE TABLE public_identity_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX public_identity_codes_expiry ON public_identity_codes(expires_at);
CREATE TABLE public_identity_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX public_identity_tokens_expiry ON public_identity_tokens(expires_at);
