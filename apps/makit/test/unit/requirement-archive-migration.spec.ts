import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration: string = readFileSync(
  resolve(
    process.cwd(),
    'migrations/0023_requirement_archive_rpc_authorization.sql',
  ),
  'utf8',
);
const deletionLeaseMigration: string = readFileSync(
  resolve(
    process.cwd(),
    'migrations/0020_requirement_archive_deletion_lease.sql',
  ),
  'utf8',
);
const updateJobFenceMigration: string = readFileSync(
  resolve(
    process.cwd(),
    'migrations/0033_requirement_archive_update_job_fence.sql',
  ),
  'utf8',
);
const accessService: string = readFileSync(
  resolve(
    process.cwd(),
    'server/modules/requirements/requirement-access.service.ts',
  ),
  'utf8',
);

const archiveFunctions: readonly string[] = [
  'requirement_archive_caller_has_any_role(text[])',
  'requirement_archive_active_ids()',
  'requirement_archive_list()',
  'requirement_archive_list_v2()',
  'requirement_archive_mark_deleted(varchar, varchar, varchar)',
  'requirement_archive_upsert(varchar, varchar, text, varchar, varchar)',
  'requirement_archive_restore(varchar, varchar, varchar)',
  'requirement_archive_delete_claim(varchar, varchar, varchar, integer)',
  'requirement_archive_delete_renew(varchar, uuid, integer)',
  'requirement_archive_delete_complete(varchar, uuid, varchar, varchar)',
  'requirement_archive_delete_fail(varchar, uuid, text, varchar, varchar)',
];

