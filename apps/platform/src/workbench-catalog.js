import {APP_BRANDS, getAppSearchText} from './app-branding.js';
export const APP_GROUPS = Object.freeze({collaboration: '协作', management: '管理', teaching: '产品'});
const groupIds = {monitoring:'management',projects:'collaboration',knowledge:'collaboration',requirements:'collaboration','public-mail':'collaboration',honors:'management','recruitment-test':'management',assessment:'management',organization:'management','updates-admin':'management','lab-home':'management','grading-internal':'teaching','grading-public':'teaching'};
const icons = {monitoring:'activity',organization:'user',projects:'folder',knowledge:'book',honors:'trophy',recruitment:'user',grading:'file-check',assessment:'file-check',requirements:'list-details',mail:'mail',home:'home',updates:'refresh'};
export const appGroup = app => groupIds[app.id] || 'collaboration';
export function appIcon(app) { return APP_BRANDS[app.id]?.iconUrl || '/assets/icons/' + (icons[app.icon] || 'apps') + '.svg'; }
export function safeAppUrl(value) {
  try { const url=new URL(value); return (url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
export function matchesApp(app, query) { return getAppSearchText(app).includes(String(query || '').trim().normalize('NFC').toLocaleLowerCase('en')); }
