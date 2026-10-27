import {
  NotificationDeliveryService,
  publicDelivery,
} from '../../server/modules/notifications/notification-delivery.service';
import { deliveryPolicy } from '../../server/modules/notifications/notification-delivery.model';
import { PgDialect } from 'drizzle-orm/pg-core';
describe('notification ledger safety', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of [
      'WORKFLOW_DELIVERY_OWNER',
      'NOTIFICATION_MODE',
      'NOTIFICATION_ALLOWED_CHAT_IDS',
    ])
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
  });
  const event = () => ({
    eventId: 'e'.repeat(200),
    requirementId: 'recQaOnly',
    targetId: 'oc_test',
    kind: 'created',
    channel: 'feishu_group' as const,
    localAllowed: true,
    payload: {
      type: 'post' as const,
      receiveIdType: 'chat_id' as const,
      content: {
        zh_cn: { title: '测试', content: [[{ tag: 'text', text: '测试' }]] },
      },
    },
  });
  it('managed source ingestion is durable, contains exact platform link, deduplicates long IDs without guessing operation', async () => {
    process.env.WORKFLOW_DELIVERY_OWNER = 'managed_bot';
    process.env.NOTIFICATION_MODE = 'test_only';
    process.env.NOTIFICATION_ALLOWED_CHAT_IDS = 'oc_test';
    const service = new NotificationDeliveryService({} as never),
      record = jest.spyOn(service, 'record').mockResolvedValue('id');
    jest
      .spyOn(service, 'status')
      .mockResolvedValue({ state: 'pending', messageId: null });
    const input = event();
    await service.ingestWorkflow(input);
    await service.ingestWorkflow(input);
    expect(record.mock.calls[0][0]).toEqual(record.mock.calls[1][0]);
    const plan = record.mock.calls[0][0];
    expect(plan.eventId.length).toBeLessThan(200);
    expect(plan.owner).toBe('managed_bot');
    expect(plan.operationId).toBeUndefined();
    expect(plan.policyAllowed).toBe(true);
    expect(JSON.stringify(plan.payload)).toContain('/requirements/recQaOnly');
    expect(input.payload.content.zh_cn.content).toHaveLength(1);
  });
  it('both source and current platform policies must permit, missing mode fails closed', async () => {
    process.env.NOTIFICATION_MODE = 'disabled';
    expect(
      deliveryPolicy('feishu_group', 'oc_test', 'requirement_workflow').allowed,
    ).toBe(false);
    process.env.NOTIFICATION_MODE = 'live';
    const service = new NotificationDeliveryService({} as never),
      record = jest.spyOn(service, 'record').mockResolvedValue('id');
    jest
      .spyOn(service, 'status')
      .mockResolvedValue({ state: 'suppressed', messageId: null });
    await service.ingestWorkflow({ ...event(), localAllowed: false });
    expect(record.mock.calls[0][0].policyAllowed).toBe(false);
  });
  it('unconfigured managed ownership never claims or opens a database connection', async () => {
    delete process.env.WORKFLOW_DELIVERY_OWNER;
    const run = jest.fn();
    const service = new NotificationDeliveryService({ run } as never);
    await expect(service.claim('managed_bot')).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it('requires a provider message ID before declaring sent', async () => {
    const run = jest.fn();
    const service = new NotificationDeliveryService({ run } as never);
    await expect(
      service.result({ id: 'id', leaseToken: 'lease', outcome: 'sent' }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('expired/unknown sending outcomes never enter automatic retry state', async () => {
    const rows = [
      {
        id: 'id',
        lease_token: 'lease',
        state: 'sending',
        attempts: 1,
        max_attempts: 8,
      },
    ];
    const execute = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      chain = { set: () => chain, where: () => ({}) };
    const service = new NotificationDeliveryService({
      run: (fn) => fn({ execute, update: () => chain }),
    } as never);
    await service.result({
      id: 'id',
      leaseToken: 'lease',
      outcome: 'unknown',
      errorCode: 'network_timeout',
    });
    const command = new PgDialect().sqlToQuery(execute.mock.calls[1][0]);
    expect(command.params).toContain('unknown');
    expect(command.params).not.toContain('retry_wait');
  });
  it('stale lease cannot overwrite another sender and public projection omits target IDs/payload', async () => {
    const execute = jest.fn().mockResolvedValue([{ lease_token: 'new' }]);
    const service = new NotificationDeliveryService({
      run: (fn) => fn({ execute }),
    } as never);
    await expect(
      service.result({
        id: 'id',
        leaseToken: 'old',
        outcome: 'sent',
        messageId: 'om_receipt',
      }),
    ).resolves.toEqual({ accepted: false });
    expect(execute).toHaveBeenCalledTimes(1);
    const projected = publicDelivery({
      target_id: 'private',
      payload_json: 'secret',
      lease_token: 'secret',
      attempts: 1,
      max_attempts: 8,
    } as never);
    expect(JSON.stringify(projected)).not.toContain('secret');
    expect(JSON.stringify(projected)).not.toContain('private');
  });
});
