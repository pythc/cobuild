import {saveMailAttachmentFile} from './mail-attachment-download.js';
const LIMIT=10_000_000,COUNT=10;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const size=n=>n<1000?n+' B':n<1_000_000?(n/1000).toFixed(1)+' KB':(n/1_000_000).toFixed(1)+' MB';

export function createMailAttachmentPicker({session,root,onChange=()=>{},onError=()=>{}}){
  let items=[],disposed=false,disabled=false,running=false;
  const header=el('div',undefined,'rw-attachment-heading'),input=el('input'),add=el('button','添加附件','rt-button'),list=el('div',undefined,'rw-attachment-list');
  input.type='file';input.multiple=true;input.hidden=true;input.setAttribute('aria-label','选择邮件附件');
  add.type='button';add.onclick=()=>input.click();header.append(el('span','附件'),add,el('small','最多 10 个，附件与正文图片合计 10 MB'));root.replaceChildren(header,input,list);
  function render(){
    add.disabled=disabled||items.length>=COUNT;
    list.replaceChildren(...items.map(item=>{
      const row=el('div',undefined,'rw-attachment-row'),copy=el('div',undefined,'rw-attachment-copy');copy.append(el('strong',item.file.name),el('small',size(item.file.size)+' · '+({queued:'等待上传',uploading:item.progress===100?'正在确认':'上传中 '+item.progress+'%',ready:'已上传',failed:item.error}[item.state])));
      row.append(copy);
      if(['queued','uploading'].includes(item.state)){const progress=el('progress');progress.max=100;progress.value=item.progress;progress.setAttribute('aria-label',item.file.name+' 上传进度');row.append(progress);}
      if(item.state==='failed'){const retry=el('button','重试','rt-button');retry.type='button';retry.disabled=disabled;retry.onclick=()=>{item.state='queued';item.progress=0;item.error='';onChange();render();void pump();};row.append(retry);}
      const remove=el('button','移除','rt-button');remove.type='button';remove.disabled=disabled;remove.setAttribute('aria-label','移除附件 '+item.file.name);remove.onclick=()=>{item.controller?.abort();items=items.filter(v=>v!==item);onChange();render();};row.append(remove);return row;
    }));
  }
  async function pump(){
    if(running||disposed)return;running=true;
    try{
      for(;;){
        const item=items.find(i=>i.state==='queued');if(!item||disposed)break;
        item.state='uploading';item.controller=new AbortController();render();
        const form=new FormData();form.set('requestId',item.requestId);form.append('attachment',item.file,item.file.name);
        try{
          const value=await session.uploadWithProgress('direct-mail/attachments',form,{signal:item.controller.signal,onProgress:n=>{if(disposed||!items.includes(item))return;item.progress=n;render();}});
          if(disposed||!items.includes(item))continue;
          if(!/^[a-f0-9-]{36}$/.test(value.id||'')||value.bytes!==item.file.size)throw Error('附件上传结果无效，请重试');
          item.metadata=value;item.state='ready';item.progress=100;onChange();
        }catch(error){if(!disposed&&items.includes(item)){item.state='failed';item.error=error.message;onChange();}}
        finally{item.controller=null;if(!disposed)render();}
      }
    }finally{running=false;}
  }
  input.onchange=()=>{
    const files=[...input.files];input.value='';
    if(disabled||disposed)return;
    for(const file of files){
      if(!file.size||file.size>LIMIT){onError('附件须大于 0 且不超过 10 MB');continue;}
      if(items.length>=COUNT){onError('最多添加 10 个附件');break;}
      if(items.reduce((n,i)=>n+i.file.size,0)+file.size>LIMIT){onError('附件总计不能超过 10 MB');continue;}
      items.push({file,state:'queued',progress:0,requestId:crypto.randomUUID(),controller:null});
    }
    onChange();render();void pump();
  };
  render();
  return {
    value(){if(items.some(i=>i.state!=='ready'))throw Error('请等待附件上传完成，或移除上传失败的附件');return items.map(i=>i.metadata.id);},
    get pending(){return items.some(i=>['queued','uploading'].includes(i.state));},
    setDisabled(value){disabled=value;input.disabled=value;render();},
    clear(){for(const item of items)item.controller?.abort();items=[];render();},
    restore(files){for(const item of items)item.controller?.abort();items=files.map(metadata=>({file:{name:metadata.filename,size:metadata.bytes},metadata,state:'ready',progress:100,requestId:crypto.randomUUID(),controller:null}));render();},
    destroy(){disposed=true;for(const item of items)item.controller?.abort();items=[];root.replaceChildren();}
  };
}

export function mailAttachmentSummary(session,files=[],onError=()=>{}){
  const box=el('section',undefined,'rw-attachment-summary');
  if(!files.length)return box;
  box.append(el('h4','附件 · '+files.length+' 个'));
  for(const file of files){const row=el('div',undefined,'rw-attachment-row'),label=el('span',file.filename+' · '+size(file.bytes)),download=el('button','下载','rt-button');download.type='button';download.onclick=async()=>{download.disabled=true;try{const blob=await session.download('direct-mail/attachments/'+file.id);await saveMailAttachmentFile(blob,file.filename,{embedded:session.embedded,current:()=>box.isConnected});}catch(e){onError(e);}finally{download.disabled=false;}};row.append(label,download);box.append(row);}
  return box;
}
