import {ContractError} from '../../../packages/contracts/index.mjs';
import {suiteConfig,moduleEnabled,portalHost,portalRequestOrigin} from '../../../packages/config/runtime.mjs';
import {verifyProjectBridge,runProjectBridge} from './project-action-bridge.mjs';
import {projectKnowledgeWorker} from './project-knowledge-worker.mjs';
import {z} from 'zod';
import {openWorkspaceStore,WorkspaceError} from './workspace-store.mjs';
import {openWorkspaceRecruitment} from './workspace-recruitment.mjs';
import {MailAuthError} from './mail-auth.mjs';
import {MailAccessError} from './mail-access-store.mjs';
import appConfig from '../src/projects.json' with {type:'json'};
import {openWorkbenchPreferencesStore,WorkbenchPreferencesError} from './workbench-preferences-store.mjs';
import {projectSyncWorker} from './project-sync-worker.mjs';

const messages={unauthenticated:'请先通过飞书登录',forbidden:'没有此操作的权限',not_found:'项目或里程碑不存在',revision_conflict:'内容已被更新 请重新加载后再操作',pending_locked:'项目正在审批 暂时不能修改',invalid_phase:'项目状态已改变 请重新加载',archived:'项目已归档 请先恢复',member_has_open_milestones:'请先处理该成员尚未完成的里程碑',milestone_quota:'单个项目最多可添加 100 个里程碑',owner_quota:'已达到个人项目数量上限',project_quota:'已达到实验室项目数量上限',invalid_note:'退回时请填写原因',invalid_due:'请选择有效的截止日期',assignee_out_of_scope:'负责人必须是项目成员',invalid_input:'请检查填写的内容',no_change:'状态已更新 请刷新',store_unavailable:'工作台暂时不可用',store_corrupt:'工作台暂时不可用'};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'});res.end(JSON.stringify(value));};
async function body(req){
  if(req.headers['content-type']!=='application/json')throw new WorkspaceError(415,'请求格式无效');
  if(Number(req.headers['content-length']||0)>32768)throw new WorkspaceError(413,'内容过长');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error);}else resolve();};
    const data=c=>{size+=c.length;if(size>32768)finish(new WorkspaceError(413,'内容过长'));else chunks.push(c);};
    const end=()=>finish(),abort=()=>finish(new WorkspaceError(400,'请求中断'));
    const timer=setTimeout(()=>finish(new WorkspaceError(408,'请求超时')),8000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new WorkspaceError(400,'请求格式无效');}
}

