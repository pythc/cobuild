export const APPS = {
  cobuild:{name:'CoBuild',icon:'cobuild-wordmark.svg'},
  makit:{name:'Makit',icon:'requirements-logo.svg'},
  weknow:{name:'WeKnow',icon:'weknow.png'},
  evalab:{name:'Evalab',icon:'evalab.png'},
  kick:{name:'Kick',icon:'kick.png'},
  pulse:{name:'Pulse',icon:'pulse.svg'},
  'grading-internal':{name:'批改系统内网版',icon:'grading.svg'},
  hiflow:{name:'HiFlow',icon:'hiflow.png'},
};
export const STATUS = {pending:'待分派',processing:'处理中',waiting:'待补充',resolved:'已解决',closed:'已关闭',unavailable:'已归档或不可用',syncing:'状态同步中'};
export const PRIORITY = {normal:'普通',high:'紧急',low:'较低',unknown:'—'};
export function visibleMessages(conversation,operator=false) {return conversation.messages.filter(m=>operator||!m.private);}
