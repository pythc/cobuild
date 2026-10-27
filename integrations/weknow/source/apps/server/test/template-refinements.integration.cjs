const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../../../..'),q=JSON.parse(fs.readFileSync(root+'/private/knowledge-office-20261014/qa-session.json','utf8'));
const env=JSON.parse(fs.readFileSync(root+'/private/knowledge-office-20261014/env.json','utf8'));
assert.equal(env.APP_URL,'http://127.0.0.1:5840'); assert.match(env.DATABASE_URL,/@127\.0\.0\.1:5843\/docmost$/);
let token=q.owner.token,passed=0;const base=env.APP_URL+'/api';
async function post(p,b={},status=200){const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json',Cookie:'authToken='+token},body:JSON.stringify(b)});const j=await r.json();assert.equal(r.status,status,p+': '+JSON.stringify(j));return j.data??j;}
async function check(name,fn){await fn();console.log('PASS '+(++passed)+' '+name);}
(async()=>{
 let list,t,folder,page,word;
 await check('built-in catalogue can be read',async()=>{list=await post('/knowledge-templates/list');assert.ok(list.items.filter(x=>x.builtin).length>=33)});
 await check('every built-in preview contains native document content',async()=>{for(const x of list.items.filter(x=>x.builtin)){const r=await post('/knowledge-templates/info',{id:x.id});assert.ok(r.html);assert.ok(!/<script[ >]/i.test(r.html));}});
 await check('private template persists tables and links',async()=>{t=await post('/knowledge-templates/save',{title:'QA 临时模板',content:'# 模板验收\n\n[帮助](https://example.com)\n\n| 项目 | 负责人 |\n| --- | --- |\n| 验证 | 测试 |\n\n1. 创建\n2. 检查',format:'markdown'});assert.match(t.html,/<table/);assert.match(t.html,/<ol/);});
 await check('another member cannot read private template',async()=>{token=q.reader.token;await post('/knowledge-templates/info',{id:t.id},404);const l=await post('/knowledge-templates/list');assert.ok(!l.items.some(x=>x.id===t.id));token=q.owner.token;});
 await check('creating in an existing folder preserves parent',async()=>{folder=await post('/office/create',{spaceId:q.spaceId,title:'模板验收目录',type:'folder'});page=await post('/knowledge-templates/apply',{id:t.id,spaceId:q.spaceId,parentPageId:folder.id,title:'模板创建验收'});assert.equal(page.parentPageId,folder.id);const info=await post('/pages/info',{pageId:page.id,format:'html'});assert.match(info.content,/模板验收/);});
 await check('read-only member cannot apply a template',async()=>{token=q.reader.token;await post('/knowledge-templates/apply',{id:list.items.find(x=>x.builtin).id,spaceId:q.spaceId},403);token=q.owner.token;});
 await check('Office file cannot be used as a parent',async()=>{word=await post('/office/create',{spaceId:q.spaceId,type:'docx',title:'禁止子页面验收',mode:'file'});await post('/knowledge-templates/apply',{id:t.id,spaceId:q.spaceId,parentPageId:word.id},400);});
 await check('revision protects concurrent template updates',async()=>{const old=t;await new Promise(r=>setTimeout(r,10));t=await post('/knowledge-templates/save',{id:t.id,expectedUpdatedAt:t.updatedAt,title:'QA 临时模板已修改',content:'# 新版',format:'markdown'});await post('/knowledge-templates/save',{id:old.id,expectedUpdatedAt:old.updatedAt,title:'不应覆盖',content:'# 旧版'},409);await post('/knowledge-templates/delete',{id:old.id,expectedUpdatedAt:old.updatedAt},409);});
 await check('blank title rejected',async()=>{await post('/knowledge-templates/save',{title:' ',content:'正文'},400);});
 await check('template deletion does not delete created document',async()=>{await post('/knowledge-templates/delete',{id:t.id,expectedUpdatedAt:t.updatedAt});await post('/knowledge-templates/info',{id:t.id},404);const p=await post('/pages/info',{pageId:page.id});assert.equal(p.title,'模板创建验收');});
 console.log(JSON.stringify({passed,fixtureFolder:folder.id,fixturePage:page.id}));
})().catch(e=>{console.error(e);process.exitCode=1});
