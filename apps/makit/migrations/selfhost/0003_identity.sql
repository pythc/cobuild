-- Historical bot/deleted-account audit cells may have no employee_id. Keep
-- them separately; never promote an unverifiable principal to a login user.
CREATE TABLE makit_audit_principal (
  open_id text PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE makit_user (
  id text PRIMARY KEY CHECK (id ~ '^[0-9]{1,30}$'),
  subject text NOT NULL UNIQUE,
  employee_id text NOT NULL REFERENCES makit_directory(employee_id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE makit_user_role (
  user_id text NOT NULL REFERENCES makit_user(id),
  role_id text NOT NULL CHECK (role_id IN ('admin','editor','viewer','operations_super_admin','operations_viewer')),
  PRIMARY KEY(user_id, role_id)
);
CREATE TABLE makit_session (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES makit_user(id),
  identity_token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE makit_auth_flow (
  token_hash text PRIMARY KEY,
  state text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  return_path text NOT NULL
);
