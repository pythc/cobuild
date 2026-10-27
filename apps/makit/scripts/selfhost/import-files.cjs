const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const postgres = require('postgres');
async function importFiles(directory, destination) {
  const root = await fs.realpath(directory), output = path.resolve(destination);
  const text = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(text);
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid file manifest');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const files = [];
  for (const entry of manifest.files) {
    if (!/^[a-f0-9]{64}\.blob$/.test(entry.blob) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid blob key');
    const input = await fs.realpath(path.join(root, entry.blob));
    if (path.dirname(input) !== root) throw new Error('Blob path escaped snapshot directory');
    const bytes = await fs.readFile(input);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Blob integrity mismatch');
    const file = path.join(output, entry.sha256);
    try { await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stored = await fs.readFile(file);
      if (createHash('sha256').update(stored).digest('hex') !== entry.sha256) throw new Error('Existing blob differs');
    }
    files.push(entry);
  }
  const sql = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      for (const entry of files) {
        const key = createHash('sha256').update(`${entry.sourceBucket}:${entry.sourcePath}`).digest('hex').slice(0, 32);
        const id = `${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20)}`;
        const [previous] = await tx`SELECT sha256 FROM makit_file WHERE id = ${id}`;
        if (previous && previous.sha256 !== entry.sha256) throw new Error('Existing attachment metadata differs');
        await tx`INSERT INTO makit_file (id,source_bucket,source_path,original_name,mime_type,size_bytes,sha256,storage_key)
          VALUES (${id},${entry.sourceBucket},${entry.sourcePath},${entry.name},${entry.mimeType || 'application/octet-stream'},${entry.bytes},${entry.sha256},${entry.sha256})
          ON CONFLICT (id) DO NOTHING`;
      }
    });
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  } finally { await sql.end(); }
}
module.exports = { importFiles };
if (require.main === module) importFiles(path.resolve(process.argv[2] || '.local/source-files'), process.env.MAKIT_FILE_DIRECTORY || '.local/files').then(console.log).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
