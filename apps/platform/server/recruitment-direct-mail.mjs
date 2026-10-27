import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {mailboxSchema,workflowText as text,templateSchema,VARIABLE_LABELS,previewHash} from './recruitment-templates.mjs';
import {cleanMailHtml,escapeHtml,imageIds} from './recruitment-rich-mail.mjs';
import {MAIL_ATTACHMENT_LIMIT,MAIL_ATTACHMENT_COUNT} from './recruitment-mail-attachments.mjs';
import {MAX_MIME_BYTES} from './recruitment-mail.mjs';

const recipients=z.array(mailboxSchema).max(50);
const values=z.record(z.string(),text(1000));
export const directMailSchema=z.object({
  from:mailboxSchema,replyTo:mailboxSchema,to:recipients.min(1),cc:recipients.default([]),bcc:recipients.default([]),
  separate:z.boolean(),template:templateSchema,values:values.default({}),
  recipientValues:z.record(mailboxSchema,values).default({}),
  scheduledAt:z.string().datetime({offset:true}).optional(),
  attachments:z.array(z.uuid()).max(MAIL_ATTACHMENT_COUNT).default([]),
}).strict().superRefine((v,ctx)=>{
  const all=[...v.to,...v.cc,...v.bcc];
  if(all.length>50||new Set(all).size!==all.length)ctx.addIssue({code:'custom',message:'每批最多 50 个地址 收件人、抄送、密送之间不能重复'});
  if(Object.keys(v.recipientValues).some(a=>!v.to.includes(a))||!v.separate&&Object.keys(v.recipientValues).length)ctx.addIssue({code:'custom',message:'逐人变量仅用于分别发送的收件人'});
  if(new Set(v.attachments).size!==v.attachments.length)ctx.addIssue({code:'custom',message:'附件不能重复'});
});
export function renderDirectMail(template,raw){
  const labels={...VARIABLE_LABELS,...Object.fromEntries(template.variables.map(v=>[v.key,v.label]))};
  if(Object.keys(raw).some(k=>!Object.hasOwn(labels,k)))throw Error('存在未定义的模板变量');
  const variables=Object.assign(Object.create(null),Object.fromEntries(template.variables.map(v=>[v.key,v.defaultValue])),raw);
  const missing=new Set(template.variables.filter(v=>v.required&&!variables[v.key]).map(v=>v.label));
  const substitute=(source,html=false)=>source.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,(_,key)=>{
    if(!variables[key]&&(Object.hasOwn(VARIABLE_LABELS,key)||template.variables.some(v=>v.key===key&&v.required)))missing.add(labels[key]);
    return html?escapeHtml(variables[key]||''):variables[key]||'';
  });
  const subject=substitute(template.subject),body=substitute(template.body),html=cleanMailHtml(substitute(cleanMailHtml(template.html),true));
  if(missing.size)throw Error('请填写变量：'+[...missing].join('、'));
  if(/[\r\n]/.test(subject)||subject.length>300||body.length>20000||html.length>120000)throw Error('邮件主题或正文过长 或主题包含换行');
  return {subject,body,html,imageIds:imageIds(html)};
}

