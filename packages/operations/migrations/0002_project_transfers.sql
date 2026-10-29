CREATE TABLE IF NOT EXISTS collaboration_project_transfers_v1 (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner_subject TEXT NOT NULL,
  initiator_subject TEXT NOT NULL,
  recipient_subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','cancelled','invalidated')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS collaboration_project_transfers_pending_idx
  ON collaboration_project_transfers_v1(project_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS collaboration_project_transfers_recipient_idx
  ON collaboration_project_transfers_v1(recipient_subject,state);
