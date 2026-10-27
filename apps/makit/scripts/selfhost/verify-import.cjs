const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),postgres=require('postgres');
const {readSnapshot}=require('./import-base.cjs');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function verify(baseDirectory,managedDirectory,fileDirectory,blobDirectory,output) {
  const base=await readSnapshot(baseDirectory),managed=JSON.parse(await fs.readFile(path.join(managedDirectory,'manifest.json'),'utf8'));
  const files=JSON.parse(await fs.readFile(path.join(fileDirectory,'manifest.json'),'utf8'));
  const sql=postgres(process.env.MAKIT_MIGRATION_DATABASE_URL,{max:1}),report={version:1,verifiedAt:new Date().toISOString(),collections:[],tables:[],files:0,pass:false};
  try{
    for(const c of base.collections){
      const expected=c.records.map(r=>({record_id:r.record_id,fields:r.fields}));
      const [{differences}]=await sql`WITH expected AS (SELECT * FROM jsonb_to_recordset(${sql.json(expected)}) AS x(record_id text,fields jsonb)),
        actual AS (SELECT record_id,fields FROM makit_record WHERE collection_id=${c.id}),
        delta AS ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected))
        SELECT count(*)::int differences FROM delta`;
      if(differences)throw Error('Record content differs: '+c.kind);
      report.collections.push({kind:c.kind,rows:expected.length,exact:true});
    }
    for(const entry of managed.tables){
      if(!/^[a-z][a-z0-9_]+$/.test(entry.name)||entry.file!==entry.name+'.json')throw Error('Invalid snapshot identifier');
      const text=await fs.readFile(path.join(managedDirectory,entry.file),'utf8');if(digest(text)!==entry.sha256)throw Error('Snapshot checksum differs');
      // Normalize source and target through the same PostgreSQL row type. This
      // compares all values, including composite audit fields and timestamps.
      const [{differences}]=await sql`WITH expected AS (SELECT * FROM jsonb_populate_recordset(NULL::${sql(entry.name)},${sql.json(JSON.parse(text))})),
        delta AS ((SELECT * FROM expected EXCEPT ALL SELECT * FROM ${sql(entry.name)}) UNION ALL (SELECT * FROM ${sql(entry.name)} EXCEPT ALL SELECT * FROM expected))
        SELECT count(*)::int differences FROM delta`;
      if(differences)throw Error('Managed content differs: '+entry.name);
      report.tables.push({name:entry.name,rows:entry.rows,exact:true});
    }
    for(const file of files.files){
      if(!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid blob hash');
      const bytes=await fs.readFile(path.join(blobDirectory,file.sha256));if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error('Attachment content differs');
      const [row]=await sql`SELECT sha256,size_bytes FROM makit_file WHERE source_bucket=${file.sourceBucket} AND source_path=${file.sourcePath}`;
      if(!row||row.sha256!==file.sha256||Number(row.size_bytes)!==file.bytes)throw Error('Attachment metadata differs');report.files++;
    }
    const [{total,subjects}]=await sql`SELECT count(*)::int total,count(distinct subject_hash)::int subjects FROM mcp_personal_credential`;
    if(total!==subjects)throw Error('Duplicate MCP subjects');report.credentials={count:total,distinctSubjects:subjects};report.pass=true;
    await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});console.log({collections:report.collections.length,tables:report.tables.length,files:report.files,pass:true});
  } finally{await sql.end();}
  return report;
}
module.exports={verify};
if(require.main===module)verify(...process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
