import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('source import excludes enterprise code, secrets, data, binaries and old plugin assets', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import runpy,json
p=runpy.run_path('tools/import_sources.py')['permitted']
cases=['apps/client/src/ee/feature.ts','packages/ee/LICENSE','.env','data/user.json','tests/fixtures.private.json','src/assets/zhiping-promo.mp4','src/assets/recruitment-qq-2026.png','node_modules/x/index.js','server/session.db','server/runtime.mjs','server/private.pem','src/assets/cobuild/weknow.png','server/workspace-store.mjs','apps/server/src/core/page/page.service.ts']
print(json.dumps({s:p(s) for s in cases}))
`], { encoding: 'utf8' }));
  for (const [path, allowed] of Object.entries(result)) {
    const shouldAllow = ['src/assets/cobuild/weknow.png', 'server/workspace-store.mjs', 'apps/server/src/core/page/page.service.ts'].includes(path);
    assert.equal(allowed, shouldAllow, path);
  }
});
