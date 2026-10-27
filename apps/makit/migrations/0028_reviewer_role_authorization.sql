BEGIN;

-- Repair environments that already received the first 0021 draft. Fresh
-- environments get the same final schema directly from 0021.
ALTER TABLE mcp_personal_credential
  ADD COLUMN IF NOT EXISTS reviewer_role_ids text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_role_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewer_roles_verified_at
    TIMESTAMP(3) WITH TIME ZONE;

COMMENT ON COLUMN mcp_personal_credential.reviewer_role_ids IS
  '最近一次从平台实时校验的需求平台角色，仅供短时 MCP 写权限证明';
COMMENT ON COLUMN mcp_personal_credential.reviewer_role_version IS
  'MCP 实时角色快照版本，每次成功同步递增';
COMMENT ON COLUMN mcp_personal_credential.reviewer_roles_verified_at IS
  'MCP 评审写权限角色快照的数据库校验时间';

CREATE OR REPLACE FUNCTION mcp_personal_credential_reviewer_roles_sync(
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar,
  p_actor_user_id text,
  p_role_ids jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  normalized_role_ids text;
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'MCP reviewer role synchronization is worker-only';
  END IF;
  IF NULLIF(BTRIM(p_actor_user_id), '') IS NULL
    OR p_credential_id IS NULL
    OR p_token_version IS NULL
    OR p_role_ids IS NULL
    OR jsonb_typeof(p_role_ids) <> 'array'
  THEN
    RAISE EXCEPTION 'invalid MCP reviewer role snapshot';
  END IF;
  IF jsonb_array_length(p_role_ids) > 3 OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_role_ids) AS platform_role(role_id)
    WHERE platform_role.role_id NOT IN ('admin', 'editor', 'viewer')
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_role_ids) AS platform_role(role_id)
    GROUP BY platform_role.role_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid MCP reviewer role snapshot';
  END IF;

  SELECT COALESCE(
    string_agg(platform_role.role_id, ',' ORDER BY platform_role.role_id),
    ''
  )
  INTO normalized_role_ids
  FROM jsonb_array_elements_text(p_role_ids) AS platform_role(role_id);

  UPDATE mcp_personal_credential AS credential
  SET reviewer_role_ids = normalized_role_ids,
    reviewer_role_version = credential.reviewer_role_version + 1,
    reviewer_roles_verified_at = clock_timestamp(),
    _updated_at = CURRENT_TIMESTAMP
  WHERE credential.id = p_credential_id
    AND credential.token_version = p_token_version
    AND credential.subject_hash = p_subject_hash
    AND credential.revoked_at IS NULL
    AND ((credential._created_by).user_id)::text = p_actor_user_id;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'MCP reviewer role synchronization credential is invalid';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_reviewer_actor_authorized(
  p_actor_user_id text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar,
  p_require_write boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  caller_role text := current_setting('role', TRUE);
  request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '');
BEGIN
  IF caller_role ~ '^service_role(_|$)' THEN
    RETURN true;
  END IF;
  IF caller_role ~ '^authenticated(_|$)' THEN
    RETURN request_user_id IS NOT NULL
      AND request_user_id = NULLIF(BTRIM(p_actor_user_id), '')
      AND (
        NOT COALESCE(p_require_write, false)
        OR EXISTS (
          SELECT 1
          FROM unnest(string_to_array(
            COALESCE(current_setting('app.role_ids', TRUE), ''), ','
          )) AS platform_role(role_id)
          WHERE BTRIM(platform_role.role_id) IN ('admin', 'editor')
        )
      );
  END IF;
  IF caller_role ~ '^anon(_|$)'
    AND NULLIF(BTRIM(p_actor_user_id), '') IS NOT NULL
    AND p_credential_id IS NOT NULL
    AND p_token_version IS NOT NULL
    AND mcp_personal_credential_verify(
      p_credential_id, p_token_version, p_subject_hash
    )
  THEN
    RETURN EXISTS (
      SELECT 1
      FROM mcp_personal_credential AS credential
      WHERE credential.id = p_credential_id
        AND credential.token_version = p_token_version
        AND credential.subject_hash = p_subject_hash
        AND credential.revoked_at IS NULL
        AND ((credential._created_by).user_id)::text = p_actor_user_id
        AND (
          NOT COALESCE(p_require_write, false)
          OR (
            credential.reviewer_roles_verified_at
              >= CURRENT_TIMESTAMP - INTERVAL '2 minutes'
            AND EXISTS (
              SELECT 1
              FROM unnest(string_to_array(
                credential.reviewer_role_ids, ','
              )) AS platform_role(role_id)
              WHERE BTRIM(platform_role.role_id) IN ('admin', 'editor')
            )
          )
        )
    );
  END IF;
  RETURN false;
END;
$$;

