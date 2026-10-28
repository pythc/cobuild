// Streamed into a pinned core image by the host; never sends material outside it.
import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {createSecureContext,createServer,connect} from 'node:tls';
const config=JSON.parse(readFileSync('/state/config.json'));
const descriptor=JSON.parse(process.argv[2]);
const root='/state/ingress/'+descriptor.generation;
const cert=readFileSync(root+'/cert.pem'),key=readFileSync(root+'/key.pem');
let server;
const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();
try {
  const names=[...new Set(['platform','makit','weknow'].filter(k=>config.modules.includes(k)).map(k=>{
    const url=new URL(config.origins[k]);
    if(url.protocol!=='https:')throw Error('HTTPS_REQUIRED');
    return url.hostname.replace(/^\[|\]$/g,'');
  }))];
  const leaf=new X509Certificate(cert);
  if(Date.parse(leaf.validFrom)>Date.now()||Date.parse(leaf.validTo)<=Date.now())throw Error('CERTIFICATE_TIME');
  for(const name of names)if(!(isIP(name)?leaf.checkIP(name):leaf.checkHost(name,{subject:'never'})))throw Error('CERTIFICATE_HOST');
  createSecureContext({cert,key,minVersion:'TLSv1.2'});
  const ca=descriptor.sha256['ca.pem']?readFileSync(root+'/ca.pem'):undefined;
  server=createServer({cert,key,minVersion:'TLSv1.2'},socket=>socket.end());
  server.on('tlsClientError',()=>{});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  for(const hostname of names)await new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:server.address().port,servername:isIP(hostname)?undefined:hostname,
      ca,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_,peer)=>{
        const remote=new X509Certificate(peer.raw);
        if(!(isIP(hostname)?remote.checkIP(hostname):remote.checkHost(hostname,{subject:'never'})))return Error('CERTIFICATE_HOST');
      }});
    socket.setTimeout(5000,()=>socket.destroy(Error('TLS_VALIDATION_TIMEOUT')));
    socket.once('error',reject);socket.once('secureConnect',()=>{socket.end();resolve();});
  });
  console.log(JSON.stringify({valid:true,hosts:names.length}));
} catch {
  // Parser diagnostics can echo private input. Only a fixed failure leaves here.
  console.error('TLS certificate validation failed (chain, hostname, validity or private key)');
  process.exitCode=1;
} finally {if(server?.listening)await new Promise(resolve=>server.close(resolve));clearTimeout(deadline);}
