import {restoreLabSession} from './persistent-login.js';
// 110lab workspace frontend. Entry: initWorkspace(). No deps, textContent only.
const PATHNAME = typeof location !== 'undefined' ? String(location.pathname || '') : '';
const PROJECTS_PAGE = PATHNAME === '/projects/' || PATHNAME === '/projects' || PATHNAME === '/projects/embedded'
  || PATHNAME.endsWith('/projects') || PATHNAME.endsWith('/projects/embedded');
const EMBEDDED = PATHNAME === '/workbench/embedded' || PATHNAME.endsWith('/workbench/embedded')
  || PATHNAME === '/projects/embedded' || PATHNAME.endsWith('/projects/embedded');
const MAIL_PREFIX = '/api/mail/' + (EMBEDDED ? 'embedded/' : '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const suiteModule=id=>!globalThis.__COBUILD__||globalThis.__COBUILD__.modules.includes(id);
const DELIVERY_LABEL={RECEIVED:'已接收',SENDING:'发送中',RETRYING:'重试中',SENT:'已发送',FAILED:'发送失败',UNKNOWN:'发送结果待核实',EXPIRED:'文件已到保留期限'};
const PREFIX = '/api/workspace/' + (EMBEDDED ? 'embedded/' : '');
const ROLE_LABEL = globalThis.__COBUILD__?{super_admin:'组织所有者',admin:'组织管理员',member:'成员'}:{ super_admin: '实验室超级管理员', admin: '实验室管理员', member: '实验室成员' };
const PHASE_LABEL = { exploring: '探索中', pending: '审核中', active: '进行中', needs_changes: '需修改' };
const PHASE_BADGE = { exploring: 'ws-badge-indigo', pending: 'ws-badge-amber', active: 'ws-badge-teal', needs_changes: 'ws-badge-rose' };
const PROJECT_FILTERS = { active: 1, mine: 1, archived: 1 };
const TODO_FILTERS = { all: 1, assigned: 1, reviews: 1, recruitment: 1 };
const TODO_KIND_LABEL = { project_transfer:'负责人转让', honor:'荣誉审核', milestone: '里程碑', project_review: '项目审核', project_revision: '项目修改', recruitment: '招新', requirement: '需求' };

const state = {
  profile: null, csrf: '', members: [], projects: [], todos: [], todoSources: null,
  requirements: null, requirementsStandaloneHint: false,
  todoFilter: 'all', projectFilter: 'active',
  selectedTodoKey: null, selectedProjectId: null,
  generation: 0, busy: false, dialogOpen: false, reqRequestId: null, reqTimer: null,
  // Enterprise directory metadata. Preserved across searches and refreshes so a
  // transient directory failure never clears the already picked members list.
  membersSource: '', membersUnavailable: false, membersLoaded: false, membersLoading: false, membersError: '',
  pendingProjectId: null, projectView: 'overview', overview: null,
};
// Picker local state for the currently open project dialog.
const projectPicker = { profiles:new Map(), selected: new Set(), search: '', ownerSubject: '' };
let activeDialog = null, activeDialogContext = null;

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
  return n;
}
const setHidden = (node, hidden) => { if (node) node.hidden = !!hidden; };
const clear = (node) => { if (node) node.replaceChildren(); };
const sameUser = (subject) => !!(state.profile && subject && state.profile.subject === subject);
const isAdminLike = () => !!(state.profile && (state.profile.role === 'admin' || state.profile.role === 'super_admin'));
const isSuperAdmin = () => !!(state.profile && state.profile.role === 'super_admin');

function isSafeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try { const u=new URL(value);return value.length<=2000&&(u.protocol==='https:'||globalThis.__COBUILD__&&[location.origin,...Object.values(globalThis.__COBUILD__.catalog.systems)].some(v=>{try{return new URL(v).origin===u.origin;}catch{return false;}}))&&!u.username&&!u.password&&!/[\u0000-\u0020\u007f]/.test(value); } catch { return false; }
}
function isGithubRepoUrl(value) {
  if (!isSafeHttpsUrl(value)) return false;
  try {
    const u = new URL(value);
    if (u.hostname !== 'github.com') return false;
    const parts = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].replace(/\.git$/, '').length > 0;
  } catch { return false; }
}
function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDateOnly(value) {
  if (!value) return '';
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function localDateInputToIsoEndOfDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime())||d.getFullYear()!==Number(m[1])||d.getMonth()+1!==Number(m[2])||d.getDate()!==Number(m[3]) ? null : d.toISOString();
}
function isOverdue(dueAt) {
  if (!dueAt) return false;
  const d = new Date(dueAt);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function setStatus(text, kind) {
  const node = $('ws-status'); if (!node) return;
  node.textContent = text || ''; node.hidden = !text; node.dataset.kind = kind || '';
}

async function api(path, { method = 'GET', data } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let res;
  try {
    res = await fetch((['auth/start','auth/redeem','logout'].includes(path)?MAIL_PREFIX:PREFIX) + path, {
      method, credentials: 'same-origin', headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { throw Object.assign(new Error('网络暂不可用'), { status: 0, cause: e }); }
  let value = null; try { value = await res.json(); } catch { value = null; }
  if (!res.ok) { const err = new Error((value && value.error) || '操作失败'); err.status = res.status; err.data = value; throw err; }
  return value || {};
}

function postToParent(message) {
  if (!EMBEDDED || typeof window === 'undefined' || window.parent === window) return false;
  try { window.parent.postMessage(message, '*'); return true; } catch { return false; }
}
function openExternal(url) {
  if (!isSafeHttpsUrl(url)) return;
  if (EMBEDDED && postToParent({ type: '110lab-workspace-open-link', url })) return;
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
}
function openApp(id) {
  if(globalThis.__COBUILD__){if(globalThis.__COBUILD__.catalog.apps.some(a=>a.id===id))location.assign('/apps/enter/'+id);return;}
  if (!['public-mail', 'assessment', 'requirements', 'organization'].includes(id)) return;
  if (EMBEDDED) postToParent({ type: '110lab-workspace-open-app', id });
  else if(id==='organization')location.assign('/apps/enter/organization');
  else openExternal({
    'public-mail':'https://internal.110-lab.cn/mail',assessment:'https://47.109.176.127',requirements:'https://makit.110-lab.cn'
  }[id]);
}
// Navigate to a project by id. Projects now live on their own application page
// so the standalone workbench and embedded host both route through /projects.
function navigateToProject(projectId) {
  if (!isUuid(projectId)) return;
  if (PROJECTS_PAGE) {
    selectProject(projectId);
    return;
  }
  if (EMBEDDED) { postToParent({ type: '110lab-workspace-open-app', id: 'projects', projectId }); return; }
  try { location.assign('/projects?project=' + encodeURIComponent(projectId)); } catch { /* ignore */ }
}

// Only navigation state belongs in the URL; form drafts stay in the dialog.
function writeProjectRoute({replace=false}={}) {
  if(!PROJECTS_PAGE)return;
  const params=new URLSearchParams(location.search);
  const id=state.pendingProjectId||state.selectedProjectId;
  if(id)params.set('project',id);else params.delete('project');
  if(['manage','access'].includes(state.projectView))params.set('view',state.projectView);else params.delete('view');
  if(state.projectFilter!=='active')params.set('filter',state.projectFilter);else params.delete('filter');
  const next=location.pathname+(params.size?'?'+params:'')+(location.hash||'');
  if(next!==location.pathname+location.search+(location.hash||''))
    window.history?.[replace?'replaceState':'pushState'](null,'',next);
}
function readProjectRoute() {
  if(!PROJECTS_PAGE)return;
  const params=new URLSearchParams(location.search),id=params.get('project'),filter=params.get('filter');
  state.projectView=['manage','access'].includes(params.get('view'))?params.get('view'):'overview';
  state.projectFilter=Object.hasOwn(PROJECT_FILTERS,filter)?filter:'active';
  state.pendingProjectId=isUuid(id)?id:null;
  state.selectedProjectId=null;
}
function reconcileProjectSelection() {
  const requested=state.pendingProjectId||state.selectedProjectId;
  const project=state.projects.find(p=>p.id===requested);
  if(project){
    state.selectedProjectId=project.id;state.pendingProjectId=null;
    if(!filteredProjects().some(p=>p.id===project.id))state.projectFilter=project.archived?'archived':'active';
  } else {
    // Retain the requested ID, never silently show an unrelated project.
    state.pendingProjectId=requested;state.selectedProjectId=null;
  }
}
function selectProject(id) {
  state.pendingProjectId=id;state.selectedProjectId=null;
  reconcileProjectSelection();writeProjectRoute();renderProjects();renderProjectSide();
}
function selectProjectFilter(value) {
  if(!Object.hasOwn(PROJECT_FILTERS,value))return;
  state.projectFilter=value;
  if(!filteredProjects().some(p=>p.id===state.selectedProjectId))state.selectedProjectId=null;
  state.pendingProjectId=null;
  writeProjectRoute();renderProjects();renderProjectSide();
}
function discardProjectDialog() {
  if(!activeDialogContext?.project&&!activeDialogContext?.transferProject)return;
  const dlg=activeDialog;closeDialog(dlg);dlg?.querySelector('form')?.reset();
  projectPicker.selected.clear();projectPicker.profiles.clear();
}
function checkProjectDialogAccess() {
  if(activeDialogContext?.transferProject){
    const ctx=activeDialogContext,p=state.projects.find(p=>p.id===ctx.transferProject.id),t=p?.ownershipTransfer;
    const allowed=ctx.transferAction==='start'?t?.canStart:ctx.transferAction==='accept'?t?.current?.canAccept:t?.current?.canCancel;
    if(!allowed||ctx.transferProject.revision!==p?.revision||ctx.transferId&&ctx.transferId!==t?.current?.id){discardProjectDialog();setStatus('项目或转让状态已变更','error');}
    return;
  }
  const previous=activeDialogContext?.project;
  if(!previous)return;
  const current=state.projects.find(p=>p.id===previous.id);
  if(!current||(!sameUser(current.ownerSubject)&&!isAdminLike())){
    discardProjectDialog();setStatus('项目访问或管理权限已变更','error');
  }
}

function toastError(err) {
  if (!err) return;
  if (err.status === 401) {
    clearIdentity();
    setStatus('登录状态已失效 请重新登录', 'error'); return;
  }
  if(err.data?.code==='APP_ACCESS_DENIED'){setStatus(err.message,'error');return;}
  if (err.status === 403) { setStatus('权限已变更 正在刷新', 'error'); void loadSession(); return; }
  if (err.status === 409) { setStatus(err.message+' 请刷新后重试', 'error'); return; }
  setStatus(err.message || '操作失败', 'error');
}

function currentTab() {
  const t = $('ws-tab-todos');
  return t && t.getAttribute('aria-selected') === 'true' ? 'todos' : 'projects';
}
function selectTab(id) {
  const tTodos = $('ws-tab-todos'), tProjects = $('ws-tab-projects');
  if (!tTodos || !tProjects) return;
  tTodos.setAttribute('aria-selected', String(id === 'todos'));
  tProjects.setAttribute('aria-selected', String(id === 'projects'));
  setHidden($('ws-panel-todos'), id !== 'todos');
  setHidden($('ws-panel-projects'), id !== 'projects');
}

function renderShell() {
  if (typeof CustomEvent === 'function' && typeof document.dispatchEvent === 'function') {
    document.dispatchEvent(new CustomEvent('110lab:identity', {detail: state.profile}));
  }
  if($('ws-title'))$('ws-title').textContent=PROJECTS_PAGE?'项目立项':'工作台';
  setHidden($('ws-recruit-history'),!isAdminLike()||!suiteModule('hiflow'));
  const greet = $('ws-greeting'), chip = $('ws-role-chip'), login = $('ws-login'), logout = $('ws-logout');
  const admin = $('ws-admin-settings'), needed = $('ws-login-needed'), perms = $('ws-permissions-hint');
  const tabs = $('ws-tabs'), newBtn = $('ws-project-new');
  const reviewsChip = document.querySelector('[data-todo-filter="reviews"]');
  const recruitChip = document.querySelector('[data-todo-filter="recruitment"]');
  const loginHint = $('ws-login-hint');
  if (!state.profile) {
    setHidden($('ws-account-settings'),true);
    if (greet) greet.textContent = PROJECTS_PAGE ? '项目立项' : '你的项目与协作';
    setHidden(chip, true); setHidden(login, false); setHidden(logout, true); setHidden(admin, true);
    setHidden(needed, false); setHidden(perms, true); setHidden(tabs, true); setHidden(newBtn, true);
    setHidden($('ws-panel-todos'), true); setHidden($('ws-panel-projects'), true);
    setHidden(reviewsChip, true); setHidden(recruitChip, true);
    if (loginHint) {
      loginHint.textContent = PROJECTS_PAGE
        ? '登录后可查看、创建和维护实验室项目。'
        : '登录后可同步你的待办、里程碑和项目变更。';
      loginHint.hidden = false;
    }
    const neededTitle = needed?.querySelector?.('p');
    if (neededTitle) neededTitle.textContent = globalThis.__COBUILD__ ? '登录后查看个人待办与项目空间' : PROJECTS_PAGE
      ? '通过飞书登录 查看和维护实验室项目'
      : '通过飞书登录 查看个人待办和项目空间';
    return;
  }
  setHidden($('ws-account-settings'),!globalThis.__COBUILD__);
  const name = state.profile.name || state.profile.email || '成员';
  if (greet) greet.textContent = PROJECTS_PAGE ? '项目立项' : name+'的工作台';
  if (chip) { chip.textContent = ROLE_LABEL[state.profile.role] || '成员'; chip.dataset.role = state.profile.role || 'member'; chip.hidden = false; }
  setHidden(login, true); setHidden(logout, false); setHidden(admin, !isSuperAdmin()); setHidden(needed, true);
  if (perms) {
    perms.textContent = isSuperAdmin() ? '实验室超级管理员：可管理授权与超管转让。管理员共同处理项目审批、招新与通知邮箱。'
      : isAdminLike() ? '实验室管理员：可处理项目审批、招新待办与通知邮箱事务。'
      : '实验室成员：可创建并维护自己负责的项目。';
    perms.hidden = true;
  }
  // Tabs only make sense on the workbench. The projects page shows a single panel.
  setHidden(tabs, PROJECTS_PAGE);
  setHidden(reviewsChip, !isAdminLike());
  setHidden(recruitChip, !isAdminLike()||!suiteModule('hiflow'));
  if (PROJECTS_PAGE) {
    setHidden($('ws-panel-todos'), true);
    setHidden($('ws-panel-projects'), false);
    setHidden(newBtn, false);
  } else {
    // Workbench no longer shows the project tab or panel; everything project
    // related moved to the standalone projects page.
    setHidden($('ws-tab-projects'), true);
    setHidden($('ws-panel-projects'), true);
    setHidden($('ws-panel-todos'), false);
    setHidden(newBtn, true);
  }
}

function updateCounts() {
  const tCount = $('ws-tab-todos-count'), pCount = $('ws-tab-projects-count');
  const vt = filteredTodos().length, vp = filteredProjects().length;
  if (tCount) { tCount.textContent = vt > 0 ? String(vt) : ''; tCount.hidden = vt === 0; }
  if (pCount) { pCount.textContent = vp > 0 ? String(vp) : ''; pCount.hidden = vp === 0; }
}

function todoKey(item) { return item.kind + ':' + (item.id || ''); }

function filteredTodos() {
  const items = Array.isArray(state.todos) ? state.todos.slice() : [];
  const req = (state.requirements && Array.isArray(state.requirements.items)) ? state.requirements.items : [];
  const all = items.concat(req.map(r => ({
    id: 'req:' + r.id, kind: 'requirement', title: r.title, projectName: r.projectName || '',
    dueAt: r.dueAt || null, status: r.status || '', action: null, url: r.url || null, source: 'requirements',
  })));
  let list;
  if (state.todoFilter === 'assigned') list = all.filter(x => x.kind === 'milestone' || x.kind === 'requirement');
  else if (state.todoFilter === 'reviews') list = all.filter(x => x.kind === 'project_review' || x.kind === 'project_revision' || x.kind === 'honor');
  else if (state.todoFilter === 'recruitment') list = all.filter(x => x.kind === 'recruitment');
  else list = all;
  list.sort((a, b) => {
    const ao = isOverdue(a.dueAt), bo = isOverdue(b.dueAt);
    if (ao !== bo) return ao ? -1 : 1;
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  });
  return list;
}

function filteredProjects() {
  const list = Array.isArray(state.projects) ? state.projects.slice() : [];
  const filtered = state.projectFilter === 'mine' ? list.filter(p => !p.archived && isMemberOrOwner(p))
    : state.projectFilter === 'archived' ? list.filter(p => p.archived)
    : list.filter(p => !p.archived);
  filtered.sort((a, b) => (new Date(b.updatedAt || 0).getTime()) - (new Date(a.updatedAt || 0).getTime()));
  return filtered;
}

function isMemberOrOwner(project) {
  if (!project || !state.profile) return false;
  if (project.ownerSubject === state.profile.subject) return true;
  return (project.members || []).some(m => m.subject === state.profile.subject);
}

function renderTodos() {
  const list = $('ws-todo-list'), empty = $('ws-todo-empty');
  if (!list) return;
  const items = filteredTodos(); clear(list);
  for (const item of items) {
    const li = el('li', 'ws-item');
    li.setAttribute('role', 'button'); li.setAttribute('tabindex', '0');
    const key = todoKey(item);
    if (state.selectedTodoKey === key) li.setAttribute('aria-current', 'true');
    const title = el('div', 'cb-todo-copy');
    title.append(el('span', 'cb-todo-title', item.title || '(无标题)'));
    if (item.projectName || item.group) title.append(el('small', 'cb-todo-subtitle', item.projectName || item.group));
    const kind = el('span', 'cb-todo-kind', TODO_KIND_LABEL[item.kind] || '待办');
    const overdue = isOverdue(item.dueAt);
    const status = item.dueAt ? (overdue ? '逾期 ' : '截止 ') + fmtDateOnly(item.dueAt)
      : item.kind === 'recruitment' ? '邮件' + (DELIVERY_LABEL[item.deliveryStatus] || '待处理')
      : ({open:'待处理',done:'已完成'})[item.status] || item.status || '待处理';
    const action = el('span', 'cb-todo-open', '查看');
    const arrow = el('img'); arrow.src = '/assets/icons/arrow-right.svg'; arrow.alt = ''; action.append(arrow);
    li.append(title, kind, el('span', 'cb-todo-status' + (overdue ? ' is-overdue' : ''), status), action);
    const activate = () => {
      state.selectedTodoKey = key; renderTodos(); renderTodoSide();
      const dialog = $('cb-todo-dialog'); if (dialog && !dialog.open) { try { dialog.showModal(); } catch {} }
    };
    li.onclick = activate;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    list.append(li);
  }
  if (empty) {empty.hidden = items.length > 0;if(empty.id==='ws-todo-empty')empty.textContent='当前没有已加载的待办';}
  updateCounts();
}

function sideRow(label, value) {
  const row = el('p', 'ws-side-row');
  row.append(el('strong', '', label + '：'));
  row.append(document.createTextNode(String(value)));
  return row;
}

function renderTodoSide() {
  const side = $('ws-todo-side'); if (!side) return;
  clear(side);
  const items = filteredTodos();
  const current = items.find(x => todoKey(x) === state.selectedTodoKey);
  if (!current) { if ($('cb-todo-dialog')?.open) closeDialog($('cb-todo-dialog')); return; }
  side.append(el('h3', '', current.title || '(无标题)'));
  const meta = el('div', 'ws-side-meta');
  meta.append(el('span', 'ws-badge ws-badge-indigo', TODO_KIND_LABEL[current.kind] || '待办'));
  if (current.dueAt) {
    const overdue = isOverdue(current.dueAt);
    meta.append(el('span', 'ws-badge ' + (overdue ? 'ws-badge-overdue' : 'ws-badge-amber'), (overdue ? '逾期 ' : '截止 ') + fmtDateOnly(current.dueAt)));
  }
  side.append(meta);
  if (current.projectName) side.append(sideRow('项目', current.projectName));
  if (current.status) side.append(sideRow('状态', ({open:'待处理',done:'已完成'})[current.status]||String(current.status)));
  if(current.kind==='honor'){const btn=el('button','ws-btn ws-btn-primary','打开荣誉登记');btn.type='button';btn.onclick=()=>{if(EMBEDDED)postToParent({type:'110lab-workspace-open-app',id:'honors',honorId:current.honorId});else location.assign('/honors?record='+encodeURIComponent(current.honorId));};side.append(btn);}
  else if (current.kind === 'recruitment') renderRecruitmentDetail(side, current);
  else if (current.kind === 'requirement') renderRequirementDetail(side, current);
  else if (current.kind === 'milestone') renderMilestoneDetail(side, current);
  else if (current.kind === 'project_review' || current.kind === 'project_revision' || current.kind === 'project_transfer') renderProjectTodoDetail(side, current);
}

function renderRecruitmentDetail(side, item) {
  if (item.receivedAt) side.append(sideRow('收件时间', fmtDateTime(item.receivedAt)));
  if (item.deliveryStatus) side.append(sideRow('邮件投递', DELIVERY_LABEL[item.deliveryStatus]||item.deliveryStatus));
  const actions = el('div', 'ws-side-actions');
  const mailBtn = el('button', 'ws-btn ws-btn-ghost', '打开公共邮箱');
  mailBtn.type = 'button'; mailBtn.onclick = () => openApp('public-mail');
  actions.append(mailBtn);
  const handleBtn = el('button', 'ws-btn ws-btn-primary', '标记为已处理');
  handleBtn.type = 'button'; handleBtn.disabled = !isAdminLike();
  handleBtn.onclick = () => openRecruitDialog(item);
  actions.append(handleBtn);
  side.append(actions);
}

function renderRequirementDetail(side, item) {
  if (state.requirements) {
    const src = el('p', 'ws-side-row');
    src.append(el('strong', '', '来源：'));
    src.append(document.createTextNode('Makit · ' + (state.requirements.accountName || '')));
    side.append(src);
  }
  const actions = el('div', 'ws-side-actions');
  if (isSafeHttpsUrl(item.url)) {
    const btn = el('button', 'ws-btn ws-btn-ghost', '在Makit查看');
    btn.type = 'button'; btn.onclick = () => openExternal(item.url);
    actions.append(btn);
  } else if (!EMBEDDED) {
    side.append(el('p', 'ws-side-row', '需求待办在 110lab 插件中同步。'));
  }
  if (actions.children.length > 0) side.append(actions);
}

function renderMilestoneDetail(side, item) {
  const project = state.projects.find(p => p.id === item.projectId);
  const actions = el('div', 'ws-side-actions');
  const openBtn = el('button', 'ws-btn ws-btn-ghost', '查看项目');
  openBtn.type = 'button'; openBtn.disabled = !isUuid(item.projectId);
  openBtn.onclick = () => { if(item.kind==='project_transfer'&&globalThis.__COBUILD__)location.assign('/projects?view=access&project='+encodeURIComponent(item.projectId));else navigateToProject(item.projectId); };
  actions.append(openBtn);
  if (item.milestoneId && project) {
    const ms = (project.milestones || []).find(m => m.id === item.milestoneId);
    if (ms && ms.status !== 'done') {
      const canFinish = ms.canChange === true;
      const btn = el('button', 'ws-btn ws-btn-primary', '完成');
      btn.type = 'button'; btn.disabled = !canFinish;
      btn.onclick = () => openMsDoneDialog(project, ms);
      actions.append(btn);
    }
  }
  side.append(actions);
}

function renderProjectTodoDetail(side, item) {
  const actions = el('div', 'ws-side-actions');
  const openBtn = el('button', 'ws-btn ws-btn-primary', '打开项目');
  openBtn.type = 'button'; openBtn.disabled = !isUuid(item.projectId);
  openBtn.onclick = () => { if(item.kind==='project_transfer'&&globalThis.__COBUILD__)location.assign('/projects?view=access&project='+encodeURIComponent(item.projectId));else navigateToProject(item.projectId); };
  actions.append(openBtn);
  side.append(actions);
}

function renderProjects() {
  const list = $('ws-project-list'), empty = $('ws-project-empty');
  if (!list) return;
  for(const chip of document.querySelectorAll('[data-project-filter]'))chip.setAttribute('aria-pressed',String(chip.dataset.projectFilter===state.projectFilter));
  const focusedId=document.activeElement?.closest?.('#ws-project-list .ws-item')?.dataset.projectId;
  const items = filteredProjects(); clear(list);
  for (const p of items) {
    const li = el('li', 'ws-item');
    li.dataset.projectId=p.id;
    li.setAttribute('role', 'button'); li.setAttribute('tabindex', '0');
    if (state.selectedProjectId === p.id) li.setAttribute('aria-current', 'true');
    const row = el('div', 'ws-item-row');
    row.append(el('div', 'ws-item-title', p.name || '(未命名)'));
    row.append(el('span', 'ws-badge ' + (PHASE_BADGE[p.phase] || 'ws-badge-indigo'), p.unconfigured?'待完善':PHASE_LABEL[p.phase] || p.phase || ''));
    li.append(row);
    const meta = el('div', 'ws-item-meta');
    const ownerName = p.ownerName || p.ownerEmail || p.ownerSubject || '';
    if (ownerName) meta.append(el('span', '', '负责人 ' + ownerName));
    const memberCount = (p.members?.length||0)+(p.ownerSubject?1:0);
    meta.append(el('span', '', '· 共 ' + memberCount + ' 人'));
    if (p.archived) meta.append(el('span', 'ws-badge', '已归档'));
    li.append(meta);
    const activate = () => selectProject(p.id);
    li.onclick = activate;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    list.append(li);
    if(focusedId===p.id)li.focus?.({preventScroll:true});
  }
  if (empty) {empty.hidden = items.length > 0;if(empty.id==='ws-todo-empty')empty.textContent='当前没有已加载的待办';}
  updateCounts();
}

function renderProjectSide() {
  const side = $('ws-project-side'); if (!side) return;
  clear(side);
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) { state.overview=null;overviewRead++;side.append(el('p', 'ws-side-hint', state.pendingProjectId?'项目不存在或当前无权访问。':'选择左侧项目查看详情。')); return; }
  side.append(el('h3', '', project.name || '(未命名)'));
  const meta = el('div', 'ws-side-meta');
  meta.append(el('span', 'ws-badge ' + (PHASE_BADGE[project.phase] || 'ws-badge-indigo'), project.unconfigured?'待完善':PHASE_LABEL[project.phase] || project.phase || ''));
  if (project.archived) meta.append(el('span', 'ws-badge', '已归档'));
  side.append(meta);
  if(globalThis.__COBUILD__){
    const tabs=el('nav','ws-overview-tabs');tabs.setAttribute('aria-label','项目视图');
    for(const [value,label] of [['overview','概览'],['access','成员与权限'],['manage','管理']]){
      const b=el('button','ws-btn ws-btn-ghost',label);b.type='button';b.dataset.projectView=value;
      b.setAttribute('aria-pressed',String(state.projectView===value));
      b.onclick=()=>{state.projectView=value;writeProjectRoute();renderProjectSide();
        $('ws-project-side')?.querySelector('[data-project-view="'+value+'"]')?.focus({preventScroll:true});};
      tabs.append(b);
    }
    side.append(tabs);
    if(state.projectView==='overview'){renderProjectOverview(side,project);return;}
    if(state.projectView==='access'){renderProjectAccess(side,project);return;}
  }
  if (project.summary) side.append(el('p', 'ws-side-row', project.summary));
  const ownerName = project.ownerName || project.ownerEmail || project.ownerSubject || '';
  if (ownerName) side.append(sideRow('负责人', ownerName));
  if (Array.isArray(project.members) && project.members.length > 0) {
    const names = project.members.map(m => m.name || m.email || m.subject).filter(Boolean).join('、');
    if (names) side.append(sideRow('成员', names));
  }
  if (project.application) side.append(sideRow('立项说明', project.application));
  if (project.reviewNote) side.append(sideRow('审核备注', project.reviewNote));
  const linkEntries = [];
  if (project.links) {
    if (project.links.repository && isGithubRepoUrl(project.links.repository)) linkEntries.push(['代码仓库', project.links.repository]);
    if (project.links.requirements && isSafeHttpsUrl(project.links.requirements)) linkEntries.push(['需求', project.links.requirements]);
    if (project.links.docs && isSafeHttpsUrl(project.links.docs)) linkEntries.push(['文档', project.links.docs]);
    if (project.links.knowledgeSpace && isSafeHttpsUrl(project.links.knowledgeSpace)) linkEntries.push(['WeKnow 空间', project.links.knowledgeSpace]);
    if (project.links.demo && isSafeHttpsUrl(project.links.demo)) linkEntries.push(['演示', project.links.demo]);
  }
  if (linkEntries.length > 0) {
    side.append(el('h4', '', '链接'));
    const ul = el('ul', 'ws-link-list');
    for (const [label, url] of linkEntries) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = label; a.href = url; a.rel = 'noopener noreferrer'; a.target = '_blank';
      a.onclick = (e) => { if (EMBEDDED) { e.preventDefault(); openExternal(url); } };
      li.append(a); ul.append(li);
    }
    side.append(ul);
  }
  if(project.unconfigured){
    side.append(el('p','ws-side-hint','来自Makit的项目分类，尚未完善立项信息。'));
    const button=el('button','ws-btn ws-btn-primary','完善立项');button.type='button';
    button.onclick=()=>openProjectDialog(project);side.append(button);return;
  }
  renderProjectSync(side, project);
  renderKnowledgeSync(side, project);
  renderMilestones(side, project);
  renderProjectActions(side, project);
}

// Lightweight read-only view: Kick data renders immediately; Makit has its own bounded read.
let overviewRead=0;
function overviewLink(parent,label,url) {
  if(!isSafeHttpsUrl(url))return;
  const a=el('a','ws-btn ws-btn-ghost',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);
}
function overviewSection(parent,title) {
  const section=el('section','ws-overview-section');section.append(el('h4','',title));parent.append(section);return section;
}
function renderProjectOverview(side,p) {
  const root=el('div','ws-overview');root.id='ws-project-overview';side.append(root);
  const goal=overviewSection(root,'项目目标');
  goal.append(el('p','ws-side-row',p.summary||'尚未填写项目目标'));
  goal.append(sideRow('负责人',p.ownerName||'尚未指定'));
  if(p.phase==='pending')goal.append(el('p','ws-overview-notice','待管理员审批立项'));
  if(p.phase==='needs_changes')goal.append(el('p','ws-overview-notice',p.reviewNote||'立项需修改'));
  if(p.archived)goal.append(el('p','ws-overview-notice','项目已归档'));
  const milestones=overviewSection(root,'里程碑');
  const list=[...(p.milestones||[])].sort((a,b)=>(a.status==='done')-(b.status==='done')||
    (Date.parse(a.dueAt)||Infinity)-(Date.parse(b.dueAt)||Infinity));
  const done=list.filter(m=>m.status==='done').length;
  milestones.append(el('p','ws-overview-summary',list.length?done+' / '+list.length+' 已完成':'尚无里程碑'));
  const ul=el('ul','ws-overview-milestones');
  for(const m of list.slice(0,4)){
    const item=el('li','');item.append(el('span','',m.title));
    const overdue=m.status!=='done'&&isOverdue(m.dueAt);
    item.append(el('span',overdue?'ws-overview-warning':'',m.status==='done'?'已完成':(overdue?'逾期 · ':'')+(fmtDateOnly(m.dueAt)||'未设日期')));ul.append(item);
  }
  milestones.append(ul);
  if(list.length>4)milestones.append(el('p','ws-side-hint','另有 '+(list.length-4)+' 项，可在管理中查看'));
  const requirements=overviewSection(root,'需求进展');requirements.id='ws-overview-requirements';
  renderOverviewRequirements(requirements,p);
  const knowledge=overviewSection(root,'知识空间');
  const sync=p.knowledgeSpace;
  const labels={awaiting_approval:'待立项审批后创建',queued:'等待同步',working:'正在同步',retrying:'同步未完成，将自动重试',blocked:'同步需要处理',ready:'空间已关联',archived:'项目已归档，空间访问暂停',legacy:'已关联既有空间'};
  knowledge.append(el('p','',!suiteModule('weknow')?'WeKnow 未启用':labels[sync?.state]||(p.links?.knowledgeSpace?'已关联既有空间':'尚未关联空间')));
  if(suiteModule('weknow'))overviewLink(knowledge,'打开 WeKnow 空间',sync?.url||p.links?.knowledgeSpace);
  if(sync?.updatedAt)knowledge.append(el('p','ws-side-hint','同步状态更新于 '+fmtDateTime(sync.updatedAt)));
  if(sync?.url||p.links?.knowledgeSpace)knowledge.append(el('p','ws-side-hint','访问权限由 WeKnow 核对'));
  const projection=p.requirementsSync;
  if(projection&&['queued','syncing','retrying','blocked'].includes(projection.state)){
    const status=overviewSection(root,'项目同步');status.append(el('p','ws-overview-notice',
      ['retrying','blocked'].includes(projection.state)?'Makit 项目信息同步未完成':'Makit 项目信息同步中'));
  }
}
function renderOverviewRequirements(node,p) {
  const restoreRefreshFocus=node.contains(document.activeElement)&&document.activeElement?.hasAttribute('data-overview-refresh');
  clear(node);node.append(el('h4','','需求进展'));
  const result=state.overview?.projectId===p.id?state.overview:null;
  const labels={loading:'正在读取需求进展…',disabled:'Makit 未启用',restricted:'无权读取 Makit 需求',not_connected:'请先打开 Makit 完成连接',not_synced:'项目尚未同步到 Makit',conflict:'项目名称关联存在冲突，请在管理中核对',unavailable:'需求进展暂时无法读取'};
  const status=!suiteModule('makit')?'disabled':result?.state||'loading';
  node.setAttribute('aria-busy',String(status==='loading'));
  if(status==='ready'){
    if(result.stale)node.append(el('p','ws-overview-notice','当前显示缓存数据'));
    const dl=el('dl','ws-overview-stats');
    for(const [key,label] of [['total','需求总数'],['inProgress','进行中'],['completed','已完成'],['blocked','阻塞'],['overdue','逾期']]){
      const item=el('div','');item.append(el('dt','',label),el('dd','',result.counts[key]));dl.append(item);
    }
    node.append(dl,el('p','ws-side-hint','数据更新于 '+fmtDateTime(result.fetchedAt)+' · 不含已归档需求'));
  }else {const message=el('p',status==='unavailable'?'ws-overview-warning':'',labels[status]||labels.unavailable);message.setAttribute('role','status');node.append(message);}
  if(status!=='disabled'){
    const actions=el('div','ws-overview-actions');
    const reload=el('button','ws-btn ws-btn-ghost','刷新需求进展');reload.type='button';reload.dataset.overviewRefresh='';
    reload.setAttribute('aria-disabled',String(status==='loading'));
    reload.onclick=()=>{if(status!=='loading')void loadOverviewRequirements(p);};actions.append(reload);
    const origin=globalThis.__COBUILD__?.catalog?.systems?.requirements;
    // Use the configured Makit origin and stable project ID, never a guessed name link.
    if(origin)overviewLink(actions,'打开 Makit 项目',origin.replace(/\/$/,'')+'/projects?project='+encodeURIComponent(p.id));
    node.append(actions);
    if(restoreRefreshFocus)reload.focus({preventScroll:true});
  }
  if(status==='loading'&&!result)void loadOverviewRequirements(p);
}
async function loadOverviewRequirements(p) {
  const serial=++overviewRead,epoch=state.generation;
  state.overview={projectId:p.id,state:'loading'};
  const render=()=>{const node=$('ws-overview-requirements');if(node&&state.selectedProjectId===p.id&&state.projectView==='overview')renderOverviewRequirements(node,p);};
  render();
  try{
    const result=await api('projects/'+p.id+'/overview/requirements');
    if(serial!==overviewRead||epoch!==state.generation||!state.profile||state.selectedProjectId!==p.id)return;
    state.overview={...result,projectId:p.id};
  }catch(e){
    if(serial!==overviewRead||epoch!==state.generation||!state.profile||state.selectedProjectId!==p.id)return;
    if(e.status===401){clearIdentity();return;}
    if(e.status===403){state.projects=[];state.overview=null;state.pendingProjectId=p.id;state.selectedProjectId=null;discardProjectDialog();renderProjects();renderProjectSide();return;}
    state.overview={projectId:p.id,state:'unavailable'};
  }
  render();
}

function renderProjectSync(side, project) {
  const sync = project.requirementsSync;
  if (!sync) return;
  const labels = { queued: '等待同步', syncing: '正在同步', retrying: '同步暂未完成，将自动重试', blocked: '同步未完成', synced: project.archived ? '已归档 · 需求保留' : '已同步' };
  side.append(sideRow('Makit', labels[sync.state] || '同步未完成'));
  if (sync.state === 'synced' && sync.url && sync.url !== project.links?.requirements && isSafeHttpsUrl(sync.url)) {
    const a = el('a', 'ws-btn ws-btn-ghost', '查看项目需求');
    a.href = sync.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.onclick = e => { if (EMBEDDED) { e.preventDefault(); openExternal(sync.url); } };
    side.append(a);
  }
  if (['retrying','blocked'].includes(sync.state) && (sameUser(project.ownerSubject) || isAdminLike())) {
    const button = el('button', 'ws-btn ws-btn-ghost', '重新同步'); button.type = 'button'; button.disabled = state.busy;
    button.onclick = async () => {
      if (state.busy) return;
      state.busy = true; button.disabled = true;
      try { await api('projects/' + project.id + '/requirements-sync/retry', { method: 'POST', data: {} }); await loadProjects(); }
      catch (e) { toastError(e); }
      finally { state.busy = false; renderProjectSide(); }
    };
    side.append(button);
  }
}

function renderKnowledgeSync(side,project) {
  const sync=project.knowledgeSpace;
  if(!sync){if(project.links?.knowledgeSpace)side.append(sideRow('WeKnow','手工关联 · 沿用空间原有权限'));return;}
  const labels={awaiting_approval:'等待立项审批',queued:'等待同步',working:'正在同步',retrying:'暂未完成，将自动重试',blocked:'需要处理',ready:'已同步',archived:'已归档 · 空间访问暂停',legacy:'已关联 · 沿用空间原有权限'};
  side.append(sideRow('WeKnow',labels[sync.state]||'状态待确认'));
  if(sync.errorCode==='KNOWLEDGE_RECONNECT_REQUIRED')side.append(el('p','ws-error','WeKnow 授权连接已失效，请联系管理员重新连接后重试'));
  if(sync.errorCode==='KNOWLEDGE_NAME_CONFLICT')side.append(el('p','ws-error','空间名称已单独修改。请在 WeKnow 将名称对齐为当前项目名，再重试同步。'));
  if(sync.url&&sync.url!==project.links?.knowledgeSpace&&isSafeHttpsUrl(sync.url)){
    const a=el('a','ws-btn ws-btn-ghost','打开关联空间');a.href=sync.url;a.target='_blank';a.rel='noopener noreferrer';
    a.onclick=e=>{if(EMBEDDED){e.preventDefault();openExternal(sync.url);}};side.append(a);
  }
  if(['blocked','retrying'].includes(sync.state)&&(sameUser(project.ownerSubject)||isAdminLike())){
    const b=el('button','ws-btn ws-btn-ghost','重试 WeKnow 同步');b.disabled=state.busy;
    b.onclick=async()=>{if(state.busy)return;state.busy=true;b.disabled=true;
      try{await api('projects/'+project.id+'/knowledge-space/retry',{method:'POST',data:{}});await loadProjects();}
      catch(e){toastError(e);}finally{state.busy=false;renderProjectSide();}};side.append(b);
  }
}

function renderMilestones(side, project) {
  side.append(el('h4', '', '里程碑'));
  const ms = Array.isArray(project.milestones) ? project.milestones.slice() : [];
  ms.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return ad - bd;
  });
  const ul = el('ul', 'ws-ms-list');
  if (ms.length === 0) ul.append(el('li', 'ws-side-hint', '尚无里程碑。'));
  const owner = { subject: project.ownerSubject, name: project.ownerName, email: project.ownerEmail };
  const assigneePool = [owner].concat(project.members || []);
  for (const m of ms) {
    const li = el('li', 'ws-ms-item'); li.dataset.status = m.status;
    const text = el('div', 'ws-ms-text');
    text.append(el('div', 'ws-ms-title', m.title || ''));
    const found = assigneePool.find(x => x && x.subject === m.assignee);
    const assigneeName = (found && (found.name || found.email)) || m.assignee || '';
    const parts = [];
    if (assigneeName) parts.push('负责人 ' + assigneeName);
    if (m.dueAt) parts.push((isOverdue(m.dueAt) && m.status !== 'done' ? '逾期 ' : '截止 ') + fmtDateOnly(m.dueAt));
    text.append(el('div', 'ws-ms-meta', parts.join(' · ')));
    li.append(text);
    const canFinish = m.canChange===true;
    const btn = el('button', 'ws-ms-done-btn', m.status === 'done' ? '重新打开' : '完成');
    btn.type = 'button'; btn.dataset.done = m.status === 'done' ? 'true' : 'false';
    btn.disabled = !canFinish||state.busy;
    btn.onclick = () => openMsDoneDialog(project, m);
    li.append(btn); ul.append(li);
  }
  side.append(ul);
}

