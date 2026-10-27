BEGIN;

-- This migration is deliberately additive. Legacy pull_request_reviewer and
-- its functions remain untouched so old Pods can continue serving during a
-- rolling release. New Pods use the operation/state/event tables below.
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

CREATE TABLE IF NOT EXISTS pull_request_reviewer_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  pull_number integer NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  operation_token uuid,
  last_completed_operation_token uuid,
  last_completed_actor_user_id varchar(255),
  operation_expires_at TIMESTAMP(3) WITH TIME ZONE,
  reconciliation_claim_token uuid,
  reconciliation_claim_expires_at TIMESTAMP(3) WITH TIME ZONE,
  actor_user_id varchar(255),
  desired_logins_json text NOT NULL DEFAULT '[]',
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL,
  CONSTRAINT pull_request_reviewer_operation_generation_check
    CHECK (generation >= 0),
  CONSTRAINT pull_request_reviewer_operation_lease_check
    CHECK (
      (operation_token IS NULL AND operation_expires_at IS NULL
        AND actor_user_id IS NULL)
      OR (operation_token IS NOT NULL AND operation_expires_at IS NOT NULL
        AND NULLIF(BTRIM(actor_user_id), '') IS NOT NULL)
    ),
  CONSTRAINT pull_request_reviewer_reconciliation_lease_check
    CHECK (
      (reconciliation_claim_token IS NULL
        AND reconciliation_claim_expires_at IS NULL)
      OR (reconciliation_claim_token IS NOT NULL
        AND reconciliation_claim_expires_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS pull_request_reviewer_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  pull_number integer NOT NULL,
  github_login varchar(255) NOT NULL,
  assignment_generation integer NOT NULL DEFAULT 0,
  notified_generation integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  assigned_by_name varchar(255) NOT NULL DEFAULT '',
  assigned_by_user_id varchar(255) NOT NULL DEFAULT '',
  pending_policy_mode varchar(32),
  pending_delivery_eligible boolean,
  pending_suppression_reason text,
  pending_reviewer_employee_id varchar(255),
  pending_reviewer_name varchar(128),
  pending_operation_generation integer,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL,
  CONSTRAINT pull_request_reviewer_state_generation_check
    CHECK (
      assignment_generation >= 0
      AND notified_generation >= 0
      AND notified_generation <= assignment_generation
    ),
  CONSTRAINT pull_request_reviewer_state_policy_check
    CHECK (
      (
        pending_policy_mode IS NULL
        AND pending_delivery_eligible IS NULL
        AND pending_suppression_reason IS NULL
        AND pending_reviewer_employee_id IS NULL
        AND pending_reviewer_name IS NULL
        AND pending_operation_generation IS NULL
      ) OR (
        pending_policy_mode IN ('disabled', 'test_only', 'live')
        AND pending_delivery_eligible IS NOT NULL
        AND NULLIF(BTRIM(pending_reviewer_employee_id), '') IS NOT NULL
        AND NULLIF(BTRIM(pending_reviewer_name), '') IS NOT NULL
        AND pending_operation_generation >= 0
        AND (
          (pending_delivery_eligible = true
            AND pending_suppression_reason IS NULL)
          OR (pending_delivery_eligible = false
            AND NULLIF(BTRIM(pending_suppression_reason), '') IS NOT NULL)
        )
      )
    )
);

CREATE TABLE IF NOT EXISTS pull_request_reviewer_notification_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  pull_number integer NOT NULL,
  github_login varchar(255) NOT NULL,
  assignment_generation integer NOT NULL,
  reviewer_user_id varchar(255) NOT NULL,
  reviewer_employee_id varchar(255) NOT NULL,
  reviewer_name varchar(128) NOT NULL,
  assigned_by_name varchar(255) NOT NULL,
  assigned_by_user_id varchar(255) NOT NULL,
  delivery_policy_mode varchar(32) NOT NULL,
  delivery_eligible boolean NOT NULL DEFAULT false,
  suppression_reason text,
  suppressed_at TIMESTAMP(3) WITH TIME ZONE,
  notified_at TIMESTAMP(3) WITH TIME ZONE,
  max_notification_attempts integer NOT NULL DEFAULT 8,
  notification_attempts integer NOT NULL DEFAULT 0,
  notification_error text,
  notification_claim_token uuid,
  notification_claim_expires_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT NULL,
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT NULL,
  CONSTRAINT pull_request_reviewer_event_generation_check
    CHECK (
      assignment_generation >= 0
      AND notification_attempts >= 0
      AND max_notification_attempts BETWEEN 1 AND 100
    ),
  CONSTRAINT pull_request_reviewer_event_policy_check
    CHECK (delivery_policy_mode IN ('disabled', 'test_only', 'live')),
  CONSTRAINT pull_request_reviewer_event_suppression_check
    CHECK (
      (delivery_eligible = true AND suppressed_at IS NULL)
      OR (delivery_eligible = false AND suppressed_at IS NOT NULL
        AND notified_at IS NULL)
    ),
  CONSTRAINT pull_request_reviewer_event_claim_check
    CHECK (
      (notification_claim_token IS NULL
        AND notification_claim_expires_at IS NULL)
      OR (notification_claim_token IS NOT NULL
        AND notification_claim_expires_at IS NOT NULL)
    )
);

