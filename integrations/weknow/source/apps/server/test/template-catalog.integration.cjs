// Local synthetic QA only: verifies imported collections, images and rollback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const root = path.resolve(__dirname, '../../../../..');
const q = JSON.parse(fs.readFileSync(root + '/private/knowledge-office-20261014/qa-session.json'));
const env = JSON.parse(fs.readFileSync(root + '/private/knowledge-office-20261014/env.json'));
assert.equal(env.APP_URL, 'http://127.0.0.1:5840');
assert.match(env.DATABASE_URL, /@127\.0\.0\.1:5843\/docmost$/);
const db = postgres(env.DATABASE_URL, { max: 1, onnotice() {} });
const base = env.APP_URL + '/api', headers = { Cookie: 'authToken=' + q.owner.token };
let passed = 0;
async function post(p, body, expected = 200) {
 const r = await fetch(base + p, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const j = await r.json(); assert.equal(r.status, expected, p + ': ' + JSON.stringify(j)); return j.data ?? j;
}
async function check(name, fn) { await fn(); console.log('PASS ' + (++passed) + ' ' + name); }
const flat = rows => rows.flatMap(x => [x, ...flat(x.children || [])]);
(async () => {
 const list = (await post('/knowledge-templates/list', {})).items.filter(x => x.builtin);
 await check('catalogue has 33 document and 6 directory templates', async () => {
  assert.equal(list.length, 39); assert.equal(list.filter(x => x.kind === 'directory').length, 6);
 });
 const collections = [];
 for (const entry of list.filter(x => x.kind === 'directory')) collections.push(await post('/knowledge-templates/info', { id: entry.id }));
 await check('directory catalogue contains 70 documents and 24 folders without multidimensional tables', async () => {
  const all = collections.flatMap(x => flat(x.children));
  assert.equal(all.filter(x => x.kind === 'directory').length, 24);
  assert.equal(all.filter(x => x.kind !== 'directory').length, 70);
  assert.ok(!all.some(x => /月度OKR Review|客户管理|项目看板/.test(x.title)));
 });
 await check('all six collections create complete trees with stable sibling ordering', async () => {
  for (const template of collections) {
   const page = await post('/knowledge-templates/apply', { id: template.id, spaceId: q.spaceId, title: '模板演示 · ' + template.title });
   assert.equal(page.nodeType, 'folder'); assert.equal(page.hasChildren, true);
   async function visit(id, expected) {
    const children = await db`select id, title, node_type, position from pages where parent_page_id=${id} and deleted_at is null order by position collate "C"`;
    assert.equal(children.length, expected.length, template.title);
    assert.equal(new Set(children.map(x => x.position)).size, children.length);
    for (let i = 0; i < expected.length; i++) {
     assert.equal(children[i].title, expected[i].title);
     assert.equal(children[i].node_type, expected[i].kind === 'directory' ? 'folder' : 'page');
     await visit(children[i].id, expected[i].children || []);
    }
   }
   await visit(page.id, template.children);
  }
 });
 let imageTemplate, imagePage;
 for (const entry of list.filter(x => x.kind !== 'directory')) {
  const t = await post('/knowledge-templates/info', { id: entry.id });
  if (/\/api\/knowledge-templates\/assets\//.test(t.html)) { imageTemplate = t; break; }
 }
 assert.ok(imageTemplate, 'image template found');
 await check('bundled image is authenticated and PNG encoded', async () => {
  const image = imageTemplate.html.match(/src="(\/api\/knowledge-templates\/assets\/[a-f0-9]+)"/)[1];
  const denied = await fetch(env.APP_URL + image); assert.equal(denied.status, 401);
  const allowed = await fetch(env.APP_URL + image, { headers }); assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await allowed.arrayBuffer()); assert.equal(bytes.subarray(1,4).toString(), 'PNG');
 });
 await check('applied template owns copied image attachments', async () => {
  imagePage = await post('/knowledge-templates/apply', { id: imageTemplate.id, spaceId: q.spaceId, title: '图片模板验收 · ' + imageTemplate.title });
  const info = await post('/pages/info', { pageId: imagePage.id, format: 'html' });
  assert.ok(!info.content.includes('/knowledge-templates/assets/'));
  const attachments = await db`select id, page_id, workspace_id, space_id from attachments where page_id=${imagePage.id}`;
  assert.ok(attachments.length > 0); for (const a of attachments) { assert.equal(a.space_id, q.spaceId); assert.equal(a.workspace_id, q.workspaceId); }
  const url = info.content.match(/src="(\/api\/files\/[^\"]+)"/)[1];
  const r = await fetch(env.APP_URL + url, { headers }); assert.equal(r.status, 200);
 });
 await check('saving a built-in image template preserves image portability', async () => {
  const saved = await post('/knowledge-templates/save', { title: 'QA 图片模板另存', content: imageTemplate.markdown, format: 'markdown' });
  const applied = await post('/knowledge-templates/apply', { id: saved.id, spaceId: q.spaceId });
  const a = await db`select id from attachments where page_id=${applied.id}`; assert.ok(a.length > 0);
  await post('/knowledge-templates/delete', { id: saved.id, expectedUpdatedAt: saved.updatedAt });
 });
 await check('mid-collection failure rolls back all pages and attachments', async () => {
  const collection = collections.find(x => flat(x.children).some(y => /\/knowledge-templates\/assets\//.test(y.html || ''))) || collections[0];
  const target = flat(collection.children).filter(x => x.kind !== 'directory').at(-1).title;
  const before = await db`select count(*)::int n from pages where space_id=${q.spaceId}`;
  const beforeImages = await db`select count(*)::int n from attachments where space_id=${q.spaceId}`;
  const storageRoot = path.resolve(root, 'work/docmost/apps/server', env.STORAGE_LOCAL_PATH || 'storage');
  const scan = p => fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).flatMap(x => x.isDirectory() ? scan(path.join(p, x.name)) : [path.join(p, x.name)]) : [];
  const beforeFiles = scan(storageRoot).sort();
  try {
   await db.unsafe(`create or replace function kb_template_qa_fail() returns trigger language plpgsql as $$ begin if NEW.space_id = '${q.spaceId}'::uuid and NEW.title = '${target.replace(/'/g, "''")}' then raise exception 'synthetic collection failure'; end if; return NEW; end $$`);
   await db.unsafe('create trigger kb_template_qa_fail before insert on pages for each row execute function kb_template_qa_fail()');
   await post('/knowledge-templates/apply', { id: collection.id, spaceId: q.spaceId, title: 'QA 不应保留的文档集' }, 500);
  } finally {
   await db.unsafe('drop trigger if exists kb_template_qa_fail on pages');
   await db.unsafe('drop function if exists kb_template_qa_fail()');
  }
  assert.equal((await db`select count(*)::int n from pages where space_id=${q.spaceId}`)[0].n, before[0].n);
  assert.equal((await db`select count(*)::int n from attachments where space_id=${q.spaceId}`)[0].n, beforeImages[0].n);
  assert.deepEqual(scan(storageRoot).sort(), beforeFiles);
 });
 await check('native image template exports to PDF through Office engine', async () => {
  const task = await post('/office/convert', { pageId: imagePage.id, format: 'pdf', purpose: 'export' });
  let status;
  for (let i=0; i<60; i++) { status = await post('/office/task', { taskId: task.id }); if (['succeeded','failed'].includes(status.state)) break; await new Promise(r => setTimeout(r,1000)); }
  assert.equal(status.state, 'succeeded', JSON.stringify(status));
  const pdf = await fetch(base + '/office/result/' + task.id, { headers }); assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer()); assert.match(bytes.subarray(0,8).toString(), /^%PDF/);
  fs.writeFileSync(root + '/outputs/knowledge-refinements-20261014/template-image.pdf', bytes);
 });
 console.log(JSON.stringify({ passed, imagePage: imagePage.id }));
})().catch(e => { console.error(e); process.exitCode=1; }).finally(() => db.end());
