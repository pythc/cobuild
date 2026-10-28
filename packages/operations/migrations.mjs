import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const migrationName = 'platform/0001_operations';
export const source = readFileSync(new URL('./migrations/0001_operations.sql', import.meta.url),'utf8');
export const checksum = createHash('sha256').update(source).digest('hex');
const schema = db => db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'collaboration_%' AND sql IS NOT NULL ORDER BY name").all();
const expectedDb = new DatabaseSync(':memory:'); expectedDb.exec(source);
const expected = JSON.stringify(schema(expectedDb)); expectedDb.close();
export function history(db) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cobuild_schema_migrations'").get();
  const rows=exists?db.prepare('SELECT name,sha256 FROM cobuild_schema_migrations ORDER BY name').all():[];
  if(rows.some(r=>r.name!==migrationName||r.sha256!==checksum))throw Error('Platform migration history differs');
  if(rows.length && JSON.stringify(schema(db))!==expected)throw Error('Platform schema differs from committed migration');
  return Object.fromEntries(rows.map(r=>[r.name,r.sha256]));
}
export function migrateOperations(db) {
  db.exec('SAVEPOINT platform_migration');
  try {
    history(db);
    db.exec(source);
    if(JSON.stringify(schema(db))!==expected)throw Error('Platform schema conflict');
    db.exec('CREATE TABLE IF NOT EXISTS cobuild_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
    db.prepare('INSERT OR IGNORE INTO cobuild_schema_migrations VALUES(?,?)').run(migrationName,checksum);
    db.exec('RELEASE platform_migration');
  } catch(e) { db.exec('ROLLBACK TO platform_migration; RELEASE platform_migration'); throw e; }
}
