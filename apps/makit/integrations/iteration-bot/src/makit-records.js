import { randomUUID } from 'node:crypto';

/** Retain the proven bot store and delivery state; replace only its data transport. */
export function createMakitRecords(config, fetchImpl = fetch) {
  if (config.storage !== 'makit') return null;
  const url = new URL(config.makit?.url || '');
  const local = process.env.NODE_ENV !== 'production' && config.makit?.allowLoopback === true &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/') throw new Error('Makit data source must be an HTTPS origin');
  const token = config.makit?.token;
  if (typeof token !== 'string' || token.length < 32) throw new Error('Dedicated Makit bot credential required');
  const collections = new Map(Object.entries(config.tables || {}).map(([name, id]) => [id, name]));
  if (collections.size !== 5 || [...collections.keys()].some((id) => typeof id !== 'string' || !id))
    throw new Error('Five distinct imported collection IDs are required');
  const endpoint = new URL('/openapi/iteration-bot/records', url);
  return async function records(args) {
    if (args[0] !== 'base') throw new Error('Unexpected Makit data operation');
    const options = new Map(), fieldNames = [];
    for (let i = 2; i < args.length; i++) {
      const flag = args[i];
      if (!['--base-token', '--as', '--table-id', '--limit', '--offset', '--field-id', '--json', '--record-id', '--yes'].includes(flag))
        throw new Error('Unsupported Makit data option');
      if (flag === '--yes') continue;
      const value = args[++i];
      if (value === undefined && flag !== '--base-token') throw new Error('Missing Makit data option');
      if (flag === '--field-id') fieldNames.push(value); else options.set(flag, value);
    }
    const collection = collections.get(options.get('--table-id'));
    if (!collection) throw new Error('Unknown Makit collection');
    const operation = ({ '+record-list': 'list', '+record-upsert': 'upsert', '+record-delete': 'delete' })[args[1]];
    if (!operation) throw new Error('Unsupported Makit data operation');
    const body = { operation, collection };
    if (operation === 'list') {
      body.offset = Number(options.get('--offset') || 0); body.limit = Number(options.get('--limit') || 200);
      if (fieldNames.length) body.fieldNames = fieldNames;
    } else {
      body.requestId = randomUUID();
      if (options.get('--record-id')) body.recordId = options.get('--record-id');
      if (operation === 'upsert') body.fields = JSON.parse(options.get('--json') || '{}');
    }
    // No fallback to Bitable, redirects or automatic mutation retries.
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Makit data request rejected (${response.status})`);
    const result = await response.json();
    if (result?.source !== 'makit-postgres-v1') throw new Error('Unexpected Makit data source');
    if (operation !== 'list') return { data: result.item };
    if (!Array.isArray(result.items) || typeof result.hasMore !== 'boolean' ||
      result.items.length > body.limit || (result.hasMore && !result.items.length)) throw new Error('Incomplete Makit data page');
    const fields = fieldNames.length ? fieldNames : [...new Set(result.items.flatMap((r) => Object.keys(r.fields)))];
    return { data: { fields, data: result.items.map((r) => fields.map((name) => r.fields[name])),
      record_id_list: result.items.map((r) => r.record_id), has_more: result.hasMore } };
  };
}
