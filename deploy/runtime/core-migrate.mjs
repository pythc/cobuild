// Explicit core transition; no web server, queues, external calls or down SQL.
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { migrateOperations, history } from '../../packages/operations/migrations.mjs';
const root=process.env.COBUILD_MIGRATION_STATE || '/state';
const safe=p=>{const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw Error('Unsafe migration state');};
safe(root+'/secrets.json');safe(root+'/platform/workspace/workspace.sqlite');
const secrets=JSON.parse(readFileSync(root+'/secrets.json'));
if(!/^[a-f0-9]{64}$/.test(secrets.database||''))throw Error('Invalid database credential');
const req=createRequire(new URL('../../integrations/weknow/source/apps/server/package.json',import.meta.url));
const {Kysely,CamelCasePlugin,sql}=req('kysely');
const {PostgresJSDialect}=req('kysely-postgres-js');
const postgres=req('postgres');
const db=new Kysely({dialect:new PostgresJSDialect({postgres:postgres(process.env.COBUILD_MIGRATION_DATABASE_URL || `postgres://suite_admin:${secrets.database}@postgres:5432/weknow`,{max:1,onnotice:()=>{}})}),plugins:[new CamelCasePlugin()]});
const folder=new URL('../../integrations/weknow/source/apps/server/dist/database/migrations/',import.meta.url);
const name='20261029T120000-suite-managed-spaces';
const file=new URL(name+'.js',folder);
const sha=createHash('sha256').update(readFileSync(file)).digest('hex');
const files=readdirSync(folder).filter(n=>n.endsWith('.js')).map(n=>n.slice(0,-3)).sort();
const sqlite=new DatabaseSync(root+'/platform/workspace/workspace.sqlite',{readOnly:process.argv.includes('--inspect-core')});
try {
  const native=await db.selectFrom('kyselyMigration').select('name').execute();
  const applied=native.map(r=>r.name).sort();
  const baseline=files.filter(n=>n!==name);
  if(JSON.stringify(applied.filter(n=>n!==name))!==JSON.stringify(baseline))throw Error('WeKnow baseline migration history differs');
  if(!process.argv.includes('--inspect-core')) {
    migrateOperations(sqlite);
    // Ledger and schema commit together. Existing files/history are immutable.
    await db.transaction().execute(async trx=>{
      await sql`SET LOCAL lock_timeout='5s'`.execute(trx);
      await sql`SET LOCAL statement_timeout='60s'`.execute(trx);
      // Match native WeKnow migrations: objects must belong to its runtime
      // owner, not the deployment superuser, or healthy startup hides API 500s.
      await sql`SET LOCAL ROLE weknow_owner`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('cobuild-core-upgrade',0))`.execute(trx);
      const old=await trx.selectFrom('kyselyMigration').select('name').where('name','=',name).executeTakeFirst();
      if(!old) {
        await req(file.pathname).up(trx);
        await trx.insertInto('kyselyMigration').values({name,timestamp:new Date().toISOString()}).execute();
      }
    });
  }
  const final=await db.selectFrom('kyselyMigration').select('name').where('name','=',name).executeTakeFirst();
  if(final) {
    // Read the security tables as part of recovery; a forged native ledger alone
    // must not permit a runtime to start against absent tables.
    await db.selectFrom('suiteManagedSpaces').select(['spaceId','projectId','organizationId']).limit(0).execute();
    await db.selectFrom('suiteManagedAccess').select(['spaceId','userId','expiresAt']).limit(0).execute();
    const ownership=await sql`SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='public' AND c.relname IN ('suite_managed_spaces','suite_managed_access')
        AND r.rolname='weknow_owner'`.execute(db);
    if(ownership.rows[0].n!==2)throw Error('Managed tables must belong to the WeKnow runtime owner');
  }
  console.log(JSON.stringify({...history(sqlite),...(final?{['weknow/'+name]:sha}:{})}));
} finally { sqlite.close(); await db.destroy(); }
