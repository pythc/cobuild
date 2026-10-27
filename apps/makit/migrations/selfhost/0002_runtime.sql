REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role_public') THEN CREATE ROLE service_role_public NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated_public') THEN CREATE ROLE authenticated_public NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon_public') THEN CREATE ROLE anon_public NOLOGIN; END IF;
END $roles$;
GRANT service_role TO service_role_public;
GRANT authenticated TO authenticated_public;
GRANT anon TO anon_public;
CREATE TYPE user_profile AS (user_id text);
CREATE TYPE file_attachment AS (bucket_id text, file_path text);
