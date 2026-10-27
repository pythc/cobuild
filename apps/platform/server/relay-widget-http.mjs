import {readFileSync} from 'node:fs';
import {issueWidgetGrant} from './relay-widget-issuer.mjs';
export async function handleRelayWidget(req,res,path,host,mail) {
  if(path!=='/api/relay/widget-grant')return false;
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store, private'});res.end(JSON.stringify(value));};
  try{
    if(req.method!=='POST'||host!=='internal.110-lab.cn'||req.headers.origin!=='https://internal.110-lab.cn'||req.headers['content-type']!=='application/json')throw Object.assign(Error('请求来源无效'),{status:403});
    let n=0,parts=[];for await(const p of req){if((n+=p.length)>1024)throw Object.assign(Error('请求过大'),{status:413});parts.push(p);}
    let v;try{v=JSON.parse(Buffer.concat(parts));}catch{throw Object.assign(Error('请求参数无效'),{status:400});}
    if(Object.keys(v).sort().join(',')!=='app,challenge'||!['kick','hiflow','pulse'].includes(v.app))throw Object.assign(Error('应用参数无效'),{status:400});
    const embedded=new URL(req.url,'http://localhost').searchParams.get('embedded')==='1';
    const a=mail.identity(req,{embedded});
    const key=readFileSync(process.env.PORTAL_RELAY_WIDGET_KEY_FILE||'/data/mail/relay-widget-key','utf8').trim();
    reply(200,issueWidgetGrant({key,issuer:'portal',app:v.app,origin:'https://internal.110-lab.cn',subject:a.subject,name:a.name,challenge:v.challenge}));
  }catch(e){req.resume();reply(e.status||503,{message:e.status&&e.status<500?e.message:'客服暂时无法连接'});}
  return true;
}
