// Trusted actors come from the HTTP identity layer. Never accept an owner from
// the request body; a role (including super_admin) cannot select another owner.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, lstatSync, chmodSync, openSync, closeSync} from 'node:fs';
import {join} from 'node:path';

const MAX_FAVORITES = 64;
const APP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT = /^[A-Za-z0-9._+:@-]{1,200}$/;
const roles = new Set(['member', 'admin', 'super_admin']);
const messages = Object.freeze({
  unauthenticated: '请先通过飞书登录',
  forbidden: '当前身份不能操作收藏',
  invalid_input: '请检查收藏内容',
  revision_conflict: '收藏已在其他页面更新，请刷新后重试',
  unavailable: '收藏暂时不可用，请稍后重试',
  configuration: '收藏存储配置无效',
});

export class WorkbenchPreferencesError extends Error {
  constructor(status, message, code = 'unavailable') {
    super(message);
    this.name = 'WorkbenchPreferencesError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new WorkbenchPreferencesError(status, messages[code], code);
}

function owner(actor) {
  if (!actor || typeof actor.subject !== 'string' || !SUBJECT.test(actor.subject)) {
    fail(401, 'unauthenticated');
  }
  if (actor.role !== undefined && !roles.has(actor.role)) fail(403, 'forbidden');
  return actor.subject;
}

function regularPrivateFile(path, create = false) {
  if (create) {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(503, 'unavailable');
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

function secureSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { regularPrivateFile(path + suffix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function openWorkbenchPreferencesStore(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail(500, 'configuration');
  const {directory, allowedAppIds, now = Date.now} = options;
  if (typeof directory !== 'string' || !directory.trim() || /[\u0000-\u001f]/u.test(directory)
      || typeof now !== 'function'
      || !(Array.isArray(allowedAppIds) || allowedAppIds instanceof Set)
      || allowedAppIds.size > 1000 || allowedAppIds.length > 1000) {
    fail(500, 'configuration');
  }
  const allowed = new Set(allowedAppIds);
  if ([...allowed].some(id => typeof id !== 'string' || !APP_ID.test(id))) fail(500, 'configuration');
  const path = join(directory, 'workbench-preferences.sqlite');
  let db;
  let select;
  let write;
  try {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(503, 'unavailable');
    if ((stat.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
    regularPrivateFile(path, true);
    secureSidecars(path);
    db = new DatabaseSync(path);
    db.enableDefensive(true);
    db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workbench_preferences (
        owner_subject TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        favorite_app_ids TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    select = db.prepare('SELECT revision, favorite_app_ids FROM workbench_preferences WHERE owner_subject=?');
    write = db.prepare(`INSERT INTO workbench_preferences(owner_subject, revision, favorite_app_ids, updated_at)
      VALUES(?,?,?,?) ON CONFLICT(owner_subject) DO UPDATE SET
        revision=excluded.revision, favorite_app_ids=excluded.favorite_app_ids, updated_at=excluded.updated_at`);
    secureSidecars(path);
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the safe public error below. */ }
    if (error instanceof WorkbenchPreferencesError) throw error;
    fail(503, 'unavailable');
  }

  let closed = false;

  function read(subject) {
    const row = select.get(subject);
    if (!row) return {revision: 0, favoriteAppIds: []};
    const ids = JSON.parse(row.favorite_app_ids);
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(ids)
        || ids.length > MAX_FAVORITES || ids.some(id => typeof id !== 'string' || !APP_ID.test(id))
        || new Set(ids).size !== ids.length) fail(503, 'unavailable');
    // Removed applications disappear without resetting the user's revision.
    return {revision: row.revision, favoriteAppIds: ids.filter(id => allowed.has(id))};
  }

  function guard(callback) {
    if (closed) fail(503, 'unavailable');
    try { return callback(); }
    catch (error) {
      if (error instanceof WorkbenchPreferencesError) throw error;
      fail(503, 'unavailable');
    }
  }

  return {
    get(actor) {
      const subject = owner(actor);
      return guard(() => read(subject));
    },
    update(actor, input) {
      const subject = owner(actor);
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['revision', 'favoriteAppIds'].includes(key))
          || !Number.isSafeInteger(input.revision) || input.revision < 0
          || !Array.isArray(input.favoriteAppIds) || input.favoriteAppIds.length > MAX_FAVORITES
          || Array.from(input.favoriteAppIds).some(id => typeof id !== 'string' || !allowed.has(id))) {
        fail(400, 'invalid_input');
      }
      const ids = [...new Set(input.favoriteAppIds)];
      return guard(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = read(subject);
          if (current.revision !== input.revision) fail(409, 'revision_conflict');
          const changed = current.favoriteAppIds.length !== ids.length
            || current.favoriteAppIds.some((id, index) => id !== ids[index]);
          let value = current;
          if (changed) {
            const time = now();
            if (!Number.isSafeInteger(time) || time < 0 || current.revision === Number.MAX_SAFE_INTEGER) {
              fail(503, 'unavailable');
            }
            value = {revision: current.revision + 1, favoriteAppIds: ids};
            write.run(subject, value.revision, JSON.stringify(ids), time);
          }
          secureSidecars(path);
          db.exec('COMMIT');
          return value;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* Preserve the original error if SQLite ended the transaction. */ }
          throw error;
        }
      });
    },
    close() {
      if (closed) return;
      return guard(() => {
        db.close();
        closed = true;
        secureSidecars(path);
      });
    },
  };
}
