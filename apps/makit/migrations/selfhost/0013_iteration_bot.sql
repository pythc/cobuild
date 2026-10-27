INSERT INTO makit_audit_principal(open_id,name) VALUES ('app_makit_iteration_bot','周催办') ON CONFLICT DO NOTHING;
CREATE TABLE makit_bot_request (
  id uuid PRIMARY KEY,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  collection text NOT NULL CHECK(collection IN ('requirements','iterations','bindings','operations','collaboration')),
  record_id text NOT NULL,
  operation text NOT NULL CHECK(operation IN ('upsert','delete')),
  state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','completed','unknown')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON makit_bot_request TO makit_application;
