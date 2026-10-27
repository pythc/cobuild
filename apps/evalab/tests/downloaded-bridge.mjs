import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {BRIDGE_INSTRUCTIONS} from '../context-bridge/dist/server.js';
const dir=await mkdtemp(path.join(tmpdir(),'assessment-install-'));
const client=new Client({name:'download-package-check',version:'1.0'});
const transport=new StdioClientTransport({command:'npx',args:['-y',process.env.TEST_PACKAGE_URL || 'https://47.109.176.127/downloads/context-bridge-0.2.2.tgz'],env:{PATH:process.env.PATH,HOME:process.env.HOME,ASSESSMENT_URL:'https://47.109.176.127',ASSESSMENT_MCP_TOKEN:'package-check-no-real-credential',ASSESSMENT_WORKSPACE:dir},stderr:'pipe'});
transport.stderr?.on('data',data=>process.stderr.write(data));
try{
 await client.connect(transport,{timeout:90000});
 assert.equal(client.getServerVersion()?.version,'0.2.2');
 assert.equal(client.getInstructions(),BRIDGE_INSTRUCTIONS);
 const {tools}=await client.listTools();
 assert.deepEqual(tools.map(x=>x.name).sort(),['exam_status','find_candidate_files','submit_files','test_connection']);console.log('PASS Published npm package installs and exposes four direct-upload MCP tools');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
