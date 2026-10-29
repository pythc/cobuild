// Disposable local browser acceptance; uses only synthetic accounts and loopback origins.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.COBUILD_PLAYWRIGHT_MODULE));
const config=JSON.parse(readFileSync(process.env.COBUILD_CONFIG));
const runId=crypto.randomUUID().slice(0,8),projectName='Browser Project '+runId,memberEmail='browser-'+runId+'@example.test';
const origins=config.origins,base=origins.platform;
assert.ok(Object.values(origins).every(s=>new URL(s).hostname==='127.0.0.1'));
const report={passed:false,checks:[],externalMessages:false,productionAccess:false,screenshots:[]};
const output='.local/project-state-browser';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.COBUILD_CHROMIUM_EXECUTABLE,args:['--no-proxy-server','--disable-background-networking']});
const check=(v,label)=>{assert.ok(v,label);report.checks.push(label);};
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',route=>Object.values(origins).includes(new URL(route.request().url()).origin)?route.continue():route.abort());return c;}
async function login(page,email,password){await page.goto(base+'/login');await page.locator('input[name=email]').fill(email);await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(base+'/workbench');}
async function connect(page,app){
 if(new URL(page.url()).origin!==base){
   if(app==='makit'){
     await page.locator('a[href^="/auth/start"], a[href="/projects"]').first().waitFor();
     const link=page.getByRole('link',{name:'使用 CoBuild 登录',exact:true});
     if(!await link.count())return;
     await link.click();
   }else{
     const confirm=page.getByRole('button',{name:'确认连接',exact:true}),login=page.getByRole('button',{name:'使用 CoBuild 登录',exact:true});
     await confirm.or(login).first().waitFor();
     if(await login.isVisible())await login.click();
   }
   await page.waitForURL(u=>u.origin===base);
 }
 await page.getByRole('button',{name:'确认连接',exact:true}).click();
 await page.waitForURL(u=>u.origin===origins[app]&&!u.pathname.includes('callback'));
}

async function api(c,path,data){const session=await(await c.request.get(base+'/api/auth/session')).json();const r=await c.request.fetch(base+path,{method:data?'POST':'GET',headers:{Origin:base,'X-CSRF-Token':session.csrf},...(data?{data}:{})});assert.ok(r.ok(),path+' '+r.status()+' '+(r.ok()?'':await r.text()));return r.json();}
async function until(fn,label){let last;for(let i=0;i<100;i++){last=await fn();if(last)return last;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+label);}
async function screenshot(page,name){await page.screenshot({path:output+'/'+name+'.png',fullPage:false,animations:'disabled'});
 report.visualStyles||={};report.visualStyles[name]=await page.locator('dialog[open]').evaluateAll(elements=>elements.map(e=>({background:getComputedStyle(e).backgroundColor,opacity:getComputedStyle(e).opacity,ancestors:[...function*(n){while(n){yield n;n=n.parentElement;}}(e)].map(n=>({tag:n.tagName,class:n.className,opacity:getComputedStyle(n).opacity,filter:getComputedStyle(n).filter}))})));report.screenshots.push(name+'.png');}
