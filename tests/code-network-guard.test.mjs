import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('preview egress is loopback by default; opt-in permits only GitHub API port 443',()=>{
 const tmp=mkdtempSync(join(tmpdir(),'cobuild-code-guard-')),file=join(tmp,'config.json');
 const config=JSON.parse(readFileSync('config/cobuild.local.example.json'));
 try{for(const mode of ['off','on','legacy-enabled','malformed']){
  config.codeSources.githubPublic=mode!=='off';config.integrations.github=mode==='legacy-enabled';
  writeFileSync(file,mode==='malformed'?'not json':JSON.stringify(config));
  const script=`const net=require('node:net');net.Socket.prototype.connect=function(){return 'allowed'};require(${JSON.stringify(resolve('tools/local-network-guard.cjs'))});
   const out=[];for(const arg of [{host:'127.0.0.1',port:8080},{host:'api.github.com',port:443},{host:'api.github.com',port:80},{host:'github.com',port:443},{host:'api.github.com.evil.test',port:443},{host:'internal.example.test',port:443},{path:'/tmp/not-allowed'}]){
    try{out.push(new net.Socket().connect(arg));}catch{out.push('blocked');}}
   process.stdout.write(JSON.stringify(out));`;
  const run=spawnSync(process.execPath,['-e',script],{env:{PATH:process.env.PATH,COBUILD_CONFIG:file},encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),['allowed',mode==='on'?'allowed':'blocked','blocked','blocked','blocked','blocked','blocked']);
 }}finally{rmSync(tmp,{recursive:true,force:true});}
});
