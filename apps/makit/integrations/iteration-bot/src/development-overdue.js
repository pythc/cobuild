import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,lstatSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

function startTime(value){if(value==null||value==='')return NaN;const numeric=Number(value);return Number.isFinite(numeric)&&numeric>10000000000?numeric:Date.parse(String(value).replace(' ','T'));}
export function developmentOverdueTargets(requirement,now){
  const start=startTime(requirement.actualStart),effort=requirement.effort;
  if(requirement.status!=='开发中'||requirement.type==='工单'||effort==null||!Number.isFinite(effort)||effort<0||!Number.isFinite(start)||!Number.isFinite(new Date(start+effort*86400000).getTime())||now<=start+effort*86400000)return [];
  return [...new Map((requirement.developers||[]).filter(p=>/^ou_[A-Za-z0-9_-]+$/.test(p.id)).map(p=>[p.id,p])).values()].map(person=>({
    key:createHash('sha256').update(JSON.stringify([requirement.recordId,start,person.id])).digest('hex'),person,start,due:start+effort*86400000,effort,
  }));
}

/** Reserve durably before sending. Ambiguous attempts stay isolated instead of being resent. */
export function createDevelopmentOverdue({rootDir,config,base,sendPost,requirementUrl,now=Date.now,log=()=>{}}){
  if(typeof requirementUrl!=='function')throw new Error('Canonical requirement URL adapter required');
  const directory=join(rootDir,'state','development-overdue');mkdirSync(directory,{recursive:true,mode:0o700});
  if(lstatSync(directory).isSymbolicLink())throw new Error('Unsafe reminder directory');
  const file=join(directory,'deliveries.sqlite');if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw new Error('Unsafe reminder database');
  const db=new DatabaseSync(file);chmodSync(file,0o600);
  db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reminders(key TEXT PRIMARY KEY,requirement_id TEXT NOT NULL,target_id TEXT NOT NULL,start INTEGER NOT NULL,state TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;");
  let running=null,lastScan=-Infinity;
  async function scan(){
    const count={sent:0,unknown:0,blocked:0};
    const requirements=await base.listAllRequirements();
    for(const requirement of requirements)for(const target of developmentOverdueTargets(requirement,now())){
      const inserted=db.prepare("INSERT OR IGNORE INTO reminders(key,requirement_id,target_id,start,state,created_at,updated_at) VALUES(?,?,?,?,'sending',?,?)").run(target.key,requirement.recordId,target.person.id,target.start,now(),now());
      if(!inserted.changes)continue;
      try{
        const date=ms=>new Date(ms).toLocaleString('zh-CN',{timeZone:config.runtime?.timezone||'Asia/Shanghai',hour12:false});
        const response=await sendPost({userId:target.person.id},{zh_cn:{title:'需求开发超时',content:[
          [{tag:'text',text:`${requirement.code||requirement.recordId} ${requirement.title}`}],
          [{tag:'text',text:`开发工作量：${target.effort} 个自然日；本轮开发开始：${date(target.start)}；预计完成：${date(target.due)}。请及时更新进展。`}],
          [{tag:'a',text:'查看需求',href:requirementUrl(requirement)}],
        ]}},target.key.slice(0,50),{purpose:'development-overdue',requirementId:requirement.recordId});
        if(response?.blocked){db.prepare("DELETE FROM reminders WHERE key=? AND state='sending'").run(target.key);count.blocked++;continue;}
        const envelope=response?.response;const messageId=envelope?.response?.data?.message_id||envelope?.data?.data?.message_id||envelope?.data?.message_id||envelope?.result?.message_id||envelope?.message_id;
        if(!/^om_[A-Za-z0-9_-]+$/.test(messageId||''))throw new Error('Delivery receipt missing');
        db.prepare("UPDATE reminders SET state='sent',message_id=?,updated_at=? WHERE key=?").run(messageId,now(),target.key);count.sent++;
      }catch{
        db.prepare("UPDATE reminders SET state='unknown',updated_at=? WHERE key=? AND state='sending'").run(now(),target.key);count.unknown++;
        log('error','[development-overdue] delivery result requires inspection; not automatically resent');
      }
    }
    lastScan=now();return count;
  }
  return {runOnce(){
    if(config.developmentOverdue?.enabled!==true||process.env.WORKFLOW_DELIVERY_OWNER==='managed_bot'||now()-lastScan<300000)return Promise.resolve({sent:0});
    if(running)return running;
    running=scan().catch(error=>{lastScan=now()-240000;throw error;}).finally(()=>{running=null;});return running;
  },close(){db.close();}};
}