-- Install the permanent no-nonce public contract directly. Existing Pods may
-- still call the old signatures during a rolling release, so safe compatibility
-- overloads are retained below until the explicit post-deploy cleanup.
CREATE OR REPLACE FUNCTION github_reviewer_bindings_get(
  p_repository text,
  p_actor_user_id text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS TABLE (
  binding_id uuid,
  github_login varchar,
  reviewer_employee_id varchar,
  reviewer_name varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  IF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, false
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'github_reviewer_bindings_get is not available to this caller';
  END IF;
  RETURN QUERY
  SELECT binding.id, binding.github_login,
    binding.reviewer_employee_id, binding.reviewer_name
  FROM github_reviewer_binding AS binding
  WHERE binding.repository = p_repository
  ORDER BY LOWER(binding.github_login);
END;
$$;

CREATE OR REPLACE FUNCTION github_reviewer_bindings_upsert(
  p_repository text,
  p_bindings jsonb,
  p_actor_user_id text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, true
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'github_reviewer_bindings_upsert is not available to this caller';
  END IF;
  IF jsonb_typeof(p_bindings) <> 'array'
    OR jsonb_array_length(p_bindings) > 100
    OR NULLIF(BTRIM(p_repository), '') IS NULL
  THEN
    RAISE EXCEPTION 'invalid reviewer bindings';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_bindings) AS item(value)
    WHERE NULLIF(BTRIM(item.value->>'login'), '') IS NULL
      OR NULLIF(BTRIM(item.value->>'employeeId'), '') IS NULL
      OR NULLIF(BTRIM(item.value->>'name'), '') IS NULL
      OR LENGTH(BTRIM(item.value->>'login')) > 255
      OR LENGTH(BTRIM(item.value->>'employeeId')) > 255
      OR LENGTH(BTRIM(item.value->>'name')) > 128
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_bindings) AS item(value)
    GROUP BY LOWER(BTRIM(item.value->>'login'))
    HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_bindings) AS item(value)
    GROUP BY BTRIM(item.value->>'employeeId')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'reviewer bindings must be complete and unique';
  END IF;

  INSERT INTO github_reviewer_binding AS binding (
    repository, github_login, reviewer_employee_id, reviewer_name,
    _created_by, _updated_by
  )
  SELECT p_repository, LOWER(BTRIM(item.value->>'login')),
    BTRIM(item.value->>'employeeId'), BTRIM(item.value->>'name'),
    CASE WHEN NULLIF(BTRIM(p_actor_user_id), '') IS NULL THEN NULL
      ELSE concat('(', p_actor_user_id, ')')::user_profile END,
    CASE WHEN NULLIF(BTRIM(p_actor_user_id), '') IS NULL THEN NULL
      ELSE concat('(', p_actor_user_id, ')')::user_profile END
  FROM jsonb_array_elements(p_bindings) AS item(value)
  ON CONFLICT (repository, github_login) DO UPDATE SET
    reviewer_employee_id = EXCLUDED.reviewer_employee_id,
    reviewer_name = EXCLUDED.reviewer_name,
    _updated_at = CURRENT_TIMESTAMP,
    _updated_by = EXCLUDED._updated_by;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_reviewer_state_prepare(
  p_repository text,
  p_pull_number integer,
  p_before_logins jsonb,
  p_desired_logins jsonb,
  p_assigned_by_name text,
  p_policy jsonb,
  p_actor_user_id text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS TABLE(
  operation_token uuid,
  operation_generation integer,
  operation_reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  policy_mode text := COALESCE(p_policy->>'mode', 'disabled');
  allowed_user_ids jsonb := COALESCE(p_policy->'allowedUserIds', '[]'::jsonb);
  normalized_before jsonb;
  normalized_desired jsonb;
  current_operation pull_request_reviewer_operation%ROWTYPE;
  next_token uuid;
  next_generation integer;
  reuse_operation boolean := false;
BEGIN
  IF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, true
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'pull_request_reviewer_state_prepare is not available to this caller';
  END IF;
  IF p_policy IS NULL
    OR p_before_logins IS NULL
    OR p_desired_logins IS NULL
    OR jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_before_logins) <> 'array'
    OR jsonb_typeof(p_desired_logins) <> 'array'
    OR jsonb_typeof(allowed_user_ids) <> 'array'
    OR jsonb_array_length(p_before_logins) > 100
    OR jsonb_array_length(p_desired_logins) > 100
    OR jsonb_array_length(allowed_user_ids) > 500
    OR NULLIF(BTRIM(p_repository), '') IS NULL
    OR LENGTH(BTRIM(p_repository)) > 255
    OR p_pull_number IS NULL
    OR p_pull_number <= 0
    OR NULLIF(BTRIM(p_actor_user_id), '') IS NULL
    OR LENGTH(BTRIM(p_actor_user_id)) > 255
    OR LENGTH(COALESCE(p_assigned_by_name, '')) > 255
    OR policy_mode NOT IN ('disabled', 'test_only', 'live')
  THEN
    RAISE EXCEPTION 'invalid reviewer notification intent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_before_logins) AS item(value)
    WHERE NULLIF(BTRIM(item.value), '') IS NULL OR LENGTH(BTRIM(item.value)) > 255
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_desired_logins) AS item(value)
    WHERE NULLIF(BTRIM(item.value), '') IS NULL OR LENGTH(BTRIM(item.value)) > 255
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_before_logins) AS item(value)
    GROUP BY LOWER(BTRIM(item.value)) HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_desired_logins) AS item(value)
    GROUP BY LOWER(BTRIM(item.value)) HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(allowed_user_ids) AS item(value)
    WHERE NULLIF(BTRIM(item.value), '') IS NULL
      OR LENGTH(BTRIM(item.value)) > 255
  ) THEN
    RAISE EXCEPTION 'reviewer logins must be non-empty and unique';
  END IF;

  SELECT COALESCE(jsonb_agg(login ORDER BY login), '[]'::jsonb)
  INTO normalized_before
  FROM (
    SELECT LOWER(BTRIM(item.value)) AS login
    FROM jsonb_array_elements_text(p_before_logins) AS item(value)
  ) AS normalized;
  SELECT COALESCE(jsonb_agg(login ORDER BY login), '[]'::jsonb)
  INTO normalized_desired
  FROM (
    SELECT LOWER(BTRIM(item.value)) AS login
    FROM jsonb_array_elements_text(p_desired_logins) AS item(value)
  ) AS normalized;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_repository || ':' || p_pull_number::text, 0)
  );
  INSERT INTO pull_request_reviewer_operation (
    repository, pull_number, generation, desired_logins_json
  ) VALUES (p_repository, p_pull_number, 0, '[]')
  ON CONFLICT (repository, pull_number) DO NOTHING;
  SELECT * INTO current_operation
  FROM pull_request_reviewer_operation AS operation
  WHERE operation.repository = p_repository
    AND operation.pull_number = p_pull_number
  FOR UPDATE;

  IF current_operation.reconciliation_claim_token IS NOT NULL
    AND current_operation.reconciliation_claim_expires_at > CURRENT_TIMESTAMP
  THEN
    RAISE lock_not_available USING
      MESSAGE = 'reviewer notification reconciliation is still in progress';
  ELSIF current_operation.operation_token IS NOT NULL
    AND current_operation.actor_user_id = p_actor_user_id
    AND current_operation.desired_logins_json::jsonb = normalized_desired
  THEN
    -- An exact retry keeps the original generation, policy and recipient even
    -- after lease expiry. The lease is intentionally not renewed here: when
    -- GitHub still differs from the desired state, the caller must wait for
    -- authoritative reconciliation instead of repeating the mutation.
    next_token := current_operation.operation_token;
    next_generation := current_operation.generation;
    reuse_operation := true;
  ELSIF current_operation.operation_token IS NOT NULL
    AND current_operation.operation_expires_at > CURRENT_TIMESTAMP
  THEN
    RAISE lock_not_available USING
      MESSAGE = 'another reviewer mutation is still in progress';
  ELSIF current_operation.operation_token IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pull_request_reviewer_state AS state
      WHERE state.repository = p_repository
        AND state.pull_number = p_pull_number
        AND state.assignment_generation > state.notified_generation
        AND state.pending_policy_mode IS NOT NULL
    )
  THEN
    RAISE serialization_failure USING
      MESSAGE = 'expired reviewer mutation requires authoritative reconciliation';
  ELSE
    next_token := gen_random_uuid();
    next_generation := current_operation.generation + 1;
    UPDATE pull_request_reviewer_operation AS operation
    SET generation = next_generation,
      operation_token = next_token,
      operation_expires_at = CURRENT_TIMESTAMP + INTERVAL '10 minutes',
      actor_user_id = p_actor_user_id,
      desired_logins_json = normalized_desired::text,
      reconciliation_claim_token = NULL,
      reconciliation_claim_expires_at = NULL,
      _updated_at = CURRENT_TIMESTAMP
    WHERE operation.id = current_operation.id;
  END IF;

  -- Unknown existing reviewers become baseline state and never generate a
  -- historical event. Pending intent metadata is deliberately preserved.
  INSERT INTO pull_request_reviewer_state AS state (
    repository, pull_number, github_login, assignment_generation,
    notified_generation, active, assigned_by_name
  )
  SELECT p_repository, p_pull_number, item.value, 0, 0, true, ''
  FROM jsonb_array_elements_text(normalized_before) AS item(value)
  ON CONFLICT (repository, pull_number, github_login) DO UPDATE
  SET active = true, _updated_at = CURRENT_TIMESTAMP;

  UPDATE pull_request_reviewer_state AS state
  SET active = false, _updated_at = CURRENT_TIMESTAMP
  WHERE state.repository = p_repository
    AND state.pull_number = p_pull_number
    AND state.active = true
    AND NOT (normalized_before ? state.github_login);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(normalized_desired) AS desired(value)
    LEFT JOIN github_reviewer_binding AS binding
      ON binding.repository = p_repository
      AND LOWER(binding.github_login) = desired.value
    WHERE NOT (normalized_before ? desired.value) AND binding.id IS NULL
  ) THEN
    RAISE EXCEPTION 'new reviewer is missing a Feishu binding';
  END IF;

  IF NOT reuse_operation THEN
    -- Policy and recipient are frozen before the external GitHub mutation.
    INSERT INTO pull_request_reviewer_state AS state (
      repository, pull_number, github_login, assignment_generation,
      notified_generation, active, assigned_by_name, assigned_by_user_id,
      pending_policy_mode, pending_delivery_eligible,
      pending_suppression_reason, pending_reviewer_employee_id,
      pending_reviewer_name, pending_operation_generation
    )
    SELECT p_repository, p_pull_number, desired.value, next_generation, 0,
      false, COALESCE(NULLIF(BTRIM(p_assigned_by_name), ''), '当前用户'),
      p_actor_user_id, policy_mode,
      CASE WHEN policy_mode = 'live' THEN true
        WHEN policy_mode = 'test_only' AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(allowed_user_ids) AS allowed(value)
          WHERE allowed.value = binding.reviewer_employee_id
        ) THEN true ELSE false END,
      CASE WHEN policy_mode = 'live' THEN NULL
        WHEN policy_mode = 'test_only' AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(allowed_user_ids) AS allowed(value)
          WHERE allowed.value = binding.reviewer_employee_id
        ) THEN NULL
        WHEN policy_mode = 'test_only' THEN '目标不在评审私聊测试白名单'
        ELSE '评审私聊通知未启用' END,
      binding.reviewer_employee_id, binding.reviewer_name, next_generation
    FROM jsonb_array_elements_text(normalized_desired) AS desired(value)
    JOIN github_reviewer_binding AS binding
      ON binding.repository = p_repository
      AND LOWER(binding.github_login) = desired.value
    WHERE NOT (normalized_before ? desired.value)
    ON CONFLICT (repository, pull_number, github_login) DO UPDATE SET
      assignment_generation = EXCLUDED.assignment_generation,
      active = false,
      assigned_by_name = EXCLUDED.assigned_by_name,
      assigned_by_user_id = EXCLUDED.assigned_by_user_id,
      pending_policy_mode = EXCLUDED.pending_policy_mode,
      pending_delivery_eligible = EXCLUDED.pending_delivery_eligible,
      pending_suppression_reason = EXCLUDED.pending_suppression_reason,
      pending_reviewer_employee_id = EXCLUDED.pending_reviewer_employee_id,
      pending_reviewer_name = EXCLUDED.pending_reviewer_name,
      pending_operation_generation = EXCLUDED.pending_operation_generation,
      _updated_at = CURRENT_TIMESTAMP;
  END IF;

  RETURN QUERY SELECT next_token, next_generation, reuse_operation;
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_reviewer_state_finalize(
  p_repository text,
  p_pull_number integer,
  p_active_reviewers jsonb,
  p_operation_token uuid,
  p_reconciliation_claim_token uuid,
  p_reconciliation_generation integer,
  p_actor_user_id text,
  p_credential_id uuid,
  p_token_version integer,
  p_subject_hash varchar
)
RETURNS TABLE(assignment_id uuid, delivery_eligible boolean)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  normalized_active jsonb;
  current_operation pull_request_reviewer_operation%ROWTYPE;
  reconcile_generation integer;
  direct_finalize boolean := p_operation_token IS NOT NULL;
  reconciliation_finalize boolean := p_reconciliation_claim_token IS NOT NULL;
  snapshot_count integer := 0;
