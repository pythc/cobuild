import {createProjectKnowledgeClient} from './project-knowledge-client.mjs';
export function projectKnowledgeWorker({store,client=createProjectKnowledgeClient(),intervalMs=2000}={}){
  let active=null,closing=false;
  async function tick(){const job=store.knowledgeSpaces.claim();if(!job)return;
    try{const result=await client.ensure(job);if(store.knowledgeSpaces.finish(job,result))store.reconcileProjects();}
    catch(error){store.knowledgeSpaces.fail(job,error);}}
  function run(){if(closing)return Promise.resolve();if(active)return active;active=tick().finally(()=>{active=null;});return active;}
  const timer=setInterval(()=>{run().catch(()=>{});},intervalMs);timer.unref();
  return {run,async close(){closing=true;clearInterval(timer);await active;}};
}
