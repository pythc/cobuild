import { BadRequestException, ConflictException } from '@nestjs/common';
import { RelayIntakeService } from '../../server/modules/requirements/relay-intake.service';
import { RelayIntakeController } from '../../server/modules/requirements/relay-intake.controller';
import {
  relayTicketInput,
  relayIntroduction,
  relayMarker,
} from '../../server/modules/requirements/relay-intake.model';
import { FeishuRequestError } from '../../server/modules/requirements/feishu.service';
import {
  ticketPatchError,
  ticketAllowedStatuses,
  requirementComplete,
  requirementInProgress,
} from '../../shared/ticket-workflow';
import type { IntakeRow } from '../../server/modules/requirements/relay-intake.store';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '../../shared/api.interface';
const actor = {
  miaodaUserId: 'member',
  employeeId: 'employee',
  name: '测试成员',
} as CurrentUserSummary;
const input = () => ({
  conversationId: 'c1',
  title: '导出失败',
  description: '图片丢失',
  sourceApp: 'Makit',
  sourceUrl: 'https://relay.example.test/conversations/c1',
  customerName: '测试用户',
  priority: 'P2',
  handlerLarkUserIds: ['staff-a', 'staff-b'],
  messages: [
    {
      id: 'm1',
      side: '用户',
      time: '2026-10-15T00:00:00Z',
      content: '导出后没有图片',
      attachments: [
        {
          id: 'f1',
          name: '截图.png',
          url: 'https://relay.example.test/files/f1',
        },
      ],
    },
  ],
});
function setup() {
  process.env.RELAY_INTEGRATION_ENABLED = 'true';
  process.env.RELAY_SOURCE_ID = 'relay';
  process.env.RELAY_PROJECT_ID = 'c4ab3a21-7c9f-4c8a-9ca7-134903b48831';
  process.env.RELAY_PUBLIC_ORIGIN = 'https://relay.example.test';
  let row: IntakeRow | undefined;
  let result = {
    id: 'rec_native',
    type: '工单',
    project: '工单',
    status: '处理中',
    handlers: [
      { id: 'ou_a', name: '甲' },
      { id: 'ou_b', name: '乙' },
    ],
    groupChatId: '',
  } as RequirementSummary;
  const store = {
    read: jest.fn(async () => row && { ...row }),
    reserve: jest.fn(
      async (source, conversation, marker, hash, payload, who) => {
        if (row) return { row: { ...row }, claimed: false };
        row = {
          source_id: source,
          conversation_id: conversation,
          marker,
          payload_hash: hash,
          payload_json: payload,
          actor_user_id: who,
          state: 'preparing',
          lease_token: 'token',
          requirement_id: null,
        };
        return { row: { ...row }, claimed: true };
      },
    ),
    writing: jest.fn(async () => {
      row!.state = 'writing';
    }),
    finish: jest.fn(async (_row, record) => {
      row!.state = 'linked';
      row!.requirement_id = record;
    }),
    fail: jest.fn(async (_row, state) => {
      if (row!.state !== 'linked') row!.state = state;
    }),
  };
  const command = {
    createRequirementAs: jest.fn(async (_input, _actor, hooks) => {
      await hooks.beforeWrite();
      await hooks.confirmed({ record_id: 'rec_native' });
    }),
    runGroupActionAs: jest.fn(async () => {
      result = { ...result, groupChatId: 'oc_native' };
    }),
  };
  const query = {
    table: jest.fn(() => 'tbl'),
    requirementByIdAs: jest.fn(async () => result),
    invalidate: jest.fn(),
  };
  const projects = {
    lookup: jest.fn(async () => ({ project: { projectName: '工单' } })),
    register: jest.fn(),
  };
  const feishu = {
    listFields: jest.fn(async () => [
      { name: 'Relay 会话标识', type: '1', options: [] },
      { name: '需求类型', options: [{ name: '工单' }] },
      { name: '项目', options: [{ name: '工单' }] },
      {
        name: '状态',
        options: ['待分派', '处理中', '待补充', '已解决', '已关闭'].map(
          (name) => ({ name }),
        ),
      },
    ]),
    searchRecords: jest.fn(async () => [] as any[]),
  };
  const service = new RelayIntakeService(
    store as never,
    command as never,
    query as never,
    projects as never,
    feishu as never,
  );
  return {
    service,
    store,
    command,
    query,
    projects,
    feishu,
    row: () => row!,
    change: (value: Partial<RequirementSummary>) => {
      result = { ...result, ...value };
    },
  };
}
afterEach(() => {
  for (const name of [
    'RELAY_INTEGRATION_ENABLED',
    'RELAY_SOURCE_ID',
    'RELAY_PROJECT_ID',
    'RELAY_PUBLIC_ORIGIN',
  ])
    delete process.env[name];
});
test('native intake creates a real requirement through the shared command with multiple employee IDs and context', async () => {
  const { service, command } = setup();
  const r = await service.create(input(), actor);
  expect(r.requirement.id).toBe('rec_native');
  expect(r.requirement.handlers).toHaveLength(2);
  expect(command.createRequirementAs).toHaveBeenCalledWith(
    expect.objectContaining({
      type: '工单',
      project: '工单',
      handlerLarkUserIds: ['staff-a', 'staff-b'],
      iterationIds: [],
      introduction: expect.stringContaining('截图.png'),
    }),
    actor,
    expect.objectContaining({ marker: relayMarker('relay', 'c1') }),
  );
});
test('duplicate clicks return the authoritative record even if the draft or native status has changed', async () => {
  const { service, command, change } = setup();
  await service.create(input(), actor);
  change({ status: '已解决' });
  expect(
    (await service.create({ ...input(), title: '修改后的草稿' }, actor))
      .requirement.status,
  ).toBe('已解决');
  expect(command.createRequirementAs).toHaveBeenCalledTimes(1);
});
test('unknown create response reconciles by the server-owned marker and never issues another create', async () => {
  const x = setup();
  x.command.createRequirementAs.mockImplementation(async (_i, _a, h) => {
    await h.beforeWrite();
    throw new FeishuRequestError('timeout', false, 'timeout');
  });
  await expect(x.service.create(input(), actor)).rejects.toThrow();
  expect(x.row().state).toBe('unknown');
  x.feishu.searchRecords.mockResolvedValue([
    { record_id: 'rec_native', fields: { 'Relay 会话标识': x.row().marker } },
  ]);
  expect((await x.service.create(input(), actor)).requirement.id).toBe(
    'rec_native',
  );
  expect(x.command.createRequirementAs).toHaveBeenCalledTimes(1);
  expect(x.row().state).toBe('linked');
});
test('empty or duplicate reconciliation matches remain uncertain without replaying writes', async () => {
  const x = setup();
  x.command.createRequirementAs.mockImplementation(async (_i, _a, h) => {
    await h.beforeWrite();
    throw new Error('connection lost');
  });
  await expect(x.service.create(input(), actor)).rejects.toThrow();
  await expect(x.service.get('c1', actor)).rejects.toBeInstanceOf(
    ConflictException,
  );
  x.feishu.searchRecords.mockResolvedValue(
    [1, 2].map((n) => ({
      record_id: 'rec_' + n,
      fields: { 'Relay 会话标识': x.row().marker },
    })),
  );
  await expect(x.service.get('c1', actor)).rejects.toThrow('重复关联');
  expect(x.command.createRequirementAs).toHaveBeenCalledTimes(1);
});
test('pre-write validation failure and explicit remote rejection are safe failures; uncertain writes are not', async () => {
  const x = setup();
  x.command.createRequirementAs.mockRejectedValue(
    new BadRequestException('bad user'),
  );
  await expect(x.service.create(input(), actor)).rejects.toThrow();
  expect(x.row().state).toBe('failed');
  const y = setup();
  y.command.createRequirementAs.mockImplementation(async (_i, _a, h) => {
    await h.beforeWrite();
    throw new FeishuRequestError('rejected', true, 'rejected');
  });
  await expect(y.service.create(input(), actor)).rejects.toThrow();
  expect(y.row().state).toBe('failed');
});
test('a receipt persistence failure recovers the original record instead of creating another', async () => {
  const x = setup();
  x.store.finish.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(x.service.create(input(), actor)).rejects.toThrow();
  expect(x.row().state).toBe('unknown');
  x.feishu.searchRecords.mockResolvedValue([
    { record_id: 'rec_native', fields: { 'Relay 会话标识': x.row().marker } },
  ]);
  await x.service.get('c1', actor);
  expect(x.row().state).toBe('linked');
  expect(x.command.createRequirementAs).toHaveBeenCalledTimes(1);
});
test('missing schema and wrong project mappings stop before any native requirement write', async () => {
  const x = setup();
  x.feishu.listFields.mockResolvedValue([]);
  await expect(x.service.create(input(), actor)).rejects.toThrow('需求类型');
  expect(x.command.createRequirementAs).not.toHaveBeenCalled();
  const y = setup();
  y.projects.lookup.mockResolvedValue({ project: { projectName: '其他项目' } });
  await expect(y.service.prepare()).rejects.toThrow('其他项目');
  expect(y.projects.register).not.toHaveBeenCalled();
});
test('an unregistered project fails preflight instead of inventing a CoBuild project UUID', async () => {
  const x = setup();
  x.projects.lookup.mockResolvedValue({ project: null } as never);
  await expect(x.service.prepare()).rejects.toThrow('真实项目 UUID');
  expect(x.projects.register).not.toHaveBeenCalled();
});
test('source URL mismatches, invalid users and oversized or forged payloads are rejected', async () => {
  const x = setup();
  await expect(
    x.service.create({ ...input(), sourceUrl: 'https://evil.test/' }, actor),
  ).rejects.toThrow('来源地址');
  await expect(
    x.service.create({ ...input(), handlerLarkUserIds: ['invalid/id'] }, actor),
  ).rejects.toBeInstanceOf(BadRequestException);
  await expect(
    x.service.create({ ...input(), actorUserId: 'admin' }, actor),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(x.store.reserve).not.toHaveBeenCalled();
  expect(
    relayTicketInput.safeParse({ ...input(), description: 'x'.repeat(20001) })
      .success,
  ).toBe(false);
});
test('HTML context is escaped and attachment links cannot use executable schemes', () => {
  const i = relayTicketInput.parse({
    ...input(),
    description: '<img src=x onerror=alert(1)>',
  });
  expect(relayIntroduction(i)).not.toContain('<img');
  expect(
    relayTicketInput.safeParse({ ...input(), sourceUrl: 'javascript:alert(1)' })
      .success,
  ).toBe(false);
});
test('all native handlers remain visible after edits; group creation delegates to Makit and then reads back', async () => {
  const x = setup();
  await x.service.create(input(), actor);
  await x.service.group('c1', actor);
  expect(x.command.runGroupActionAs).toHaveBeenLastCalledWith(
    'rec_native',
    'create',
    actor,
  );
  await x.service.group('c1', actor);
  expect(x.command.runGroupActionAs).toHaveBeenLastCalledWith(
    'rec_native',
    'sync',
    actor,
  );
});
test('feature disabled and invalid configuration never silently fall back to a local ticket', async () => {
  const x = setup();
  process.env.RELAY_INTEGRATION_ENABLED = 'false';
  await expect(x.service.create(input(), actor)).rejects.toThrow('尚未启用');
  expect(x.store.reserve).not.toHaveBeenCalled();
});
test('controller rejects absent credentials, rechecks each identity, and binds the actor on the server', async () => {
  const x = setup();
  const identity = { verify: jest.fn(async () => actor) },
    tokens = { verify: jest.fn(async () => actor) };
  const c = new RelayIntakeController(
    identity as never,
    tokens as never,
    x.service,
  );
  await expect(c.prepare({ headers: {} } as never)).rejects.toThrow('有效');
  await c.prepare({
    headers: { 'x-requirement-mcp-token': 'private' },
  } as never);
  await c.prepare({
    headers: {
      'x-requirement-mcp-token': 'private',
      'x-lab-identity-token': 'grant',
    },
  } as never);
  expect(tokens.verify).toHaveBeenCalledWith('private');
  expect(identity.verify).toHaveBeenCalledWith('grant', 'private');
  tokens.verify.mockRejectedValue(new Error('revoked'));
  await expect(
    c.prepare({ headers: { 'x-requirement-mcp-token': 'private' } } as never),
  ).rejects.toThrow('revoked');
});
test('ticket rules permit multiple handlers, independent workflow, resolution reasons and completed metrics', () => {
  const req = {
    type: '工单',
    status: '处理中',
    handlers: [{ id: 'a' }, { id: 'b' }],
    iterationIds: [],
  } as RequirementSummary;
  expect(ticketPatchError({ handlerLarkUserIds: ['a', 'b'] }, req)).toBeNull();
  expect(ticketPatchError({ handlerLarkUserIds: [] }, req)).toContain('处理人');
  expect(ticketPatchError({ status: '已解决' }, req)).toContain('处理结果');
  expect(
    ticketPatchError({ status: '已解决', latestProgress: '恢复成功' }, req),
  ).toBeNull();
  expect(ticketAllowedStatuses('处理中')).toContain('待补充');
  expect(ticketAllowedStatuses('处理中')).not.toContain('开发中');
  expect(requirementComplete({ ...req, status: '已解决' })).toBe(true);
  expect(requirementComplete({ ...req, type: '缺陷', status: '已解决' })).toBe(
    false,
  );
  expect(requirementInProgress({ ...req, status: '待分派' })).toBe(false);
});