// Presentation only: existing DTO capabilities control entries; commands still authorize on the server.
function projectActionAvailability(project) {
  return {
    edit:project.canEdit===true&&project.phase!=='pending',
    apply:project.canApply===true&&['exploring','needs_changes'].includes(project.phase),
    review:project.canReview===true&&project.phase==='pending',
    addMilestone:project.canEdit===true,
    archive:(sameUser(project.ownerSubject)||isAdminLike())&&project.phase!=='pending',
  };
}

function renderProjectAccess(side,project) {
  const root=el('div','ws-overview');root.id='ws-project-access';side.append(root);
  const identity=overviewSection(root,'我的身份');
  identity.append(sideRow('组织',ROLE_LABEL[state.profile?.role]||'成员'));
  identity.append(sideRow('项目',sameUser(project.ownerSubject)?'项目负责人':isMemberOrOwner(project)?'项目成员':'未加入此项目'));
  const scope=overviewSection(root,'访问范围');
  scope.append(sideRow('项目','拥有 Kick 访问权限的组织成员可见'));
  scope.append(sideRow('需求',suiteModule('makit')?'由 Makit 独立核对业务权限':'Makit 未启用'));
  scope.append(sideRow('文档',suiteModule('weknow')?'由 WeKnow 独立核对空间权限':'WeKnow 未启用'));
  const actions=overviewSection(root,'当前可用入口'),available=projectActionAvailability(project);
  const labels={edit:'编辑项目与成员',apply:'提交立项',review:'审核立项',addMilestone:'新建里程碑',archive:project.archived?'恢复项目':'归档项目'};
  const list=el('ul','ws-access-actions');
  for(const [key,label] of Object.entries(labels))if(available[key])list.append(el('li','ws-badge ws-badge-indigo',label));
  const milestones=(project.milestones||[]).filter(m=>m.canChange===true);
  if(milestones.length)list.append(el('li','ws-badge ws-badge-teal','更新 '+milestones.length+' 项里程碑'));
  if(list.children.length)actions.append(list);else actions.append(el('p','','仅查看项目'));
  const people=new Map();
  if(project.ownerSubject)people.set(project.ownerSubject,{subject:project.ownerSubject,name:project.ownerName,email:project.ownerEmail,owner:true});
  for(const person of project.members||[])if(person.subject&&!people.has(person.subject))people.set(person.subject,person);
  const members=overviewSection(root,'项目成员 · '+people.size),rows=el('ul','ws-access-members');
  rows.setAttribute('aria-label','项目成员列表');
  if(people.size>5)rows.setAttribute('tabindex','0');
  for(const person of people.values()){
    const row=el('li','ws-access-member'),copy=el('div','ws-access-person');
    copy.append(el('strong','',person.name||person.email||'未命名成员'));
    if(person.name&&person.email)copy.append(el('span','ws-access-email',person.email));
    row.append(copy,el('span','ws-badge '+(person.owner?'ws-badge-indigo':''),person.owner?'负责人':'成员'));
    if(sameUser(person.subject))row.setAttribute('aria-label',(person.name||person.email||'成员')+'，我');
    rows.append(row);
  }
  if(people.size)members.append(rows);else members.append(el('p','','尚未配置成员'));
  renderTransferControls(root,project);
}

