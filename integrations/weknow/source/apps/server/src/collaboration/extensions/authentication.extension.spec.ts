import { AuthenticationExtension } from './authentication.extension';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
describe('live collaboration permission revocation', () => {
  let native: any,
    page: any,
    roles: any,
    permissions: any,
    extension: AuthenticationExtension;
  beforeEach(() => {
    native = { validate: jest.fn(async () => ({ id: 'u', workspaceId: 'w' })) };
    page = {
      findById: jest.fn(async () => ({
        id: 'p',
        spaceId: 's',
        workspaceId: 'w',
        deletedAt: null,
      })),
    };
    roles = {
      getUserSpaceRoles: jest.fn(async () => [{ userId: 'u', role: 'writer' }]),
    };
    permissions = {
      canUserEditPage: jest.fn(async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      })),
    };
    extension = new AuthenticationExtension(
      {
        verifyJwt: jest.fn(async () => ({
          sub: 'u',
          workspaceId: 'w',
          sessionId: 'session',
        })),
      } as any,
      native,
      {} as any,
      page,
      roles,
      permissions,
    );
  });
  afterEach(() => {
    extension.onModuleDestroy();
    jest.useRealTimers();
  });
  const payload = (readOnly = false) => ({
    context: {
      nativeSession: {
        userId: 'u',
        workspaceId: 'w',
        sessionId: 'session',
        pageId: 'p',
        nextCheck: 0,
      },
    },
    connection: { readOnly, close: jest.fn() },
  });
  test('writer can continue with an active session and unchanged permissions', async () =>
    await expect(
      extension.beforeHandleMessage(payload()),
    ).resolves.toBeUndefined());
  test('removing a space member blocks the next authorized message', async () => {
    roles.getUserSpaceRoles.mockResolvedValue([]);
    await expect(extension.beforeHandleMessage(payload())).rejects.toThrow();
  });
  test('downgrade to reader closes writable connection for reauthentication', async () => {
    roles.getUserSpaceRoles.mockResolvedValue([
      { userId: 'u', role: 'reader' },
    ]);
    const data = payload();
    await expect(extension.beforeHandleMessage(data)).rejects.toThrow();
    expect(data.connection.close).toHaveBeenCalledWith({
      code: 4403,
      reason: 'Permissions changed',
    });
  });
  test('reader can keep a read-only connection', async () => {
    roles.getUserSpaceRoles.mockResolvedValue([
      { userId: 'u', role: 'reader' },
    ]);
    await expect(
      extension.beforeHandleMessage(payload(true)),
    ).resolves.toBeUndefined();
  });
  test('removed page-level permission cannot retain the open connection', async () => {
    permissions.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: false,
      canEdit: false,
    });
    await expect(extension.beforeHandleMessage(payload())).rejects.toThrow();
  });
  test('foreign-workspace page is denied', async () => {
    page.findById.mockResolvedValue({
      id: 'p',
      workspaceId: 'other',
      spaceId: 's',
    });
    await expect(extension.beforeHandleMessage(payload())).rejects.toThrow();
  });
  test('revoked or suspended member cannot keep editing', async () => {
    native.validate.mockRejectedValue(new Error('revoked'));
    await expect(extension.beforeHandleMessage(payload())).rejects.toThrow();
  });
  test('temporary inspection failure rejects the update and uses a recoverable reason', async () => {
    native.validate.mockRejectedValue(new ServiceUnavailableException());
    const data = payload();
    await expect(extension.beforeHandleMessage(data)).rejects.toMatchObject({
      reason: 'identity-unavailable',
    });
    expect(data.connection.readOnly).toBe(true);
    expect(data.context.nativeSession.nextCheck).toBe(0);
    expect(data.connection.close).toHaveBeenCalledWith({
      code: 1013,
      reason: 'identity-unavailable',
    });
  });
  test('periodic temporary inspection failure is not reported as session expiry', async () => {
    jest.useFakeTimers();
    native.validate.mockRejectedValue(new ServiceUnavailableException());
    const data = { ...payload(), socketId: 'socket', documentName: 'page.p' };
    await extension.connected(data);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(data.connection.close).toHaveBeenCalledWith({
      code: 1013,
      reason: 'identity-unavailable',
    });
  });
  test('confirmed revocation closes immediately and never advances the authorization window', async () => {
    native.validate.mockRejectedValue(new UnauthorizedException());
    const data = payload();
    await expect(extension.beforeHandleMessage(data)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(data.connection.close).toHaveBeenCalledWith({
      code: 4401,
      reason: 'Session expired',
    });
    expect(data.context.nativeSession.nextCheck).toBe(0);
  });
  test('initial temporary failure exposes only the fixed retry marker', async () => {
    native.validate.mockRejectedValue(
      new ServiceUnavailableException('private diagnostic'),
    );
    await expect(
      extension.onAuthenticate({
        documentName: 'page.p',
        token: 'fixture',
      } as any),
    ).rejects.toMatchObject({
      reason: 'identity-unavailable',
      message: 'Identity temporarily unavailable',
    });
  });
  test('initial explicit revocation remains a denial instead of a retry marker', async () => {
    native.validate.mockRejectedValue(new UnauthorizedException());
    await expect(
      extension.onAuthenticate({
        documentName: 'page.p',
        token: 'fixture',
      } as any),
    ).rejects.toThrow(UnauthorizedException);
  });
});
