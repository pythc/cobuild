import {consultationCard,cardSignature} from './notification-cards.mjs';
// The same bot owns initial notices, lifecycle card edits and reminders.
export class ReminderWorker {
  constructor(config,store,tracker,bot,access){Object.assign(this,{config,store,tracker,bot,access});this.attention=store.attention;this.busy=false;}
  async once(){
    if(this.busy)return;this.busy=true;
    try{
      for(const row of this.attention.rows()){
        if(this.stopping)return;
        try{await this.tracker.sync(row,{force:true});}catch{this.attention.defer(row.id);console.error('Relay message synchronization pending');}
      }
      // Planning does not depend on which conversation an operator has open.
      const rows=this.store.db.prepare('SELECT c.id FROM conversations c JOIN consultations a ON a.conversation_id=c.id WHERE a.first_message_id IS NOT NULL').all();
      for(const row of rows)this.attention.plan(row.id,this.config.reminders);
      await this.bot.auth();
      for(let i=0;i<20&&!this.stopping;i++){
        const item=this.attention.next();if(!item)break;
        let outcome='unknown',messageId,errorCode;
        try{
          const conversation=await this.store.conversation(item.conversation_id);
          try { await this.tracker.sync(conversation,{force:true}); }
          catch { this.attention.deferDelivery(item);continue; }
          // Revalidate the current assignee and the workbench scope at delivery.
          const s=this.attention.summary(item.conversation_id);
          if(item.recipient!=='group'&&!(await this.access.allowed(item.recipient))){this.attention.finish(item,'cancelled');continue;}
          if(!this.attention.valid(item)){this.attention.finish(item,'cancelled');continue;}
          const row=this.store.db.prepare('SELECT c.app,a.customer_name AS name FROM conversations c JOIN consultations a ON a.conversation_id=c.id WHERE c.id=?').get(item.conversation_id);
          const payload=this.attention.freeze(item,{receive_id:item.recipient==='group'?this.config.chatId:item.recipient,msg_type:'interactive',content:JSON.stringify(consultationCard(this.config,{...item,...row},s,item.kind)),uuid:item.id});
          const v=await this.bot.request('/im/v1/messages?receive_id_type='+(item.recipient==='group'?'chat_id':'user_id'),payload,this.bot.token);
          messageId=v.data?.message_id;if(typeof messageId==='string'&&/^om_[\w-]+$/.test(messageId))outcome='sent';
        }catch(e){outcome=e.rejected?'rejected':'unknown';errorCode=e.code;if(e.code===99991663||e.code===99991668)this.bot.expires=0;}
        const accepted=this.attention.finish(item,outcome,messageId,errorCode);
        console.log(JSON.stringify({event:'relay_reminder',kind:item.kind,outcome,accepted,messageId,errorCode}));
      }
      await this.updateCards();
    }finally{this.busy=false;}
  }
  async updateCards(){
    const rows=this.store.db.prepare("SELECT n.conversation_id AS conversationId,n.app,n.name,n.message_id,s.card_hash,s.card_attempt_hash,s.card_attempts,s.card_retry_at FROM notices n JOIN attention_state s ON s.conversation_id=n.conversation_id WHERE n.state='sent' AND n.message_id IS NOT NULL AND s.status_revision>0").all();
    for(const row of rows){
      if(this.stopping)return;
      const s=this.attention.summary(row.conversationId),signature=cardSignature(s);if(signature===row.card_hash||(signature===row.card_attempt_hash&&(row.card_attempts>=8||row.card_retry_at>Date.now())))continue;
      try{
        await this.bot.request('/im/v1/messages/'+encodeURIComponent(row.message_id),{content:JSON.stringify(consultationCard(this.config,row,s))},this.bot.token,'PATCH');
        this.store.db.prepare('UPDATE attention_state SET card_hash=?,card_attempts=0,card_error=NULL WHERE conversation_id=?').run(signature,row.conversationId);
      }catch(e){
        const attempts=signature===row.card_attempt_hash?row.card_attempts+1:1;
        this.store.db.prepare('UPDATE attention_state SET card_attempt_hash=?,card_attempts=?,card_retry_at=?,card_error=? WHERE conversation_id=?').run(signature,attempts,Date.now()+Math.min(3600000,30000*2**attempts),String(e.code||'transport'),row.conversationId);
        console.error(JSON.stringify({event:'relay_card_update',outcome:e.rejected?'rejected':'unknown',code:e.code}));
      }
    }
  }
  start(){this.stopping=false;const tick=()=>{if(!this.busy)this.active=this.once().catch(()=>console.error('Relay reminders pending'));};this.timer=setInterval(tick,5000);this.timer.unref();tick();}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;}
}
