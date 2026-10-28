import {createRequire} from 'node:module';
const req=createRequire(new URL('../integrations/weknow/source/apps/client/package.json',import.meta.url));
const serverReq=createRequire(new URL('../integrations/weknow/source/apps/server/package.json',import.meta.url));
const {HocuspocusProvider,HocuspocusProviderWebsocket}=req('@hocuspocus/provider');
const Y=req('yjs'),WebSocket=serverReq('ws');
async function until(predicate){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Managed collaboration did not settle');await new Promise(r=>setTimeout(r,40));}}
export async function managedCollaboration(origin,pageId,token){
 const socket=new HocuspocusProviderWebsocket({url:origin.replace(/^http/,'ws')+'/collab',WebSocketPolyfill:WebSocket,autoConnect:false});
 const document=new Y.Doc();let closed=false,authenticated=false;
 const provider=new HocuspocusProvider({websocketProvider:socket,name:'page.'+pageId,token,document,
  onAuthenticated:()=>{authenticated=true;},onClose:({event})=>{if([4401,4403].includes(event.code)||['Session expired','Permissions changed'].includes(event.reason))closed=true;}});
 const destroy=()=>{provider.destroy();socket.destroy();document.destroy();};
 try{provider.attach();void socket.connect();await until(()=>authenticated&&provider.synced);}catch(e){destroy();throw e;}
 return {async revoked(){try{document.getMap('managed-fixture').set('post-revoke','must be rejected');await until(()=>closed);}finally{destroy();}},destroy};
}
