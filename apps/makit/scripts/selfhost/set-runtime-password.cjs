const postgres=require('postgres');
async function setRuntimePassword() {
  const password=process.env.MAKIT_APPLICATION_PASSWORD;
  if(!process.env.MAKIT_MIGRATION_DATABASE_URL || !password || password.length<32 || password.length>256 || /[\x00-\x1f]/.test(password)) throw new Error('Explicit migration URL and strong application password required');
  const sql=postgres(process.env.MAKIT_MIGRATION_DATABASE_URL,{max:1,onnotice(){}});
  try {
    // PostgreSQL utility statements cannot bind a password parameter. Quote as
    // a standard string literal; do not log the query or the supplied secret.
    await sql`SET standard_conforming_strings=on`;
    await sql.unsafe("ALTER ROLE makit_application PASSWORD '"+password.replaceAll("'","''")+"'");
    console.log('Restricted application login configured.');
  } finally {await sql.end();}
}
if(require.main===module)setRuntimePassword().catch(()=>{console.error('Application login configuration failed.');process.exitCode=1;});
module.exports={setRuntimePassword};
