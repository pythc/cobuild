import { OperationsTelemetryService } from '../../server/modules/operations/operations-telemetry.service';
import { OperationsInsightsService } from '../../server/modules/operations/operations-insights.service';
import { DEFAULT_OPERATIONS_SETTINGS } from '../../server/modules/operations/operations-insights.model';

describe('retired monitoring preserves business execution', () => {
  const service = new OperationsTelemetryService();
  const runners = [
    (action: () => Promise<string>) => service.operation('operation', action),
    (action: () => Promise<string>) =>
      service.measure('feishu', 'read', action),
    (action: () => Promise<string>) => service.scanner('jobs', action),
  ];
  it.each(runners)(
    'runs business work once without scheduling monitoring',
    async (run) => {
      const timer = jest.spyOn(global, 'setInterval');
      const action = jest.fn().mockResolvedValue('confirmed');
      await expect(run(action)).resolves.toBe('confirmed');
      expect(action).toHaveBeenCalledTimes(1);
      expect(timer).not.toHaveBeenCalled();
      timer.mockRestore();
    },
  );
  it.each(runners)(
    'preserves errors without retrying business work',
    async (run) => {
      const error = new Error('business failure');
      const action = jest.fn().mockRejectedValue(error);
      await expect(run(action)).rejects.toBe(error);
      expect(action).toHaveBeenCalledTimes(1);
    },
  );
  it('has no monitoring lifecycle, database, sampling or alert evaluation methods', () => {
    for (const key of [
      'onModuleInit',
      'onModuleDestroy',
      'heartbeat',
      'flush',
      'recordExperience',
    ])
      expect(key in service).toBe(false);
    for (const key of [
      'onModuleInit',
      'onModuleDestroy',
      'health',
      'evaluateAlerts',
      'alerts',
      'preview',
    ])
      expect(key in OperationsInsightsService.prototype).toBe(false);
  });
  it('rejects attempts to reenable retired alerts without persisting or sending', async () => {
    const database = { run: jest.fn() };
    const settings = { save: jest.fn() };
    const insights = new OperationsInsightsService(
      database as never,
      settings as never,
    );
    const draft = structuredClone(DEFAULT_OPERATIONS_SETTINGS);
    draft.alerts.enabled = true;
    draft.alerts.receiverUserIds = ['123'];
    await expect(insights.saveSettings(draft, '123')).rejects.toThrow(
      '监测功能已移除',
    );
    expect(database.run).not.toHaveBeenCalled();
    expect(settings.save).not.toHaveBeenCalled();
  });
  it('still saves AI settings with alerts disabled', async () => {
    const draft = structuredClone(DEFAULT_OPERATIONS_SETTINGS);
    const settings = {
      save: jest.fn().mockResolvedValue({ ...draft, revision: 1 }),
    };
    const insights = new OperationsInsightsService(
      {} as never,
      settings as never,
    );
    await expect(insights.saveSettings(draft, '123')).resolves.toMatchObject({
      revision: 1,
    });
    expect(settings.save).toHaveBeenCalledTimes(1);
  });
});
