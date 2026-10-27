// Read-only rehearsal export. No production workers or Nest modules are loaded.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
require('dotenv').config({ path: process.env.MAKIT_SOURCE_ENV || '.env.local', quiet: true });

const kinds = ['REQUIREMENTS', 'ITERATIONS', 'COMMENTS', 'ACCEPTANCE', 'RELATIONS', 'COLLABORATION', 'BINDINGS', 'OPERATIONS'];
async function exportBase(output) {
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const auth = await tokenResponse.json();
  if (!tokenResponse.ok || auth.code !== 0 || !auth.tenant_access_token) throw new Error('Source authentication failed');
  const base = process.env.FEISHU_BASE_APP_TOKEN || process.env.FEISHU_BITABLE_APP_TOKEN || process.env.FEISHU_BASE_TOKEN;
  if (!base) throw new Error('Source base is not configured');
  async function read(route, params = {}) {
    const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(base)}/${route}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${auth.tenant_access_token}` },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0 || !result.data) throw new Error('Source export request rejected');
    return result.data;
  }
  async function pages(route, params) {
    const items = [], tokens = new Set();
    let pageToken = '';
    for (;;) {
      const data = await read(route, { page_size: '500', ...params, ...(pageToken ? { page_token: pageToken } : {}) });
      items.push(...(data.items || []));
      if (!data.has_more) return items;
      if (!data.page_token || tokens.has(data.page_token)) throw new Error('Incomplete source pagination');
      tokens.add(data.page_token); pageToken = data.page_token;
    }
  }
  const manifest = { version: 1, mode: 'rehearsal', exportedAt: new Date().toISOString(), collections: [] };
  for (const kind of kinds) {
    const id = process.env[`FEISHU_${kind}_TABLE`];
    if (!id) {
      // Missing source categories must be resolved explicitly, never treated as empty.
      throw new Error(`Missing source table configuration: ${kind}`);
    }
    const rawFields = await pages(`tables/${id}/fields`, { page_size: '200' });
    const fields = rawFields.map((field) => ({ id: field.field_id, name: field.field_name, type: String(field.type), options: field.property?.options || [], property: field.property || {} }));
    const records = await pages(`tables/${id}/records`, { user_id_type: 'open_id' });
    const employeeRecords = await pages(`tables/${id}/records`, { user_id_type: 'user_id' });
    const payload = JSON.stringify({ id, kind: kind.toLowerCase(), fields, records, employeeRecords });
    const file = `${kind.toLowerCase()}.json`;
    await fs.writeFile(path.join(output, file), payload, { mode: 0o600 });
    manifest.collections.push({ id, kind: kind.toLowerCase(), file, records: records.length, sha256: createHash('sha256').update(payload).digest('hex') });
    console.log(`${kind}: ${records.length} records, ${fields.length} fields`);
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
module.exports = { exportBase };
if (require.main === module) exportBase(path.resolve(process.argv[2] || '.local/source-base')).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
