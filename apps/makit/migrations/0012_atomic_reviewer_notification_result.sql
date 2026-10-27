BEGIN;

DROP FUNCTION IF EXISTS pull_request_reviewer_notification_result(
  uuid,
  boolean,
  text,
  uuid,
  integer,
  varchar
);

CREATE FUNCTION pull_request_reviewer_notification_result(
  p_assignment_id uuid,
  p_success boolean,
  p_error_message text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  affected_count integer := 0;
BEGIN
  IF caller_role ~ '^(authenticated|service_role)(_|$)' THEN
    NULL;
  ELSIF caller_role ~ '^anon(_|$)'
    AND p_credential_id IS NOT NULL
    AND p_token_version IS NOT NULL
    AND mcp_personal_credential_verify(
      p_credential_id,
      p_token_version,
      p_subject_hash
    )
  THEN
    NULL;
  ELSE
    RAISE insufficient_privilege USING
      MESSAGE = 'pull_request_reviewer_notification_result is not available to this role';
  END IF;

  UPDATE pull_request_reviewer
  SET notified_at = CASE WHEN p_success THEN CURRENT_TIMESTAMP ELSE notified_at END,
      notification_attempts = notification_attempts + 1,
      notification_error = CASE
        WHEN p_success THEN NULL
        ELSE LEFT(COALESCE(p_error_message, ''), 2000)
      END,
      _updated_at = CURRENT_TIMESTAMP
  WHERE id = p_assignment_id
    AND notified_at IS NULL;

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', TRUE,
    'affectedCount', affected_count
  );
END;
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.pull_request_reviewer_notification_result(uuid, boolean, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
END;
$$;

COMMENT ON FUNCTION pull_request_reviewer_notification_result(
  uuid,
  boolean,
  text,
  uuid,
  integer,
  varchar
)
  IS '原子记录合并请求评审人通知结果，仅支持登录页面、系统任务和已验证个人 MCP';

COMMIT;