// Separate from candidate records; shares the durable outbox and permission checks.
export function createDirectMail({db,now,settings,mutate,requireOperator,canManage,audit,fail,deliveryMode,liveTestEmails,mailProfiles,readImage,readAttachment,mailAttachments,deliveryEvent,deliveryView}){
  db.exec('CREATE TABLE IF NOT EXISTS direct_mail_previews(id TEXT PRIMARY KEY,actor TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER)');
  const modeFor=p=>[...p.to,...p.cc,...p.bcc].every(a=>liveTestEmails.includes(a))?'live':deliveryMode;
  const senderAllowed=p=>{if(!settings().mailboxes.some(m=>m.enabled&&m.address===p.from))fail(409,'发件邮箱已停用 请重新预览');if(modeFor(p)==='live'&&!mailProfiles.some(m=>m.address===p.from&&m.configured))fail(409,'此邮箱尚未配置服务器发信凭证');};
  const read=id=>{const row=db.prepare('SELECT * FROM direct_mail_previews WHERE id=?').get(id);if(!row)fail(404,'邮件预览不存在');return {...row,data:JSON.parse(row.data)};};
  const snapshot=id=>{const row=read(id);return {...row.data,id,createdAt:new Date(row.created_at).toISOString(),sent:row.sent_at!==null,deliveries:db.prepare("SELECT * FROM deliveries WHERE candidate_id=? AND kind='direct' ORDER BY rowid").all(id).map(deliveryView)};};
  function validate(job,role){
    if(!canManage({subject:job.actor,role}))fail(403,'确认人的招新权限已撤销');
    const p=job.payload;
    const expected=modeFor(p)+(p.attachments?.length?'-files-v1':'')+(p.scheduledAt?'-schedule-v1':'');
    if(p.settingsRevision!==settings().revision||job.mode!==expected)fail(409,'发信配置或模式已改变 请重新预览');
    senderAllowed(p);mailAttachments(p);return null;
  }
  return {
    validateDirectDelivery:validate,
    directMailGet(actor,id){requireOperator(actor);return snapshot(z.uuid().parse(id));},
    directMailList(actor){requireOperator(actor);return {items:db.prepare("SELECT id,created_at,json_extract(data,'$.items[0].payload.subject') AS subject FROM direct_mail_previews WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 100").all().map(row=>({id:row.id,createdAt:new Date(row.created_at).toISOString(),subject:row.subject,deliveries:db.prepare("SELECT id,status,error,attempts,next_at,json_extract(payload,'$.scheduledAt') AS scheduled_at,json_extract(payload,'$.to') AS recipients FROM deliveries WHERE candidate_id=? AND kind='direct' ORDER BY rowid").all(row.id).map(d=>({id:d.id,status:d.status,error:d.error,attempts:d.attempts,scheduledAt:d.scheduled_at,nextAt:new Date(d.next_at).toISOString(),to:JSON.parse(d.recipients)}))})),mode:deliveryMode};},
    previewDirectMail(actor,raw){
      requireOperator(actor);const input=z.object({requestId:z.uuid(),mail:directMailSchema}).strict().parse(raw);
      return mutate(actor,input,'direct-preview',()=>{
        const m=input.mail;senderAllowed(m);if(m.scheduledAt&&(Date.parse(m.scheduledAt)<now()+60000||Date.parse(m.scheduledAt)>now()+30*86400000))fail(400,'发送时间须在 1 分钟至 30 天之内');
        const attachments=m.attachments.map(id=>{const {buffer,...metadata}=readAttachment(actor,id);return metadata;});
        const groups=m.separate?m.to.map(to=>[to]):[m.to];
        const items=groups.map(to=>{
          let rendered;try{rendered=renderDirectMail(m.template,{...m.values,...(m.separate?m.recipientValues[to[0]]:{})});}catch(e){fail(400,(m.separate?to[0]+'：':'')+e.message);}
          if(rendered.imageIds.length>8)fail(400,'单封邮件最多 8 张图片');
          const images=rendered.imageIds.map(id=>readImage(actor,id));
          if(images.reduce((n,i)=>n+i.bytes,0)>8*1024*1024)fail(400,'邮件图片总计不超过 8 MB');
          if(attachments.reduce((n,a)=>n+a.bytes,0)+images.reduce((n,i)=>n+i.bytes,0)>MAIL_ATTACHMENT_LIMIT)fail(400,'附件与正文图片合计不能超过 10 MB');
          // All parts use base64 with 76-column wrapping; reserve room for
          // headers, boundaries and UTF-8 filenames before enqueueing.
          const estimate=[...attachments,...images].reduce((n,f)=>n+Math.ceil(f.bytes/57)*78,0)+[rendered.html,rendered.body].reduce((n,t)=>n+Math.ceil(Buffer.byteLength(t)/57)*78,0)+65536;
          if(estimate>MAX_MIME_BYTES)fail(400,'邮件总大小过大，请减少附件或缩短正文');
          const p={kind:'direct',from:m.from,to,cc:m.cc,bcc:m.bcc,replyTo:m.replyTo,...rendered,attachments,...(m.scheduledAt?{scheduledAt:m.scheduledAt}:{}),settingsRevision:settings().revision};
          // Older APIs reject this mode and older Workers cannot claim it;
          // rollback must never send a new message with its files omitted.
          return {payload:p,mode:modeFor(p)+(attachments.length?'-files-v1':'')+(m.scheduledAt?'-schedule-v1':'')};
        });
        if(Buffer.byteLength(JSON.stringify(items))>2*1024*1024)fail(400,'本批邮件内容过多 请减少收件人或正文长度');
        const id=randomUUID(),data={items,separate:m.separate,expiresAt:new Date(now()+15*60000).toISOString()};
        data.previewHash=previewHash({id,actor:actor.subject,...data});
        db.prepare('INSERT INTO direct_mail_previews VALUES(?,?,?,?,NULL)').run(id,actor.subject,JSON.stringify(data),now());
        return snapshot(id);
      });
    },
    sendDirectMail(actor,raw){
      const input=z.object({requestId:z.uuid(),id:z.uuid(),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
      return mutate(actor,input,'direct-send',()=>{
        const row=read(input.id),p=row.data;
        if(row.actor!==actor.subject)fail(403,'请由生成预览的本人确认发送');
        if(row.sent_at!==null)fail(409,'此预览已确认发送 请查看发送记录');
        if(p.previewHash!==input.previewHash||Date.parse(p.expiresAt)<=now())fail(409,'预览已过期或改变 请重新预览');
        const bucket=Math.floor(now()/3600000),count=p.items.reduce((n,i)=>n+i.payload.to.length+i.payload.cc.length+i.payload.bcc.length,0);
        const budget=db.prepare("INSERT INTO budgets VALUES('direct-mail',?,?,?) ON CONFLICT(scope,key,bucket) DO UPDATE SET count=count+excluded.count RETURNING count").get(actor.subject,bucket,count);
        if(budget.count>200)fail(429,'每位操作人每小时最多发送 200 个收件地址');
        for(const item of p.items){
          if(item.payload.scheduledAt&&Date.parse(item.payload.scheduledAt)<=now())fail(409,'定时发送时间已到，请返回编辑重新选择');
          validate({...item,actor:actor.subject},actor.role);
          const id=randomUUID();db.prepare("INSERT INTO deliveries(id,candidate_id,kind,mode,status,payload,actor,created_at,updated_at,next_at) VALUES(?,?,'direct',?,'QUEUED',?,?,?,?,?)").run(id,input.id,item.mode,JSON.stringify(item.payload),actor.subject,now(),now(),item.payload.scheduledAt?Date.parse(item.payload.scheduledAt):now());deliveryEvent(id,'QUEUED');
        }
        db.prepare('UPDATE direct_mail_previews SET sent_at=? WHERE id=?').run(now(),input.id);audit(actor,'direct-mail-send',{id:input.id,messages:p.items.length,recipients:count});return snapshot(input.id);
      });
    },
    cancelDirectMail(actor,raw){const input=z.object({requestId:z.uuid(),id:z.uuid()}).strict().parse(raw);return mutate(actor,input,'direct-cancel',()=>{const row=read(input.id);if(row.actor!==actor.subject&&actor.role!=='super_admin')fail(403,'只能取消自己创建的邮件');const jobs=db.prepare("SELECT * FROM deliveries WHERE candidate_id=? AND kind='direct'").all(input.id);if(!jobs.length||jobs.some(j=>!['QUEUED','RETRYING'].includes(j.status)||!JSON.parse(j.payload).scheduledAt||Date.parse(JSON.parse(j.payload).scheduledAt)<=now()))fail(409,'邮件已开始处理或不是待发送的定时邮件，不能取消');for(const j of jobs){db.prepare("UPDATE deliveries SET status='CANCELLED',updated_at=? WHERE id=?").run(now(),j.id);deliveryEvent(j.id,'CANCELLED');}audit(actor,'direct-mail-cancel',{id:input.id});return snapshot(input.id);});},
    manageDirectDelivery(actor,raw){
      const input=z.object({requestId:z.uuid(),id:z.uuid(),action:z.enum(['retry','sent','not_sent']),note:text(2000).default('')}).strict().parse(raw);
      return mutate(actor,input,'direct-delivery',()=>{
        const row=db.prepare("SELECT * FROM deliveries WHERE id=? AND kind='direct'").get(input.id);if(!row)fail(404,'发送记录不存在');
        if(input.action==='retry'){
          if(row.status!=='FAILED')fail(409,'仅明确失败的任务可以重试 待核实的任务须先核实结果');
          if(row.attempts>=8)fail(429,'已达到重试上限');
          validate({...row,payload:JSON.parse(row.payload),actor:actor.subject},actor.role);
          db.prepare("UPDATE deliveries SET status='QUEUED',actor=?,updated_at=?,next_at=?,error=NULL WHERE id=?").run(actor.subject,now(),now(),row.id);deliveryEvent(row.id,'QUEUED');
        }else{
          if(row.status!=='UNKNOWN'||!input.note)fail(409,'请为待核实任务填写核实依据');
          const status=input.action==='sent'?'SENT':'FAILED';db.prepare("UPDATE deliveries SET status=?,error='MANUALLY_VERIFIED',updated_at=? WHERE id=?").run(status,now(),row.id);deliveryEvent(row.id,status,'MANUALLY_VERIFIED');
        }
        audit(actor,'direct-mail-'+input.action,{id:row.id,note:input.note});return snapshot(row.candidate_id);
      });
    },
  };
}
