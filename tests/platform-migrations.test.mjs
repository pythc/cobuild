import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateOperations, history, checksum, source, migrationName, migrations } from '../packages/operations/migrations.mjs';
test('platform migration preserves legacy data and adopts identical pre-ledger operations',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('retained');");
 db.exec(source);migrateOperations(db);migrateOperations(db);
 assert.equal(db.prepare('SELECT id FROM projects').get().id,'retained');
 assert.deepEqual(history(db),Object.fromEntries(migrations.map(m=>[m.name,m.checksum])));db.close();
});
test('partial DDL and ledger roll back together on a conflicting existing table',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE collaboration_events_v1(id TEXT PRIMARY KEY)');
 assert.throws(()=>migrateOperations(db),/schema conflict/);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='collaboration_operations_v1'").get().n,0);
 assert.deepEqual(history(db),{});db.close();
});
test('changed ledger and drift after migration fail closed without rewriting history',()=>{
 const db=new DatabaseSync(':memory:');migrateOperations(db);
 db.prepare('UPDATE cobuild_schema_migrations SET sha256=?').run('0'.repeat(64));
 assert.throws(()=>migrateOperations(db),/history differs/);
 for(const m of migrations)db.prepare('UPDATE cobuild_schema_migrations SET sha256=? WHERE name=?').run(m.checksum,m.name);
 db.exec('ALTER TABLE collaboration_operations_v1 ADD COLUMN unexpected TEXT');
 assert.throws(()=>migrateOperations(db),/schema differs/);db.close();
});
test('transfer migration appends to the immutable baseline ledger',()=>{
 const db=new DatabaseSync(':memory:');db.exec(source);db.exec('CREATE TABLE cobuild_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');db.prepare('INSERT INTO cobuild_schema_migrations VALUES(?,?)').run(migrationName,checksum);
 assert.deepEqual(history(db),{[migrationName]:checksum});migrateOperations(db);
 assert.equal(Object.keys(history(db)).length,2);assert.equal(history(db)[migrationName],checksum);db.close();
});
test('a missing middle migration or changed transfer schema is rejected',()=>{
 const db=new DatabaseSync(':memory:');migrateOperations(db);db.prepare('DELETE FROM cobuild_schema_migrations WHERE name=?').run(migrationName);
 assert.throws(()=>migrateOperations(db),/history differs/);
 db.prepare('INSERT INTO cobuild_schema_migrations VALUES(?,?)').run(migrationName,checksum);
 db.exec('ALTER TABLE collaboration_project_transfers_v1 ADD COLUMN unexpected TEXT');
 assert.throws(()=>migrateOperations(db),/schema differs/);db.close();
});
