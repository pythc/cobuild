// Also streamed into the immutable 0.4 image by the host lifecycle manager.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { contract } = await import(pathToFileURL(process.cwd()+'/deploy/runtime/contract.mjs').href);
const files={},makitLedger={};
const sha=value=>createHash('sha256').update(value).digest('hex');
function visit(directory) {
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=directory+'/'+entry.name;
    if(entry.isSymbolicLink())throw Error('Unexpected schema link');
    if(entry.isDirectory())visit(path);
    else if(/\.(sql|js)$/.test(entry.name))files[path]=sha(readFileSync(path));
  }
}
for(const name of readdirSync('apps/platform/server').filter(n=>n.endsWith('-store.mjs')).sort()) {
  const path='apps/platform/server/'+name;files[path]=sha(readFileSync(path));
}
for(const path of ['packages/operations/sqlite-store.mjs','packages/operations/migrations.mjs',...(existsSync('packages/operations/migrations')?readdirSync('packages/operations/migrations'):[]).filter(n=>n.endsWith('.sql')).sort().map(n=>'packages/operations/migrations/'+n)]) { if(existsSync(path))files[path]=sha(readFileSync(path)); }
visit('apps/makit/migrations');
visit('integrations/weknow/source/apps/server/dist/database/migrations');
for(const path of ['apps/makit/scripts/selfhost/migrate.cjs','apps/makit/scripts/selfhost/set-runtime-password.cjs'])files[path]=sha(readFileSync(path));
for(const name of readdirSync('apps/makit/migrations/selfhost').filter(n=>/^\d+.*\.sql$/.test(n)).sort())
  makitLedger[name]=sha(readFileSync('apps/makit/migrations/selfhost/'+name));
for(const name of readdirSync('apps/makit/migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()) {
  const source=readFileSync('apps/makit/migrations/'+name,'utf8');
  makitLedger['legacy/'+name]=sha(source.replace(/\bworkspace_aadknhjojzqdw\b/g,'public').replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,''));
}
const migrationRunner=existsSync('deploy/runtime/migrate.mjs');
console.log(JSON.stringify({contract,files,makitLedger,migrationRunner,runnerDigest:migrationRunner?sha(readFileSync('deploy/runtime/migrate.mjs')):null,coreRunnerDigest:existsSync('deploy/runtime/core-migrate.mjs')?sha(readFileSync('deploy/runtime/core-migrate.mjs')):null}));
