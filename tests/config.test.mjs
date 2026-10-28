import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registry, validateConfig, planConfig } from '../packages/config/index.mjs';

const example = () => JSON.parse(readFileSync(new URL('../config/cobuild.example.json', import.meta.url)));
test('core plan enables only the four core modules and never claims runtime readiness', () => {
  const plan = planConfig(example());
  assert.deepEqual(plan.enabledModules, ['platform', 'kick', 'makit', 'weknow']);
  assert.equal(plan.runnable, false);
  assert.equal(plan.externalMessages, false);
  assert.ok(plan.retainedSourceModules.includes('hiflow'));
  assert.ok(plan.retainedSourceModules.includes('evalab'));
});
test('config is copied and frozen so later mutations cannot enable delivery', () => {
  const input = example(), config = validateConfig(input);
  input.delivery.externalMessages = true;
  assert.equal(config.delivery.externalMessages, false);
  assert.throws(() => { config.modules.push('hiflow'); }, TypeError);
});
test('loopback development configuration is accepted', () => {
  assert.ok(validateConfig(JSON.parse(readFileSync(new URL('../config/cobuild.local.example.json', import.meta.url)))));
});
for (const [name, change] of [
  ['unknown module', c => c.modules.push('imaginary')],
  ['excluded product', c => c.modules.push('110lab-plugin')],
  ['missing platform', c => { c.modules = ['kick']; }],
  ['missing project owner', c => { c.modules = ['platform', 'makit']; }],
  ['duplicate module', c => c.modules.push('makit')],
  ['unknown root setting', c => { c.password = 'never-allowed-here'; }],
  ['empty organization', c => { c.organization.name = ' '; }],
  ['invalid organization slug', c => { c.organization.slug = '../unsafe'; }],
  ['Feishu without integration', c => { c.identity.providers = ['feishu']; }],
  ['no login provider', c => { c.identity.providers = []; }],
  ['unsupported login provider', c => { c.identity.providers = ['unknown']; }],
  ['session beyond contract', c => { c.identity.sessionDays = 31; }],
  ['truthy registration string', c => { c.identity.selfRegistration = 'false'; }],
  ['mail without module', c => { c.integrations.mail = true; }],
  ['delivery without integration', c => { c.delivery.externalMessages = true; }],
  ['missing module origin', c => { delete c.origins.makit; }],
  ['missing optional application origin', c => { c.modules.push('evalab'); }],
  ['origin collision', c => { c.origins.makit = c.origins.platform; }],
  ['remote plaintext HTTP', c => { c.origins.platform = 'http://example.com'; }],
  ['loopback prefix spoof', c => { c.origins.platform = 'http://localhost.attacker.example'; }],
  ['credentials in origin', c => { c.origins.platform = 'https://user:password@example.com'; }],
  ['query in origin', c => { c.origins.platform += '?token=secret'; }],
  ['path in origin', c => { c.origins.platform += '/auth'; }],
  ['fragment in origin', c => { c.origins.platform += '#secret'; }]
]) test(`rejects ${name}`, () => { const c = example(); change(c); assert.throws(() => validateConfig(c)); });
test('retained business sources cannot be enabled by configuration', () => {
  for(const module of registry.retainedModules) {
    const config=example();config.modules.push(module.id);
    assert.throws(()=>validateConfig(config));
  }
  assert.equal(registry.modules.filter(m=>m.owns.includes('project')).length,1);
  assert.deepEqual(registry.modules.map(m=>m.id),['platform','kick','makit','weknow']);
});
test('secret values never appear in invalid configuration errors', () => {
  const config = example(); config.origins.platform = 'https://user:very-private-value@example.com';
  assert.throws(() => validateConfig(config), error => !error.message.includes('very-private-value'));
});
