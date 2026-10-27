import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { WorkspaceRecordStore } from '../../server/database/workspace-record.store';
import { FeishuService } from '../../server/modules/requirements/feishu.service';

describe('self-hosted authoritative PostgreSQL records', () => {
  let owner: Sql, application: Sql, store: WorkspaceRecordStore;
  const id = `test-${randomUUID()}`;
  const employee = `employee-${randomUUID()}`, open = `ou_${randomUUID()}`;
  beforeAll(async () => {
    const ownerUrl = process.env.MAKIT_MIGRATION_DATABASE_URL;
    const applicationUrl = process.env.MAKIT_DATABASE_URL;
    if (!ownerUrl || !applicationUrl || new URL(ownerUrl).hostname !== '127.0.0.1') {
      throw new Error('Explicit isolated local database credentials required');
    }
    owner = postgres(ownerUrl, { max: 1 }); application = postgres(applicationUrl, { max: 4 });
    store = new WorkspaceRecordStore(application);
    await owner`INSERT INTO makit_directory (employee_id,open_id,name) VALUES (${employee},${open},'测试成员')`;
    await owner`INSERT INTO makit_collection (id,kind,fields) VALUES (${id},${id}, ${owner.json([
      { id: 'title', name: '需求', type: '1', options: [] },
      { id: 'person', name: '当前处理人', type: '11', options: [] },
      { id: 'link', name: '所属迭代', type: '21', options: [] },
      { id: 'updated', name: '更新时间', type: '1002', options: [] },
      { id: 'forward', name: '关联记录', type: '21', options: [], property: {table_id:id,back_field_name:'反向关联'} },
      { id: 'back', name: '反向关联', type: '21', options: [], property: {table_id:id,back_field_name:'关联记录'} },
      { id: 'code', name: '需求编号', type: '1005', options: [], property: { auto_serial: { type: 'custom', options: [
        { type: 'fixed_text', value: 'REQ-' }, { type: 'created_time', value: 'yyyyMMdd' }, { type: 'system_number', value: '4' },
      ] } } },
    ])})`;
  });
  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM makit_record WHERE collection_id = ${id}`;
      await owner`DELETE FROM makit_collection WHERE id = ${id}`;
      await owner`DELETE FROM makit_directory WHERE employee_id = ${employee}`;
      await owner.end();
    }
    await application?.end();
  });
  it('uses a non-superuser application login', async () => {
    const [role] = await application`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await expect(application`SELECT * FROM mcp_personal_credential`).rejects.toThrow();
  });
  it('creates stable records with real auto-number and time semantics', async () => {
    const row = await store.createRecord(id, { 需求: '第一条', 当前处理人: [{ id: employee }] }, 'user_id');
    expect(row.record_id).toMatch(/^rec[a-f0-9]+$/);
    expect(row.fields['需求编号']).toMatch(/^REQ-\d{8}0001$/);
    expect(row.fields['更新时间']).toEqual(expect.any(Number));
    expect(row.fields['当前处理人']).toEqual([{ id: employee, name: '测试成员' }]);
    const canonical = await store.getRecord(id, row.record_id);
    expect(canonical.fields['当前处理人']).toEqual([{ id: open, name: '测试成员' }]);
  });
  it('searches linked IDs exactly and accepts Unicode/apostrophes as parameters', async () => {
    const row = await store.createRecord(id, { 需求: "O'Reilly 中文", 所属迭代: ['rec10'] });
    const none = await store.searchRecords(id, { conjunction: 'and', conditions: [{ fieldName: '所属迭代', operator: 'contains', value: ['rec1'] }] });
    expect(none).toEqual([]);
    const found = await store.searchRecords(id, { conjunction: 'and', conditions: [{ fieldName: '需求', operator: 'is', value: ["O'Reilly 中文"] }] });
    expect(found.map((item) => item.record_id)).toContain(row.record_id);
  });
  it('rolls back the entire batch when a later row does not exist', async () => {
    const row = await store.createRecord(id, { 需求: '原始值' });
    await expect(store.batchUpdateRecords(id, [
      { recordId: row.record_id, fields: { 需求: '不应写入' } },
      { recordId: 'missing', fields: { 需求: '失败' } },
    ])).rejects.toThrow();
    expect((await store.getRecord(id, row.record_id)).fields['需求']).toBe('原始值');
  });
  it('preserves text contains semantics and converts person filter namespaces', async () => {
    const row = await store.createRecord(id, { 需求: '中文 Search 100% _literal', 当前处理人: [{ id: employee }] }, 'user_id');
    const results = await store.searchRecords(id, { conjunction: 'and', conditions: [
      { fieldName: '需求', operator: 'contains', value: ['search 100% _'] },
      { fieldName: '当前处理人', operator: 'contains', value: [employee] },
    ] }, 'user_id');
    expect(results.map((record) => record.record_id)).toContain(row.record_id);
    expect(await store.searchRecords(id, { conjunction: 'and', conditions: [
      { fieldName: '需求', operator: 'contains', value: ['S%'] },
    ] })).toEqual([]);
    const page = await store.searchRecordPage(id, { conjunction: 'and', conditions: [] }, ['需求'], 1);
    expect(page.items).toHaveLength(1); expect(page.hasMore).toBe(true);
    expect(Object.keys(page.items[0].fields)).toEqual(['需求']);
    await expect(store.searchRecords(id, { conjunction: 'and', conditions: [
      { fieldName: 'missing', operator: 'isEmpty' },
    ] })).rejects.toThrow('筛选字段不存在');
  });
  it('preserves disjoint concurrent patches and generates unique codes', async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, (_, index) => store.createRecord(id, { 需求: `并发${index}` })));
    expect(new Set(rows.map((row) => row.fields['需求编号'])).size).toBe(8);
    await Promise.all([
      store.updateRecord(id, rows[0].record_id, { 需求: '标题变更' }),
      store.updateRecord(id, rows[0].record_id, { 所属迭代: ['rec1'] }),
    ]);
    expect((await store.getRecord(id, rows[0].record_id)).fields).toMatchObject({ 需求: '标题变更', 所属迭代: ['rec1'] });
  });
  it('routes business reads through local records without a Feishu HTTP call', async () => {
    const feishu = new FeishuService(undefined, store);
    const list = await feishu.listRecords(id);
    expect(list.length).toBeGreaterThan(0);
    expect(await feishu.listFields(id)).toEqual(expect.arrayContaining([expect.objectContaining({ name: '需求' })]));
  });
  it('keeps reverse links atomic for create, reassignment and deletion',async()=>{
    const a=await store.createRecord(id,{需求:'链接A'}),b=await store.createRecord(id,{需求:'链接B'});
    const linked=await store.createRecord(id,{需求:'链接来源',关联记录:[a.record_id]});
    expect((await store.getRecord(id,a.record_id)).fields['反向关联']).toEqual([linked.record_id]);
    await store.updateRecord(id,linked.record_id,{关联记录:[b.record_id]});
    expect((await store.getRecord(id,a.record_id)).fields['反向关联']).toEqual([]);
    expect((await store.getRecord(id,b.record_id)).fields['反向关联']).toEqual([linked.record_id]);
    await expect(store.updateRecord(id,linked.record_id,{关联记录:['rec_missing_target']})).rejects.toThrow();
    expect((await store.getRecord(id,linked.record_id)).fields['关联记录']).toEqual([b.record_id]);
    await store.deleteRecord(id,linked.record_id);
    expect((await store.getRecord(id,b.record_id)).fields['反向关联']).toEqual([]);
  });
});
