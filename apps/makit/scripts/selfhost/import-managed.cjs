const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const postgres = require('postgres');
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function importManaged(directory) {
  const root = await fs.realpath(directory);
  const text = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(text), tables = new Map();
  if (manifest.version !== 1 || !Array.isArray(manifest.tables) || manifest.tables.length < 34) throw new Error('Incomplete managed snapshot');
  for (const entry of manifest.tables) {
    if (!/^[a-z][a-z0-9_]+$/.test(entry.name) || entry.file !== `${entry.name}.json` || tables.has(entry.name)) throw new Error('Invalid managed snapshot entry');
    const file = await fs.realpath(path.join(root, entry.file));
    if (path.dirname(file) !== root) throw new Error('Snapshot path escaped directory');
    const content = await fs.readFile(file, 'utf8');
    if (digest(content) !== entry.sha256) throw new Error('Managed snapshot checksum mismatch');
    const rows = JSON.parse(content);
    if (!Array.isArray(rows) || rows.length !== entry.rows) throw new Error('Managed snapshot count mismatch');
    tables.set(entry.name, rows);
  }
  if (!process.env.MAKIT_MIGRATION_DATABASE_URL) throw new Error('Missing migration database URL');
  const sql = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1, onnotice() {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(11020261018)`;
      const source = 'managed:app_17b6pxwde0x';
      const [previous] = await tx`SELECT manifest_sha256 FROM makit_migration_import WHERE source_id = ${source}`;
      if (previous) {
        if (previous.manifest_sha256 !== digest(text)) throw new Error('Managed target already imported from another snapshot');
        return { duplicate: true };
      }
      const columns = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY ordinal_position`;
      const parents = await tx`SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
        WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`;
      const ordered = [], remaining = new Set(tables.keys());
      while (remaining.size) {
        const ready = [...remaining].filter((name) => !parents.some((edge) => edge.child === name && remaining.has(edge.parent)));
        if (!ready.length) throw new Error('Managed foreign key cycle requires an explicit migration');
        for (const name of ready) { ordered.push(name); remaining.delete(name); }
      }
      for (const name of ordered) {
        const [count] = await tx`SELECT count(*)::int AS value FROM ${tx(name)}`;
        if (count.value) throw new Error(`Managed target table must be empty: ${name}`);
        const allowed = columns.filter((column) => column.table_name === name).map((column) => column.column_name);
        if (!allowed.length) throw new Error(`Missing target table: ${name}`);
        const rows = tables.get(name);
        if (rows.some((row) => Object.keys(row).some((key) => !allowed.includes(key)))) throw new Error(`Target schema is incomplete: ${name}`);
        if (rows.length) {
          await tx`INSERT INTO ${tx(name)} (${tx(allowed)})
            SELECT ${tx(allowed)} FROM jsonb_populate_recordset(NULL::${tx(name)}, ${tx.json(rows)})`;
        }
        const [after] = await tx`SELECT count(*)::int AS value FROM ${tx(name)}`;
        if (after.value !== rows.length) throw new Error('Managed import count mismatch');
      }
      const counts = Object.fromEntries([...tables].map(([name, rows]) => [name, rows.length]));
      await tx`INSERT INTO makit_migration_import (source_id, manifest_sha256, counts)
        VALUES (${source}, ${digest(text)}, ${tx.json(counts)})`;
      return { duplicate: false, tables: tables.size, rows: [...tables.values()].reduce((sum, rows) => sum + rows.length, 0) };
    });
  } finally { await sql.end(); }
}
module.exports = { importManaged };
if (require.main === module) importManaged(path.resolve(process.argv[2] || '.local/source-managed')).then(console.log).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
