import {
  developmentOverduePlans,
  DevelopmentOverdueService,
} from '../../server/modules/notifications/development-overdue.service';
import type { BaseRecord } from '../../server/modules/requirements/feishu.service';
const start = 1700000000000;
const record = (fields: Record<string, unknown> = {}): BaseRecord => ({
  record_id: 'recTestDevelopment',
  fields: {
    状态: '开发中',
    需求: '虚构需求',
    工作量: 1.5,
    实际开始时间: start,
    研发人员: [
      { id: 'ou_testdeveloper', name: '虚构同学' },
      { id: 'ou_testdeveloper', name: '重复成员' },
    ],
    ...fields,
  },
});
describe('development overdue', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  it('uses strict natural-day boundary, supports fractions and sends only private messages to unique developers', () => {
    expect(developmentOverduePlans(record(), start + 1.5 * 86400000)).toEqual(
      [],
    );
    const plans = developmentOverduePlans(record(), start + 1.5 * 86400000 + 1);
    expect(plans).toHaveLength(1);
    expect(plans[0].channel).toBe('feishu_private');
    expect(plans[0].payload.receiveIdType).toBe('open_id');
    expect(plans[0].targetId).toBe('ou_testdeveloper');
  });
  it.each([null, '', -1, 'bad', Infinity, 1e20])(
    'ignores invalid effort %p',
    (effort) => {
      expect(
        developmentOverduePlans(record({ 工作量: effort }), Date.now()),
      ).toEqual([]);
    },
  );
  it('excludes completed stages, tickets and records without a confirmed development start', () => {
    for (const fields of [
      { 状态: '开发转测试' },
      { 实际开始时间: null },
      { 需求类型: '工单' },
      { 研发人员: [] },
    ])
      expect(developmentOverduePlans(record(fields), Date.now())).toEqual([]);
  });
  it('retains event identity during repeated scans and changes the identity for a new development cycle', () => {
    const [a] = developmentOverduePlans(record(), start + 2 * 86400000);
    const [b] = developmentOverduePlans(record(), start + 4 * 86400000);
    const [c] = developmentOverduePlans(
      record({ 实际开始时间: start + 1 }),
      start + 4 * 86400000,
    );
    expect(a.eventId).toBe(b.eventId);
    expect(c.eventId).not.toBe(a.eventId);
  });
  it('honors allowlists and does not force notification policy open', () => {
    process.env.NOTIFICATION_MODE = 'test_only';
    process.env.NOTIFICATION_ALLOWED_USER_IDS = 'ou_somebodyelse';
    expect(developmentOverduePlans(record(), Date.now())[0].policyAllowed).toBe(
      false,
    );
  });
  it('shares an in-flight scan, throttles successful scans and records through the durable ledger', async () => {
    process.env.WORKFLOW_DELIVERY_OWNER = 'managed_bot';
    process.env.FEISHU_REQUIREMENTS_TABLE = 'table';
    const listRecords = jest.fn().mockResolvedValue([record()]);
    const save = jest.fn().mockResolvedValue('id');
    const service = new DevelopmentOverdueService(
      { listRecords } as never,
      { record: save } as never,
    );
    await Promise.all([service.scan(), service.scan()]);
    await service.scan();
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toBe(true);
  });
});
