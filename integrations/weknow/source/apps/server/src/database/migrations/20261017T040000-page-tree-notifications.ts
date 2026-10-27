import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  // PostgreSQL delivers NOTIFY only after COMMIT, including changes made through
  // MCP, imports, Office APIs and background jobs. No page names/content or IDs
  // are broadcast: receivers must re-query under their own current permission.
  await sql`
    CREATE FUNCTION notify_page_tree_change() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND
        ROW(OLD.title, OLD.icon, OLD.parent_page_id, OLD.position, OLD.space_id,
            OLD.deleted_at, OLD.node_type, OLD.file_extension, OLD.is_base)
        IS NOT DISTINCT FROM
        ROW(NEW.title, NEW.icon, NEW.parent_page_id, NEW.position, NEW.space_id,
            NEW.deleted_at, NEW.node_type, NEW.file_extension, NEW.is_base)
      THEN RETURN NULL; END IF;
      IF TG_OP <> 'INSERT' THEN
        PERFORM pg_notify('weknow_page_tree', json_build_object('spaceId', OLD.space_id)::text);
      END IF;
      IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.space_id IS DISTINCT FROM NEW.space_id) THEN
        PERFORM pg_notify('weknow_page_tree', json_build_object('spaceId', NEW.space_id)::text);
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER pages_tree_notify AFTER INSERT OR DELETE OR UPDATE OF
      title, icon, parent_page_id, position, space_id, deleted_at, node_type, file_extension, is_base
    ON pages FOR EACH ROW EXECUTE FUNCTION notify_page_tree_change()
  `.execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`DROP TRIGGER IF EXISTS pages_tree_notify ON pages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_page_tree_change()`.execute(db);
}
