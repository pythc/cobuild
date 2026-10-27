import { RequirementBatchService } from '../../server/modules/requirements/requirement-batch.service';
import type { CurrentUserSummary } from '../../shared/api.interface';
import type {
  RequirementBatch,
  RequirementBatchPreviewInput,
} from '../../shared/requirement-batch';
const actor = { miaodaUserId: 'test-only' } as CurrentUserSummary;
describe('batch safety boundaries', () => {
  const setup = () => {
    const database = { run: jest.fn().mockResolvedValue([]) };
    const query = {
      requirementByIdAs: jest
        .fn()
        .mockResolvedValue({ id: 'recTest', updatedAt: 1234 }),
    };
    return {
      database,
      query,
      service: new RequirementBatchService(
        database as never,
        query as never,
        {} as never,
        {} as never,
      ),
    };
  };
  it.each([
    null,
    {},
    { status: '已发布' },
    { status: '已关闭' },
    { handlerUserIds: ['someone'] },
    { iterationIds: ['recOne', 'recTwo'] },
  ])(
    'rejects empty, unsupported and unsafe patches before DB or writes: %j',
    async (patch) => {
      const { service, database } = setup();
      await expect(
        service.preview(
          {
            clientMutationId: 'test-batch-1',
            items: [{ recordId: 'recTest', expectedUpdatedAt: 1234 }],
            patch,
          } as RequirementBatchPreviewInput,
          actor,
        ),
      ).rejects.toThrow();
      expect(database.run).not.toHaveBeenCalled();
    },
  );
  it('retry preview only includes confirmed failures, not unknown or successful operations', async () => {
    const { service, query } = setup();
    jest.spyOn(service, 'get').mockResolvedValue({
      patch: { priority: 'P1' },
      items: [
        { recordId: 'recFailed', status: 'failed' },
        { recordId: 'recUnknown', status: 'unknown' },
        { recordId: 'recDone', status: 'succeeded' },
      ],
    } as RequirementBatch);
    const preview = jest
      .spyOn(service, 'preview')
      .mockResolvedValue({} as RequirementBatch);
    await service.retryPreview('batch-id', actor, 'fresh-key');
    expect(query.requirementByIdAs).toHaveBeenCalledTimes(1);
    expect(query.requirementByIdAs).toHaveBeenCalledWith('recFailed', actor);
    expect(preview.mock.calls[0][0].items).toEqual([
      { recordId: 'recFailed', expectedUpdatedAt: 1234 },
    ]);
  });
  it('an expired preview cannot enqueue anything', async () => {
    const { service, database } = setup();
    database.run.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'preview',
        expires_at: '2000-01-01T00:00:00Z',
      },
    ]);
    await expect(
      service.execute('11111111-1111-4111-8111-111111111111', actor),
    ).rejects.toThrow('预览已过期');
    expect(database.run).toHaveBeenCalledTimes(1);
  });
});
