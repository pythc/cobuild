import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration: string = readFileSync(
  resolve(
    process.cwd(),
    'migrations/0021_reviewer_notification_reconciliation.sql',
  ),
  'utf8',
);
const legacyCompatibilityMigration: string = readFileSync(
  resolve(
    process.cwd(),
    'migrations/0019_restore_legacy_reviewer_compatibility.sql',
  ),
  'utf8',
);
const pullRequestsServiceSource: string = readFileSync(
  resolve(
    process.cwd(),
    'server/modules/pull-requests/pull-requests.service.ts',
  ),
  'utf8',
);
const authorizationRepairMigration: string = readFileSync(
  resolve(process.cwd(), 'migrations/0028_reviewer_role_authorization.sql'),
  'utf8',
);
const nonceCleanupMigration: string = readFileSync(
  resolve(
    process.cwd(),
    'post-deploy/0029_remove_reviewer_nonce_compatibility.sql',
  ),
  'utf8',
);
const legacyHardeningMigration: string = readFileSync(
  resolve(
    process.cwd(),
    'post-deploy/0022_reviewer_legacy_direct_access_hardening.sql',
  ),
  'utf8',
);

function functionDefinition(name: string): string {
  const start: number = migration.indexOf(
    `CREATE OR REPLACE FUNCTION ${name}`,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end: number = migration.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end + 4);
}

