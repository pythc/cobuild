import{randomBytes}from'node:crypto';
export class ToolSessions{
 constructor({key,endpoint='http://relay-support-tools:5495/invoke',request=fetch,now=Date.now}={}){this.key=key;this.endpoint=endpoint;this.request=request;this.now=now;this.sessions=new Map();}
 open(context,signal){
  for(const[id,s]of this.sessions)if(s.expires<this.now())this.sessions.delete(id);
  if(this.sessions.size>=8)throw Error('Tool sessions busy');
  const token=randomBytes(32).toString('hex'),s={context,signal,expires:this.now()+140000,count:0,busy:false,records:[],answer:null};this.sessions.set(token,s);
  return{token,finish:args=>this.invoke(token,'finish_answer',args),result:answer=>{if(!s.answer||JSON.stringify(s.answer)!==JSON.stringify(answer))throw Error('Unconfirmed answer');return answer;},close:()=>this.sessions.delete(token)};
 }
 async invoke(token,name,args){
  const s=this.sessions.get(token);if(!s||s.expires<this.now()||s.signal.aborted||s.busy||s.answer)throw Error('会话已失效或正在查询');
  s.busy=true;try{
   if(name==='finish_answer'){
    if(!args||Object.keys(args).some(k=>!['answer','handoff'].includes(k))||typeof args.answer!=='string'||!args.answer.trim()||args.answer.length>3000||typeof args.handoff!=='boolean')throw Error('回答无效');
    s.answer=s.records.length&&s.records.every(r=>r.failed)?{answer:'本次后台查询未能完成，需要人工继续核对。',handoff:true}:{answer:args.answer,handoff:args.handoff};return s.answer;
   }
   if(!['query_database','search_logs','service_status','search_knowledge'].includes(name)||++s.count>10)throw Error('没有工具权限或本轮次数已用完');
   try{
    if(!this.key||!s.context.scope)throw Error('Backend scope unavailable');
    const response=await this.request(this.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.any([s.signal,AbortSignal.timeout(32000)]),headers:{'Content-Type':'application/json','X-Relay-Tool-Key':this.key},body:JSON.stringify({sessionId:token,context:s.context,name,args})});
    const text=await response.text();if(Buffer.byteLength(text)>48000)throw Error('Result limit');const value=JSON.parse(text);
    if(!response.ok||value.status==='unavailable')throw Error('Query unavailable');
    s.signal.throwIfAborted();s.records.push({name,failed:false});return value;
   }catch{if(s.signal.aborted)throw Error('Aborted');s.records.push({name,failed:true});return{status:'unavailable',note:'本次查询未成功或当前账号无此权限，不能据此判断系统正常或操作成功。'};}
  }finally{s.busy=false;}
 }
}
