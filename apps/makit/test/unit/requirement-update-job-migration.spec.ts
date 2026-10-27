import * as fs from 'node:fs';
import * as path from 'node:path';

describe('requirement update job security migration', () => {
  const migration = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'migrations/0024_requirement_update_job_security.sql',
    ),
    'utf8',
  );
  const hardeningMigration = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'post-deploy/0025_requirement_update_job_direct_access_hardening.sql',
    ),
    'utf8',
  );
  const jsonContractMigration = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'migrations/0027_requirement_update_job_json_contract.sql',
    ),
    'utf8',
  );
  const boundaryMigration = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'migrations/0030_requirement_update_job_boundary_hardening.sql',
    ),
    'utf8',
  );

  it('uses an additive rollout before denying direct table access', () => {
    expect(migration).not.toContain(
      'CREATE POLICY requirement_update_job_authenticated_deny',
    );
    expect(hardeningMigration).toContain(
      'AS RESTRICTIVE FOR ALL TO authenticated',
    );
    expect(hardeningMigration).toContain('AS RESTRICTIVE FOR ALL TO anon');
    expect(hardeningMigration).toMatch(/USING \(false\)/u);
    expect(hardeningMigration).toMatch(/WITH CHECK \(false\)/u);
    expect(hardeningMigration).toContain('POST-DEPLOY ONLY');
    expect(
      fs.existsSync(
        path.resolve(
          process.cwd(),
          'migrations/0025_requirement_update_job_direct_access_hardening.sql',
        ),
      ),
    ).toBe(false);
  });

  it('takes the enqueue actor from app.user_id and stores only the request', () => {
    for (const source of [migration, jsonContractMigration, boundaryMigration]) {
      expect(source).toContain(
        "request_user_id text := NULLIF(current_setting('app.user_id', TRUE), '')",
      );
      expect(source).toContain("jsonb_build_object('input', p_input)::text");
      expect(source).toContain("'\u5f85\u89e3\u6790'");
      expect(source).not.toContain('LEFT(COALESCE(p_actor_user_name');
      expect(source).not.toContain('p_employee_id');
      expect(source).not.toContain('p_open_id');
    }
  });

  it('uses platform-compatible internal authorization for every entry point', () => {
    expect(migration).not.toMatch(/^\s*(?:GRANT|REVOKE)\s/gmu);
    expect(migration).toContain(
      'requirement update enqueue requires an authenticated user',
    );
    expect(migration).toContain(
      'requirement update status requires an authenticated user',
    );
    expect(migration).toContain(
      'requirement update pending scan is worker-only',
    );
    expect(migration).toContain(
      'requirement update claim is worker-only',
    );
    expect(migration).toContain(
      'requirement update finish is worker-only',
    );
    expect(migration).toContain(
      'requirement update lease renewal is worker-only',
    );
    expect(migration).toContain('job.actor_user_id = request_user_id');
    expect(migration).not.toContain(
      "caller_role ~ '^service_role(_|$)'\n      OR job.actor_user_id",
    );
    expect(migration).toContain('job.lock_token = p_lock_token');
  });

  it('bounds enqueue input and serializes each actor admission check', () => {
    for (const source of [migration, jsonContractMigration, boundaryMigration]) {
      expect(source).toContain('octet_length(p_requirement_id) > 255');
      expect(source).toContain('octet_length(p_expected_updated_at) > 128');
      expect(source).toContain('octet_length(p_input::text) > 262144');
      expect(source).toContain('pg_advisory_xact_lock');
      expect(source).toContain("job.status IN ('queued', 'running')");
      expect(source).toContain('active_job_count >= 50');
    }
    expect(boundaryMigration).toContain(
      'idx_requirement_update_job_actor_status',
    );
  });

  it('serializes enqueue admission with archive and rejects archived requirements', () => {
    for (const source of [migration, jsonContractMigration, boundaryMigration]) {
      expect(source).toContain(
        "hashtextextended('requirement_mutation:' || btrim(p_requirement_id), 0)",
      );
      expect(source).toContain('FROM requirement_archive AS archive');
      expect(source).toContain('requirement is archived');
    }
  });

  it('derives claim and heartbeat leases from database time', () => {
    for (const source of [migration, boundaryMigration]) {
      expect(
        source.match(
          /lock_expires_at = CURRENT_TIMESTAMP \+ interval '15 minutes'/gu,
        ),
      ).toHaveLength(2);
      expect(source).not.toContain('lock_expires_at = p_lock_expires_at');
    }
  });

  it('fixes every security definer search path', () => {
    for (const name of [
      'enqueue',
      'get',
      'pending_ids',
      'claim',
      'finish',
      'renew',
    ]) {
      expect(migration).toContain(
        `ALTER FUNCTION %I.requirement_update_job_${name}`,
      );
    }
    expect(migration).toContain('SET search_path = pg_catalog, %I, pg_temp');
  });

  it('returns scalar JSONB instead of a table composite row', () => {
    for (const name of ['enqueue', 'get', 'claim']) {
      expect(migration).toMatch(
        new RegExp(
          `FUNCTION requirement_update_job_${name}\\([\\s\\S]*?RETURNS jsonb`,
          'u',
        ),
      );
      expect(jsonContractMigration).toMatch(
        new RegExp(
          `FUNCTION requirement_update_job_${name}\\([\\s\\S]*?RETURNS jsonb`,
          'u',
        ),
      );
    }
    expect(jsonContractMigration).not.toContain(
      'DROP FUNCTION IF EXISTS requirement_update_job_pending_ids',
    );
    expect(jsonContractMigration).not.toContain(
      'DROP FUNCTION IF EXISTS requirement_update_job_finish',
    );
    expect(migration).not.toContain('RETURNS SETOF requirement_update_job');
    expect(jsonContractMigration).not.toContain(
      'RETURNS SETOF requirement_update_job',
    );
    expect(migration).toContain('RETURN to_jsonb(job_row)');
    expect(jsonContractMigration).toContain('RETURN to_jsonb(job_row)');
  });

  it('repairs the three development-only result contracts atomically', () => {
    expect(jsonContractMigration.trimStart()).toMatch(/^BEGIN;/u);
    expect(jsonContractMigration.trimEnd()).toMatch(/COMMIT;$/u);
    for (const name of ['enqueue', 'get', 'claim']) {
      expect(jsonContractMigration).toContain(
        `DROP FUNCTION IF EXISTS requirement_update_job_${name}`,
      );
      expect(jsonContractMigration).toContain(
        `CREATE FUNCTION requirement_update_job_${name}`,
      );
      expect(jsonContractMigration).toContain(
        `ALTER FUNCTION %I.requirement_update_job_${name}`,
      );
    }
    expect(jsonContractMigration).toContain(
      'SET search_path = pg_catalog, %I, pg_temp',
    );
    for (const gate of [
      'requirement update enqueue requires an authenticated user',
      'requirement update status requires an authenticated user',
      'requirement update claim is worker-only',
      'job.actor_user_id = request_user_id',
      'job.lock_expires_at <= CURRENT_TIMESTAMP',
    ]) {
      expect(jsonContractMigration).toContain(gate);
    }
  });

  it('repairs already-migrated development with the final rolling contract', () => {
    expect(boundaryMigration.trimStart()).toMatch(/^BEGIN;/u);
    expect(boundaryMigration.trimEnd()).toMatch(/COMMIT;$/u);
    expect(boundaryMigration).not.toMatch(/^\s*(?:GRANT|REVOKE)\s/gmu);
    for (const name of [
      'enqueue',
      'get',
      'pending_ids',
      'claim',
      'finish',
      'renew',
    ]) {
      expect(boundaryMigration).toContain(
        `CREATE OR REPLACE FUNCTION requirement_update_job_${name}`,
      );
      expect(boundaryMigration).toContain(
        `ALTER FUNCTION %I.requirement_update_job_${name}`,
      );
    }
    expect(boundaryMigration).toContain(
      'requirement update claim is worker-only',
    );
    expect(boundaryMigration).toContain(
      'requirement update finish is worker-only',
    );
    expect(boundaryMigration).toContain(
      'requirement update lease renewal is worker-only',
    );
    expect(boundaryMigration).toContain(
      'job.lock_expires_at > CURRENT_TIMESTAMP',
    );
    expect(boundaryMigration).not.toContain(
      'requirement update claim requires a worker or task owner',
    );
    expect(boundaryMigration).not.toContain(
      'requirement update finish requires a worker or task owner',
    );
  });
});
