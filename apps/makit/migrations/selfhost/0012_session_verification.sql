ALTER TABLE makit_session ADD COLUMN last_verified_at timestamptz NOT NULL DEFAULT 'epoch';
