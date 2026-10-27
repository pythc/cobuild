// Uses the official authenticated CLI. No managed DB connection string is read.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const appId = 'app_17b6pxwde0x';
function cli(args) {
  return JSON.parse(execFileSync('lark-cli', ['apps', ...args, '--app-id', appId,
    '--environment', 'online', '--as', 'user', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}
async function exportLargeTable(table, file) {
  // The standard CLI exporter has a 1 MiB response cap. Read immutable JSON
  // chunks through supported SELECT, checking a digest before and after.
  const source = `(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS payload FROM "${table}" AS t) AS snapshot`;
  const query = (text) => {
    const result = cli(['+db-execute', '--sql', text, '--yes']);
    if (!result.ok || !Array.isArray(result.data)) throw new Error('Chunk export failed');
    return result.data;
  };
  const [before] = query(`SELECT length(payload)::int AS size, md5(payload) AS digest FROM ${source}`);
  const parts = [];
  for (let offset = 1; offset <= before.size; offset += 65536) {
    const [part] = query(`SELECT substring(payload FROM ${offset} FOR 65536) AS part FROM ${source}`);
    if (typeof part.part !== 'string' || !part.part.length) throw new Error('Incomplete chunk');
    parts.push(part.part);
  }
  const content = parts.join('');
  const [after] = query(`SELECT length(payload)::int AS size, md5(payload) AS digest FROM ${source}`);
  if (after.digest !== before.digest || createHash('md5').update(content).digest('hex') !== before.digest) {
    throw new Error('Table changed during chunk export; repeat after stopping writes');
  }
  await fs.writeFile(file, content, { mode: 0o600 });
}
async function exportManaged(output) {
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  let token = '', tables = [];
  do {
    const result = cli(['+db-table-list', '--page-size', '100', ...(token ? ['--page-token', token] : [])]);
    if (!result.ok) throw new Error('Managed table list failed');
    tables.push(...result.data.items);
    if (result.data.has_more && (!result.data.page_token || result.data.page_token === token)) throw new Error('Incomplete managed schema pagination');
    token = result.data.has_more ? result.data.page_token : '';
  } while (token);
  const manifest = { version: 1, mode: 'rehearsal', exportedAt: new Date().toISOString(), tables: [] };
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]+$/.test(table.name)) throw new Error('Unexpected table identifier');
    const count = cli(['+db-execute', '--sql', `SELECT count(*)::int AS count FROM "${table.name}"`, '--yes']);
    if (!count.ok || !Array.isArray(count.data) || !Number.isInteger(count.data[0]?.count)) throw new Error('Cannot verify managed table count');
    const file = path.join(output, `${table.name}.json`);
    try {
      if (count.data[0].count >= 5000) throw new Error('Use verified complete chunk export');
      const receipt = cli(['+db-data-export', '--table', table.name, '--output', path.relative(process.cwd(), file), '--limit', '5000']);
      if (!receipt.ok) throw new Error('Managed export failed');
    } catch {
      await exportLargeTable(table.name, file);
    }
    await fs.chmod(file, 0o600);
    const content = await fs.readFile(file, 'utf8'), rows = JSON.parse(content);
    if (!Array.isArray(rows) || rows.length !== count.data[0].count) throw new Error('Managed count changed during rehearsal export');
    manifest.tables.push({ name: table.name, file: `${table.name}.json`, rows: rows.length,
      sha256: createHash('sha256').update(content).digest('hex') });
    console.log(`${table.name}: ${rows.length}`);
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
module.exports = { exportManaged };
if (require.main === module) exportManaged(path.resolve(process.argv[2] || '.local/source-managed')).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
