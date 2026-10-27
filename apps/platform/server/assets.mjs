import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';

// Explicit filenames keep request paths away from the filesystem namespace.
const generated=new Set(['recruitment-pdf-preview-v1.mjs','recruitment-pdf-worker-6.4.299.mjs','recruitment-pdf-LICENSE.txt']);
const types={
  'cobuild/pulse.svg':'image/svg+xml',
  'cobuild/relay.svg':'image/svg+xml',
  'icons/activity.svg':'image/svg+xml',
  'icons/server.svg':'image/svg+xml',
  'icons/chart-line.svg':'image/svg+xml',
  'icons/bell.svg':'image/svg+xml',
  'icons/maximize.svg':'image/svg+xml',
  'icons/arrow-left.svg':'image/svg+xml',
  'icons/LICENSE.txt':'text/plain; charset=utf-8',
  'icons/apps.svg':'image/svg+xml',
  'icons/arrow-right.svg':'image/svg+xml',
  'icons/arrow-up-right.svg':'image/svg+xml',
  'icons/book.svg':'image/svg+xml',
  'icons/calendar.svg':'image/svg+xml',
  'icons/download.svg':'image/svg+xml',
  'icons/chevron-down.svg':'image/svg+xml',
  'icons/circle-check.svg':'image/svg+xml',
  'icons/file-check.svg':'image/svg+xml',
  'icons/folder.svg':'image/svg+xml',
  'icons/identity-home.svg':'image/svg+xml',
  'icons/home.svg':'image/svg+xml',
  'icons/layout-sidebar-left-collapse.svg':'image/svg+xml',
  'icons/layout-sidebar-left-expand.svg':'image/svg+xml',
  'icons/list-details.svg':'image/svg+xml',
  'icons/logout.svg':'image/svg+xml',
  'icons/mail.svg':'image/svg+xml',
  'icons/refresh.svg':'image/svg+xml',
  'icons/search.svg':'image/svg+xml',
  'icons/send.svg':'image/svg+xml',
  'icons/settings.svg':'image/svg+xml',
  'icons/star-filled.svg':'image/svg+xml',
  'icons/star.svg':'image/svg+xml',
  'icons/trophy.svg':'image/svg+xml',
  'icons/user.svg':'image/svg+xml',
  'icons/x.svg':'image/svg+xml',
  'cobuild/cobuild-wordmark-white.svg':'image/svg+xml',
  'cobuild/cobuild-lockup.svg':'image/svg+xml',
  'cobuild/cobuild-wordmark.svg':'image/svg+xml',
  'cobuild/feishu-logo.svg':'image/svg+xml',
  'cobuild/cobuild-initial.svg':'image/svg+xml',
  'cobuild/cobuild-tail.svg':'image/svg+xml',
  'cobuild/evalab.png':'image/png',
  'cobuild/hiflow.png':'image/png',
  'cobuild/kick.png':'image/png',
  'cobuild/requirements-logo.svg':'image/svg+xml',
  'cobuild/weknow.png':'image/png',
  'recruitment-pdf-preview-v1.mjs':'text/javascript; charset=utf-8',
  'recruitment-pdf-worker-6.4.299.mjs':'text/javascript; charset=utf-8',
  'recruitment-pdf-LICENSE.txt':'text/plain; charset=utf-8',
  '110lab-icon.png':'image/png',
  'glass-loop-v2.png':'image/png',
  'zhiping-logo.png':'image/png',
  'grunteon-logo.svg':'image/svg+xml',
  'grunteon-poster-v2.jpg':'image/jpeg',
  'grunteon-intro-v2.mp4':'video/mp4',
  'recruitment-qq-2026.png':'image/png',
  'zhiping-poster.jpg':'image/jpeg',
  'zhiping-promo.mp4':'video/mp4',
  'zhiping-promo-1080p30.mp4':'video/mp4',
  'zhiping-public-release.json':'application/json; charset=utf-8',
  'zhiping-public-0.2.2.apk':'application/vnd.android.package-archive'
};

function byteRange(value,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||(!match[1]&&!match[2])||size===0)return null;
  if(!match[1]){
    const suffix=Number(match[2]);
    if(!Number.isSafeInteger(suffix)||suffix<=0)return null;
    return {start:Math.max(0,size-suffix),end:size-1};
  }
  const start=Number(match[1]),end=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return null;
  return {start,end:Math.min(end,size-1)};
}

export async function serveAsset(req,res,name){
  if(!Object.hasOwn(types,name))return false;
  const type=types[name];
  const path=new URL((generated.has(name)?'../dist/assets/':'../src/assets/')+name,import.meta.url);
  const info=await stat(path);
  const etag='"'+info.size.toString(16)+'-'+Math.trunc(info.mtimeMs).toString(16)+'"';
  const headers={'Content-Type':type,'Cache-Control':'public, max-age=3600','Content-Length':info.size,ETag:etag,'Last-Modified':info.mtime.toUTCString(),'Accept-Ranges':'bytes'};
  if(name==='zhiping-public-0.2.2.apk')headers['Content-Disposition']="attachment; filename=\"zhiping-android-public-0.2.2.apk\"; filename*=UTF-8''"+encodeURIComponent('智评学堂-安卓版-0.2.2.apk');
  if(name==='zhiping-public-release.json')headers['Cache-Control']='public, max-age=60';
  const noneMatch=req.headers['if-none-match'];
  const since=Date.parse(req.headers['if-modified-since']||'');
  const unmodified=noneMatch!==undefined
    ? String(noneMatch).split(',').map(x=>x.trim().replace(/^W\//,'')).some(x=>x==='*'||x===etag)
    : Number.isFinite(since)&&Math.floor(info.mtimeMs/1000)*1000<=since;
  if(unmodified){const {'Content-Length':length,...cachedHeaders}=headers;res.writeHead(304,cachedHeaders);res.end();return true;}
  const conditional=req.headers['if-range'];
  const conditionalDate=Date.parse(conditional||'');
  const rangeAllowed=!conditional||conditional===etag||(!conditional.startsWith('W/')&&Number.isFinite(conditionalDate)&&info.mtimeMs<conditionalDate+1000);
  let range;
  if(req.method==='GET'&&req.headers.range&&rangeAllowed){
    range=byteRange(req.headers.range,info.size);
    if(!range){res.writeHead(416,{...headers,'Content-Length':0,'Content-Range':'bytes */'+info.size});res.end();return true;}
    headers['Content-Range']=`bytes ${range.start}-${range.end}/${info.size}`;
    headers['Content-Length']=range.end-range.start+1;
  }
  res.writeHead(range?206:200,headers);
  if(req.method==='HEAD'){res.end();return true;}
  await pipeline(createReadStream(path,range||{}),res);
  return true;
}
