const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash}=require('node:crypto');
const postgres = require('postgres');
async function importIdentities(directory='.local') {
  const root=await fs.realpath(directory);
  let contacts=null,manifestText;
  try {
    manifestText=await fs.readFile(path.join(root,'manifest.json'),'utf8');
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(manifestText) {
    const manifest=JSON.parse(manifestText);
    if(manifest.version!==1 || Object.keys(manifest.files||{}).length!==4)throw Error('Incomplete identity manifest');
    for(const file of ['identity-open-id-to-miaoda.json','identity-miaoda-to-union-id.json','effective-roles.json','identity-directory.json']){
      const bytes=await fs.readFile(path.join(root,file));
      if(createHash('sha256').update(bytes).digest('hex')!==manifest.files[file])throw Error('Identity checksum mismatch');
    }
    contacts=JSON.parse(await fs.readFile(path.join(root,'identity-directory.json'),'utf8'));
    if(contacts.length!==manifest.users)throw Error('Incomplete directory snapshot');
  }
  const openMapping = JSON.parse(await fs.readFile(path.join(root,'identity-open-id-to-miaoda.json'), 'utf8'));
  const unionMapping = JSON.parse(await fs.readFile(path.join(root,'identity-miaoda-to-union-id.json'), 'utf8'));
  if (!openMapping.ok || !unionMapping.ok || openMapping.data.missed.length || unionMapping.data.missed.length) {
    throw new Error('Identity mapping is incomplete');
  }
  const unions = new Map(unionMapping.data.items.map((item) => [item.source_id, item.target_id]));
  const users = new Map(openMapping.data.items.map((item) => [item.source_id, item.target_id]));
  if(openMapping.data.convert_type!=='open-id-to-miaoda' || unionMapping.data.convert_type!=='miaoda-to-union-id' ||
    users.size!==openMapping.data.items.length || unions.size!==unionMapping.data.items.length || users.size!==unions.size ||
    new Set(users.values()).size!==users.size || [...users.values()].some(id=>!unions.has(id)))throw Error('Identity mapping is not one-to-one');
  if(contacts!==null && (!Array.isArray(contacts) || contacts.length!==users.size || new Set(contacts.map(c=>c.user_id)).size!==users.size))throw Error('Directory identity count mismatch');
  for(const c of contacts||[])if(users.get(c.open_id)!==c.user_id || unions.get(c.user_id)!==c.union_id || !c.employee_id || !c.name || typeof c.active!=='boolean' || !Array.isArray(c.department_ids))throw Error('Invalid verified directory snapshot');
  const tenant = process.env.LAB_IDENTITY_TENANT_KEY;
  if (!tenant) throw new Error('Missing identity tenant');
  const roles = new Map();
  const effective = JSON.parse(await fs.readFile(path.join(root,'effective-roles.json'), 'utf8'));
  if (effective.length !== users.size) throw new Error('Effective role snapshot incomplete');
  for (const row of effective) {
    if (!users.has(row.openId) || !Array.isArray(row.result?.roles) || roles.has(row.openId)) throw new Error('Invalid effective role snapshot');
    const ids = row.result.roles.map((role) => role.role_id);
    if (ids.some((role) => !['admin','editor','viewer','operations_super_admin','operations_viewer'].includes(role))) throw new Error('Unknown role needs explicit migration');
    roles.set(row.openId, ids);
  }
  const sql = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(11020261021)`;
      const fingerprint=createHash('sha256').update(JSON.stringify({openMapping,unionMapping,effective,contacts})).digest('hex');
      const source='identities:app_17b6pxwde0x';
      const [prior]=await tx`SELECT manifest_sha256 FROM makit_migration_import WHERE source_id=${source}`;
      if(prior){if(prior.manifest_sha256!==fingerprint)throw Error('Identity target already imported from a different snapshot');return;}
      for(const c of contacts||[]){
        const changed=await tx`INSERT INTO makit_directory(employee_id,open_id,union_id,name,avatar_url,department_ids,active)
          VALUES(${c.employee_id},${c.open_id},${c.union_id},${c.name},${c.avatar_url},${tx.json(c.department_ids)},${c.active})
          ON CONFLICT(employee_id) DO UPDATE SET union_id=EXCLUDED.union_id,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,
            department_ids=EXCLUDED.department_ids,active=EXCLUDED.active WHERE makit_directory.open_id=EXCLUDED.open_id RETURNING employee_id`;
        if(!changed.length)throw Error('Verified directory mapping conflicts with existing data');
      }
      for (const [openId, id] of users) {
        const unionId = unions.get(id);
        if (!/^[0-9]{1,30}$/.test(id) || !/^on_[\w-]+$/.test(unionId || '')) throw new Error('Invalid verified user mapping');
        const [directory] = await tx`SELECT employee_id,active FROM makit_directory WHERE open_id = ${openId}`;
        if (!directory) throw new Error('Verified directory entry is missing');
        const [existing] = await tx`SELECT subject,employee_id FROM makit_user WHERE id = ${id}`;
        if (existing && (existing.subject !== `${tenant}:${unionId}` || existing.employee_id !== directory.employee_id)) throw new Error('Existing identity mapping differs');
        await tx`UPDATE makit_directory SET union_id = ${unionId} WHERE open_id = ${openId}`;
        await tx`INSERT INTO makit_user (id,subject,employee_id,active) VALUES (${id},${`${tenant}:${unionId}`},${directory.employee_id},${directory.active}) ON CONFLICT(id) DO NOTHING`;
        for (const role of roles.get(openId) || []) {
          await tx`INSERT INTO makit_user_role (user_id,role_id) VALUES (${id},${role}) ON CONFLICT DO NOTHING`;
        }
      }
      await tx`INSERT INTO makit_migration_import(source_id,manifest_sha256,counts) VALUES(${source},${fingerprint},${tx.json({users:users.size})})`;
    });
    console.log(`Imported ${users.size} verified legacy identities.`);
  } finally { await sql.end(); }
}
if (require.main === module) importIdentities(process.argv[2] || '.local').catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { importIdentities };
