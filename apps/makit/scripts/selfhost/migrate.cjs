// Separate migration credential; never run this with the application's login.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const postgres = require('postgres');

async function migrate() {
  if (!process.env.MAKIT_MIGRATION_DATABASE_URL) throw new Error('Missing migration database URL');
  const sql = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1, onnotice() {} });
  try {
    await sql`SELECT pg_advisory_lock(11020261016)`;
    const [existing] = await sql`SELECT to_regclass('public.makit_schema_migration') AS ledger`;
    if (!existing.ledger) {
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f')`;
      if (count) throw new Error('First migration requires an empty dedicated database; refusing an unrelated existing schema');
    }
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS makit_schema_migration (
        name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const directory = path.resolve('migrations/selfhost');
    const local = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const legacy = (await fs.readdir(path.resolve('migrations'))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const files = [
      ...local.filter((name) => name < '0003').map((name) => ({ name, file: path.join(directory, name), legacy: false })),
      ...legacy.map((name) => ({ name: `legacy/${name}`, file: path.resolve('migrations', name), legacy: true })),
      ...local.filter((name) => name >= '0003').map((name) => ({ name, file: path.join(directory, name), legacy: false })),
    ];
    for (const entry of files) {
      const { name } = entry;
      const source = await fs.readFile(entry.file, 'utf8');
      // Only the known, formerly managed schema is relocated. Do not rewrite
      // arbitrary SQL, identifiers, role checks, RLS policies or RPC bodies.
      const content = entry.legacy ? source.replace(/\bworkspace_aadknhjojzqdw\b/g, 'public')
        .replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, '') : source;
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      const [previous] = await sql`SELECT sha256 FROM makit_schema_migration WHERE name = ${name}`;
      if (previous) {
        if (previous.sha256 !== sha) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await sql.begin(async (tx) => {
        try { await tx.unsafe(content); }
        catch (error) { throw Object.assign(new Error(`Migration ${name} failed: ${error.message}`), { code: error.code }); }
        await tx`INSERT INTO makit_schema_migration (name, sha256) VALUES (${name}, ${sha})`;
      });
      console.log(`Applied ${name}`);
    }
  } finally {
    await sql.end();
  }
}
module.exports = { migrate };
if (require.main === module) migrate().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
