// Run against an empty schema clone only; never points at the application database.
const assert = require('node:assert/strict');
const { Kysely, CamelCasePlugin } = require('kysely');
const { PostgresJSDialect } = require('kysely-postgres-js');
const postgres = require('postgres');
const { ConfigService } = require('@nestjs/config');
const { SearchService } = require('../dist/core/search/search.service');
const { FeishuDirectoryService } = require('../dist/core/feishu/feishu-directory.service');
const { GroupRepo } = require('../dist/database/repos/group/group.repo');
const { GroupUserRepo } = require('../dist/database/repos/group/group-user.repo');
const { UserRepo } = require('../dist/database/repos/user/user.repo');
const database = process.env.KNOWLEDGE_TEST_DATABASE;
assert.match(database || '', /^kb_groups_test_[0-9]+$/);
const url = new URL(process.env.DATABASE_URL);
assert.notEqual(url.pathname.slice(1), database);
url.pathname = '/' + database;
const db = new Kysely({ dialect: new PostgresJSDialect({ postgres: postgres(url.toString(), { max: 3, onnotice() {} }) }), plugins: [new CamelCasePlugin()] });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function main() {
  assert.equal((await db.selectFrom('workspaces').select('id').execute()).length, 0, 'test schema must contain no production rows');
  const workspace = await db.insertInto('workspaces').values({ name: 'Group tests' }).returning('id').executeTakeFirstOrThrow();
  const foreign = await db.insertInto('workspaces').values({ name: 'Other workspace' }).returning('id').executeTakeFirstOrThrow();
  const groups = new GroupRepo(db), users = new UserRepo(db);
  const memberships = new GroupUserRepo(db, groups, users);
  const system = await groups.createDefaultGroup(workspace.id, {});
  const manual = await groups.insertGroup({ name: '全体成员', isDefault: false, workspaceId: workspace.id });
  const hidden = await groups.insertGroup({ name: '全体成员已删', isDefault: false, workspaceId: workspace.id, deletedAt: new Date() });
  const foreignGroup = await groups.createDefaultGroup(foreign.id, {});
  const config = new ConfigService({ FEISHU_APP_ID: 'test-app', FEISHU_TENANT_KEY: 'test-tenant', FEISHU_SYNC_ENABLED: 'true' });
  const api = { appId: 'test-app', tenant: 'test-tenant' };
  const service = new FeishuDirectoryService(db, config, api, {}, users, memberships);
  service.requestSync = () => {}; // Events must not contact a real directory.
  const search = new SearchService(db, {}, {}, {}, {}, config);
  const suggest = (query) => search.searchSuggestions({ query, includeGroups: true, includeUsers: true }, 'unused', workspace.id);
  await check('empty search includes default first and excludes deleted/foreign groups', async () => {
    const result = await suggest('');
    assert.deepEqual(result.groups.map(g => g.id), [system.id, manual.id]);
    assert.equal(result.groups[0].isDefault, true);
  });
  await check('Chinese/English display labels and custom names are searchable', async () => {
    for (const q of ['全体成员', '全体', '自动同步', 'ALL MEMBERS', 'Everyone']) assert.ok((await suggest(q)).groups.some(g => g.id === system.id));
    assert.ok((await suggest('全体成员')).groups.some(g => g.id === manual.id));
    assert.equal((await suggest('does not exist')).groups.length, 0);
  });
  await check('paginated group settings use the same localized search and workspace scope', async () => {
    const result = await groups.getGroupsPaginated(workspace.id, { query: '全体成员', limit: 10 });
    assert.deepEqual(new Set(result.items.map(g => g.id)), new Set([system.id, manual.id]));
  });
  const member = (subject, status = 'active', name = subject) => ({ subject, name, avatarUrl: null, status });
  const snapshot = (members, startedAt = new Date()) => service.applySnapshot({ members, startedAt });
  const both = [member('one'), member('two')];
  const identity = (subject) => db.selectFrom('feishuIdentities').selectAll().where('subject', '=', subject).executeTakeFirstOrThrow();
  const autoIds = () => memberships.getUserIdsByGroupId(system.id);
  const session = async (who) => db.insertInto('userSessions').values({ userId: who.userId, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 3600000) }).returning('id').executeTakeFirstOrThrow();
  await check('new active members automatically join default group only', async () => {
    await snapshot(both);
    assert.equal((await autoIds()).length, 2);
    assert.equal((await memberships.getUserIdsByGroupId(manual.id)).length, 0);
  });
  const one = await identity('one'), two = await identity('two');
  await memberships.insertGroupUser({ userId: one.userId, groupId: manual.id });
  const oneSession = await session(one), twoSession = await session(two);
  await check('repeated snapshots are idempotent', async () => { await snapshot(both); await snapshot(both); assert.equal((await autoIds()).length, 2); });
  await check('repairs a missing default membership', async () => {
    await memberships.delete(one.userId, system.id, {}); await snapshot(both); assert.ok((await autoIds()).includes(one.userId));
  });
  await check('frozen member leaves default group while custom group is preserved', async () => {
    await snapshot([member('one', 'frozen'), member('two')]);
    assert.deepEqual(await autoIds(), [two.userId]);
    assert.deepEqual(await memberships.getUserIdsByGroupId(manual.id), [one.userId]);
    assert.equal((await identity('one')).directoryStatus, 'frozen');
    assert.ok((await db.selectFrom('userSessions').select('revokedAt').where('id', '=', oneSession.id).executeTakeFirstOrThrow()).revokedAt);
  });
  await check('reactivated member rejoins without duplicates or role changes', async () => {
    await snapshot(both); assert.equal((await autoIds()).length, 2);
    assert.equal((await users.findById(one.userId, workspace.id)).role, 'member');
  });
  await check('out-of-scope member is removed', async () => {
    await snapshot([member('one')]); assert.deepEqual(await autoIds(), [one.userId]); assert.equal((await identity('two')).directoryStatus, 'out_of_scope');
    assert.ok((await db.selectFrom('userSessions').select('revokedAt').where('id', '=', twoSession.id).executeTakeFirstOrThrow()).revokedAt);
  });
  const eventSession = await session(one);
  const beforeEvent = new Date(Date.now() - 1000);
  await check('negative event removes membership immediately', async () => {
    await service.receiveEvent({ app_id: api.appId, tenant_key: api.tenant, event_id: 'delete-one', object: { open_id: 'one' } }, 'contact.user.deleted_v3');
    assert.equal((await autoIds()).length, 0); assert.equal((await identity('one')).directoryStatus, 'resigned');
    assert.ok((await db.selectFrom('userSessions').select('revokedAt').where('id', '=', eventSession.id).executeTakeFirstOrThrow()).revokedAt);
  });
  await check('older snapshot cannot reverse a newer departure event', async () => {
    await snapshot([member('one')], beforeEvent); assert.equal((await autoIds()).length, 0); assert.equal((await identity('one')).directoryStatus, 'resigned');
  });
  await check('fresh reactivation after the event can rejoin', async () => { await snapshot([member('one')]); assert.deepEqual(await autoIds(), [one.userId]); });
  await check('locally deactivated member is not automatically re-added', async () => {
    await users.updateUser({ deactivatedAt: new Date() }, one.userId, workspace.id); await snapshot([member('one')]); assert.equal((await autoIds()).length, 0);
  });
  await check('local reactivation is repaired by the next sync', async () => {
    await users.updateUser({ deactivatedAt: null }, one.userId, workspace.id); await snapshot([member('one')]); assert.deepEqual(await autoIds(), [one.userId]);
  });
  await check('membership removal is scoped to the target workspace', async () => {
    await memberships.insertGroupUser({ userId: one.userId, groupId: foreignGroup.id });
    await db.transaction().execute(trx => memberships.removeUserFromDefaultGroup(one.userId, workspace.id, trx));
    assert.deepEqual(await memberships.getUserIdsByGroupId(foreignGroup.id), [one.userId]);
    assert.equal((await autoIds()).length, 0); await snapshot([member('one')]);
  });
  await check('locally deleted member stays excluded', async () => {
    await users.updateUser({ deletedAt: new Date() }, one.userId, workspace.id); await snapshot([member('one')]); assert.equal((await autoIds()).length, 0);
  });
  await check('unactivated new member is not provisioned', async () => {
    await snapshot([member('new-unactivated', 'unactivated')]);
    assert.equal((await db.selectFrom('feishuIdentities').select('id').where('subject', '=', 'new-unactivated').execute()).length, 0);
  });
  await users.updateUser({ deletedAt: null }, one.userId, workspace.id);
  await snapshot([member('one')]);
  await check('failed group update rolls back directory/name updates atomically', async () => {
    const add = memberships.addUserToDefaultGroup;
    memberships.addUserToDefaultGroup = async () => { throw new Error('injected failure'); };
    try { await assert.rejects(() => snapshot([member('one', 'active', 'should roll back')]), /injected failure/); }
    finally { memberships.addUserToDefaultGroup = add; }
    assert.equal((await users.findById(one.userId, workspace.id)).name, 'one');
    assert.deepEqual(await autoIds(), [one.userId]);
  });
  await check('no lifecycle step modified the manually managed group', async () => assert.deepEqual(await memberships.getUserIdsByGroupId(manual.id), [one.userId]));
  console.log(JSON.stringify({ passed, schemaOnly: true, productionRowsUsed: false }));
}
main().finally(() => db.destroy()).catch((error) => { console.error(error.message); process.exitCode = 1; });