function functionDefinitionFrom(source: string, name: string): string {
  const startMarker: string = `CREATE OR REPLACE FUNCTION ${name}(`;
  const start: number = source.indexOf(startMarker);
  if (start < 0) throw new Error(`missing function ${name}`);
  const nextFunction: number = source.indexOf(
    'CREATE OR REPLACE FUNCTION ',
    start + startMarker.length,
  );
  const nextDoBlock: number = source.indexOf('DO $$', start);
  const candidates: number[] = [nextFunction, nextDoBlock].filter(
    (value: number): boolean => value > start,
  );
  const end: number = candidates.length > 0 ? Math.min(...candidates) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

function functionDefinition(name: string): string {
  return functionDefinitionFrom(migration, name);
}

describe('requirement archive RPC authorization migration', () => {
  it('makes the additive deletion lease migration safe on its own', () => {
    expect(deletionLeaseMigration).toContain(
      'CREATE OR REPLACE FUNCTION requirement_archive_caller_has_any_role',
    );
    expect(deletionLeaseMigration).toContain(
      "ARRAY['admin', 'editor']::text[]",
    );
    expect(deletionLeaseMigration).toContain("ARRAY['admin']::text[]");
    expect(deletionLeaseMigration).toContain(
      'request_user_id = p_actor_user_id',
    );
    expect(deletionLeaseMigration).toContain(
      'OR ((_updated_by).user_id)::text = request_user_id',
    );
    expect(deletionLeaseMigration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
  });

  it('keeps direct table access closed while preserving service worker access', () => {
    expect(migration).toContain(
      'CREATE POLICY service_role_bypass_policy ON requirement_archive',
    );
    expect(migration).toContain(
      'FOR ALL TO service_role USING (true) WITH CHECK (true)',
    );
    expect(migration).toContain(
      'AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)',
    );
    expect(migration).toContain(
      'AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
    );
  });

  it('uses platform-injected identity and real platform role ids', () => {
    expect(migration).toContain("current_setting('app.user_id', TRUE)");
    expect(migration).toContain("current_setting('app.role_ids', TRUE)");
    expect(migration).toContain("ARRAY['admin', 'editor']::text[]");
    expect(migration).toContain("ARRAY['admin']::text[]");
    expect(migration).toContain('request_user_id = p_actor_user_id');
    expect(migration).not.toContain('REQUIREMENT_PLATFORM_ADMIN_ROLE_IDS =');
    for (const role of ['admin', 'editor', 'viewer'])
      expect(accessService).toContain(`'${role}'`);
    expect(accessService).not.toContain('REQUIREMENT_PLATFORM_ADMIN_ROLE_IDS');
    expect(accessService).not.toContain('REQUIREMENT_PLATFORM_EDITOR_ROLE_IDS');
    expect(accessService).not.toContain('REQUIREMENT_PLATFORM_VIEWER_ROLE_IDS');
  });

  it('uses platform-compatible internal authorization and fixed search paths', () => {
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
    archiveFunctions.forEach((signature: string): void => {
      expect(migration).toContain(
        `ALTER FUNCTION %I.${signature} SET search_path = pg_catalog, %I, pg_temp`,
      );
    });
  });

  it('keeps the public role helper boolean-only and free of archive data', () => {
    const helper: string = functionDefinition(
      'requirement_archive_caller_has_any_role',
    );
    expect(helper).toContain('RETURNS boolean');
    expect(helper).toContain("current_setting('role', TRUE)");
    expect(helper).toContain("current_setting('app.user_id', TRUE)");
    expect(helper).toContain("current_setting('app.role_ids', TRUE)");
    expect(helper).not.toContain('FROM requirement_archive');
    expect(helper).not.toContain('RETURN QUERY');
    expect(helper).not.toMatch(/requirement_(?:id|code|title)/u);
  });

  it('authorizes each usable definer function within its own body', () => {
    const activeIds: string = functionDefinition(
      'requirement_archive_active_ids',
    );
    expect(activeIds).toContain("current_setting('role', TRUE)");
    expect(activeIds).toContain("current_setting('app.user_id', TRUE)");

    ['requirement_archive_list', 'requirement_archive_list_v2'].forEach(
      (name: string): void => {
        const definition: string = functionDefinition(name);
        expect(definition).toContain('requirement_archive_caller_has_any_role');
        expect(definition).toContain("ARRAY['admin', 'editor']::text[]");
      },
    );

    const disabledLegacyDelete: string = functionDefinition(
      'requirement_archive_mark_deleted',
    );
    expect(disabledLegacyDelete).toContain('RAISE feature_not_supported');
    expect(disabledLegacyDelete).not.toMatch(/\b(?:UPDATE|DELETE)\b/iu);

    ['requirement_archive_upsert', 'requirement_archive_restore'].forEach(
      (name: string): void => {
        const definition: string = functionDefinition(name);
        expect(definition).toContain("current_setting('role', TRUE)");
        expect(definition).toContain("current_setting('app.user_id', TRUE)");
        expect(definition).toContain('request_user_id = p_actor_user_id');
        expect(definition).toContain("ARRAY['admin', 'editor']::text[]");
      },
    );

    [
      'requirement_archive_delete_claim',
      'requirement_archive_delete_complete',
      'requirement_archive_delete_fail',
    ].forEach((name: string): void => {
      const definition: string = functionDefinition(name);
      expect(definition).toContain("current_setting('role', TRUE)");
      expect(definition).toContain("current_setting('app.user_id', TRUE)");
      expect(definition).toContain('request_user_id = p_actor_user_id');
      expect(definition).toContain("ARRAY['admin']::text[]");
    });

    const renew: string = functionDefinition(
      'requirement_archive_delete_renew',
    );
    expect(renew).toContain("current_setting('role', TRUE)");
    expect(renew).toContain("current_setting('app.user_id', TRUE)");
    expect(renew).toContain("ARRAY['admin']::text[]");
    expect(renew).toContain('deletion_claim_token = p_claim_token');
    expect(renew).toContain('((_updated_by).user_id)::text = request_user_id');
  });

  it('keeps signed-in reads compatible and makes every mutation role-bound', () => {
    expect(migration).toContain(
      'requirement archive IDs are not available to this role',
    );
    expect(migration).toContain(
      'requirement archive list requires an editor role',
    );
    expect(migration).toContain(
      'use the leased requirement archive deletion workflow',
    );
    expect(migration).toContain(
      'requirement archive requires an editor role and matching actor',
    );
    expect(migration).toContain(
      'requirement restore requires an editor role and matching actor',
    );
    expect(migration).toContain(
      'requirement permanent deletion requires an admin role',
    );
    expect(migration).toContain("caller_role ~ '^service_role(_|$)'");
  });

  it('binds an authenticated deletion lease to its claiming administrator', () => {
    expect(migration).toContain(
      'OR ((_updated_by).user_id)::text = request_user_id',
    );
    expect(migration).toContain(
      'OR ((_updated_by).user_id)::text = p_actor_user_id',
    );
    expect(migration).toContain('AND deletion_claim_token = p_claim_token');
  });

  it('serializes archive admission with active background updates', () => {
    const upsert: string = functionDefinition('requirement_archive_upsert');
    expect(upsert).toContain(
      "hashtextextended('requirement_mutation:' || p_requirement_id, 0)",
    );
    expect(upsert).toContain("job.status = 'queued'");
    expect(upsert).toContain("job.status = 'running'");
    expect(upsert).toContain('job.lock_expires_at > CURRENT_TIMESTAMP');
    expect(upsert).toContain('requirement has active update jobs');
    const repairUpsert: string = functionDefinitionFrom(
      updateJobFenceMigration,
      'requirement_archive_upsert',
    );
    expect(updateJobFenceMigration).toContain(
      'CREATE OR REPLACE FUNCTION requirement_archive_upsert',
    );
    expect(repairUpsert).toContain(
      "hashtextextended('requirement_mutation:' || p_requirement_id, 0)",
    );
    expect(repairUpsert).toContain("job.status = 'queued'");
    expect(repairUpsert).toContain("job.status = 'running'");
    expect(repairUpsert).toContain('job.lock_expires_at > CURRENT_TIMESTAMP');
    expect(repairUpsert).toContain('requirement has active update jobs');
    expect(updateJobFenceMigration).toContain(
      'SET search_path = pg_catalog, %I, pg_temp',
    );
    expect(updateJobFenceMigration).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu);
  });
});