BEGIN
  IF reconciliation_finalize THEN
    IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
      RAISE insufficient_privilege USING
        MESSAGE = 'authoritative reviewer reconciliation is worker-only';
    END IF;
  ELSIF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, true
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'pull_request_reviewer_state_finalize is not available to this caller';
  END IF;
  IF p_active_reviewers IS NULL
    OR NULLIF(BTRIM(p_repository), '') IS NULL
    OR LENGTH(BTRIM(p_repository)) > 255
    OR p_pull_number IS NULL
    OR p_pull_number <= 0
    OR direct_finalize = reconciliation_finalize
    OR jsonb_typeof(p_active_reviewers) <> 'array'
    OR jsonb_array_length(p_active_reviewers) > 100
    OR OCTET_LENGTH(p_active_reviewers::text) > 500000
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_active_reviewers) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'object'
        OR NULLIF(BTRIM(item.value->>'login'), '') IS NULL
        OR LENGTH(BTRIM(item.value->>'login')) > 255
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_active_reviewers) AS item(value)
      GROUP BY LOWER(BTRIM(item.value->>'login'))
      HAVING COUNT(*) > 1
    )
  THEN
    RAISE EXCEPTION 'invalid authoritative reviewer state';
  END IF;
  SELECT COALESCE(jsonb_agg(login ORDER BY login), '[]'::jsonb)
  INTO normalized_active
  FROM (
    SELECT DISTINCT LOWER(BTRIM(item.value->>'login')) AS login
    FROM jsonb_array_elements(p_active_reviewers) AS item(value)
  ) AS normalized;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_repository || ':' || p_pull_number::text, 0)
  );
  SELECT * INTO current_operation
  FROM pull_request_reviewer_operation AS operation
  WHERE operation.repository = p_repository
    AND operation.pull_number = p_pull_number
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF direct_finalize THEN
    IF current_operation.operation_token IS DISTINCT FROM p_operation_token THEN
      IF current_operation.last_completed_operation_token = p_operation_token
        AND (
          current_setting('role', TRUE) ~ '^service_role(_|$)'
          OR current_operation.last_completed_actor_user_id = p_actor_user_id
        )
      THEN
        RETURN QUERY
        SELECT event.id, event.delivery_eligible
        FROM pull_request_reviewer_notification_event AS event
        WHERE event.repository = p_repository
          AND event.pull_number = p_pull_number
          AND event.assignment_generation = current_operation.generation
        ORDER BY event._created_at;
        RETURN;
      END IF;
      IF current_setting('role', TRUE) ~ '^service_role(_|$)'
        AND p_actor_user_id IS NULL
      THEN
        RETURN;
      END IF;
      RAISE serialization_failure USING
        MESSAGE = 'reviewer mutation lease is stale';
    END IF;
    IF current_setting('role', TRUE) !~ '^service_role(_|$)'
      AND current_operation.actor_user_id IS DISTINCT FROM p_actor_user_id
    THEN
      RAISE insufficient_privilege USING
        MESSAGE = 'reviewer mutation belongs to another actor';
    END IF;
  ELSIF current_operation.reconciliation_claim_token
      IS DISTINCT FROM p_reconciliation_claim_token
    OR current_operation.generation IS DISTINCT FROM p_reconciliation_generation
  THEN
    RAISE serialization_failure USING
      MESSAGE = 'reviewer reconciliation lease is stale';
  END IF;
  reconcile_generation := COALESCE(
    p_reconciliation_generation,
    current_operation.generation
  );

  -- The authoritative GitHub reviewer state and its notification outbox are
  -- committed while holding the same per-PR lease. A stale refresh or an
  -- expired reconciliation owner therefore cannot overwrite a newer change.
  UPDATE pull_request_snapshot
  SET requested_reviewers_json = p_active_reviewers::text,
    reviewers_updated_at = clock_timestamp(),
    _updated_at = CURRENT_TIMESTAMP
  WHERE repository = p_repository AND pull_number = p_pull_number;
  GET DIAGNOSTICS snapshot_count = ROW_COUNT;
  IF snapshot_count <> 1 THEN
    RAISE EXCEPTION 'pull request snapshot not found';
  END IF;

  UPDATE pull_request_reviewer_state AS state
  SET active = normalized_active ? state.github_login,
    _updated_at = CURRENT_TIMESTAMP
  WHERE state.repository = p_repository
    AND state.pull_number = p_pull_number;

  RETURN QUERY
  WITH pending AS (
    SELECT *
    FROM pull_request_reviewer_state AS state
    WHERE state.repository = p_repository
      AND state.pull_number = p_pull_number
      AND state.active = true
      AND state.assignment_generation > state.notified_generation
      AND state.pending_policy_mode IS NOT NULL
      AND COALESCE(
        state.pending_operation_generation,
        state.assignment_generation
      ) <= reconcile_generation
    FOR UPDATE
  ), inserted AS (
    INSERT INTO pull_request_reviewer_notification_event AS event (
      repository, pull_number, github_login, assignment_generation,
      reviewer_user_id, reviewer_employee_id, reviewer_name, assigned_by_name,
      assigned_by_user_id, delivery_policy_mode, delivery_eligible,
      suppression_reason, suppressed_at
    )
    SELECT repository, pull_number, github_login, assignment_generation,
      pending_reviewer_employee_id, pending_reviewer_employee_id,
      pending_reviewer_name, assigned_by_name, assigned_by_user_id,
      pending_policy_mode,
      COALESCE(pending_delivery_eligible, false), pending_suppression_reason,
      CASE WHEN COALESCE(pending_delivery_eligible, false)
        THEN NULL ELSE CURRENT_TIMESTAMP END
    FROM pending
    ON CONFLICT (
      repository, pull_number, github_login, assignment_generation
    ) DO NOTHING
    RETURNING event.id, event.repository, event.pull_number,
      event.github_login, event.assignment_generation,
      event.delivery_eligible
  ), marked AS (
    UPDATE pull_request_reviewer_state AS state
    SET notified_generation = state.assignment_generation,
      pending_policy_mode = NULL,
      pending_delivery_eligible = NULL,
      pending_suppression_reason = NULL,
      pending_reviewer_employee_id = NULL,
      pending_reviewer_name = NULL,
      pending_operation_generation = NULL,
      _updated_at = CURRENT_TIMESTAMP
    FROM inserted
    WHERE state.repository = inserted.repository
      AND state.pull_number = inserted.pull_number
      AND state.github_login = inserted.github_login
      AND state.assignment_generation = inserted.assignment_generation
    RETURNING inserted.id, inserted.delivery_eligible
  )
  SELECT marked.id, marked.delivery_eligible FROM marked;

  -- Absence in the authoritative GitHub response terminally cancels only
  -- intents covered by this operation generation. A later remove/re-add gets
  -- a new generation and a new append-only event.
  UPDATE pull_request_reviewer_state AS state
  SET notified_generation = state.assignment_generation,
    pending_policy_mode = NULL,
    pending_delivery_eligible = NULL,
    pending_suppression_reason = NULL,
    pending_reviewer_employee_id = NULL,
    pending_reviewer_name = NULL,
    pending_operation_generation = NULL,
    _updated_at = CURRENT_TIMESTAMP
  WHERE state.repository = p_repository
    AND state.pull_number = p_pull_number
    AND state.active = false
    AND state.assignment_generation > state.notified_generation
    AND COALESCE(
      state.pending_operation_generation,
      state.assignment_generation
    ) <= reconcile_generation;

  UPDATE pull_request_reviewer_operation AS operation
  SET last_completed_operation_token = COALESCE(
      operation.operation_token,
      operation.last_completed_operation_token
    ),
    last_completed_actor_user_id = COALESCE(
      operation.actor_user_id,
      operation.last_completed_actor_user_id
    ),
    operation_token = NULL,
    operation_expires_at = NULL,
    reconciliation_claim_token = NULL,
    reconciliation_claim_expires_at = NULL,
    actor_user_id = NULL,
    _updated_at = CURRENT_TIMESTAMP
  WHERE operation.id = current_operation.id
    AND (
      operation.operation_token = p_operation_token
      OR (
        p_reconciliation_claim_token IS NOT NULL
        AND operation.reconciliation_claim_token
          = p_reconciliation_claim_token
        AND operation.generation = p_reconciliation_generation
      )
    );
