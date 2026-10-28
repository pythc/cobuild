CREATE TABLE IF NOT EXISTS collaboration_operations_v1(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, subject TEXT NOT NULL,
      request_id TEXT NOT NULL, action TEXT NOT NULL, resource_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(organization_id,subject,request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_events_v1(
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES collaboration_operations_v1(id),
      envelope_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_deliveries_v1(
      event_id TEXT NOT NULL REFERENCES collaboration_events_v1(id),
      consumer TEXT NOT NULL, projection_key TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','blocked','succeeded')),
      receipt_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(event_id,consumer)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS collaboration_projection_v1
      ON collaboration_deliveries_v1(consumer,projection_key,generation);
