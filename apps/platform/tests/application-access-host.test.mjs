import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {runInNewContext} from 'node:vm';import {randomUUID} from 'node:crypto';
async function fixture(){
 const messages=[],listeners={},timers=new Map();let count=0;
 class Node{constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.dataset={};this.attributes={};this.classList={add(){}};this.contentWindow={postMessage:value=>messages.push({frame:this,value})};}append(...nodes){this.children.push(...nodes);}after(node){this.next=node;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(){}querySelector(tag){return this.children.find(n=>n.tag===tag)||null;}}
 const main=new Node('main'),footer=new Node('footer'),brand=new Node('brand'),header=new Node('header'),body=new Node('body');
 const document={body,createElement:tag=>new Node(tag),querySelector:selector=>({'main.shell':main,'.wb-footer':footer,'.brand-product':brand,'.masthead-inner':header})[selector],addEventListener(){}};
 const window={addEventListener:(type,fn)=>listeners[type]=fn};
 const source=(await readFile(new URL('../src/embedded-workspace.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replaceAll('export ','');
 const api=runInNewContext(source+'\ninitEmbeddedWorkspace();',{document,window,crypto:{randomUUID},setTimeout:fn=>{timers.set(++count,fn);return count;},clearTimeout:id=>timers.delete(id),validVersion:v=>v});
 const workbench=main.next.children[0].querySelector('iframe');
 return {api,main,body,workbench,messages,receive:(data,{source=workbench.contentWindow,origin='https://internal.110-lab.cn'}={})=>listeners.message({data,source,origin}),timers};
}
test('plugin navigation rechecks current permission even for mounted frames and ignores forged replies',async()=>{
 const h=await fixture();const denied=h.api.show('requirements'),first=h.messages.at(-1).value;
 assert.equal(first.type,'110lab-application-entry-check');assert.equal(h.main.next.children.length,1);
 await h.receive({type:'110lab-application-entry-result',requestId:first.requestId,allowed:true},{origin:'https://evil.example'});assert.equal(h.main.next.children.length,1);
 await h.receive({type:'110lab-application-entry-result',requestId:first.requestId,allowed:false,error:'无访问权限'});await denied;assert.equal(h.body.dataset.currentApp,'workbench');assert.equal(h.main.next.children.length,1);
 const allowed=h.api.show('requirements'),second=h.messages.at(-1).value;await h.receive({type:'110lab-application-entry-result',requestId:second.requestId,allowed:true});await allowed;
 assert.equal(h.body.dataset.currentApp,'requirements');const frame=h.main.next.children[1].querySelector('iframe');assert.equal(frame.src,'https://internal.110-lab.cn/apps/embedded/requirements');
 await h.api.show('workbench');const repeat=h.api.show('requirements'),third=h.messages.at(-1).value;await h.receive({type:'110lab-application-entry-result',requestId:third.requestId,allowed:false});await repeat;assert.equal(h.body.dataset.currentApp,'workbench');assert.equal(frame.src,'https://internal.110-lab.cn/apps/embedded/requirements','a denied switch must not reset an existing edit');assert.equal(h.timers.size,0);
});
test('returning to the workbench cancels an older navigation completion',async()=>{const h=await fixture(),pending=h.api.show('honors'),message=h.messages.at(-1).value;await h.api.show('workbench');await h.receive({type:'110lab-application-entry-result',requestId:message.requestId,allowed:true});await pending;assert.equal(h.body.dataset.currentApp,'workbench');assert.equal(h.main.next.children.length,1);});
