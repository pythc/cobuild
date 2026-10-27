import Busboy from 'busboy';
import {createHash,randomUUID} from 'node:crypto';
import {extname} from 'node:path';
import {z} from 'zod';
import {RecruitmentTestError} from './recruitment-test-store.mjs';

export const MAIL_ATTACHMENT_LIMIT=10_000_000;
export const MAIL_ATTACHMENT_COUNT=10;
const filename=z.string().min(1).max(180).refine(n=>!/[\u0000-\u001f\u007f/\\]/.test(n),'附件名称无效');
const mimeFor=name=>({'.pdf':'application/pdf','.zip':'application/zip','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.txt':'text/plain','.md':'text/plain','.csv':'text/csv','.json':'application/json'})[extname(name).toLowerCase()]||'application/octet-stream';
const failure=(status,message)=>new RecruitmentTestError(status,message);

// Opaque files, never unpacked, rendered, executed or fetched from a URL.
export async function readMailAttachment(req,{timeoutMs=60000}={}){
  if(Number(req.headers['content-length']||0)>MAIL_ATTACHMENT_LIMIT+65536)throw failure(413,'附件不能超过 10 MB');
  let parser;
  try{parser=Busboy({headers:req.headers,defParamCharset:'utf8',preservePath:true,limits:{files:1,fields:1,parts:3,fileSize:MAIL_ATTACHMENT_LIMIT+1,fieldSize:128,headerPairs:100}});}catch{throw failure(415,'请通过附件上传组件提交文件');}
  const fields={},chunks=[];let info,received=0,files=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('aborted',abort);req.off('error',abort);if(error){req.unpipe(parser);parser.destroy();req.resume();chunks.length=0;reject(error);}else resolve();};
    const invalid=()=>finish(failure(400,'附件上传格式无效'));
    const data=chunk=>{if((received+=chunk.length)>MAIL_ATTACHMENT_LIMIT+65536)finish(failure(413,'附件不能超过 10 MB'));};
    const abort=()=>finish(failure(400,'附件上传中断，请重试'));
    const timer=setTimeout(()=>finish(failure(408,'附件上传超时，请重试')),timeoutMs);timer.unref();
    req.on('data',data);req.once('aborted',abort);req.once('error',abort);
    parser.on('field',(name,value,meta)=>{if(done)return;if(name!=='requestId'||Object.hasOwn(fields,name)||meta.valueTruncated||meta.nameTruncated)return invalid();fields[name]=value;});
    parser.on('file',(name,file,meta)=>{file.on('error',invalid);if(done||name!=='attachment'||++files!==1){file.resume();invalid();return;}info=meta;file.on('data',chunk=>{if(!done)chunks.push(chunk);});file.once('limit',()=>finish(failure(413,'附件不能超过 10 MB')));});
    for(const event of ['filesLimit','fieldsLimit','partsLimit','error'])parser.on(event,invalid);
    parser.once('close',()=>finish());req.pipe(parser);
  });
  const id=z.uuid().safeParse(fields.requestId),name=filename.safeParse(info?.filename),buffer=Buffer.concat(chunks);
  if(!id.success||!name.success||!buffer.length||buffer.length>MAIL_ATTACHMENT_LIMIT)throw failure(400,'请选择有效附件');
  return {requestId:id.data,filename:name.data,buffer};
}

export function createMailAttachments({db,now,mutate,requireOperator,fail,maxStoredBytes}){
  db.exec('CREATE TABLE IF NOT EXISTS mail_attachments(id TEXT PRIMARY KEY,actor TEXT NOT NULL,metadata TEXT NOT NULL,content BLOB NOT NULL,created_at INTEGER NOT NULL)');
  const read=id=>{const row=db.prepare('SELECT metadata,content FROM mail_attachments WHERE id=?').get(z.uuid().parse(id));if(!row)fail(404,'附件不存在');const metadata=JSON.parse(row.metadata),buffer=Buffer.from(row.content);if(buffer.length!==metadata.bytes||createHash('sha256').update(buffer).digest('hex')!==metadata.sha256)throw Object.assign(Error('Attachment integrity failed'),{code:'FILE_INTEGRITY'});return {...metadata,buffer};};
  return {
    saveMailAttachment(actor,raw){
      requireOperator(actor);const name=filename.parse(raw.filename);
      if(!Buffer.isBuffer(raw.buffer)||!raw.buffer.length||raw.buffer.length>MAIL_ATTACHMENT_LIMIT)fail(413,'附件不能超过 10 MB');
      const metadata={id:randomUUID(),filename:name,bytes:raw.buffer.length,mime:mimeFor(name),sha256:createHash('sha256').update(raw.buffer).digest('hex')};
      return mutate(actor,{requestId:z.uuid().parse(raw.requestId),filename:name,bytes:metadata.bytes,sha256:metadata.sha256},'mail-attachment',()=>{
        const used=['resumes','resume_history','mail_images','mail_attachments'].reduce((sum,table)=>sum+Number(db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM '+table).get().n),0);
        if(used+metadata.bytes>maxStoredBytes)fail(503,'附件存储空间不足，请联系管理员');
        db.prepare('INSERT INTO mail_attachments VALUES(?,?,?,?,?)').run(metadata.id,actor.subject,JSON.stringify(metadata),raw.buffer,now());return metadata;
      });
    },
    readMailAttachment(actor,id){requireOperator(actor);return read(id);},
    mailAttachments(payload){
      return (payload.attachments||[]).map(snapshot=>{let file;try{file=read(snapshot.id);}catch(error){throw Object.assign(Error('Attachment unavailable'),{code:'FILE_INTEGRITY'});}if(['sha256','bytes','filename','mime'].some(key=>snapshot[key]!==file[key]))throw Object.assign(Error('Attachment snapshot changed'),{code:'FILE_INTEGRITY'});return file;});
    }
  };
}
