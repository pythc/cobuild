import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { contract } from './contract.mjs';
import { environment, ports } from './environment.mjs';
import { transportFetch } from '../../packages/service/backchannel.mjs';
const { config, secrets, common, root } = environment();
process.env.COBUILD_BACKCHANNELS = common.COBUILD_BACKCHANNELS;
if (process.argv.includes('--check')) { console.log(JSON.stringify({ valid: true, modules: config.modules })); process.exit(0); }
process.umask(0o077);
if (!existsSync(root + '/runtime.json')) writeFileSync(root + '/runtime.json', JSON.stringify(contract), { mode: 0o600, flag: 'wx' });
const data = root + '/platform';
mkdirSync(data, { recursive: true, mode: 0o700 });
mkdirSync(root + '/files', { recursive: true, mode: 0o700 });
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  const live = p => p.exitCode === null && p.signalCode === null;
  for (const p of children) if (live(p)) p.kill('SIGTERM');
  const timer = setTimeout(() => { for (const p of children) if (live(p)) p.kill('SIGKILL'); }, 30000);
  Promise.all(children.map(p => live(p) ? new Promise(r => p.once('exit', r)) : null)).then(() => { clearTimeout(timer); process.exit(code); });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stop(0));
function start(name, command, cwd, env, once = false) {
  const p = spawn(process.execPath, command, { cwd, env, stdio: 'inherit' });
  children.push(p);
  p.once('error', () => stop(1));
  if (!once) p.once('exit', () => { if (!stopping) { console.error(name + ' exited; stopping the suite'); stop(1); } });
  return p;
}
async function wait(url, app) {
  for (let n = 0; n < 240; n++) {
    if (stopping) throw Error('Suite stopped');
    try { const r = await transportFetch(config.origins[app], new URL(url).pathname, { signal: AbortSignal.timeout(1500) }); if (r.ok) { await r.body?.cancel(); return; } await r.body?.cancel(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw Error('Readiness timeout');
}
async function run(command, cwd, env) {
  const p = start('migration', command, cwd, env, true);
  const code = await new Promise(r => p.once('exit', r));
  if (code !== 0) throw Error('Migration failed');
}
try {
  start('platform', ['deploy/runtime/platform.mjs'], '/suite', { ...common, COBUILD_CONFIG: root + '/config.json', COBUILD_DATA_DIR: data });
  await wait('http://127.0.0.1:4100/healthz', 'platform');
  const { organizationId } = await (await transportFetch(config.origins.platform, '/api/suite/config')).json();
  const appCommon = { ...common, COBUILD_MODULE_ENABLED: 'true', LAB_IDENTITY_TENANT_KEY: organizationId };
  if (config.modules.includes('makit')) {
    const env = { ...appCommon, COBUILD_IDENTITY_ORIGIN: config.origins.platform,
      COBUILD_WEKNOW_ORIGIN: config.modules.includes('weknow') ? config.origins.weknow : '',
      COBUILD_SERVICE_KEY_FILE: data + '/makit.service.key', MAKIT_PUBLIC_URL: config.origins.makit,
      SERVER_HOST: '0.0.0.0', SERVER_PORT: String(ports.makit), MAKIT_STORAGE: 'postgres',
      MAKIT_WORKERS_ENABLED: 'false', MAKIT_EXTERNAL_WRITES_ENABLED: 'false', REQUIREMENT_PLATFORM_APP_ID: 'cobuild-local',
      MAKIT_DATABASE_URL: `postgres://makit_application:${secrets.makitDatabase}@postgres:5432/makit`,
      MAKIT_SESSION_ENCRYPTION_KEY: secrets.makitSession };
    const migration = { ...env, MAKIT_MIGRATION_DATABASE_URL: `postgres://suite_admin:${secrets.database}@postgres:5432/makit`, MAKIT_APPLICATION_PASSWORD: secrets.makitDatabase };
    await run(['scripts/selfhost/migrate.cjs'], '/suite/apps/makit', migration);
    await run(['scripts/selfhost/set-runtime-password.cjs'], '/suite/apps/makit', migration);
    start('makit', ['dist/selfhost/server.cjs'], '/suite/apps/makit', env);
    await wait('http://127.0.0.1:4101/readyz', 'makit');
  }
  if (config.modules.includes('weknow')) {
    start('weknow', ['dist/main.js'], '/suite/integrations/weknow/source/apps/server', {
      ...appCommon, APP_URL: config.origins.weknow, HOST: '0.0.0.0', PORT: String(ports.weknow),
      LAB_IDENTITY_ENABLED: 'true', LAB_IDENTITY_ORIGIN: config.origins.platform,
      COBUILD_SERVICE_KEY_FILE: data + '/weknow.service.key', COBUILD_ORGANIZATION_NAME: config.organization.name,
      JWT_TOKEN_EXPIRES_IN: config.identity.sessionDays + 'd', FEISHU_ENABLED: 'false', FEISHU_DIRECTORY_ENABLED: 'false',
      DISABLE_TELEMETRY: 'true', STORAGE_DRIVER: 'local', COBUILD_STORAGE_PATH: root + '/files',
      APP_SECRET: secrets.weknowSession,
      DATABASE_URL: `postgres://weknow_owner:${secrets.weknowDatabase}@postgres:5432/weknow`, REDIS_URL: 'redis://redis:6379',
    });
    await wait('http://127.0.0.1:4102/api/auth/identity/status', 'weknow');
  }
  console.log(JSON.stringify({ ready: true, modules: config.modules }));
} catch (error) { console.error('Suite startup failed: ' + error.message); stop(1); }
