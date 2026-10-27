import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, lstatSync, chmodSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync, linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {openWorkbenchPreferencesStore, WorkbenchPreferencesError} from '../server/workbench-preferences-store.mjs';

const alice = {subject: 'tenant:alice', role: 'member'};
const bob = {subject: 'tenant:bob', role: 'member'};
const admin = {subject: 'tenant:admin', role: 'super_admin'};
const ids = ['projects', 'knowledge', 'assessment', 'recruitment-test'];
const dbName = 'workbench-preferences.sqlite';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cobuild-preferences-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const open = (extra = {}) => {
    const store = openWorkbenchPreferencesStore({directory, allowedAppIds: ids, ...options, ...extra});
    stores.push(store);
    return store;
  };
  return {directory, open, store: open()};
}

function error(fn, status, code) {
  assert.throws(fn, value => {
    assert.ok(value instanceof WorkbenchPreferencesError);
    assert.equal(value.status, status);
    if (code) assert.equal(value.code, code);
    assert.ok(value.message.length > 0);
    assert.doesNotMatch(value.message, /SQLITE|sqlite|\/Users\/|SELECT|INSERT|ENOENT|EACCES/);
    return true;
  });
}

test('starts at revision zero, de-duplicates preserving order, and persists across restart', t => {
  const {store, open} = fixture(t, {now: () => 1700000000000});
  assert.deepEqual(store.get(alice), {revision: 0, favoriteAppIds: []});
  assert.deepEqual(store.update(alice, {revision: 0, favoriteAppIds: ['knowledge', 'projects', 'knowledge']}), {
    revision: 1, favoriteAppIds: ['knowledge', 'projects'],
  });
  store.close();
  assert.deepEqual(open().get(alice), {revision: 1, favoriteAppIds: ['knowledge', 'projects']});
});

test('users including super administrators cannot read or overwrite another user preferences', t => {
  const {store} = fixture(t);
  store.update(alice, {revision: 0, favoriteAppIds: ['projects']});
  for (const actor of [bob, admin]) {
    assert.deepEqual(store.get(actor), {revision: 0, favoriteAppIds: []});
    store.update(actor, {revision: 0, favoriteAppIds: ['knowledge']});
  }
  assert.deepEqual(store.get(alice), {revision: 1, favoriteAppIds: ['projects']});
  for (const field of ['subject', 'owner', 'ownerSubject', 'userId', 'role', 'email', '__proto__']) {
    const body = JSON.parse(JSON.stringify({revision: 1, favoriteAppIds: ['assessment']}));
    Object.defineProperty(body, field, {value: alice.subject, enumerable: true});
    error(() => store.update(admin, body), 400, 'invalid_input');
  }
  assert.deepEqual(store.get(alice).favoriteAppIds, ['projects']);
});

test('rejects absent, malformed and control-character identities without normalizing subjects', t => {
  const {store} = fixture(t);
  for (const actor of [null, {}, {subject: ''}, {subject: 123}, {subject: ' tenant:alice'},
    {subject: 'tenant:alice\n'}, {subject: 'a'.repeat(201)}, {subject: '../alice'}]) {
    error(() => store.get(actor), 401);
    error(() => store.update(actor, {revision: 0, favoriteAppIds: []}), 401);
  }
  error(() => store.get({...alice, role: 'guest'}), 403);
  assert.deepEqual(store.get({subject: 'tenant:member.with+email@lab.test'}), {revision: 0, favoriteAppIds: []});
});

test('strictly validates body, revision, bounded lists and whitelist IDs; invalid writes are atomic', t => {
  const {store} = fixture(t);
  const invalid = [null, undefined, [], 'projects', {}, {revision: 0}, {favoriteAppIds: []},
    ...[-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => ({revision, favoriteAppIds: []})),
    {revision: 0, favoriteAppIds: 'projects'}, {revision: 0, favoriteAppIds: [null]},
    {revision: 0, favoriteAppIds: ['projects', 'not-approved']},
    {revision: 0, favoriteAppIds: ['https://evil.test']},
    {revision: 0, favoriteAppIds: ['Projects']}, {revision: 0, favoriteAppIds: [' projects']},
    {revision: 0, favoriteAppIds: ['projects\n']}, {revision: 0, favoriteAppIds: ['__proto__']},
    {revision: 0, favoriteAppIds: Array(2)},
    {revision: 0, favoriteAppIds: Array(65).fill('projects')},
  ];
  for (const input of invalid) {
    error(() => store.update(alice, input), 400, 'invalid_input');
    assert.deepEqual(store.get(alice), {revision: 0, favoriteAppIds: []});
  }
});

