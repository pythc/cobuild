import { ConfigService } from '@nestjs/config';
import { NativeSessionService } from './native-session.service';
describe('native session enforcement', () => {
  const user = { id: 'u', workspaceId: 'w' };
  function create(identity: any, account: any, session: any) {
    const query: any = {
      select: () => query,
      selectAll: () => query,
      where: () => query,
      executeTakeFirst: async () => identity,
    };
    return new NativeSessionService(
      {
        selectFrom: (table: string) =>
          table === 'labIdentitySessions'
            ? {
                selectAll() {
                  return this;
                },
                where() {
                  return this;
                },
                executeTakeFirst: async () => undefined,
              }
            : query,
      } as any,
      new ConfigService({ FEISHU_APP_ID: 'cli', FEISHU_TENANT_KEY: 'tenant' }),
      { findById: async () => account } as any,
      { findActiveById: async () => session } as any,
    );
  }
  test('accepts only a bound user and active matching session', async () =>
    expect(
      await create({ userId: 'u' }, user, {
        userId: 'u',
        workspaceId: 'w',
      }).validate('u', 'w', 's'),
    ).toBe(user));
  test.each([
    [null, user, { userId: 'u', workspaceId: 'w' }],
    [
      {},
      { ...user, deactivatedAt: new Date() },
      { userId: 'u', workspaceId: 'w' },
    ],
    [{}, { ...user, deletedAt: new Date() }, { userId: 'u', workspaceId: 'w' }],
    [{}, user, null],
    [{}, user, { userId: 'other', workspaceId: 'w' }],
    [{}, user, { userId: 'u', workspaceId: 'other' }],
  ])(
    'rejects unbound, inactive, revoked or mismatched identity',
    async (i, u, s) =>
      await expect(create(i, u, s).validate('u', 'w', 's')).rejects.toThrow(),
  );
  test('rejects legacy token without a session', async () =>
    await expect(
      create({}, user, {}).validate('u', 'w', undefined),
    ).rejects.toThrow());
});

import * as identityPolicy from '../auth/feishu/lab-identity-policy';
describe('cached central inspection still enforces native identity', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture() {
    const state: any = {
      user: { id: 'u', workspaceId: 'w' },
      identity: { userId: 'u', directoryStatus: 'active' },
      session: { userId: 'u', workspaceId: 'w' },
      central: {
        subject: 'tenant:on_fictional00000001',
        expiresAt: new Date(Date.now() + 3600000),
        sealedGrant: identityPolicy.sealIdentity('private-token', 's', 'key'),
      },
    };
    const db = {
      selectFrom(table: string) {
        return {
          select() {
            return this;
          },
          selectAll() {
            return this;
          },
          where() {
            return this;
          },
          executeTakeFirst: async () =>
            table === 'labIdentitySessions' ? state.central : state.identity,
        };
      },
    };
    const inspect = jest
      .spyOn(identityPolicy, 'identityRequest')
      .mockImplementation(async () => ({
        subject: state.central.subject,
        expiresAt: state.central.expiresAt.toISOString(),
      }));
    const service = new NativeSessionService(
      db as any,
      new ConfigService({
        FEISHU_APP_ID: 'cli',
        FEISHU_TENANT_KEY: 'tenant',
        APP_SECRET: 'key',
        LAB_IDENTITY_ENABLED: 'true',
      }),
      { findById: async () => state.user } as any,
      { findActiveById: async () => state.session } as any,
    );
    return { state, inspect, service };
  }
  test.each([
    'account',
    'session',
    'directory',
    'central-expiry',
    'central-missing',
  ])('rejects %s revocation even within the cache lifetime', async (kind) => {
    const { state, inspect, service } = fixture();
    await service.validate('u', 'w', 's');
    expect(inspect).toHaveBeenCalledTimes(1);
    if (kind === 'account') state.user.deactivatedAt = new Date();
    if (kind === 'session') state.session = undefined;
    if (kind === 'directory') state.identity.directoryStatus = 'resigned';
    if (kind === 'central-expiry') state.central.expiresAt = new Date(0);
    if (kind === 'central-missing') state.central = undefined;
    await expect(service.validate('u', 'w', 's')).rejects.toThrow();
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  test('healthy repeat checks share central verification; logout is detected at the 15-second boundary', async () => {
    const { inspect, service } = fixture();
    const time = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(time);
    await service.validate('u', 'w', 's');
    await service.validate('u', 'w', 's');
    expect(inspect).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(time + 15_001);
    inspect.mockRejectedValue(new Error('revoked'));
    await expect(service.validate('u', 'w', 's')).rejects.toThrow('revoked');
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
