import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const cfg=JSON.parse(await readFile(process.env.TEST_CONFIG_PATH,'utf8'));
const fixture=JSON.parse(await readFile(process.env.TEST_UPLOAD_RESULT_PATH,'utf8'));
const base=cfg.TEST_ORIGIN;
assert.equal(fixture.origin,base);assert.ok(['https://47.109.176.127','http://127.0.0.1:5380'].includes(base));
const account=JSON.parse(cfg.TEST_CANDIDATES_JSON)[0],cookies=new Map();let csrf='';
async function request(path,method='GET',body){
 const res=await fetch(new URL(path,base),{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 for(const c of res.headers.getSetCookie()){const [v]=c.split(';');const e=v.indexOf('=');cookies.set(v.slice(0,e),v.slice(e+1));}
 const data=await res.json();if(data.csrfToken)csrf=data.csrfToken;return {status:res.status,data};
}
async function api(...args){const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r));return r.data;}
await api('/api/auth/login','POST',{account:cfg.TEST_ADMIN_EMAIL,password:cfg.TEST_ADMIN_PASSWORD});
const id=fixture.enrollmentId,detail=await api(`/api/admin/enrollments/${id}`),e=detail.enrollment;
assert.equal(detail.user.email,account.email,'must be our synthetic test account');
assert.match(e.roundName,/^直接上传验收-\d+$/,'must be disposable live-upload test fixture');
assert.equal(e.batchName,'材料直接上传验收');assert.equal(e.question.title,'原文件提交验收');
const all=(await api('/api/admin/questions?batchId='+encodeURIComponent(e.batchId))).questions;
assert.equal(all.length,1);const question=all[0];
const checks=[];
async function preview(kind,target){return (await api(`/api/admin/deletions/${kind}/${target}`)).preview;}
for(const [kind,target] of [['round',e.roundId],['batch',e.batchId],['question',question.id]]){
 const p=await preview(kind,target);assert.equal(p.allowed,false);assert.ok(p.reason);
}
checks.push('有关联数据的轮次、批次及已使用题目阻止直接删除');
const p=await preview('enrollment',id);assert.equal(p.allowed,true);assert.ok(p.counts.materials>0);assert.ok(p.counts.files>0);
assert.equal((await request(`/api/admin/deletions/enrollment/${id}`,'DELETE',{confirmation:'wrong',fingerprint:p.fingerprint})).status,400);
assert.equal((await request(`/api/admin/deletions/enrollment/${id}`,'DELETE',{confirmation:'删除',fingerprint:'0'.repeat(64)})).status,409);
checks.push('缺少正确确认或预览版本不匹配时拒绝删除');
const deleted=await api(`/api/admin/deletions/enrollment/${id}`,'DELETE',{confirmation:'删除',fingerprint:p.fingerprint});assert.equal(deleted.ok,true);assert.ok(deleted.filesQueued>0);
assert.equal((await request(`/api/admin/enrollments/${id}`)).status,404);
assert.equal((await request(`/api/enrollments/${id}/materials`)).status,404);
const remaining=await api('/api/admin/candidates?search='+encodeURIComponent(account.email));assert.ok(remaining.candidates.some(x=>x.id===detail.user.id));
assert.ok(!remaining.candidates.find(x=>x.id===detail.user.id).enrollments.some(x=>x.id===id));
checks.push('只删除本次已交卷的合成报名，保留考生账号及其他报名');
checks.push('删除回执、原始材料和权限记录，文件进入持久化清理队列');
for(const [kind,target] of [['question',question.id],['batch',e.batchId],['round',e.roundId]]){
 const p=await preview(kind,target);assert.equal(p.allowed,true);
 const r=await api(`/api/admin/deletions/${kind}/${target}`,'DELETE',{confirmation:'删除',fingerprint:p.fingerprint});assert.equal(r.ok,true);
 assert.equal((await request(`/api/admin/deletions/${kind}/${target}`)).status,404);
}
checks.push('依次删除合成题目、空批次及空轮次成功');
const result={origin:base,enrollmentId:id,filesQueued:deleted.filesQueued,checks};
await writeFile(process.env.TEST_OUTPUT_PATH,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
