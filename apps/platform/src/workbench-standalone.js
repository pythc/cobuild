import './relay-widget-entry.js';
import {initWorkbench} from './workbench.js';
import config from './projects.json';
import {initWorkspace} from './workspace.js';
import {EMBEDDED_APPS, DIRECT_APPS} from './embedded-workspace.js';
const embedded=['/workbench/embedded','/projects/embedded'].includes(location.pathname);
const projectPage=['/projects','/projects/','/projects/embedded'].includes(location.pathname);

const portal=initWorkbench(config,{embeddedIds:embedded?Object.keys(EMBEDDED_APPS):[]});
portal.setReleaseChecker(async()=>{const response=await fetch('/api/plugin/release',{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();return response.json();});
if(embedded&&window.parent!==window){
  portal.setExternalOpener(url=>window.parent.postMessage({type:'110lab-workspace-open-link',url},'*'));
  document.querySelector('#cb-nav-projects').addEventListener('click',event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id:'projects'},'*');}});
  document.querySelectorAll('[data-cb-view]').forEach(link=>{if(projectPage)link.addEventListener('click',event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id:'workbench',view:link.dataset.cbView},'*');}});});
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const id=event.target instanceof Element?event.target.closest('a[data-app-id]')?.dataset.appId:null;
    if(id&&Object.hasOwn(EMBEDDED_APPS,id)&&!DIRECT_APPS.has(id)){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id},'*');}
  },{capture:true});
}
await portal.loadApplicationAccess();
initWorkspace({applicationAccess:portal.applicationAccess()});

import {initSuiteBrand} from './suite-brand.js';
initSuiteBrand();
