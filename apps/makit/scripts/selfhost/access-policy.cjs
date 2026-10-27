const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const postgres = require('postgres');
async function call(command, args=[]) {
  const {stdout} = await execute('lark-cli',['apps',command,'--app-id','app_17b6pxwde0x',...args,'--as','user','--json'],{maxBuffer:4*1024*1024});
  const value=JSON.parse(stdout); if(!value.ok) throw new Error('Official permission export failed'); return value.data;
}
async function exportPolicy(file) {
  const scope=await call('+access-scope-get'), roles=await call('+role-list');
  if(roles.has_more || !['Tenant','Range'].includes(scope.scope)) throw new Error('Source scope requires explicit migration design');
  const bindings=[];
  for(const role of roles.items) {
    if(!['admin','editor','viewer','operations_super_admin','operations_viewer'].includes(role.role_id)) throw new Error('Unknown source role');
    const members=await call('+role-member-list',['--role-id',role.role_id]);
    for(const [key,kind] of [['users','user'],['chats','chat'],['departments','department']])
      for(const id of members[key] || []) bindings.push({role:role.role_id,kind,id});
  }
  await fs.writeFile(file,JSON.stringify({version:1,exportedAt:new Date().toISOString(),scope,bindings},null,2),{mode:0o600});
  console.log(`Exported tenant access policy and ${bindings.length} explicit role bindings.`);
}
async function importPolicy(file) {
  const value=JSON.parse(await fs.readFile(file,'utf8'));
  if(value.version!==1 || !['Tenant','Range'].includes(value.scope?.scope) || !Array.isArray(value.bindings)) throw new Error('Invalid policy snapshot');
  for(const binding of value.bindings) if(!['admin','editor','viewer','operations_super_admin','operations_viewer'].includes(binding.role) ||
    !['user','chat','department'].includes(binding.kind) || typeof binding.id!=='string') throw new Error('Invalid role binding');
  const sql=postgres(process.env.MAKIT_MIGRATION_DATABASE_URL,{max:1});
  try { await sql.begin(async(tx)=>{
    await tx`SELECT pg_advisory_xact_lock(11020261019)`;
    const [previous]=await tx`SELECT * FROM makit_access_policy WHERE id`;
    if(previous) throw new Error('Permission policy is already imported; never overwrite live changes');
    await tx`INSERT INTO makit_access_policy(id,scope,users,departments,chats) VALUES(true,${value.scope.scope},
      ${tx.json(value.scope.users || [])},${tx.json(value.scope.departments || [])},${tx.json(value.scope.chats || [])})`;
    // Replace the initial rehearsal's flattened role snapshot with real bindings.
    // Group membership is re-evaluated at identity verification time.
    await tx`DELETE FROM makit_user_role`;
    for(const binding of value.bindings) {
      await tx`INSERT INTO makit_role_binding(role_id,kind,external_id) VALUES(${binding.role},${binding.kind},${binding.id})`;
      if(binding.kind==='user') await tx`INSERT INTO makit_user_role(user_id,role_id,source)
        SELECT u.id,${binding.role},'legacy' FROM makit_user u JOIN makit_directory d ON d.employee_id=u.employee_id WHERE d.open_id=${binding.id}
        ON CONFLICT DO NOTHING`;
    }
  }); console.log('Imported explicit application access policy.'); } finally {await sql.end();}
}
if(require.main===module) (process.argv[2]==='export'?exportPolicy:process.argv[2]==='import'?importPolicy:()=>{throw new Error('Use export or import');})(path.resolve(process.argv[3] || '.local/source-access.json'))
  .catch((error)=>{console.error(error.message);process.exitCode=1;});
module.exports={exportPolicy,importPolicy};
