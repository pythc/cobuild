const text=(content,size='normal',color='default')=>({tag:'div',text:{tag:'plain_text',content:String(content).slice(0,500),text_size:size,text_color:color}});
export function consultationCard(config,item,state,kind='status'){
  const resolved=state.status==='resolved',claimed=!!state.owner;
  const title=kind==='unclaimed'?'咨询待接待':kind.startsWith('overdue')?'咨询待回复':kind==='message'?'用户有新消息':resolved?'咨询已结束':claimed?'咨询已接待':'新咨询';
  const warning=kind==='unclaimed'||kind.startsWith('overdue'),color=resolved?'green':warning?'orange':'turquoise';
  const label=resolved?'已结束':claimed?`接待人：${state.owner.name}`:'等待接待';
  const url=config.publicBase+'/?view=operator&conversation='+encodeURIComponent(item.conversationId||item.conversation_id);
  const app=config.chatwoot.apps[item.app]?.name||item.app;
  const elements=[{tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,background_style:color+'-50',padding:'12px',vertical_spacing:'4px',elements:[text(item.name||'用户','heading-3'),text(`来源：${app}\n${label}`,'normal')]}]}];
  if(kind==='unclaimed')elements.push({tag:'markdown',content:'<at id=all></at> 请安排接待。'});
  if(kind.startsWith('overdue'))elements.push(text('用户的消息尚未收到回复，请及时处理。'));
  elements.push({tag:'button',text:{tag:'plain_text',content:resolved?'查看咨询':claimed?'打开会话':'查看并接待'},type:'primary_filled',width:'fill',behaviors:[{type:'open_url',default_url:url}]});
  return {schema:'2.0',config:{update_multi:true,width_mode:'default',summary:{content:`Relay · ${title}`}},header:{title:{tag:'plain_text',content:`Relay · ${title}`},template:color},body:{direction:'vertical',padding:'12px 12px 20px 12px',vertical_spacing:'12px',elements}};
}
export function cardSignature(s){return JSON.stringify([s.status,s.owner?.id||'',s.owner?.name||'']);}
