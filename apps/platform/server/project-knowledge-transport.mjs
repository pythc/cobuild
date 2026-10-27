import {request as httpsRequest} from 'node:https';

const origin='https://knowledge.110-lab.cn';
const paths=new Set(['/api/knowledge/oauth/token',...['space_create','space_get','whoami'].map(name=>'/api/knowledge/v1/operations/kb_'+name)]);

/** Private SSH routing changes only the TCP peer; OAuth audience, Host and TLS stay canonical. */
export function createKnowledgeTransport({host=process.env.PORTAL_PROJECT_KNOWLEDGE_CONNECT_HOST,requester=httpsRequest,direct=fetch}={}){
  if(host&&!['127.0.0.1','172.29.0.1'].includes(host))throw new Error('Invalid private knowledge connection');
  return async function knowledgeFetch(address,options){
    const url=new URL(address);
    if(url.origin!==origin||url.username||url.password||url.search||url.hash||!paths.has(url.pathname)||options.method!=='POST')throw new Error('Invalid knowledge endpoint');
    if(!host)return direct(address,options);
    return new Promise((resolve,reject)=>{
      const req=requester(url,{hostname:host,port:19443,servername:'knowledge.110-lab.cn',rejectUnauthorized:true,
        method:'POST',signal:options.signal,headers:{...options.headers,host:'knowledge.110-lab.cn'}},res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{if((size+=chunk.length)>524288){res.destroy(new Error('Knowledge response too large'));return;}chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:{'content-type':'application/json'}})));
      });
      req.on('error',reject);req.end(options.body);
    });
  };
}
