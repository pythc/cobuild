// Native local platform + real public API; isolated account and no external writes.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.COBUILD_PLAYWRIGHT_MODULE));
const tmp=mkdtempSync(join(tmpdir(),'cobuild-code-live-')),file=join(tmp,'config.json'),data=join(tmp,'data');
const output=resolve('.local/evidence/public-code-0.13.0-dev.0/live-browser');mkdirSync(output,{recursive:true});
const config=JSON.parse(readFileSync('config/cobuild.local.example.json'));config.modules=['platform','kick'];config.codeSources.githubPublic=true;
const sock=createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const base='http://127.0.0.1:'+sock.address().port;await new Promise(r=>sock.close(r));config.origins.platform=base;writeFileSync(file,JSON.stringify(config));
const report={passed:false,productionAccess:false,externalWrites:false,repository:'https://github.com/octokit/rest.js',checks:[]};
let child,browser,log='',page;
try{
 child=spawn(process.execPath,['--require',resolve('tools/local-network-guard.cjs'),'tools/serve-platform.mjs'],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,COBUILD_CONFIG:file,COBUILD_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 let ready=false;for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error('Preview exited');try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
 const boot=await fetch(base+'/api/auth/bootstrap',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Bootstrap-Token':readFileSync(join(data,'bootstrap.private.key'),'utf8').trim()},body:JSON.stringify({email:'live-reader@example.test',name:'Local Reader',password:'Public source fixture password 123'})});assert.equal(boot.status,200);
 const user=await boot.json(),cookie=boot.headers.get('set-cookie').split(';')[0];
 const created=await fetch(base+'/api/workspace/projects',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':user.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'Public read acceptance',summary:'Isolated public read',members:[],links:{repository:report.repository,requirements:'',docs:'',demo:''}})});assert.equal(created.status,201);const project=await created.json();
 browser=await chromium.launch({headless:true,executablePath:process.env.COBUILD_CHROMIUM_EXECUTABLE,args:['--no-proxy-server','--disable-background-networking']});const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 page=await c.newPage();page.setDefaultTimeout(15000);await page.goto(base+'/login');await page.locator('input[name=email]').fill('live-reader@example.test');await page.locator('input[name=password]').fill('Public source fixture password 123');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(base+'/workbench');
 await page.goto(base+'/projects?project='+project.id);const panel=page.locator('#ws-overview-code');
 const summaryReply=page.waitForResponse(base+'/api/workspace/projects/'+project.id+'/overview/code');await panel.getByRole('button',{name:'加载代码状态',exact:true}).click();const summary=await(await summaryReply).json();assert.equal(summary.state,'ready');report.checks.push('native page reads real public repository through guarded preview');
 report.repositoryId=summary.repository.repositoryId;report.pullCount=summary.pullRequests.length;const pr=summary.pullRequests[0];assert.ok(pr);report.reference=pr.reference;
 const checkReply=page.waitForResponse(r=>r.url().includes('/overview/code/pulls/'));await panel.getByRole('button',{name:'查看检查',exact:true}).first().click();const checks=await(await checkReply).json();assert.equal(checks.state,'ready');assert.equal(checks.headSha,pr.headSha);
 await panel.getByText('结果对应 '+pr.headSha.slice(0,12),{exact:true}).waitFor();report.checks.push('real head checks render without external browser navigation');report.result={state:checks.state,outcome:checks.outcome,count:checks.checks.length};
 await panel.scrollIntoViewIfNeeded();await page.screenshot({path:output+'/real-public-code.png'});report.browserVersion=browser.version();report.passed=true;
}catch(e){report.error=e.message;process.exitCode=1;if(page)await page.screenshot({path:output+'/failure.png'}).catch(()=>{});}
finally{await browser?.close();if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;report.previewStopped=child.exitCode===0;}writeFileSync(output+'/report.json',JSON.stringify(report,null,2));writeFileSync(output+'/preview.log',log);rmSync(tmp,{recursive:true,force:true});}
console.log(JSON.stringify(report));
