// Schema-only clone. This suite never copies production people/documents/tokens.
const assert = require('node:assert/strict');
const { Kysely, CamelCasePlugin, sql } = require('kysely');
const { PostgresJSDialect } = require('kysely-postgres-js');
const postgres = require('postgres');
const { ConfigService } = require('@nestjs/config');
const { randomUUID } = require('node:crypto');
const { ensurePersonalSpace, queuePersonalHandoff, PersonalSpaceService } = require('../dist/core/space/services/personal-space.service');
const { SpaceMemberRepo } = require('../dist/database/repos/space/space-member.repo');
const { SpaceRepo } = require('../dist/database/repos/space/space.repo');
const { PageRepo } = require('../dist/database/repos/page/page.repo');
const { PagePermissionRepo } = require('../dist/database/repos/page/page-permission.repo');
const SpaceAbility = require('../dist/core/casl/abilities/space-ability.factory').default;
const { PageAccessService } = require('../dist/core/page/page-access/page-access.service');
const { SearchService } = require('../dist/core/search/search.service');
const { KnowledgeDocumentService } = require('../dist/core/knowledge/knowledge-document.service');
const { AuthenticationExtension } = require('../dist/collaboration/extensions/authentication.extension');
const { PersistenceExtension } = require('../dist/collaboration/extensions/persistence.extension');
const { AttachmentController } = require('../dist/core/attachment/attachment.controller');
const { FeishuDirectoryService } = require('../dist/core/feishu/feishu-directory.service');
const migration = require('../dist/database/migrations/20261014T180000-personal-knowledge');
const database = process.env.KNOWLEDGE_TEST_DATABASE;
assert.match(database || '', /^kb_personal_test_[0-9]+$/);
const url = new URL(process.env.DATABASE_URL);assert.notEqual(url.pathname.slice(1), database);url.pathname='/' + database;
const db = new Kysely({ dialect: new PostgresJSDialect({ postgres: postgres(url.toString(), { max: 6, onnotice() {} }) }), plugins: [new CamelCasePlugin()] });
let passed = 0;
const check = async(name, fn) => { await fn(); console.log('PASS ' + (++passed) + ' ' + name); };
const denied = fn => assert.rejects(fn, e => [403,404].includes(e.status));
const emitter = { emit() {} };
const cached = new Map();const cache = { get: async k=>cached.get(k), set: async(k,v)=>cached.set(k,v) };
const spaces = new SpaceRepo(db,emitter), members = new SpaceMemberRepo(db,{},spaces,cache), abilities = new SpaceAbility(members);
const pagePerms = new PagePermissionRepo(db,{},cache), pages = new PageRepo(db,members,emitter);
const access = new PageAccessService(pagePerms,abilities,spaces);
const search = new SearchService(db,pages,{},members,pagePerms,new ConfigService());
const doc = new KnowledgeDocumentService(pages,{},access,{},db);
const read = (id,p) => doc.page(id,{ user:p, workspace:{id:p.workspaceId} });
let workspaceId,owner,alice,bob,admin,aliceSpace,root,child,trash,history;
async function person(name, role='member') {
 const u = await db.insertInto('users').values({name,role,email:randomUUID()+'@example.invalid',workspaceId}).returningAll().executeTakeFirstOrThrow();
 await db.insertInto('feishuIdentities').values({provider:'feishu',appId:'personal-test',tenantKey:'test-org',subject:randomUUID(),userId:u.id,workspaceId,directoryStatus:'active',directoryCheckedAt:new Date()}).execute();return u;
}
async function page(spaceId,title,parentPageId=null,deletedAt=null) {
 return db.insertInto('pages').values({title,slugId:randomUUID().slice(0,10),spaceId,workspaceId,parentPageId,creatorId:alice.id,lastUpdatedById:alice.id,
 position:'a0',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Private original'}]}]},ydoc:Buffer.from([1,2,3]),deletedAt}).returningAll().executeTakeFirstOrThrow();
}
async function main() {
 assert.equal((await db.selectFrom('users').select('id').execute()).length,0);
 await db.transaction().execute(trx=>migration.up(trx));
 workspaceId=(await db.insertInto('workspaces').values({name:'Synthetic privacy tests'}).returning('id').executeTakeFirstOrThrow()).id;
 owner=await person('Recipient','owner');alice=await person('Departed');bob=await person('Other');admin=await person('Other admin','admin');
 const config=new ConfigService({PERSONAL_KNOWLEDGE_ENABLED:'true',PERSONAL_KNOWLEDGE_RECIPIENT_ID:owner.id});
 const service=new PersonalSpaceService(db,config);
 await check('concurrent first visits create one private space and one owner grant',async()=>{
  const results=await Promise.all(Array.from({length:5},()=>service.forUser(alice.id,workspaceId)));assert.equal(new Set(results.map(s=>s.id)).size,1);aliceSpace=results[0];
  assert.equal((await db.selectFrom('spaceMembers').selectAll().where('spaceId','=',aliceSpace.id).execute()).length,1);assert.equal(aliceSpace.isPersonal,true);
 });
 root=await page(aliceSpace.id,'Secret alpha');child=await page(aliceSpace.id,'Secret child',root.id);trash=await page(aliceSpace.id,'Secret trash',null,new Date());
 history=await db.insertInto('pageHistory').values({pageId:root.id,spaceId:aliceSpace.id,workspaceId,title:'Original history',content:root.content}).returningAll().executeTakeFirstOrThrow();
 const attachment=await db.insertInto('attachments').values({pageId:root.id,spaceId:aliceSpace.id,workspaceId,creatorId:alice.id,filePath:'synthetic/original.bin',fileName:'private.txt',fileExt:'.txt',fileSize:7}).returningAll().executeTakeFirstOrThrow();
 await check('owner can view/edit through document API and MCP shared ACL',async()=>{await access.validateCanView(root,alice);await access.validateCanEdit(root,alice);assert.equal((await read(root.id,alice)).id,root.id);});
 await check('another member, admin and workspace owner cannot read personal documents',async()=>{for(const u of[bob,admin,owner]) {await denied(()=>read(root.id,u));await denied(()=>access.validateCanEdit(root,u));}});
 await check('personal permission does not expose membership, settings mutation or public sharing',async()=>{const a=await abilities.createForUser(alice,aliceSpace.id);assert.equal(a.can('manage','page'),true);for(const s of['member','share','settings'])assert.equal(a.can('manage',s),false);});
 await check('admin workspace space catalog omits all personal metadata',async()=>{assert.equal((await spaces.getSpacesInWorkspace(workspaceId,{limit:100})).items.length,0);});
 await check('global search and mentions hide private titles from other people',async()=>{for(const u of[bob,admin,owner]){assert.equal((await search.searchPage({query:'Secret',titleOnly:true},{userId:u.id,workspaceId})).items.length,0);assert.equal((await search.searchSuggestions({query:'Secret',includePages:true},u.id,workspaceId)).pages.length,0);}assert.ok((await search.searchPage({query:'Secret',titleOnly:true},{userId:alice.id,workspaceId})).items.length>=1);});
 await check('database refuses direct and group grants including admin grant endpoints',async()=>{const g=await db.insertInto('groups').values({name:'Everyone',workspaceId,isDefault:false}).returning('id').executeTakeFirstOrThrow();for(const grant of[{userId:admin.id},{groupId:g.id}])await assert.rejects(()=>db.insertInto('spaceMembers').values({spaceId:aliceSpace.id,role:'admin',...grant}).execute(),e=>e.code==='23514');});
 await check('database refuses public page links and public space publishing',async()=>{await assert.rejects(()=>db.insertInto('shares').values({key:randomUUID(),pageId:root.id,spaceId:aliceSpace.id,workspaceId}).execute(),e=>e.code==='23514');await assert.rejects(()=>db.insertInto('publicSpaces').values({spaceId:aliceSpace.id,workspaceId}).execute(),e=>e.code==='23514');});
 await check('ownership, privacy flag and hard deletion cannot be changed',async()=>{await assert.rejects(()=>db.updateTable('spaces').set({creatorId:admin.id}).where('id','=',aliceSpace.id).execute());await assert.rejects(()=>db.updateTable('spaces').set({isPersonal:false}).where('id','=',aliceSpace.id).execute());await assert.rejects(()=>db.deleteFrom('spaces').where('id','=',aliceSpace.id).execute());});
 await check('normal shared space grant, read and deletion still work',async()=>{const s=await db.insertInto('spaces').values({slug:randomUUID(),workspaceId,name:'Shared'}).returningAll().executeTakeFirstOrThrow();await db.insertInto('spaceMembers').values({spaceId:s.id,userId:bob.id,role:'reader'}).execute();assert.equal((await abilities.createForUser(bob,s.id)).can('read','page'),true);await spaces.deleteSpace(s.id,workspaceId);assert.equal(await spaces.findById(s.id,workspaceId),undefined);});
 await check('public signed attachment path rejects a personal space',async()=>{const c=new AttachmentController(null,null,null,null,pages,spaces,null,null,null,null,null,null);assert.equal(await c.spaceAbilityPublicAllowed(aliceSpace.id,workspaceId),false); const signed=new AttachmentController(null,null,null,null,pages,spaces,{findById:async()=>attachment},null,{verifyJwt:async()=>({attachmentId:attachment.id,workspaceId,pageId:root.id})},null,null,null);await denied(()=>signed.getPublicFile({}, {}, {id:workspaceId}, attachment.id, 'private.txt', 'synthetic-token'));});
 await check('frozen, unactivated, unknown and out-of-scope never enqueue a handoff',async()=>{for(const s of['frozen','unactivated','unknown','out_of_scope'])await db.transaction().execute(t=>queuePersonalHandoff(t,alice.id,workspaceId,s));assert.equal((await db.selectFrom('personalHandoffs').selectAll().execute()).length,0);});
 const ident=await db.selectFrom('feishuIdentities').selectAll().where('userId','=',alice.id).executeTakeFirstOrThrow();
 const directory=new FeishuDirectoryService(db,new ConfigService({FEISHU_SYNC_ENABLED:'true',FEISHU_APP_ID:'personal-test',FEISHU_TENANT_KEY:'test-org'}),{provider:'feishu',appId:'personal-test',tenant:'test-org'},{},{},{removeUserFromDefaultGroup:async()=>{}});directory.requestSync=()=>{};
 await check('real departure handler enqueues a durable handoff and duplicate events do not duplicate it',async()=>{const e={app_id:'personal-test',tenant_key:'test-org',event_id:'departure-1',object:{open_id:ident.subject}};await directory.receiveEvent(e,'contact.user.deleted_v3');await directory.receiveEvent(e,'contact.user.deleted_v3');assert.equal((await db.selectFrom('personalHandoffs').selectAll().execute()).length,1);});
 await check('missing recipient retains pending data for retry; no loss or partial directory',async()=>{const bad=new PersonalSpaceService(db,new ConfigService({PERSONAL_KNOWLEDGE_RECIPIENT_ID:bob.id}));await assert.rejects(()=>bad.transfer(aliceSpace.id));assert.equal((await db.selectFrom('pages').select('spaceId').where('id','=',root.id).executeTakeFirstOrThrow()).spaceId,aliceSpace.id);assert.equal((await db.selectFrom('personalHandoffs').select('state').where('sourceSpaceId','=',aliceSpace.id).executeTakeFirstOrThrow()).state,'pending');});
 await check('failure after directory creation rolls back the entire transfer',async()=>{
  await sql.raw("create function test_fail_move() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$; create trigger test_fail_move before update on attachments for each row execute function test_fail_move();").execute(db);
  await assert.rejects(()=>service.transfer(aliceSpace.id));
  await sql.raw('drop trigger test_fail_move on attachments; drop function test_fail_move();').execute(db);
  const t=await spaces.findPersonalSpace(owner.id,workspaceId);assert.equal(t,undefined);
  assert.equal((await db.selectFrom('pages').select('spaceId').where('id','=',root.id).executeTakeFirstOrThrow()).spaceId,aliceSpace.id);
 });
 await check('restart and concurrent processing complete exactly one transfer',async()=>{const restarted=new PersonalSpaceService(db,config);await Promise.all([restarted.transfer(aliceSpace.id),service.transfer(aliceSpace.id)]);const h=await db.selectFrom('personalHandoffs').selectAll().where('sourceSpaceId','=',aliceSpace.id).executeTakeFirstOrThrow();assert.equal(h.state,'done');assert.equal(h.pageCount,3);assert.equal(h.recipientId,owner.id);assert.equal((await db.selectFrom('pages').selectAll().where('id','=',h.folderId).executeTakeFirstOrThrow()).title,alice.name);});
 const handoff=await db.selectFrom('personalHandoffs').selectAll().where('sourceSpaceId','=',aliceSpace.id).executeTakeFirstOrThrow();const target=await spaces.findPersonalSpace(owner.id,workspaceId);
 await check('document bytes, authors, IDs, nested hierarchy and trash survive transfer',async()=>{const r=await db.selectFrom('pages').selectAll().where('id','=',root.id).executeTakeFirstOrThrow();assert.deepEqual(r.content,root.content);assert.deepEqual(r.ydoc,root.ydoc);assert.equal(r.creatorId,alice.id);assert.equal(r.parentPageId,handoff.folderId);assert.equal(r.spaceId,target.id);assert.equal((await db.selectFrom('pages').selectAll().where('id','=',child.id).executeTakeFirstOrThrow()).parentPageId,root.id);assert.ok((await db.selectFrom('pages').selectAll().where('id','=',trash.id).executeTakeFirstOrThrow()).deletedAt);});
 await check('history and attachments keep original contents and storage path',async()=>{const h=await db.selectFrom('pageHistory').selectAll().where('id','=',history.id).executeTakeFirstOrThrow();assert.deepEqual(h.content,history.content);assert.equal(h.spaceId,target.id);const a=await db.selectFrom('attachments').selectAll().where('id','=',attachment.id).executeTakeFirstOrThrow();assert.equal(a.filePath,attachment.filePath);assert.equal(a.spaceId,target.id);});
 await check('only pinned recipient can read transferred data; old owner and other admin cannot',async()=>{assert.equal((await read(root.id,owner)).id,root.id);for(const u of[alice,bob,admin])await denied(()=>read(root.id,u));});
 await check('an in-flight create cannot insert into the archived source space',async()=>{await assert.rejects(()=>page(aliceSpace.id,'Late write'),e=>e.code==='23514');});
 await check('an already-open departed editor cannot persist edits after transfer',async()=>{
  const {TiptapTransformer}=require('@hocuspocus/transformer');const {tiptapExtensions}=require('../dist/collaboration/collaboration.util');
  const y=TiptapTransformer.toYdoc({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Unauthorized late edit'}]}]},'default',tiptapExtensions);
  const storage=new PersistenceExtension(pages,db,null,null,null,null,null);
  await storage.onStoreDocument({documentName:'page.'+root.id,document:y,lastContext:{user:alice}});
  assert.deepEqual((await db.selectFrom('pages').select('content').where('id','=',root.id).executeTakeFirstOrThrow()).content,root.content);y.destroy();
 });
 await check('departed user cannot provision a replacement space',async()=>{await assert.rejects(()=>service.forUser(alice.id,workspaceId));});
 await check('stale active author collab socket cannot reconnect to transferred document',async()=>{const auth=new AuthenticationExtension({verifyJwt:async()=>({sub:alice.id,workspaceId,sessionId:'fake'})},{validate:async()=>alice},null,pages,members,pagePerms);await assert.rejects(()=>auth.onAuthenticate({documentName:'page.'+root.id,token:'x',connectionConfig:{}}));});
 await check('reactivation creates empty personal knowledge without reversing handoff',async()=>{await db.updateTable('feishuIdentities').set({directoryStatus:'active'}).where('userId','=',alice.id).execute();const s=await service.forUser(alice.id,workspaceId);assert.notEqual(s.id,aliceSpace.id);assert.equal((await db.selectFrom('pages').select('id').where('spaceId','=',s.id).execute()).length,0);assert.equal((await read(root.id,owner)).id,root.id);});
 await check('repeated reconcile and retry never duplicate the completed archive',async()=>{await service.reconcile();await service.transfer(aliceSpace.id);assert.equal((await db.selectFrom('pages').select('id').where('id','=',handoff.folderId).execute()).length,1);assert.equal((await db.selectFrom('personalHandoffs').selectAll().where('state','=','done').execute()).length,1);});
 await check('corrected active state cancels pending departure without moving anything',async()=>{
  const u=await person('Correction');const s=await service.forUser(u.id,workspaceId);await db.updateTable('feishuIdentities').set({directoryStatus:'resigned'}).where('userId','=',u.id).execute();
  await db.transaction().execute(t=>queuePersonalHandoff(t,u.id,workspaceId,'resigned'));await db.updateTable('feishuIdentities').set({directoryStatus:'active'}).where('userId','=',u.id).execute();await service.transfer(s.id);
  assert.equal(await db.selectFrom('personalHandoffs').selectAll().where('sourceSpaceId','=',s.id).executeTakeFirst(),undefined);assert.equal((await service.forUser(u.id,workspaceId)).id,s.id);
 });
 await check('used migration refuses unsafe rollback',async()=>{await assert.rejects(()=>migration.down(db),/privacy guards/);});
 console.log(JSON.stringify({passed}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.destroy());