function renderProjectActions(side, project) {
  const available=projectActionAvailability(project);
  const actions = el('div', 'ws-side-actions');
  const add = (cls, text, fn, enabled = true) => { if (!enabled) return; const b = el('button', 'ws-btn ' + cls, text); b.type = 'button'; b.onclick = fn; actions.append(b); };
  add('ws-btn-ghost', '编辑', () => openProjectDialog(project), available.edit);
  add('ws-btn-primary', '提交立项', () => openApplyDialog(project), available.apply);
  add('ws-btn-primary', '审核', () => openReviewDialog(project), available.review);
  add('ws-btn-ghost', '新建里程碑', () => openMilestoneDialog(project), available.addMilestone);
  add(project.archived ? 'ws-btn-ghost' : 'ws-btn-danger', project.archived ? '取消归档' : '归档', () => openArchiveDialog(project), available.archive);
  if(project.ownershipTransfer?.enabled){const b=el('button','ws-btn ws-btn-ghost','负责人转让');b.type='button';b.onclick=()=>{state.projectView='access';writeProjectRoute();renderProjectSide();};actions.append(b);}
  add('ws-btn-ghost','操作记录',()=>showHistory(project));
  if (actions.children.length > 0) side.append(actions);
}

function renderTransferControls(root,project){
  const transfer=project.ownershipTransfer;if(!transfer?.enabled)return;
  const section=overviewSection(root,'负责人转让'),current=transfer.current;section.id='ws-transfer-controls';
  if(current){
    const labels={pending:'等待接收',accepted:'已完成',cancelled:'已取消',expired:'已过期',invalidated:'已失效'};
    section.append(el('p','',current.recipientName+' · '+(labels[current.state]||'已失效')));
    if(current.state==='pending')section.append(el('p','','有效期至 '+fmtDateTime(current.expiresAt)));
  }
  const actions=el('div','ws-side-actions');
  const add=(text,action,enabled)=>{if(!enabled)return;const b=el('button','ws-btn '+(action==='cancel'?'ws-btn-ghost':'ws-btn-primary'),text);b.type='button';b.onclick=()=>openTransferDialog(project,action);actions.append(b);};
  add('转让负责人','start',transfer.canStart);add('接收负责人','accept',current?.canAccept);add('取消转让','cancel',current?.canCancel);
  if(actions.children.length)section.append(actions);
}
function openTransferDialog(project,action){
  let dlg=$('ws-dialog-transfer');if(!dlg){dlg=el('dialog','ws-dialog ws-dialog-small');dlg.id='ws-dialog-transfer';$('ws-dialog-project').parentElement.append(dlg);dlg.addEventListener('close',()=>{if(activeDialog===dlg){activeDialog=null;activeDialogContext=null;state.dialogOpen=false;}});}
  dlg.replaceChildren();dlg.setAttribute('aria-labelledby','ws-transfer-title');
  const form=el('form'),title=el('h3','ws-dialog-title',action==='start'?'转让负责人':action==='accept'?'接收项目负责人':'取消转让');title.id='ws-transfer-title';
  form.append(title,el('p','',project.name));
  const choice=el('select','ws-input');choice.id='ws-transfer-recipient';
  if(action==='start'){
    const label=el('label','','接收人');label.htmlFor=choice.id;
    const valid=new Set(state.members.map(m=>m.subject));
    for(const person of project.members||[])if(valid.has(person.subject)){const option=el('option','',person.name||person.email);option.value=person.subject;choice.append(option);}
    const field=el('div','ws-field');field.append(label,choice);form.append(field);
    if(!choice.children.length)form.append(el('p','','请先在项目中添加有效成员。'));
  }
  if(action!=='cancel')form.append(el('p','','接收后，原负责人保留为普通成员。知识空间权限保持不变。'));
  const error=el('p','ws-form-error');error.hidden=true;error.setAttribute('role','alert');form.append(error);
  const actions=el('div','ws-dialog-actions'),back=el('button','ws-btn ws-btn-ghost','返回'),submit=el('button','ws-btn ws-btn-primary',action==='start'?'发送转让请求':action==='accept'?'确认接收':'确认取消');
  back.type='button';back.onclick=()=>closeDialog(dlg);submit.type='submit';submit.disabled=action==='start'&&!choice.children.length;actions.append(back,submit);form.append(actions);dlg.append(form);
  const ctx={transferProject:project,transferAction:action,transferId:project.ownershipTransfer.current?.id,requestId:crypto.randomUUID(),input:null};
  form.onsubmit=async event=>{
    event.preventDefault();if(state.busy)return;
    // Once attempted, freeze the exact input until this dialog is closed.
    ctx.input||={requestId:ctx.requestId,...(action==='start'?{revision:project.revision,recipientSubject:choice.value}:{transferId:ctx.transferId})};
    const epoch=state.generation;state.busy=true;setFormBusy(form,true);setFormError(dlg,'');
    try{
      await api('projects/'+project.id+'/transfer/'+action,{method:'POST',data:ctx.input});
      if(epoch!==state.generation)return;
      closeDialog(dlg);await Promise.all([loadProjects(),loadTodos()]);setStatus('转让状态已更新','ok');
    }catch(e){if(epoch===state.generation){setFormError(dlg,e.message);if([401,403].includes(e.status))toastError(e);}}
    finally{state.busy=false;setFormBusy(form,false);if(ctx.input)choice.disabled=true;}
  };
  openDialog('ws-dialog-transfer',ctx);
}

