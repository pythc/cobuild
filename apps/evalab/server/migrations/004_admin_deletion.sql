-- Additive queue of material file UUIDs. No foreign key to rows deletion removes.
CREATE TABLE IF NOT EXISTS deleted_material_files (
  file_id UUID PRIMARY KEY,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS deleted_material_files_pending_idx
  ON deleted_material_files (next_attempt_at)
  WHERE deleted_at IS NULL;
