BEGIN;
-- Durable bridge metadata only. Native requirements remain in the existing Base.
CREATE TABLE IF NOT EXISTS relay_ticket_intake (
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_by user_profile,
  source_id varchar(120) NOT NULL,
  conversation_id varchar(128) NOT NULL,
  marker varchar(80) NOT NULL UNIQUE,
  payload_hash varchar(64) NOT NULL,
  payload_json text NOT NULL,
  actor_user_id varchar(128) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('preparing','writing','unknown','failed','linked')),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  requirement_id varchar(128) UNIQUE,
  error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_id, conversation_id),
  CHECK ((state = 'linked') = (requirement_id IS NOT NULL))
);
ALTER TABLE relay_ticket_intake ENABLE ROW LEVEL SECURITY;
-- Miaoda manages table privileges; policies keep raw payloads service-only.
DROP POLICY IF EXISTS relay_ticket_service ON relay_ticket_intake;
CREATE POLICY relay_ticket_service ON relay_ticket_intake TO service_role USING (true) WITH CHECK (true);
COMMIT;
