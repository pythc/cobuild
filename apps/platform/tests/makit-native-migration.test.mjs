import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requirementsBase,REQUIREMENTS_BASE,LEGACY_REQUIREMENTS_BASE,NATIVE_REQUIREMENTS_BASE} from '../server/requirements-endpoint.mjs';
import {createIdentityRegistry} from '../server/identity-applications.mjs';
import {loadCredentials,ENDPOINT,createRelay} from '../server/requirements-client.mjs';
import {createProjectSyncClient} from '../server/project-sync-client.mjs';

test('native callback is exact while desktop PKCE remains compatible',()=>{
 assert.equal(REQUIREMENTS_BASE,NATIVE_REQUIREMENTS_BASE);const registry=createIdentityRegistry();
 assert.equal(registry.services.requirements.url,NATIVE_REQUIREMENTS_BASE);
 assert.equal(registry.allows('requirements',NATIVE_REQUIREMENTS_BASE+'/callback/110lab_requirements'),true);
 assert.equal(registry.allows('requirements','http://127.0.0.1:38923/callback/110lab_requirements'),true);
 for(const value of [NATIVE_REQUIREMENTS_BASE+'.evil.test/callback/110lab_requirements',NATIVE_REQUIREMENTS_BASE+'/callback/other',NATIVE_REQUIREMENTS_BASE+'/callback/110lab_requirements?token=x','https://evil.test/callback/110lab_requirements'])
  assert.equal(registry.allows('requirements',value),false);
});
test('endpoint configuration rejects redirects, userinfo and production loopback',()=>{
 const environment={...process.env};try{
  for(const value of ['https://evil.test',NATIVE_REQUIREMENTS_BASE+'/','https://user@makit.110-lab.cn',NATIVE_REQUIREMENTS_BASE+'?x=1'])assert.throws(()=>requirementsBase(value));
  process.env.PORTAL_REQUIREMENTS_ALLOW_LOOPBACK='true';process.env.NODE_ENV='production';assert.throws(()=>requirementsBase('http://127.0.0.1:5450'));
  process.env.NODE_ENV='test';assert.equal(requirementsBase('http://127.0.0.1:5450'),'http://127.0.0.1:5450');
 }finally{process.env=environment;}
});
test('existing stored credentials retain their tokens but route to the configured native endpoint',()=>{
 const directory=mkdtempSync(join(tmpdir(),'makit-migration-')),file=join(directory,'credentials.json');
 const credential={version:1,endpoint:LEGACY_REQUIREMENTS_BASE+'/openapi/mcp',openApiKey:'existing-transport',personalToken:'rmcp_v1.existing'};
 try{writeFileSync(file,JSON.stringify(credential),{mode:0o600});const actual=loadCredentials(file);
  assert.equal(actual.endpoint,NATIVE_REQUIREMENTS_BASE+'/openapi/mcp');assert.equal(actual.personalToken,credential.personalToken);assert.equal(actual.openApiKey,credential.openApiKey);
  writeFileSync(file,JSON.stringify({...credential,endpoint:'https://evil.test/openapi/mcp'}));assert.throws(()=>loadCredentials(file));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('the actual native MCP adapter preserves transport and personal authentication without redirects',async()=>{
 const calls=[];const client=createRelay({readCredentials:()=>({endpoint:ENDPOINT,openApiKey:'transport',personalToken:'rmcp_v1.personal'}),fetchImpl:async(url,options)=>{
  calls.push({url,options});return Response.json({jsonrpc:'2.0',id:1,result:{tools:[]}});
 }});await client({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
 assert.equal(calls[0].url,NATIVE_REQUIREMENTS_BASE+'/openapi/mcp');assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].options.headers.Authorization,'Bearer transport');assert.equal(calls[0].options.headers['X-Requirement-Mcp-Token'],'rmcp_v1.personal');
});
test('project synchronization validates a root-host native URL and recovers an existing registration',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'makit-project-')),configPath=join(directory,'key.json');writeFileSync(configPath,JSON.stringify({openApiKey:'project-only-key'}),{mode:0o600});
 const job={id:'00000000-0000-4000-8000-000000000017',name:'Project A',summary:'Summary'},calls=[];
 try{const client=createProjectSyncClient({configPath,fetcher:async(url,options)=>{
  calls.push(url);assert.equal(options.headers.Authorization,'Bearer project-only-key');return Response.json({project:{sourceProjectId:job.id,projectId:job.id,projectName:job.name,projectSummary:job.summary,projectUrl:NATIVE_REQUIREMENTS_BASE+'/requirements?project=Project+A'}});
 }});assert.deepEqual(await client.ensure(job),{projectId:job.id,url:NATIVE_REQUIREMENTS_BASE+'/requirements?project=Project+A'});assert.deepEqual(calls,[NATIVE_REQUIREMENTS_BASE+'/openapi/workspace/projects/lookup']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
