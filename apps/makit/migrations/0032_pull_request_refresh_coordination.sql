BEGIN;

-- Cross-Pod coordination for GitHub snapshot refreshes. This migration is
-- additive: old application pods do not know about this table or its RPCs.
CREATE TABLE IF NOT EXISTS pull_request_refresh_lease (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository varchar(255) NOT NULL,
  lease_token uuid,
  lease_expires_at TIMESTAMP(3) WITH TIME ZONE,
  last_succeeded_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_refresh_lease_repository
  ON pull_request_refresh_lease(repository);
CREATE INDEX IF NOT EXISTS idx_pull_request_refresh_lease_expiry
  ON pull_request_refresh_lease(lease_expires_at);

ALTER TABLE pull_request_refresh_lease ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass_policy
  ON pull_request_refresh_lease;
CREATE POLICY service_role_bypass_policy ON pull_request_refresh_lease
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "修改全部数据" ON pull_request_refresh_lease;
CREATE POLICY "修改全部数据" ON pull_request_refresh_lease
  AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "查看全部数据" ON pull_request_refresh_lease;
CREATE POLICY "查看全部数据" ON pull_request_refresh_lease
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS "修改本人数据" ON pull_request_refresh_lease;
CREATE POLICY "修改本人数据" ON pull_request_refresh_lease
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  ) WITH CHECK (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

-- Direct access is denied immediately because only the new application code
-- uses this table. The default policies above remain present for Miaoda's
-- platform contract; these restrictive policies are the effective boundary.
DROP POLICY IF EXISTS pull_request_refresh_lease_authenticated_deny
  ON pull_request_refresh_lease;
CREATE POLICY pull_request_refresh_lease_authenticated_deny
  ON pull_request_refresh_lease AS RESTRICTIVE
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS pull_request_refresh_lease_anon_deny
  ON pull_request_refresh_lease;
CREATE POLICY pull_request_refresh_lease_anon_deny
  ON pull_request_refresh_lease AS RESTRICTIVE
  FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION pull_request_refresh_lease_claim_v1(
  p_repository text,
  p_lease_token uuid,
  p_lease_seconds integer,
  p_cooldown_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  now_at TIMESTAMP(3) WITH TIME ZONE := clock_timestamp();
  lease_row pull_request_refresh_lease%ROWTYPE;
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'pull request refresh coordination is worker-only';
  END IF;
  IF NULLIF(BTRIM(p_repository), '') IS NULL
    OR octet_length(p_repository) > 255
    OR p_lease_token IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 600
    OR p_cooldown_seconds NOT BETWEEN 0 AND 300
  THEN
    RAISE EXCEPTION 'invalid pull request refresh lease request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('pull_request_refresh:' || BTRIM(p_repository), 0)
  );
  INSERT INTO pull_request_refresh_lease (repository)
  VALUES (BTRIM(p_repository))
  ON CONFLICT (repository) DO NOTHING;

  SELECT refresh_lease.*
  INTO lease_row
  FROM pull_request_refresh_lease AS refresh_lease
  WHERE refresh_lease.repository = BTRIM(p_repository)
  FOR UPDATE;

  -- The same token is a heartbeat. All lease deadlines are derived from the
  -- database clock, so Pod clock skew cannot steal or prolong ownership.
  IF lease_row.lease_token = p_lease_token
    AND lease_row.lease_expires_at > now_at
  THEN
    UPDATE pull_request_refresh_lease
    SET lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
      _updated_at = now_at
    WHERE repository = BTRIM(p_repository)
    RETURNING * INTO lease_row;
    RETURN jsonb_build_object(
      'claimed', true,
      'reason', 'renewed',
      'observedAt', now_at,
      'startedAt', now_at,
      'leaseExpiresAt', lease_row.lease_expires_at,
      'lastSucceededAt', lease_row.last_succeeded_at
    );
  END IF;

  -- A token is single-generation. Once its lease expires it can never be
  -- revived as a fresh owner, even if no replacement owner has arrived yet.
  IF lease_row.lease_token = p_lease_token THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'lost',
      'observedAt', now_at,
      'leaseExpiresAt', lease_row.lease_expires_at,
      'lastSucceededAt', lease_row.last_succeeded_at
    );
  END IF;

  IF lease_row.lease_expires_at > now_at THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'active',
      'observedAt', now_at,
      'leaseExpiresAt', lease_row.lease_expires_at,
      'lastSucceededAt', lease_row.last_succeeded_at
    );
  END IF;

  IF lease_row.last_succeeded_at IS NOT NULL
    AND lease_row.last_succeeded_at
      > now_at - make_interval(secs => p_cooldown_seconds)
  THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'cooldown',
      'observedAt', now_at,
      'leaseExpiresAt', NULL,
      'lastSucceededAt', lease_row.last_succeeded_at
    );
  END IF;

  UPDATE pull_request_refresh_lease
  SET lease_token = p_lease_token,
    lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
    _updated_at = now_at
  WHERE repository = BTRIM(p_repository)
  RETURNING * INTO lease_row;

  RETURN jsonb_build_object(
    'claimed', true,
    'reason', 'claimed',
    'observedAt', now_at,
    'startedAt', now_at,
    'leaseExpiresAt', lease_row.lease_expires_at,
    'lastSucceededAt', lease_row.last_succeeded_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION pull_request_refresh_lease_finish_v1(
  p_repository text,
  p_lease_token uuid,
  p_succeeded boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  now_at TIMESTAMP(3) WITH TIME ZONE := clock_timestamp();
  lease_row pull_request_refresh_lease%ROWTYPE;
BEGIN
  IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN
    RAISE insufficient_privilege USING
      MESSAGE = 'pull request refresh completion is worker-only';
  END IF;
  IF NULLIF(BTRIM(p_repository), '') IS NULL
    OR octet_length(p_repository) > 255
    OR p_lease_token IS NULL
    OR p_succeeded IS NULL
  THEN
    RAISE EXCEPTION 'invalid pull request refresh completion'
      USING ERRCODE = '22023';
  END IF;

  SELECT refresh_lease.*
  INTO lease_row
  FROM pull_request_refresh_lease AS refresh_lease
  WHERE refresh_lease.repository = BTRIM(p_repository)
  FOR UPDATE;
  IF NOT FOUND
    OR lease_row.lease_token IS DISTINCT FROM p_lease_token
    OR lease_row.lease_expires_at <= now_at
  THEN
    RETURN jsonb_build_object('finished', false);
  END IF;

  UPDATE pull_request_refresh_lease
  SET lease_token = NULL,
    lease_expires_at = NULL,
    last_succeeded_at = CASE
      WHEN p_succeeded THEN now_at
      ELSE last_succeeded_at
    END,
    _updated_at = now_at
  WHERE repository = BTRIM(p_repository)
  RETURNING * INTO lease_row;

  RETURN jsonb_build_object(
    'finished', true,
    'completedAt', now_at,
    'lastSucceededAt', lease_row.last_succeeded_at
  );
END;
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.pull_request_refresh_lease_claim_v1(text, uuid, integer, integer) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.pull_request_refresh_lease_finish_v1(text, uuid, boolean) SET search_path = pg_catalog, %I, pg_temp',
    schema_name,
    schema_name
  );
END $$;

COMMENT ON TABLE pull_request_refresh_lease IS
  'GitHub 合并请求快照刷新跨实例租约与成功冷却窗口';
COMMENT ON FUNCTION pull_request_refresh_lease_claim_v1(
  text, uuid, integer, integer
) IS '系统角色按数据库时间领取或续租 GitHub 合并请求刷新任务';
COMMENT ON FUNCTION pull_request_refresh_lease_finish_v1(
  text, uuid, boolean
) IS '系统角色以租约令牌原子完成 GitHub 合并请求刷新任务';

COMMIT;