ALTER TABLE pull_request_snapshot
  ADD COLUMN IF NOT EXISTS reviewers_updated_at
    TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT to_timestamp(0);

ALTER TABLE pull_request_reviewer_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE pull_request_reviewer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pull_request_reviewer_notification_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass_policy ON pull_request_reviewer_operation;
CREATE POLICY service_role_bypass_policy ON pull_request_reviewer_operation
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON pull_request_reviewer_operation;
CREATE POLICY "修改全部数据" ON pull_request_reviewer_operation
  AS PERMISSIVE FOR ALL TO authenticated USING (true);
DROP POLICY IF EXISTS "查看全部数据" ON pull_request_reviewer_operation;
CREATE POLICY "查看全部数据" ON pull_request_reviewer_operation
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "修改本人数据" ON pull_request_reviewer_operation;
CREATE POLICY "修改本人数据" ON pull_request_reviewer_operation
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );
DROP POLICY IF EXISTS "评审变更租约登录用户禁止直接访问" ON pull_request_reviewer_operation;
CREATE POLICY "评审变更租约登录用户禁止直接访问" ON pull_request_reviewer_operation
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "评审变更租约匿名用户禁止直接访问" ON pull_request_reviewer_operation;
CREATE POLICY "评审变更租约匿名用户禁止直接访问" ON pull_request_reviewer_operation
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS service_role_bypass_policy ON pull_request_reviewer_state;
CREATE POLICY service_role_bypass_policy ON pull_request_reviewer_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON pull_request_reviewer_state;
CREATE POLICY "修改全部数据" ON pull_request_reviewer_state
  AS PERMISSIVE FOR ALL TO authenticated USING (true);
DROP POLICY IF EXISTS "查看全部数据" ON pull_request_reviewer_state;
CREATE POLICY "查看全部数据" ON pull_request_reviewer_state
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "修改本人数据" ON pull_request_reviewer_state;
CREATE POLICY "修改本人数据" ON pull_request_reviewer_state
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );
DROP POLICY IF EXISTS "评审通知状态登录用户禁止直接访问" ON pull_request_reviewer_state;
CREATE POLICY "评审通知状态登录用户禁止直接访问" ON pull_request_reviewer_state
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "评审通知状态匿名用户禁止直接访问" ON pull_request_reviewer_state;
CREATE POLICY "评审通知状态匿名用户禁止直接访问" ON pull_request_reviewer_state
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS service_role_bypass_policy ON pull_request_reviewer_notification_event;
CREATE POLICY service_role_bypass_policy ON pull_request_reviewer_notification_event
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "修改全部数据" ON pull_request_reviewer_notification_event;
CREATE POLICY "修改全部数据" ON pull_request_reviewer_notification_event
  AS PERMISSIVE FOR ALL TO authenticated USING (true);
DROP POLICY IF EXISTS "查看全部数据" ON pull_request_reviewer_notification_event;
CREATE POLICY "查看全部数据" ON pull_request_reviewer_notification_event
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "修改本人数据" ON pull_request_reviewer_notification_event;
CREATE POLICY "修改本人数据" ON pull_request_reviewer_notification_event
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );
DROP POLICY IF EXISTS "评审通知事件登录用户禁止直接访问" ON pull_request_reviewer_notification_event;
CREATE POLICY "评审通知事件登录用户禁止直接访问" ON pull_request_reviewer_notification_event
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "评审通知事件匿名用户禁止直接访问" ON pull_request_reviewer_notification_event;
CREATE POLICY "评审通知事件匿名用户禁止直接访问" ON pull_request_reviewer_notification_event
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_operation
  ON pull_request_reviewer_operation(repository, pull_number);
CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_operation_lease
  ON pull_request_reviewer_operation(
    repository, operation_expires_at, reconciliation_claim_expires_at
  );
CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_state
  ON pull_request_reviewer_state(repository, pull_number, github_login);
CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_state_pending
  ON pull_request_reviewer_state(
    repository, active, notified_generation, assignment_generation
  );
CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_notification_event_generation
  ON pull_request_reviewer_notification_event(
    repository, pull_number, github_login, assignment_generation
  );
CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_notification_event_pull
  ON pull_request_reviewer_notification_event(
    repository, pull_number, _created_at
  );
CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_notification_event_pending
  ON pull_request_reviewer_notification_event(
    repository, delivery_eligible, notified_at, suppressed_at,
    notification_claim_expires_at, _created_at
  );

-- MCP roles are refreshed from the platform API for every authenticated MCP
-- request. Only the service-role path that runs outside the anonymous request
-- context may persist that live result. The short TTL prevents a credential
-- holder from retaining reviewer write access after a platform-role revocation.
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

-- One trust-boundary helper is reused by every SECURITY DEFINER function.
-- Authenticated writes require the platform-provided request identity and an
-- admin/editor role. Anonymous MCP writes additionally require a valid owned
-- credential plus a fresh role snapshot created by the service-role sync above.
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

CREATE OR REPLACE FUNCTION pull_request_reviewer_state_reconciliation_claim(
  p_repository text,
  p_limit integer,
  p_lease_seconds integer
)
RETURNS TABLE(
  pull_number integer,
  operation_generation integer,
  reconciliation_claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'reviewer notification reconciliation is worker-only';
  END IF;
  IF NULLIF(BTRIM(p_repository), '') IS NULL
    OR LENGTH(BTRIM(p_repository)) > 255
  THEN
    RAISE EXCEPTION 'invalid reviewer reconciliation repository';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT operation.id
    FROM pull_request_reviewer_operation AS operation
    WHERE operation.repository = p_repository
      AND (
        operation.operation_token IS NULL
        OR operation.operation_expires_at <= CURRENT_TIMESTAMP
      )
      AND (
        operation.reconciliation_claim_token IS NULL
        OR operation.reconciliation_claim_expires_at <= CURRENT_TIMESTAMP
      )
      AND EXISTS (
        SELECT 1
        FROM pull_request_reviewer_state AS state
        WHERE state.repository = operation.repository
          AND state.pull_number = operation.pull_number
          AND state.assignment_generation > state.notified_generation
          AND state.pending_policy_mode IS NOT NULL
      )
    ORDER BY operation._updated_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100)
  ), claimed AS (
    UPDATE pull_request_reviewer_operation AS operation
    SET reconciliation_claim_token = gen_random_uuid(),
      reconciliation_claim_expires_at = CURRENT_TIMESTAMP + make_interval(
        secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 30), 30), 600)
      ),
      -- Claiming authoritative recovery fences the expired request owner.
      -- Its frozen state remains intact; only the stale mutation token is
      -- cleared so a paused request can no longer overwrite reconciliation.
      operation_token = NULL,
      operation_expires_at = NULL,
      actor_user_id = NULL,
      _updated_at = CURRENT_TIMESTAMP
    FROM candidates
    WHERE operation.id = candidates.id
    RETURNING operation.pull_number, operation.generation,
      operation.reconciliation_claim_token
  )
  SELECT claimed.pull_number, claimed.generation,
    claimed.reconciliation_claim_token
  FROM claimed;
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

CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_events_claim(
  p_repository text,
  p_assignment_ids jsonb,
  p_max_attempts integer,
  p_limit integer,
  p_lease_seconds integer
)
RETURNS TABLE(
  assignment_id uuid,
  repository varchar,
  pull_number integer,
  github_login varchar,
  reviewer_employee_id varchar,
  reviewer_name varchar,
  assigned_by_name varchar,
  assigned_by_user_id varchar,
  delivery_eligible boolean,
  suppressed_at TIMESTAMP(3) WITH TIME ZONE,
  notification_claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'reviewer notification claims are worker-only';
  END IF;
  IF NULLIF(BTRIM(p_repository), '') IS NULL
    OR LENGTH(BTRIM(p_repository)) > 255
    OR p_max_attempts IS NULL
    OR p_limit IS NULL
    OR p_lease_seconds IS NULL
    OR (
      p_assignment_ids IS NOT NULL
      AND (
        jsonb_typeof(p_assignment_ids) <> 'array'
        OR jsonb_array_length(p_assignment_ids) > 100
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p_assignment_ids) AS item(value)
          WHERE item.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
      )
    )
  THEN
    RAISE EXCEPTION 'invalid reviewer notification claim request';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM pull_request_reviewer_notification_event AS event
    WHERE event.repository = p_repository
      AND event.delivery_eligible = true
      AND event.suppressed_at IS NULL
      AND event.notified_at IS NULL
      AND event.notification_attempts < LEAST(
        event.max_notification_attempts,
        GREATEST(p_max_attempts, 1)
      )
      AND (
        event.notification_claim_expires_at IS NULL
        OR event.notification_claim_expires_at <= CURRENT_TIMESTAMP
      )
      AND (
        jsonb_array_length(COALESCE(p_assignment_ids, '[]'::jsonb)) = 0
        OR event.id::text IN (
          SELECT jsonb_array_elements_text(p_assignment_ids)
        )
      )
    ORDER BY event._created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ), claimed AS (
    UPDATE pull_request_reviewer_notification_event AS event
    SET notification_claim_token = gen_random_uuid(),
      notification_claim_expires_at = CURRENT_TIMESTAMP + make_interval(
        secs => LEAST(GREATEST(p_lease_seconds, 30), 600)
      ),
      notification_error = NULL,
      _updated_at = CURRENT_TIMESTAMP
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING event.id, event.repository, event.pull_number,
      event.github_login, event.reviewer_employee_id, event.reviewer_name,
      event.assigned_by_name, event.assigned_by_user_id,
      event.delivery_eligible, event.suppressed_at,
      event.notification_claim_token
  )
  SELECT claimed.id, claimed.repository, claimed.pull_number,
    claimed.github_login, claimed.reviewer_employee_id,
    claimed.reviewer_name, claimed.assigned_by_name,
    claimed.assigned_by_user_id, claimed.delivery_eligible,
    claimed.suppressed_at,
    claimed.notification_claim_token
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_event_result(
  p_assignment_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected_count integer := 0;
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'reviewer notification results are worker-only';
  END IF;
  IF p_assignment_id IS NULL OR p_claim_token IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION 'invalid reviewer notification result';
  END IF;
  UPDATE pull_request_reviewer_notification_event
  SET notified_at = CASE WHEN p_success
      THEN CURRENT_TIMESTAMP ELSE notified_at END,
    notification_attempts = notification_attempts + 1,
    notification_error = CASE WHEN p_success THEN NULL
      ELSE LEFT(COALESCE(p_error_message, ''), 2000) END,
    notification_claim_token = NULL,
    notification_claim_expires_at = NULL,
    _updated_at = CURRENT_TIMESTAMP
  WHERE id = p_assignment_id
    AND notification_claim_token = p_claim_token
    AND notified_at IS NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN jsonb_build_object(
    'success', affected_count = 1,
    'affectedCount', affected_count
  );
END;
$$;

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

DO $$
DECLARE schema_name text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.mcp_personal_credential_reviewer_roles_sync(uuid, integer, varchar, text, jsonb) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_actor_authorized(text, uuid, integer, varchar, boolean) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_get(text, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.github_reviewer_bindings_upsert(text, jsonb, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_prepare(text, integer, jsonb, jsonb, text, jsonb, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_reconciliation_claim(text, integer, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_state_finalize(text, integer, jsonb, uuid, uuid, integer, text, uuid, integer, varchar) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_events_claim(text, jsonb, integer, integer, integer) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_event_result(uuid, uuid, boolean, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_audit_stats(text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
  EXECUTE format('ALTER FUNCTION %I.pull_request_reviewer_notification_audit_list(text, integer, integer, text) SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END $$;

-- Miaoda owns database execution privileges. Each public function therefore
-- validates the caller role plus actor/MCP/admin proof inside its own body;
-- worker-only functions reject every role except service_role.

COMMENT ON TABLE pull_request_reviewer_notification_event IS
  'Append-only GitHub reviewer Feishu notification audit events';
COMMENT ON FUNCTION github_reviewer_bindings_upsert(text, jsonb, text, uuid, integer, varchar) IS
  'Validated SECURITY DEFINER write boundary for GitHub-to-Feishu reviewer bindings';
COMMENT ON FUNCTION pull_request_reviewer_state_prepare(text, integer, jsonb, jsonb, text, jsonb, text, uuid, integer, varchar) IS
  'Acquire/reuse a per-PR reviewer mutation lease and freeze notification policy before GitHub mutation';
COMMENT ON FUNCTION pull_request_reviewer_state_finalize(text, integer, jsonb, uuid, uuid, integer, text, uuid, integer, varchar) IS
  'Reconcile authoritative GitHub reviewers and append notification events with mutation-token fencing';

COMMIT;
