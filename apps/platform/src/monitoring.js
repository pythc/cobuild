import {init,use} from 'echarts/core';
import {LineChart} from 'echarts/charts';
import {GridComponent,TooltipComponent,LegendComponent} from 'echarts/components';
import {CanvasRenderer} from 'echarts/renderers';
import {createLabSession} from './lab-session.js';
import {createGrafanaNavigation,refreshGrafanaData} from './monitoring-frame.js';
import {bindSuiteBrandFocus} from './suite-brand.js';
use([LineChart,GridComponent,TooltipComponent,LegendComponent,CanvasRenderer]);
const $=id=>document.getElementById(id);
const chartIds=['cpu','memory','network','disk'],charts=new Map();
const frameNavigation=createGrafanaNavigation($('grafana-frame'));
let catalog=null,snapshot=null,view='overview',cadence=15,timer,requestId=0,controller=null,frameTimer,framePoll;
const prefs=(()=>{try{return JSON.parse(localStorage.getItem('pulse-display')||'{}');}catch{return {};}})();
if([0,15,30,60].includes(prefs.cadence))cadence=prefs.cadence;
let lastGrafanaPanel=prefs.grafanaPanel||prefs.panel;
const session=createLabSession({apiRoot:'/api/monitoring/',onChange:profile=>{if(profile){$('profile-name').textContent=profile.name||'监控用户';void start();}else{removeFrame();if(catalog){clearCurrent();error('请登录后查看服务器监控',true);}}},onStatus:message=>{if(message)error(message);}});
bindSuiteBrandFocus(document.querySelector('.suite-identity'));
const text=(id,value)=>{$(id).textContent=value;};
const number=(v,d=1)=>Number.isFinite(v)?v.toFixed(d):'—';
const size=v=>Number.isFinite(v)?(v/1073741824).toFixed(1)+' GiB':'—';
function error(message,login=false){$('error').hidden=false;$('error').querySelector('span').textContent=message;$('login').hidden=!login;}
function hideError(){$('error').hidden=true;}
const setState=(label,kind='')=>{text('live-state',label);$('live-state').className='live-tag '+kind;};
function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o;}
function save(){const value={cadence,host:$('host').value,range:$('range').value,panel:$('panel').value,grafanaPanel:lastGrafanaPanel};Object.assign(prefs,value);try{localStorage.setItem('pulse-display',JSON.stringify(value));}catch{}}
function hostIdentity(){const host=catalog?.hosts.find(h=>h.id===$('host').value);if(!host)return;text('host-name',host.name);text('host-address',host.address);text('host-network',host.network==='intranet'?'内网':'公网');}
function clearCurrent(){snapshot=null;for(const key of ['cpu','memory','disk','uptime'])text(key,'—');for(const key of ['cpu','memory','disk'])$(key+'-progress').value=0;text('capacity','等待采集');text('host-state','连接中');$('host-state').className='status';text('host-detail','');for(const c of charts.values())c.clear();setState('连接中');text('prom-state','连接中');$('prom-state').className='muted';text('updated','等待采集');}
function renderSnapshot(data){
 snapshot=data;hostIdentity();setState(data.online?'实时数据':'采集离线',data.online?'live':'failed');text('host-state',data.online?'在线':'离线');$('host-state').className='status'+(data.online?' online':'');
 const v=data.values;for(const key of ['cpu','memory','disk']){text(key,number(v[key])+(Number.isFinite(v[key])?'%':''));$(key+'-progress').value=Number.isFinite(v[key])?Math.max(0,Math.min(100,v[key])):0;}
 const days=Math.floor(v.uptime/86400),hours=Math.floor((v.uptime%86400)/3600);text('uptime',Number.isFinite(v.uptime)?days+' 天 '+hours+' 小时':'—');
 text('capacity',Number.isFinite(v.memoryTotal)?'内存 '+size(v.memoryTotal):'等待采集');text('host-detail',Number.isFinite(v.cores)?v.cores+' 核 · '+size(v.diskTotal)+' 系统盘':'');
 text('prom-state',data.online?'采集中':'目标离线');$('prom-state').className=data.online?'connected':'muted';
 text('updated','更新于 '+new Date(data.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}));renderCharts();renderAlerts();
}
function renderCharts(){
 if(view!=='overview'||!snapshot)return;
 const defs={cpu:[['cpu','CPU 使用率','#2373fa']],memory:[['memory','内存使用率','#0aa68c']],network:[['networkIn','接收','#2373fa'],['networkOut','发送','#0aa68c']],disk:[['diskRead','读取','#2373fa'],['diskWrite','写入','#0aa68c']]};
 for(const key of chartIds){
  let chart=charts.get(key);if(!chart){chart=init($('chart-'+key),null,{renderer:'canvas'});charts.set(key,chart);}
  const series=defs[key].map(([field,name,color])=>({name,type:'line',data:snapshot.series[field]||[],showSymbol:false,connectNulls:false,lineStyle:{width:1.7,color},itemStyle:{color},areaStyle:{color,opacity:.055},animation:false}));
  const hasData=series.some(s=>s.data.some(p=>p[1]!==null));
  const end=snapshot.updatedAt,seconds={'15m':900,'1h':3600,'6h':21600,'24h':86400}[snapshot.range];
  chart.setOption({animation:false,textStyle:{fontFamily:'Inter, -apple-system, "PingFang SC", sans-serif',fontSize:11,color:'#8791a3'},tooltip:{trigger:'axis',confine:true,valueFormatter:v=>number(v,2)},legend:{bottom:8,itemWidth:7,itemHeight:7,icon:'circle',textStyle:{color:'#7d8799',fontSize:11}},grid:{top:22,left:42,right:16,bottom:53},xAxis:{type:'time',min:end-seconds*1000,max:end,splitNumber:5,axisLine:{lineStyle:{color:'#e7edf5'}},axisTick:{show:false},axisLabel:{fontSize:10,hideOverlap:true,formatter:value=>new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})},splitLine:{show:true,lineStyle:{color:'#edf1f7',type:'dashed'}}},yAxis:{type:'value',min:0,max:['cpu','memory'].includes(key)?100:undefined,interval:['cpu','memory'].includes(key)?25:undefined,splitNumber:4,axisLabel:{fontSize:10,formatter:value=>value>=1000?(value/1000).toFixed(1)+'k':value},splitLine:{lineStyle:{color:'#edf1f7',type:'dashed'}}},graphic:hasData?[]:[{type:'text',left:'center',top:'40%',style:{text:'等待采样数据',fill:'#98a1af',fontSize:12}}],series},true);chart.resize();
 }
}
function renderAlerts(){
 const list=$('alert-list');list.replaceChildren();const warnings=[];
 if(!snapshot)warnings.push('尚未取得监控数据');
 else if(!snapshot.online)warnings.push('服务器采集离线，请检查网络与采集器');
 else for(const [key,title,threshold] of [['cpu','CPU 使用率',90],['memory','内存使用率',90],['disk','磁盘使用率',85]])if(snapshot.values[key]>=threshold)warnings.push(title+' '+number(snapshot.values[key])+'%，已达到 '+threshold+'% 阈值');
 $('alert-count').hidden=!warnings.length;text('alert-count',warnings.length);
 if(warnings.length)for(const warning of warnings){const row=document.createElement('div');row.className='alert-row';const img=document.createElement('img');img.src='/assets/icons/bell.svg';img.alt='';const p=document.createElement('p');p.textContent=warning;row.append(img,p);list.append(row);}
 else{const box=document.createElement('div');box.className='empty';const image=document.createElement('img');image.src='/assets/icons/circle-check.svg';image.alt='';const h=document.createElement('h3');h.textContent='当前没有告警';const p=document.createElement('p');p.textContent='所选服务器的资源使用处于阈值范围内';box.append(image,h,p);list.append(box);}
}
function renderServers(){
 $('server-list').replaceChildren();for(const host of catalog.hosts){const row=document.createElement('div');row.className='server-row';const icon=document.createElement('img');icon.src='/assets/icons/server.svg';icon.alt='';const label=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p'),button=document.createElement('button');h.textContent=host.name;p.textContent=host.address+' · '+(host.network==='intranet'?'内网':'公网');label.append(h,p);button.className='button';button.textContent='查看监控';button.onclick=()=>{$('host').value=host.id;$('panel').value='overview';setView('overview');void changeHost();};row.append(icon,label,button);$('server-list').append(row);}
}
function setView(next){
 view=next;for(const id of ['overview','grafana-view','servers-view','alerts-view'])$(id).hidden=id!==({overview:'overview',panels:'grafana-view',servers:'servers-view',alerts:'alerts-view'}[view]);
 $('host-summary').hidden=view==='servers'||view==='panels';
 const title={overview:'运行总览',panels:'监控面板',servers:'服务器',alerts:'当前告警'}[view];text('title',title);text('crumb',({overview:'总览',panels:'监控面板',servers:'服务器',alerts:'告警'})[view]);
 for(const b of document.querySelectorAll('[data-view]')){b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-current',b.dataset.view===view?'page':'false');}
 if(view==='overview'){renderCharts();}else if(view==='panels'){if($('panel').value==='overview'&&catalog.panels.length)$('panel').value=catalog.panels.some(p=>p.id===lastGrafanaPanel)?lastGrafanaPanel:catalog.panels[0].id;loadFrame();}else{if(view==='servers')renderServers();else renderAlerts();}
}
function removeFrame(){clearTimeout(frameTimer);clearInterval(framePoll);frameNavigation.clear();text('grafana-state','按需加载');$('grafana-state').className='muted';}
function loadFrame({force=false}={}){
 const panel=catalog.panels.find(p=>p.id===$('panel').value);if(!panel){error('尚未配置 Grafana 面板');return;}
 lastGrafanaPanel=panel.id;text('grafana-title',panel.title);
 const query=new URLSearchParams({'var-server':$('host').value,from:'now-'+$('range').value,to:'now',refresh:cadence?cadence+'s':'',theme:'light',kiosk:'1'});
 if(!frameNavigation.navigate('/monitoring/grafana/d/'+encodeURIComponent(panel.uid)+'?'+query,{force}))return;
 text('frame-state','正在加载 Grafana 面板…');text('grafana-state','加载中');
 clearTimeout(frameTimer);clearInterval(framePoll);frameTimer=setTimeout(()=>{clearInterval(framePoll);text('frame-state','面板尚未完成加载，可点击“重载面板”重试。');text('grafana-state','加载超时');},30000);save();
}
$('grafana-frame').onload=()=>{
 if(!$('grafana-frame').hasAttribute('src'))return;
 clearInterval(framePoll);
 const inspect=()=>{
  const doc=$('grafana-frame').contentDocument;
  if(!doc)return;
  if(/Failed to load dashboard|Dashboard not found|不支持此 Grafana 操作/.test(doc.body?.innerText||'')){
   text('frame-state','面板未能加载，请检查 Grafana 连接或重载面板。');text('grafana-state','加载失败');
  }else if(doc.querySelector('#reactRoot h2, #reactRoot [role=heading], #reactRoot canvas')){
   clearInterval(framePoll);clearTimeout(frameTimer);text('frame-state','');text('grafana-state','已加载');$('grafana-state').className='connected';
  }
 };
 framePoll=setInterval(inspect,700);inspect();
};
function schedule(){clearTimeout(timer);text('refresh-text',cadence?cadence+' 秒':'刷新');if(cadence&&!document.hidden)timer=setTimeout(()=>void refresh(),cadence*1000);}
async function refresh(){
 if(!catalog)return;
 const id=++requestId;controller?.abort();controller=new AbortController();$('refresh').disabled=true;
 try{const data=await session.request('snapshot?'+new URLSearchParams({host:$('host').value,range:$('range').value}),{signal:controller.signal});if(id!==requestId)return;hideError();renderSnapshot(data);}
 catch(e){if(id!==requestId||e.name==='AbortError')return;error(e.status?e.message:'监控连接暂时中断，请重试');setState('连接中断','failed');text('host-state','状态未知');$('host-state').className='status';text('prom-state','连接中断');$('prom-state').className='muted';}
 finally{if(id===requestId){$('refresh').disabled=false;schedule();}}
}
async function changeHost(){clearCurrent();hostIdentity();save();if(view==='panels')loadFrame();await refresh();}
async function start(){
 try{catalog=await session.request('catalog');$('host').replaceChildren(...catalog.hosts.map(h=>option(h.id,h.name)));$('panel').replaceChildren(option('overview','资源总览'),...catalog.panels.map(p=>option(p.id,p.title)));
 if(catalog.hosts.some(h=>h.id===prefs.host))$('host').value=prefs.host;if(['15m','1h','6h','24h'].includes(prefs.range))$('range').value=prefs.range;
 if(catalog.panels.some(p=>p.id===prefs.panel)){$('panel').value=prefs.panel;setView('panels');}
 hostIdentity();await refresh();}catch(e){error(e.message);setState('连接不可用','failed');}
}
$('host').onchange=()=>void changeHost();$('range').onchange=()=>void changeHost();$('panel').onchange=()=>{save();setView($('panel').value==='overview'?'overview':'panels');};
$('refresh').onclick=()=>{if(view==='panels'&&!refreshGrafanaData($('grafana-frame')))loadFrame({force:true});void refresh();};$('retry').onclick=()=>catalog?void refresh():void boot();$('frame-reload').onclick=()=>loadFrame({force:true});
$('login').onclick=()=>session.login();
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{if(!catalog)return;if(b.dataset.view==='overview')$('panel').value='overview';setView(b.dataset.view);save();};
$('settings').onclick=()=>{$('cadence').value=String(cadence);$('settings-dialog').showModal();};$('cadence').onchange=()=>{cadence=Number($('cadence').value);save();schedule();if(view==='panels')loadFrame();};
document.querySelector('.collapse').onclick=()=>{const collapsed=document.body.classList.toggle('compact'),button=document.querySelector('.collapse');button.setAttribute('aria-label',collapsed?'展开侧栏':'收起侧栏');button.querySelector('img').src='/assets/icons/layout-sidebar-left-'+(collapsed?'expand':'collapse')+'.svg';for(const c of charts.values())c.resize();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{document.body.classList.toggle('big-screen');resize();}fullscreenLabel();};
function fullscreenLabel(){const on=!!document.fullscreenElement||document.body.classList.contains('big-screen');$('fullscreen').querySelector('span').textContent=on?'退出大屏':'进入大屏';}
function resize(){for(const c of charts.values())c.resize();}
document.addEventListener('fullscreenchange',()=>{document.body.classList.toggle('big-screen',!!document.fullscreenElement);fullscreenLabel();resize();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.fullscreenElement&&document.body.classList.contains('big-screen')){document.body.classList.remove('big-screen');fullscreenLabel();resize();}});
new ResizeObserver(resize).observe($('main'));
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden&&catalog)void refresh();});
window.addEventListener('pagehide',event=>{controller?.abort();clearTimeout(timer);if(event.persisted)return;clearTimeout(frameTimer);clearInterval(framePoll);for(const c of charts.values())c.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted){resize();void session.load();}});
async function boot(){hideError();try{await session.load();if(!session.profile){setState('需要登录');text('profile-name','未登录');error('请登录后查看服务器监控',true);}}catch(e){setState('无法连接','failed');error(e.message,true);}}
void boot();
