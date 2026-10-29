import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {commandJournal} from './durable-command.mjs';

const startSchema=z.object({requestId:z.uuid(),revision:z.number().int().positive(),recipientSubject:z.string().min(1).max(200)}).strict();
const finishSchema=z.object({requestId:z.uuid(),transferId:z.uuid()}).strict();
export const parseProjectTransferInput=(action,input)=>(action==='start'?startSchema:finishSchema).parse(input);

// Uses the project's database/transaction and the live local identity provider.
// Caller supplies app authorization; no client profile or cached role is trusted.
export function projectTransferStore(db,{now,resolveActor,loadProject,fail,commit,isConfigured}){
  const journal=commandJournal(db),ttl=24*60*60*1000;
  const admin=a=>['admin','super_admin'].includes(a?.role);
  const active=subject=>{try{const a=resolveActor(subject);return a?.subject===subject?a:null;}catch{return null;}};
  const allowed=(a,p)=>a&&(p.owner_subject===a.subject||admin(a));
  const eligible=p=>!p.archived&&p.phase!=='pending'&&isConfigured(p.id);
  const members=p=>JSON.parse(p.members_json);
  const row=id=>db.prepare('SELECT * FROM collaboration_project_transfers_v1 WHERE id=?').get(id);
  const latest=id=>db.prepare('SELECT * FROM collaboration_project_transfers_v1 WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  function state(t,p){
    if(t.state!=='pending')return t.state;
    if(now()>=t.expires_at)return 'expired';
    if(!eligible(p)||p.revision!==t.revision||p.owner_subject!==t.owner_subject||!members(p).some(m=>m.subject===t.recipient_subject))return 'invalidated';
    if(!active(t.owner_subject)||!active(t.recipient_subject)||!allowed(active(t.initiator_subject),p))return 'invalidated';
    return 'pending';
  }
  function dto(t,p,a){
    if(!t)return null;
    const status=state(t,p),person=active(t.recipient_subject)||members(p).find(m=>m.subject===t.recipient_subject);
    return {id:t.id,state:status,recipientSubject:t.recipient_subject,recipientName:person?.name||'成员',initiatorSubject:t.initiator_subject,
      expiresAt:new Date(t.expires_at).toISOString(),canAccept:status==='pending'&&a.subject===t.recipient_subject,
      canCancel:status==='pending'&&(allowed(a,p)||a.subject===t.recipient_subject||a.subject===t.initiator_subject)};
  }
  function summary(p,actor){
    const a=active(actor.subject);if(!a)fail(401,'unauthenticated');
    const current=latest(p.id),pending=current&&state(current,p)==='pending';
    return {enabled:true,canStart:eligible(p)&&allowed(a,p)&&!pending,current:dto(current,p,a)};
  }
  function execute(actor,id,action,input){
    const parsed=(action==='start'?startSchema:finishSchema).safeParse(input);if(!parsed.success)fail(400,'invalid_input');
    const {requestId,...data}=parsed.data,p=loadProject(id),a=active(actor.subject);if(!a)fail(401,'unauthenticated');
    const t=action==='start'?null:row(data.transferId);
    if(action==='start'){if(!allowed(a,p))fail(403,'forbidden');}
    else {
      if(!t||t.project_id!==id)fail(404,'not_found');
      if(action==='accept'?a.subject!==t.recipient_subject:!(allowed(a,p)||a.subject===t.recipient_subject||a.subject===t.initiator_subject))fail(403,'forbidden');
    }
    // Authorize first, even on a replay; store only stable transfer identity.
    const receipt=journal(a,requestId,'project_transfer_'+action,{projectId:id,...data},()=>{
      if(action==='start'){
        if(!eligible(p))fail(409,'invalid_phase');
        if(p.revision!==data.revision)fail(409,'revision_conflict');
        if(!active(p.owner_subject)||!active(data.recipientSubject))fail(409,'transfer_identity_changed');
        if(data.recipientSubject===p.owner_subject||!members(p).some(m=>m.subject===data.recipientSubject))fail(400,'assignee_out_of_scope');
        const old=latest(id);if(old&&state(old,p)==='pending')fail(409,'transfer_pending');
        db.prepare("UPDATE collaboration_project_transfers_v1 SET state='invalidated',resolved_at=? WHERE project_id=? AND state='pending'").run(now(),id);
        const transferId=randomUUID();
        db.prepare("INSERT INTO collaboration_project_transfers_v1 VALUES(?,?,?,?,?,?,'pending',?,?,NULL)")
          .run(transferId,id,p.revision,p.owner_subject,a.subject,data.recipientSubject,now(),now()+ttl);
        db.prepare('INSERT INTO audit(project_id,action,actor_subject,actor_name,at,note) VALUES(?,?,?,?,?,?)')
          .run(id,'transfer_start',a.subject,a.name,new Date(now()).toISOString(),active(data.recipientSubject).name);
        return {transferId};
      }
      if(state(t,p)!=='pending')fail(409,'transfer_inactive');
      if(action==='accept'){
        // Uses live canonical profiles, keeps the former owner in the roster.
        commit(p,a,active(p.owner_subject));
      }
      db.prepare('UPDATE collaboration_project_transfers_v1 SET state=?,resolved_at=? WHERE id=? AND state=\'pending\'')
        .run(action==='accept'?'accepted':'cancelled',now(),t.id);
      db.prepare('INSERT INTO audit(project_id,action,actor_subject,actor_name,at,note) VALUES(?,?,?,?,?,?)')
        .run(id,'transfer_'+action,a.subject,a.name,new Date(now()).toISOString(),a.name);
      return {transferId:t.id};
    });
    return dto(row(receipt.transferId),loadProject(id),a);
  }
  return {summary,execute,pendingFor(actor){return db.prepare("SELECT * FROM collaboration_project_transfers_v1 WHERE recipient_subject=? AND state='pending'").all(actor.subject).filter(t=>state(t,loadProject(t.project_id))==='pending');}};
}
