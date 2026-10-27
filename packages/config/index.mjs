import { readFileSync } from 'node:fs';

export const registry = freeze(JSON.parse(readFileSync(new URL('../../suite.json', import.meta.url))));
const modules = new Map(registry.modules.map(module => [module.id, module]));
const providers = new Set(['local', 'oidc', 'feishu']);
const loopbacks = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(message) { throw new TypeError(message); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}
function keys(value, allowed, field) {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${field} contains an unsupported field`);
}
function uniqueList(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) fail(`${field} must be a unique string list`);
}
function boolean(value, field) { if (typeof value !== 'boolean') fail(`${field} must be boolean`); }
function origin(value, field) {
  if (typeof value !== 'string') fail(`${field} is required`);
  let url;
  try { url = new URL(value); } catch { fail(`${field} must be an absolute origin`); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin) fail(`${field} must be an origin without credentials, path, query or fragment`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbacks.has(url.hostname))) fail(`${field} requires HTTPS except for local loopback development`);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Validates the target configuration contract. Legacy application adapters are tracked separately. */
export function validateConfig(input) {
  const config = structuredClone(input);
  keys(config, ['schemaVersion', 'organization', 'origins', 'modules', 'identity', 'integrations', 'delivery'], 'config');
  if (config.schemaVersion !== 1) fail('schemaVersion must be 1');
  keys(config.organization, ['name', 'slug'], 'organization');
  if (typeof config.organization.name !== 'string' || !config.organization.name.trim() || config.organization.name.length > 100) fail('organization.name must be 1 to 100 characters');
  if (typeof config.organization.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.organization.slug) || config.organization.slug.length > 63) fail('organization.slug must be a lowercase slug');
  uniqueList(config.modules, 'modules');
  if (!config.modules.includes('platform')) fail('platform is required');
  for (const id of config.modules) {
    const module = modules.get(id);
    if (!module) fail('modules contains an unknown module');
    if (module.dependsOn.some(dependency => !config.modules.includes(dependency))) fail(`module ${id} is missing a dependency`);
  }
  keys(config.origins, ['platform', 'makit', 'weknow', 'evalab', 'relay'], 'origins');
  for (const [id, value] of Object.entries(config.origins)) origin(value, `origins.${id}`);
  for (const id of ['platform', 'makit', 'weknow', 'evalab', 'relay']) {
    if (config.modules.includes(id) && !config.origins[id]) fail(`origins.${id} is required`);
  }
  const origins = Object.values(config.origins);
  if (new Set(origins).size !== origins.length) fail('application origins must be distinct until path routing is supported');
  keys(config.identity, ['providers', 'sessionDays', 'selfRegistration'], 'identity');
  uniqueList(config.identity.providers, 'identity.providers');
  if (!config.identity.providers.length || config.identity.providers.some(provider => !providers.has(provider))) fail('identity.providers contains an unsupported provider');
  if (!Number.isInteger(config.identity.sessionDays) || config.identity.sessionDays < 1 || config.identity.sessionDays > 30) fail('identity.sessionDays must be 1 to 30');
  boolean(config.identity.selfRegistration, 'identity.selfRegistration');
  keys(config.integrations, ['feishu', 'github', 'mail', 'ai'], 'integrations');
  for (const id of ['feishu', 'github', 'mail', 'ai']) boolean(config.integrations[id], `integrations.${id}`);
  if (config.identity.providers.includes('feishu') && !config.integrations.feishu) fail('Feishu identity requires the Feishu integration');
  if (config.integrations.mail && !config.modules.includes('mail')) fail('mail integration requires the mail module');
  keys(config.delivery, ['externalMessages'], 'delivery');
  boolean(config.delivery.externalMessages, 'delivery.externalMessages');
  if (config.delivery.externalMessages && !config.integrations.mail && !config.integrations.feishu) fail('external messages require an enabled delivery integration');
  return freeze(config);
}

export function planConfig(input) {
  const config = validateConfig(input);
  return {
    status: 'target-configuration-only',
    runnable: false,
    organization: config.organization.slug,
    enabledModules: config.modules,
    disabledModules: registry.modules.filter(module => !config.modules.includes(module.id)).map(module => module.id),
    sourceComponents: [...new Set(config.modules.map(id => modules.get(id).source))],
    externalMessages: config.delivery.externalMessages,
    note: 'A valid target plan does not enable or secure the legacy applications. See release blockers.'
  };
}