END;
$$;


-- Replace the audit readers as part of the repair so they depend only on the
-- permanent five-argument authorization helper before the legacy helper is
-- removed post-deploy.
CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_audit_stats(
  p_actor_user_id text
)
RETURNS TABLE (
  total integer,
  pending integer,
  retrying integer,
  failed integer,
  delivered integer,
  suppressed integer,
  reconciling integer
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  IF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, NULL, NULL, NULL, false
  ) OR (
    current_setting('role', TRUE) !~ '^service_role(_|$)'
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(string_to_array(
        COALESCE(current_setting('app.role_ids', TRUE), ''), ','
      )) AS platform_role(role_id)
      WHERE BTRIM(platform_role.role_id) = 'admin'
    )
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'reviewer notification audit is not available to this caller';
  END IF;
  RETURN QUERY
  SELECT COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE event.notified_at IS NULL
        AND event.suppressed_at IS NULL
        AND event.notification_attempts = 0
    )::integer,
    COUNT(*) FILTER (
      WHERE event.notified_at IS NULL
        AND event.suppressed_at IS NULL
        AND event.notification_attempts > 0
        AND event.notification_attempts < event.max_notification_attempts
    )::integer,
    COUNT(*) FILTER (
      WHERE event.notified_at IS NULL
        AND event.suppressed_at IS NULL
        AND event.notification_attempts >= event.max_notification_attempts
    )::integer,
    COUNT(*) FILTER (WHERE event.notified_at IS NOT NULL)::integer,
    COUNT(*) FILTER (
      WHERE event.notified_at IS NULL AND event.suppressed_at IS NOT NULL
    )::integer,
    (
      SELECT COUNT(*)::integer
      FROM pull_request_reviewer_state AS state
      WHERE state.assignment_generation > state.notified_generation
        AND state.pending_policy_mode IS NOT NULL
    )
  FROM pull_request_reviewer_notification_event AS event;
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_audit_list(
  p_status text,
  p_offset integer,
  p_limit integer,
  p_actor_user_id text
)
RETURNS TABLE (
  assignment_id uuid,
  repository varchar,
  pull_number integer,
  reviewer_name varchar,
  reviewer_employee_id varchar,
  github_login varchar,
  assigned_by_name varchar,
  assigned_by_user_id varchar,
  max_notification_attempts integer,
  notification_attempts integer,
  notification_error text,
  suppression_reason text,
  suppressed_at TIMESTAMP(3) WITH TIME ZONE,
  created_at TIMESTAMP(3) WITH TIME ZONE,
  updated_at TIMESTAMP(3) WITH TIME ZONE,
  notified_at TIMESTAMP(3) WITH TIME ZONE,
  pull_title text,
  pull_external_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  IF NOT pull_request_reviewer_actor_authorized(
    p_actor_user_id, NULL, NULL, NULL, false
  ) OR (
    current_setting('role', TRUE) !~ '^service_role(_|$)'
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(string_to_array(
        COALESCE(current_setting('app.role_ids', TRUE), ''), ','
      )) AS platform_role(role_id)
      WHERE BTRIM(platform_role.role_id) = 'admin'
    )
  ) THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'reviewer notification audit is not available to this caller';
  END IF;
  IF p_status IS NOT NULL
    AND p_status NOT IN (
      'pending', 'retrying', 'failed', 'delivered', 'suppressed'
    )
  THEN
    RAISE EXCEPTION 'unsupported notification status';
  END IF;
  RETURN QUERY
  SELECT event.id, event.repository, event.pull_number,
    event.reviewer_name, event.reviewer_employee_id, event.github_login,
    event.assigned_by_name, event.assigned_by_user_id,
    event.max_notification_attempts,
    event.notification_attempts,
    event.notification_error, event.suppression_reason, event.suppressed_at,
    event._created_at, event._updated_at, event.notified_at,
    snapshot.title, snapshot.url
  FROM pull_request_reviewer_notification_event AS event
  LEFT JOIN pull_request_snapshot AS snapshot
    ON snapshot.repository = event.repository
    AND snapshot.pull_number = event.pull_number
  WHERE p_status IS NULL
    OR (p_status = 'delivered' AND event.notified_at IS NOT NULL)
    OR (
      p_status = 'suppressed'
      AND event.notified_at IS NULL
      AND event.suppressed_at IS NOT NULL
    )
    OR (
      p_status = 'failed'
      AND event.notified_at IS NULL
      AND event.suppressed_at IS NULL
      AND event.notification_attempts >= event.max_notification_attempts
    )
    OR (
      p_status = 'retrying'
      AND event.notified_at IS NULL
      AND event.suppressed_at IS NULL
      AND event.notification_attempts > 0
      AND event.notification_attempts < event.max_notification_attempts
    )
    OR (
      p_status = 'pending'
      AND event.notified_at IS NULL
      AND event.suppressed_at IS NULL
      AND event.notification_attempts = 0
    )
  ORDER BY event._created_at DESC
  OFFSET GREATEST(p_offset, 0)
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
END;
$$;