describe('reviewer notification reconciliation migration', () => {
  it('is additive and leaves the legacy reviewer table contract alone', () => {
    expect(migration).not.toMatch(/ALTER TABLE pull_request_reviewer\s/i);
    expect(migration).not.toMatch(/DROP INDEX[^;]*pull_request_reviewer/iu);
    expect(migration).not.toMatch(/DELETE FROM pull_request_reviewer\b/iu);
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS pull_request_reviewer_notification_event',
    );
  });

  it('uses identity-bound definer functions and direct-access deny policies', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewer_actor_authorized',
    );
    expect(migration).toContain(
      "request_user_id = NULLIF(BTRIM(p_actor_user_id), '')",
    );
    expect(migration).toContain('mcp_personal_credential_verify(');
    expect(migration).toContain(
      'AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)',
    );
    expect(migration).toContain(
      'AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
    );
    for (const table of [
      'pull_request_reviewer_operation',
      'pull_request_reviewer_state',
      'pull_request_reviewer_notification_event',
    ]) {
      const tablePolicies = migration.slice(
        migration.indexOf(
          `DROP POLICY IF EXISTS service_role_bypass_policy ON ${table}`,
        ),
      );
      expect(tablePolicies).toContain(
        `CREATE POLICY service_role_bypass_policy ON ${table}`,
      );
      expect(tablePolicies).toContain(
        `CREATE POLICY "修改全部数据" ON ${table}`,
      );
      expect(tablePolicies).toContain(
        `CREATE POLICY "查看全部数据" ON ${table}`,
      );
      expect(tablePolicies).toContain(
        `CREATE POLICY "修改本人数据" ON ${table}`,
      );
    }
  });

  it('uses platform-compatible migrations without privilege statements or broad legacy helpers', () => {
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
    expect(legacyCompatibilityMigration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
    expect(legacyCompatibilityMigration).not.toContain('SECURITY DEFINER');
    expect(legacyCompatibilityMigration).not.toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewers_replace',
    );
    expect(legacyCompatibilityMigration).not.toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_result',
    );
    expect(legacyCompatibilityMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_user',
    );
    expect(legacyCompatibilityMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uk_pull_request_reviewer_github_login',
    );
    expect(legacyHardeningMigration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
    expect(legacyHardeningMigration).toContain('POST-DEPLOY ONLY');
    for (const legacyFunction of [
      'pull_request_reviewers_replace',
      'pull_request_reviewer_notification_enqueue',
      'pull_request_reviewer_notifications_claim',
      'pull_request_reviewer_notification_result',
    ]) {
      expect(legacyHardeningMigration).toContain(
        `DROP FUNCTION IF EXISTS ${legacyFunction}`,
      );
    }
  });

  it('enforces every public definer boundary inside the function body', () => {
    const actorHelper: string = functionDefinition(
      'pull_request_reviewer_actor_authorized',
    );
    expect(actorHelper).toContain("caller_role ~ '^service_role(_|$)'");
    expect(actorHelper).toContain("caller_role ~ '^authenticated(_|$)'");
    expect(actorHelper).toContain("caller_role ~ '^anon(_|$)'");
    expect(actorHelper).toContain('mcp_personal_credential_verify(');
    expect(actorHelper).toContain("IN ('admin', 'editor')");
    expect(actorHelper).toContain("INTERVAL '2 minutes'");
    expect(actorHelper).toContain('RETURN false;');

    const bindingRead: string = functionDefinition(
      'github_reviewer_bindings_get',
    );
    expect(bindingRead).toContain(
      'p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, false',
    );
    expect(bindingRead).toContain('RAISE insufficient_privilege');

    for (const name of [
      'github_reviewer_bindings_upsert',
      'pull_request_reviewer_state_prepare',
    ]) {
      const body: string = functionDefinition(name);
      expect(body).toContain('pull_request_reviewer_actor_authorized(');
      expect(body).toContain(
        'p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, true',
      );
      expect(body).toContain('RAISE insufficient_privilege');
    }

    const finalize: string = functionDefinition(
      'pull_request_reviewer_state_finalize',
    );
    expect(finalize).toContain(
      "current_setting('role', TRUE) !~ '^service_role(_|$)'",
    );
    expect(finalize).toContain('pull_request_reviewer_actor_authorized(');
    expect(finalize).toContain(
      'p_actor_user_id, p_credential_id, p_token_version, p_subject_hash, true',
    );
    expect(finalize).toContain('RAISE insufficient_privilege');

    for (const name of [
      'pull_request_reviewer_state_reconciliation_claim',
      'pull_request_reviewer_notification_events_claim',
      'pull_request_reviewer_notification_event_result',
    ]) {
      const body: string = functionDefinition(name);
      expect(body).toContain(
        "current_setting('role', TRUE) !~ '^service_role(_|$)'",
      );
      expect(body).toContain('RAISE insufficient_privilege');
    }

    for (const name of [
      'pull_request_reviewer_notification_audit_stats',
      'pull_request_reviewer_notification_audit_list',
    ]) {
      const body: string = functionDefinition(name);
      expect(body).toContain('pull_request_reviewer_actor_authorized(');
      expect(body).toContain("WHERE BTRIM(platform_role.role_id) = 'admin'");
      expect(body).toContain('RAISE insufficient_privilege');
    }

    expect(migration).not.toContain('authorization_nonce');
    expect(pullRequestsServiceSource).not.toContain('authorization_nonce');
    expect(pullRequestsServiceSource).not.toContain('set_config(');
  });

  it('refreshes MCP roles through a service-only database boundary', () => {
    const syncRoles: string = functionDefinition(
      'mcp_personal_credential_reviewer_roles_sync',
    );
    expect(syncRoles).toContain(
      "current_setting('role', TRUE) !~ '^service_role(_|$)'",
    );
    expect(syncRoles).toContain('reviewer_role_version + 1');
    expect(syncRoles).toContain('reviewer_roles_verified_at = clock_timestamp()');
    expect(authorizationRepairMigration).toContain(
      'has_legacy_nonce_overloads',
    );
    expect(authorizationRepairMigration).toContain(
      'The legacy nonce argument is deliberately ignored',
    );
    expect(authorizationRepairMigration).not.toContain('set_config(');
    expect(
      authorizationRepairMigration.match(/p_authorization_nonce/gu),
    ).toHaveLength(4);
    expect(authorizationRepairMigration).toContain(
      'FROM %I.pull_request_reviewer_state_prepare(',
    );
    expect(authorizationRepairMigration).toContain(
      'FROM %I.pull_request_reviewer_state_finalize(',
    );
    expect(authorizationRepairMigration).toContain(
      "IF current_setting('role', TRUE) !~ '^service_role(_|$)' THEN",
    );
    expect(authorizationRepairMigration).toContain(
      'authoritative reviewer reconciliation is worker-only',
    );
    for (const name of [
      'pull_request_reviewer_notification_audit_stats',
      'pull_request_reviewer_notification_audit_list',
    ]) {
      expect(authorizationRepairMigration).toContain(
        `CREATE OR REPLACE FUNCTION ${name}`,
      );
    }
    expect(authorizationRepairMigration).toContain(
      'p_actor_user_id, NULL, NULL, NULL, false',
    );
  });

  it('keeps nonce cleanup as a post-deploy drop-only migration', () => {
    expect(nonceCleanupMigration).toContain('POST-DEPLOY ONLY');
    expect(nonceCleanupMigration).toContain(
      'this file only\n-- removes the safe legacy signatures',
    );
    expect(nonceCleanupMigration).not.toContain('pg_get_functiondef(');
    expect(nonceCleanupMigration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(nonceCleanupMigration).toContain(
      'DROP FUNCTION IF EXISTS github_reviewer_bindings_get(\n  text, text, uuid, integer, varchar, text',
    );
    expect(nonceCleanupMigration).toContain(
      'DROP FUNCTION IF EXISTS pull_request_reviewer_state_prepare(\n  text, integer, jsonb, jsonb, text, jsonb,',
    );
    expect(nonceCleanupMigration).toContain(
      'DROP FUNCTION IF EXISTS pull_request_reviewer_actor_authorized(\n  text, uuid, integer, varchar',
    );
    expect(nonceCleanupMigration).not.toMatch(/DROP FUNCTION[^;]*CASCADE/isu);
  });

  it('serializes reviewer mutations and fences delivery results', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS pull_request_reviewer_operation',
    );
    expect(migration).toContain(
      'another reviewer mutation is still in progress',
    );
    expect(migration).toContain('reviewer mutation lease is stale');
    expect(migration).toContain('operation_reused boolean');
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('AND notification_claim_token = p_claim_token');
    expect(migration).toContain(
      'event.assigned_by_name, event.assigned_by_user_id',
    );
    expect(migration).not.toContain(
      'pull_request_reviewer_notification_events_get',
    );
    expect(migration).toContain(
      'authoritative reviewer reconciliation is worker-only',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewer_state_reconciliation_claim',
    );
    expect(migration).toContain(
      'reviewer reconciliation lease is stale',
    );
    expect(migration).toContain(
      'SET requested_reviewers_json = p_active_reviewers::text',
    );
  });

  it('persists policy decisions and exposes only controlled audit reads', () => {
    expect(migration).toContain('pending_policy_mode');
    expect(migration).toContain('suppressed_at');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_audit_stats',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pull_request_reviewer_notification_audit_list',
    );
    expect(migration).toContain(
      "WHERE BTRIM(platform_role.role_id) = 'admin'",
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION github_reviewer_bindings_upsert',
    );
    expect(migration).toContain('last_completed_operation_token');
    expect(migration).toContain('reviewers_updated_at');
    expect(migration).toContain(
      'MESSAGE = \'reviewer notification claims are worker-only\'',
    );
    expect(migration).toContain(
      'MESSAGE = \'reviewer notification results are worker-only\'',
    );
  });
});
