import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { contract } from './contract.mjs';
import { validateConfig } from '../../packages/config/index.mjs';
import { assertNativeRuntime } from '../../packages/config/runtime.mjs';
export const ports = { platform: 4100, makit: 4101, weknow: 4102 };
export function environment(root = '/state') {
  const config = validateConfig(JSON.parse(readFileSync(root + '/config.json')));
  assertNativeRuntime(config);
  if (existsSync(root + '/runtime.json') && JSON.stringify(JSON.parse(readFileSync(root + '/runtime.json'))) !== JSON.stringify(contract))
    throw Error('Stored schema contract differs; an explicit migration is required');
  const stat = lstatSync(root + '/secrets.json');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw Error('Unsafe deployment secrets file');
  const secrets = JSON.parse(readFileSync(root + '/secrets.json'));
  for (const key of ['database', 'makitDatabase', 'weknowDatabase', 'makitSession', 'weknowSession'])
    if (!/^[a-f0-9]{64}$/.test(secrets[key] || '')) throw Error('Invalid deployment secret: ' + key);
  const common = {
    PATH: process.env.PATH, HOME: '/tmp', NODE_ENV: 'production',
    COBUILD_IDENTITY_MODE: 'local',
    COBUILD_BACKCHANNELS: JSON.stringify(Object.fromEntries(Object.entries(ports).map(([k, p]) => [config.origins[k], 'http://127.0.0.1:' + p]).filter(([k]) => k))),
  };
  return { config, secrets, common, root };
}
