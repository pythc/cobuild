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
const { GroupService } = require('../dist/core/group/services/group.service');
const { GroupUserService } = require('../dist/core/group/services/group-user.service');
const { SpaceMemberRepo } = require('../dist/database/repos/space/space-member.repo');
const { departmentGroupPrefix } = require('../dist/core/feishu/feishu-department-sync');
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
  assert.equal((await db.selectFrom('workspaces').select('id').execute()).length, 0);
  const { id: workspaceId } = await db.insertInto('workspaces').values({ name: 'Department sync tests' }).returning('id').executeTakeFirstOrThrow();
  const groups = new GroupRepo(db), users = new UserRepo(db), memberships = new GroupUserRepo(db, groups, users);
  await groups.createDefaultGroup(workspaceId, {});
  const manual = await groups.insertGroup({ name: '飞书 · Root / Dev', isDefault: false, workspaceId });
  const api = { appId: 'org-app', tenant: 'org-tenant' }, scope = { ...api, workspaceId };
  const provider = {};
  const config = new ConfigService({ FEISHU_SYNC_ENABLED: 'true', FEISHU_DEPARTMENT_SYNC_ENABLED: 'true', FEISHU_APP_ID: api.appId, FEISHU_TENANT_KEY: api.tenant });
  const service = new FeishuDirectoryService(db, config, api, provider, users, memberships);
  service.requestSync = () => {};
  const member = (subject, status='active') => ({ subject, status, name: subject, avatarUrl: null });
  const dept = (id, path, subjects, parentId='0') => ({ id, parentId, name: path.split(' / ').pop(), path, subjects });
  let view = [dept('od-root', 'Root', ['one','two']), dept('od-dev', 'Root / Dev', ['one'], 'od-root'), dept('od-product', 'Root / Product', ['two'], 'od-root')];
  let members = [member('one'),member('two')];
  const apply = (startedAt=new Date(), departments=view) => service.applySnapshot({ startedAt, members, departments });
  const get = id => db.selectFrom('groups').selectAll().where('scimExternalId', '=', departmentGroupPrefix(scope)+id).executeTakeFirstOrThrow();
  const ids = async id => memberships.getUserIdsByGroupId((await get(id)).id);
  await check('creates read-only department groups without modifying a conflicting manual group', async () => {
    await apply();
    const dev = await get('od-dev'); assert.ok(dev.isExternal); assert.notEqual(dev.id,manual.id); assert.notEqual(dev.name,manual.name);
    assert.equal((await groups.findById(manual.id,workspaceId)).isExternal,false);
  });
  const one = await db.selectFrom('feishuIdentities').selectAll().where('subject','=','one').executeTakeFirstOrThrow();
  const two = await db.selectFrom('feishuIdentities').selectAll().where('subject','=','two').executeTakeFirstOrThrow();
  await memberships.insertGroupUser({ userId: one.userId, groupId: manual.id });
  const originalDev = await get('od-dev');
  const space = await db.insertInto('spaces').values({ name:'Dev docs',slug:'dev-test', workspaceId }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('spaceMembers').values({ groupId:originalDev.id,spaceId:space.id,role:'reader' }).execute();
  const access = new SpaceMemberRepo(db,groups,{},{});
  await check('real space access follows department membership', async () => {
    assert.deepEqual(await access.getUserIdsWithSpaceAccess([one.userId,two.userId],space.id), new Set([one.userId]));
    assert.deepEqual(new Set(await ids('od-root')), new Set([one.userId,two.userId]));
  });
  await check('renaming retains the group ID and its space grants', async () => {
    view[1] = dept('od-dev','Root / Engineering',['one'],'od-root'); await apply();
    assert.equal((await get('od-dev')).id,originalDev.id);
    assert.equal((await get('od-dev')).name,'飞书 · Root / Engineering');
    assert.deepEqual(await access.getUserIdsWithSpaceAccess([one.userId],space.id),new Set([one.userId]));
  });
  await check('transfer removes old department access and grants only the new membership', async () => {
    view[1].subjects=[];view[2].subjects=['one','two'];await apply();
    assert.equal((await ids('od-dev')).length,0); assert.equal((await ids('od-product')).length,2);
    assert.equal((await access.getUserIdsWithSpaceAccess([one.userId],space.id)).size,0);
  });
  await check('repeated snapshots neither duplicate groups nor members', async () => {
    await apply();await apply();
    assert.equal((await db.selectFrom('groups').select('id').where('isExternal','=',true).execute()).length,3);
    assert.equal((await ids('od-product')).length,2);
  });
  await check('out-of-scope members lose every department membership', async () => {
    members=[member('one')];await apply();
    for(const d of view) assert.ok(!(await ids(d.id)).includes(two.userId));
  });
  await check('a fresh reactivation restores only current departments', async () => {
    members=[member('one'),member('two')];await apply();
    assert.ok((await ids('od-product')).includes(two.userId));assert.equal((await ids('od-dev')).length,0);
  });
  await check('departure events immediately remove all synchronized group memberships', async () => {
    await service.receiveEvent({app_id:api.appId,tenant_key:api.tenant,event_id:'user-departure',object:{open_id:'one'}},'contact.user.deleted_v3');
    for(const d of view) assert.ok(!(await ids(d.id)).includes(one.userId));
    assert.deepEqual(await memberships.getUserIdsByGroupId(manual.id),[one.userId]);
  });
  await apply();
  const oldStart = new Date(Date.now()-1000);
  await check('department deletion retires the group and removes inherited stale memberships', async () => {
    await service.receiveEvent({app_id:api.appId,tenant_key:api.tenant,event_id:'dept-departure',object:{open_department_id:'od-product'}},'contact.department.deleted_v3');
    assert.ok((await get('od-product')).deletedAt);
    assert.equal((await ids('od-product')).length,0);assert.equal((await ids('od-root')).length,0);
  });
  await check('an in-flight stale snapshot cannot resurrect a deleted department', async () => {
    await apply(oldStart);assert.ok((await get('od-product')).deletedAt);assert.equal((await ids('od-product')).length,0);
  });
  await check('new department with same display name never inherits the deleted group ID or grants', async () => {
    const old=await get('od-product');
    view=[dept('od-root','Root',['one','two']),dept('od-dev','Root / Engineering',['one'],'od-root'),dept('od-new-product','Root / Product',['two'],'od-root')];await apply();
    const replacement=await get('od-new-product');assert.notEqual(replacement.id,old.id);
    assert.equal((await db.selectFrom('spaceMembers').select('id').where('groupId','=',replacement.id).execute()).length,0);
    assert.ok((await get('od-product')).deletedAt);
  });
  const audit = {log(){}};
  const groupService = new GroupService(groups,memberships,null,null,null,null,db,audit);
  const userService = new GroupUserService(memberships,null,users,groupService,null,null,db,audit);
  await check('normal APIs reject editing or deleting synchronized groups', async () => {
    await assert.rejects(()=>groupService.updateGroup(workspaceId,{groupId:originalDev.id,name:'Manual overwrite'}));
    await assert.rejects(()=>groupService.deleteGroup(originalDev.id,workspaceId));
  });
  await check('all ordinary membership mutation entry points reject managed groups', async () => {
    await assert.rejects(()=>userService.addUsersToGroupBatch([two.userId],originalDev.id,workspaceId));
    await assert.rejects(()=>userService.removeUserFromGroup(one.userId,originalDev.id,workspaceId));
    await assert.rejects(()=>memberships.addUserToGroup(two.userId,originalDev.id,workspaceId));
  });
  await check('inactive local accounts cannot be re-added to synced groups', async () => {
    await users.updateUser({deactivatedAt:new Date()},one.userId,workspaceId);await apply();
    for(const d of view) assert.ok(!(await ids(d.id)).includes(one.userId));
    await users.updateUser({deactivatedAt:null},one.userId,workspaceId);await apply();
  });
  await check('failure reading the organization leaves existing groups and grants unchanged', async () => {
    const before=await ids('od-dev');provider.snapshot=async()=>{throw new Error('upstream incomplete')};
    assert.equal((await service.sync('test-failure')).status,'failed');
    assert.deepEqual(await ids('od-dev'),before);
  });
  const foreignScope={appId:'other-app',tenant:'other-tenant',workspaceId};
  const foreignGroup=await groups.insertGroup({name:'Foreign directory',workspaceId,isDefault:false,isExternal:true,scimExternalId:departmentGroupPrefix(foreignScope)+'od-foreign'});
  await memberships.insertGroupUser({groupId:foreignGroup.id,userId:one.userId});
  await check('disabling department sync retires only this app/tenant managed groups',async()=>{
    await apply(new Date(),[]);
    for(const d of view){assert.ok((await get(d.id)).deletedAt);assert.equal((await ids(d.id)).length,0)}
    assert.deepEqual(await memberships.getUserIdsByGroupId(foreignGroup.id),[one.userId]);
    assert.deepEqual(await memberships.getUserIdsByGroupId(manual.id),[one.userId]);
  });
  await check('reenabling uses stable department IDs and existing grants only',async()=>{
    await apply();assert.equal((await get('od-dev')).id,originalDev.id);
    assert.deepEqual(await access.getUserIdsWithSpaceAccess([one.userId],space.id),new Set([one.userId]));
  });
  console.log(JSON.stringify({passed,schemaOnly:true,productionRowsUsed:false}));
}
main().finally(()=>db.destroy()).catch(error=>{console.error(error.message);process.exitCode=1});
