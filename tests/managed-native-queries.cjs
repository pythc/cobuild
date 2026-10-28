// Exercise the native bulk-recipient SQL against the disposable suite database.
// All changes below are rolled back; no notifications or messages are sent.
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');
const req=createRequire(resolve('integrations/weknow/source/apps/server/package.json'));
const {Kysely,CamelCasePlugin}=req('kysely');
const {PostgresJSDialect}=req('kysely-postgres-js');
const {SpaceMemberRepo}=req('./dist/database/repos/space/space-member.repo');
const db=new Kysely({dialect:new PostgresJSDialect({postgres:req('postgres')(process.env.DATABASE_URL,{max:1})}),plugins:[new CamelCasePlugin()]});
let checks=0;
const rollback=new Error('Expected fixture rollback');
(async()=>{
 try{
  await db.transaction().execute(async trx=>{
   const managed=await trx.selectFrom('suiteManagedSpaces').select('spaceId').executeTakeFirstOrThrow();
   const users=await trx.selectFrom('suiteIdentityAccounts').select('userId').limit(2).execute();
   assert.equal(users.length,2);const ids=users.map(u=>u.userId);
   const shared=await trx.selectFrom('spaces').select('id').where('slug','=','legacy-shared-fixture').executeTakeFirstOrThrow();
   for(const spaceId of [managed.spaceId,shared.id]){
    await trx.deleteFrom('spaceMembers').where('spaceId','=',spaceId).where('userId','in',ids).execute();
    await trx.insertInto('spaceMembers').values(ids.map(userId=>({spaceId,userId,role:'writer'}))).execute();
   }
   await trx.deleteFrom('suiteManagedAccess').where('spaceId','=',managed.spaceId).execute();
   await trx.insertInto('suiteManagedAccess').values({spaceId:managed.spaceId,userId:ids[0],expiresAt:new Date(Date.now()+60000)}).execute();
   const repo=new SpaceMemberRepo(trx,null,null,null);
   assert.deepEqual([...await repo.getUserIdsWithSpaceAccess(ids,managed.spaceId)],[ids[0]]);checks++;
   await trx.updateTable('suiteManagedAccess').set({expiresAt:new Date(0)}).where('spaceId','=',managed.spaceId).execute();
   assert.equal((await repo.getUserIdsWithSpaceAccess(ids,managed.spaceId)).size,0);checks++;
   assert.deepEqual([...await repo.getUserIdsWithSpaceAccess(ids,shared.id)].sort(),ids.slice().sort());checks++;
   assert.equal((await repo.getUserIdsWithSpaceAccess([],shared.id)).size,0);checks++;
   throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;}finally{await db.destroy();}
 console.log(JSON.stringify({passed:true,checks,scope:'native bulk ACL SQL; transaction rolled back'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
