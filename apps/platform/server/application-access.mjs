import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
export class ApplicationAccessError extends Error{constructor(status,message,code='APP_ACCESS_DENIED'){super(message);this.status=status;this.code=code;}}
const fail=(status,message,code)=>{throw new ApplicationAccessError(status,message,code);};
const subject=z.string().regex(/^[A-Za-z0-9_-]{4,80}:on_[A-Za-z0-9_-]{10,100}$/);
const fields=z.object({mode:z.enum(['inherit','everyone','restricted']),subjects:z.array(subject).max(1000),departmentIds:z.array(z.string().regex(/^od-[A-Za-z0-9_-]{1,100}$/)).max(100)}).strict();
export const applicationScope=scope=>({'projects':'projects','honors':'honors','recruitment':'recruitment-test','mail':'public-mail','updates':'updates-admin'})[String(scope).split(':')[0]]||null;
function privateFile(path,create=false){if(create){try{closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail(503,'应用权限存储不可用');chmodSync(path,0o600);}
export function openApplicationAccess({directory,apps,profile,fetchSnapshot,now=Date.now,interval=60000}){
  mkdirSync(directory,{recursive:true,mode:0o700});const ds=lstatSync(directory);if(!ds.isDirectory()||ds.isSymbolicLink())fail(503,'应用权限存储不可用');chmodSync(directory,0o700);
  const file=join(directory,'application-access.sqlite');privateFile(file,true);for(const suffix of ['-wal','-shm'])try{privateFile(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(file);try{db.exec(`PRAGMA busy_timeout=3000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS app_access(app_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,policy TEXT NOT NULL,updated_at INTEGER NOT NULL,actor TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS app_access_audit(id INTEGER PRIMARY KEY,app_id TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL,policy TEXT NOT NULL) STRICT;`);
  for(const suffix of ['-wal','-shm'])try{privateFile(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
  }catch(e){db.close();throw e;}
  const catalog=new Map(apps.map(a=>[a.id,a]));let snapshot=null,pending=null,closed=false,syncError=false;
  const policy=id=>{if(!catalog.has(id))fail(404,'应用不存在');const row=db.prepare('SELECT * FROM app_access WHERE app_id=?').get(id);return row?{appId:id,revision:row.revision,...JSON.parse(row.policy),updatedAt:row.updated_at}:{appId:id,revision:0,mode:id==='relay'?'restricted':'inherit',subjects:[],departmentIds:[],updatedAt:null};};
  async function refresh({fresh=false}={}){
    if(closed)fail(503,'应用权限暂时不可用');
    if(!fresh&&snapshot&&now()-snapshot.syncedAt<60000&&!syncError)return snapshot;
    if(pending)return pending;
    pending=Promise.resolve().then(()=>fetchSnapshot({fresh})).then(v=>{
      if(!v||!Array.isArray(v.members)||!Array.isArray(v.departments)||!Number.isFinite(v.syncedAt)||v.syncedAt>now()+1000||now()-v.syncedAt>60000)throw new Error('Invalid snapshot');
      if(closed)throw new Error('Closed');snapshot=structuredClone(v);syncError=false;return snapshot;
    }).catch(()=>{syncError=true;fail(503,'飞书成员与部门暂时无法同步，请稍后重试','APP_DIRECTORY_UNAVAILABLE');}).finally(()=>{pending=null;});return pending;
  }
  function assertCached(actor,id){
    const p=policy(id);if(p.mode==='inherit')return;
    const current=profile(actor?.subject);if(current.role==='super_admin')return;
    if(!snapshot||syncError||now()-snapshot.syncedAt>=60000)fail(503,'飞书成员与部门暂时无法同步，请稍后重试','APP_DIRECTORY_UNAVAILABLE');
    if(!snapshot.members.some(m=>m.subject===current.subject))fail(403,'当前成员不在可访问范围内');
    if(p.mode==='everyone'||p.subjects.includes(current.subject)||snapshot.departments.some(g=>p.departmentIds.includes(g.id)&&g.subjects.includes(current.subject)))return;
    fail(403,'你暂时没有此应用的访问权限，请联系实验室管理员');
  }
  async function authorize(actor,id){const p=policy(id);if(p.mode==='inherit')return;if(profile(actor?.subject).role!=='super_admin')await refresh();assertCached(actor,id);}
  function superAdmin(actor){const a=profile(actor?.subject);if(a.role!=='super_admin')fail(403,'仅超级管理员可配置应用权限');return a;}
  function update(actor,id,input){
    const a=superAdmin(actor);const v=z.object({revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),policy:fields}).strict().parse(input);policy(id);
    const canonical={mode:v.policy.mode,subjects:[...new Set(v.policy.subjects)].sort(),departmentIds:[...new Set(v.policy.departmentIds)].sort()};
    if(canonical.mode!=='restricted'&&(canonical.subjects.length||canonical.departmentIds.length))fail(400,'此访问方式不能设置名单');
    if(canonical.mode!=='inherit'){
      if(!snapshot||syncError||now()-snapshot.syncedAt>=60000)fail(503,'请先同步飞书通讯录');
      // Existing orphaned targets may be retained or removed, but never invented.
      const old=policy(id);for(const s of canonical.subjects)if(!snapshot.members.some(m=>m.subject===s)&&!old.subjects.includes(s))fail(400,'请选择飞书通讯录中的成员');
      for(const g of canonical.departmentIds)if(!snapshot.departments.some(d=>d.id===g)&&!old.departmentIds.includes(g))fail(400,'请选择飞书组织架构中的部门');
    }
    const encoded=JSON.stringify(canonical);db.exec('BEGIN IMMEDIATE');
    try{if(policy(id).revision!==v.revision)fail(409,'权限已被其他页面更新，请刷新后重试','APP_ACCESS_REVISION_CONFLICT');
      db.prepare('INSERT INTO app_access VALUES(?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,updated_at=excluded.updated_at,actor=excluded.actor').run(id,v.revision+1,encoded,now(),a.subject);
      db.prepare('INSERT INTO app_access_audit(app_id,revision,at,actor,policy) VALUES(?,?,?,?,?)').run(id,v.revision+1,now(),a.subject,encoded);db.exec('COMMIT');return policy(id);
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  const timer=setInterval(()=>{if(db.prepare("SELECT 1 FROM app_access WHERE json_extract(policy,'$.mode')!='inherit' LIMIT 1").get())void refresh({fresh:true}).catch(()=>{});},interval);timer.unref();
  return {policy,authorize,assertCached,refresh,update,
    async relayOperator(employeeId){
      const p=policy('relay');
      if(p.mode==='inherit')return {allowed:false,revision:p.revision};
      const directory=await refresh();
      const current=directory.members.find(m=>m.employeeId===employeeId);
      // No global administrator bypass: this endpoint represents who may reply.
      return {allowed:!!current&&(p.mode==='everyone'||p.subjects.includes(current.subject)||directory.departments.some(d=>p.departmentIds.includes(d.id)&&d.subjects.includes(current.subject))),revision:p.revision};
    },
    async manage(actor,{fresh=false}={}){superAdmin(actor);let directory=null;try{directory=await refresh({fresh});}catch{}superAdmin(actor);return {apps:apps.map(a=>({id:a.id,title:a.title,policy:policy(a.id)})),directory:directory||{members:[],departments:[],syncedAt:snapshot?.syncedAt||null},directoryAvailable:!!directory,audit:db.prepare('SELECT app_id AS appId,revision,at,actor,policy FROM app_access_audit ORDER BY id DESC LIMIT 100').all().map(r=>({...r,policy:JSON.parse(r.policy)}))};},
    async entries(actor){const result={};for(const a of apps){try{if(!actor&&policy(a.id).mode!=='inherit')result[a.id]={allowed:false,reason:'请先通过飞书登录',status:401};else{await authorize(actor,a.id);result[a.id]={allowed:true};}}catch(e){result[a.id]={allowed:false,reason:e.message,status:e.status||503};}}return {apps:result,syncedAt:snapshot?.syncedAt||null};},
    async close(){if(closed)return;closed=true;clearInterval(timer);try{await pending;}catch{}db.close();}
  };
}
