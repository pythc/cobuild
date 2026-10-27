import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('monitoring retirement database fence', () => {
  const migration = readFileSync(resolve(process.cwd(), 'migrations/0046_retire_monitoring_writes.sql'), 'utf8');
  it('fences only the three retired telemetry tables', () => {
    const tables = [...migration.matchAll(/BEFORE INSERT OR UPDATE ON (\w+)/gu)].map((match) => match[1]);
    expect(tables).toEqual(['operations_scanner_heartbeat', 'operations_dependency_sample', 'operations_alert_incident']);
    expect(migration).toContain('RETURN NULL;');
    expect(migration).not.toMatch(/BEFORE DELETE|AFTER DELETE|TRUNCATE|SECURITY DEFINER/iu);
    expect(migration).not.toMatch(/^\s*(DELETE|UPDATE|DROP|GRANT|REVOKE)\s/gmu);
  });
  it('keeps function and trigger DDL visible to the Miaoda migration tracker', () => {
    expect(migration).toMatch(/^CREATE OR REPLACE FUNCTION /mu);
    expect(migration.match(/^CREATE OR REPLACE TRIGGER /gmu)).toHaveLength(3);
    expect(migration).not.toMatch(/^DO\s/mu);
  });
});
