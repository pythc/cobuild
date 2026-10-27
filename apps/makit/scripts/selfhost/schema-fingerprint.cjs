const fs=require('node:fs/promises');
const {execFileSync}=require('node:child_process');
const postgres=require('postgres');
const {createHash}=require('node:crypto');
function queries(schema,tables) {
  if(!/^[a-z_0-9]+$/.test(schema) || tables.some((table)=>!/^[a-z_0-9]+$/.test(table))) throw new Error('Invalid catalogue identifiers');
  const names=tables.map((table)=>`'${table}'`).join(',');
  const relation=`n.nspname='${schema}' AND c.relname IN (${names})`;
  return {
    columns:`SELECT c.relname AS "table",a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",a.attidentity AS identity,pg_get_expr(d.adbin,d.adrelid) AS "default" FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE ${relation} AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
    constraints:`SELECT c.relname AS "table",k.conname AS name,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} ORDER BY c.relname,k.conname`,
    indexes:`SELECT c.relname AS "table",i.relname AS name,pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} ORDER BY c.relname,i.relname`,
    policies:`SELECT tablename AS "table",policyname AS name,permissive,roles,cmd,qual,with_check AS "check" FROM pg_policies WHERE schemaname='${schema}' AND tablename IN (${names}) ORDER BY tablename,policyname`,
    rls:`SELECT c.relname AS "table",c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} ORDER BY c.relname`,
    triggers:`SELECT c.relname AS "table",t.tgname AS name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    functions:`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,p.prosecdef AS "securityDefiner" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}' AND p.prokind='f' ORDER BY p.proname,arguments`,
  };
}
async function snapshot(target,file) {
  const manifest=JSON.parse(await fs.readFile('.local/source-managed/manifest.json','utf8'));
  const statements=queries(target==='source'?'workspace_aadknhjojzqdw':'public',manifest.tables.map((table)=>table.name));
  const result={version:1,target,capturedAt:new Date().toISOString(),catalogue:{}};
  const sql=target==='source'?null:postgres(process.env.MAKIT_MIGRATION_DATABASE_URL,{max:1});
  try {for(const [kind,query] of Object.entries(statements)) {
    if(target==='source') {
      const response=JSON.parse(execFileSync('lark-cli',['apps','+db-execute','--app-id','app_17b6pxwde0x','--environment','online','--as','user','--sql',query,'--yes','--json'],{encoding:'utf8',maxBuffer:8*1024*1024}));
      if(!response.ok || !Array.isArray(response.data)) throw new Error('Source catalogue export failed');
      result.catalogue[kind]=response.data;
    } else result.catalogue[kind]=Array.from(await sql.unsafe(query));
  }} finally {await sql?.end();}
  result.sha256=createHash('sha256').update(JSON.stringify(result.catalogue)).digest('hex');
  await fs.writeFile(file,JSON.stringify(result,null,2),{mode:0o600});
  console.log(Object.fromEntries(Object.entries(result.catalogue).map(([kind,rows])=>[kind,rows.length])));
}
async function compare(a,b,file) {
  const left=JSON.parse(await fs.readFile(a,'utf8')),right=JSON.parse(await fs.readFile(b,'utf8'));
  const stable=(value)=>Array.isArray(value)?value.map(stable):value && typeof value==='object'
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
  const normalize=(value)=>JSON.stringify(stable(value ?? null)).replaceAll('workspace_aadknhjojzqdw','public');
  const differences={};
  for(const kind of Object.keys(left.catalogue)) {
    const key=(row)=>[row.table || '',row.name || '',row.arguments || ''].join(':');
    const l=new Map(left.catalogue[kind].map((row)=>[key(row),row])),r=new Map(right.catalogue[kind].map((row)=>[key(row),row]));
    differences[kind]=[...new Set([...l.keys(),...r.keys()])].flatMap((id)=>normalize(l.get(id))===normalize(r.get(id))?[]:[{id,source:l.get(id) || null,target:r.get(id) || null}]);
  }
  await fs.writeFile(file,JSON.stringify(differences,null,2),{mode:0o600});
  console.log(Object.fromEntries(Object.entries(differences).map(([kind,rows])=>[kind,rows.length])));
}
if(require.main===module)(process.argv[2]==='compare'?compare(process.argv[3],process.argv[4],process.argv[5]):snapshot(process.argv[2],process.argv[3]))
  .catch((error)=>{console.error(error.message);process.exitCode=1;});
module.exports={queries,snapshot,compare};
