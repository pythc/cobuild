const requestType='110lab-mail-attachment-download',resultType=requestType+'-result',limit=10_000_000;
function info(filename,mimeType,size){
  if(typeof filename!=='string'||!filename||filename.length>180||/[\u0000-\u001f\u007f/\\]/.test(filename)||typeof mimeType!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(mimeType)||!Number.isInteger(size)||size<1||size>limit)throw Error('附件名称或大小无效');
  const name=filename.normalize('NFC').replace(/[<>:"|?*]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,170);return {filename:name||'附件',mimeType};
}
export async function saveMailAttachmentFile(blob,filename,{embedded=false,current=()=>true,onStatus=()=>{}}={},env=globalThis){
  const file=info(filename,blob.type||'application/octet-stream',blob.size),active=()=>{if(!current())throw Error('页面或登录状态已改变，请重新下载');};active();
  if(!embedded||env.window.parent===env.window){const url=env.URL.createObjectURL(blob),link=env.document.createElement('a');try{link.href=url;link.download=file.filename;env.document.body.append(link);link.click();}finally{link.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),10000);}return;}
  const bytes=await blob.arrayBuffer();active();const requestId=env.crypto.randomUUID(),parent=env.window.parent;
  await new Promise((resolve,reject)=>{
    let timer,done=false;
    const finish=error=>{if(done)return;done=true;env.clearTimeout(timer);env.window.removeEventListener('message',receive);error?reject(error):resolve();};
    const receive=event=>{const m=event.data;if(event.source!==parent||m?.type!==resultType||m.requestId!==requestId)return;try{active();}catch(error){finish(error);return;}if(m.status==='started'){env.clearTimeout(timer);timer=env.setTimeout(()=>finish(Error('客户端未返回下载结果，请检查保存窗口')),150000);onStatus('正在交由客户端保存附件');}else if(m.status==='complete')finish();else finish(Error(m.status==='cancelled'?'下载已取消':m.status==='busy'?'已有文件正在下载，请稍后重试':'当前客户端无法保存附件，请独立打开网页版下载'));};
    env.window.addEventListener('message',receive);timer=env.setTimeout(()=>finish(Error('当前客户端不支持附件下载，请独立打开网页版下载')),5000);
    try{parent.postMessage({type:requestType,requestId,...file,bytes},'*',[bytes]);}catch{finish(Error('无法连接客户端下载，请独立打开网页版下载'));}
  });
}
export async function handleMailAttachmentDownloadRequest(event,{frame,downloadFile}){
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow)return false;
  const m=event.data;if(m?.type!==requestType||!/^[a-f0-9-]{36}$/.test(m.requestId||''))return false;
  const reply=status=>event.source.postMessage({type:resultType,requestId:m.requestId,status},event.origin);
  try{if(!(m.bytes instanceof ArrayBuffer))throw Error();const file=info(m.filename,m.mimeType,m.bytes.byteLength);if(typeof downloadFile!=='function'){reply('unsupported');return true;}const bytes=new Uint8Array(m.bytes);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));reply('started');const result=await downloadFile({contents:[{type:'resource',resource:{uri:'file:///'+encodeURIComponent(file.filename),mimeType:file.mimeType,blob:btoa(binary)}}]});reply(!result||typeof result!=='object'?'failed':result.isError?'cancelled':'complete');}catch{reply('failed');}return true;
}
