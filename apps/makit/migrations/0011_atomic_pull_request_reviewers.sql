BEGIN;

DROP FUNCTION IF EXISTS pull_request_reviewers_replace(
  text,
  integer,
  jsonb,
  text
);

DROP FUNCTION IF EXISTS pull_request_reviewers_replace(
  text,
  integer,
  jsonb,
  text,
  uuid,
  integer,
  varchar
);

CREATE OR REPLACE FUNCTION pull_request_reviewers_replace(
  p_repository text,
  p_pull_number integer,
  p_reviewers jsonb,
  p_assigned_by_name text,
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
      MESSAGE = 'pull_request_reviewers_replace is not available to this role';
  END IF;

  IF jsonb_typeof(p_reviewers) <> 'array' THEN
    RAISE EXCEPTION 'p_reviewers must be a JSON array';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pull_request_snapshot
    WHERE repository = p_repository
      AND pull_number = p_pull_number
  ) THEN
    RAISE EXCEPTION 'pull request not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_reviewers) AS reviewer
    GROUP BY reviewer->>'userId'
    HAVING COUNT(*) > 1 OR MIN(reviewer->>'userId') IS NULL
  ) THEN
    RAISE EXCEPTION 'reviewer userId must be non-empty and unique';
  END IF;

  DELETE FROM pull_request_reviewer AS current_reviewer
  WHERE current_reviewer.repository = p_repository
    AND current_reviewer.pull_number = p_pull_number
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_reviewers) AS desired_reviewer
      WHERE desired_reviewer->>'userId' = current_reviewer.reviewer_user_id
    );

  INSERT INTO pull_request_reviewer (
    repository,
    pull_number,
    reviewer,
    status,
    reviewer_user_id,
    assigned_by_name,
    reviewer_employee_id,
    reviewer_name,
    _created_by,
    _updated_by
  )
  SELECT
    p_repository,
    p_pull_number,
    NULL::user_profile,
    'pending',
    reviewer->>'userId',
    COALESCE(NULLIF(p_assigned_by_name, ''), '当前用户'),
    reviewer->>'employeeId',
    reviewer->>'name',
    NULL::user_profile,
    NULL::user_profile
  FROM jsonb_array_elements(p_reviewers) AS reviewer
  ON CONFLICT (repository, pull_number, reviewer_user_id)
  DO UPDATE SET
    reviewer_employee_id = EXCLUDED.reviewer_employee_id,
    reviewer_name = EXCLUDED.reviewer_name,
    _updated_at = CURRENT_TIMESTAMP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'reviewerCount', jsonb_array_length(p_reviewers)
  );
END;
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.pull_request_reviewers_replace(text, integer, jsonb, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
END;
$$;

COMMENT ON FUNCTION pull_request_reviewers_replace(
  text,
  integer,
  jsonb,
  text,
  uuid,
  integer,
  varchar
)
  IS '原子替换平台内合并请求评审人，供登录页面和个人 MCP 共用';

COMMIT;