async function showHistory(project=null){
  $('ws-history-title').textContent=project?'项目操作记录':'招新处理记录';
  const list=$('ws-history-list');list.replaceChildren(el('li','ws-side-hint','加载中'));
  openDialog('ws-dialog-history',{});const epoch=state.generation;
  try{
    const r=await api(project?'projects/'+project.id+'/audit':'recruitment/history');
    if(epoch!==state.generation||!state.profile)return;list.replaceChildren();
    const labels={transfer_start:'发起负责人转让',transfer_accept:'接收项目负责人',transfer_cancel:'取消负责人转让',create:'创建项目',update:'修改资料',apply:'提交立项',approve:'批准立项',return:'退回修改',archive:'归档项目',restore:'恢复项目',milestone_add:'新建里程碑',milestone_done:'完成里程碑',milestone_reopen:'重开里程碑'};
    for(const row of r.events){const li=el('li','ws-item');li.append(el('strong','',row.actorName+' · '+(project?(labels[row.action]||'更新项目'):'处理投递 '+row.id.slice(0,8))),el('p','ws-ms-meta',fmtDateTime(row.at)));if(row.note)li.append(el('p','ws-side-row',row.note));list.append(li);}
    if(!r.events.length)list.append(el('li','ws-side-hint','暂无记录'));
  }catch(e){if(epoch===state.generation){list.replaceChildren(el('li','ws-side-hint',e.message));if([401,403].includes(e.status))toastError(e);}}
}

function openDialog(id, context) {
  const dlg = $(id); if (!dlg || typeof dlg.showModal !== 'function') return;
  activeDialog = dlg; activeDialogContext = context || null; state.dialogOpen = true;
  const errNode = dlg.querySelector('.ws-form-error');
  if (errNode) { errNode.textContent = ''; errNode.hidden = true; }
  try { dlg.showModal(); } catch { /* already open */ }
}
function closeDialog(dlg) {
  const target = dlg || activeDialog; if (!target) return;
  try { target.close(); } catch { /* ignore */ }
  if (target === activeDialog) { activeDialog = null; activeDialogContext = null; state.dialogOpen = false; }
}
function setFormError(dlg, text) {
  const node = dlg && dlg.querySelector('.ws-form-error'); if (!node) return;
  node.textContent = text || ''; node.hidden = !text;
}
function setFormBusy(form, busy) {
  if (!form) return;
  for (const node of form.querySelectorAll('input, textarea, select, button')) node.disabled = !!busy;
}

