// Shared in-page viewer. Private bytes are loaded through each workspace's
// existing authenticated route, never a public or third-party document URL.
const moduleUrl='/assets/recruitment-pdf-preview-v1.mjs?v=resume-preview-5';
const renderers=()=>import(moduleUrl);

// Candidate status polling must not reset the document, page or zoom. Only a
// different candidate/assignment/attachment (or explicit teardown) invalidates it.
export function createResumePreviewController(open=openResumePreview){
  let key=null,viewer=null,generation=0;
  const identity=c=>c?.resume?JSON.stringify([c.id,c.assignment?.id,c.resume.sha256,c.resume.uploadedAt,c.resume.filename]):null;
  const destroy=()=>{generation++;viewer?.destroy();viewer=null;key=null;};
  return {
    show(candidate,{load,current=()=>true}){
      destroy();key=identity(candidate);const gen=generation;
      viewer=open({filename:candidate.resume.filename,load,current:()=>gen===generation&&current()});
    },
    sync(candidate){if(key!==identity(candidate))destroy();},
    destroy
  };
}
async function renderDocument(body,{filename,load,current,loadRenderers}){
  const [blob,renderer]=await Promise.all([load(),loadRenderers()]);
  if(!current())return {stale:true};
  const extension=String(filename).split('.').at(-1).toLowerCase();
  if(!blob.size||blob.size>10*1024*1024)throw new Error('Invalid size');
  const render=extension==='pdf'&&blob.type==='application/pdf'?renderer.previewPdf:extension==='docx'&&blob.type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?renderer.previewDocx:null;
  if(!render)throw new Error('Unsupported format');
  const cleanup=await render(blob,body,current);
  return {cleanup};
}
function statusLine(document,text){
  const p=document.createElement('p');p.className='rw-resume-status';p.textContent=text;return p;
}
export function mountInlineResume({filename,load,current=()=>true,host,download,retry},env=globalThis,loadRenderers=renderers){
  const document=env.document;
  host.setAttribute('aria-live','polite');host.setAttribute('aria-busy','true');
  host.replaceChildren(statusLine(document,'正在加载简历'));
  let active=true,cleanup;const valid=()=>active&&current();
  const destroy=()=>{if(!active)return;active=false;cleanup?.();host.replaceChildren();host.removeAttribute('aria-busy');};
  const fail=()=>{
    const nodes=[statusLine(document,'简历暂时无法预览，请重试；若仍失败，可下载原文件。')];
    if(retry){const again=document.createElement('button');again.type='button';again.className='rt-button';again.textContent='重试预览';again.onclick=()=>retry();nodes.push(again);}
    if(download){const save=document.createElement('button');save.type='button';save.className='rt-button';save.textContent='下载简历';save.onclick=()=>download();nodes.push(save);}
    host.removeAttribute('aria-busy');host.replaceChildren(...nodes);
  };
  const ready=(async()=>{
    try{
      const rendered=await renderDocument(host,{filename,load,current:valid,loadRenderers});
      if(!valid()){if(rendered.cleanup)rendered.cleanup();if(active)destroy();return;}
      if(rendered.stale){destroy();return;}
      cleanup=rendered.cleanup;host.removeAttribute('aria-busy');
      if(!valid()){if(active)destroy();else cleanup?.();}
    }catch{if(valid())fail();else destroy();}
  })();
  return {destroy,ready};
}
export function createInlineResumeController(mount=mountInlineResume){
  let key=null,viewer=null,generation=0;
  const identity=c=>c?.resume?JSON.stringify([c.id,c.assignment?.id,c.resume.sha256,c.resume.uploadedAt,c.resume.filename]):null;
  const destroy=()=>{generation++;viewer?.destroy();viewer=null;key=null;};
  const api={
    show(candidate,options){
      const next=identity(candidate);
      if(!options.force&&viewer&&next&&next===key)return viewer;
      destroy();const gen=generation;
      if(!next){options.host.replaceChildren(statusLine(options.host.ownerDocument||document,'还没有简历'));return null;}
      key=next;
      viewer=mount({filename:candidate.resume.filename,load:options.load,download:options.download,host:options.host,retry:()=>api.show(candidate,{...options,force:true}),current:()=>gen===generation&&(options.current?.()??true)});
      return viewer;
    },
    sync(candidate){if(key!==identity(candidate))destroy();},
    destroy
  };
  return api;
}
export function openResumePreview({filename,load,current=()=>true},env=globalThis,loadRenderers=renderers){
  const document=env.document,dialog=document.createElement('dialog');dialog.className='rw-resume-dialog';
  const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button'),body=document.createElement('div');
  title.textContent=filename;title.id='resume-preview-'+env.crypto.randomUUID();dialog.setAttribute('aria-labelledby',title.id);
  close.type='button';close.className='rt-button';close.textContent='关闭预览';header.append(title,close);
  body.className='rw-resume-viewer';body.setAttribute('aria-live','polite');body.textContent='正在加载简历';dialog.append(header,body);
  let active=true,cleanup;const valid=()=>active&&current();
  const destroy=()=>{if(!active)return;active=false;cleanup?.();dialog.close();dialog.remove();};
  close.onclick=destroy;dialog.addEventListener('cancel',e=>{e.preventDefault();destroy();});
  document.body.append(dialog);dialog.showModal();close.focus();
  const ready=(async()=>{
    try{
      const rendered=await renderDocument(body,{filename,load,current:valid,loadRenderers});
      if(!valid()){rendered.cleanup?.();if(active)destroy();return;}
      if(rendered.stale){destroy();return;}
      cleanup=rendered.cleanup;
      if(!valid()){if(active)destroy();else cleanup?.();}
    }catch{if(valid())body.textContent='简历暂时无法预览，请重试；若仍失败，可独立打开网页版下载原文件。';else destroy();}
  })();
  return {destroy,ready};
}
