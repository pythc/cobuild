import {mountRelayWidget} from './relay-widget.js';
const app=location.pathname.startsWith('/projects')?'kick':location.pathname.startsWith('/recruitment')?'hiflow':location.pathname.startsWith('/monitoring')?'pulse':null;
let widget=null;
async function check(){
  if(!app)return;
  const embedded=location.pathname.endsWith('/embedded');
  try{
    const r=await fetch(embedded?'/api/mail/embedded/session':'/api/mail/session',{credentials:'same-origin',cache:'no-store'});
    if(!r.ok){widget?.destroy();widget=null;return;}
    if(!widget)widget=mountRelayWidget({app,grant:async challenge=>{const response=await fetch('/api/relay/widget-grant'+(embedded?'?embedded=1':''),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({app,challenge})});const data=await response.json();if(!response.ok)throw Object.assign(Error('客服连接失败'),{status:response.status});return data;}});
  }catch{/* Auth check failure does not affect the host application. */}
}
void check();setInterval(check,30000);window.addEventListener('focus',check);
