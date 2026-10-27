import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Miaoda migration compatibility', () => {
  const files = [
    '0019_restore_legacy_reviewer_compatibility.sql',
    '0020_requirement_archive_deletion_lease.sql',
    '0021_reviewer_notification_reconciliation.sql',
    '0023_requirement_archive_rpc_authorization.sql',
    '0024_requirement_update_job_security.sql',
    '0026_archive_function_contract_versioning.sql',
    '0027_requirement_update_job_json_contract.sql',
    '0028_reviewer_role_authorization.sql',
    '0030_requirement_update_job_boundary_hardening.sql',
    '0032_pull_request_refresh_coordination.sql',
    '0033_requirement_archive_update_job_fence.sql',
  ];
  const postDeployFiles = [
    'post-deploy/0022_reviewer_legacy_direct_access_hardening.sql',
    'post-deploy/0025_requirement_update_job_direct_access_hardening.sql',
    'post-deploy/0029_remove_reviewer_nonce_compatibility.sql',
    'post-deploy/0031_pull_request_snapshot_direct_write_hardening.sql',
  ];

  it.each(files)('%s does not use platform-managed GRANT or REVOKE', (file) => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations', file),
      'utf8',
    );
    expect(migration).not.toMatch(/^\s*(?:GRANT|REVOKE)\s/gmu);
  });

  it.each(postDeployFiles)(
    '%s stays outside the normal migration batch and avoids privilege statements',
    (file) => {
      expect(files).not.toContain(file);
      const migration = fs.readFileSync(
        path.resolve(process.cwd(), file),
        'utf8',
      );
      expect(migration).toContain('POST-DEPLOY ONLY');
      expect(file.startsWith('post-deploy/')).toBe(true);
      expect(migration).not.toMatch(/^\s*(?:GRANT|REVOKE)\s/gmu);
    },
  );

  it('keeps every contract-shrinking migration outside the normal tree', () => {
    const rootEntries: string[] = fs.readdirSync(
      path.resolve(process.cwd(), 'migrations'),
    );
    expect(rootEntries).not.toContain(
      '0022_reviewer_legacy_direct_access_hardening.sql',
    );
    expect(rootEntries).not.toContain(
      '0025_requirement_update_job_direct_access_hardening.sql',
    );
    expect(rootEntries).not.toContain(
      '0029_remove_reviewer_nonce_compatibility.sql',
    );
    expect(rootEntries).not.toContain(
      '0031_pull_request_snapshot_direct_write_hardening.sql',
    );
  });

  it('keeps pull request snapshots readable but denies direct user writes post-deploy', () => {
    const migration = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'post-deploy/0031_pull_request_snapshot_direct_write_hardening.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('FOR INSERT');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('FOR DELETE');
    expect(migration).toContain('AS RESTRICTIVE');
    expect(migration).not.toMatch(/FOR SELECT/iu);
    expect(migration).toContain(
      'synced_at = to_timestamp(0)',
    );
    expect(migration).toContain(
      'github_updated_at = LEAST(github_updated_at, clock_timestamp())',
    );
  });

  it('coordinates GitHub refreshes with a database-time service-role lease', () => {
    const migration = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'migrations/0032_pull_request_refresh_coordination.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('pull_request_refresh_lease_claim_v1');
    expect(migration).toContain('pull_request_refresh_lease_finish_v1');
    expect(migration).toContain('clock_timestamp()');
    expect(migration).toContain('lease_expires_at');
    expect(migration).toContain('last_succeeded_at');
    expect(migration).toContain("'observedAt', now_at");
    expect(migration).toContain("'reason', 'lost'");
    expect(migration).toContain('p_cooldown_seconds NOT BETWEEN 0 AND 300');
    expect(migration).toContain('AS RESTRICTIVE');
    expect(migration).toContain('TO service_role');
    expect(migration).not.toMatch(/^\s*(?:GRANT|REVOKE)\s/gmu);
  });
});
