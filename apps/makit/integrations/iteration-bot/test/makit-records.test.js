import test from 'node:test';
import assert from 'node:assert/strict';
import { createMakitRecords } from '../src/makit-records.js';
import { createLarkCli } from '../src/lark-cli.js';
import { createBaseStore } from '../src/base.js';

const config = { storage: 'makit', makit: { url: 'https://makit.example.com', token: 'b'.repeat(43) },
  identities: { base: 'bot' }, tables: { requirements: 'tbl1', iterations: 'tbl2', bindings: 'tbl3', operations: 'tbl4', collaboration: 'tbl5' } };
test('refuses unsafe origins and incomplete collection maps', () => {
  for (const url of ['http://makit.example.com', 'https://evil.example/path', 'https://user:pass@makit.example.com', 'https://makit.example.com/?token=secret'])
    assert.throws(() => createMakitRecords({ ...config, makit: { ...config.makit, url } }));
  assert.throws(() => createMakitRecords({ ...config, tables: { requirements: 'tbl1' } }));
});
test('pages the real bot store through native records and preserves open IDs and literal content', async () => {
  const seen = [];
  const adapter = createMakitRecords(config, async (url, init) => {
    seen.push(JSON.parse(init.body)); assert.equal(url.href, 'https://makit.example.com/openapi/iteration-bot/records');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer ' + config.makit.token);
    const body = seen.at(-1), items = [{ record_id: body.offset ? 'rec2' : 'rec1', fields: { '需求': '逐字 \\n 原文', '当前处理人': [{ id: 'ou_member', name: '成员' }] } }];
    return new Response(JSON.stringify({ source: 'makit-postgres-v1', items, hasMore: body.offset === 0 }));
  });
  const base = createBaseStore(config, { json: adapter });
  const rows = await base.listAllRequirements();
  assert.equal(rows.length, 2); assert.equal(rows[0].title, '逐字 \\n 原文');
  assert.equal(rows[0].handlers[0].id, 'ou_member'); assert.deepEqual(seen.map((x) => x.offset), [0, 1]);
});
test('never falls back or retries a rejected or ambiguous mutation', async () => {
  for (const outcome of ['reject', 'throw', 'wrong-source']) {
    let count = 0;
    const adapter = createMakitRecords(config, async () => {
      count++; if (outcome === 'throw') throw Error('network');
      return new Response(JSON.stringify({ source: 'wrong' }), { status: outcome === 'reject' ? 503 : 200 });
    });
    await assert.rejects(() => adapter(['base', '+record-upsert', '--table-id', 'tbl1', '--record-id', 'rec1', '--json', '{"最近通知摘要":"完成"}']));
    assert.equal(count, 1);
  }
});
test('rejects unknown operations and empty has-more pages', async () => {
  const adapter = createMakitRecords(config, async () => new Response(JSON.stringify({ source: 'makit-postgres-v1', items: [], hasMore: true })));
  await assert.rejects(() => adapter(['base', '+record-list', '--table-id', 'tbl1']));
  await assert.rejects(() => adapter(['base', '+record-list', '--table-id', 'other']));
  await assert.rejects(() => adapter(['base', '+record-delete-all', '--table-id', 'tbl1']));
  await assert.rejects(() => adapter(['base', '+record-list', '--table-id', 'tbl1', '--unsafe', 'true']));
});
test('native mode blocks direct legacy CLI execution before spawning a child', async () => {
  const cli = createLarkCli({ ...config, runtime: { larkCliPath: '/must-not-run' } });
  await assert.rejects(() => cli.exec(['base', '+record-list']), /Bitable CLI is retired/);
});
