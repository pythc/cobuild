import { ConfigService } from '@nestjs/config';
import { FeishuService } from './feishu.service';
import { hashState } from './feishu-policy';

describe('Feishu code exchange', () => {
  let service: FeishuService;
  let store: Map<string, string>;
  let redis: any;
  let bind: jest.SpyInstance;
  let sessions: any;
  const state = 'a'.repeat(43);
  const flow = {
    binding: 'browser-cookie',
    verifier: 'secret-verifier',
    redirect: '/s/general/p/design',
  };
  beforeEach(() => {
    store = new Map();
    redis = {
      set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      get: jest.fn(async (k: string) => store.get(k)),
      eval: jest.fn(async (_s: any, _n: any, k: string, v: string) => {
        if (store.get(k) !== v) return 0;
        store.delete(k);
        return 1;
      }),
    };
    const config = new ConfigService({
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_TENANT_KEY: 'org',
      APP_URL: 'http://127.0.0.1:5840',
    });
    sessions = { createSessionAndToken: jest.fn(async () => 'session-token') };
    service = new FeishuService(
      config,
      { getOrThrow: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      sessions,
      {ensureMember:jest.fn()} as any,
    );
    bind = jest
      .spyOn(service as any, 'bindIdentity')
      .mockResolvedValue({ id: 'user', workspaceId: 'workspace' });
    store.set('lab110:oauth:' + hashState(state), JSON.stringify(flow));
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url: any) =>
          ({
            ok: true,
            json: async () =>
              String(url).includes('/oauth/token')
                ? { access_token: 'provider-token' }
                : {
                    code: 0,
                    data: { tenant_key: 'org', open_id: 'ou_current_user' },
                  },
          }) as any,
      );
  });
  afterEach(() => jest.restoreAllMocks());
  test('uses PKCE, fixed endpoints and one-use browser-bound state', async () => {
    const result = await service.complete(
      state,
      'provider-code',
      'browser-cookie',
    );
    expect(result).toEqual({
      authToken: 'session-token',
      redirect: flow.redirect,
    });
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe(
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    );
    expect(JSON.parse(calls[0][1].body)).toMatchObject({
      code_verifier: flow.verifier,
      redirect_uri: service.callbackUrl,
      client_id: 'cli_test',
    });
    await expect(
      service.complete(state, 'provider-code', 'browser-cookie'),
    ).rejects.toThrow('登录已过期');
    expect(sessions.createSessionAndToken).toHaveBeenCalledTimes(1);
  });
  test('a wrong browser cannot consume the valid flow', async () => {
    await expect(service.complete(state, 'code', 'attacker')).rejects.toThrow(
      '登录状态无效',
    );
    expect(store.has('lab110:oauth:' + hashState(state))).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('simultaneous replay has only one successful exchange', async () => {
    const results = await Promise.allSettled([
      service.complete(state, 'code', 'browser-cookie'),
      service.complete(state, 'code', 'browser-cookie'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sessions.createSessionAndToken).toHaveBeenCalledTimes(1);
  });
  test('another organization cannot create a user or session', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: any) => ({
      ok: true,
      json: async () =>
        String(url).includes('/oauth/token')
          ? { access_token: 'token' }
          : {
              code: 0,
              data: { tenant_key: 'external', open_id: 'ou_current_user' },
            },
    }));
    await expect(
      service.complete(state, 'code', 'browser-cookie'),
    ).rejects.toThrow('organization');
    expect(bind).not.toHaveBeenCalled();
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });
  test('provider errors fail closed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
    await expect(
      service.complete(state, 'code', 'browser-cookie'),
    ).rejects.toThrow('飞书登录暂时不可用');
    expect(bind).not.toHaveBeenCalled();
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });
  test('new flow hides external return URL and generates S256', async () => {
    const flow = await service.begin('//external.example');
    const url = new URL(flow.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const stored = JSON.parse(
      store.get('lab110:oauth:' + hashState(flow.state))!,
    );
    expect(stored.redirect).toBe('/home');
    expect(url.searchParams.get('code_challenge')).toBe(
      Buffer.from(hashState(stored.verifier), 'hex').toString('base64url'),
    );
  });
});
