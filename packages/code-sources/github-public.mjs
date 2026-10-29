// Public GitHub read adapter. No credentials, legacy workers, or business writes.
const API = 'https://api.github.com';
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const text = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
const id = value => Number.isSafeInteger(value) && value > 0;
class SourceError extends Error { constructor(state) { super(state); this.state = state; } }
export function githubRepository(value) {
  const match = typeof value === 'string' && REPOSITORY.exec(value);
  if (!match) return null;
  const name = match[2].replace(/\.git$/, '');
  if (!name || ['.', '..'].includes(name)) return null;
  return { fullName: match[1] + '/' + name, url: 'https://github.com/' + match[1] + '/' + name };
}
const ref = (repo, extra = {}) => ({provider:'github', host:'github.com', repositoryId:String(repo.id), ...extra});
function pull(row, repo) {
  if (!id(row?.id) || !id(row.number) || !SHA.test(row.head?.sha) || row.base?.repo?.id !== repo.id || !['open','closed'].includes(row.state)) throw new SourceError('unavailable');
  return {reference:ref(repo,{pullRequestId:String(row.id),number:row.number,headSha:row.head.sha}),
    number:row.number,title:text(row.title),headSha:row.head.sha,
    state:row.merged_at ? 'merged' : row.state === 'closed' ? 'closed' : row.draft ? 'draft' : 'open',
    url:repo.url+'/pull/'+row.number};
}
function checkState(row) {
  if (['queued','in_progress','waiting','requested','pending'].includes(row.status)) return 'running';
  if (row.status !== 'completed') return 'unknown';
  return ({success:'passed',failure:'failed',timed_out:'failed',action_required:'failed',cancelled:'cancelled',neutral:'neutral',skipped:'skipped',stale:'unknown'})[row.conclusion] || 'unknown';
}
export function createGithubPublicSource({enabled=()=>false, fetchImpl=globalThis.fetch, now=Date.now, timeoutMs=8000, cacheMs=60000}={}) {
  const cache=new Map(), pending=new Map(), controllers=new Set();
  let closed=false, generation=0, blockedUntil=0;
  function clear() { generation++;cache.clear();pending.clear();for(const c of controllers)c.abort();controllers.clear(); }
  function active() { if(closed || !enabled()) { clear();return false; } return true; }
  const retry = () => Math.max(1,Math.ceil((blockedUntil-now())/1000));
  async function request(path,signal) {
    if(!active())throw new SourceError('disabled');
    if(now()<blockedUntil)throw new SourceError('rate_limited');
    const response=await fetchImpl(API+path,{method:'GET',redirect:'manual',credentials:'omit',signal,
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'CoBuild-public-code-reader'}});
    if(response.status!==200){
      await response.body?.cancel();
      if(response.status===429 || response.status===403 && (response.headers.get('x-ratelimit-remaining')==='0' || response.headers.has('retry-after'))){
        const after=response.headers.get('retry-after');
        const until=after ? (/^\d+$/.test(after)?now()+Number(after)*1000:Date.parse(after)) : Number(response.headers.get('x-ratelimit-reset'))*1000;
        blockedUntil=Math.max(blockedUntil,now()+Math.min(3600000,Math.max(60000,Number.isFinite(until)?until-now():60000)));
        throw new SourceError('rate_limited');
      }
      if(response.status>=300 && response.status<400)throw new SourceError('repository_moved');
      throw new SourceError(response.status===404?'not_found':response.status===403?'restricted':'unavailable');
    }
    const reader=response.body?.getReader();if(!reader)throw new SourceError('unavailable');
    const chunks=[];let size=0;
    try {
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>1024*1024)throw new SourceError('unavailable');chunks.push(value);}
      return {data:JSON.parse(Buffer.concat(chunks).toString('utf8')),partial:/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('link')||'')};
    } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  }
  async function repository(selected,signal) {
    const path='/repos/'+selected.fullName;
    const {data}=await request(path,signal);
    if(!id(data?.id) || typeof data.private!=='boolean')throw new SourceError('unavailable');
    if(data.private || data.visibility && data.visibility!=='public')throw new SourceError('restricted');
    if(data.full_name?.toLowerCase()!==selected.fullName.toLowerCase())throw new SourceError('repository_moved');
    return {id:data.id,fullName:selected.fullName,url:selected.url,path};
  }
  async function run(url,key,work) {
    if(!active())return {state:'disabled'};
    if(!url)return {state:'not_configured'};
    const selected=githubRepository(url);if(!selected)return {state:'unsupported'};
    const cacheKey=selected.fullName.toLowerCase()+':'+key;
    if(now()<blockedUntil)return {state:'rate_limited',retryAfter:retry()};
    const hit=cache.get(cacheKey);
    if(hit && hit.expires>now())return {...structuredClone(hit.value),cached:true};
    if(pending.has(cacheKey))return structuredClone(await pending.get(cacheKey));
    if(controllers.size>=2)return {state:'busy',retryAfter:2};
    const epoch=generation,controller=new AbortController();controllers.add(controller);
    // Entire read has one deadline, including metadata, checks, and body consumption.
    const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
    const promise=(async()=>{
      try {
        const value=await work(selected,controller.signal);
        if(!active() || epoch!==generation)return {state:'disabled'};
        const result={...value,fetchedAt:new Date(now()).toISOString(),cached:false};
        cache.delete(cacheKey);cache.set(cacheKey,{expires:now()+cacheMs,value:result});
        while(cache.size>64)cache.delete(cache.keys().next().value);
        return result;
      } catch(error) {
        if(!active() || epoch!==generation)return {state:'disabled'};
        const state=controller.signal.aborted?'timeout':error instanceof SourceError?error.state:'unavailable';
        return {state,...(state==='rate_limited'?{retryAfter:retry()}:{})};
      } finally { clearTimeout(timer);controllers.delete(controller);if(epoch===generation)pending.delete(cacheKey); }
    })();
    pending.set(cacheKey,promise);return structuredClone(await promise);
  }
  return {
    // Both methods take an explicit selected repository; no name-based project lookup.
    summary(url) { return run(url,'summary',async(selected,signal)=>{
      const repo=await repository(selected,signal);
      const {data,partial}=await request(repo.path+'/pulls?state=all&sort=updated&direction=desc&per_page=5',signal);
      if(!Array.isArray(data)||data.length>5)throw new SourceError('unavailable');
      return {state:'ready',repository:{...ref(repo),fullName:repo.fullName,url:repo.url},pullRequests:data.map(row=>pull(row,repo)),partial};
    }); },
    checks(url,{number,headSha,repositoryId}={}) {
      if(!id(number)||!SHA.test(headSha)||!/^\d{1,16}$/.test(repositoryId||''))return Promise.resolve({state:'invalid_request'});
      return run(url,`checks:${repositoryId}:${number}:${headSha}`,async(selected,signal)=>{
        const repo=await repository(selected,signal);
        const invalidateSummary=()=>cache.delete(selected.fullName.toLowerCase()+':summary');
        if(String(repo.id)!==repositoryId){invalidateSummary();throw new SourceError('repository_changed');}
        const current=pull((await request(repo.path+'/pulls/'+number,signal)).data,repo);
        if(current.number!==number)throw new SourceError('unavailable');
        if(current.headSha!==headSha){invalidateSummary();return {state:'head_changed',headSha:current.headSha};}
        const endpoints=[repo.path+'/commits/'+headSha+'/check-runs?per_page=20&filter=latest',repo.path+'/commits/'+headSha+'/status?per_page=20'];
        const responses=await Promise.allSettled(endpoints.map(path=>request(path,signal)));
        const rows=[],sources=[];
        for(let i=0;i<responses.length;i++){
          const response=responses[i],source=i?'statuses':'checks';
          if(response.status==='rejected'){sources.push({source,state:response.reason instanceof SourceError?response.reason.state:'unavailable'});continue;}
          const {data,partial}=response.value,items=i?data?.statuses:data?.check_runs;
          if(!Array.isArray(items)||items.length>20||!Number.isSafeInteger(data.total_count)||data.total_count<items.length || i && data.sha!==headSha){sources.push({source,state:'unavailable'});continue;}
          let valid=true;const parsed=[];
          for(const item of items){
            if(!id(item.id) || !i && item.head_sha!==headSha){valid=false;break;}
            parsed.push({id:String(item.id),source,name:text(i?item.context:item.name),
              state:i?({success:'passed',failure:'failed',error:'failed',pending:'running'}[item.state]||'unknown'):checkState(item)});
          }
          if(!valid){sources.push({source,state:'unavailable'});continue;}
          rows.push(...parsed);sources.push({source,state:partial||data.total_count>items.length?'partial':'ready'});
        }
        // Concurrent force pushes must not present the old head as current.
        const latest=pull((await request(repo.path+'/pulls/'+number,signal)).data,repo);
        if(latest.number!==number||latest.reference.pullRequestId!==current.reference.pullRequestId)throw new SourceError('unavailable');
        if(latest.headSha!==headSha){invalidateSummary();return {state:'head_changed',headSha:latest.headSha};}
        const complete=sources.every(s=>s.state==='ready');
        const anyAvailable=sources.some(s=>['ready','partial'].includes(s.state));
        const state=complete?'ready':anyAvailable?'partial':'unavailable';
        const outcome=!complete?'unknown':!rows.length?'none':rows.some(r=>r.state==='failed')?'failed':rows.some(r=>r.state==='running')?'running':rows.every(r=>r.state==='passed')?'passed':'other';
        return {state,reference:current.reference,headSha,scope:'pull_request_head',url:current.url+'/checks',outcome,sources,checks:rows};
      });
    },
    close() { closed=true;clear(); },
  };
}
