import test from 'node:test';
import assert from 'node:assert/strict';
import {observeReadReplies} from '../src/read-observer.js';
const wait=()=>new Promise(r=>setTimeout(r,400));
function send(target,type,props={}){const e=new Event(type);Object.assign(e,props);target.dispatchEvent(e);}
test('seen means a visible public reply in an open panel and foreground tab',async()=>{
 const keys=['window','document','parent','IntersectionObserver'],old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const window=new EventTarget(),document=Object.assign(new EventTarget(),{visibilityState:'visible'}),parent={postMessage(){}};let observed,disconnected=false,callback;
 const target={dataset:{replyId:'42'}},excluded={dataset:{replyId:'43'}},root={querySelectorAll:()=>[target,excluded]},acks=[];
 Object.assign(globalThis,{window,document,parent,IntersectionObserver:class{constructor(fn){callback=fn;}observe(t){observed=t;}disconnect(){disconnected=true;}}});
 let stop;
 try {
  stop=observeReadReplies({root,ids:['42'],embedded:true,app:'makit',ack:async id=>acks.push(id)});assert.equal(observed,target);
  callback([{target,isIntersecting:true,intersectionRect:{height:60},boundingClientRect:{height:80}}]);await wait();assert.deepEqual(acks,[],'hidden panel is not read');
  const visibility=visible=>send(window,'message',{source:parent,origin:'https://internal.110-lab.cn',data:{type:'RELAY_WIDGET_VISIBILITY',app:'makit',visible}});
  document.visibilityState='hidden';visibility(true);await wait();assert.deepEqual(acks,[],'background tab is not read');
  document.visibilityState='visible';send(document,'visibilitychange');visibility(false);await wait();assert.deepEqual(acks,[],'closing cancels the visibility dwell');
  visibility(true);await wait();assert.deepEqual(acks,['42']);stop();assert.equal(disconnected,true);
 }finally{stop?.();for(const k of keys){const d=old.get(k);if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
