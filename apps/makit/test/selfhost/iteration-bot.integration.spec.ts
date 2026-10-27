import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { MakitIterationBotController } from '../../server/common/selfhost/iteration-bot.controller';
import { RequestContextService } from '../../server/common/selfhost/context';
import { WorkspaceRecordStore } from '../../server/database/workspace-record.store';
import { transportAllowed } from '../../server/common/selfhost/access.guard';

describe('dedicated bot migration transport and durable ambiguous results', () => {
  let owner: Sql, application: Sql, controller: MakitIterationBotController;
  const environment = { ...process.env }, collection = `test-bot-${randomUUID()}`, requests: string[] = [];
  beforeAll(async () => {
    if (new URL(process.env.MAKIT_MIGRATION_DATABASE_URL!).hostname !== '127.0.0.1') throw Error('Isolated local database required');
    owner = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL!, { max: 1 });
    application = postgres(process.env.MAKIT_DATABASE_URL!, { max: 2 });
    const context = new RequestContextService();
    controller = new MakitIterationBotController(new WorkspaceRecordStore(application, context), { client: application } as never, context);
    await owner`INSERT INTO makit_collection(id,kind,fields) VALUES (${collection},${collection},${owner.json([
      { id: 'title', name: '事件键', type: '1' }, { id: 'summary', name: '最近通知摘要', type: '1' },
      { id: 'updated', name: '最后修改人', type: '1004' },
    ])})`;
    process.env.FEISHU_COLLABORATION_TABLE = collection; process.env.FEISHU_REQUIREMENTS_TABLE = collection;
    process.env.MAKIT_ITERATION_BOT_ENABLED = 'true'; process.env.MAKIT_WORKERS_ENABLED = 'true';
    process.env.MAKIT_EXTERNAL_WRITES_ENABLED = 'true';
  });
  afterAll(async () => {
    process.env = environment;
    if (owner) {
      await owner`DELETE FROM makit_bot_request WHERE id=ANY(${owner.array(requests, 2950)})`;
      await owner`DELETE FROM makit_record WHERE collection_id=${collection}`;
      await owner`DELETE FROM makit_collection WHERE id=${collection}`; await owner.end();
    }
    await application?.end();
  });
  function mutation() { const requestId = randomUUID(); requests.push(requestId); return { operation: 'upsert', collection: 'collaboration', fields: { 事件键: randomUUID() }, requestId }; }
  it('requires its own token and cannot authorize human browser APIs', () => {
    process.env.MAKIT_ITERATION_BOT_TOKEN = 'b'.repeat(43); process.env.MCP_TRANSPORT_API_KEY = 'm'.repeat(43);
    expect(transportAllowed({ path: '/openapi/iteration-bot/records', headers: { authorization: 'Bearer ' + 'm'.repeat(43) } } as never)).toBe(false);
    expect(transportAllowed({ path: '/openapi/iteration-bot/records', headers: { authorization: 'Bearer ' + 'b'.repeat(43) } } as never)).toBe(true);
    expect(transportAllowed({ path: '/api/operations/admin', headers: { authorization: 'Bearer ' + 'b'.repeat(43) } } as never)).toBe(false);
  });
  it('keeps original record IDs, attributes bot writes and reuses only a completed identical receipt', async () => {
    const body = mutation(), first = await controller.request(body), repeat = await controller.request(body);
    expect(repeat).toEqual(first);
    const [row] = await owner`SELECT fields FROM makit_record WHERE collection_id=${collection}`;
    expect(row.fields['最后修改人']).toEqual({ id: 'app_makit_iteration_bot', name: '周催办' });
    const list = await controller.request({ operation: 'list', collection: 'collaboration', limit: 1 });
    expect(list).toMatchObject({ source: 'makit-postgres-v1', hasMore: false });
    await expect(controller.request({ ...body, fields: { 事件键: 'changed' } })).rejects.toThrow('禁止重复提交');
  });
  it('never repeats an unknown write and rejects human workflow edits and paused writes', async () => {
    const body = mutation();
    await controller.request(body);
    await owner`UPDATE makit_bot_request SET state='unknown' WHERE id=${body.requestId}`;
    await expect(controller.request(body)).rejects.toThrow('禁止重复提交');
    await expect(controller.request({ ...mutation(), collection: 'requirements', recordId: 'rec_test', fields: { 事件键: 'forbidden' } })).rejects.toThrow('只能维护');
    process.env.MAKIT_WORKERS_ENABLED = 'false';
    await expect(controller.request(mutation())).rejects.toThrow('已暂停');
    expect(await controller.request({ operation: 'list', collection: 'collaboration' })).toMatchObject({ source: 'makit-postgres-v1' });
    process.env.MAKIT_WORKERS_ENABLED = 'true';
  });
});
