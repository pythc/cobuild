import {getAppPresentation} from '../src/app-branding.js';
import {appIcon} from '../src/workbench-catalog.js';
export function createWorkbenchNavigation({workspace,access,apps}){
  return async actor=>{
    const prefs=workspace.favorites(actor),entries=await access.entries(actor);
    return {subject:actor.subject,revision:prefs.revision,favorites:prefs.favoriteAppIds.flatMap(id=>{
      const source=apps.find(a=>a.id===id);if(!source)return [];
      const app=getAppPresentation(source),decision=entries.apps[id]||{allowed:false,reason:'暂时无法核对应用权限'};
      return [{id,title:app.title,url:'https://internal.110-lab.cn/apps/enter/'+id,iconUrl:'https://internal.110-lab.cn'+appIcon(app),allowed:decision.allowed===true,reason:decision.reason||''}];
    })};
  };
}
