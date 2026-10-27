import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRelayWidget} from '../integrations/relay-widget.js';
class Element extends EventTarget {
 constructor(tag){super();this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.contentWindow={postMessage:(v,o)=>{this.sent={value:v,origin:o};}};}
 attachShadow(){return this.shadow=new Element('shadow');}
 append(...v){this.children.push(...v);for(const x of v)x.parent=this;}
 setAttribute(k,v){this.attributes[k]=v;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
 focus(){}
 setPointerCapture(id){this.pointer=id;}
 hasPointerCapture(id){return this.pointer===id;}
 releasePointerCapture(){this.pointer=null;}
}
function send(target,type,props){const e=new Event(type);Object.assign(e,props);target.dispatchEvent(e);}
test('portable launcher clamps dragging, separates a drag from a click, scopes identity handoff and removes listeners',async()=>{
 const keys=['window','document','innerWidth','innerHeight','localStorage','MutationObserver'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const win=new EventTarget(),body=new Element('body');let calls=0,modalOpen=false,modalCallback,disconnected=false;win.visualViewport=Object.assign(new EventTarget(),{width:1000,height:800,offsetLeft:0,offsetTop:0});
 Object.assign(globalThis,{window:win,document:Object.assign(new EventTarget(),{body,visibilityState:'visible',querySelector:()=>modalOpen?{}:null,createElement:tag=>new Element(tag)}),innerWidth:1000,innerHeight:800,localStorage:{getItem:()=>null,setItem:()=>{}}});
 globalThis.MutationObserver=class {constructor(fn){modalCallback=fn;}observe(){}disconnect(){disconnected=true;}};
 try{
  const widget=mountRelayWidget({app:'makit',grant:async challenge=>{calls++;return {grant:'signed-'+challenge};}});
  const root=body.children[0].shadow,button=root.children[1],panel=root.children[2];
  send(button,'pointerdown',{button:0,pointerId:1,clientX:900,clientY:700});send(button,'pointermove',{pointerId:1,clientX:1500,clientY:-500});send(button,'pointerup',{pointerId:1});send(button,'click',{});
  assert.equal(button.style.left,'936px');assert.equal(button.style.top,'12px');assert.equal(panel.hidden,true,'drag release does not open chat');
  send(button,'click',{});assert.equal(panel.hidden,false);const frame=panel.children[0];assert.match(frame.src,/app=makit/);
  send(win,'message',{origin:'https://evil.test',source:frame.contentWindow,data:{type:'RELAY_WIDGET_READY',app:'makit',challenge:'x'.repeat(43)}});assert.equal(calls,0);
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:{},data:{type:'RELAY_WIDGET_READY',app:'makit',challenge:'x'.repeat(43)}});assert.equal(calls,0);
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:frame.contentWindow,data:{type:'RELAY_WIDGET_READY',app:'makit',challenge:'x'.repeat(43)}});await Promise.resolve();await Promise.resolve();assert.equal(calls,1);assert.equal(frame.sent.origin,'https://cobuild.110-lab.cn');
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:frame.contentWindow,data:{type:'RELAY_CLOSE'}});assert.equal(panel.hidden,true);assert.equal(panel.children.length,0,'closing stops the iframe poller');
  const monitor=root.children[3],badge=button.children[0];
  send(win,'message',{origin:'https://evil.test',source:monitor.contentWindow,data:{type:'RELAY_UNREAD_COUNT',app:'makit',count:9}});assert.equal(badge.hidden,true);
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:monitor.contentWindow,data:{type:'RELAY_UNREAD_COUNT',app:'makit',count:3}});assert.equal(badge.hidden,false);assert.equal(badge.textContent,'3');assert.equal(panel.hidden,true);
  send(button,'click',{});const nextFrame=panel.children[0];
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:nextFrame.contentWindow,data:{type:'RELAY_WIDGET_VISIBILITY_REQUEST'}});assert.equal(nextFrame.sent.value.visible,true);
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:nextFrame.contentWindow,data:{type:'RELAY_UNREAD_REFRESH'}});assert.equal(monitor.sent.value.type,'RELAY_UNREAD_REFRESH');
  send(win,'message',{origin:'https://cobuild.110-lab.cn',source:monitor.contentWindow,data:{type:'RELAY_UNREAD_COUNT',app:'makit',count:0}});assert.equal(badge.hidden,true);
  send(button,'click',{});send(win,'message',{origin:'https://cobuild.110-lab.cn',source:monitor.contentWindow,data:{type:'RELAY_UNREAD_COUNT',app:'makit',count:120}});assert.equal(badge.textContent,'99+');
  Object.assign(globalThis,{innerWidth:390,innerHeight:844});Object.assign(win.visualViewport,{width:390,height:460,offsetTop:6});send(win.visualViewport,'resize',{});
  assert.equal(panel.style.height,'444px','mobile panel fits the visual viewport above the keyboard');assert.equal(panel.style.top,'14px');assert.equal(panel.style.width,'374px');
  send(button,'click',{});const visibleFrame=panel.children[0];modalOpen=true;modalCallback();assert.equal(body.children[0].hidden,true,'launcher does not cover an application modal');assert.equal(visibleFrame.sent.value.visible,false,'hidden widget cannot acknowledge unseen messages');modalOpen=false;modalCallback();assert.equal(body.children[0].hidden,false);assert.equal(visibleFrame.sent.value.visible,true);
  widget.destroy();assert.equal(body.children.length,0);assert.equal(disconnected,true);
  const heightAfterDestroy=panel.style.height;win.visualViewport.height=600;send(win.visualViewport,'resize',{});assert.equal(panel.style.height,heightAfterDestroy,'destroy removes viewport listeners');
 }finally{for(const k of keys){const descriptor=old.get(k);if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}
});
