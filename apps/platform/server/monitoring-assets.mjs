import {open} from 'node:fs/promises';
import {resolve,extname,isAbsolute} from 'node:path';
import {pipeline} from 'node:stream/promises';

const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon'};
export function grafanaAssetCache(path){
  if(!path.startsWith('public/'))return 'no-store';
  return /\.[a-f0-9]{8,64}\.(?:js|css|svg|woff2?)$/.test(path)?'private, max-age=31536000, immutable':'private, max-age=3600';
}
// Caller must authenticate before entering here. This immutable directory only
// contains public files copied from the matching Grafana image, never API data.
export async function serveMonitoringAsset(req,res,path,directory){
  if(!directory||!isAbsolute(directory)||!path.startsWith('public/')||!['GET','HEAD'].includes(req.method))return false;
  const relative=path.slice(7),type=types[extname(relative)];
  if(!type||!relative||relative.split('/').some(p=>!p||p==='.'||p==='..')||!/^[a-zA-Z0-9_./-]+$/.test(relative))return false;
  const root=resolve(directory),file=resolve(root,relative);if(!file.startsWith(root+'/'))return false;
  let handle;
  try{handle=await open(file,'r');}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return false;throw e;}
  try{
    const stat=await handle.stat();if(!stat.isFile())return false;
    res.writeHead(200,{'Content-Type':type,'Content-Length':stat.size,'Cache-Control':grafanaAssetCache(path),'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','X-Pulse-Asset':'local'});
    if(req.method==='HEAD')res.end();else await pipeline(handle.createReadStream({autoClose:false}),res);
    return true;
  }finally{await handle.close();}
}
