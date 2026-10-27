import './relay-widget-entry.js';
import {initCoBuildBrand} from "./cobuild-brand.js";
import {createLabSession} from './lab-session.js';
import {createInterviewWorkspace} from './recruitment-interviews.js';
const $=id=>document.getElementById(id);let workspace=null,identity=null;
const status=(message='',error=false)=>{const n=$('ri-status');n.textContent=message;n.hidden=!message;n.dataset.error=error;};
const session=createLabSession({apiRoot:'/api/recruitment-interviewer/',onStatus:status,onChange:p=>{
  $('ri-person').textContent=p?.name||'未登录';$('ri-login').hidden=!!p;
  $('ri-avatar').textContent=p?.name?.slice(0,1)||'';
  const key=p?JSON.stringify([p.subject,p.role,p.recruitmentRole]):null;
  if(identity!==key){workspace?.destroy();workspace=null;identity=key;}
  if(p&&!workspace){workspace=createInterviewWorkspace({session,root:$('ri-content'),assignment:new URL(location.href).searchParams.get('assignment'),onStatus:status});void workspace.load();}
  else if(!p)status('通过飞书登录后，查看分配给自己的面试');
}});
$('ri-login').onclick=()=>session.login();$('ri-refresh').onclick=()=>{if(workspace?.busy())return;if(!workspace?.dirty()||confirm('刷新会放弃未提交的填写内容，继续？'))void workspace?.load(true);};
$('ri-all').onclick=()=>{if(workspace?.busy()||workspace?.dirty()&&!confirm('填写内容尚未提交，放弃并返回所有面试？'))return;workspace?.destroy();workspace=null;location.assign('/recruitment/interviewer');};
const collapse=value=>{$('ri-shell').classList.toggle('is-collapsed',value);$('ri-collapse').setAttribute('aria-expanded',String(!value));$('ri-collapse').setAttribute('aria-label',value?'展开侧栏':'收起侧栏');$('ri-collapse').querySelector('img').src='/assets/icons/layout-sidebar-left-'+(value?'expand':'collapse')+'.svg';};
try{collapse(localStorage.getItem('hiflow.sidebar.collapsed')==='1');}catch{}
$('ri-collapse').onclick=()=>{const value=!$('ri-shell').classList.contains('is-collapsed');collapse(value);try{localStorage.setItem('hiflow.sidebar.collapsed',value?'1':'0');}catch{}};
window.addEventListener('beforeunload',e=>{if(workspace?.dirty()){e.preventDefault();e.returnValue='';}});
void session.load();

initCoBuildBrand(document);