let page;
try{
 const c=await context();page=await c.newPage();page.setDefaultTimeout(12000);
 await login(page,'member@example.test','Changed after restart local password 123');
 const currentIdentity=await (await c.request.get(base+'/api/auth/session')).json();
 for(const path of ['/openapi/suite/project-overview','/openapi/suite/project-overview/']){
   const unsigned=await c.request.post(origins.makit+path,{data:{organizationId:currentIdentity.organizationId,subject:currentIdentity.subject,projectId:crypto.randomUUID()}});
   check(unsigned.status()===401,'overview machine endpoint rejects unsigned requests '+path);
 }
 const invitation=await api(c,'/api/organization/invitations',{email:memberEmail});
 const member=await context(),mp=await member.newPage();
 const accepted=await member.request.post(base+'/api/auth/accept',{headers:{Origin:base},data:{token:invitation.token,name:'Browser Member',password:'Browser synthetic local password 123'}});
 assert.ok(accepted.ok());const memberIdentity=await accepted.json();
 await page.goto(base+'/projects?view=manage');await page.locator('#ws-project-new').click();
 await page.locator('#ws-form-project-submit').click();await page.locator('#ws-form-project-error').waitFor({state:'visible'});
 check(await page.locator('#ws-dialog-project').isVisible(),'invalid form stays open with inline error');
 await page.locator('#ws-field-name').fill(projectName);await page.locator('#ws-field-summary').fill('Synthetic browser acceptance');
 await page.locator('#ws-field-members-list input[value="'+memberIdentity.subject+'"]').check();
 await page.locator('#ws-field-create-knowledge').check();await page.locator('#ws-form-project-submit').click();await page.locator('#ws-dialog-project').waitFor({state:'hidden'});
 await page.locator('#ws-project-list li').filter({hasText:projectName}).click();
 const projectId=new URL(page.url()).searchParams.get('project');check(!!projectId,'Kick selection is shareable in URL');
 let project=await api(c,'/api/workspace/projects/'+projectId);
 project=await api(c,'/api/workspace/projects/'+projectId+'/apply',{revision:project.revision,application:'Browser fixture'});
 await page.goto(base+'/workbench');
 const reviewTodo=page.locator('#ws-todo-list li').filter({hasText:projectName});await reviewTodo.waitFor();
 await reviewTodo.focus();await page.keyboard.press('Enter');await page.locator('#cb-todo-dialog').waitFor({state:'visible'});
 check(true,'populated workbench renders project review and supports keyboard opening');await page.keyboard.press('Escape');
 await page.goto(base+'/projects?view=manage&project='+projectId);
 await api(c,'/api/workspace/projects/'+projectId+'/review',{revision:project.revision,decision:'approve',note:''});
 project=await until(async()=>{const p=await api(c,'/api/workspace/projects/'+projectId);return p.knowledgeSpace?.state==='ready'&&p.requirementsSync?.state==='synced'?p:null;},'project projections');
 project=await api(c,'/api/workspace/projects/'+projectId+'/milestones',{title:'Review scope',assignee:project.ownerSubject,dueAt:null});
 const doneMilestone=project.milestones.find(m=>m.title==='Review scope');
 project=await api(c,'/api/workspace/projects/'+projectId+'/milestones/'+doneMilestone.id,{revision:doneMilestone.revision,status:'done'});
 project=await api(c,'/api/workspace/projects/'+projectId+'/milestones',{title:'First delivery',assignee:project.ownerSubject,dueAt:'2026-11-30T00:00:00.000Z'});
 await page.goto(base+'/projects?project='+projectId);
 const overview=page.locator('#ws-project-overview'),requirements=page.locator('#ws-overview-requirements');
 await requirements.getByText('需求总数',{exact:true}).waitFor();
 check(await requirements.locator('dd').first().innerText()==='0','overview distinguishes a real empty project from global requirements');
 check(await overview.getByText('1 / 2 已完成',{exact:true}).isVisible()&&await overview.locator('.ws-overview-milestones li').first().innerText().then(t=>t.includes('First delivery')),'overview summarizes real milestones with unfinished work first');
 check(await overview.getByRole('button',{name:/完成|归档|保存|同步/}).count()===0,'overview exposes no business write controls');
 const beforeOverview=await api(c,'/api/workspace/projects/'+projectId+'/audit');
 await requirements.getByRole('button',{name:'刷新需求进展',exact:true}).click();
 await until(async()=>await requirements.getAttribute('aria-busy')==='false','overview refresh');
 check(await requirements.getByRole('button',{name:'刷新需求进展',exact:true}).evaluate(e=>document.activeElement===e),'overview refresh preserves keyboard focus');
 check(JSON.stringify(await api(c,'/api/workspace/projects/'+projectId+'/audit'))===JSON.stringify(beforeOverview),'overview refresh creates no business audit or write');
 const summaryPath=base+'/api/workspace/projects/'+projectId+'/overview/requirements';
 await page.route(summaryPath,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'unavailable'})}));
 await requirements.getByRole('button',{name:'刷新需求进展',exact:true}).click();await requirements.getByText('需求进展暂时无法读取',{exact:true}).waitFor();
 check(await overview.getByText('Synthetic browser acceptance',{exact:true}).isVisible()&&await overview.getByRole('heading',{name:'知识空间',exact:true}).isVisible(),'Makit failure does not block Kick or knowledge association');
 check(await requirements.locator('dd').count()===0,'provider failure never shows false zero or stale counts');
 await page.unroute(summaryPath);
 await requirements.getByRole('button',{name:'刷新需求进展',exact:true}).click();await requirements.getByText('需求总数',{exact:true}).waitFor();
 for(const [state,label] of [['restricted','无权读取 Makit 需求'],['not_connected','请先打开 Makit 完成连接'],['disabled','Makit 未启用'],['conflict','项目名称关联存在冲突，请在管理中核对']]){
   await page.route(summaryPath,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state})}));
   await page.reload();await requirements.getByText(label,{exact:true}).waitFor();
   check(await requirements.locator('dd').count()===0,'overview '+state+' hides private counts');await page.unroute(summaryPath);
 }
 await page.reload();await requirements.getByText('需求总数',{exact:true}).waitFor();
 // A late response for the previous project must never overwrite the next selection.
 let releaseOverview,seenOverview;
 const holdOverview=new Promise(r=>releaseOverview=r),overviewSeen=new Promise(r=>seenOverview=r);
 await page.route(summaryPath,async route=>{seenOverview();await holdOverview;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'ready',counts:{total:99,inProgress:99,completed:0,blocked:0,overdue:0},fetchedAt:new Date().toISOString(),stale:false})});});
 await requirements.getByRole('button',{name:'刷新需求进展',exact:true}).click();await overviewSeen;
 await page.locator('#ws-project-list li').filter({hasText:'Final portable project'}).click();await requirements.getByText('需求总数',{exact:true}).waitFor();
 const lateResponse=page.waitForResponse(summaryPath);releaseOverview();await lateResponse;
 await page.waitForFunction(()=>document.querySelector('#ws-project-side h3')?.textContent==='Final portable project');
 check(await requirements.locator('dd').first().innerText()!=='99','late previous-project response is discarded');
 await page.unroute(summaryPath);
 await page.locator('#ws-project-list li').filter({hasText:projectName}).click();await requirements.getByText('需求总数',{exact:true}).waitFor();
 await screenshot(page,'project-overview-desktop');
 await page.setViewportSize({width:390,height:844});await screenshot(page,'project-overview-narrow');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overview fits a narrow viewport');
 await requirements.scrollIntoViewIfNeeded();await screenshot(page,'project-overview-narrow-detail');
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-project-view=manage]').click();await page.reload();
 check(new URL(page.url()).searchParams.get('view')==='manage','project view is retained in URL');
 await page.locator('#ws-project-side h3').filter({hasText:projectName}).waitFor();
 check(new URL(page.url()).searchParams.get('project')===projectId,'Kick reload retains project');
 // Trigger a real background session/projects refresh while the edit modal is open.
 await page.locator('#ws-project-side').getByRole('button',{name:'编辑',exact:true}).click();
 await page.locator('#ws-field-summary').fill('Unsaved draft, retained on refresh');
 await page.locator('#ws-field-summary').focus();
 const refreshed=page.waitForResponse(r=>r.url()===base+'/api/workspace/projects'&&r.status()===200);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;
 check(await page.locator('#ws-field-summary').inputValue()==='Unsaved draft, retained on refresh','background refresh retains draft');
 check(await page.locator('#ws-field-summary').evaluate(e=>document.activeElement===e),'background refresh retains text focus');
 await screenshot(page,'kick-edit-desktop');await page.keyboard.press('Escape');
 // Commit once, discard its HTTP response, then retry the original form.
 const archivePath=base+'/api/workspace/projects/'+projectId+'/archive';let first=null,second=null,firstBody;
 await page.route(archivePath,async route=>{const body=route.request().postDataJSON();const response=await route.fetch();const value=await response.json();if(!first){first=value;firstBody=body;await route.abort('failed');}else{second=value;check(JSON.stringify(body)===JSON.stringify(firstBody),'lost-response retry preserves request ID and input');await route.fulfill({response});}});
 await page.locator('#ws-project-side').getByRole('button',{name:'归档',exact:true}).click();await page.locator('#ws-form-archive-submit').click();await page.locator('#ws-form-archive-error').waitFor({state:'visible'});
 check(await page.locator('#ws-dialog-archive').isVisible(),'lost response keeps retry dialog open');
 await page.locator('#ws-form-archive-submit').click();await page.locator('#ws-dialog-archive').waitFor({state:'hidden'});
 check(first.operation.id===second.operation.id && second.operation.replayed,'real browser retry returns original operation');
 await page.unroute(archivePath);
 await until(async()=>new URL(page.url()).searchParams.get('filter')==='archived','archive filter');
 await page.reload();await page.locator('#ws-project-side h3').filter({hasText:projectName}).waitFor();
 await page.locator('#ws-projects-refresh').click();
 check(new URL(page.url()).searchParams.get('project')===projectId,'archived deep link survives reload and refresh');
 check(await page.locator('[data-project-filter=archived]').getAttribute('aria-pressed')==='true','archived route matches active filter');
 await screenshot(page,'kick-archived-desktop');
 await page.locator('[data-project-filter=active]').click();check(!new URL(page.url()).searchParams.has('project'),'explicit incompatible filter clears selection');
 await page.goBack();await page.locator('#ws-project-side h3').filter({hasText:projectName}).waitFor();
 check(new URL(page.url()).searchParams.get('filter')==='archived','browser back restores project and filter');
 await page.goForward();check(!new URL(page.url()).searchParams.has('project'),'browser forward restores cleared selection');
 await page.goBack();await page.locator('#ws-project-side').getByRole('button',{name:'取消归档',exact:true}).click();await page.locator('#ws-form-archive-submit').click();await page.locator('#ws-dialog-archive').waitFor({state:'hidden'});
 await until(async()=>{const p=await api(c,'/api/workspace/projects/'+projectId);return !p.archived&&p.knowledgeSpace?.state==='ready'&&p.requirementsSync?.state==='synced';},'restore projections');
 const events=await api(c,'/api/workspace/projects/'+projectId+'/audit');check(events.events.filter(e=>e.action==='archive').length===1,'lost-response retry produces one business archive');
 await page.locator('#ws-projects-refresh').click();
 const [makit]=await Promise.all([page.waitForEvent('popup'),page.getByRole('link',{name:'需求',exact:true}).click()]);await makit.waitForLoadState();
 await connect(makit,'makit');
 await makit.goto(origins.makit+'/projects?project='+projectId);await connect(makit,'makit');
 await makit.locator('aside h2').filter({hasText:projectName}).waitFor();
 check(true,'Kick link opens Makit using generic identity');
 const createdRequirement=await c.request.post(origins.makit+'/api/workspace/requirements',{headers:{Origin:origins.makit},data:{title:'Overview requirement',project:projectName,type:'产品需求',introduction:'Local synthetic fixture',acceptanceCriteria:'Overview only',handlerLarkUserIds:[currentIdentity.id]}});
 check(createdRequirement.ok(),'synthetic requirement created for overview validation: '+createdRequirement.status()+' '+(createdRequirement.ok()?'':await createdRequirement.text()));
 await page.goto(base+'/projects?project='+projectId);await requirements.getByText('需求总数',{exact:true}).waitFor();
 check(await requirements.locator('dd').first().innerText()==='1','real Makit requirement is counted once in its Kick project');
 const [overviewMakit]=await Promise.all([page.waitForEvent('popup'),requirements.getByRole('link',{name:'打开 Makit 项目',exact:true}).click()]);
 await overviewMakit.locator('aside h2').filter({hasText:projectName}).waitFor();
 check(new URL(overviewMakit.url()).searchParams.get('project')===projectId,'overview link opens the same project in Makit');await overviewMakit.close();
 await screenshot(page,'project-overview-populated');
 await page.locator('[data-project-view=manage]').click();

 await makit.getByRole('button',{name:'收起',exact:true}).click();await makit.getByRole('textbox',{name:'搜索项目',exact:true}).fill('Browser Project');
 await makit.getByRole('button',{name:'已立项',exact:true}).click();
 await makit.getByRole('button').filter({has:makit.getByRole('heading',{name:projectName,exact:true})}).click();
 const selectedURL=makit.url();await makit.reload();await makit.locator('aside h2').filter({hasText:projectName}).waitFor();
 check(await makit.getByRole('textbox',{name:'搜索项目',exact:true}).inputValue()==='Browser Project','Makit reload retains search');
 check(await makit.getByRole('button',{name:'已立项',exact:true}).getAttribute('aria-pressed')==='true','Makit reload retains phase filter');
 await makit.getByRole('button',{name:'全部',exact:true}).click();await makit.goBack();check(makit.url()===selectedURL,'Makit back restores selected project and filters');
 await makit.getByRole('button',{name:'管理里程碑与空间',exact:true}).click();await makit.getByRole('textbox',{name:'里程碑名称',exact:true}).fill('Draft milestone retained');
 await makit.getByRole('dialog').getByRole('button',{name:'刷新',exact:true}).click();
 check(await makit.getByRole('textbox',{name:'里程碑名称',exact:true}).inputValue()==='Draft milestone retained','Makit refresh does not replace milestone draft');
 await screenshot(makit,'makit-edit-desktop');await makit.keyboard.press('Escape');
 const [wk]=await Promise.all([makit.waitForEvent('popup'),makit.getByRole('link',{name:'WeKnow 空间',exact:true}).click()]);await wk.waitForLoadState();await connect(wk,'weknow');
 await until(async()=> (await wk.locator('body').innerText()).includes(projectName),'WeKnow visible project space');
 check(true,'Makit opens managed WeKnow project space');await screenshot(wk,'weknow-project-desktop');
 // Independent ordinary member follows the same chain and keeps read-only project management.
 await login(mp,memberEmail,'Browser synthetic local password 123');await mp.goto(base+'/projects?view=manage&project='+projectId);
 await mp.locator('#ws-project-side h3').filter({hasText:projectName}).waitFor();
 check(await mp.locator('#ws-project-side').getByRole('button',{name:'归档',exact:true}).count()===0,'ordinary member has no archive control');
 check((await api(member,'/api/workspace/projects/'+projectId+'/overview/requirements')).state==='not_connected','overview does not silently provision an unconnected member in Makit');
 const denied=await member.request.post(archivePath,{headers:{Origin:base,'X-CSRF-Token':(await(await member.request.get(base+'/api/auth/session')).json()).csrf},data:{revision:project.revision,archived:true,requestId:crypto.randomUUID()}});check(denied.status()===403,'ordinary member cannot archive via direct API');
 await mp.goto(origins.makit+'/projects?project='+projectId);await connect(mp,'makit');await mp.locator('aside h2').filter({hasText:projectName}).waitFor();check(true,'ordinary member reaches Makit project');
 const memberOverview=await api(member,'/api/workspace/projects/'+projectId+'/overview/requirements');
 check(memberOverview.state==='ready'&&memberOverview.counts.total===1,'connected ordinary member reads the same authorized project count');
 await mp.goto(project.links.knowledgeSpace);await connect(mp,'weknow');await until(async()=>(await mp.locator('body').innerText()).includes(projectName),'member WeKnow');check(true,'ordinary member reaches managed WeKnow space');
 await mp.goto(base+'/projects?view=manage&project='+projectId);await mp.locator('#ws-project-side h3').waitFor();check(true,'return to Kick retains project identity');
 // Missing resources stay explicit; errors never replace the target with another row.
 await page.goto(base+'/projects?project=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');await page.getByText('项目不存在或当前无权访问。',{exact:true}).waitFor();check(true,'missing target is explicit, with no unrelated fallback');
 await page.goto(base+'/projects?view=manage&project='+projectId);await page.locator('#ws-project-side h3').waitFor();
 await page.route(base+'/api/workspace/projects',route=>route.abort('timedout'));
 await page.locator('#ws-projects-refresh').click();await page.locator('#ws-status').filter({hasText:'网络暂不可用'}).waitFor();
 check(await page.locator('#ws-project-side h3').innerText()===projectName,'transient source failure keeps target with error');await page.unroute(base+'/api/workspace/projects');
 await page.setViewportSize({width:390,height:844});await screenshot(page,'kick-narrow');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Kick narrow viewport has no horizontal overflow');
 await page.locator('#ws-project-list li').filter({hasText:projectName}).focus();await page.keyboard.press('Enter');check(new URL(page.url()).searchParams.get('project')===projectId,'keyboard project selection works');check(await page.locator('#ws-project-list li[aria-current=true]').evaluate(e=>document.activeElement===e),'keyboard focus stays on the selected row');
 await makit.setViewportSize({width:390,height:844});await screenshot(makit,'makit-narrow');check(await makit.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Makit narrow viewport has no horizontal overflow');
 await makit.route(origins.makit+'/api/workspace/project-management',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'Fixture access revoked'})}));
 await makit.getByRole('button',{name:'刷新',exact:true}).click();
 await makit.getByText('无操作权限，请联系应用管理员',{exact:true}).waitFor();
 check(await makit.locator('aside h2').count()===0,'Makit forbidden refresh removes cached private project details');
 await makit.unroute(origins.makit+'/api/workspace/project-management');
 // Revocation must win over draft preservation. Revoke a synthetic admin after opening a draft.
 await api(c,'/api/organization/users/'+memberIdentity.id,{role:'admin'});
 await login(mp,memberEmail,'Browser synthetic local password 123');await mp.goto(base+'/projects?view=manage&project='+projectId);await mp.locator('#ws-project-side').getByRole('button',{name:'编辑',exact:true}).click();await mp.locator('#ws-field-summary').fill('Revoked draft');
 await api(c,'/api/organization/users/'+memberIdentity.id,{role:'member'});
 await mp.evaluate(()=>window.dispatchEvent(new Event('focus')));await mp.locator('#ws-dialog-project').waitFor({state:'hidden'});
 check(await mp.locator('#ws-field-summary').inputValue()!=='Revoked draft','permission downgrade removes editable draft');
 report.passed=true;report.browserVersion=browser.version();
}catch(error){report.error=String(error.stack||error);for(const [ci,c] of browser.contexts().entries())for(const [pi,p] of c.pages().entries())if(!p.isClosed()){await screenshot(p,'failure-'+ci+'-'+pi);report.error+='\nPage '+ci+'-'+pi+': '+p.url()+' '+(await p.locator('body').innerText()).slice(0,1500);}process.exitCode=1;}
finally{await browser.close();writeFileSync(output+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
