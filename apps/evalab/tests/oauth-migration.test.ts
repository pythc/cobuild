import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool, migrate } from '../server/src/db.js';

test('001 upgrade preserves data and changes only documented upload columns; startup is repeatable', async (t) => {
  if (!process.env.TEST_DATABASE_URL) return t.skip('TEST_DATABASE_URL required');
  const schema = `oauth_upgrade_${process.pid}`;
  const db = createPool(process.env.TEST_DATABASE_URL, schema);
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(await readFile(new URL('../server/migrations/001_init.sql', import.meta.url), 'utf8'));
    await db.query("INSERT INTO schema_migrations(id) VALUES('001_init')");
    const before = await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position`, [schema]);
    const sentinel = (await db.query("INSERT INTO rounds(name) VALUES('升级保留测试') RETURNING id")).rows[0].id;
    await Promise.all([migrate(db, schema), migrate(db, schema)]);
    const after = await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name NOT LIKE 'oauth_%' AND table_name NOT LIKE 'material_upload%' AND table_name <> 'deleted_material_files' ORDER BY table_name,ordinal_position`, [schema]);
    const expected = before.rows.map(row => row.table_name === 'materials' && row.column_name === 'approval_id' ? {...row,is_nullable:'YES'} : row);
    assert.deepEqual(after.rows.filter(row => !(row.table_name === 'enrollments' && row.column_name === 'direct_upload_consent_at')), expected);
    assert.equal((await db.query('SELECT name FROM rounds WHERE id=$1', [sentinel])).rows[0].name, '升级保留测试');
    assert.deepEqual((await db.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(x => x.id), ['001_init','002_oauth','003_direct_upload','004_admin_deletion']);
    // Old release's migration gate only checks 001 and returns, without removing added tables.
    assert.equal((await db.query("SELECT 1 FROM schema_migrations WHERE id='001_init'")).rowCount, 1);
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
});
