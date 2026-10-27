import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await sql`CREATE TABLE writing_activity (
    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bucket timestamptz NOT NULL, chars_delta bigint NOT NULL DEFAULT 0,
    edited boolean NOT NULL DEFAULT false, created boolean NOT NULL DEFAULT false
  )`.execute(db);
  await sql`CREATE INDEX writing_activity_week ON writing_activity(workspace_id, bucket)`.execute(
    db,
  );
  await sql`CREATE TABLE writing_statistics_metadata (id boolean PRIMARY KEY DEFAULT true CHECK(id), started_at timestamptz NOT NULL DEFAULT now())`.execute(
    db,
  );
  await sql`INSERT INTO writing_statistics_metadata DEFAULT VALUES`.execute(db);
  await sql`CREATE FUNCTION record_page_writing() RETURNS trigger AS $$
  DECLARE actor uuid; is_creation boolean; BEGIN
    IF NEW.node_type <> 'page' OR NEW.deleted_at IS NOT NULL OR NOT EXISTS
      (SELECT 1 FROM spaces WHERE id=NEW.space_id AND is_personal=false AND deleted_at IS NULL)
    THEN RETURN NULL; END IF;
    is_creation := TG_OP='INSERT';
    IF NOT is_creation AND ROW(OLD.title,OLD.icon) IS NOT DISTINCT FROM ROW(NEW.title,NEW.icon) THEN RETURN NULL; END IF;
    actor := CASE WHEN is_creation THEN NEW.creator_id ELSE NEW.last_updated_by_id END;
    IF actor IS NULL THEN RETURN NULL; END IF;
    INSERT INTO writing_activity (id,workspace_id,page_id,user_id,bucket,chars_delta,edited,created)
    VALUES (gen_random_uuid(),NEW.workspace_id,NEW.id,actor,date_bin('5 minutes',now(),'2000-01-01'::timestamptz),
      CASE WHEN is_creation THEN char_length(regexp_replace(coalesce(NEW.text_content,''),'[' || chr(9) || '-' || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']' ,'','g')) ELSE 0 END,
      NOT is_creation,is_creation);
    RETURN NULL;
  END; $$ LANGUAGE plpgsql`.execute(db);
  await sql`CREATE TRIGGER pages_writing_activity AFTER INSERT OR UPDATE OF title,icon ON pages
    FOR EACH ROW EXECUTE FUNCTION record_page_writing()`.execute(db);
}
export async function down(db: Kysely<any>) {
  await sql`DROP TRIGGER IF EXISTS pages_writing_activity ON pages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS record_page_writing()`.execute(db);
  await sql`DROP TABLE IF EXISTS writing_activity`.execute(db);
  await sql`DROP TABLE IF EXISTS writing_statistics_metadata`.execute(db);
}
