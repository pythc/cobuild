import { IdentityInspectionCache } from './lab-identity-cache';

describe('central identity inspection cache', () => {
  let time: jest.SpyInstance;
  beforeEach(() => {
    time = jest.spyOn(Date, 'now').mockReturnValue(1000);
  });
  afterEach(() => jest.restoreAllMocks());
  test('coalesces parallel inspections and reuses only a successful bounded result', async () => {
    const cache = new IdentityInspectionCache();
    let finish: () => void;
    const inspect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const calls = Array.from({ length: 12 }, () =>
      cache.verify('s', 'v1', 60_000, inspect),
    );
    await Promise.resolve();
    expect(inspect).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all(calls);
    await cache.verify('s', 'v1', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(1);
    time.mockReturnValue(16_001);
    const check = jest.fn().mockResolvedValue(undefined);
    await cache.verify('s', 'v1', 60_000, check);
    expect(check).toHaveBeenCalledTimes(1);
  });
  test('does not serve an expired result on outage or rejection; recovery needs a fresh check', async () => {
    const cache = new IdentityInspectionCache();
    const inspect = jest.fn().mockResolvedValue(undefined);
    await cache.verify('s', 'v1', 60_000, inspect);
    time.mockReturnValue(16_001);
    inspect.mockRejectedValueOnce(new Error('revoked'));
    await expect(cache.verify('s', 'v1', 60_000, inspect)).rejects.toThrow(
      'revoked',
    );
    inspect.mockResolvedValue(undefined);
    await cache.verify('s', 'v1', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  test('never reuses a successful result across a session or credential change', async () => {
    const cache = new IdentityInspectionCache();
    const inspect = jest.fn().mockResolvedValue(undefined);
    await cache.verify('a', 'v1', 60_000, inspect);
    await cache.verify('b', 'v1', 60_000, inspect);
    await cache.verify('a', 'v2', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  test('caps the result at the identity provider expiry and starts TTL before the request', async () => {
    const cache = new IdentityInspectionCache();
    const inspect = jest.fn(async () => {
      time.mockReturnValue(14_000);
      return 15_000;
    });
    await cache.verify('s', 'v1', 60_000, inspect);
    time.mockReturnValue(15_001);
    await cache.verify('s', 'v1', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  test('bounds memory and does not let an old pending failure remove a replacement', async () => {
    const cache = new IdentityInspectionCache(15_000, 1);
    let reject: (e: Error) => void;
    const pending = cache.verify(
      's',
      'v1',
      60_000,
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    );
    await Promise.resolve();
    const inspect = jest.fn().mockResolvedValue(undefined);
    await cache.verify('s', 'v2', 60_000, inspect);
    reject(new Error('old'));
    await expect(pending).rejects.toThrow();
    await cache.verify('s', 'v2', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(1);
    await cache.verify('other', 'v1', 60_000, inspect);
    await cache.verify('s', 'v2', 60_000, inspect);
    expect(inspect).toHaveBeenCalledTimes(3);
  });
});
