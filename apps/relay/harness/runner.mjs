import {ToolSessions} from './tool-sessions.mjs';
import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,symlink,copyFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const hash=v=>createHash('sha256').update(String(v||'')).digest();
export function validateContext(body){
 if(!body || typeof body!=='object' || Object.keys(body).some(k=>!['user','sourceApp','conversationId','history','historyTruncated','scope'].includes(k)) ||
 !body.user || typeof body.user.name!=='string' || body.user.name.length>128 || typeof body.sourceApp!=='string' || body.sourceApp.length>128 ||
 typeof body.conversationId!=='string' || !/^[\w-]{1,128}$/.test(body.conversationId) || !Array.isArray(body.history) || body.history.length>40 ||
 body.history.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>4000||!Array.isArray(m.attachments)||m.attachments.length>3))throw Error('Invalid context');
 if(body.scope && (!/^[a-f0-9]{64}$/.test(body.scope.principal||'')||typeof body.scope.app!=='string'))throw Error('Invalid scope');
 return body;
}
export function answerEvent(event){
 if(event?.type!=='tool_use'||event.part?.tool!=='finish_answer'||event.part.state?.status!=='completed')return null;
 const value=JSON.parse(event.part.state.output);
 if(typeof value.answer!=='string'||!value.answer.trim()||value.answer.length>3000||typeof value.handoff!=='boolean')throw Error('Invalid answer');
 return {answer:value.answer,handoff:value.handoff};
}
export async function runHarness(context,signal,{sessionToken}={}){
 const directory=await mkdtemp(join(tmpdir(),'relay-agent-'));
 try{
  for(const name of ['home','cache','data','state','work'])await mkdir(join(directory,name),{mode:0o700});
  const configPath=join(directory,'config');await mkdir(configPath,{mode:0o700});
  await copyFile('/relay-harness/config/opencode.json',join(configPath,'opencode.json'));
  await cp('/relay-harness/config/tools',join(configPath,'tools'),{recursive:true});
  await cp('/relay-harness/config/lib',join(configPath,'lib'),{recursive:true});
  for(const file of ['package.json','package-lock.json','.gitignore'])await copyFile('/app/opencode_runner/config/'+file,join(configPath,file));
  await symlink('/app/opencode_runner/config/node_modules',join(configPath,'node_modules'));
  await symlink(configPath,join(directory,'home','opencode'));
  const now=new Date(),beijing=new Date(now.getTime()+8*3600000).toISOString().replace('Z','+08:00');
 const prompt={...context,now:now.toISOString(),nowBeijing:beijing,todayStartBeijing:beijing.slice(0,10)+'T00:00:00+08:00'};delete prompt.scope;
 const child=spawn('/usr/local/bin/opencode',['run','--format','json','--agent','relay-support','--',JSON.stringify(prompt)],{
   cwd:join(directory,'work'),detached:true,stdio:['ignore','pipe','pipe'],
   env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:join(directory,'home'),XDG_CACHE_HOME:join(directory,'cache'),XDG_DATA_HOME:join(directory,'data'),XDG_STATE_HOME:join(directory,'state'),XDG_CONFIG_HOME:join(directory,'home'),OPENCODE_CONFIG:join(configPath,'opencode.json'),OPENCODE_CONFIG_DIR:configPath,OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_TERMINAL_TITLE:'true',OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:'true',DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,RELAY_AI_SESSION:sessionToken},
  });
  return await new Promise((resolve,reject)=>{
   let line='',size=0,answer,failure,done=false,killTimer;
   const kill=signal=>{try{process.kill(-child.pid,signal);}catch{}};
   const finish=error=>{if(done)return;done=true;failure=error;clearTimeout(timer);signal.removeEventListener('abort',abort);kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);};
   const abort=()=>finish(Error('Aborted'));
   const timer=setTimeout(()=>finish(Error('Harness timeout')),130000);
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    if(done)return;size+=Buffer.byteLength(chunk);line+=chunk;if(size>262144)return finish(Error('Output limit'));
    let end;while((end=line.indexOf('\n'))!==-1&&!done){const record=line.slice(0,end);line=line.slice(end+1);if(!record.trim())continue;
     try{const event=JSON.parse(record);if(event.type==='error')return finish(Error('Model failed'));const result=answerEvent(event);if(result){answer=result;finish();}}catch{finish(Error('Invalid model event'));}
    }
   });
   child.stderr.on('data',chunk=>{size+=chunk.length;if(size>262144)finish(Error('Output limit'));});
   child.once('error',()=>finish(Error('Launch failed')));
   child.once('close',()=>{clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',abort);if(signal.aborted)reject(Error('Aborted'));else if(answer&&!failure)resolve(answer);else reject(failure||Error('No answer'));});
  });
 }finally{await rm(directory,{recursive:true,force:true});}
}
export function createHarness({key,run=runHarness,tools=new ToolSessions({key:process.env.RELAY_TOOL_KEY})}){
 if(typeof key!=='string'||key.length<32)throw Error('Missing harness key');
 const active=new Set();let closing=false;
 const server=createServer(async(req,res)=>{
  const reply=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  if(req.method==='GET'&&req.url==='/healthz')return reply(closing?503:200,{ready:!closing,engine:'opencode',model:'deepseek-flash'});
  if(req.method==='POST'&&req.url==='/tool'){
   try{let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>14000)return reply(413,{});parts.push(chunk);}const body=JSON.parse(Buffer.concat(parts));
    if(!body||Object.keys(body).some(k=>!['name','args'].includes(k)))return reply(400,{});
    return reply(200,await tools.invoke(String(req.headers['x-relay-session']||''),body.name,body.args));
   }catch{return reply(409,{error:'查询权限不足或本轮已失效'});}
  }
  if(req.method!=='POST'||req.url!=='/reply')return reply(404,{});
  if(!timingSafeEqual(hash(req.headers['x-relay-ai-key']),hash(key)))return reply(403,{});
  if(closing||active.size>=2)return reply(503,{});
  const abort=new AbortController();active.add(abort);const cancel=()=>{if(!res.writableEnded)abort.abort();};res.once('close',cancel);
  let session;
  try{let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>200000)return reply(413,{});parts.push(chunk);}let input;try{input=validateContext(JSON.parse(Buffer.concat(parts)));}catch{return reply(400,{});}
   session=tools.open(input,abort.signal);const answer=await run(input,abort.signal,{sessionToken:session.token,finish:session.finish});abort.signal.throwIfAborted();reply(200,session.result(answer));
  }catch{reply(503,{error:'Assistant unavailable'});}finally{session?.close();abort.abort();active.delete(abort);res.removeListener('close',cancel);}
 });
 server.requestTimeout=150000;server.headersTimeout=10000;server.maxConnections=10;
 return{server,async stop(){closing=true;for(const abort of active)abort.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const runner=createHarness({key:process.env.RELAY_AI_KEY});runner.server.listen(5494,'0.0.0.0');
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await runner.stop();});
}