// Member picker — searchable checkbox list that is resilient to directory
// failures. Already selected members are kept visible even when the directory
// is unavailable so a hiccup never silently discards saved choices.
function memberSearchMatches(member, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    String(member.name || '').toLowerCase().includes(q) ||
    String(member.email || '').toLowerCase().includes(q) ||
    String(member.subject || '').toLowerCase().includes(q)
  );
}

function renderMemberPicker() {
  const list = $('ws-field-members-list'); if (!list) return;
  clear(list);
  const owner = projectPicker.ownerSubject;
  const selected = projectPicker.selected;
  const query = projectPicker.search || '';
  // Known universe: directory entries plus any already picked subjects so
  // picks persist even when the directory is unavailable or filtered out.
  const byId = new Map();
  for (const m of state.members || []) if (m && m.subject && m.subject !== owner) byId.set(m.subject, m);
  for (const subject of selected) {
    if (subject === owner || byId.has(subject)) continue;
    byId.set(subject, projectPicker.profiles.get(subject)||{ subject, name: '', email: '' });
  }
  const all = Array.from(byId.values());
  const visible = all.filter((m) => selected.has(m.subject) || memberSearchMatches(m, query));
  visible.sort((a, b) => {
    const sa = selected.has(a.subject), sb = selected.has(b.subject);
    if (sa !== sb) return sa ? -1 : 1;
    return String(a.name || a.email || a.subject).localeCompare(String(b.name || b.email || b.subject), 'zh-CN');
  });

  const summary = $('ws-field-members-summary');
  if (summary) {
    const parts = ['已选 ' + selected.size + ' 人'];
    if (state.membersLoading && !state.membersLoaded) parts.push('目录加载中…');
    else if (state.membersUnavailable) parts.push('企业目录暂不可用');
    else if (state.membersSource) parts.push('来源：' + (state.membersSource === 'feishu' ? '飞书通讯录' : state.membersSource === 'organization' ? '组织成员' : '已登录成员'));
    summary.textContent = parts.join(' · ');
  }
  const status = $('ws-field-members-status');
  if (status) {
    let text = '';
    if (state.membersLoading && !state.membersLoaded) text = '正在加载企业目录…';
    else if (state.membersUnavailable) text = '企业目录暂时无法读取，已保留当前选择。可点击刷新重试。';
    else if (state.membersError) text = state.membersError;
    status.textContent = text; status.hidden = !text;
  }

  if (visible.length === 0) {
    const empty = el('p', 'ws-member-empty');
    empty.textContent = query ? '没有匹配的成员。' : (state.membersUnavailable ? '企业目录暂不可用。' : '目录中暂无其他成员。');
    list.append(empty);
    return;
  }

  for (const m of visible) {
    const row = el('label', 'ws-member-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = m.subject;
    cb.checked = selected.has(m.subject);
    cb.addEventListener('change', () => {
      if (cb.checked) {selected.add(m.subject);projectPicker.profiles.set(m.subject,m);} else selected.delete(m.subject);
      renderMemberPicker();
    });
    const text = el('span', 'ws-member-text');
    const name = el('span', 'ws-member-name', m.name || m.email || m.subject);
    text.append(name);
    const emailValue = m.email ? String(m.email) : '';
    if (emailValue) text.append(el('span', 'ws-member-email', emailValue));
    if (!byId.get(m.subject)?.name && !byId.get(m.subject)?.email) {
      text.append(el('span', 'ws-member-email', '（已选成员，未在当前目录命中）'));
    }
    row.append(cb, text);
    list.append(row);
  }
}

function refreshMemberPicker() { renderMemberPicker(); updateMemberPickerSaveState(); }

function updateMemberPickerSaveState() {
  const submit = $('ws-form-project-submit'); if (!submit) return;
  // Disable save while the directory is still being loaded for the first time
  // so the user never submits before seeing the picker populate.
  if (state.membersLoading && !state.membersLoaded) { submit.disabled = true; return; }
  if (!state.busy) submit.disabled = false;
}

function populateAssigneeSelect(select, project) {
  if (!select) return; clear(select);
  const seen = new Set();
  const owner = { subject: project.ownerSubject, name: project.ownerName, email: project.ownerEmail };
  for (const m of [owner].concat(project.members || [])) {
    if (!m || !m.subject || seen.has(m.subject)) continue;
    seen.add(m.subject);
    const opt = document.createElement('option');
    opt.value = m.subject;
    const label = (m.name || m.email || m.subject) + (m.email ? ' · ' + m.email : '');
    opt.textContent = label + (m.subject === project.ownerSubject ? '（负责人）' : '');
    select.append(opt);
  }
}

function openProjectDialog(project) {
  const dlg = $('ws-dialog-project'), form = $('ws-form-project');
  if (!dlg || !form) return;
  form.reset();
  $('ws-form-project-title').textContent = project?.unconfigured?'完善立项':project ? '编辑项目' : '新建项目';
  $('ws-field-name').value = project ? (project.name || '') : '';
  $('ws-field-summary').value = project ? (project.summary || '') : '';
  // Reset the picker local state so stale selections never leak between opens.
  projectPicker.selected = new Set(
    project && Array.isArray(project.members)
      ? project.members.map((m) => m && m.subject).filter(Boolean)
      : []
  );
  projectPicker.profiles=new Map((project?.members||[]).map(m=>[m.subject,m]));
  projectPicker.search = '';
  projectPicker.ownerSubject = (project && project.ownerSubject) || state.profile?.subject || '';
  const searchInput = $('ws-field-members-search'); if (searchInput) searchInput.value = '';
  const links = (project && project.links) || {};
  $('ws-field-link-repo').value = links.repository || '';
  $('ws-field-link-req').value = links.requirements || '';
  $('ws-field-link-docs').value = links.docs || '';
  if(globalThis.__COBUILD__){$('ws-field-create-knowledge').disabled=!suiteModule('weknow');$('ws-field-create-knowledge').title=suiteModule('weknow')?'':'WeKnow 模块未启用';}
  $('ws-field-link-knowledge').value = links.knowledgeSpace || '';
  $('ws-field-create-knowledge').checked = false;
  $('ws-create-knowledge-option').hidden = !!project && !project.unconfigured;
  $('ws-field-link-demo').value = links.demo || '';
  openDialog('ws-dialog-project', { project, requestId: crypto.randomUUID() });
  const fields = dlg.querySelector('.ws-project-fields');
  if (fields) fields.scrollTop = 0;
  $('ws-field-name').focus({ preventScroll: true });
  // Ensure the enterprise directory is loaded (or refreshed) on every open so
  // long-lived dialogs see new teammates.
  void loadMembers({ refresh: true });
  refreshMemberPicker();
}

function collectProjectForm() {
  const name = String($('ws-field-name').value || '').trim();
  const summary = String($('ws-field-summary').value || '').trim();
  // Send plain {subject} rows; the server rejects any subject that is not in
  // its own enterprise directory, so arbitrary / stale ids cannot slip through.
  const owner = projectPicker.ownerSubject;
  const subjects = Array.from(projectPicker.selected).filter((s) => typeof s === 'string' && s && s !== owner);
  const members = subjects.map((subject) => ({ subject }));
  const links = {
    repository: String($('ws-field-link-repo').value || '').trim(),
    requirements: String($('ws-field-link-req').value || '').trim(),
    docs: String($('ws-field-link-docs').value || '').trim(),
    knowledgeSpace: String($('ws-field-link-knowledge').value || '').trim(),
    demo: String($('ws-field-link-demo').value || '').trim(),
  };
  if (name.length === 0 || name.length > 80) return { error: '名称长度需为 1-80' };
  if (summary.length === 0 || summary.length > 800) return { error: '简介长度需为 1-800' };
  if (links.repository && !isGithubRepoUrl(links.repository)) return { error: '代码仓库仅支持 https://github.com/owner/repo' };
  for (const [key, label] of [['requirements', '需求'], ['docs', '文档'], ['knowledgeSpace','WeKnow 空间'], ['demo', '演示']]) {
    if (links[key] && !isSafeHttpsUrl(links[key])) return { error: label + '链接需为 https:// 开头' };
  }
  const creating=!activeDialogContext?.project||activeDialogContext.project.unconfigured;
  const createKnowledgeSpace=creating&&$('ws-field-create-knowledge').checked;
  if(createKnowledgeSpace&&name.length<2)return {error:'创建 WeKnow 空间的项目名称至少 2 个字'};
  return { name, summary, members, links,...(creating?{createKnowledgeSpace}:{} ) };
}

function openApplyDialog(project) {
  $('ws-form-apply-project').textContent = project.name || '';
  $('ws-field-application').value = project.application || '';
  openDialog('ws-dialog-apply', { project });
}
function openReviewDialog(project) {
  $('ws-form-review-project').textContent = project.name || '';
  $('ws-form-review').reset();
  openDialog('ws-dialog-review', { project });
}
function openArchiveDialog(project) {
  $('ws-form-archive-title').textContent = project.archived ? '取消归档' : '归档项目';
  $('ws-form-archive-project').textContent = project.name || '';
  $('ws-form-archive-submit').textContent = project.archived ? '取消归档' : '归档';
  openDialog('ws-dialog-archive', { project, requestId:crypto.randomUUID() });
}
function openMilestoneDialog(project) {
  $('ws-form-milestone').reset();
  $('ws-form-milestone-project').textContent = project.name || '';
  populateAssigneeSelect($('ws-field-ms-assignee'), project);
  openDialog('ws-dialog-milestone', { project });
}
async function openMsDoneDialog(project, milestone) {
  if(state.busy)return;
  state.busy=true;renderProjectSide();
  try{
    await api('projects/'+project.id+'/milestones/'+milestone.id,{method:'POST',data:{revision:milestone.revision,status:milestone.status==='done'?'open':'done'}});
    await Promise.all([loadProjects(),loadTodos()]);setStatus(milestone.status==='done'?'里程碑已重新打开':'里程碑已完成','ok');
  }catch(e){toastError(e);}finally{state.busy=false;renderProjectSide();}
}
function openRecruitDialog(item) {
  $('ws-form-recruit-text').textContent = item.title || '';
  $('ws-form-recruit').reset();
  openDialog('ws-dialog-recruit', { item });
}

async function runSubmit(dlgId, formId, buildRequest, onSuccess) {
  const dlg = $(dlgId), form = $(formId);
  if (!dlg || !form || state.busy) return;
  const ctx = activeDialogContext || {}, epoch = state.generation;
  let req;
  try { req = buildRequest(ctx); } catch (e) { setFormError(dlg, e.message || '输入无效'); return; }
  if (!req) return;
  if (req.error) { setFormError(dlg, req.error); return; }
  state.busy = true; setFormBusy(form, true); setFormError(dlg, '');
  try {
    const result = await api(req.path, { method: 'POST', data: req.data });
    if(epoch!==state.generation || ctx!==activeDialogContext)return;
    closeDialog(dlg);
    if (req.status) setStatus(typeof req.status === 'function' ? req.status(result) : req.status, 'ok');
    if (typeof onSuccess === 'function') await onSuccess(result);
  } catch (err) {
    if(epoch!==state.generation || ctx!==activeDialogContext)return;
    setFormError(dlg, err.message || '操作失败');
    if (err.status === 401 || err.status === 403) toastError(err);
  } finally {
    state.busy = false; setFormBusy(form, false);renderProjectSide();
  }
}

function submitProjectForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-project', 'ws-form-project', (ctx) => {
    const parsed = collectProjectForm();
    if (parsed.error) return parsed;
    if(ctx.project?.unconfigured)return {path:'projects',data:{...parsed,classificationId:ctx.project.id,requestId:ctx.requestId},status:'立项信息已完善'};
    if (ctx.project) {
      const data = {revision:ctx.project.revision,...parsed};
      // Same submission keeps its key after a lost response; editing the form
      // creates a new command rather than reusing a key with different content.
      const signature=JSON.stringify(data);
      if(ctx.submittedSignature && ctx.submittedSignature!==signature)ctx.requestId=crypto.randomUUID();
      ctx.submittedSignature=signature;
      if(globalThis.__COBUILD__)data.requestId=ctx.requestId;
      return {path:'projects/'+encodeURIComponent(ctx.project.id)+'/update',data,status:'项目已更新'};
    }
    return { path: 'projects', data: { ...parsed, requestId: ctx.requestId }, status: '项目已创建' };
  }, () => loadProjects());
}

function submitApplyForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-apply', 'ws-form-apply', (ctx) => {
    const application = String($('ws-field-application').value || '').trim();
    if (application.length === 0 || application.length > 2000) return { error: '立项说明长度需为 1-2000' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/apply', data: { revision: ctx.project.revision, application }, status: '立项申请已提交' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitReviewForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-review', 'ws-form-review', (ctx) => {
    const form = $('ws-form-review');
    const picked = form.querySelector('input[name="decision"]:checked');
    if (!picked) return { error: '请选择审核结果' };
    const decision = picked.value;
    const note = String($('ws-field-review-note').value || '').trim();
    if (note.length > 1000) return { error: '备注不能超过 1000 字' };
    if (decision === 'return' && note.length === 0) return { error: '退回需要填写备注' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/review', data: { revision: ctx.project.revision, decision, note }, status: '审核结果已记录' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitArchiveForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-archive', 'ws-form-archive', (ctx) => ({
    path: 'projects/' + encodeURIComponent(ctx.project.id) + '/archive',
    data: { revision: ctx.project.revision, archived: !ctx.project.archived, ...(globalThis.__COBUILD__?{requestId:ctx.requestId}:{}) },
    status: result => (result.archived ? '项目已归档' : '项目已恢复')+(result.operation&&result.operation.state!=='succeeded'?'，关联应用正在同步':''),
  }), async () => { await Promise.all([loadProjects(),loadTodos()]); });
}

function submitMilestoneForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-milestone', 'ws-form-milestone', (ctx) => {
    const title = String($('ws-field-ms-title').value || '').trim();
    const assignee = String($('ws-field-ms-assignee').value || '').trim();
    const dueRaw = String($('ws-field-ms-due').value || '').trim();
    if (title.length === 0 || title.length > 160) return { error: '标题长度需为 1-160' };
    if (!assignee) return { error: '请选择负责人' };
    const dueAt = dueRaw ? localDateInputToIsoEndOfDay(dueRaw) : null;
    if (dueRaw && !dueAt) return { error: '日期无效' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/milestones', data: { title, assignee, dueAt }, status: '里程碑已创建' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitMsDoneForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-ms-done', 'ws-form-ms-done', (ctx) => ({
    path: 'projects/' + encodeURIComponent(ctx.project.id) + '/milestones/' + encodeURIComponent(ctx.milestone.id),
    data: { revision: ctx.milestone.revision, status: 'done' },
    status: '里程碑已完成',
  }), async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitRecruitForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-recruit', 'ws-form-recruit', (ctx) => {
    const note = String($('ws-field-recruit-note').value || '').trim();
    if (note.length === 0 || note.length > 1000) return { error: '处理说明长度需为 1-1000' };
    const rawId = String(ctx.item.id || '').replace(/^recruitment:/, '');
    return { path: 'recruitment/' + encodeURIComponent(rawId) + '/handled', data: { note }, status: '已记录处理说明' };
  }, () => loadTodos());
}

function clearIdentity() {
  state.generation++;state.profile=null;state.csrf='';state.members=[];state.projects=[];state.todos=[];state.todoSources=null;state.requirements=null;
  state.selectedProjectId=null;state.selectedTodoKey=null;state.reqRequestId=null;state.todosReady=false;
  state.membersSource=''; state.membersUnavailable=false; state.membersLoaded=false; state.membersLoading=false; state.membersError='';
  state.pendingProjectId=null;state.overview=null;overviewRead++;
  projectPicker.selected = new Set(); projectPicker.profiles.clear(); projectPicker.search = ''; projectPicker.ownerSubject = '';
  clearTimeout(state.reqTimer);finishLogin();
  for(const dlg of document.querySelectorAll('.ws-dialog')){closeDialog(dlg);dlg.querySelector('form')?.reset();}
  $('ws-history-list')?.replaceChildren();
  renderShell();renderPanels();renderRequirementsSource();
}
async function loadSession() {
  const epoch=++state.generation;
  try{
    const me=await api('session');if(epoch!==state.generation)return;
    if(state.profile?.subject&&state.profile.subject!==me.subject){clearIdentity();void loadSession();return;}
    state.profile=me;state.csrf=me.csrf||'';renderShell();
    await Promise.all([loadMembers(),loadProjects(),loadTodos()]);
    if(epoch===state.generation&&state.profile)requestRequirements();
  }catch(e){if(epoch!==state.generation)return;if(e.status===401)clearIdentity();else setStatus(e.message,'error');}
}
// Read the enterprise directory. On transient failures we deliberately keep
// state.members untouched so already-selected teammates and the owner picker
// never silently disappear from an open dialog.
let membersRead=0;
async function loadMembers({ refresh = false } = {}) {
  if(!suiteModule('kick')){state.members=[];return;}
  const epoch = state.generation,serial=++membersRead;
  state.membersLoading = true; state.membersError = '';
  if (refresh) refreshMemberPicker();
  try {
    const r = await api('members');
    if (epoch !== state.generation || serial!==membersRead || !state.profile) return;
    state.members = Array.isArray(r?.members) ? r.members.filter((m) => m && typeof m.subject === 'string') : [];
    state.membersSource = typeof r?.source === 'string' ? r.source : '';
    state.membersUnavailable = !!r?.unavailable;
    state.membersLoaded = true;
    state.membersError = state.membersUnavailable ? '企业目录暂时无法读取，已保留当前选择。' : '';
  } catch (e) {
    if (epoch !== state.generation||serial!==membersRead) return;
    // Preserve previously known members; just surface a human readable error
    // next to the picker. 401/403 continue to drive the shared login flow.
    state.membersUnavailable = true;
    state.membersError = e.status === 0 ? '企业目录当前不可访问（网络）。' : (e.message || '企业目录读取失败');
    if (e.status === 401 || e.status === 403) toastError(e);
  } finally {
    if (epoch === state.generation&&serial===membersRead) {
      state.membersLoading = false;
      refreshMemberPicker();
    }
  }
}
let projectsRead=0,todosRead=0;
async function loadProjects() {
  if(!suiteModule('kick')){state.projects=[];return;}
  const epoch=state.generation,serial=++projectsRead;
  if(state.applicationAccess?.projects?.allowed===false){state.projects=[];state.selectedProjectId=null;discardProjectDialog();renderProjects();renderProjectSide();return;}
  try{
    const r=await api('projects');if(epoch!==state.generation||serial!==projectsRead||!state.profile)return;
    state.projects=r.projects||[];state.overview=null;overviewRead++;
    reconcileProjectSelection();writeProjectRoute({replace:true});checkProjectDialogAccess();
    renderProjects();renderProjectSide();
  }catch(e){if(epoch===state.generation&&serial===projectsRead){
    if(e.status===403){state.projects=[];state.pendingProjectId=state.selectedProjectId||state.pendingProjectId;state.selectedProjectId=null;discardProjectDialog();renderProjects();renderProjectSide();setStatus('无权访问项目','error');}
    else toastError(e);
  }}
}
async function loadTodos() {
  const epoch=state.generation,serial=++todosRead;
  try{
    const r=await api('todos');if(epoch!==state.generation||serial!==todosRead||!state.profile)return;
    state.todos=r.items||[];state.todoSources=r.sources||null;state.todosReady=true;
    renderTodos();renderTodoSide();renderRequirementsSource();
  }catch(e){if(epoch===state.generation&&serial===todosRead){state.todosReady=false;toastError(e);}}
}

function renderPanels() { renderProjects(); renderProjectSide(); renderTodos(); renderTodoSide(); updateCounts(); }

function renderRequirementsSource() {
  const node = $('ws-req-source'); if (!node) return;
  clear(node); node.hidden = true;
  node.removeAttribute('data-partial'); node.removeAttribute('data-stale');
  const recruitment=state.todoSources?.recruitment;
  if(recruitment?.state==='unavailable'){node.append(document.createTextNode('招新待办暂时无法同步 · '));node.hidden=false;}
  if(recruitment?.partial){node.append(document.createTextNode('招新显示前 200 条 待处理后继续加载 · '));node.hidden=false;}
  if(globalThis.__COBUILD__)return;
  if (!EMBEDDED) {
    if (state.requirementsStandaloneHint) {
      node.append(document.createTextNode('需求待办在 110lab 插件中同步。'));
      node.hidden = false;
    }
    return;
  }
  const r = state.requirements; if (!r) return;
  if (r.state === 'not_configured') { node.append(document.createTextNode('Makit尚未配置。')); node.hidden = false; return; }
  if (r.state === 'unavailable') { node.append(document.createTextNode('Makit暂时不可用。')); node.hidden = false; return; }
  node.append(document.createTextNode('Makit · ' + (r.accountName || '')));
  if (r.stale) { node.append(document.createTextNode(' · 来源缓存待刷新')); node.dataset.stale = 'true'; }
  if(r.reviewState==='unavailable')node.append(document.createTextNode(' · PR 评审暂时无法同步'));
  if (r.partial) { node.append(document.createTextNode(' · 来源仅返回部分记录')); node.dataset.partial = 'true'; }
  node.hidden = false;
}

