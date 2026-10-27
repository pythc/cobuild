import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {APP_BRANDS, COBUILD_BRAND, getAppPresentation, applyAppBranding, getAppSearchText} from '../src/app-branding.js';

const catalog = JSON.parse(readFileSync(new URL('../src/projects.json', import.meta.url)));
const expected = [
  ['projects', 'Kick', '项目立项'],
  ['knowledge', 'WeKnow', '知识库'],
  ['recruitment-test', 'HiFlow', '招新管理'],
  ['assessment', 'Evalab', '考核系统'],
  ['relay', 'Relay', '客服'],
  ['requirements', 'Makit', '需求平台'],
];

test('brands precisely the approved application IDs without changing routing or availability', () => {
  assert.equal(Object.keys(APP_BRANDS).length, 6);
  for (const [id, name, original] of expected) {
    const app = catalog.apps.find(value => value.id === id);
    assert.ok(app, id);
    const presented = getAppPresentation(app);
    assert.equal(presented.title, name);
    assert.equal(presented.originalTitle, original);
    for (const key of ['id', 'url', 'status', 'icon', 'edition', 'description']) {
      assert.deepEqual(presented[key], app[key], `${id}.${key}`);
    }
    assert.equal(presented.iconUrl, id === 'requirements' ? '/assets/cobuild/requirements-logo.svg' : id === 'relay' ? '/assets/cobuild/relay.svg' : `/assets/cobuild/${name.toLowerCase()}.png`);
  }
});

test('CoBuild is the suite; honors, mail, grading and other apps retain their names', () => {
  assert.equal(COBUILD_BRAND.name, 'CoBuild');
  assert.equal(COBUILD_BRAND.scope, 'suite');
  for (const app of catalog.apps.filter(app => !Object.hasOwn(APP_BRANDS, app.id))) {
    const result = getAppPresentation(app);
    assert.equal(result.title, app.title);
    assert.equal(result.originalTitle, app.title);
    assert.equal(result.iconUrl, null);
    assert.deepEqual(result, {...app, originalTitle: app.title, iconUrl: null});
  }
  assert.equal(getAppPresentation(catalog.apps.find(app => app.id === 'requirements')).title, 'Makit');
});

test('branding is non-mutating, preserves extra fields and remains stable when applied twice', () => {
  const item = Object.freeze({id: 'projects', title: '项目立项', url: '/projects', status: 'available', canManage: false});
  const input = Object.freeze([item]);
  const output = applyAppBranding(input);
  assert.notEqual(output, input);
  assert.notEqual(output[0], item);
  assert.equal(output[0].canManage, false);
  assert.equal(item.title, '项目立项');
  assert.deepEqual(applyAppBranding(output), output);
  assert.ok(Object.isFrozen(COBUILD_BRAND));
  assert.ok(Object.isFrozen(APP_BRANDS.projects));
});

test('new names, original names, IDs and descriptions remain searchable after renaming', () => {
  for (const [id, name, original] of expected) {
    const app = getAppPresentation(catalog.apps.find(value => value.id === id));
    const text = getAppSearchText(app);
    assert.ok(text.includes(name.toLowerCase()));
    assert.ok(text.includes(original));
    assert.ok(text.includes(id));
    assert.ok(text.includes(app.description.toLowerCase()));
  }
});

test('unbranded apps preserve any existing custom icon and original title', () => {
  const app = {id: 'custom', title: 'New', originalTitle: 'Old', iconUrl: '/assets/custom.svg'};
  assert.deepEqual(getAppPresentation(app), app);
  assert.ok(getAppSearchText(app).includes('old'));
  assert.equal(getAppPresentation({id: '__proto__', title: 'Unchanged'}).title, 'Unchanged');
});

test('invalid catalog containers fail explicitly rather than silently producing an empty directory', () => {
  for (const value of [null, undefined, 42, 'apps', {}]) assert.throws(() => applyAppBranding(value), TypeError);
  for (const value of [null, undefined, [], 'Kick']) assert.throws(() => getAppPresentation(value), TypeError);
});

test('the checked-in marks are byte-for-byte the approved wordmarks and functional v3 icons', () => {
  const hashes = {
    'cobuild-wordmark.svg': 'f25d674097f74d55fb8854da0191c751902a2b352955887a32b6f1d43952fe1e',
    'cobuild-wordmark-white.svg': '2d9af18558db35d136ffe4170b4f0ba1adf7bd299c194966f14147fefa19938c',
    'kick.png': '3462efbe4625f5755a45b439f745f33f2ef63a414fcb25f3838e6f231fe59da8',
    'weknow.png': 'ffc3a25b112cc74fa16ec9b593dc0c31b39afe9ce1e22c2a8cb64004555cb665',
    'hiflow.png': 'fccd1b6f0d59a567971c276242c312321f65634380eeff7d073c7b9163bb1de4',
    'requirements-logo.svg': 'd9cbee3eb69634ef1f6a132e2d4066065f90a8a066c64a65b86d95eeed18309b',
    'relay.svg': '34e264956670d13133cd0b75ec197bc7ce036bf4e7040a4442d8719e4d8e1bcd',
    'evalab.png': 'ef0dcaa9a0cf12c0658571fb1473e5ddfa784e90e3c37fee44b7d264e23f68c2',
  };
  const urls = [COBUILD_BRAND.wordmarkUrl, COBUILD_BRAND.inverseWordmarkUrl, ...Object.values(APP_BRANDS).map(app => app.iconUrl)];
  assert.equal(urls.length, Object.keys(hashes).length);
  for (const url of urls) {
    assert.match(url, /^\/assets\/cobuild\/[a-z-]+\.(?:png|svg)$/);
    const file = url.split('/').at(-1);
    const bytes = readFileSync(new URL(`../src/assets/cobuild/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[file], file);
    if (file.endsWith('.png')) {
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.readUInt32BE(16), 1254);
      assert.equal(bytes.readUInt32BE(20), 1254);
      assert.equal(bytes[25], 6); // RGBA PNG; preserve real transparency.
    } else {
      assert.match(bytes.toString(), /<svg\b/);
      assert.doesNotMatch(bytes.toString(), /<(?:text|image|script|foreignObject)\b/);
    }
  }
});
