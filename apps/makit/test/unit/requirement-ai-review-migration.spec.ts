import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('requirement AI review migration', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'migrations/0034_requirement_ai_review.sql'),
    'utf8',
  );

  it('creates versioned artifacts and durable review jobs', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS requirement_artifact');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS requirement_ai_review');
    expect(migration).toContain('uk_requirement_ai_review_dedupe');
    expect(migration).toContain("status IN ('queued', 'running', 'completed', 'failed')");
  });

  it('enables RLS and keeps a worker-only service role path', () => {
    expect(migration).toContain('ALTER TABLE requirement_artifact ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE requirement_ai_review ENABLE ROW LEVEL SECURITY');
    expect(migration.match(/TO service_role USING \(true\) WITH CHECK \(true\)/gu)).toHaveLength(2);
  });
});
