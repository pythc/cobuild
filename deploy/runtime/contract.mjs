import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const hash = createHash('sha256');
// Conservative gate: any schema-owning implementation or migration change
// needs a separately reviewed migration release. This runner never guesses.
for (const path of readdirSync('apps/platform/server').filter(n=>n.endsWith('-store.mjs')).sort().map(n=>'apps/platform/server/'+n)) {
  hash.update(path); hash.update(readFileSync(path));
}
for(const path of ['packages/operations/sqlite-store.mjs']) { hash.update(path);hash.update(readFileSync(path)); }
for (const directory of ['apps/makit/migrations', 'integrations/weknow/source/apps/server/dist/database/migrations']) {
  const visit = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) throw Error('Unexpected migration link');
      const path = dir + '/' + e.name;
      if (e.isDirectory()) visit(path);
      else if (/\.(sql|js)$/.test(e.name)) { hash.update(path); hash.update(readFileSync(path)); }
    }
  };
  visit(directory);
}
export const contract = { format: 1, schema: hash.digest('hex'), runtime: 'core-single-writer-v1', postgresMajor: 17 };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(contract));
