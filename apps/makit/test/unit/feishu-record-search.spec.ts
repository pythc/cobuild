import {
  type BaseRecord,
  FeishuService,
} from '../../server/modules/requirements/feishu.service';

describe('FeishuService.searchRecords', () => {
  const previousBaseToken: string | undefined = process.env.FEISHU_BASE_TOKEN;

  beforeAll(() => {
    process.env.FEISHU_BASE_TOKEN = 'base-token';
  });

  afterAll(() => {
    if (previousBaseToken === undefined) {
      delete process.env.FEISHU_BASE_TOKEN;
    } else {
      process.env.FEISHU_BASE_TOKEN = previousBaseToken;
    }
  });

  it('sends structured Base filters and follows result pagination', async () => {
    const service: FeishuService = new FeishuService();
    const first: BaseRecord = { record_id: 'one', fields: {} };
    const second: BaseRecord = { record_id: 'two', fields: {} };
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        items: [first],
        has_more: true,
        page_token: 'next-page',
      })
      .mockResolvedValueOnce({ items: [second], has_more: false });
    Object.defineProperty(service, 'request', { value: request });

    const records: BaseRecord[] = await service.searchRecords(
      'relations',
      {
        conjunction: 'or',
        conditions: [
          {
            fieldName: '源需求',
            operator: 'contains',
            value: ['requirement-1'],
          },
          {
            fieldName: '目标需求',
            operator: 'contains',
            value: ['requirement-1'],
          },
        ],
      },
      'user_id',
    );

    expect(records).toEqual([first, second]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/bitable/v1/apps/base-token/tables/relations/records/search',
      {
        params: {
          page_size: 500,
          page_token: undefined,
          user_id_type: 'user_id',
        },
        data: {
          filter: {
            conjunction: 'or',
            conditions: [
              {
                field_name: '源需求',
                operator: 'contains',
                value: ['requirement-1'],
              },
              {
                field_name: '目标需求',
                operator: 'contains',
                value: ['requirement-1'],
              },
            ],
          },
        },
        retryableRead: true,
      },
    );
    expect(request.mock.calls[1]?.[2]).toMatchObject({
      params: { page_token: 'next-page' },
    });
  });
  it.each([
    [{ items: [], has_more: true }],
    [{ items: [], has_more: true, page_token: 'same' }, { items: [], has_more: true, page_token: 'same' }],
  ])('rejects incomplete list pagination instead of returning a partial index', async (...pages) => {
    const service = new FeishuService();
    const request = jest.fn();
    for (const page of pages) request.mockResolvedValueOnce(page);
    Object.defineProperty(service, 'request', { value: request });
    await expect(service.listRecords('requirements')).rejects.toThrow('分页未完整返回');
  });

});
