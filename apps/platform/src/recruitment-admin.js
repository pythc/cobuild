import './relay-widget-entry.js';
import {initCoBuildBrand} from "./cobuild-brand.js";
import {createComposeWorkspace} from './recruitment-compose.js';
import {createOfferWorkspace} from './recruitment-offers.js';
import {createRecruitmentRoleWorkspace} from './recruitment-roles.js';
import {saveResumeFile} from './resume-download.js';
import {createInlineResumeController,createResumePreviewController} from './resume-preview.js';
import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import zhCN from '@uppy/locales/lib/zh_CN.js';
import {mailPreview} from './recruitment-mail-editor.js';
import {createLabSession} from './lab-session.js';
import {candidateTask,filterCandidates,isPendingCandidate,notificationIssue,stageNames,taskViews} from './recruitment-tasks.js';
import {createInterviewWorkspace} from './recruitment-interviews.js';
import {createTemplateWorkspace} from './recruitment-template-workspace.js';

const $=id=>document.getElementById(id);
const stages=[['screening','初筛'],['assessment','考核'],['interview','面试'],['decision','待决策'],['accepted','已录取'],['rejected','未通过']];
const labels={...stageNames,...Object.fromEntries(stages)};
const linkedCandidate=new URL(location.href).searchParams.get('candidate');
const noticeLabels={draft:'待确认',queued:'等待处理',failed:'发送失败',unknown:'结果待核实',sent:'服务商已接收',simulated:'模拟完成'};
const deliveryLabels={HELD:'未发送',QUEUED:'等待处理',SENDING:'处理中',RETRYING:'等待重试',FAILED:'发送失败',UNKNOWN:'结果待核实',SENT:'服务商已接收',SIMULATED:'模拟完成 未外发'};
let listPage=0,listMode='table',checkedIds=new Set();
const sidebarKey='hiflow.sidebar.collapsed';
const state={view:'candidates',tab:'all',detailTab:'resume',filtered:[],profile:null,items:[],selected:null,archived:false,decisionArchived:false,mailTab:'compose',admissionTab:'decisions',settingsTab:'people',epoch:0,load:0,opening:0,busy:false,form:null,uppy:null,abort:null,userClosed:false,suspendAuto:false,screenFor:null,screenBaseline:null,screenRequest:null,uploadFor:null,renderedId:null};
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,fn,cls='rt-button')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
const terminal=c=>['accepted','rejected'].includes(c.stage);
const canManage=profile=>profile?.recruitmentCapabilities?.manage===true;
const canSee=(view,profile=state.profile)=>!!profile&&(view==='interviews'||(view==='settings'?profile.recruitmentCapabilities?.manageHr===true||profile.role==='super_admin':canManage(profile)));
const wide=()=>window.matchMedia('(min-width:901px)').matches;
const status=(text='',error=false)=>{const n=$('rt-status');n.textContent=text;n.hidden=!text;n.dataset.error=String(error);};
const destroyUpload=()=>{state.abort?.abort();state.abort=null;state.uppy?.destroy();state.uppy=null;state.uploadFor=null;state.uploadRevision=null;};
const resumePreview=createResumePreviewController();
const inlineResume=createInlineResumeController();
function clearResumePreview(){resumePreview.destroy();inlineResume.destroy();$('rw-resume-preview').replaceChildren();}
function screenState(){if($('rw-screen-panel').hidden)return null;return $('rw-screen-note').value+'\n'+($('rw-next-assessment').checked?'assessment':'interview');}
function screenDirty(){const cur=screenState();return state.selected?.id===state.screenFor&&state.screenBaseline!==null&&cur!==null&&cur!==state.screenBaseline;}
function unsavedCandidate(){const reasons=[];if($('rt-form-dialog').open)reasons.push('表单尚未提交');if(state.uppy?.getFiles().length)reasons.push('已选择的简历尚未保存');if(screenDirty())reasons.push('初筛记录尚未提交');return reasons;}
function confirmLeave(){const reasons=unsavedCandidate();return !reasons.length||confirm(reasons.join('，')+'。离开并放弃这些修改？');}
function closeForm(force=false){if(state.busy&&!force)return;clearTimeout(state.form?.previewTimer);if($('rt-form-dialog').open)$('rt-form-dialog').close();state.form?.editor?.destroy();state.form=null;}
function closeDetail(force=false,closedByUser=false){if(state.busy&&!force)return;if(!force&&!confirmLeave())return;closeForm(true);state.opening++;destroyUpload();clearResumePreview();state.selected=null;state.renderedId=null;state.screenFor=null;state.screenBaseline=null;state.userClosed=closedByUser;for(const row of document.querySelectorAll('.rw-queue-item'))row.setAttribute('aria-selected','false');updatePager();applySelection();}
function setBusy(value){
  state.busy=value;state.form?.editor?.setDisabled(value);
  for(const id of ['rt-new','rt-new-empty','rt-settings','rt-refresh','rt-logout','rt-form-submit','rt-form-cancel','rt-form-close','rt-detail-close','rt-detail-done','rt-upload-submit','rw-previous','rw-next','rw-resume-expand','rw-resume-download'])if($(id))$(id).disabled=value;
  for(const b of document.querySelectorAll('#rt-detail-actions button, #rt-resume-info button, .rw-sidebar [data-view], #rt-rows button'))b.disabled=value;
  for(const control of document.querySelectorAll('#rt-form-fields input, #rt-form-fields textarea, #rt-form-fields select, #rw-screen-panel input, #rw-screen-panel textarea'))control.disabled=value;
  state.uppy?.getPlugin('Dashboard')?.setOptions({disabled:value});
  if(!value){updatePager();if(state.form?.previewReady===false)$('rt-form-submit').disabled=true;}
}
const blankFilter=()=>({archived:false,query:'',group:'',stage:'',tab:'all',task:'all'});
let committed=blankFilter();
function currentFilter(){return {archived:state.archived,query:$('rt-search').value,group:$('rt-group').value,stage:$('rt-stage').value,tab:state.tab,task:$('rt-task').value||'all'};}
function writeFilter(snapshot){state.tab=snapshot.tab;state.archived=!!snapshot.archived;$('rt-task').value=snapshot.task||'all';$('rt-stage').value=snapshot.stage||'';$('rt-group').value=snapshot.group||'';$('rt-search').value=snapshot.query||'';}
function tryFilter(next){
  const projected=filterCandidates(state.items,next);
  const leaves=state.selected&&!projected.visible.some(c=>c.id===state.selected.id);
  if(leaves&&unsavedCandidate().length&&!confirm('当前候选人有未提交的内容。切换筛选将离开该候选人并放弃修改。继续？')){writeFilter(committed);return;}
  if(leaves)closeDetail(true,true);
  listPage=0;checkedIds.clear();committed={...next};writeFilter(next);renderTable();
}
function clearPrivate(){
  status();checkedIds.clear();listPage=0;
  state.epoch++;state.load++;state.opening++;state.openedLinked=false;state.userClosed=false;state.suspendAuto=false;state.tab='all';state.archived=false;state.screenRequest=null;committed=blankFilter();
  composeWorkspace?.destroy();composeWorkspace=null;offerWorkspace?.destroy();offerWorkspace=null;roleWorkspace?.destroy();roleWorkspace=null;templateWorkspace?.destroy();templateWorkspace=null;interviewWorkspace?.destroy();interviewWorkspace=null;
  $('rw-templates').replaceChildren();$('rw-interview-list').replaceChildren();$('rw-offers').replaceChildren();$('rw-hr').replaceChildren();$('rw-compose').replaceChildren();$('rw-mail-history').replaceChildren();$('rw-decisions').replaceChildren();
  closeForm(true);closeDetail(true);state.items=[];state.profile=null;setBusy(false);
  $('rt-deliveries').replaceChildren();$('rt-rows').replaceChildren();$('rt-count').textContent='';$('rt-detail-info').textContent='';$('rt-events').replaceChildren();$('rt-current').replaceChildren();$('rt-detail-actions').replaceChildren();$('rt-form-fields').replaceChildren();$('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();$('rw-feedback').replaceChildren();$('rw-task-log').replaceChildren();$('rw-record-facts').replaceChildren();
  for(const id of ['rt-detail-title','rt-detail-stage','rt-notice-body','rt-notice-subject','rt-upload-status','rt-detail-updated','rw-summary','rw-count-all','rw-count-pending'])$(id).textContent='';
  $('rt-search').value='';$('rt-stage').value='';$('rt-task').value='all';$('rt-group').replaceChildren(new Option('所有组别',''));$('rw-screen-note').value='';
}
let composeWorkspace=null,offerWorkspace=null,roleWorkspace=null,templateWorkspace=null,interviewWorkspace=null;
function applySelection(){
  const selected=!!state.selected&&state.view==='candidates';document.querySelector('.rw-resume-tab-actions').hidden=state.detailTab!=='resume';
  $('rt-detail').hidden=!selected;$('hf-detail-backdrop').hidden=true;if(selected&&!$('rt-detail').open)$('rt-detail').showModal();if(!selected&&$('rt-detail').open)$('rt-detail').close();$('rw-task').hidden=!selected||state.detailTab!=='workflow';$('rw-unselected').hidden=true;
  $('rw-shell').classList.toggle('is-reading',selected);
}
function applyVisibility(){
  const profile=state.profile;$('hf-current-page').textContent=({candidates:'候选人',interviews:'面试',admission:'录取',notifications:state.mailTab==='templates'?'邮件模板':'邮件',settings:'设置'})[state.view]||'HiFlow';
  $('rt-locked').hidden=!!profile;$('rw-nav').hidden=!profile;$('rt-login').hidden=!!profile;$('rt-logout').hidden=!profile;$('rt-login-main').hidden=!!profile;$('rt-back').hidden=session.embedded;
  $('rw-sidebar-settings').hidden=!canSee('settings',profile);
  for(const n of document.querySelectorAll('.rw-sidebar [data-view]')){n.hidden=!canSee(n.dataset.view,profile);if(n.dataset.view===state.view&&(n.dataset.view!=='notifications'||(n.dataset.mailView==='templates')===(state.mailTab==='templates')))n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');}
  $('rw-settings-people').hidden=!profile?.recruitmentCapabilities?.manageHr;$('rw-settings-mail').hidden=profile?.role!=='super_admin';
  $('rt-content').hidden=state.view!=='candidates'||!canManage(profile);
  $('rw-interviews').hidden=state.view!=='interviews'||!profile;
  $('rw-admission').hidden=state.view!=='admission'||!canManage(profile);
  $('rw-notifications').hidden=state.view!=='notifications'||!canManage(profile);
  $('rw-settings').hidden=state.view!=='settings'||!canSee('settings',profile);
  $('rt-person').textContent=profile?profile.name+' · '+(profile.recruitmentRole==='hr'?'HR':{super_admin:'超级管理员',admin:'管理员',member:'面试官'}[profile.role]||'面试官'):'未登录';
  $('rt-avatar').textContent=profile?.name?.slice(0,1)||'';
  $('rt-locked-title').textContent=profile?'暂无招新管理权限':'登录后管理招新';
  $('rt-locked-description').textContent=profile?'请联系实验室超级管理员开通管理员权限':'通过飞书登录后 实验室管理员可处理招新流程';
  applySelection();
}
const session=createLabSession({apiRoot:'/api/recruitment-admin/',onStatus:status,onChange:profile=>{
  const changed=profile?.subject!==state.profile?.subject||profile?.role!==state.profile?.role||profile?.recruitmentRole!==state.profile?.recruitmentRole;
  if(changed||!profile)clearPrivate();
  state.profile=profile;applyVisibility();
  if(!profile){$('rt-mode').textContent='未连接';return;}
  if(!canManage(profile))$('rt-mode').textContent='面试官工作区';
  if(!canSee(state.view)){void setView(canManage(profile)?'candidates':'interviews');return;}
  if(canManage(profile))void loadCandidates();
  if(state.view==='interviews'&&!interviewWorkspace)void setView('interviews');
  else if(state.view==='admission'&&!offerWorkspace&&state.admissionTab==='offers')void setView('admission');
  else if(state.view==='notifications'&&!composeWorkspace)void setView('notifications');
  else if(state.view==='settings'&&profile.recruitmentCapabilities?.manageHr&&!roleWorkspace)void setView('settings');
}});
$('rt-back').hidden=session.embedded;
$('rt-stage').append(...stages.map(([value,label])=>new Option(label,value)));
const taskOrder=taskViews.filter(([key])=>key!=='all');taskOrder.splice(taskOrder.findIndex(([key])=>key==='assign')+1,0,['waiting','待面试官填写']);
$('rt-task').append(...[['all','全部任务'],...taskOrder].map(([value,label])=>new Option(label,value)));
async function loadCandidates(){
  if(!canManage(state.profile))return;const epoch=state.epoch,load=++state.load;
  try{
    const result=await session.request('candidates');
    if(epoch!==state.epoch||load!==state.load)return;
    state.items=result.items;state.mode=result.deliveryMode;$('rt-mode').textContent=result.localPreview?'本地测试 · 邮件不外发':result.testDeliveryEnabled?'仅指定测试地址可外发':result.deliveryMode==='live'?'正式发送':'仅模拟 不外发';
    const group=$('rt-group').value;const groups=[...new Set(state.items.map(c=>c.group))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    $('rt-group').replaceChildren(new Option('所有组别',''),...groups.map(g=>new Option(g,g)));$('rt-group').value=groups.includes(group)?group:'';committed={...currentFilter()};
    if(state.selected&&!state.items.some(c=>c.id===state.selected.id))closeDetail(true);
    renderTable();
    if(state.view==='admission')renderDecisions();
    if(!state.openedLinked&&/^[a-f0-9-]{36}$/.test(linkedCandidate||'')){state.openedLinked=true;const linked=state.items.find(c=>c.id===linkedCandidate);if(linked?.archived){state.archived=true;committed={...currentFilter()};renderTable();}state.userClosed=false;void openCandidate(linkedCandidate);}

  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function replaceCandidate(candidate){
  const index=state.items.findIndex(c=>c.id===candidate.id);
  if(index<0)state.items.unshift(candidate);else state.items[index]=candidate;
  if(state.selected?.id===candidate.id)state.selected=candidate;
  renderTable();if(state.view==='admission')renderDecisions();
}
function renderTable(){
  const activeFilters=Number(!!$('rt-stage').value)+Number(!!$('rt-group').value)+Number($('rt-task').value!=='all')+Number(state.archived);
  $('rw-filter-summary').textContent=activeFilters?'筛选 · '+activeFilters:'筛选';
  const {counts,visible}=filterCandidates(state.items,currentFilter());
  state.filtered=visible;
  $('rw-count-all').textContent=String(counts.all);$('rw-count-pending').textContent=String(counts.pending);
  $('rw-tab-all').setAttribute('aria-pressed',String(state.tab==='all'));$('rw-tab-pending').setAttribute('aria-pressed',String(state.tab==='pending'));
  $('rt-active').setAttribute('aria-pressed',String(!state.archived));$('rt-archived').setAttribute('aria-pressed',String(state.archived));
  const hasScope=state.items.some(c=>c.archived===state.archived);
  $('rt-empty').hidden=hasScope;$('rw-queue-scroll').hidden=!hasScope;
  const scroller=$('rw-queue-scroll'),top=scroller.scrollTop;
  renderCandidateList(visible);
  if(hasScope&&!visible.length)$('rt-rows').append(el('p','rw-queue-empty','此筛选下暂无候选人'));
  scroller.scrollTop=top;
  $('rt-count').textContent='共 '+visible.length+' 位';
  $('hf-page-index').textContent=(listPage+1)+' / '+Math.max(1,Math.ceil(visible.length/50));$('hf-page-prev').disabled=listPage===0;$('hf-page-next').disabled=(listPage+1)*50>=visible.length;
  $('hf-bulk').hidden=!checkedIds.size;$('hf-selected-count').textContent='已选择 '+checkedIds.size+' 人';
  updatePager();applySelection();
}
function renderCandidateList(visible){
  checkedIds=new Set([...checkedIds].filter(id=>visible.some(c=>c.id===id)));
  listPage=Math.min(listPage,Math.max(0,Math.ceil(visible.length/50)-1));
  const mount=$('rt-rows');mount.replaceChildren();
  $('hf-table-view').setAttribute('aria-pressed',String(listMode==='table'));$('hf-board-view').setAttribute('aria-pressed',String(listMode==='board'));
  const pick=(c,checked)=>{if(checked&&checkedIds.size>=50){status('每批最多选择 50 位候选人',true);return false;}checked?checkedIds.add(c.id):checkedIds.delete(c.id);$('hf-bulk').hidden=!checkedIds.size;$('hf-selected-count').textContent='已选择 '+checkedIds.size+' 人';return true;};
  const page=visible.slice(listPage*50,listPage*50+50);
  if(listMode==='board'){
    const board=el('div','hf-board');
    for(const [stage,label] of stages){const col=el('section','hf-stage-column');const items=page.filter(c=>c.stage===stage);col.append(el('h3','',label+' '+visible.filter(c=>c.stage===stage).length));for(const c of items){const card=button('',()=>void openCandidate(c.id),'hf-candidate-card');card.append(el('span','rw-avatar',c.name.slice(0,1)),el('strong','',c.name),el('small','',c.group),el('span','hf-card-task',candidateTask(c).label));col.append(card);}if(!items.length)col.append(el('p','rt-help','暂无候选人'));board.append(col);}mount.append(board);return;
  }
  const table=el('table','hf-candidate-table'),head=el('thead'),headRow=el('tr');
  const all=el('input');all.type='checkbox';all.setAttribute('aria-label','选择本页候选人');all.checked=!!page.length&&page.every(c=>checkedIds.has(c.id));all.indeterminate=page.some(c=>checkedIds.has(c.id))&&!all.checked;all.onchange=()=>{if(all.checked&&new Set([...checkedIds,...page.map(c=>c.id)]).size>50){all.checked=false;status('每批最多选择 50 位候选人',true);return;}for(const c of page)pick(c,all.checked);renderTable();};const th=el('th');th.append(all);headRow.append(th,...['姓名','组别','邮箱','阶段','当前任务','更新时间'].map(v=>el('th','',v)));head.append(headRow);table.append(head);const body=el('tbody');
  for(const c of page){const row=el('tr');row.dataset.id=c.id;row.classList.toggle('is-selected',checkedIds.has(c.id));const choice=el('input');choice.type='checkbox';choice.checked=checkedIds.has(c.id);choice.setAttribute('aria-label','选择 '+c.name);choice.onchange=()=>{if(!pick(c,choice.checked))choice.checked=false;row.classList.toggle('is-selected',choice.checked);all.checked=page.every(c=>checkedIds.has(c.id));all.indeterminate=page.some(c=>checkedIds.has(c.id))&&!all.checked;};const cell=el('td');cell.append(choice);row.append(cell);const name=el('td'),link=button('',()=>void openCandidate(c.id),'hf-candidate-name');link.append(el('span','rw-avatar',c.name.slice(0,1)),el('strong','',c.name));name.append(link);row.append(name,el('td','',c.group),el('td','hf-email',c.email));const stage=el('td');stage.append(el('span','hf-stage hf-stage-'+c.stage,labels[c.stage]));row.append(stage,el('td','hf-task',candidateTask(c).label),el('td','hf-date',date(c.updatedAt)));body.append(row);}table.append(body);mount.append(table);
}
$('hf-table-view').onclick=()=>{listMode='table';renderTable();};$('hf-board-view').onclick=()=>{listMode='board';renderTable();};
$('hf-page-prev').onclick=()=>{listPage=Math.max(0,listPage-1);renderTable();};$('hf-page-next').onclick=()=>{listPage++;renderTable();};
$('hf-bulk-clear').onclick=()=>{checkedIds.clear();renderTable();};
$('hf-bulk-mail').onclick=async()=>{const candidates=state.items.filter(c=>checkedIds.has(c.id));state.mailTab='compose';await setView('notifications');if(state.view==='notifications'&&composeWorkspace)composeWorkspace.selectCandidates(candidates);};
$('rt-detail').addEventListener('cancel',e=>{e.preventDefault();closeDetail(false,true);});
$('hf-detail-backdrop').onclick=()=>closeDetail(false,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.selected&&!$('rt-form-dialog').open){e.preventDefault();closeDetail(false,true);}});
function renderQueueItem(c){
  const row=el('button','rw-queue-item');row.type='button';row.dataset.id=c.id;row.setAttribute('role','option');row.setAttribute('aria-selected',String(state.selected?.id===c.id));row.title=c.email;
  const copy=el('span','rw-queue-copy');copy.append(el('strong','',c.name),el('small','',c.group+' · '+(labels[c.stage]||c.stage)));
  const arrow=document.createElement('img');arrow.src='/assets/icons/arrow-right.svg';arrow.alt='';
  row.append(el('span','rw-avatar',c.name.slice(0,1)),copy,arrow);
  row.addEventListener('click',()=>{state.userClosed=false;void openCandidate(c.id);});
  return row;
}
function updatePager(){
  const index=state.filtered.findIndex(c=>c.id===state.selected?.id);
  $('rw-previous').disabled=state.busy||index<=0;$('rw-next').disabled=state.busy||index<0||index>=state.filtered.length-1;
}
async function openCandidate(id){
  if(state.busy||!canManage(state.profile))return;
  if(state.selected?.id===id){applySelection();return;}
  if(!confirmLeave())return;
  closeForm(true);const epoch=state.epoch,opening=++state.opening,keepTab=false;
  try{
    const c=await session.request('candidates/'+id);
    if(epoch!==state.epoch||opening!==state.opening)return;
    state.selected=c;if(!keepTab)state.detailTab='workflow';state.userClosed=false;renderDetail();$('rt-detail').focus({preventScroll:true});
    document.querySelector('.rw-queue-item[aria-selected=true]')?.scrollIntoView({block:'nearest'});
  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function renderDetail(){
  const c=state.selected;if(!c)return;const epoch=state.epoch;
  $('rt-detail-title').textContent=c.name;$('rt-detail-info').textContent=c.group+' | '+c.email;$('rt-detail-stage').textContent=labels[c.stage]+(c.archived?' · 已归档':'');
  $('rw-task-title').textContent=candidateTask(c).label;$('rw-summary').textContent=c.summary||'';
  $('rt-detail-updated').textContent='更新于 '+date(c.updatedAt);
  if(state.renderedId!==c.id)$('rt-detail').scrollTop=0;
  state.renderedId=c.id;
  renderScreen(c);
  const summary=[];
  if(c.assessment)summary.push('考核 '+c.assessment.score+' 分 · '+c.assessment.note);
  if(c.interview&&(!c.assignment||c.assignment.status==='approved')){summary.push('面试 '+date(c.interview.at)+' · '+(c.interview.durationMinutes||30)+' 分钟 · '+c.interview.interviewer+' · '+c.interview.location);if(c.interview.score!==undefined&&!c.assignment?.feedback)summary.push('面试反馈 '+c.interview.score+' 分 · '+c.interview.note);}
  if(c.assignment){const a=c.assignment;summary.push('面试官 '+a.name+' · '+({requested:'等待面试官填写',submitted:'待管理员审核',changes_requested:'已退回修改',approved:'安排已确认'}[a.status]||a.status));if(a.proposal&&a.status!=='approved')summary.push('待审核安排 '+date(a.proposal.at)+' · '+(a.proposal.durationMinutes||30)+' 分钟 · '+a.proposal.location+' · '+a.proposal.contact);}
  if(c.decisionNote)summary.push('决策记录 '+c.decisionNote);
  if(!summary.length&&c.stage!=='screening')summary.push(({assessment:'考核进行中 完成后记录成绩',interview:'安排面试并审核通知内容',decision:'根据评价记录确认本次决策'})[c.stage]||'流程已结束');
  $('rt-current').replaceChildren(...summary.map(v=>el('p','rt-current-summary',v)));
  const actions=[];
  const add=(text,action,values,cls)=>actions.push(button(text,()=>openForm(action,values),cls||'rt-button'));
  if(!c.archived){
    if(c.stage==='screening')actions.push(button('通过初筛',()=>void submitScreen(),'rt-button rt-primary'));
    if(c.stage==='assessment')add('记录考核结果','assessment',{},'rt-button rt-primary');
    if(c.stage==='interview'){
      if(!c.assignment&&!c.interview)add('分配面试官','assign_interviewer',{},'rt-button rt-primary');
      else if(c.assignment?.status==='submitted'||!c.assignment&&c.interview&&!['sent','simulated','queued','unknown'].includes(c.notification?.status)){
        if(c.notification?.status==='draft')actions.push(button('继续审核并发送邀请',()=>void previewDelivery('interview'),'rt-button rt-primary'));
        else add('审核安排与邀请邮件','prepare_notice',{},'rt-button rt-primary');
        if(c.notification?.status==='draft')add('修改邀请内容','prepare_notice');
        if(c.assignment?.status==='submitted')add('退回修改','return_interview');
      }else if(c.assignment?.status==='approved')add('发起改期','reschedule');
      if(['requested','changes_requested','submitted'].includes(c.assignment?.status)&&!['queued','unknown'].includes(c.notification?.status))add('更换面试官','assign_interviewer');
      if(!c.assignment&&['simulated','sent'].includes(c.notification?.status))add('补录历史面试评价','interview');
    }
    if(c.stage==='decision')add('录取并审核通知','prepare_outcome',{outcome:'accepted'},'rt-button rt-primary');
    if(!terminal(c))add('未通过','prepare_outcome',{outcome:'rejected'},'rt-button rt-danger');
    else{if(['failed','draft'].includes(c.resultNotification?.status))add('重新准备结果通知','prepare_outcome',{outcome:c.stage},'rt-button rt-primary');add('归档候选人','archive');}
  }
  if(!c.archived&&c.resultNotification?.status==='draft'&&c.resultDraftValid)actions.push(button('继续审核'+(c.resultNotification.outcome==='accepted'?'录取':'未通过')+'通知',()=>void previewDelivery('outcome'),'rt-button'));
  const feedback=c.assignment?.feedback;$('rw-feedback').replaceChildren();
  if(feedback){$('rw-feedback').append(el('h3','','面试评价'),el('p','rw-score',feedback.score+' / 100'),el('p','',({recommend:'建议录取',consider:'建议进一步讨论',decline:'建议不录取'}[feedback.recommendation])),el('p','rw-feedback-note',feedback.note),el('p','rt-help',feedback.by+' · '+date(feedback.at)));}
  else if(c.assignment?.status==='approved')$('rw-feedback').append(el('p','rw-callout','等待 '+c.assignment.name+' 完成面试并提交评价'));
  const issue=notificationIssue(c);if(issue)actions.unshift(button(issue+' · 查看处理',()=>document.querySelector('[data-detail-tab=notifications]').click(),'rt-button rw-warning'));
  $('rt-detail-actions').replaceChildren(...actions);
  const facts=[];if(c.assessment)facts.push('考核 '+c.assessment.score+' 分 · '+c.assessment.note);if(c.decisionNote)facts.push('决策记录 '+c.decisionNote);
  $('rw-record-facts').replaceChildren(...facts.map(v=>el('p','',v)));
  const log=$('rw-task-log');log.replaceChildren(el('h3','','处理记录'));
  const recent=[...c.events].reverse().slice(0,4);
  if(!recent.length)log.append(el('p','rt-help','暂无处理记录'));else log.append(...recent.map(event=>el('p','rw-log-item',date(event.at)+' · '+event.action)));
  for(const b of document.querySelectorAll('[data-detail-tab]'))b.setAttribute('aria-pressed',String(b.dataset.detailTab===state.detailTab));
  for(const panel of document.querySelectorAll('[data-detail-panel]'))panel.hidden=panel.dataset.detailPanel!==state.detailTab;
  renderDeliveries(c);
  $('rt-notice-section').hidden=!c.notification;
  $('rt-notice-state').textContent=c.notification?noticeLabels[c.notification.status]+(c.notification.attempts?' · '+c.notification.attempts+' 次尝试':''):'';
  $('rt-notice-subject').textContent=c.notification?`${c.notification.subject} · 发件 ${c.notification.from} · 回复 ${c.notification.replyTo}`:'';$('rt-notice-body').textContent=c.notification?.body||'';
  $('rt-events').replaceChildren(...[...c.events].reverse().map(event=>{const n=el('li'),head=el('div','rt-event-head');head.append(el('strong','',event.action),el('time','',date(event.at)));n.append(head,el('p','',event.actor+(event.note?' · '+event.note:'')));return n;}));
  $('rw-resume-expand').hidden=!c.resume;$('rw-resume-expand').onclick=()=>{if(state.selected?.resume)previewResume(state.selected);};
  $('rw-resume-download').hidden=!c.resume;$('rw-resume-download').onclick=()=>{if(state.selected?.resume)void downloadResume(state.selected);};
  resumePreview.sync(c);
  inlineResume.show(c,{host:$('rw-resume-preview'),load:()=>session.download('candidates/'+c.id+'/resume'),download:()=>{if(state.selected?.resume)void downloadResume(state.selected);},current:()=>epoch===state.epoch&&state.selected?.id===c.id&&state.selected?.resume?.sha256===c.resume?.sha256});
  renderUpload(c);updatePager();applySelection();
  for(const row of document.querySelectorAll('.rw-queue-item'))row.setAttribute('aria-selected',String(row.dataset.id===c.id));
}
function renderScreen(c){
  const show=!c.archived&&c.stage==='screening';$('rw-screen-panel').hidden=!show;
  if(!show){state.screenFor=null;state.screenBaseline=null;return;}
  if(state.screenFor===c.id&&screenDirty())return;
  state.screenFor=c.id;$('rw-screen-note').value='';$('rw-next-interview').checked=true;$('rw-screen-error').hidden=true;state.screenBaseline=screenState();updateScreenCount();
}
function updateScreenCount(){$('rw-screen-count').textContent=$('rw-screen-note').value.length+' / 2000';}
async function submitScreen(){
  const c=state.selected;if(state.busy||!c||c.archived||c.stage!=='screening'||!canManage(state.profile))return;
  const payload={revision:c.revision,action:'screen',assessmentRequired:$('rw-next-assessment').checked,note:$('rw-screen-note').value.trim()};
  const fingerprint=JSON.stringify(payload);
  if(state.screenRequest?.fingerprint!==fingerprint)state.screenRequest={fingerprint,id:crypto.randomUUID()};
  const epoch=state.epoch;setBusy(true);$('rw-screen-error').hidden=true;
  try{
    const result=await session.request('candidates/'+c.id+'/actions',{method:'POST',data:{...payload,requestId:state.screenRequest.id}});
    if(epoch!==state.epoch)return;
    state.screenRequest=null;state.screenBaseline=null;state.screenFor=null;state.selected=result;await refreshSelected(result.id,epoch);status('初筛已通过');void loadCandidates();
  }catch(error){
    if(epoch!==state.epoch)return;
    if(error.status===409)await refreshSelected(c.id,epoch);
    $('rw-screen-error').hidden=false;$('rw-screen-error').textContent=error.status===409?error.message+'。本次未提交，记录已保留。':error.message;
  }finally{if(epoch===state.epoch)setBusy(false);}
}
function renderUpload(c){
  if(state.uppy&&state.uploadFor===c.id&&state.uploadRevision===c.revision&&state.uppy.getFiles().length&&!c.archived)return;
  destroyUpload();
  $('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();$('rt-upload-status').textContent='';
  $('rw-upload-disclosure').hidden=c.archived;
  if(c.resume){const box=el('div','rt-resume-file');box.append(el('strong','',c.resume.filename),el('p','',Math.ceil(c.resume.bytes/1024)+' KB · '+'永久保留'));if(!session.embedded)box.append(button('下载',()=>void downloadResume(c)));$('rt-resume-info').append(box);}
  $('rt-upload').hidden=c.archived;$('rt-upload-actions').hidden=c.archived;
  if(c.archived)return;
  const epoch=state.epoch,instance=new Uppy({id:'110lab-recruitment-'+c.id,autoProceed:false,restrictions:{maxNumberOfFiles:1,minNumberOfFiles:1,maxFileSize:10*1024*1024,allowedFileTypes:['.pdf','.docx']},locale:zhCN});
  state.uppy=instance;state.uploadFor=c.id;state.uploadRevision=c.revision;
  instance.use(Dashboard,{target:'#rt-upload',inline:true,width:'100%',height:180,hideUploadButton:true,hideRetryButton:true,hideCancelButton:true,disableThumbnailGenerator:true,proudlyDisplayPoweredByUppy:false,note:'PDF 或 DOCX'});
  let requestId=null,uploaded=null;
  instance.on('file-added',()=>{requestId=null;});instance.on('file-removed',()=>{requestId=null;});
  instance.on('restriction-failed',(_file,error)=>{$('rt-upload-status').textContent=error.message;});
  instance.addUploader(async ids=>{
    const file=instance.getFile(ids[0]);if(!file)return;
    requestId||=crypto.randomUUID();uploaded=null;
    const form=new FormData();form.set('requestId',requestId);form.set('revision',String(c.revision));form.append('resume',file.data,file.name);
    const controller=new AbortController();state.abort=controller;instance.emit('upload-start',[file]);
    try{
      const result=await session.upload('candidates/'+c.id+'/resume',form,controller.signal);
      if(epoch!==state.epoch||state.uppy!==instance)return;
      uploaded=result;instance.emit('upload-success',file,{status:200,body:result});
    }catch(error){
      if(epoch!==state.epoch||state.uppy!==instance)return;
      instance.emit('upload-error',file,error);$('rt-upload-status').textContent=error.message;
      if(error.status===409){requestId=null;await refreshSelected(c.id,epoch);$('rt-upload-status').textContent='资料已更新 请重新选择简历后上传';}
    }finally{if(state.abort===controller)state.abort=null;}
  });
  $('rt-upload-submit').onclick=async()=>{
    if(state.busy||state.uppy!==instance)return;
    if(!instance.getFiles().length){$('rt-upload-status').textContent='请先选择简历';return;}
    setBusy(true);$('rt-upload-status').textContent='正在上传';
    try{if(instance.getFiles().some(f=>f.error))await instance.retryAll();else await instance.upload();
      if(epoch!==state.epoch||state.uppy!==instance)return;
      if(uploaded){await refreshSelected(c.id,epoch);$('rt-upload-status').textContent='简历已保存';}
    }catch(error){if(epoch===state.epoch)$('rt-upload-status').textContent=error.message;}
    finally{if(epoch===state.epoch)setBusy(false);}
  };
}
async function downloadResume(c){
  if(state.busy||!c?.resume)return;const epoch=state.epoch;setBusy(true);
  try{status('正在下载简历');const blob=await session.download('candidates/'+c.id+'/resume');if(epoch!==state.epoch)return;await saveResumeFile(blob,c.resume.filename,{embedded:session.embedded,current:()=>epoch===state.epoch,onStatus:status});if(epoch===state.epoch)status('已发起简历下载，请查看客户端保存窗口或下载列表');}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
const actionTitles={reschedule:'发起面试改期',send_receipt:'检查并发送投递回执',assign_interviewer:'分配飞书面试官',return_interview:'退回面试安排',prepare_outcome:'结果邮件预览',send_outcome:'确认决定并发送结果邮件',create:'新建候选人',screen:'完成初筛',assessment:'记录考核结果',schedule:'安排面试',interview:'记录面试反馈',accept:'确认录取',reject:'结束为未通过',archive:'归档候选人',prepare_notice:'审核面试安排',send_notice:'审核并发送面试邀请',confirm_forward:'确认简历转送',sync_feishu:'确认飞书联动',retry_delivery:'重试投递',resolve_delivery:'核实投递结果',settings:'邮箱设置',templates:'邮件模板'};
function field(name,label,{type='text',value='',required=true,maxLength=2000,placeholder='',min,max}={}){
  const wrap=el('label','rt-field'),input=el(type==='textarea'?'textarea':'input');input.name=name;if(type!=='textarea')input.type=type;input.value=value;input.required=required;input.maxLength=maxLength;input.placeholder=placeholder;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
function openForm(action,values={}){
  if(state.busy||!canManage(state.profile))return;
  const c=state.selected;if(!['create','settings','templates'].includes(action)&&(!c||c.archived&&action!=='resolve_delivery'))return;
  state.form={action,values,id:['create','settings','templates'].includes(action)?null:c.id,revision:c?.revision,request:null};
  const fields=$('rt-form-fields');fields.oninput=null;fields.replaceChildren();$('rt-form-error').hidden=true;
  $('rt-form-dialog').classList.toggle('rt-mail-form',['templates','prepare_notice','prepare_outcome','send_notice','send_outcome','send_receipt'].includes(action));
  $('rt-form-title').textContent=actionTitles[action];$('rt-form-submit').textContent=({create:'建立候选人',screen:'通过初筛',assessment:'保存考核结果',assign_interviewer:'分配并通知面试官',return_interview:'退回并通知',reschedule:'发起改期并通知',prepare_notice:'下一步：检查发送内容',prepare_outcome:'下一步：检查结果通知',send_notice:'批准安排并发送邀请',send_outcome:'确认决定并发送通知',send_receipt:'发送投递回执',settings:'保存设置'})[action]||'保存';
  $('rw-form-step').textContent=['prepare_notice','prepare_outcome'].includes(action)?'1 / 2 · 核对信息':['send_notice','send_outcome'].includes(action)?'2 / 2 · 确认发送':'';
  const intro=text=>fields.append(el('p','rt-form-intro',text));
  if(action==='create'){
    field('name','姓名',{maxLength:80,placeholder:'候选人姓名'});
    const group=field('group','应聘组别',{maxLength:60,placeholder:'选择或填写组别'});group.setAttribute('list','rt-group-options');
    const options=el('datalist');options.id='rt-group-options';options.append(...[...new Set(['产品组','开发组','测试运维组',...state.items.map(v=>v.group)])].map(v=>new Option(v,v)));fields.append(options);
    field('email','联系邮箱',{type:'email',maxLength:254,placeholder:'name@example.com'});
    intro('姓名和邮箱用于投递与招新联系');
    field('summary','简历摘要',{type:'textarea',required:false,placeholder:'项目经历 专长或希望探索的方向'});
  }else if(action==='screen'){
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.name='assessmentRequired';check.checked=values.assessmentRequired??false;
    wrap.append(check,el('span','','先进入考核'));fields.append(wrap);intro('不勾选时直接进入面试官分配；勾选后需要手工记录考核成绩。');field('note','初筛记录',{type:'textarea',required:false});
  }else if(action==='assessment'||action==='interview'){
    intro(action==='assessment'?'记录考核成绩与评价':'记录本次面试的反馈');field('score','评分',{type:'number',min:0,max:100});field('note','评价记录',{type:'textarea'});
  }else if(action==='assign_interviewer'){void interviewerSelect(state.form);
  }else if(action==='return_interview'||action==='reschedule'){if(action==='reschedule')intro('保留原安排并请面试官重新填写。新安排审核前，不会向候选人发送新邀请。');field('note','修改说明',{type:'textarea',maxLength:2000});
  }else if(action==='prepare_outcome'){field('note','发给候选人的结果说明',{type:'textarea',maxLength:2000,value:c.resultNotification?.outcome===values.outcome?c.resultNotification.decisionNote||'':''});void templateVariables(state.form,values.outcome);
  }else if(action==='schedule'){
    const local=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    field('at','面试时间',{type:'datetime-local',value:c.interview?.at?local(c.interview.at):'',min:local(Date.now()+60000)});
    intro('时间按本机时区 '+Intl.DateTimeFormat().resolvedOptions().timeZone+' 填写');
    field('interviewer','面试官',{value:c.interview?.interviewer||'',maxLength:80,placeholder:'面试官姓名'});field('email','面试官邮箱（候选人回复地址）',{type:'email',maxLength:254,value:c.interview?.email||''});field('contact','面试官联系方式',{maxLength:500,value:c.interview?.contact||''});field('location','地点或会议地址',{value:c.interview?.location||'',maxLength:500});
    if(c.notification)intro('修改安排后 通知需要重新审核');
  }else if(action==='prepare_notice'){
    void templateVariables(state.form);
  }else if(['send_notice','send_outcome','send_receipt','confirm_forward','sync_feishu'].includes(action)){
    const p=values.preview;intro(p.mode==='live'?'确认后将交给发送服务处理':'当前只执行模拟 不对外发送');
    if(action==='sync_feishu')fields.append(el('pre','rt-form-preview',JSON.stringify(p.payload,null,2)));
    else fields.append(el('p','rt-form-intro',`发件人 ${p.payload.from}\n收件人 ${p.payload.to}\n回复地址 ${p.payload.replyTo}`),el('strong','',p.payload.subject));
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.required=true;wrap.append(check,el('span','','我已逐项检查此候选人的收件地址和内容'));fields.append(wrap);
    if(p.payload.html){
      const context=state.form;context.previewReady=false;check.disabled=true;$('rt-form-submit').disabled=true;
      const mount=el('div');fields.insertBefore(mount,wrap);
      void mailPreview(session,p.payload,mount,{strictImages:true}).then(()=>{
        if(state.form!==context)return;context.previewReady=true;check.disabled=state.busy;$('rt-form-submit').disabled=state.busy;
      }).catch(error=>{if(state.form!==context)return;$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message;});
    }else fields.insertBefore(el('pre','rt-form-preview',p.payload.body),wrap);
  }else if(action==='retry_delivery'){const job=c.deliveries.find(d=>d.id===values.deliveryId);intro('仅重试该任务的原始内容 不修改收件人和模板');fields.append(el('pre','rt-form-preview',['feishu','interviewer','hr_intake','hr_feedback_reminder','interviewer_feedback_reminder'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.required=true;wrap.append(check,el('span','','我已检查此候选人的重试内容'));fields.append(wrap);
  }else if(action==='resolve_delivery'){
    selectField('outcome','核实结果',[['not_sent','确认未发送'],['sent','确认服务商已接收']]);field('note','核实依据',{type:'textarea'});
  }else if(action==='settings'){renderSettings(values.settings);
  }  else if(action==='accept'||action==='reject')field('note','决策理由',{type:'textarea'});
  else if(action==='archive')intro('归档后保留资料和操作记录 可在已归档中查看');
  $('rt-form-dialog').showModal();
}
function formPayload(context){
  const data=new FormData($('rt-form')),text=name=>String(data.get(name)||'').trim();
  if(context.action==='create')return {name:text('name'),email:text('email'),group:text('group'),summary:text('summary')};
  const value={revision:context.revision,action:context.action};
  if(context.action==='screen')Object.assign(value,{assessmentRequired:data.has('assessmentRequired'),note:text('note')});
  if(['assessment','interview'].includes(context.action))Object.assign(value,{score:Number(text('score')),note:text('note')});
  if(context.action==='schedule')Object.assign(value,{at:new Date(text('at')).toISOString(),interviewer:text('interviewer'),email:text('email'),contact:text('contact'),location:text('location')});
  if(context.action==='assign_interviewer')value.subject=text('memberSubject');
  if(['return_interview','reschedule'].includes(context.action))value.note=text('note');
  if(['prepare_notice','prepare_outcome'].includes(context.action)){const template=context.templates?.find(t=>t.id===text('templateId'));if(!template)throw new Error('请选择邮件模板');Object.assign(value,{templateId:template.id,templateRevision:template.revision,sender:text('sender'),values:Object.fromEntries(template.variables.map(v=>[v.key,text('variable:'+v.key)]))});}
  if(context.action==='prepare_outcome'){delete value.sender;value.outcome=context.values.outcome;value.note=text('note');}
  if(['send_notice','send_outcome','send_receipt','confirm_forward','sync_feishu'].includes(context.action)){if(context.previewReady===false)throw Error('请等待完整邮件预览加载完成；加载失败时请关闭后重新打开。');value.previewHash=context.values.preview.previewHash;}
  if(['retry_delivery','resolve_delivery'].includes(context.action))value.deliveryId=context.values.deliveryId;
  if(context.action==='resolve_delivery')Object.assign(value,{outcome:text('outcome'),note:text('note')});
  if(context.action==='settings')return settingsPayload(data,context);
  if(['accept','reject'].includes(context.action))value.note=text('note');
  return value;
}
async function refreshSelected(id,epoch){
  try{const latest=await session.request('candidates/'+id);if(epoch!==state.epoch)return;replaceCandidate(latest);if(state.selected?.id===id)renderDetail();}
  catch(error){if(epoch===state.epoch)status(error.message,true);}
}
$('rt-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||!state.form||!$('rt-form').reportValidity())return;
  const context=state.form,epoch=state.epoch;let payload;try{payload=formPayload(context);}catch(e){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;return;}const fingerprint=JSON.stringify(payload);
  if(context.request?.fingerprint!==fingerprint)context.request={fingerprint,id:crypto.randomUUID()};
  setBusy(true);$('rt-form-error').hidden=true;
  try{
    const result=await session.request(['settings','templates'].includes(context.action)?context.action:context.id?'candidates/'+context.id+'/actions':'candidates',{method:'POST',data:{...payload,requestId:context.request.id}});
    if(epoch!==state.epoch)return;
    closeForm(true);if(!['settings','templates'].includes(context.action)){state.selected=result;await refreshSelected(result.id,epoch);if(epoch!==state.epoch)return;applySelection();}
    status(({screen:'初筛已通过',assign_interviewer:'已分配，正在通知面试官',send_notice:'安排已批准，邀请已进入发送队列',send_outcome:'决定已保存，结果通知已进入发送队列',reschedule:'改期已发起，等待面试官重新填写'})[context.action]||'已保存');
    if(['prepare_notice','prepare_outcome'].includes(context.action)){setBusy(false);await previewDelivery(context.action==='prepare_notice'?'interview':'outcome');}
    void loadCandidates();
  }catch(error){
    if(epoch!==state.epoch)return;
    if(error.status===409&&context.id){await refreshSelected(context.id,epoch);if(epoch!==state.epoch)return;$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message+'。本次未提交，填写内容已保留；请复制需要保留的内容，关闭表单后重新检查最新资料。';}
    else{$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message;}
  }finally{if(epoch===state.epoch)setBusy(false);}
});
for(const id of ['rt-login','rt-login-main'])$(id).addEventListener('click',()=>void session.login());
$('rt-logout').addEventListener('click',async()=>{if(state.busy||composeWorkspace?.busy()||templateWorkspace?.busy()||interviewWorkspace?.busy())return;if((composeWorkspace?.dirty()||templateWorkspace?.dirty()||interviewWorkspace?.dirty()||unsavedCandidate().length)&&!confirm('有未保存的内容，确定退出？'))return;try{await session.logout();}catch(error){status(error.message,true);}});
$('rt-refresh').addEventListener('click',()=>{if(unsavedCandidate().length&&!confirm('刷新会放弃未提交的填写内容，继续？'))return;closeForm(true);$('rw-screen-note').value='';state.screenFor=null;state.screenBaseline=null;destroyUpload();status();void session.load();if(state.selected)void refreshSelected(state.selected.id,state.epoch);});
for(const id of ['rt-new','rt-new-empty'])$(id).addEventListener('click',()=>openForm('create'));
$('rt-detail-close').addEventListener('click',()=>closeDetail(false,true));$('rt-detail-done').addEventListener('click',()=>closeDetail(false,true));
for(const id of ['rt-form-close','rt-form-cancel'])$(id).addEventListener('click',()=>closeForm());
$('rt-form-dialog').addEventListener('cancel',event=>{event.preventDefault();closeForm();});
$('rw-tab-all').addEventListener('click',()=>tryFilter({...currentFilter(),tab:'all'}));
$('rw-tab-pending').addEventListener('click',()=>tryFilter({...currentFilter(),tab:'pending'}));
$('rt-active').addEventListener('click',()=>tryFilter({...currentFilter(),archived:false}));
$('rt-archived').addEventListener('click',()=>tryFilter({...currentFilter(),archived:true}));
$('rt-search').addEventListener('input',()=>tryFilter(currentFilter()));
$('rt-group').addEventListener('change',()=>tryFilter(currentFilter()));
$('rt-stage').addEventListener('change',()=>tryFilter(currentFilter()));
$('rt-task').addEventListener('change',()=>tryFilter(currentFilter()));
$('rw-search-form').addEventListener('submit',event=>event.preventDefault());
$('rw-screen-note').addEventListener('input',updateScreenCount);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.busy)void session.load();});
window.addEventListener('message',event=>{if(session.embedded&&event.source===parent&&event.data?.type==='110lab-workspace-activated'&&!state.busy)void session.load();});
setInterval(()=>{if(!document.hidden&&!state.busy&&state.profile){void session.load();if(state.selected&&!$('rt-form-dialog').open&&!state.uppy?.getFiles().length&&!screenDirty()&&state.selected.deliveries?.some(d=>['QUEUED','SENDING','RETRYING'].includes(d.status)))void refreshSelected(state.selected.id,state.epoch);}},10000);
function selectField(name,label,options,value){
  const wrap=el('label','rt-field'),input=el('select');input.name=name;input.append(...options.map(([id,title])=>new Option(title,id)));if(value!==undefined)input.value=value;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
async function previewDelivery(kind){
  if(state.busy||!state.selected)return;const c=state.selected,epoch=state.epoch;setBusy(true);
  try{const preview=await session.request('candidates/'+c.id+'/preview-'+kind);if(epoch!==state.epoch||state.selected?.id!==c.id)return;setBusy(false);openForm(({receipt:'send_receipt',interview:'send_notice',outcome:'send_outcome',application:'confirm_forward',feishu:'sync_feishu'})[kind],{preview});}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
function renderDeliveries(c){
  $('rt-deliveries').replaceChildren(...(c.deliveries||[]).map(job=>{
    const box=el('article','rt-delivery'),head=el('div','rt-section-heading');
    head.append(el('strong','',({interview:'面试邮件',receipt:'投递回执',outcome:'结果邮件',interviewer:'面试官通知',hr_intake:'HR 新投递提醒',hr_feedback_reminder:'HR 面评跟进提醒',interviewer_feedback_reminder:'面试官面评提醒',application:'简历转送',feishu:'历史表格同步'})[job.kind]),el('span','rt-pill',deliveryLabels[job.status]));
    box.append(head,el('p','rt-help',date(job.updatedAt)+(job.payload.recipientName?' · '+job.payload.recipientName:'')+' · '+(job.mode==='live'?'正式任务':'模拟任务')+' · 尝试 '+job.attempts+' 次'),el('p','rt-help','任务 '+job.id+(job.error?' · '+job.error:'')));
    const detail=el('details'),summary=el('summary','','查看已确认内容和处理记录');
    detail.append(summary,el('pre','rt-form-preview',['feishu','interviewer','hr_intake','hr_feedback_reminder','interviewer_feedback_reminder'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));
    for(const e of job.events||[])detail.append(el('p','rt-help',date(e.at)+' · '+(deliveryLabels[e.status]||e.status)+(e.code?' · '+e.code:'')));
    box.append(detail);
    if(!c.archived&&job.kind==='receipt'&&['FAILED','HELD','SIMULATED'].includes(job.status)&&c.deliveries.find(d=>d.kind==='receipt')?.id===job.id)box.append(button('重新预览回执',()=>void previewDelivery('receipt')));
    if(!c.archived&&job.status==='FAILED')box.append(button('检查后重试',()=>openForm('retry_delivery',{deliveryId:job.id})));
    if(job.status==='UNKNOWN')box.append(button('登记核实结果',()=>openForm('resolve_delivery',{deliveryId:job.id})));
    return box;
  }));
  if(!c.deliveries?.length)$('rt-deliveries').append(el('p','rt-help','暂无投递记录'));
}
async function templateVariables(context,kind='interview'){
  const epoch=state.epoch;$('rt-form-submit').disabled=true;
  try{
    const [result,settings]=await Promise.all([session.request('templates'),session.request('settings')]);if(state.form!==context||epoch!==state.epoch)return;
    result.items=result.items.filter(t=>(t.kind||'interview')===kind);context.templates=result.items;
    const c=state.selected,proposal=c.assignment?.proposal||c.interview,previous=kind==='interview'?c.notification:c.resultNotification?.outcome===kind?c.resultNotification:null;
    if(kind==='interview'&&proposal)$('rt-form-fields').append(el('p','rw-callout',c.name+' · '+date(proposal.at)+'\n面试官 '+(proposal.interviewer||c.assignment?.name)+'\n'+proposal.location+'\n回复邮箱 '+proposal.email));
    if(kind==='interview')selectField('sender','发件邮箱',settings.mailboxes.filter(m=>m.enabled).map(m=>[m.address,m.label+' · '+m.address]),previous?.from||settings.sender);
    const selector=selectField('templateId','邮件模板',result.items.map(t=>[t.id,t.name])),container=el('div','rt-form-fields'),preview=el('section','rw-composition-preview'),hint=el('p','rt-help','正在生成预览');
    $('rt-form-fields').append(container,hint,preview);if(result.items.some(t=>t.id===previous?.templateId))selector.value=previous.templateId;let generation=0;
    const update=async()=>{const gen=++generation;try{const p=formPayload(context);delete p.action;delete p.outcome;
      const result=await session.request('candidates/'+context.id+'/actions',{method:'POST',data:{...p,action:'preview_composition',kind}});
      if(state.form!==context||epoch!==state.epoch||gen!==generation)return;const content=el('div');await mailPreview(session,result.payload,content);if(state.form!==context||gen!==generation)return;
      preview.replaceChildren(el('h3','',result.payload.subject),content);hint.textContent='收件人 '+result.payload.to+' · 回复地址 '+result.payload.replyTo;
    }catch(e){if(state.form===context&&gen===generation){preview.replaceChildren();hint.textContent=e.message;}}};
    const queue=()=>{clearTimeout(context.previewTimer);generation++;context.previewTimer=setTimeout(()=>void update(),700);};
    const render=()=>{container.replaceChildren();const t=result.items.find(t=>t.id===selector.value);if(!t)return;
      for(const v of t.variables){const n=field('variable:'+v.key,v.label,{value:previous?.templateId===t.id?(previous.variables?.[v.key]??v.defaultValue):v.defaultValue,required:v.required,maxLength:1000});container.append(n.parentElement);}queue();};
    selector.addEventListener('change',render);$('rt-form-fields').oninput=queue;render();
    if(!result.items.length)throw Error('没有此用途的模板，请先在邮件模板中建立');
  }catch(e){if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}}
  finally{if(state.form===context&&epoch===state.epoch)$('rt-form-submit').disabled=!context.templates?.length;}
}
function renderSettings(s){
  const fields=$('rt-form-fields'),rows=el('div');rows.id='rt-mailbox-rows';
  fields.append(el('p','rt-help','收信地址用于官网投递说明与尚无面试官时的回复地址 发信地址用于招新邮件'),rows);
  const add=(value={address:'',label:'',enabled:true})=>{
    const row=el('div','rt-config-row');
    for(const [key,label]of [['address','邮箱地址'],['label','邮箱名称']]){const n=el('input');n.dataset.key=key;n.type=key==='address'?'email':'text';n.value=value[key];n.placeholder=label;n.setAttribute('aria-label',label);n.required=true;n.maxLength=key==='address'?254:80;row.append(n);}
    const label=el('label','rt-checkbox'),enabled=el('input');enabled.type='checkbox';enabled.dataset.key='enabled';enabled.checked=value.enabled;label.append(enabled,el('span','','启用'));row.append(label,button('移除',()=>row.remove()));rows.append(row);
  };
  for(const m of s.mailboxes)add(m);fields.append(button('添加可用邮箱',()=>{if(rows.children.length<10)add();}));
  field('sender','默认发件邮箱',{type:'email',value:s.sender,maxLength:254});field('recipient','收件邮箱 / 官网投递邮箱',{type:'email',value:s.recipient,maxLength:254});
  fields.append(el('p','rt-help','候选人、面试安排和审核记录保存在工作台 飞书仅发送面试官填写通知'));
  const context=state.form;context.settingsReady=false;$('rt-form-submit').disabled=true;void session.request('templates').then(({items})=>{if(state.form!==context)return;selectField('receiptTemplateId','自动投递回执模板',items.filter(t=>t.kind==='receipt').map(t=>[t.id,t.name]),s.receiptTemplateId||'11011011-0110-4110-8110-110110110111');context.settingsReady=true;$('rt-form-submit').disabled=false;}).catch(e=>{if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}});
}
function settingsPayload(data,context){if(!context.settingsReady)throw Error('请等待回执模板加载完成');return {revision:context.values.settings.revision,mailboxes:[...$('rt-mailbox-rows').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(n=>[n.dataset.key,n.type==='checkbox'?n.checked:n.value.trim()]))),sender:String(data.get('sender')).trim(),recipient:String(data.get('recipient')).trim(),receiptTemplateId:String(data.get('receiptTemplateId')||'11011011-0110-4110-8110-110110110111')};}
for(const [id,action,route] of [['rt-settings','settings','settings']])$(id).addEventListener('click',async()=>{
  if(state.busy)return;const epoch=state.epoch;setBusy(true);
  try{const result=await session.request(route);if(epoch!==state.epoch)return;setBusy(false);openForm(action,{[action]:route==='templates'?result.items:result});}
  catch(e){if(epoch===state.epoch)status(e.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
});
async function interviewerSelect(context){
  const epoch=state.epoch;$('rt-form-submit').disabled=true;
  try{const result=await session.request('members');if(state.form!==context||epoch!==state.epoch)return;
    const search=field('memberSearch','搜索成员',{required:false,placeholder:'姓名或邮箱'}),select=selectField('memberSubject','面试官',[],state.selected?.assignment?.subject);select.required=true;select.className='rt-member-select';
    const render=()=>{const old=select.value,q=search.value.trim().toLowerCase();select.replaceChildren(new Option('请选择飞书成员',''),...result.members.filter(m=>(m.name+' '+m.email).toLowerCase().includes(q)).map(m=>new Option(m.name+(m.email?' · '+m.email:''),m.subject)));if([...select.options].some(o=>o.value===old))select.value=old;};search.addEventListener('input',render);render();
    $('rt-form-fields').append(el('p','rt-help','确认后 招新工作流应用将向所选面试官发送填写入口'));
  }catch(e){if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}}
  finally{if(state.form===context&&epoch===state.epoch)$('rt-form-submit').disabled=false;}
}
function renderDecisions(){
  const root=$('rw-decisions');root.replaceChildren();
  const scope=el('div','rw-filters');
  for(const [value,label] of [[false,'未归档'],[true,'已归档']]){const b=button(label,()=>{state.decisionArchived=value;renderDecisions();},'rt-tab');b.setAttribute('aria-pressed',String(state.decisionArchived===value));scope.append(b);}
  root.append(scope);
  const rows=state.items.filter(c=>['decision','accepted','rejected'].includes(c.stage)&&c.archived===state.decisionArchived);
  if(!rows.length){root.append(el('p','rt-help',state.decisionArchived?'没有已归档的结果记录':'当前没有待决定或已出结果的候选人'));return;}
  const list=el('div','rw-interview-list');
  for(const c of rows){
    const row=el('article','rw-interview-row'),identity=el('div');
    identity.append(el('strong','',c.name),el('p','rt-help',c.group+' · '+c.email));
    const issue=notificationIssue(c);
    row.append(identity,el('span','rt-pill',labels[c.stage]),el('span',issue?'rw-warning':'rt-help',issue||(c.resultNotification?.status==='sent'?'结果已发送':c.resultNotification?.status==='draft'?'结果待确认':'—')),button(candidateTask(c).action,()=>void focusCandidate(c.id)));
    list.append(row);
  }
  root.append(list);
}
async function focusCandidate(id){
  if(state.busy||!canManage(state.profile))return;
  if(state.view!=='candidates'){state.suspendAuto=true;await setView('candidates');state.suspendAuto=false;if(state.view!=='candidates')return;}
  state.userClosed=false;await openCandidate(id);
}
function showMail(tab){
  if(composeWorkspace?.busy()||templateWorkspace?.busy())return;
  state.mailTab=tab;$('rw-notifications').querySelector('.rw-page-heading h2').textContent=tab==='templates'?'邮件模板':'邮件';$('rw-notifications').querySelector('.rw-subnav').hidden=tab==='templates';applyVisibility();
  $('rw-compose').hidden=tab!=='compose';$('rw-templates').hidden=tab!=='templates';$('rw-mail-history').hidden=tab!=='history';
  for(const b of document.querySelectorAll('[data-mail-tab]'))b.setAttribute('aria-pressed',String(b.dataset.mailTab===tab));
}
function showAdmission(tab){
  state.admissionTab=tab;
  $('rw-decisions').hidden=tab!=='decisions';$('rw-offers').hidden=tab!=='offers';
  for(const b of document.querySelectorAll('[data-admission-tab]'))b.setAttribute('aria-pressed',String(b.dataset.admissionTab===tab));
  if(tab==='decisions')renderDecisions();
}
function showSettings(tab){
  const people=state.profile?.recruitmentCapabilities?.manageHr===true,mail=state.profile?.role==='super_admin';
  if(tab==='people'&&!people)tab='mail';if(tab==='mail'&&!mail)tab='people';
  state.settingsTab=tab;
  $('rw-hr').hidden=tab!=='people';$('rw-mail-settings').hidden=tab!=='mail';
  for(const b of document.querySelectorAll('[data-settings-tab]'))b.setAttribute('aria-pressed',String(b.dataset.settingsTab===tab));
}
async function setView(view){
  if(state.busy||composeWorkspace?.busy()||offerWorkspace?.busy()||templateWorkspace?.busy()||interviewWorkspace?.busy()||roleWorkspace?.busy())return;
  if(!canSee(view))return;
  if(view!==state.view){
    if((composeWorkspace?.dirty()||templateWorkspace?.dirty())&&!confirm('有未保存的邮件或模板。离开并放弃这些修改？'))return;
    if(interviewWorkspace?.dirty()&&!confirm('面试表单有未保存的内容。离开并放弃这些修改？'))return;
    if(!confirmLeave())return;
    closeForm(true);
    composeWorkspace?.destroy();composeWorkspace=null;offerWorkspace?.destroy();offerWorkspace=null;roleWorkspace?.destroy();roleWorkspace=null;templateWorkspace?.destroy();templateWorkspace=null;interviewWorkspace?.destroy();interviewWorkspace=null;
    $('rw-templates').replaceChildren();$('rw-interview-list').replaceChildren();$('rw-offers').replaceChildren();$('rw-hr').replaceChildren();$('rw-compose').replaceChildren();$('rw-mail-history').replaceChildren();
    closeDetail(true);state.view=view;$('rt-main').scrollTop=0;window.scrollTo({top:0,behavior:'instant'});
  }
  applyVisibility();status();
  if(view==='candidates')await loadCandidates();
  if(view==='interviews'){if(!interviewWorkspace){interviewWorkspace=createInterviewWorkspace({session,root:$('rw-interview-list'),route:'my-interviews',onStatus:status});await interviewWorkspace.load();}}
  if(view==='admission'){showAdmission(state.admissionTab||'decisions');if(state.admissionTab==='offers'&&!offerWorkspace){offerWorkspace=createOfferWorkspace({session,root:$('rw-offers'),onStatus:status});await offerWorkspace.load();}}
  if(view==='notifications'){
    showMail(state.mailTab||'compose');
    if(!composeWorkspace){composeWorkspace=createComposeWorkspace({session,root:$('rw-compose'),historyRoot:$('rw-mail-history'),headless:true,onStatus:status,candidates:()=>state.items});await composeWorkspace.load();}
    if(!templateWorkspace){templateWorkspace=createTemplateWorkspace({session,root:$('rw-templates'),onStatus:status});await templateWorkspace.load();}
  }
  if(view==='settings'){showSettings(state.settingsTab||'people');if(state.profile?.recruitmentCapabilities?.manageHr&&!roleWorkspace){roleWorkspace=createRecruitmentRoleWorkspace({session,root:$('rw-hr'),onStatus:status});await roleWorkspace.load();}}
}
for(const b of document.querySelectorAll('.rw-sidebar [data-view]'))b.addEventListener('click',()=>{if(state.busy||composeWorkspace?.busy()||templateWorkspace?.busy())return;if(b.dataset.view==='notifications')state.mailTab=b.dataset.mailView||'compose';void setView(b.dataset.view);});
for(const b of document.querySelectorAll('[data-detail-tab]'))b.addEventListener('click',()=>{state.detailTab=b.dataset.detailTab;for(const item of document.querySelectorAll('[data-detail-tab]'))item.setAttribute('aria-pressed',String(item===b));for(const panel of document.querySelectorAll('[data-detail-panel]'))panel.hidden=panel.dataset.detailPanel!==state.detailTab;applySelection();});
for(const b of document.querySelectorAll('[data-mail-tab]'))b.addEventListener('click',()=>showMail(b.dataset.mailTab));
for(const b of document.querySelectorAll('[data-admission-tab]'))b.addEventListener('click',async()=>{if(offerWorkspace?.busy())return;showAdmission(b.dataset.admissionTab);if(b.dataset.admissionTab==='offers'&&!offerWorkspace){offerWorkspace=createOfferWorkspace({session,root:$('rw-offers'),onStatus:status});await offerWorkspace.load();}});
for(const b of document.querySelectorAll('[data-settings-tab]'))b.addEventListener('click',()=>showSettings(b.dataset.settingsTab));
$('rw-interviews-refresh').onclick=()=>{if(interviewWorkspace?.busy())return;if(!interviewWorkspace?.dirty()||confirm('刷新会放弃未提交的填写内容，继续？'))void interviewWorkspace?.load(true);};
for(const [id,step] of [['rw-previous',-1],['rw-next',1]])$(id).onclick=()=>{const index=state.filtered.findIndex(c=>c.id===state.selected?.id);const c=state.filtered[index+step];if(c){state.userClosed=false;void openCandidate(c.id);}};
window.addEventListener('beforeunload',e=>{if(composeWorkspace?.busy()||composeWorkspace?.dirty()||templateWorkspace?.dirty()||interviewWorkspace?.dirty()||unsavedCandidate().length){e.preventDefault();e.returnValue='';}});
function previewResume(c){
  const id=c.id,epoch=state.epoch;
  resumePreview.show(c,{load:()=>session.download('candidates/'+id+'/resume'),current:()=>epoch===state.epoch&&state.selected?.id===id});
}
function applySidebar(collapsed){
  $('rw-shell').classList.toggle('is-collapsed',collapsed);
  const control=$('rw-collapse');
  control.setAttribute('aria-expanded',String(!collapsed));
  control.setAttribute('aria-label',collapsed?'展开侧栏':'收起侧栏');
  control.querySelector('img').src='/assets/icons/layout-sidebar-left-'+(collapsed?'expand':'collapse')+'.svg';
}
try{applySidebar(localStorage.getItem(sidebarKey)==='1');}catch{applySidebar(false);}
$('rw-collapse').addEventListener('click',()=>{const collapsed=!$('rw-shell').classList.contains('is-collapsed');applySidebar(collapsed);try{localStorage.setItem(sidebarKey,collapsed?'1':'0');}catch{}});
$('rw-filter-toggle').addEventListener('click',()=>{const open=$('rw-candidate-filters').hidden;$('rw-candidate-filters').hidden=!open;$('rw-filter-toggle').setAttribute('aria-expanded',String(open));});
void session.load();

initCoBuildBrand(document);
