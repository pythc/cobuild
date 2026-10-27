CREATE TABLE makit_file (
  id uuid PRIMARY KEY,
  source_bucket text,
  source_path text,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL CHECK (storage_key ~ '^[a-f0-9]{64}$'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_bucket, source_path)
);
GRANT SELECT, INSERT ON makit_file TO makit_application;
GRANT ALL ON makit_file TO service_role;
GRANT SELECT ON makit_schema_migration TO makit_application;