-- Repair only environments that already have the old nonce-shaped signatures.
-- The legacy nonce argument is deliberately ignored: every compatibility call
-- delegates to the permanent public function, which performs the full identity
-- and role check inside the database.
DO $migration$
DECLARE
  schema_name text := current_schema();
  has_legacy_nonce_overloads boolean;
BEGIN
  has_legacy_nonce_overloads := to_regprocedure(format(
    '%I.pull_request_reviewer_state_prepare(text,integer,jsonb,jsonb,text,jsonb,text,uuid,integer,character varying,text)',
    schema_name
  )) IS NOT NULL;

  IF has_legacy_nonce_overloads THEN
    EXECUTE format($definition$
      CREATE OR REPLACE FUNCTION %I.pull_request_reviewer_actor_authorized(
        p_actor_user_id text,
        p_credential_id uuid,
        p_token_version integer,
        p_subject_hash varchar
      )
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      STABLE
      AS $function$
      BEGIN
        RETURN %I.pull_request_reviewer_actor_authorized(
          p_actor_user_id,
          p_credential_id,
          p_token_version,
          p_subject_hash,
          true
        );
      END;
      $function$;
    $definition$, schema_name, schema_name);

    EXECUTE format($definition$
      CREATE OR REPLACE FUNCTION %I.github_reviewer_bindings_get(
        p_repository text,
        p_actor_user_id text,
        p_credential_id uuid,
        p_token_version integer,
        p_subject_hash varchar,
        p_authorization_nonce text
      )
      RETURNS TABLE (
        binding_id uuid,
        github_login varchar,
        reviewer_employee_id varchar,
        reviewer_name varchar
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      STABLE
      AS $function$
      BEGIN
        RETURN QUERY
        SELECT *
        FROM %I.github_reviewer_bindings_get(
          p_repository,
          p_actor_user_id,
          p_credential_id,
          p_token_version,
          p_subject_hash
        );
      END;
      $function$;
    $definition$, schema_name, schema_name);

    EXECUTE format($definition$
      CREATE OR REPLACE FUNCTION %I.github_reviewer_bindings_upsert(
        p_repository text,
        p_bindings jsonb,
        p_actor_user_id text,
        p_credential_id uuid,
        p_token_version integer,
        p_subject_hash varchar,
        p_authorization_nonce text
      )
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $function$
      BEGIN
        RETURN %I.github_reviewer_bindings_upsert(
          p_repository,
          p_bindings,
          p_actor_user_id,
          p_credential_id,
          p_token_version,
          p_subject_hash
        );
      END;
      $function$;
    $definition$, schema_name, schema_name);

    EXECUTE format($definition$
      CREATE OR REPLACE FUNCTION %I.pull_request_reviewer_state_prepare(
        p_repository text,
        p_pull_number integer,
        p_before_logins jsonb,
        p_desired_logins jsonb,
        p_assigned_by_name text,
        p_policy jsonb,
        p_actor_user_id text,
        p_credential_id uuid,
        p_token_version integer,
        p_subject_hash varchar,
        p_authorization_nonce text
      )
      RETURNS TABLE(
        operation_token uuid,
        operation_generation integer,
        operation_reused boolean
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $function$
      BEGIN
        RETURN QUERY
        SELECT *
        FROM %I.pull_request_reviewer_state_prepare(
          p_repository,
          p_pull_number,
          p_before_logins,
          p_desired_logins,
          p_assigned_by_name,
          p_policy,
          p_actor_user_id,
          p_credential_id,
          p_token_version,
          p_subject_hash
        );
      END;
      $function$;
    $definition$, schema_name, schema_name);

    EXECUTE format($definition$
      CREATE OR REPLACE FUNCTION %I.pull_request_reviewer_state_finalize(
        p_repository text,
        p_pull_number integer,
        p_active_reviewers jsonb,
        p_operation_token uuid,
        p_reconciliation_claim_token uuid,
        p_reconciliation_generation integer,
        p_actor_user_id text,
        p_credential_id uuid,
        p_token_version integer,
        p_subject_hash varchar,
        p_authorization_nonce text
      )
      RETURNS TABLE(assignment_id uuid, delivery_eligible boolean)
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $function$
      BEGIN
        RETURN QUERY
        SELECT *
        FROM %I.pull_request_reviewer_state_finalize(
          p_repository,
          p_pull_number,
          p_active_reviewers,
          p_operation_token,
          p_reconciliation_claim_token,
          p_reconciliation_generation,
          p_actor_user_id,
          p_credential_id,
          p_token_version,
          p_subject_hash
        );
      END;
      $function$;
    $definition$, schema_name, schema_name);
  END IF;
END;
$migration$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.mcp_personal_credential_reviewer_roles_sync(uuid, integer, varchar, text, jsonb) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_actor_authorized(text, uuid, integer, varchar, boolean) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_get(text, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_upsert(text, jsonb, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_prepare(text, integer, jsonb, jsonb, text, jsonb, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_finalize(text, integer, jsonb, uuid, uuid, integer, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_audit_stats(text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_audit_list(text, integer, integer, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  IF to_regprocedure(format(
    '%I.pull_request_reviewer_actor_authorized(text,uuid,integer,character varying)',
    schema_name
  )) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_actor_authorized(text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  END IF;
  IF to_regprocedure(format(
    '%I.github_reviewer_bindings_get(text,text,uuid,integer,character varying,text)',
    schema_name
  )) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_get(text, text, uuid, integer, varchar, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  END IF;
  IF to_regprocedure(format(
    '%I.github_reviewer_bindings_upsert(text,jsonb,text,uuid,integer,character varying,text)',
    schema_name
  )) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_upsert(text, jsonb, text, uuid, integer, varchar, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  END IF;
  IF to_regprocedure(format(
    '%I.pull_request_reviewer_state_prepare(text,integer,jsonb,jsonb,text,jsonb,text,uuid,integer,character varying,text)',
    schema_name
  )) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_prepare(text, integer, jsonb, jsonb, text, jsonb, text, uuid, integer, varchar, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  END IF;
  IF to_regprocedure(format(
    '%I.pull_request_reviewer_state_finalize(text,integer,jsonb,uuid,uuid,integer,text,uuid,integer,character varying,text)',
    schema_name
  )) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_finalize(text, integer, jsonb, uuid, uuid, integer, text, uuid, integer, varchar, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  END IF;
END $$;

COMMENT ON FUNCTION mcp_personal_credential_reviewer_roles_sync(
  uuid, integer, varchar, text, jsonb
) IS '仅由系统角色写入平台实时校验过的短时 MCP 评审角色快照';
COMMENT ON FUNCTION github_reviewer_bindings_get(
  text, text, uuid, integer, varchar
) IS '按当前登录身份或个人 MCP 凭据读取 GitHub 与飞书成员映射';
COMMENT ON FUNCTION github_reviewer_bindings_upsert(
  text, jsonb, text, uuid, integer, varchar
) IS '仅允许平台管理员或编辑者更新 GitHub 与飞书成员映射';
COMMENT ON FUNCTION pull_request_reviewer_state_prepare(
  text, integer, jsonb, jsonb, text, jsonb, text, uuid, integer, varchar
) IS '仅允许平台管理员或编辑者准备 GitHub 评审人变更';
COMMENT ON FUNCTION pull_request_reviewer_state_finalize(
  text, integer, jsonb, uuid, uuid, integer, text, uuid, integer, varchar
) IS '直接完成仅允许平台管理员或编辑者，后台对账仅允许系统角色';

COMMIT;
