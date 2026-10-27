import { createHash } from 'node:crypto';
import { RelayChatwootService } from '../../server/modules/relay/relay-chatwoot.service';
import {
  ChatwootError,
  chatwootConfig,
} from '../../server/modules/relay/chatwoot-client';
const actor: any = {
  employeeId: 'self',
  platformAppId: 'makit',
  name: '测试运营',
};
const principal = createHash('sha256')
  .update('makit-member:makit:self')
  .digest('hex');
function setup() {
  process.env.RELAY_SOURCE_ID = 'relay';
  process.env.RELAY_PUBLIC_ORIGIN = 'http://127.0.0.1:5424';
  const messages: any[] = [
    {
      id: 1,
      message_type: 0,
      private: false,
      content: '公开',
      created_at: 1700000000,
    },
    {
      id: 2,
      message_type: 1,
      private: true,
      content: '内部',
      created_at: 1700000001,
    },
    { id: 3, message_type: 2, content: '系统', created_at: 1700000002 },
  ];
  const row = {
    id: 'c-real',
    principal,
    app: 'makit',
    remote_id: 9,
    created_at: '2026-10-15T00:00:00Z',
  };
  const chat: any = {
    gatewayHeaders: () => ({}),
    config: () => ({
      origin: 'http://127.0.0.1:5409',
      apps: { makit: { inboxId: 1, name: 'Makit' } },
    }),
    operator: jest.fn(async () => true),
    account: (p: string) => p,
    messages: jest.fn(async () => messages),
    request: jest.fn(async (path: string) =>
      path.endsWith('/messages')
        ? { id: 99 }
        : {
            inbox_id: 1,
            status: 'open',
            meta: { sender: { name: '测试用户' } },
          },
    ),
  };
  const store: any = {
    conversation: jest.fn(async () => row),
    conversations: jest.fn(async () => [row]),
    reserve: jest.fn(async () => ({
      row: { state: 'preparing' },
      claimed: true,
    })),
    writing: jest.fn(),
    done: jest.fn(),
    fail: jest.fn(),
  };
  const intents: any = { read: jest.fn(async () => null) };
  const intake: any = {
    get: jest.fn(async () => ({ requirement: {} })),
    members: jest.fn(async () => ({ members: [] })),
  };
  const service = new RelayChatwootService(
    chat,
    store,
    intake,
    intents,
    {} as any,
    {} as any,
  );
  return { service, chat, store, intake, intents, messages, row };
}
test('customer snapshots exclude internal notes and system activity', async () => {
  const { service } = setup();
  const s = await service.state(actor, 'customer');
  expect(s.conversations[0].messages.map((m: any) => m.content)).toEqual([
    '公开',
  ]);
});
test('operator snapshot retains internal notes', async () => {
  const { service } = setup();
  expect((await service.context('c-real', actor)).messages).toHaveLength(3);
});
test('conversation cannot be accessed with a different authenticated identity', async () => {
  const { service } = setup();
  await expect(
    service.send(
      'c-real',
      { ...actor, employeeId: 'other' },
      { content: 'x' },
      'request-key',
      false,
    ),
  ).rejects.toThrow('咨询不存在');
});
test('customer cannot post private notes', async () => {
  const { service, store } = setup();
  await expect(
    service.send(
      'c-real',
      actor,
      { content: 'x', private: true },
      'request-key',
      false,
    ),
  ).rejects.toThrow('内部备注');
  expect(store.reserve).not.toHaveBeenCalled();
});
test.each([
  'https://bad.test/file',
  'data:text/plain;base64,abc!',
  'data:application/json,%7B%7D',
])('malformed attachment rejected before operation claim: %s', async (url) => {
  const { service, store } = setup();
  await expect(
    service.send(
      'c-real',
      actor,
      { attachments: [{ id: 'f', name: 'f', kind: 'text', size: '1 B', url }] },
      'request-key',
      false,
    ),
  ).rejects.toThrow();
  expect(store.reserve).not.toHaveBeenCalled();
});
test('actual composer text attachment is uploaded byte-for-byte using multipart', async () => {
  const { service, chat } = setup();
  await service.send(
    'c-real',
    actor,
    {
      content: '附件',
      attachments: [
        {
          id: 'f',
          name: '验证.txt',
          kind: 'text',
          size: '7 B',
          url:
            'data:text/plain;charset=utf-8,' + encodeURIComponent('测试\n你好'),
          content: '测试\n你好',
        },
      ],
    },
    'request-key',
    false,
  );
  const [, opts] = chat.request.mock.calls.find((c: any) =>
    c[0].endsWith('/messages'),
  )!;
  expect(opts.form).toBeInstanceOf(FormData);
  expect(await opts.form.get('attachments[]').text()).toBe('测试\n你好');
  expect(opts.form.get('message_type')).toBe('incoming');
});
test('unknown sends are reconciled by server marker without resending', async () => {
  const { service, chat, store, messages } = setup();
  const marker = createHash('sha256')
    .update(principal + '|message:c-real|request-key')
    .digest('hex');
  store.reserve.mockResolvedValue({
    row: { state: 'unknown' },
    claimed: false,
  });
  messages.push({ id: 100, content_attributes: { relay_request_id: marker } });
  expect(
    await service.send('c-real', actor, { content: 'x' }, 'request-key', false),
  ).toEqual({ id: '100' });
  expect(
    chat.request.mock.calls.filter((c: any) => c[0].endsWith('/messages')),
  ).toHaveLength(0);
});
test('unconfirmed unknown sends remain fenced', async () => {
  const { service, chat, store } = setup();
  store.reserve.mockResolvedValue({
    row: { state: 'unknown' },
    claimed: false,
  });
  await expect(
    service.send('c-real', actor, { content: 'x' }, 'request-key', false),
  ).rejects.toThrow('未重复发送');
  expect(
    chat.request.mock.calls.filter((c: any) => c[0].endsWith('/messages')),
  ).toHaveLength(0);
});
test('upstream uncertain write is persisted as unknown', async () => {
  const { service, chat, store } = setup();
  chat.request.mockImplementation(async (p: string) => {
    if (p.endsWith('/messages')) throw new ChatwootError(false);
    return { inbox_id: 1 };
  });
  await expect(
    service.send('c-real', actor, { content: 'x' }, 'request-key', false),
  ).rejects.toThrow();
  expect(store.fail).toHaveBeenCalledWith(expect.anything(), false);
});
test('native attachments require native ticket visibility and actual conversation membership', async () => {
  const { service, intake, intents } = setup();
  intents.read.mockResolvedValue({
    payload_json: JSON.stringify({
      messages: [{ attachments: [{ id: '1' }] }],
    }),
  });
  await expect(
    service.attachment('c-real', '2', actor, false, true),
  ).rejects.toThrow('附件不存在');
  expect(intake.get).toHaveBeenCalledWith('c-real', actor);
  intake.get.mockRejectedValue(new Error('denied'));
  await expect(
    service.attachment('c-real', '1', actor, false, true),
  ).rejects.toThrow('denied');
});
test('Chatwoot config rejects non-loopback HTTP and URL credentials', () => {
  const valid = {
    origin: 'http://127.0.0.1:5409',
    accountId: 1,
    token: 'test-token-only',
    apps: {
      makit: {
        inboxId: 1,
        identifier: 'test-inbox',
        hmacToken: 'test-hmac-token-only',
        name: 'Makit',
      },
    },
    operators: { self: 1 },
  };
  expect(chatwootConfig.safeParse(valid).success).toBe(true);
  for (const origin of [
    'http://example.test',
    'https://user:pass@example.test',
  ])
    expect(chatwootConfig.safeParse({ ...valid, origin }).success).toBe(false);
});
test('resolved conversations can be reopened with a separate fenced desired state', async () => {
  const { service, chat } = setup();
  await service.resolve('c-real', actor, 'request-key', { status: 'open' });
  expect(chat.request).toHaveBeenCalledWith('/conversations/9/toggle_status', {
    method: 'POST',
    body: { status: 'open' },
  });
  await expect(
    service.resolve('c-real', actor, 'request-key', { status: 'hacked' }),
  ).rejects.toThrow();
});
test('operator permission is checked against actual inbox membership', async () => {
  const { service, chat, store } = setup();
  chat.operator.mockResolvedValue(false);
  await expect(
    service.send('c-real', actor, { content: 'x' }, 'request-key', true),
  ).rejects.toThrow('客服权限');
  expect(store.reserve).not.toHaveBeenCalled();
});
test('native detail keeps frozen snapshot, shows later communication and survives Chatwoot read outage', async () => {
  const { service, intents, intake, chat, messages } = setup();
  const context = {
    description: '原始描述',
    messages: [{ id: '1', side: '用户', content: '公开' }],
  };
  intents.read.mockResolvedValue({
    requirement_id: 'rec-real',
    payload_json: JSON.stringify(context),
    created_at: '2026-10-15T00:00:00Z',
  });
  intake.get.mockResolvedValue({
    requirement: {
      id: 'rec-real',
      code: 'REQ-real',
      title: '工单',
      status: '处理中',
      priority: 'P2',
      handlers: [],
      personnelUserIds: { handlers: [] },
      updatedAt: '2026-10-15T01:00:00Z',
    },
  });
  const result = await service.tickets(actor, 'rec-real');
  expect(result.context.messages).toHaveLength(1);
  expect(result.context.messages[0].side).toBe('customer');
  expect(result.updates.map((m: any) => m.content)).toEqual(['内部']);
  expect(result.createdAt).toBe('2026-10-15T00:00:00Z');
  chat.messages.mockRejectedValue(new ChatwootError(false));
  const fallback = await service.tickets(actor, 'rec-real');
  expect(fallback.context.messages).toHaveLength(1);
  expect(fallback.updatesUnavailable).toBe(true);
});

test('a confirmed native link survives a transient Base read failure without offering duplicate creation', async () => {
  const { service, intake, intents } = setup();
  intents.read.mockResolvedValue({
    state: 'linked',
    requirement_id: 'rec-linked',
    payload_json: JSON.stringify({ title: '已确认工单', messages: [] }),
  });
  intake.get.mockRejectedValue(new Error('Base temporarily unavailable'));
  const state = await service.state(actor, 'operator');
  expect(state.pendingConversions).toEqual([]);
  expect(state.tickets).toHaveLength(1);
  expect(state.tickets[0]).toMatchObject({
    id: 'rec-linked',
    status: 'syncing',
    syncPending: true,
  });
  expect(state.tickets[0].nativeUrl).toContain('/requirements/rec-linked');
  intake.get.mockRejectedValue(
    new (require('@nestjs/common').NotFoundException)(),
  );
  expect((await service.state(actor, 'operator')).tickets[0].status).toBe(
    'unavailable',
  );
});
