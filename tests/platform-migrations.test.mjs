import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateOperations, history, checksum, source, migrationName } from '../packages/operations/migrations.mjs';
test('platform migration preserves legacy data and adopts identical pre-ledger operations',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('retained');");
 db.exec(source);migrateOperations(db);migrateOperations(db);
 assert.equal(db.prepare('SELECT id FROM projects').get().id,'retained');
 assert.deepEqual(history(db),{[migrationName]:checksum});db.close();
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
 db.prepare('UPDATE cobuild_schema_migrations SET sha256=?').run(checksum);
 db.exec('ALTER TABLE collaboration_operations_v1 ADD COLUMN unexpected TEXT');
 assert.throws(()=>migrateOperations(db),/schema differs/);db.close();
});
