import { ConfigService } from '@nestjs/config';
import { FeishuApiService } from './feishu-api.service';
describe('official Feishu API transport', () => {
  let api: FeishuApiService;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    api = new FeishuApiService(
      new ConfigService({
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'private-secret',
      }),
    );
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      async (url: any) =>
        ({
          ok: true,
          status: 200,
          json: async () =>
            String(url).includes('tenant_access_token')
              ? {
                  code: 0,
                  tenant_access_token: 'private-token',
                  expire: 7200,
                }
              : { code: 0, data: { value: true } },
        }) as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  test('concurrent requests share one token exchange', async () => {
    await Promise.all([
      api.call('/contact/v3/scopes'),
      api.call('/contact/v3/scopes'),
    ]);
    expect(
      fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('tenant_access_token'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every((c) =>
        String(c[0]).startsWith('https://open.feishu.cn/open-apis/'),
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  test('provider details and secrets never become error messages', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        code: 99991672,
        msg: 'private-secret private-token',
      }),
    });
    await expect(api.call('/contact/v3/scopes')).rejects.toThrow('99991672');
  });
  test('invalid token is refreshed once without infinite retry', async () => {
    fetchMock.mockImplementation(async (url: any) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('tenant_access_token')
          ? { code: 0, tenant_access_token: 'token', expire: 7200 }
          : { code: 99991668 },
    }));
    await expect(api.call('/contact/v3/scopes')).rejects.toThrow('99991668');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  test('pagination includes all pages', async () => {
    jest
      .spyOn(api, 'call')
      .mockResolvedValueOnce({ items: [1], has_more: true, page_token: 'next' })
      .mockResolvedValueOnce({ items: [2], has_more: false });
    expect(await api.pages('/test', {}, 'items')).toEqual([1, 2]);
  });
  test('empty completed page can omit its items field', async () => {
    jest.spyOn(api, 'call').mockResolvedValue({ has_more: false });
    expect(await api.pages('/test', {}, 'items')).toEqual([]);
  });
  test.each([
    { items: [], has_more: true, page_token: '' },
    { items: [], has_more: true, page_token: 'loop' },
    { items: [] },
  ])('rejects malformed/looping pages', async (data) => {
    jest.spyOn(api, 'call').mockResolvedValue(data);
    await expect(api.pages('/test', {}, 'items')).rejects.toThrow();
  });
});