test('no-op saves are idempotent but stale revisions still conflict', t => {
  const {store} = fixture(t);
  assert.deepEqual(store.update(alice, {revision: 0, favoriteAppIds: []}), {revision: 0, favoriteAppIds: []});
  const first = store.update(alice, {revision: 0, favoriteAppIds: ['projects']});
  assert.deepEqual(store.update(alice, {revision: 1, favoriteAppIds: ['projects', 'projects']}), first);
  error(() => store.update(alice, {revision: 0, favoriteAppIds: ['projects']}), 409, 'revision_conflict');
  assert.deepEqual(store.update(alice, {revision: 1, favoriteAppIds: []}), {revision: 2, favoriteAppIds: []});
});

test('reorder is a change and returned arrays cannot mutate stored favorites', t => {
  const {store} = fixture(t);
  const input = {revision: 0, favoriteAppIds: ['projects', 'knowledge']};
  const first = store.update(alice, input);
  input.favoriteAppIds.push('assessment');
  first.favoriteAppIds.reverse();
  const read = store.get(alice);
  assert.deepEqual(read.favoriteAppIds, ['projects', 'knowledge']);
  read.favoriteAppIds.push('assessment');
  assert.deepEqual(store.update(alice, {revision: 1, favoriteAppIds: ['knowledge', 'projects']}), {
    revision: 2, favoriteAppIds: ['knowledge', 'projects'],
  });
});

test('two connections reject stale writes and recover after rollback', t => {
  const {store, open} = fixture(t);
  const second = open();
  assert.equal(second.get(alice).revision, 0);
  store.update(alice, {revision: 0, favoriteAppIds: ['projects']});
  error(() => second.update(alice, {revision: 0, favoriteAppIds: ['knowledge']}), 409);
  assert.deepEqual(second.get(alice), {revision: 1, favoriteAppIds: ['projects']});
  assert.deepEqual(second.update(alice, {revision: 1, favoriteAppIds: ['knowledge']}), {
    revision: 2, favoriteAppIds: ['knowledge'],
  });
  assert.equal(store.get(alice).revision, 2);
});

test('simultaneous worker connections commit one winner, not two lost-update successes', {timeout: 15000}, async t => {
  const {directory, store} = fixture(t);
  store.close();
  const moduleUrl = new URL('../server/workbench-preferences-store.mjs', import.meta.url).href;
  const code = `
    const {parentPort, workerData} = require('node:worker_threads');
    import(workerData.moduleUrl).then(({openWorkbenchPreferencesStore}) => {
      const store = openWorkbenchPreferencesStore({directory:workerData.directory,allowedAppIds:workerData.ids});
      const current = store.get(workerData.actor);
      parentPort.postMessage({ready:current.revision});
      parentPort.once('message', () => {
        let result;
        try {result={value:store.update(workerData.actor,{revision:current.revision,favoriteAppIds:[workerData.favorite]})};}
        catch(error){result={status:error.status,code:error.code};}
        finally {store.close();}
        parentPort.postMessage(result);
        parentPort.close();
      });
    }).catch(error=>{throw error;});`;
  const workers = ['projects', 'knowledge'].map(favorite => new Worker(code, {
    eval: true, workerData: {moduleUrl, directory, ids, actor: alice, favorite},
  }));
  try {
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready.map(([value]) => value.ready), [0, 0]);
    const results = workers.map(worker => once(worker, 'message'));
    for (const worker of workers) worker.postMessage('go');
    const values = (await Promise.all(results)).map(([value]) => value);
    assert.equal(values.filter(value => value.value?.revision === 1).length, 1);
    assert.equal(values.filter(value => value.status === 409).length, 1);
    const reopened = openWorkbenchPreferencesStore({directory, allowedAppIds: ids});
    try {assert.deepEqual(reopened.get(alice), values.find(value => value.value).value);}
    finally {reopened.close();}
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});

test('a failed clock rolls back fully and a subsequent valid write succeeds', t => {
  let failClock = true;
  const {store} = fixture(t, {now: () => {if (failClock) throw new Error('/private/clock details'); return 1700000000000;}});
  error(() => store.update(alice, {revision: 0, favoriteAppIds: ['projects']}), 503);
  assert.deepEqual(store.get(alice), {revision: 0, favoriteAppIds: []});
  failClock = false;
  assert.equal(store.update(alice, {revision: 0, favoriteAppIds: ['knowledge']}).revision, 1);
});

test('invalid clock values fail without persisting half a change', t => {
  for (const time of [NaN, Infinity, -1, 1.5, '1700000000000']) {
    const {store} = fixture(t, {now: () => time});
    error(() => store.update(alice, {revision: 0, favoriteAppIds: ['projects']}), 503);
    assert.equal(store.get(alice).revision, 0);
  }
});

