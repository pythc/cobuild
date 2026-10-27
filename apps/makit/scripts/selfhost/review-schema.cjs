const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const decisions=require('./schema-decisions.json');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort().map(([k,x])=>[k,stable(x)])):v;
const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const sha=v=>createHash('sha256').update(v?.definition||'absent').digest('hex');
const schema=s=>s.replaceAll('workspace_aadknhjojzqdw','public');
function enumExpression(s){
 const compact=s.replace(/::(?:character varying|text)(?:\[\])?/g,'').replace(/[()\s]/g,'').replace(/^CHECK/,'');
 const match=/^(?:([a-z_]+)ISNULLOR)?([a-z_]+)=ANYARRAY\[(?:'(?:[^']|'')*'(?:,'(?:[^']|'')*')*)\]$/.exec(compact);
 return match&&(!match[1]||match[1]===match[2])?compact:null;
}
function policy(row){
 if(!row)return row;const value={...row};
 value.roles=(Array.isArray(row.roles)?row.roles:row.roles.replace(/[{}]/g,'').split(','))
  .map(r=>r.replace(/_(?:workspace_aadknhjojzqdw|public)$/,'')).sort();
 for(const key of ['qual','check'])if(value[key])value[key]=schema(value[key]).replaceAll('((_created_by).user_id)::text','(_created_by).user_id');
 return value;
}
async function review(file,output){
 const differences=JSON.parse(await fs.readFile(file,'utf8')),approved=[],unresolved=[];
 for(const [kind,rows]of Object.entries(differences))for(const row of rows){
  let reason;
  if(kind==='constraints'&&row.source&&row.target&&enumExpression(row.source.definition)&&enumExpression(row.source.definition)===enumExpression(row.target.definition))reason='PostgreSQL enum-array deparser difference';
  if(kind==='indexes'&&row.source&&row.target){
   const [l,lp]=schema(row.source.definition).split(' WHERE '),[r,rp]=row.target.definition.split(' WHERE ');
   if(l===r&&lp&&rp&&enumExpression(lp)&&enumExpression(lp)===enumExpression(rp))reason='PostgreSQL enum-array deparser difference';
  }
  if(kind==='policies'){
   if(equal(policy(row.source),policy(row.target)))reason='Explicit inherited role relocation and text-composite cast equivalence';
   else if(!row.source&&['pull_request_refresh_lease_anon_deny','pull_request_refresh_lease_authenticated_deny'].includes(row.target?.name)&&
    row.target.table==='pull_request_refresh_lease'&&row.target.permissive==='RESTRICTIVE'&&row.target.qual==='false'&&row.target.check==='false'&&row.target.cmd==='ALL'&&
    equal(row.target.roles,[row.target.name.endsWith('_anon_deny')?'anon':'authenticated']))reason='Service-only lease table explicitly denies browser/anonymous access';
  }
  if(kind==='functions'&&row.source&&row.target&&schema(row.source.definition).trim()===row.target.definition.replace(/^ SET search_path TO 'pg_catalog', 'public', 'pg_temp'\n/m,'').trim())reason='Fixed SECURITY DEFINER search_path';
  const pinned=decisions[kind]?.find(d=>d.id===row.id&&d.sourceSha256===sha(row.source)&&d.targetSha256===sha(row.target));
  if(pinned)reason=pinned.reason;
  if(reason)approved.push({kind,id:row.id,reason});else unresolved.push({kind,id:row.id});
 }
 const report={version:1,reviewedAt:new Date().toISOString(),approvedDifferences:approved,unresolved,pass:unresolved.length===0};
 await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
 console.log({approved:approved.length,unresolved:unresolved.length,pass:report.pass});
 if(unresolved.length){console.error(unresolved);process.exitCode=1;}
 return report;
}
module.exports={review,enumExpression,policy};
if(require.main===module)review(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});
