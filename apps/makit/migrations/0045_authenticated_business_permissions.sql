BEGIN;

-- All signed-in members may collaborate. Keep anonymous denial, exact app role,
-- actor binding, credential revocation and fresh MCP identity verification.
-- Archive lease/confirmation and PR operation fencing remain unchanged.
DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.requirement_archive_caller_has_any_role(p_allowed_roles text[])
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE AS $body$
    DECLARE caller_role text := current_setting('role', TRUE);
      actor text := NULLIF(BTRIM(current_setting('app.user_id', TRUE)), '');
    BEGIN
      IF caller_role = %L THEN RETURN true; END IF;
      RETURN caller_role = %L AND actor IS NOT NULL AND actor <> 'anonymous_user_id';
    END;
    $body$;
  $ddl$, s, 'service_role_' || s, 'authenticated_' || s);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.pull_request_reviewer_actor_authorized(
      p_actor_user_id text, p_credential_id uuid, p_token_version integer,
      p_subject_hash varchar, p_require_write boolean DEFAULT false
    ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE AS $body$
    DECLARE caller_role text := current_setting('role', TRUE);
      actor text := NULLIF(BTRIM(current_setting('app.user_id', TRUE)), '');
    BEGIN
      IF caller_role = %L THEN RETURN true; END IF;
      IF caller_role = %L THEN
        RETURN actor IS NOT NULL AND actor <> 'anonymous_user_id'
          AND actor = NULLIF(BTRIM(p_actor_user_id), '');
      END IF;
      IF caller_role = %L AND NULLIF(BTRIM(p_actor_user_id), '') IS NOT NULL
        AND p_actor_user_id <> 'anonymous_user_id'
        AND p_credential_id IS NOT NULL AND p_token_version IS NOT NULL
        AND mcp_personal_credential_verify(p_credential_id, p_token_version, p_subject_hash)
      THEN
        RETURN EXISTS (
          SELECT 1 FROM mcp_personal_credential AS credential
          WHERE credential.id = p_credential_id AND credential.token_version = p_token_version
            AND credential.subject_hash = p_subject_hash AND credential.revoked_at IS NULL
            AND ((credential._created_by).user_id)::text = p_actor_user_id
            AND (NOT COALESCE(p_require_write, false) OR
              credential.reviewer_roles_verified_at >= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
        );
      END IF;
      RETURN false;
    END;
    $body$;
  $ddl$, s, 'service_role_' || s, 'authenticated_' || s, 'anon_' || s);

  EXECUTE format('ALTER FUNCTION %I.requirement_archive_caller_has_any_role(text[]) SET search_path = pg_catalog, %I, pg_temp', s, s);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_actor_authorized(text, uuid, integer, varchar, boolean) SET search_path = pg_catalog, %I, pg_temp', s, s);
END;
$migration$;
COMMIT;