test('removed catalog entries are filtered, revision retained, new entries need a fresh store', t => {
  const catalog = new Set(ids);
  const {store, open} = fixture(t, {allowedAppIds: catalog});
  store.update(alice, {revision: 0, favoriteAppIds: ['knowledge', 'projects']});
  catalog.add('untrusted');
  error(() => store.update(alice, {revision: 1, favoriteAppIds: ['untrusted']}), 400);
  store.close();
  const reduced = open({allowedAppIds: ['projects']});
  assert.deepEqual(reduced.get(alice), {revision: 1, favoriteAppIds: ['projects']});
  assert.deepEqual(reduced.update(alice, {revision: 1, favoriteAppIds: []}), {revision: 2, favoriteAppIds: []});
});

test('directory, database and WAL/SHM files are private; only its own database is created', t => {
  const {directory, store, open} = fixture(t);
  store.update(alice, {revision: 0, favoriteAppIds: ['projects']});
  const check = () => {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    for (const name of readdirSync(directory)) {
      assert.ok(name.startsWith(dbName), name);
      assert.equal(lstatSync(join(directory, name)).mode & 0o777, 0o600, name);
    }
  };
  check();
  chmodSync(directory, 0o755);
  for (const name of readdirSync(directory)) chmodSync(join(directory, name), 0o644);
  open();
  check();
});

test('rejects symlinked directory, database and sidecars without modifying targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'cobuild-preferences-links-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const target = join(root, 'target');mkdirSync(target);
  const link = join(root, 'link');symlinkSync(target, link);
  error(() => openWorkbenchPreferencesStore({directory: link, allowedAppIds: ids}), 503);
  assert.deepEqual(readdirSync(target), []);
  const sentinel = join(root, 'sentinel');writeFileSync(sentinel, 'untouched', {mode: 0o644});
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const dir = join(root, 'dir' + (suffix || '-db'));mkdirSync(dir);
    symlinkSync(sentinel, join(dir, dbName + suffix));
    error(() => openWorkbenchPreferencesStore({directory: dir, allowedAppIds: ids}), 503);
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
    assert.equal(lstatSync(sentinel).mode & 0o777, 0o644);
  }
});

test('rejects hardlinked database before changing file permissions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-preferences-hardlink-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const target = join(dir, 'target');writeFileSync(target, 'untouched', {mode: 0o644});
  linkSync(target, join(dir, dbName));
  error(() => openWorkbenchPreferencesStore({directory: dir, allowedAppIds: ids}), 503);
  assert.equal(lstatSync(target).mode & 0o777, 0o644);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

test('corrupt files and incompatible schemas fail with safe errors', t => {
  for (const schema of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'cobuild-preferences-corrupt-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const path = join(dir, dbName);
    if (schema) {
      const db = new DatabaseSync(path);db.exec('CREATE TABLE workbench_preferences(wrong TEXT)');db.close();
    } else writeFileSync(path, 'sensitive invalid database content');
    error(() => openWorkbenchPreferencesStore({directory: dir, allowedAppIds: ids}), 503);
  }
});

test('malformed stored favorites fail closed rather than leaking or silently resetting a user', t => {
  const {directory, store} = fixture(t);
  store.update(alice, {revision: 0, favoriteAppIds: ['projects']});
  const db = new DatabaseSync(join(directory, dbName));
  try {
    for (const content of ['bad-json', '{}', '["projects","projects"]', '[123]', '["../../secret"]']) {
      db.prepare('UPDATE workbench_preferences SET favorite_app_ids=?').run(content);
      error(() => store.get(alice), 503);
    }
  } finally {db.close();}
});

test('empty catalog is valid and configuration failures are explicit and safe', t => {
  const {store} = fixture(t, {allowedAppIds: []});
  assert.deepEqual(store.get(alice), {revision: 0, favoriteAppIds: []});
  error(() => store.update(alice, {revision: 0, favoriteAppIds: ['projects']}), 400);
  for (const options of [undefined, null, [], 42, {}, {directory: '', allowedAppIds: ids},
    {directory: '/unused', allowedAppIds: 'projects'}, {directory: '/unused', allowedAppIds: ['https://evil.test']},
    {directory: '/unused', allowedAppIds: ids, now: 1}, {directory: '/unused\u0000', allowedAppIds: ids}]) {
    error(() => openWorkbenchPreferencesStore(options), 500, 'configuration');
  }
});

test('close is idempotent and closed stores return safe unavailable errors', t => {
  const {store} = fixture(t);
  store.close();store.close();
  error(() => store.get(alice), 503);
  error(() => store.update(alice, {revision: 0, favoriteAppIds: []}), 503);
});
