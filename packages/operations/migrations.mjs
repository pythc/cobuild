import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const migrations = ['0001_operations','0002_project_transfers'].map(name => {
  const source=readFileSync(new URL('./migrations/'+name+'.sql',import.meta.url),'utf8');
  return {name:'platform/'+name,source,checksum:createHash('sha256').update(source).digest('hex')};
});
// Retain the original exports for consumers inspecting the first migration.
export const {name:migrationName,source,checksum}=migrations[0];
const schema=db=>db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'collaboration_%' AND sql IS NOT NULL ORDER BY name").all();
const expectedDb=new DatabaseSync(':memory:'),expected=[];
for(const step of migrations){expectedDb.exec(step.source);expected.push(JSON.stringify(schema(expectedDb)));}expectedDb.close();
export function history(db) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cobuild_schema_migrations'").get();
  const rows=exists?db.prepare('SELECT name,sha256 FROM cobuild_schema_migrations ORDER BY name').all():[];
  if(rows.some((r,i)=>r.name!==migrations[i]?.name||r.sha256!==migrations[i]?.checksum))throw Error('Platform migration history differs');
  if(rows.length&&JSON.stringify(schema(db))!==expected[rows.length-1])throw Error('Platform schema differs from committed migration');
  return Object.fromEntries(rows.map(r=>[r.name,r.sha256]));
}
export function migrateOperations(db) {
  db.exec('SAVEPOINT platform_migration');
  try {
    const applied=Object.keys(history(db)).length;
    db.exec('CREATE TABLE IF NOT EXISTS cobuild_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
    for(let i=applied;i<migrations.length;i++){
      const step=migrations[i];db.exec(step.source);
      if(JSON.stringify(schema(db))!==expected[i])throw Error('Platform schema conflict');
      db.prepare('INSERT INTO cobuild_schema_migrations VALUES(?,?)').run(step.name,step.checksum);
    }
    db.exec('RELEASE platform_migration');
  } catch(e) { db.exec('ROLLBACK TO platform_migration; RELEASE platform_migration'); throw e; }
}
