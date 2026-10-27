-- Run with the migration owner. Application credentials must not own tables.
CREATE TABLE makit_collection (
  id text PRIMARY KEY,
  kind text NOT NULL UNIQUE,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0)
);

CREATE TABLE makit_record (
  collection_id text NOT NULL REFERENCES makit_collection(id),
  record_id text NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (collection_id, record_id)
);
CREATE INDEX makit_record_fields ON makit_record USING gin (fields jsonb_path_ops);
CREATE INDEX makit_record_order ON makit_record (collection_id, ordinal);

CREATE TABLE makit_directory (
  employee_id text PRIMARY KEY,
  open_id text NOT NULL UNIQUE,
  union_id text UNIQUE,
  name text NOT NULL,
  avatar_url text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION makit_cell_values(cell jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public
AS $fn$
  SELECT CASE jsonb_typeof(cell)
    WHEN 'array' THEN COALESCE((
      SELECT array_agg(DISTINCT item) FROM jsonb_array_elements(cell) AS element,
        unnest(makit_cell_values(element)) AS item
    ), ARRAY[]::text[])
    WHEN 'object' THEN makit_cell_values(COALESCE(
      cell->'link_record_ids', cell->'record_ids', cell->'record_id',
      cell->'id', cell->'text', cell->'name', cell->'value'
    ))
    WHEN 'null' THEN ARRAY[]::text[]
    ELSE CASE WHEN cell IS NULL OR cell #>> '{}' = '' THEN ARRAY[]::text[]
      ELSE ARRAY[cell #>> '{}'] END
  END
$fn$;

CREATE TABLE makit_migration_import (
  source_id text PRIMARY KEY,
  manifest_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  counts jsonb NOT NULL
);
