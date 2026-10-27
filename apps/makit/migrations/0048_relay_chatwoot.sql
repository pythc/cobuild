BEGIN;
CREATE TABLE IF NOT EXISTS relay_chatwoot_contact (
 _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 _created_by user_profile, _updated_by user_profile,
 principal varchar(64) NOT NULL, app varchar(64) NOT NULL,
 source_id varchar(200) NOT NULL, contact_id bigint NOT NULL,
 PRIMARY KEY(principal,app)
);
CREATE TABLE IF NOT EXISTS relay_chatwoot_conversation (
 _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 _created_by user_profile, _updated_by user_profile,
 id varchar(128) PRIMARY KEY, principal varchar(64) NOT NULL, app varchar(64) NOT NULL,
 remote_id bigint NOT NULL, source_id varchar(200) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(app,remote_id)
);
CREATE INDEX IF NOT EXISTS relay_chatwoot_conversation_principal ON relay_chatwoot_conversation(principal,app);
CREATE TABLE IF NOT EXISTS relay_chatwoot_operation (
 _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 _created_by user_profile, _updated_by user_profile,
 marker varchar(64) PRIMARY KEY, payload_hash varchar(64) NOT NULL,
 state varchar(16) NOT NULL CHECK(state IN ('preparing','writing','unknown','failed','done')),
 lease_token uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
 response_json text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE relay_chatwoot_contact ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS relay_chatwoot_service ON relay_chatwoot_contact;
CREATE POLICY relay_chatwoot_service ON relay_chatwoot_contact TO service_role USING(true) WITH CHECK(true);
ALTER TABLE relay_chatwoot_conversation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS relay_chatwoot_service ON relay_chatwoot_conversation;
CREATE POLICY relay_chatwoot_service ON relay_chatwoot_conversation TO service_role USING(true) WITH CHECK(true);
ALTER TABLE relay_chatwoot_operation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS relay_chatwoot_service ON relay_chatwoot_operation;
CREATE POLICY relay_chatwoot_service ON relay_chatwoot_operation TO service_role USING(true) WITH CHECK(true);
COMMIT;
