const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
async function exportFiles(output) {
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const items=[], seen=new Set(); let token='';
  do {
    const { stdout } = await execute('lark-cli', ['apps', '+file-list', '--app-id', 'app_17b6pxwde0x', '--as', 'user', '--page-size', '200',
      ...(token?['--page-token',token]:[]),'--json'],{maxBuffer:4*1024*1024});
    const page=JSON.parse(stdout);
    if(!page.ok || !Array.isArray(page.data.items) || (page.data.has_more && (!page.data.page_token || seen.has(page.data.page_token)))) throw new Error('Incomplete file pagination');
    items.push(...page.data.items);token=page.data.has_more?page.data.page_token:'';seen.add(token);
  } while(token);
  if(new Set(items.map(item=>item.path)).size!==items.length) throw new Error('Duplicate source files');
  const files = [];
  // Bounded concurrency keeps the CLI and storage service responsive.
  const pending = [...items];
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const file = pending.shift(); if (!file) return;
      const key = createHash('sha256').update(file.path).digest('hex');
      const target = path.join(output, `${key}.blob`);
      await execute('lark-cli', ['apps', '+file-download', '--app-id', 'app_17b6pxwde0x', '--path', file.path,
        '--output', path.relative(process.cwd(), target), '--as', 'user', '--json'], { maxBuffer: 1024 * 1024 });
      const bytes = await fs.readFile(target);
      if (bytes.length !== file.size_bytes) throw new Error('Downloaded file size mismatch');
      await fs.chmod(target, 0o600);
      const bucket = new URL(file.download_url, 'https://source.invalid').pathname.match(/\/(bucket_[\w-]+)\//)?.[1];
      if (!bucket) throw new Error('Original storage bucket is not identifiable');
      files.push({ sourcePath: file.path.replace(/^\//, ''), sourceBucket: bucket, name: file.file_name,
        mimeType: file.type, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        blob: `${key}.blob`, uploadedAt: file.uploaded_at, uploadedBy: file.uploaded_by });
      console.log(`Downloaded ${files.length}/${items.length}`);
    }
  });
  const settled = await Promise.allSettled(workers);
  if (settled.some((result) => result.status === 'rejected')) throw new Error('File export incomplete; manifest was not written');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2), { mode: 0o600 });
}
module.exports = { exportFiles };
if (require.main === module) exportFiles(path.resolve(process.argv[2] || '.local/source-files')).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
