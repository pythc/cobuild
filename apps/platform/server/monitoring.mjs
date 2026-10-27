import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

export class MonitoringError extends Error {constructor(status,message){super(message);this.status=status;}}
const ID=/^[a-z][a-z0-9_-]{0,63}$/;
const endpoint=value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Invalid monitoring endpoint');return u.href.replace(/\/$/,'');};
export function monitoringConfig(value){
  if(!value)return null;
  if(!Array.isArray(value.hosts)||!value.hosts.length||value.hosts.length>20)throw Error('Configure monitoring hosts');
  const ids=new Set();
  const hosts=value.hosts.map(h=>{if(!ID.test(h.id)||ids.has(h.id)||!h.name||String(h.name).length>80)throw Error('Invalid monitoring host');ids.add(h.id);return {id:h.id,name:h.name,address:String(h.address||''),network:h.network==='intranet'?'intranet':'public'};});
  if(value.allowedSubjects!==undefined&&(!Array.isArray(value.allowedSubjects)||value.allowedSubjects.some(s=>typeof s!=='string'||s.length>300)))throw Error('Invalid monitoring permissions');
  const panels=value.panels||[];
  if(panels.length>30||panels.some((p,i)=>!ID.test(p.id)||!ID.test(p.uid)||!p.title||panels.findIndex(x=>x.id===p.id)!==i))throw Error('Invalid Grafana panels');
  if(value.grafanaAssetsDirectory!==undefined&&(typeof value.grafanaAssetsDirectory!=='string'||!isAbsolute(value.grafanaAssetsDirectory)))throw Error('Invalid Grafana asset directory');
  return {hosts,panels:panels.map(({id,uid,title})=>({id,uid,title})),prometheusUrl:endpoint(value.prometheusUrl),grafanaUrl:endpoint(value.grafanaUrl),allowedSubjects:value.allowedSubjects||[],...(value.grafanaAssetsDirectory?{grafanaAssetsDirectory:value.grafanaAssetsDirectory}:{})};
}
export function readMonitoringConfig(){return process.env.PORTAL_MONITORING_CONFIG?monitoringConfig(JSON.parse(readFileSync(process.env.PORTAL_MONITORING_CONFIG,'utf8'))):null;}
export function metricExpressions(host){
  if(!ID.test(host))throw new MonitoringError(400,'无效的服务器');
  const s=`server="${host}",job="pulse-node"`;
  return {
    cpu:`100 * (1 - avg(rate(node_cpu_seconds_total{${s},mode="idle"}[2m])))`,
    memory:`100 * (1 - node_memory_MemAvailable_bytes{${s}} / node_memory_MemTotal_bytes{${s}})`,
    disk:`100 * (1 - node_filesystem_avail_bytes{${s},mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{${s},mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})`,
    networkIn:`sum(rate(node_network_receive_bytes_total{${s},device!~"lo|veth.*|docker.*|br-.*"}[2m])) * 8 / 1000000`,
    networkOut:`sum(rate(node_network_transmit_bytes_total{${s},device!~"lo|veth.*|docker.*|br-.*"}[2m])) * 8 / 1000000`,
    diskRead:`sum(rate(node_disk_read_bytes_total{${s},device!~"loop.*|ram.*|dm-.*"}[2m])) / 1000000`,
    diskWrite:`sum(rate(node_disk_written_bytes_total{${s},device!~"loop.*|ram.*|dm-.*"}[2m])) / 1000000`,
    up:`up{${s}}`,
    sampledAt:`timestamp(node_uname_info{${s}})`,
    cores:`count(node_cpu_seconds_total{${s},mode="idle"})`,
    memoryTotal:`node_memory_MemTotal_bytes{${s}}`,
    diskTotal:`node_filesystem_size_bytes{${s},mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}`,
    uptime:`time() - node_boot_time_seconds{${s}}`,
  };
}
const union=entries=>entries.map(([key,q])=>`label_replace((${q}), "pulse_metric", "${key}", "", "")`).join(' or ');
export async function limitedFetch(url,options={},limit=8*1024*1024,timeoutMs=10000){
  const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel();throw new MonitoringError(502,'监控响应过大');}
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new MonitoringError(502,'监控响应过大');}chunks.push(Buffer.from(value));}
  return {status:response.status,ok:response.ok,headers:response.headers,body:Buffer.concat(chunks)};
}
export function createMonitoringService(config,{now=Date.now,fetcher=limitedFetch}={}){
  const cache=new Map(),pending=new Map();
  async function prom(route,params){
    const url=new URL(config.prometheusUrl+'/api/v1/'+route);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    // Read-only queries can retry one transient upstream/connection failure.
    for(let attempt=0;attempt<2;attempt++){
      try{const response=await fetcher(url,{},8*1024*1024,15000);if(!response.ok)throw Error('upstream');
        const data=JSON.parse(response.body);if(data.status!=='success'||!Array.isArray(data.data?.result))throw Error('upstream');return data.data.result;
      }catch(e){if(attempt)throw e;await new Promise(resolve=>setTimeout(resolve,200));}
    }
  }
  return {async snapshot(id,range='1h'){
    const host=config.hosts.find(x=>x.id===id);if(!host)throw new MonitoringError(404,'服务器不存在');
    const seconds={'15m':900,'1h':3600,'6h':21600,'24h':86400}[range];if(!seconds)throw new MonitoringError(400,'无效的时间范围');
    const key=id+range,old=cache.get(key);if(old&&now()-old.at<10000)return old.value;
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      const end=Math.floor(now()/1000),step=Math.max(15,Math.ceil(seconds/240)),expressions=metricExpressions(id);
      try{
        const [instant,history]=await Promise.all([
          prom('query',{query:union(Object.entries(expressions)),time:end,timeout:'10s'}),
          prom('query_range',{query:union(Object.entries(expressions).filter(([k])=>['cpu','memory','networkIn','networkOut','diskRead','diskWrite'].includes(k)).map(([k,q])=>[k,`(${q}) and on() (up{server="${id}",job="pulse-node"} == 1)`])),start:end-seconds,end,step,timeout:'10s'})
        ]);
        const values={};for(const r of instant){const v=Number(r.value?.[1]);values[r.metric.pulse_metric]=Number.isFinite(v)?v:null;}
        const online=values.up===1&&Number.isFinite(values.sampledAt)&&end-values.sampledAt<60;
        const series={};for(const r of history){const points=new Map((r.values||[]).map(([t,v])=>[t,Number.isFinite(Number(v))?Number(v):null]));series[r.metric.pulse_metric]=[];for(let t=end-seconds;t<=end;t+=step)series[r.metric.pulse_metric].push([t*1000,points.get(t)??null]);}
        const value={host,online,sampledAt:values.sampledAt?values.sampledAt*1000:null,updatedAt:now(),range,values:online?values:{up:0},series};
        cache.set(key,{at:now(),value});return value;
      }catch(e){throw e instanceof MonitoringError?e:new MonitoringError(502,'监控数据暂时不可用，请重试');}
    })().finally(()=>pending.delete(key));pending.set(key,task);return task;
  }};
}
