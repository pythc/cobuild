import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createPortalServer,UI_URI,LEGACY_UI_URI} from '../server/portal.mjs';

test('widget declares its emitted asset origins and preserves the previous shell URI',async()=>{
  const server=await createPortalServer(),client=new Client({name:'widget-csp-verification',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(a),client.connect(b)]);
    const contents=(await client.readResource({uri:UI_URI})).contents[0];
    const csp=contents._meta.ui.csp,legacy=contents._meta['openai/widgetCSP'];
    const images=[...contents.text.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match=>new URL(match[1]).origin);
    assert.ok(images.length>0);
    for(const origin of images)assert.ok(csp.resourceDomains.includes(origin));
    assert.deepEqual(legacy.resource_domains,csp.resourceDomains);
    assert.deepEqual(legacy.frame_domains,csp.frameDomains);
    assert.ok(csp.frameDomains.includes('https://makit.110-lab.cn'));
    assert.ok(!JSON.stringify(csp).includes('*'));
    const previous=(await client.readResource({uri:'ui://110lab/workbench/v0.23.1'})).contents[0];
    assert.equal(previous.text,contents.text);
    assert.equal(UI_URI,'ui://110lab/workbench/v0.23.3');
  }finally{await client.close();await server.close();}
});

test('MCP client discovers the global workbench and reads its bundled resource',async()=>{
  const server=await createPortalServer(),client=new Client({name:'portal-verification',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(a),client.connect(b)]);
    const {tools}=await client.listTools();
    const opener=tools.find(t=>t.name==='open_110lab');
    assert.equal(opener.title,'110lab');
    assert.equal(opener._meta.ui.resourceUri,UI_URI);
    assert.equal(UI_URI,'ui://110lab/workbench/v0.23.3');
    assert.match(opener.icons[0].src,/^data:image\/png;base64,/);
    assert.equal(opener.icons[0].mimeType,'image/png');
    // Global entries use Tool.icons rather than only the plugin composer icon.
    const manifest=JSON.parse(await readFile(new URL('../plugin/110lab/plugin.json',import.meta.url),'utf8'));
    const mark=await readFile(new URL('../plugin/110lab/'+manifest.extensions['com.openai'].interface.composerIcon,import.meta.url));
    assert.deepEqual(Buffer.from(opener.icons[0].src.split(',')[1],'base64'),mark,'Global entry and plugin must show the same approved mark');
    assert.deepEqual(opener.icons[0].sizes,[mark.readUInt32BE(16)+'x'+mark.readUInt32BE(20)]);
    assert.deepEqual(opener._meta['openai/ui'].entrypoints,[{type:'global'}]);
    const opened=await client.callTool({name:'open_110lab',arguments:{}});
    assert.equal(opened.structuredContent.appCount,12);
    assert.equal(opened.structuredContent.systems.assessment,'https://exam.110-lab.cn');
    const resource=await client.readResource({uri:UI_URI});
    assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
    assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes,['fullscreen']);
    assert.equal(resource.contents[0]._meta.ui.domain,'https://internal.110-lab.cn');
    assert.equal(resource.contents[0]._meta['openai/widgetDomain'],resource.contents[0]._meta.ui.domain);
    assert.deepEqual(resource.contents[0]._meta['openai/widgetCSP'].frame_domains,resource.contents[0]._meta.ui.csp.frameDomains);
    assert.ok(resource.contents[0]._meta['openai/widgetCSP'].redirect_domains.includes('https://internal.110-lab.cn'));
    assert.deepEqual(resource.contents[0]._meta.ui.csp,{
      connectDomains:[],resourceDomains:['https://internal.110-lab.cn'],frameDomains:[
        'https://internal.110-lab.cn',
        'https://47.109.176.127','https://exam.110-lab.cn',
        'https://fcncvoyreb8p.feishuapp.com',
        'https://makit.110-lab.cn',
        'https://fcncvoyreb8p.aiforce.cloud',
        'https://open.feishu.cn',
        'https://accounts.feishu.cn',
        'https://passport.feishu.cn',
        'https://login.feishu.cn',
        'https://miaoda.feishu.cn'
      ]
    });
    assert.deepEqual(resource.contents[0]._meta['openai/widgetCSP'].resource_domains,resource.contents[0]._meta.ui.csp.resourceDomains);
    const previousShell=await client.readResource({uri:'ui://110lab/workbench/v0.23.1'});
    assert.equal(previousShell.contents[0].text,resource.contents[0].text);
    assert.match(resource.contents[0].text,/批改系统内网版/);
    assert.match(resource.contents[0].text,/公共邮箱管理/);
    assert.ok(resource.contents[0]._meta['openai/widgetCSP'].redirect_domains.includes('https://www.feishu.cn'));
    assert.match(resource.contents[0].text,/<title>CoBuild 工作台<\/title>/);
    assert.doesNotMatch(resource.contents[0].text,/首页管理|hero-story/);
    const cached=await client.readResource({uri:'ui://110lab/workbench/v0.8.7'});
    assert.equal(cached.contents[0].text,resource.contents[0].text);
    assert.equal(cached.contents[0]._meta.ui.domain,resource.contents[0]._meta.ui.domain);
    const legacy=await client.readResource({uri:LEGACY_UI_URI});
    assert.equal(legacy.contents[0].text,resource.contents[0].text);
    const v081=await client.readResource({uri:'ui://110lab/workbench/v0.8.1'});
    assert.equal(v081.contents[0].text,resource.contents[0].text);
    const v08=await client.readResource({uri:'ui://110lab/workbench/v0.8.0'});
    assert.equal(v08.contents[0].text,resource.contents[0].text);
    const v07=await client.readResource({uri:'ui://110lab/workbench/v0.7.0'});
    assert.equal(v07.contents[0].text,resource.contents[0].text);
    const previous=await client.readResource({uri:'ui://110lab/workbench/v0.6.0'});
    assert.equal(previous.contents[0].text,resource.contents[0].text);
    const images=[...resource.contents[0].text.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match=>match[1]);
    assert.ok(images.length>0);assert.ok(images.every(url=>url.startsWith('https://internal.110-lab.cn/assets/')));
    assert.match(resource.contents[0].text,/id="cb-favorites-list"/);
    const search=await client.callTool({name:'search_110lab_projects',arguments:{query:'需求'}});
    assert.equal(search.structuredContent.projects.length,1);
    assert.equal(search.structuredContent.projects[0].url,'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x');
    const missing=await client.callTool({name:'search_110lab_projects',arguments:{query:'不存在的项目'}});
    assert.deepEqual(missing.structuredContent.projects,[]);
  }finally{await client.close();await server.close();}
});
