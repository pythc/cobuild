import {suiteConfig,portalHost,portalRequestOrigin} from '../../../packages/config/runtime.mjs';
import {readMonitoringConfig,monitoringConfig,createMonitoringService,MonitoringError,limitedFetch} from './monitoring.mjs';
import {serveMonitoringAsset,grafanaAssetCache} from './monitoring-assets.mjs';
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
export function createMonitoringHttp({mail,config=readMonitoringConfig(),localTest=false,service,upstreamFetch=limitedFetch}={}){
  config=monitoringConfig(config);const enabled=!!config;
  const metrics=service||(config?createMonitoringService(config):null);
  const authorize=(req,embedded)=>{
    if(!mail?.enabled)throw new MonitoringError(503,'监控登录尚未配置');
    const actor=mail.identity(req,{embedded,write:false});
    if(!['admin','super_admin'].includes(actor.role)&&!config.allowedSubjects.includes(actor.subject))throw new MonitoringError(403,'没有监控查看权限');return actor;
  };
  return {enabled,async handle(req,res,path,host){
    if(!path.startsWith('/api/monitoring/')&&!path.startsWith('/monitoring/grafana/'))return false;
    try{
      if(host!==portalHost()&&!(localTest&&['127.0.0.1','localhost'].includes(host)))throw new MonitoringError(404,'Not found');
      if(!enabled)throw new MonitoringError(503,'监控服务尚未配置');
      const url=new URL(req.url,'http://localhost'),embedded=path.includes('/embedded/')||url.searchParams.get('embedded')==='1';
      authorize(req,embedded);
      if(path.startsWith('/api/monitoring/')){
        if(req.method!=='GET')throw new MonitoringError(405,'只支持读取监控数据');
        const route=path.replace('/api/monitoring/','').replace(/^embedded\//,'');
        if(route==='session'){const a=authorize(req,embedded);json(res,200,{subject:a.subject,name:a.name,role:a.role});}
        else if(route==='catalog')json(res,200,{hosts:config.hosts,panels:config.panels});
        else if(route==='snapshot')json(res,200,await metrics.snapshot(url.searchParams.get('host'),url.searchParams.get('range')||'1h'));
        else throw new MonitoringError(404,'Not found');return true;
      }
      // No arbitrary upstream URLs. Grafana is private and every request is
      // authenticated here; a fixed auth-proxy identity is always a Viewer.
      const base='/monitoring/grafana/',p=path.slice(base.length);
      const allowedGet=/^(?:d\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?\/?|public\/[a-zA-Z0-9_./-]+|api\/(?:frontend\/settings|health|user(?:\/[^?]*)?|org(?:\/[^?]*)?|search|folders(?:\/[^?]*)?|dashboards\/uid\/[a-zA-Z0-9_-]+|datasources(?:\/[^?]*)?|plugins(?:\/[^?]*)?|access-control\/user\/permissions|preferences))$/;
      const modernGet=/^apis\/dashboard\.grafana\.app\/(?:v[0-9]+(?:(?:alpha|beta)[0-9]+)?\/namespaces\/default\/dashboards(?:\/[a-zA-Z0-9_-]+(?:\/dto)?)?)?$/.test(p);
      const extraGet=/^(?:api\/login\/ping|api\/annotations|avatar\/[a-f0-9]{32,64})$/.test(p);
      const queryPost=p==='api/ds/query'||p==='apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags'||p==='api/frontend-metrics';
      if(!((['GET','HEAD'].includes(req.method)&&(allowedGet.test(p)||modernGet||extraGet))||(req.method==='POST'&&queryPost))||p.includes('..'))throw new MonitoringError(403,'不支持此 Grafana 操作');
      if(await serveMonitoringAsset(req,res,p,config.grafanaAssetsDirectory))return true;
      let body;
      if(req.method==='POST'){
        if(!portalRequestOrigin(req,localTest)||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new MonitoringError(403,'请在监控页面操作');
        if(!String(req.headers['content-type']).startsWith('application/json'))throw new MonitoringError(415,'请求格式无效');
        let length=0;const chunks=[];for await(const c of req){length+=c.length;if(length>256*1024)throw new MonitoringError(413,'请求过大');chunks.push(c);}body=Buffer.concat(chunks);
      }
      // Drop cookies, Authorization and all caller auth-proxy headers.
      const upstream=await upstreamFetch(config.grafanaUrl+'/'+p+url.search,{method:req.method,headers:{'X-WEBAUTH-USER':'pulse-viewer','Content-Type':'application/json'},...(body?{body}:{})},24*1024*1024,20000);
      const headers={'Content-Type':upstream.headers.get('content-type')||'application/octet-stream','Cache-Control':upstream.status===200&&['GET','HEAD'].includes(req.method)?grafanaAssetCache(p):'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"frame-ancestors 'self'"};
      res.writeHead(upstream.status,headers);res.end(req.method==='HEAD'?undefined:upstream.body);
    }catch(e){req.resume();if(!res.headersSent)json(res,e.status||502,{error:e.status?e.message:'监控服务暂时不可用，请重试'});}
    return true;
  }};
}
