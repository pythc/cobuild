import { WsTreeChangeService } from './ws-tree-change.service';
import * as postgres from 'postgres';
jest.mock('postgres', () => jest.fn());
describe('transactional tree change notifications', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });
  function fixture() {
    const database = {
      listen: jest.fn().mockResolvedValue({ unlisten: jest.fn() }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    (postgres as unknown as jest.Mock).mockReturnValue(database);
    const ws: any = { notifyTreeChanged: jest.fn() };
    const service = new WsTreeChangeService(
      { getDatabaseURL: () => 'postgres://unused@localhost/test' } as any,
      ws,
    );
    return { service, database, ws };
  }
  test('coalesces only space IDs and triggers a full reconciliation on listener reconnect', async () => {
    const { service, database, ws } = fixture();
    await service.onApplicationBootstrap();
    const [, receive, reconnected] = database.listen.mock.calls[0];
    reconnected();
    expect(ws.notifyTreeChanged).toHaveBeenCalledWith();
    const id = '00000000-0000-4000-8000-000000000001';
    for (let n = 0; n < 20; n++) receive(JSON.stringify({ spaceId: id }));
    receive('not-json');
    receive(JSON.stringify({ spaceId: 'not-a-space', title: 'private' }));
    await jest.advanceTimersByTimeAsync(151);
    expect(ws.notifyTreeChanged.mock.calls).toEqual([[], [id]]);
    await service.onModuleDestroy();
    expect(database.end).toHaveBeenCalledWith({ timeout: 2 });
  });
  test('cancels pending broadcasts on shutdown', async () => {
    const { service, database, ws } = fixture();
    await service.onApplicationBootstrap();
    database.listen.mock.calls[0][1](
      JSON.stringify({ spaceId: '00000000-0000-4000-8000-000000000001' }),
    );
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ws.notifyTreeChanged).not.toHaveBeenCalled();
  });
});
