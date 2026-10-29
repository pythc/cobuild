// Test-only upstream fixture. Native auth, SQLite, HTTP and built UI remain real.
import {appendFileSync} from 'node:fs';
import {fixtureFetch} from './public-code.mjs';
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(new URL(url).origin==='https://api.github.com'){
    appendFileSync(process.env.COBUILD_CODE_REQUEST_LOG,JSON.stringify({method:options.method,path:new URL(url).pathname+new URL(url).search})+'\n');
    return fixtureFetch(url);
  }
  return nativeFetch(url,options);
};
await import('../../tools/serve-platform.mjs');
