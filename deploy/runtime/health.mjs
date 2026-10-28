import { readFileSync } from 'node:fs';
import { transportFetch } from '../../packages/service/backchannel.mjs';
const { modules, origins } = JSON.parse(readFileSync('/state/config.json'));
process.env.COBUILD_BACKCHANNELS = JSON.stringify(Object.fromEntries(['platform','makit','weknow'].map((id,i)=>[origins[id], 'http://127.0.0.1:'+(4100+i)]).filter(([origin])=>origin)));
try {
  for (const [id, url] of [['platform', 'http://127.0.0.1:4100/healthz'], ['makit', 'http://127.0.0.1:4101/readyz'], ['weknow', 'http://127.0.0.1:4102/api/auth/identity/status']]) {
    if (!modules.includes(id)) continue;
    const r = await transportFetch(origins[id], new URL(url).pathname, { signal: AbortSignal.timeout(3000) });
    await r.body?.cancel();
    if (!r.ok) throw Error(id);
  }
} catch { process.exit(1); }
