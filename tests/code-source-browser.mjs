// Disposable real Chrome acceptance. Only the upstream GitHub payloads are fixtures.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {HEAD,NEXT_HEAD,REPO} from './fixtures/public-code.mjs';
const {chromium}=await import(pathToFileURL(process.env.COBUILD_PLAYWRIGHT_MODULE));
const out=resolve('.local/evidence/public-code-0.13.0-dev.0/browser');mkdirSync(out,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),'cobuild-public-code-')),configFile=join(temp,'config.json'),data=join(temp,'data'),requestLog=join(temp,'requests.jsonl');
const config=JSON.parse(readFileSync('config/cobuild.local.example.json'));config.modules=['platform','kick'];config.codeSources.githubPublic=true;
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');config.origins.platform='http://127.0.0.1:'+reservation.address().port;await new Promise(r=>reservation.close(r));
const base=config.origins.platform,report={passed:false,checks:[],productionAccess:false,externalMessages:false,github:'local deterministic fixture',screenshots:[]};
const check=(ok,label)=>{assert.ok(ok,label);report.checks.push(label);};
let child,browser,page,output='';
const requests=()=>existsSync(requestLog)?readFileSync(requestLog,'utf8').trim().split('\n').filter(Boolean).length:0;
async function start(){writeFileSync(configFile,JSON.stringify(config));output='';
 child=spawn(process.execPath,['--require',resolve('tools/local-network-guard.cjs'),'tests/fixtures/public-code-preview.mjs'],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,COBUILD_CONFIG:configFile,COBUILD_DATA_DIR:data,COBUILD_CODE_REQUEST_LOG:requestLog},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error('Preview exited: '+output);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Preview readiness timeout');
}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;check(child.exitCode===0,'preview exits gracefully');}child=null;}
async function screenshot(name){await page.screenshot({path:out+'/'+name+'.png',animations:'disabled'});report.screenshots.push(name+'.png');}
try{
 await start();
 const boot=await fetch(base+'/api/auth/bootstrap',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Bootstrap-Token':readFileSync(join(data,'bootstrap.private.key'),'utf8').trim()},body:JSON.stringify({email:'owner@example.test',name:'Local Owner',password:'Code browser fixture password 123'})});assert.equal(boot.status,200);
 browser=await chromium.launch({headless:true,executablePath:process.env.COBUILD_CHROMIUM_EXECUTABLE,args:['--no-proxy-server','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/login');await page.locator('input[name=email]').fill('owner@example.test');await page.locator('input[name=password]').fill('Code browser fixture password 123');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(base+'/workbench');
 const api=async(path,body)=>{const session=await(await context.request.get(base+'/api/auth/session')).json();const r=await context.request.fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,'X-CSRF-Token':session.csrf},...(body?{data:body}:{})});assert.ok(r.ok(),path+' '+r.status());return r.json();};
 await page.goto(base+'/projects');await page.locator('#ws-project-new').click();await page.locator('#ws-field-name').fill('Code source acceptance');await page.locator('#ws-field-summary').fill('Public project overview');await page.locator('#ws-field-link-repo').fill(REPO);await page.locator('#ws-form-project-submit').click();await page.locator('#ws-dialog-project').waitFor({state:'hidden'});
 await page.locator('#ws-project-list li').filter({hasText:'Code source acceptance'}).click();await page.locator('[data-project-view=overview]').click();
 const projectId=new URL(page.url()).searchParams.get('project');const route=base+'/api/workspace/projects/'+projectId+'/overview/code';const panel=page.locator('#ws-overview-code');
 await panel.getByText('按需读取 GitHub 公共仓库',{exact:true}).waitFor();check(requests()===0,'opening project sends no external code reads');
 const audit=await api('/api/workspace/projects/'+projectId+'/audit');
 await panel.getByRole('button',{name:'加载代码状态',exact:true}).focus();await page.keyboard.press('Enter');await panel.getByRole('link',{name:'#7 Improve project flow',exact:true}).waitFor();
 check(requests()===2,'one action reads repository plus a bounded PR page');
 check(await panel.getByRole('button',{name:'刷新代码状态',exact:true}).evaluate(e=>document.activeElement===e),'load preserves keyboard focus');
 check(await panel.getByRole('link',{name:'#7 Improve project flow',exact:true}).getAttribute('href')===REPO+'/pull/7','PR points at validated GitHub source');
 await panel.getByRole('button',{name:'查看检查',exact:true}).click();await panel.getByText('已读取的检查通过',{exact:true}).waitFor();
 check(await panel.getByText('Unit tests',{exact:true}).isVisible()&&await panel.getByText('lint',{exact:true}).isVisible(),'both check and status results are visible');
 check(await panel.getByText('结果对应 '+HEAD.slice(0,12),{exact:true}).isVisible(),'checks show exact commit prefix');
 check(await panel.getByRole('button',{name:'收起检查',exact:true}).getAttribute('aria-expanded')==='true','accessible expand state');
 check(JSON.stringify(await api('/api/workspace/projects/'+projectId+'/audit'))===JSON.stringify(audit),'read-only interactions do not mutate project audit');
 await screenshot('code-desktop');await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await screenshot('code-narrow');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px view has no horizontal page overflow');await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-project-view=access]').click();await page.goBack();await panel.getByText('Unit tests',{exact:true}).waitFor();check(new URL(page.url()).searchParams.get('project')===projectId,'back retains selected project and expanded code result');
 await page.locator('[data-project-view=manage]').click();await page.locator('#ws-project-side').getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#ws-field-summary').fill('Unsaved code acceptance draft');
 const refreshed=page.waitForResponse(r=>r.url()===base+'/api/workspace/projects'&&r.ok());await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;
 check(await page.locator('#ws-field-summary').inputValue()==='Unsaved code acceptance draft','background refresh preserves edit draft');await page.keyboard.press('Escape');await page.locator('[data-project-view=overview]').click();
 for(const [state,label] of [['rate_limited','GitHub 请求额度已用完，请稍后重试'],['timeout','代码来源读取超时'],['not_found','仓库不存在或未公开'],['repository_moved','仓库地址已变化，请在管理中更新链接']]){
   await page.route(route,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state,retryAfter:60})}));await panel.getByRole('button',{name:'刷新代码状态',exact:true}).click();await panel.getByText(label,{exact:true}).waitFor();
   check(await page.getByText('Public project overview',{exact:true}).isVisible()&&await page.getByRole('heading',{name:'知识空间',exact:true}).isVisible(),state+' failure stays inside code panel');check(await panel.locator('.ws-code-item').count()===0,state+' does not show stale success');await page.unroute(route);
 }
 await panel.getByRole('button',{name:'刷新代码状态',exact:true}).click();await panel.getByRole('button',{name:'查看检查',exact:true}).click();await panel.getByText('Unit tests',{exact:true}).waitFor();
 const checksRoute=route+'/pulls/7/checks?head='+HEAD+'&repository=123';
 await page.route(checksRoute,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'partial',headSha:HEAD,checks:[{name:'Unit tests',state:'passed'}]})}));await panel.getByRole('button',{name:'刷新检查',exact:true}).click();await panel.getByText('仅取得部分检查，无法确认完整结果',{exact:true}).waitFor();check(await panel.getByText('已读取的检查通过',{exact:true}).count()===0,'partial results never claim all passed');await screenshot('code-partial');await page.unroute(checksRoute);
 // A previous head's slow checks must not overwrite a refreshed PR's results.
 let releaseOld,oldEntered,oldComplete;
 const oldHold=new Promise(r=>releaseOld=r),oldSeen=new Promise(r=>oldEntered=r),oldDone=new Promise(r=>oldComplete=r);
 await page.route(checksRoute,async r=>{oldEntered();await oldHold;try{await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'ready',headSha:HEAD,outcome:'passed',checks:[]})});}finally{oldComplete();}});
 await panel.getByRole('button',{name:'刷新检查',exact:true}).click();await oldSeen;
 const injection='<img src=x onerror=alert(1)> literal title';
 await page.route(route,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'ready',repository:{repositoryId:'123'},fetchedAt:new Date().toISOString(),pullRequests:[{number:7,title:injection,headSha:NEXT_HEAD,state:'open',url:REPO+'/pull/7'}]})}));
 await panel.getByRole('button',{name:'刷新代码状态',exact:true}).click();await panel.getByText('#7 '+injection,{exact:true}).waitFor();
 check(await panel.locator('img').count()===0,'provider title is rendered only as text');
 const newChecksRoute=route+'/pulls/7/checks?head='+NEXT_HEAD+'&repository=123';
 await page.route(newChecksRoute,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'ready',headSha:NEXT_HEAD,outcome:'running',checks:[]})}));
 await panel.getByRole('button',{name:'查看检查',exact:true}).click();await panel.getByText('检查进行中',{exact:true}).waitFor();releaseOld();await oldDone;
 check(await panel.getByText('结果对应 '+NEXT_HEAD.slice(0,12),{exact:true}).isVisible()&&await panel.getByText('已读取的检查通过',{exact:true}).count()===0,'old head response cannot overwrite refreshed checks');
 await page.unroute(checksRoute);await page.unroute(newChecksRoute);await page.unroute(route);
 // Delayed response cannot contaminate another project or leave returning view stuck.
 const other=await api('/api/workspace/projects',{name:'Second project',summary:'Other goal',members:[],links:{repository:REPO,requirements:'',docs:'',demo:''}});
 await page.reload();await panel.getByRole('button',{name:'加载代码状态',exact:true}).waitFor();
 let release,entered,complete;const hold=new Promise(r=>release=r),seen=new Promise(r=>entered=r),done=new Promise(r=>complete=r);
 await page.route(route,async r=>{entered();await hold;try{await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'unavailable'})});}finally{complete();}});
 await panel.getByRole('button',{name:'加载代码状态',exact:true}).click();await seen;await page.locator('#ws-project-list li').filter({hasText:'Second project'}).click();release();await done;await page.unroute(route);
 await panel.getByText('按需读取 GitHub 公共仓库',{exact:true}).waitFor();check(await page.getByText('Other goal',{exact:true}).isVisible(),'late previous project response discarded');
 await page.locator('#ws-project-list li').filter({hasText:'Code source acceptance'}).click();await panel.getByRole('button',{name:'加载代码状态',exact:true}).waitFor();
 check(await panel.getAttribute('aria-busy')==='false','return from abandoned request is not stuck loading');
 const oldRequests=requests();await stop();config.codeSources.githubPublic=false;await start();await page.reload();await panel.getByText('代码来源未启用',{exact:true}).waitFor();
 check((await api('/api/workspace/projects/'+projectId+'/overview/code')).state==='disabled','disabled source API refuses reads');check(requests()===oldRequests,'disable sends no upstream requests');
 check((await api('/api/workspace/projects/'+projectId)).links.repository===REPO,'disable retains repository and native session');
 await stop();config.modules=['platform'];config.codeSources.githubPublic=true;await start();
 check((await context.request.get(route)).status()===404,'disabled Kick rejects the code endpoint');check(requests()===oldRequests,'module disable sends no source requests');
 await stop();config.modules=['platform','kick'];config.codeSources.githubPublic=true;await start();await page.reload();await panel.getByRole('button',{name:'加载代码状态',exact:true}).click();await panel.getByRole('link',{name:'#7 Improve project flow',exact:true}).waitFor();check(requests()===oldRequests+2,'restart/reenable has fresh cache');
 await page.route(route,r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'forbidden'})}));await panel.getByRole('button',{name:'刷新代码状态',exact:true}).click();await page.getByText('无权访问项目',{exact:true}).waitFor();check(await panel.count()===0,'revocation clears source and project details');
 check(errors.length===0,'no browser page errors');report.browserVersion=browser.version();report.passed=true;
}catch(e){report.error=e.message;if(page)await screenshot('failure').catch(()=>{});throw e;}
finally{await browser?.close();await stop();writeFileSync(out+'/preview.log',output);writeFileSync(out+'/report.json',JSON.stringify(report,null,2));rmSync(temp,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output:out}));