function requestRequirements() {
  if(!state.profile)return;
  if(state.applicationAccess?.requirements?.allowed===false){state.requirements={state:'restricted',items:[]};renderRequirementsSource();renderTodos();return;}
  if (!EMBEDDED) { state.requirementsStandaloneHint = true; renderRequirementsSource(); return; }
  if (typeof crypto === 'undefined' || !crypto.randomUUID) return;
  const requestId = crypto.randomUUID();
  state.reqRequestId = requestId;
  if (state.reqTimer) { clearTimeout(state.reqTimer); state.reqTimer = null; }
  if (!postToParent({ type: '110lab-workspace-requirements', requestId })) return;
  state.reqTimer = setTimeout(() => {
    if (state.reqRequestId !== requestId) return;
    if (state.profile) {
      state.requirements = { state: 'unavailable', items: [] };
      renderRequirementsSource(); renderTodos();
    }
  }, 65000);
}

async function handleParentMessage(ev) {
  if (!EMBEDDED || typeof window === 'undefined' || ev.source !== window.parent) return;
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  if(data.type==='110lab-workspace-activated'){if(!state.busy&&!state.dialogOpen)await loadSession();return;}
  if(data.type==='110lab-mail-host-opened'&&data.state===state.loginFlow?.state){setStatus('请在飞书完成授权 返回后自动登录');return;}
  if(data.type==='110lab-mail-host-result'&&data.state===state.loginFlow?.state){
    const flow=state.loginFlow;
    try{
      if(!/^[\w-]{43}$/.test(data.ticket||''))throw new Error('连接未完成 请重试或更新 110lab 插件');
      await api('auth/redeem',{method:'POST',data:{state:flow.state,ticket:data.ticket}});
      if(state.loginFlow!==flow)return;finishLogin();setStatus('');await loadSession();
    }catch(e){if(state.loginFlow===flow){finishLogin();setStatus(e.message,'error');}}return;
  }
  if (data.type === '110lab-workspace-requirements-result'&&state.profile) {
    if (!data.requestId || data.requestId !== state.reqRequestId) return;
    const r = data.result;
    if (!r || typeof r !== 'object') return;
    const stateValue = typeof r.state === 'string' ? r.state : 'unavailable';
    const accountName = typeof r.accountName === 'string' ? r.accountName : '';
    const stale = !!r.stale, partial = !!r.partial;
    const items = Array.isArray(r.items) ? r.items.filter(x => x && typeof x === 'object').map(x => ({
      id: typeof x.id === 'string' ? x.id : '',
      title: typeof x.title === 'string' ? x.title : '',
      kind: 'requirement',
      url: typeof x.url === 'string' && isSafeHttpsUrl(x.url) ? x.url : null,
      status: typeof x.status === 'string' ? x.status : '',
      dueAt: typeof x.dueAt === 'string' ? x.dueAt : null,
      projectName: typeof x.projectName === 'string' ? x.projectName : '',
    })).filter(x => x.id && x.title) : [];
    state.requirements = { state: stateValue, accountName, stale, partial, reviewState:r.reviewState, items };
    if (state.reqTimer) { clearTimeout(state.reqTimer); state.reqTimer = null; }
    renderRequirementsSource(); renderTodos(); renderTodoSide();
    return;
  }
  if (data.type === '110lab-workspace-ready') { requestRequirements(); return; }
  // Parent-driven project selection. Only accepts well-formed UUIDs from the
  // real parent frame (checked above via ev.source === window.parent).
  if (data.type === '110lab-workspace-select-project' && isUuid(data.projectId)) {
    if (!PROJECTS_PAGE) return;
    selectProject(data.projectId);
    return;
  }
}

function finishLogin(){clearTimeout(state.loginTimer);state.loginFlow=null;state.busy=false;if($('ws-login'))$('ws-login').disabled=false;}
async function doLogin() {
  if(globalThis.__COBUILD__){location.assign('/login?next='+encodeURIComponent(PROJECTS_PAGE?location.pathname+location.search:'/workbench'));return;}
  if(state.busy)return;state.busy=true;$('ws-login').disabled=true;setStatus('');
  try{
    const flow=await api('auth/start',{method:'POST',data:EMBEDDED?{}:{returnTo:PROJECTS_PAGE?'/projects':'/workbench'}});
    const url=new URL(flow.launchUrl);
    if(!/^[\w-]{43}$/.test(flow.state||'')||url.origin!=='https://internal.110-lab.cn'||url.pathname!=='/mail/auth/launch')throw new Error('登录入口无效');
    state.loginFlow=flow;
    if(EMBEDDED){
      if(!postToParent({type:'110lab-mail-host-login',state:flow.state,fresh:false}))throw new Error('请从 110lab 插件打开工作台');
      setStatus('正在打开飞书授权');
      state.loginTimer=setTimeout(()=>{if(state.loginFlow===flow){finishLogin();setStatus('授权超时 请重试','error');}},285000);
    }else location.assign(flow.launchUrl);
  }catch(e){finishLogin();setStatus(e.message,'error');}
}
async function doLogout(){
  if(state.busy)return;state.busy=true;state.generation++;$('ws-logout').disabled=true;
  try{await api('logout',{method:'POST',data:{}});clearIdentity();setStatus('已退出');}
  catch(e){toastError(e);}finally{state.busy=false;$('ws-logout').disabled=false;}
}

function bindEvents() {
  $('ws-recruit-history').onclick=()=>showHistory();
  if (EMBEDDED && document && document.body) document.body.classList.add('is-workbench-embedded');
  if (PROJECTS_PAGE && document && document.body) document.body.classList.add('is-workspace-projects');
  readProjectRoute();
  window.addEventListener('popstate',()=>{
    readProjectRoute();reconcileProjectSelection();writeProjectRoute({replace:true});renderProjects();renderProjectSide();
  });
  // Member picker events — bound once, read picker state on each interaction.
  const memberSearch = $('ws-field-members-search');
  if (memberSearch) memberSearch.addEventListener('input', (e) => {
    projectPicker.search = String(e.target.value || '');
    renderMemberPicker();
  });
  const memberRefresh = $('ws-field-members-refresh');
  if (memberRefresh) memberRefresh.addEventListener('click', () => {
    if (state.membersLoading) return;
    void loadMembers({ refresh: true });
  });
  const loginBtn = $('ws-login'); if(loginBtn&&globalThis.__COBUILD__)loginBtn.textContent='登录'; if (loginBtn) loginBtn.onclick = () => { void doLogin(); };
  const logoutBtn = $('ws-logout'); if (logoutBtn) logoutBtn.onclick = () => { void doLogout(); };
  const adminBtn = $('ws-admin-settings'); if (adminBtn) adminBtn.onclick = () => { if (isSuperAdmin()) openApp('organization'); };
  const tTodos = $('ws-tab-todos'); if (tTodos) tTodos.onclick = () => selectTab('todos');
  const tProjects = $('ws-tab-projects'); if (tProjects) tProjects.onclick = () => selectTab('projects');
  for (const chip of document.querySelectorAll('[data-todo-filter]')) {
    chip.onclick = () => {
      const value = chip.dataset.todoFilter;
      if (!TODO_FILTERS[value]) return;
      state.todoFilter = value;
      for (const o of document.querySelectorAll('[data-todo-filter]')) o.setAttribute('aria-pressed', String(o.dataset.todoFilter === value));
      state.selectedTodoKey = null; renderTodos(); renderTodoSide();
    };
  }
  for (const chip of document.querySelectorAll('[data-project-filter]')) {
    chip.onclick = () => {
      selectProjectFilter(chip.dataset.projectFilter);
    };
  }
  const todosRefresh = $('ws-todos-refresh');
  if (todosRefresh) todosRefresh.onclick = () => { if (!state.busy) { void loadTodos(); requestRequirements(); } };
  const projectsRefresh = $('ws-projects-refresh');
  if (projectsRefresh) projectsRefresh.onclick = () => { if (!state.busy) void loadProjects(); };
  const newBtn = $('ws-project-new'); if (newBtn) newBtn.onclick = () => openProjectDialog(null);
  for (const btn of document.querySelectorAll('[data-ws-close]')) {
    btn.onclick = () => { closeDialog(btn.closest('dialog')); };
  }
  for (const dlg of document.querySelectorAll('.ws-dialog')) {
    dlg.addEventListener('close', () => {
      if (dlg === activeDialog) { activeDialog = null; activeDialogContext = null; state.dialogOpen = false; }
    });
  }
  const formHandlers = [
    ['ws-form-project', submitProjectForm], ['ws-form-apply', submitApplyForm],
    ['ws-form-review', submitReviewForm], ['ws-form-archive', submitArchiveForm],
    ['ws-form-milestone', submitMilestoneForm], ['ws-form-ms-done', submitMsDoneForm],
    ['ws-form-recruit', submitRecruitForm],
  ];
  for (const [id, handler] of formHandlers) { const f = $(id); if (f) f.addEventListener('submit', handler); }
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleParentMessage);
    window.addEventListener('focus', () => { if (!state.busy && state.profile) { void loadSession(); } });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.busy && state.profile) { void loadSession(); }
    });
    setInterval(() => {
      if (document.hidden || state.busy || !state.profile) return;
      void loadSession();
    }, 60000);
    let syncing = false;
    setInterval(async () => {
      if (syncing || document.hidden || state.busy || !state.profile || !state.projects.some(p => (['queued', 'syncing', 'retrying'].includes(p.requirementsSync?.state)||['queued','working','retrying'].includes(p.knowledgeSpace?.state)))) return;
      syncing = true;
      try { await loadProjects(); } finally { syncing = false; }
    }, 5000);
  }
}

export function initWorkspace({applicationAccess=null}={}) {
  state.applicationAccess=applicationAccess;
  document.addEventListener('110lab:application-access',event=>{state.applicationAccess=event.detail;if(state.reqTimer){clearTimeout(state.reqTimer);state.reqTimer=null;}state.reqRequestId=null;state.requirements=null;if(state.profile){void loadProjects();requestRequirements();}});
  document.addEventListener('110lab:session-expired', () => { clearIdentity(); void loadSession(); });
  const root = $('ws-root'); if (!root) return;
  if (root.dataset.wsInit === 'true') return;
  root.dataset.wsInit = 'true';
  bindEvents();
  renderShell(); renderPanels(); renderRequirementsSource();
  void restoreLabSession().then(()=>loadSession());
}
export default initWorkspace;