export function createWorkspaceHttp({mail,knowledgeWorkerEnabled=true,apps=appConfig.apps,recruitment,honorsTodos=()=>[],localTest=false,now=Date.now,directory=mail?.workspaceDirectory,projectSyncEnabled=process.env.PORTAL_PROJECT_SYNC_ENABLED==='true',projectSyncClient,knowledgeProjectClient,projectBridgeSecret}={}){
  const enabled=!!mail?.enabled&&!!directory;
  const store=enabled?openWorkspaceStore({directory,now,syncProjects:projectSyncEnabled,organizationId:mail.auth?.organizationId}):null;
  let inbox;try{inbox=enabled&&moduleEnabled('hiflow')?openWorkspaceRecruitment({directory,source:()=>recruitment.labInbox(),canManage:a=>recruitment.store?.canManage?.(a)||['admin','super_admin'].includes(a.role),now}):null;}catch(e){store?.close();throw e;}
  let preferences;try{preferences=enabled?openWorkbenchPreferencesStore({directory,allowedAppIds:apps.map(app=>app.id),now}):null;}catch(e){inbox?.close();store?.close();throw e;}
  const projectSync=store?projectSyncWorker({store,mail,client:projectSyncClient,enabled:projectSyncEnabled}):null;
  const knowledgeWorker=store&&knowledgeWorkerEnabled?projectKnowledgeWorker({store,client:knowledgeProjectClient}):null;
  const writes=new Map();
  function throttle(actor){const time=now(),old=writes.get(actor.subject),v=old&&time-old.at<60000?old:{at:time,count:0};
    if(++v.count>60)throw new WorkspaceError(429,'操作频繁 请稍后再试');
    if(writes.size>2000)for(const [key,row] of writes)if(time-row.at>=60000)writes.delete(key);
    writes.set(actor.subject,v);
  }
  async function canonicalMembers(actor,input,existing=[]){
    if(!Array.isArray(input?.members))return input;
    if(input.members.length>100)throw new WorkspaceError(400,'项目成员过多');
    const directory=new Map((await mail.projectMembers(actor.subject)).members.map(m=>[m.subject,m]));
    // Existing project members can be retained during a directory outage. They
    // cannot be invented by the client or borrowed from another project.
    for(const member of existing)if(!directory.has(member.subject))directory.set(member.subject,member);
    return {...input,members:input.members.map(value=>{
      const member=directory.get(value?.subject);
      if(!member)throw new WorkspaceError(400,'请选择列表中的实验室成员');
      // Directory rows also contain employeeId/avatarUrl. Persist only the
      // project member contract, and never trust client-supplied names/emails.
      return {subject:member.subject,name:member.name,email:member.email};
    })};
  }
  return {enabled,store,canonicalMembers,favorites:actor=>preferences.get(actor),projects:actor=>store?.list(actor).projects||[],async close(){await knowledgeWorker?.close();if(!projectSync){preferences?.close();inbox?.close();store?.close();return Promise.resolve();}return projectSync.close().finally(()=>{preferences?.close();inbox?.close();store?.close();});},async handle(req,res,path,host){
    if(!path.startsWith('/api/workspace/'))return false;
    try{
      if(host!==portalHost()&&!(localTest&&['localhost','127.0.0.1'].includes(host)))throw new WorkspaceError(404,'Not found');
      if(!enabled)throw new WorkspaceError(503,'工作台登录尚未配置');
      if(path==='/api/workspace/project-actions'){
        if(suiteConfig)throw new WorkspaceError(404,'Not found');
        if(req.method!=='POST'||req.headers.origin||req.headers['sec-fetch-site'])throw new WorkspaceError(403,'仅供服务连接使用');
        const envelope=verifyProjectBridge(await body(req),req.headers['x-project-signature'],{secret:localTest?projectBridgeSecret:undefined,now});
        throttle({subject:envelope.subject});
        json(res,200,await runProjectBridge(envelope,{store,mail}));return true;
      }
      if(!['GET','POST'].includes(req.method))throw new WorkspaceError(405,'请求方式无效');
      const embedded=path.startsWith('/api/workspace/embedded/'),route=path.slice(embedded?24:15),write=req.method==='POST';
      if(write){const origin=req.headers.origin;const ok=portalRequestOrigin(req,localTest);
        if(!ok||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new WorkspaceError(403,'请通过工作台操作');}
      const projectActor=async()=>{
        const first=mail.identity(req,{embedded,write});
        await mail.authorizeApplication?.(first,'projects');
        const current=mail.identity(req,{embedded,write});
        mail.assertApplication?.(current,'projects');
        return current;
      };
      let actor=mail.identity(req,{embedded,write});
      if (/^(?:projects(?:\/|$)|members$)/.test(route)) {
        actor=await projectActor();
      }
      if(!write){
        if(route==='session')json(res,200,actor);
        else if(route==='preferences')json(res,200,{...preferences.get(actor),subject:actor.subject});
        else if(route==='members')json(res,200,await mail.projectMembers(actor.subject));
        else if(route==='projects')json(res,200,store.list(actor));
        else if(/^projects\/operations\/[a-f0-9-]+$/.test(route))json(res,200,store.operation(actor,route.split('/')[2]));
        else if(route==='todos'){
          const allowed={};for(const id of ['projects','honors','recruitment-test']){try{await mail.authorizeApplication?.(actor,id);allowed[id]=true;}catch(e){if(e.status!==403)throw e;allowed[id]=false;}}
          actor=mail.identity(req,{embedded});for(const id of Object.keys(allowed))if(allowed[id]){try{mail.assertApplication?.(actor,id);}catch(e){if(e.status!==403)throw e;allowed[id]=false;}}
          const admin=['admin','super_admin'].includes(actor.role),recruit=allowed['recruitment-test']&&(admin||recruitment.store?.canManage?.(actor))?inbox.list(actor):{state:'restricted',items:[],partial:false};
          json(res,200,{items:[...(allowed.projects?store.listTodos(actor).items:[]),...recruit.items,...(allowed.honors?honorsTodos(actor):[])],sources:{recruitment:{state:recruit.state,partial:recruit.partial},assessment:{state:'external'}}});
        }else if(route==='recruitment/history')json(res,200,inbox.history(actor));
        else{const match=/^projects\/([\w-]+)(\/audit)?$/.exec(route);if(!match)throw new WorkspaceError(404,'Not found');
          json(res,200,match[2]?{events:store.audit(actor,match[1])}:store.get(actor,match[1]));}
      }else{
        throttle(actor);const input=await body(req);
        if(/^projects(?:\/|$)/.test(route))actor=await projectActor();
        if(route==='preferences'){actor=mail.identity(req,{embedded,write:true});json(res,200,{...preferences.update(actor,input),subject:actor.subject});return true;}
        if(route==='projects'){
          if(!input||typeof input!=='object'||Array.isArray(input))throw new WorkspaceError(400,'invalid_input');
          const {requestId,...fields}=input;
          if(suiteConfig&&!knowledgeWorkerEnabled&&fields.createKnowledgeSpace)throw new WorkspaceError(503,'自动创建 WeKnow 空间的连接尚未启用');
          if(requestId!==undefined&&!z.uuid().safeParse(requestId).success)throw new WorkspaceError(400,'invalid_input');
          const canonical=await canonicalMembers(actor,fields);actor=await projectActor();
          const value=requestId?store.durable(actor,requestId,'web_project_create',fields,()=>store.create(actor,canonical)):store.create(actor,canonical);
          // A replay returns the same project but its latest synchronization state.
          json(res,201,store.get(actor,value.id));return true;
        }
        const handled=/^recruitment\/([\w-]+)\/handled$/.exec(route);
        if(handled){json(res,200,inbox.handle(actor,handled[1],input));return true;}
        const knowledgeRetry=/^projects\/([\w-]+)\/knowledge-space\/retry$/.exec(route);
        if(knowledgeRetry){z.object({}).strict().parse(input);const p=store.get(actor,knowledgeRetry[1]);
          if(p.ownerSubject!==actor.subject&&!['admin','super_admin'].includes(actor.role))throw new WorkspaceError(403,'forbidden');store.knowledgeSpaces.retry(p.id);json(res,200,store.get(actor,p.id));return true;}
        const retry=/^projects\/([\w-]+)\/requirements-sync\/retry$/.exec(route);
        if(retry){
          if(!projectSyncEnabled)throw new WorkspaceError(503,'需求平台连接尚未启用');
          z.object({}).strict().parse(input);
          const p=store.get(actor,retry[1]);if(p.ownerSubject!==actor.subject&&!['admin','super_admin'].includes(actor.role))throw new WorkspaceError(403,'forbidden');
          store.requirementsSync.retry(p.id);json(res,200,store.get(actor,p.id));return true;
        }
        const m=/^projects\/([\w-]+)\/(update|rename|apply|review|archive|milestones)(?:\/([\w-]+))?$/.exec(route);
        if(!m||m[3]&&m[2]!=='milestones')throw new WorkspaceError(404,'Not found');
        const [,id,action,mid]=m;
        const canonical=action==='update'?await canonicalMembers(actor,input,store.get(actor,id).members):input;
        actor=await projectActor();
        const value=action==='milestones'?(mid?store.setMilestone(actor,id,mid,input):store.addMilestone(actor,id,input)):
          store[action](actor,id,canonical);
        json(res,200,value);
      }
    }catch(e){
      req.resume();if(res.headersSent||res.destroyed)return true;
      if(e instanceof ContractError)json(res,e.status,{error:e.code==='REQUEST_CONFLICT'?'同一请求编号的内容已改变，请重新提交':e.code==='OPERATION_NOT_FOUND'?'操作记录不存在':'操作请求无效',code:e.code});
      else if(e?.code==='REQUEST_CONFLICT'&&e.status===409)json(res,409,{error:'这次创建请求的内容已改变，请重新打开新建项目后提交'});
      else if(e instanceof WorkbenchPreferencesError)json(res,e.status,{error:e.message,code:e.code});
      else if(e instanceof WorkspaceError||e instanceof MailAuthError)json(res,e.status,{error:messages[e.message]||(/^[a-z_]+$/.test(e.message)?'操作未完成 请检查内容后重试':e.message)});
      else if(e instanceof MailAccessError)json(res,e.status,{error:'实验室身份或权限已变更 请重新登录'});
      else if(e instanceof z.ZodError)json(res,400,{error:'请检查填写的内容'});
      else{console.error('Workspace request failed',e.code||e.name);json(res,503,{error:'工作台暂时不可用 请稍后重试'});}
    }
    return true;
  }};
}
