// One-shot migration only. Never starts web servers, queues or consumers.
import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path='/state/secrets.json',stat=lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw Error('Unsafe migration credentials');
const s=JSON.parse(readFileSync(path));
if(!/^[a-f0-9]{64}$/.test(s.database||''))throw Error('Invalid migration credentials');
const result=spawnSync(process.execPath,['scripts/selfhost/migrate.cjs'],{
  cwd:'/suite/apps/makit',stdio:'inherit',
  env:{PATH:process.env.PATH,NODE_ENV:'production',MAKIT_MIGRATION_DATABASE_URL:`postgres://suite_admin:${s.database}@postgres:5432/makit`},
});
process.exit(result.status===0?0:1);
