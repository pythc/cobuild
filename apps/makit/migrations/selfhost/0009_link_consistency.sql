CREATE FUNCTION makit_sync_reverse_links() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
DECLARE definition jsonb; previous_ids text[]; current_ids text[]; target_id text;
  source_id text; source_collection text; target_collection text; reverse_name text;
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  source_id:=COALESCE(NEW.record_id,OLD.record_id);
  source_collection:=COALESCE(NEW.collection_id,OLD.collection_id);
  FOR definition IN SELECT jsonb_array_elements(fields) FROM makit_collection WHERE id=source_collection LOOP
    IF definition->>'type'<>'21' OR NULLIF(definition->'property'->>'back_field_name','') IS NULL THEN CONTINUE; END IF;
    target_collection:=definition->'property'->>'table_id'; reverse_name:=definition->'property'->>'back_field_name';
    previous_ids:=CASE WHEN TG_OP='INSERT' THEN ARRAY[]::text[] ELSE makit_cell_values(OLD.fields->(definition->>'name')) END;
    current_ids:=CASE WHEN TG_OP='DELETE' THEN ARRAY[]::text[] ELSE makit_cell_values(NEW.fields->(definition->>'name')) END;
    FOR target_id IN SELECT DISTINCT unnest(previous_ids||current_ids) LOOP
      IF (target_id=ANY(previous_ids))=(target_id=ANY(current_ids)) THEN CONTINUE; END IF;
      UPDATE makit_record SET fields=jsonb_set(fields,ARRAY[reverse_name],
        to_jsonb(ARRAY(SELECT DISTINCT item FROM unnest(makit_cell_values(fields->reverse_name)) item WHERE item<>source_id)
          || CASE WHEN target_id=ANY(current_ids) THEN ARRAY[source_id] ELSE ARRAY[]::text[] END),true),
        version=version+1,updated_at=clock_timestamp()
        WHERE collection_id=target_collection AND record_id=target_id;
      IF NOT FOUND AND target_id=ANY(current_ids) THEN RAISE foreign_key_violation USING MESSAGE='Linked record does not exist'; END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION makit_sync_reverse_links() FROM PUBLIC;
CREATE TRIGGER makit_record_reverse_links AFTER INSERT OR UPDATE OF fields OR DELETE ON makit_record
FOR EACH ROW EXECUTE FUNCTION makit_sync_reverse_links();
