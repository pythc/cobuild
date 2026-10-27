import { ConfigService } from '@nestjs/config';
import {
  identityRequest,
  identityEndpoint,
  sealIdentity,
  unsealIdentity,
  LAB_ISSUER,
} from './lab-identity-policy';
describe('lab identity trust boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  const config = () => new ConfigService({ FEISHU_TENANT_KEY: 'tenant' });
  const value = () => ({
    issuer: LAB_ISSUER,
    audience: 'knowledge',
    tenantKey: 'tenant',
    unionId: 'on_fictional00000001',
    subject: 'tenant:on_fictional00000001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    token: 'x'.repeat(43),
  });
  function response(p: any) {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(p), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  test('only trusts the canonical issuer, with explicit loopback test mode', () => {
    expect(identityEndpoint(config())).toBe(LAB_ISSUER);
    expect(() =>
      identityEndpoint(
        new ConfigService({ LAB_IDENTITY_ORIGIN: 'https://attacker.example' }),
      ),
    ).toThrow();
    expect(() =>
      identityEndpoint(
        new ConfigService({ LAB_IDENTITY_ORIGIN: 'http://127.0.0.1:5850' }),
      ),
    ).toThrow();
    expect(
      identityEndpoint(
        new ConfigService({
          LAB_IDENTITY_LOCAL_TEST: 'true',
          LAB_IDENTITY_ORIGIN: 'http://127.0.0.1:5850',
        }),
      ),
    ).toBe('http://127.0.0.1:5850');
  });
  test('sealed credentials cannot move between sessions or keys', () => {
    const sealed = sealIdentity('private-token', 'session-A', 'private-key');
    expect(sealed).not.toContain('private-token');
    expect(unsealIdentity(sealed, 'session-A', 'private-key')).toBe(
      'private-token',
    );
    expect(() => unsealIdentity(sealed, 'session-B', 'private-key')).toThrow();
    expect(() => unsealIdentity(sealed, 'session-A', 'other-key')).toThrow();
  });
  test('accepts a live exact audience identity and never follows a redirect', async () => {
    response(value());
    await expect(
      identityRequest(config(), 'exchange', { code: 'c' }),
    ).resolves.toMatchObject({ subject: 'tenant:on_fictional00000001' });
    expect(fetch).toHaveBeenCalledWith(
      LAB_ISSUER + '/api/identity/exchange',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  test.each([
    { issuer: 'https://attacker.example' },
    { audience: 'requirements' },
    { tenantKey: 'other' },
    { unionId: 'unknown' },
    { subject: 'tenant:wrong' },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(0).toISOString() },
    { expiresAt: new Date(Date.now() + 31 * 86400000).toISOString() },
    { token: '' },
  ])('rejects identity response mismatch %p', async (patch) => {
    response({ ...value(), ...patch });
    await expect(identityRequest(config(), 'exchange', {})).rejects.toThrow();
  });
  test('revocation and service failure are distinguished; neither becomes a cached login', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }));
    await expect(identityRequest(config(), 'inspect', {})).rejects.toThrow(
      '统一登录已失效',
    );
    (fetch as jest.Mock).mockRejectedValue(new Error());
    await expect(identityRequest(config(), 'inspect', {})).rejects.toThrow(
      '暂时无法核对统一身份',
    );
  });
});

describe('identity outage recovery', () => {
  afterEach(() => jest.restoreAllMocks());
  const config = new ConfigService({ FEISHU_TENANT_KEY: 'tenant' });
  const profile = () => ({
    issuer: LAB_ISSUER,
    audience: 'knowledge',
    tenantKey: 'tenant',
    unionId: 'on_fictional00000001',
    subject: 'tenant:on_fictional00000001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  test.each([502, 503, 504])(
    'retries one read-only inspection on HTTP %i',
    async (status) => {
      const f = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('', { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify(profile())));
      await expect(
        identityRequest(config, 'inspect', {}),
      ).resolves.toMatchObject({ subject: profile().subject });
      expect(f).toHaveBeenCalledTimes(2);
    },
  );
  test.each([401, 403, 429])(
    'does not retry rejection or rate limiting (%i)',
    async (status) => {
      const f = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('', { status }));
      await expect(identityRequest(config, 'inspect', {})).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    },
  );
  test('never replays an authorization-code exchange after a lost response', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('upstream private message token=secret'));
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => {});
    await expect(
      identityRequest(config, 'exchange', {
        code: 'private-code',
        verifier: 'private-verifier',
      }),
    ).rejects.toThrow('暂时无法核对统一身份');
    expect(f).toHaveBeenCalledTimes(1);
    const log = JSON.stringify(warn.mock.calls);
    expect(log).toContain('network');
    for (const secret of ['private-code', 'private-verifier', 'token=secret'])
      expect(log).not.toContain(secret);
  });
});
