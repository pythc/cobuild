// Explicit, credential-free smoke check of one public repository. Not a daemon.
import {createGithubPublicSource,githubRepository} from '../packages/code-sources/github-public.mjs';
const url=process.argv[2];if(!githubRepository(url))throw Error('Pass an explicit https://github.com/owner/repo URL');
const calls=[];
const source=createGithubPublicSource({enabled:()=>true,fetchImpl:async(url,options)=>{
  if(new URL(url).origin!=='https://api.github.com'||options.method!=='GET'||Object.keys(options.headers).some(h=>/authorization|cookie/i.test(h)))throw Error('Read-only source boundary violated');
  const r=await fetch(url,options);calls.push({path:new URL(url).pathname,status:r.status});return r;
}});
try{
  const summary=await source.summary(url),pr=summary.pullRequests?.[0];
  const checks=pr?await source.checks(url,{number:pr.number,headSha:pr.headSha,repositoryId:summary.repository.repositoryId}):null;
  const report={date:new Date().toISOString(),scope:'Public GitHub GET only; no repository changes',repository:summary.repository||{url},summaryState:summary.state,readAt:summary.fetchedAt,
    pullCount:summary.pullRequests?.length,partial:summary.partial,reference:pr?.reference,
    checks:checks?{state:checks.state,headSha:checks.headSha,outcome:checks.outcome,sources:checks.sources,count:checks.checks?.length}:null,calls};
  report.passed=summary.state==='ready'&&!!checks&&checks.state==='ready';console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=2;
}finally{source.close();}
