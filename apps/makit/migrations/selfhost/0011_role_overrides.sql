-- Explicit operations-admin changes must survive the next organization refresh.
-- Application administrator/editor grants still follow their imported bindings.
CREATE TABLE makit_role_override (
  user_id text REFERENCES makit_user(id) ON DELETE CASCADE,
  role_id text CHECK(role_id='operations_viewer'),
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,role_id)
);
GRANT SELECT,INSERT,UPDATE ON makit_role_override TO makit_application;
