import test from 'node:test';
import assert from 'node:assert/strict';
import {availableUpdate,createReleaseMonitor} from '../src/workbench-release.js';
import {PLUGIN_RELEASE} from '../src/plugin-release.js';
const current={version:'0.22.0',build:'a'.repeat(64)};
const release=(options={})=>({release:PLUGIN_RELEASE,workbenchVersion:current.version,workbenchBuild:current.build,...options});
const newer=()=>release({workbenchBuild:'b'.repeat(64),release:{...PLUGIN_RELEASE,version:'0.20.0'}});
function harness(checkRelease=async()=>newer()) {
  let time=0,visible=true,scheduled,cleared=0;const notices=[];
  const storage=new Map();
  const options={checkRelease,current,installedVersion:'0.19.0',onChange:value=>notices.push(value),now:()=>time,isVisible:()=>visible,setTimer:fn=>{scheduled=fn;return 1;},clearTimer:()=>cleared++,storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
  const monitor=createReleaseMonitor(options);
  return {monitor,options,notices,storage,advance:ms=>time+=ms,hide:()=>visible=false,show:()=>visible=true,scheduled:()=>scheduled(),cleared:()=>cleared};
}

test('unknown plugin version never implies an upgrade, and newer installed versions never downgrade',()=>{
  for(const version of [undefined,null,'unknown',PLUGIN_RELEASE.version,'1.0.0'])assert.equal(availableUpdate(release(),current,version),null);
  const plugin=availableUpdate(release(),current,'0.18.9');assert.equal(plugin.plugin.version,PLUGIN_RELEASE.version);assert.equal(plugin.web,null);
});
test('a web rollback prompts refresh, but never downgrades an installed plugin',()=>{
  const notice=availableUpdate(release({workbenchVersion:'0.21.0',workbenchBuild:'c'.repeat(64)}),current,PLUGIN_RELEASE.version);
  assert.equal(notice.plugin,null);assert.equal(notice.web.version,'0.21.0');
  const legacy=availableUpdate(release({workbenchVersion:'0.21.0',workbenchBuild:undefined}),current,PLUGIN_RELEASE.version);
  assert.equal(legacy.plugin,null);assert.equal(legacy.web.version,'0.21.0');assert.equal(legacy.web.build,'');
  assert.equal(availableUpdate(release({workbenchVersion:'0.23.0',workbenchBuild:undefined}),current,null).web.version,'0.23.0');
});
test('same-version changes require a real build fingerprint and install URLs remain constrained',()=>{
  const update=availableUpdate(newer(),current,'0.19.0');assert.equal(update.web.build,'b'.repeat(64));assert.equal(update.plugin.url,PLUGIN_RELEASE.url);
  assert.equal(availableUpdate(release({workbenchBuild:undefined}),current,null),null);
  assert.equal(availableUpdate(release({workbenchBuild:'invalid'}),current,null),null);
  assert.equal(availableUpdate(release({workbenchVersion:'invalid',workbenchBuild:'b'.repeat(64)}),current,null),null);
  assert.throws(()=>availableUpdate(release({release:{version:'0.30.0',url:'https://evil.example'}}),current,'0.19.0'));
  assert.throws(()=>availableUpdate(release({release:{...PLUGIN_RELEASE,version:'<script>'}}),current,'0.19.0'));
});
test('checks automatically on start, throttles focus checks, shares concurrent reads and skips hidden tabs',async()=>{
  let calls=0,resolve;const h=harness(()=>{calls++;return new Promise(r=>resolve=r);});
  const initial=h.monitor.start();await Promise.resolve();assert.equal(calls,1);assert.equal(h.monitor.check(),initial);
  resolve(newer());await initial;assert.ok(h.monitor.snapshot().notice);await h.monitor.check();assert.equal(calls,1);
  h.advance(600000);h.hide();h.scheduled();await Promise.resolve();assert.equal(calls,1);h.show();h.scheduled();await Promise.resolve();assert.equal(calls,2);const next=h.monitor.check();resolve(newer());await next;
  assert.equal(h.notices.length,1,'unchanged releases do not announce repeatedly');h.monitor.stop();assert.equal(h.cleared(),1);
});
test('network and malformed responses remain quiet, recover later and do not clear a valid notice',async()=>{
  let result='offline';const h=harness(async()=>{if(result==='offline')throw new Error('offline');return result;});
  await h.monitor.start();assert.equal(h.notices.length,0);result=newer();h.advance(60000);await h.monitor.check();assert.ok(h.monitor.snapshot().notice);
  result=release({release:{version:'invalid',url:'unsafe'}});h.advance(60000);await h.monitor.check();assert.ok(h.monitor.snapshot().notice);
  result=release({release:{...PLUGIN_RELEASE,version:'0.19.0'}});h.advance(60000);await h.monitor.check();assert.equal(h.monitor.snapshot().notice,null);
});
test('a dismissed version stays dismissed across reloads, and a later release gets a new reminder',async()=>{
  const h=harness();await h.monitor.start();h.monitor.dismiss();assert.equal(h.monitor.snapshot().notice,null);
  const restored=createReleaseMonitor(h.options);await restored.start();assert.equal(restored.snapshot().notice,null);
  h.options.checkRelease=async()=>release({workbenchBuild:'c'.repeat(64)});const subsequent=createReleaseMonitor(h.options);await subsequent.start();assert.ok(subsequent.snapshot().notice);
  restored.stop();subsequent.stop();h.monitor.stop();
});
test('trusted host version arriving later re-evaluates cached release without polling or opening links',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return release({release:{...PLUGIN_RELEASE,version:'0.20.0'}});});h.monitor.setInstalledVersion(null);await h.monitor.start();assert.equal(h.monitor.snapshot().notice,null);
  h.monitor.setInstalledVersion('0.19.0');assert.equal(h.monitor.snapshot().notice.plugin.version,'0.20.0');assert.equal(calls,1);
  h.monitor.setInstalledVersion('0.20.1');assert.equal(h.monitor.snapshot().notice,null);h.monitor.stop();
});
test('installing a dismissed plugin cannot resurrect the same dismissed web update',async()=>{
  const h=harness();await h.monitor.start();h.monitor.dismiss();h.monitor.setInstalledVersion('0.20.0');assert.equal(h.monitor.snapshot().notice,null);
  const restored=createReleaseMonitor({...h.options,installedVersion:null});await restored.start();assert.equal(restored.snapshot().notice,null);
  restored.setInstalledVersion('0.19.0');assert.equal(restored.snapshot().notice,null);restored.stop();h.monitor.stop();
});
test('disabled or invalid browser storage does not prevent detection or dismissal in this page',async()=>{
  for(const storage of [{getItem:()=>'{broken',setItem:()=>{throw new Error('blocked');}},{getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}}]){
    const monitor=createReleaseMonitor({...harness().options,storage});await monitor.start();assert.ok(monitor.snapshot().notice);monitor.dismiss();assert.equal(monitor.snapshot().notice,null);monitor.stop();
  }
});
test('stopped or replaced checks cannot resurrect an old notice',async()=>{
  const pending=[];const h=harness(()=>new Promise(r=>pending.push(r)));
  const first=h.monitor.start();await Promise.resolve();h.monitor.stop();const second=h.monitor.start();await Promise.resolve();
  pending[1](release({release:{...PLUGIN_RELEASE,version:'0.19.0'}}));await second;pending[0](newer());await first;assert.equal(h.monitor.snapshot().notice,null);h.monitor.stop();
});
