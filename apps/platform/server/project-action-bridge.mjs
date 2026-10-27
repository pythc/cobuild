import {createHmac,timingSafeEqual} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {WorkspaceError} from './workspace-store.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function verifyProjectBridge(input,signature,{secretPath=process.env.PORTAL_MAKIT_PROJECT_BRIDGE_SECRET_FILE,secret,now=Date.now}={}){
  if(!secret){try{const stat=lstatSync(secretPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>1024)throw new Error();secret=readFileSync(secretPath,'utf8').trim();}catch{throw new WorkspaceError(503,'项目管理连接尚未配置');}}
  if(typeof secret!=='string'||secret.length<32)throw new WorkspaceError(503,'项目管理连接尚未配置');
  if(!input||Object.keys(input).some(k=>!['requestId','subject','at','action','projectId','input'].includes(k))||!UUID.test(input.requestId||'')||!UUID.test(input.projectId||'')||typeof input.subject!=='string'||input.subject.length>256||!Number.isSafeInteger(input.at)||Math.abs(now()-input.at)>60000)throw new WorkspaceError(401,'服务请求无效');
  if(!['read','knowledge_link','milestone_add','milestone_set'].includes(input.action))throw new WorkspaceError(400,'操作无效');
  const expected=createHmac('sha256',secret).update(JSON.stringify(input)).digest('hex');
  if(typeof signature!=='string'||!/^[0-9a-f]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new WorkspaceError(401,'服务身份无效');
  return input;
}
export async function runProjectBridge(envelope,{store,mail}){
  let actor=await mail.projectBridgeActor(envelope.subject);
  await mail.authorizeApplication?.(actor,'projects');
  actor=await mail.projectBridgeActor(envelope.subject);
  mail.assertApplication?.(actor,'projects');
  const {action,projectId,input,requestId}=envelope;
  const current=store.get(actor,projectId);
  if(action==='read')return current;
  const command=()=>{
    if(action==='knowledge_link'){
      if(!input||Object.keys(input).some(k=>!['revision','url'].includes(k))||typeof input.url!=='string')throw new WorkspaceError(400,'链接无效');
      return store.update(actor,projectId,{revision:input.revision,name:current.name,summary:current.summary,members:current.members,links:{...current.links,knowledgeSpace:input.url}});
    }
    if(action==='milestone_add')return store.addMilestone(actor,projectId,input);
    if(!input||Object.keys(input).some(k=>!['id','revision','status'].includes(k))||!UUID.test(input.id||''))throw new WorkspaceError(400,'里程碑无效');
    return store.setMilestone(actor,projectId,input.id,{revision:input.revision,status:input.status});
  };
  store.durable(actor,requestId,'makit_'+action,{projectId,input},command);
  return store.get(actor,projectId);
}
