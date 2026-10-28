// Explicit test process only: preserve TLS verification, resolve allowed hosts to loopback.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(process.env.COBUILD_CONFIG));
const hosts=new Set(['platform','makit','weknow'].map(k=>new URL(config.origins[k]).hostname));
const origins=new Set(Object.values(config.origins));
if([...origins].some(o=>!o.startsWith('https:'))||[...hosts].some(h=>!h.endsWith('.cobuild.test')))throw Error('Not an isolated HTTPS test configuration');
const require=createRequire(new URL('../integrations/weknow/source/apps/server/package.json',import.meta.url));
const {Agent,setGlobalDispatcher}=require('undici');
const dispatcher=new Agent({connect:{ca:readFileSync(process.env.COBUILD_TEST_CA),rejectUnauthorized:true,
  lookup(hostname,options,callback){
    if(!hosts.has(hostname))return callback(Error('External test DNS denied'));
    callback(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);
  }}});
setGlobalDispatcher(dispatcher);
const fetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!origins.has(url.origin))throw Error('External test request denied');
  return fetch(input,init);
};
