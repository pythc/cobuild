const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {readSnapshot}=require('./import-base.cjs');
function cli(command,args=[]) {
  const value=JSON.parse(execFileSync('lark-cli',['apps',command,...args,'--as','user','--json'],{encoding:'utf8',maxBuffer:4*1024*1024}));
  if(!value.ok)throw Error('Official identity export failed');return value;
}
async function convert(type,ids) {
  const items=[];
  for(let i=0;i<ids.length;i+=100){
    const value=cli('+user-id-convert',['--convert-type',type,'--ids',ids.slice(i,i+100).join(',')]);
    if(value.data.missed.length || value.data.items.length!==Math.min(100,ids.length-i))throw Error('Incomplete official identity conversion');
    items.push(...value.data.items);
  }
  if(new Set(items.map(item=>item.source_id)).size!==ids.length)throw Error('Duplicate identity conversion');
  return {ok:true,data:{convert_type:type,items,missed:[]}};
}
function managedUserIds(rows) {
  return rows.flatMap(row=>Object.entries(row).flatMap(([key,value])=>{
    if(!['_created_by','_updated_by'].includes(key) && !key.endsWith('user_id'))return [];
    if(typeof value!=='string')return [];
    const match=/^(?:([0-9]{1,30})|\(([0-9]{1,30})\))$/.exec(value);return match?[match[1]||match[2]]:[];
  }));
}
async function exportIdentities(baseDirectory,managedDirectory,output) {
  const snapshot=await readSnapshot(baseDirectory),openIds=new Set(snapshot.collections.flatMap(c=>c.directory.filter(p=>p.employee_id).map(p=>p.open_id)));
  const root=await fs.realpath(managedDirectory),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')),legacyIds=new Set();
  for(const entry of manifest.tables){
    if(!/^[a-z][a-z0-9_]+\.json$/.test(entry.file))throw Error('Invalid snapshot path');
    const text=await fs.readFile(path.join(root,entry.file),'utf8');
    if(createHash('sha256').update(text).digest('hex')!==entry.sha256)throw Error('Managed snapshot checksum mismatch');
    for(const id of managedUserIds(JSON.parse(text)))legacyIds.add(id);
  }
  const referenced=await convert('miaoda-to-open-id',[...legacyIds]);
  for(const item of referenced.data.items)openIds.add(item.target_id);
  const opened=await convert('open-id-to-miaoda',[...openIds]),unions=await convert('miaoda-to-union-id',opened.data.items.map(item=>item.target_id));
  const auth=await(await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET}),
    redirect:'error',signal:AbortSignal.timeout(15000)})).json();
  if(auth.code!==0||!auth.tenant_access_token)throw Error('Cannot verify the migration directory');
  const effective=[],directory=[];
  for(const openId of openIds){
    const value=cli('+role-match-list',['--app-id','app_17b6pxwde0x','--user-id',openId]);
    effective.push({openId,result:value.data});
    const id=opened.data.items.find(item=>item.source_id===openId).target_id;
    const union=unions.data.items.find(item=>item.source_id===id).target_id;
    const r=await fetch('https://open.feishu.cn/open-apis/contact/v3/users/'+encodeURIComponent(union)+'?user_id_type=union_id&department_id_type=open_department_id',{
      headers:{Authorization:'Bearer '+auth.tenant_access_token},redirect:'error',signal:AbortSignal.timeout(15000)});
    const contact=await r.json(),u=contact.data?.user;
    if(!r.ok||contact.code!==0||u?.union_id!==union||u?.open_id!==openId||!u.user_id||!u.name||!u.status)throw Error('Incomplete verified migration directory');
    directory.push({user_id:id,employee_id:u.user_id,open_id:openId,union_id:union,name:u.name,avatar_url:u.avatar?.avatar_240||'',
      department_ids:u.department_ids||[],active:u.status.is_activated===true&&!u.status.is_resigned&&!u.status.is_frozen&&!u.status.is_exited});
  }
  await fs.mkdir(output,{mode:0o700,recursive:true});
  const files={};
  for(const [file,value]of [['identity-open-id-to-miaoda.json',opened],['identity-miaoda-to-union-id.json',unions],['effective-roles.json',effective],['identity-directory.json',directory]]){
    const content=JSON.stringify(value);files[file]=createHash('sha256').update(content).digest('hex');
    await fs.writeFile(path.join(output,file),content,{mode:0o600});
  }
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({version:1,exportedAt:new Date().toISOString(),users:directory.length,files}),{mode:0o600});
  console.log(`Exported ${openIds.size} official identity mappings and effective roles.`);
}
module.exports={managedUserIds,exportIdentities};
if(require.main===module)exportIdentities(...process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
