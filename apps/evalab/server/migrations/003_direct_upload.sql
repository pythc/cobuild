ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS direct_upload_consent_at TIMESTAMPTZ;
ALTER TABLE materials ALTER COLUMN approval_id DROP NOT NULL;
CREATE TABLE material_uploads (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
 mcp_token_id UUID NOT NULL REFERENCES mcp_tokens(id),
 token_hash TEXT NOT NULL UNIQUE,
 repo_sha TEXT NOT NULL,
 metadata JSONB NOT NULL,
 manifest JSONB,
 status TEXT NOT NULL DEFAULT 'AWAITING_FILES' CHECK(status IN ('AWAITING_FILES','UPLOADING','RECEIVED','SUPERSEDED','EXPIRED')),
 total_bytes BIGINT NOT NULL DEFAULT 0 CHECK(total_bytes BETWEEN 0 AND 1073741824),
 material_id UUID REFERENCES materials(id),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX material_uploads_enrollment_idx ON material_uploads(enrollment_id,created_at DESC);
CREATE TABLE material_upload_files (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 upload_id UUID NOT NULL REFERENCES material_uploads(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 size_bytes BIGINT NOT NULL CHECK(size_bytes BETWEEN 1 AND 1073741824),
 received_bytes BIGINT NOT NULL DEFAULT 0 CHECK(received_bytes BETWEEN 0 AND size_bytes),
 deleted_at TIMESTAMPTZ,
 UNIQUE(upload_id,name)
);
CREATE INDEX material_upload_files_upload_idx ON material_upload_files(upload_id);
