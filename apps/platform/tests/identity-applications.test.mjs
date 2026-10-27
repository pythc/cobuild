import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIdentityRegistry,readIdentityApplications} from '../server/identity-applications.mjs';
const app={id:'calendar',name:'日程',url:'https://calendar.110-lab.cn/',redirectUris:['https://calendar.110-lab.cn/auth/callback'],scopes:['identity:profile','identity:email']};
test('new web applications use exact HTTPS callbacks, explicit identity scopes and confirmation',()=>{
 const r=createIdentityRegistry({applications:[app]});assert.equal(r.get('calendar').automatic,false);assert.equal(r.allows('calendar',app.redirectUris[0]),true);
 for(const callback of [app.redirectUris[0]+'?next=evil',app.redirectUris[0]+'#x',app.redirectUris[0]+'/',app.redirectUris[0].replace('calendar.','calendar.evil.'),app.redirectUris[0].replace('https:','http:'),'https://user@calendar.110-lab.cn/auth/callback'])assert.equal(r.allows('calendar',callback),false);
 assert.equal(r.services.calendar.federated,true);assert.equal(Object.hasOwn(r.services,'constructor'),false);
 const p=r.project({issuer:'issuer',subject:'tenant:on_user',name:'用户',email:'u@110-lab.cn',role:'super_admin'},'calendar');assert.equal(p.email,'u@110-lab.cn');assert.equal(Object.hasOwn(p,'role'),false);
 const minimal=createIdentityRegistry({applications:[{...app,scopes:['identity:profile']}]});assert.equal(Object.hasOwn(minimal.project({email:'private',role:'admin'},'calendar'),'email'),false);
});
test('application configuration rejects duplicate IDs, prototype IDs, arbitrary fields and insecure registration',()=>{
 for(const applications of [[app,app],[{...app,id:'knowledge'}],[{...app,id:'constructor'}],[{...app,automatic:true}],[{...app,url:'http://calendar.110-lab.cn/'}],[{...app,redirectUris:['https://calendar.110-lab.cn/callback?x=y']}],[{...app,redirectUris:[]}],[{...app,scopes:['identity:email']}],[{...app,scopes:['identity:profile','mail:send']}],[{...app,icon:'../secret'}]])assert.throws(()=>createIdentityRegistry({applications}));
 assert.notEqual(createIdentityRegistry({applications:[app]}).get('calendar').policyHash,createIdentityRegistry({applications:[{...app,scopes:['identity:profile']}]}).get('calendar').policyHash);
});
test('registered application configuration is immutable and private-file loading fails closed',async()=>{
 const source={...app,redirectUris:[...app.redirectUris],scopes:[...app.scopes]},r=createIdentityRegistry({applications:[source]});source.redirectUris.push('https://evil.example/callback');assert.equal(r.allows('calendar',source.redirectUris[1]),false);
 const dir=await mkdtemp(join(tmpdir(),'identity-registry-'));try{const file=join(dir,'apps.json');await writeFile(file,JSON.stringify({version:1,applications:[app]}),{mode:0o600});assert.deepEqual(readIdentityApplications(file),[app]);await chmod(file,0o644);assert.throws(()=>readIdentityApplications(file));await chmod(file,0o600);await symlink(file,join(dir,'link'));assert.throws(()=>readIdentityApplications(join(dir,'link')));assert.deepEqual(readIdentityApplications(),[]);}finally{await rm(dir,{recursive:true,force:true});}
});
