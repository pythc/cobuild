-- Dev-only, one statement: assertions run in one database context.
-- The inner exception block rolls back every synthetic write and role change.
DO $qa$
DECLARE affected integer;
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated_workspace_aadknhjojzqdw';
    PERFORM set_config('app.user_id', '1859972341904474', true);
    PERFORM set_config('app.role_ids', 'admin', true);
    INSERT INTO iteration_configuration (iteration_id, draft_json) VALUES ('qa_iteration_config_20260907_not_real', '{}');
    SELECT count(*) INTO affected FROM iteration_configuration WHERE iteration_id = 'qa_iteration_config_20260907_not_real';
    IF affected <> 1 THEN RAISE EXCEPTION 'admin read failed'; END IF;
    UPDATE iteration_configuration SET revision = 2 WHERE iteration_id = 'qa_iteration_config_20260907_not_real' AND revision = 0;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'stale revision was accepted'; END IF;
    UPDATE iteration_configuration SET revision = 2 WHERE iteration_id = 'qa_iteration_config_20260907_not_real' AND revision = 1;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'valid revision update failed'; END IF;
    PERFORM set_config('app.role_ids', 'editor', true);
    SELECT count(*) INTO affected FROM iteration_configuration WHERE iteration_id = 'qa_iteration_config_20260907_not_real';
    IF affected <> 0 THEN RAISE EXCEPTION 'editor can read private configuration'; END IF;
    UPDATE iteration_configuration SET revision = 3 WHERE iteration_id = 'qa_iteration_config_20260907_not_real';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'editor can update configuration'; END IF;
    BEGIN
      INSERT INTO iteration_configuration (iteration_id, draft_json) VALUES ('qa_iteration_config_editor_20260907', '{}');
      RAISE EXCEPTION 'editor can insert configuration';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE 'SET LOCAL ROLE anon_workspace_aadknhjojzqdw';
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.role_ids', '', true);
    SELECT count(*) INTO affected FROM iteration_configuration WHERE iteration_id = 'qa_iteration_config_20260907_not_real';
    IF affected <> 0 THEN RAISE EXCEPTION 'anonymous can read configuration'; END IF;
    EXECUTE 'SET LOCAL ROLE service_role_workspace_aadknhjojzqdw';
    SELECT count(*) INTO affected FROM iteration_configuration WHERE iteration_id = 'qa_iteration_config_20260907_not_real' AND revision = 2;
    IF affected <> 1 THEN RAISE EXCEPTION 'worker cannot read published-rule storage'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'Z0001', MESSAGE = 'QA passed; rollback synthetic writes';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
END;
$qa$;
