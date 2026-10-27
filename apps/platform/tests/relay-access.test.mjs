import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {openApplicationAccess} from '../server/application-access.mjs';
test('Relay defaults closed, matches exact live department membership and has no admin bypass',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-scope-'));let time=100000;const admin={subject:'fixture_tenant:on_admin_fixture001',role:'super_admin'};let snap={members:[{...admin,employeeId:'admin'},{subject:'fixture_tenant:on_ops_fixture00001',employeeId:'ops'},{subject:'fixture_tenant:on_other_fixture001',employeeId:'other'}],departments:[{id:'od-ops',subjects:['fixture_tenant:on_ops_fixture00001']}]};let fails=false;
 const store=openApplicationAccess({directory:dir,apps:[{id:'relay',title:'Relay'}],profile:()=>admin,now:()=>time,fetchSnapshot:async()=>{if(fails)throw Error();return {...structuredClone(snap),syncedAt:time};}});t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
 assert.equal(store.policy('relay').mode,'restricted');assert.equal((await store.relayOperator('ops')).allowed,false);
 await store.refresh();store.update(admin,'relay',{revision:0,policy:{mode:'restricted',subjects:[],departmentIds:['od-ops']}});
 assert.equal((await store.relayOperator('ops')).allowed,true);assert.equal((await store.relayOperator('other')).allowed,false);assert.equal((await store.relayOperator('admin')).allowed,false);
 snap.departments[0].subjects=[];time+=61000;assert.equal((await store.relayOperator('ops')).allowed,false);
 fails=true;time+=61000;await assert.rejects(store.relayOperator('ops'),{status:503});
});
