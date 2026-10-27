// Browser build identity is injected by the build, never inferred from a server
// or plugin version. Unknown installed versions cannot prove an upgrade exists.
import {PLUGIN_RELEASE} from './plugin-release.js';
export const WORKBENCH_VERSION = typeof __WORKBENCH_VERSION__ === 'string' ? __WORKBENCH_VERSION__ : null;
export const WORKBENCH_BUILD = typeof __WORKBENCH_BUILD__ === 'string' ? __WORKBENCH_BUILD__ : null;
const BUILD = /^[a-f0-9]{64}$/;
const webKey=web=>web?'web:'+web.version+':'+web.build:'';
const pluginKey=plugin=>plugin?'plugin:'+plugin.version:'';
const updateNotice=(plugin,web)=>plugin||web?{plugin,web,key:[webKey(web),pluginKey(plugin)].filter(Boolean).join('|')}:null;
export function validVersion(value) { return typeof value === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value); }
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) return null;
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;
  return 0;
}
export function availableUpdate(payload, current, installedVersion) {
  if(!payload?.release || !validVersion(payload.release.version) || payload.release.url!==PLUGIN_RELEASE.url)throw new Error('更新信息无效');
  const plugin=compareVersions(payload.release.version, installedVersion)===1
    ? {version:payload.release.version,url:PLUGIN_RELEASE.url}:null;
  // The web client should also follow an intentional server rollback. The
  // installed plugin is different: never recommend a plugin downgrade.
  const comparison=compareVersions(payload.workbenchVersion,current?.version);
  const differentVersion=comparison!==null&&comparison!==0;
  const differentBuild=comparison===0 && BUILD.test(current?.build||'') && BUILD.test(payload.workbenchBuild||'') && payload.workbenchBuild!==current.build;
  // Previous servers published only a version, with no build fingerprint.
  const web=differentVersion||differentBuild ? {version:payload.workbenchVersion,build:BUILD.test(payload.workbenchBuild||'')?payload.workbenchBuild:''}:null;
  return updateNotice(plugin,web);
}

export function createReleaseMonitor({checkRelease,current,installedVersion=null,onChange=()=>{},storage=null,now=Date.now,isVisible=()=>true,setTimer=setInterval,clearTimer=clearInterval,interval=600000,minInterval=60000}={}) {
  let active=false,epoch=0,pending=null,timer=null,lastAttempt=-Infinity,latest=null,notice=null,lastEmitted=null;
  const dismissed={web:'',plugin:''};
  try{
    const raw=storage?.getItem('cobuild-dismissed-update');
    if(typeof raw==='string'&&raw.length<=256){const value=JSON.parse(raw);for(const key of ['web','plugin'])if(typeof value?.[key]==='string')dismissed[key]=value[key];}
  }catch{}
  const snapshot=()=>({notice,pending:!!pending,lastCheckedAt:Number.isFinite(lastAttempt)?lastAttempt:null});
  function render(){
    const candidate=latest?availableUpdate(latest,current,installedVersion):null;
    // Dismiss each component separately. Installing the plugin must not bring
    // back a web reminder that the user already dismissed (or vice versa).
    notice=updateNotice(candidate?.plugin&&pluginKey(candidate.plugin)!==dismissed.plugin?candidate.plugin:null,candidate?.web&&webKey(candidate.web)!==dismissed.web?candidate.web:null);
    const key=notice?.key||'';
    if(key!==lastEmitted){lastEmitted=key;onChange(snapshot());}
  }
  function check(){
    if(!active||!isVisible())return Promise.resolve();
    if(pending)return pending;
    if(now()-lastAttempt<minInterval)return Promise.resolve();
    lastAttempt=now();const token=epoch;
    const task=Promise.resolve().then(checkRelease).then(value=>{
      if(token!==epoch||!active)return;
      // Validate before replacing the last successful result. Failures stay
      // quiet and keep any earlier legitimate update reminder available.
      availableUpdate(value,current,installedVersion);latest=value;render();
    }).catch(()=>{}).finally(()=>{if(pending===task)pending=null;});
    pending=task;return task;
  }
  return {
    snapshot,check,
    start(){if(active)return Promise.resolve();active=true;timer=setTimer(()=>void check(),interval);return check();},
    stop(){if(!active)return;active=false;epoch++;clearTimer(timer);timer=null;pending=null;lastAttempt=-Infinity;},
    setInstalledVersion(value){installedVersion=validVersion(value)?value:null;render();},
    dismiss(){if(!notice)return;if(notice.web)dismissed.web=webKey(notice.web);if(notice.plugin)dismissed.plugin=pluginKey(notice.plugin);try{storage?.setItem('cobuild-dismissed-update',JSON.stringify(dismissed));}catch{}render();}
  };
}
