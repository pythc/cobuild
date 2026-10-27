import { OfficeService } from './office.service';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
const user = { id: 'user', workspaceId: 'workspace', name: 'Member' };
function fixture() {
  const config: any = {
    get: (key: string) =>
      (
        ({
          OFFICE_PUBLIC_URL: 'http://office.local',
          OFFICE_JWT_SECRET: 'test-engine-secret',
        }) as any
      )[key],
    getOrThrow: (key: string) =>
      key === 'APP_SECRET' ? 'test-app-secret' : 'test-engine-secret',
  };
  const pages: any = {
    findById: jest.fn().mockResolvedValue({
      id: 'file',
      workspaceId: 'workspace',
      spaceId: 'space',
      nodeType: 'office',
      fileExtension: 'docx',
    }),
  };
  const access: any = {
    validateCanView: jest.fn(),
    validateCanEdit: jest.fn(),
    validateCanViewWithPermissions: jest
      .fn()
      .mockResolvedValue({ canEdit: false }),
  };
  const db: any = { selectFrom: jest.fn() };
  const users: any = { findById: jest.fn().mockResolvedValue(user) };
  const service = new OfficeService(
    db,
    config,
    pages,
    access,
    {} as any,
    {} as any,
    {} as any,
    users,
  );
  return { service, db, pages, access, config };
}
describe('Office access and callback boundaries', () => {
  it('rejects files in another workspace before inspecting permissions', async () => {
    const { service, pages, access } = fixture();
    pages.findById.mockResolvedValue({ id: 'file', workspaceId: 'other' });
    await expect(service.page('file', user)).rejects.toThrow(NotFoundException);
    expect(access.validateCanView).not.toHaveBeenCalled();
  });
  it('rejects soft-deleted files', async () => {
    const { service, pages } = fixture();
    pages.findById.mockResolvedValue({
      workspaceId: 'workspace',
      deletedAt: new Date(),
    });
    await expect(service.page('file', user)).rejects.toThrow(NotFoundException);
  });
  it('rejects writes to locked files', async () => {
    const { service, pages } = fixture();
    pages.findById.mockResolvedValue({
      workspaceId: 'workspace',
      isLocked: true,
    });
    await expect(service.page('file', user, true)).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('propagates page-level restrictions to viewers', async () => {
    const { service, access } = fixture();
    access.validateCanView.mockRejectedValue(new ForbiddenException());
    await expect(service.page('file', user)).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('rejects unsigned callbacks before reading a session', async () => {
    const { service, db } = fixture();
    await expect(
      service.callback('session', {
        key: 'session',
        status: 2,
        url: 'http://office.local/cache',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });
  it('rejects a token signed using the app secret instead of the engine secret', async () => {
    const { service } = fixture();
    const token = jwt.sign({ key: 'session', status: 2 }, 'test-app-secret');
    await expect(service.callback('session', { token })).rejects.toThrow(
      UnauthorizedException,
    );
  });
  it('rejects callbacks claiming a different editing session', async () => {
    const { service, db } = fixture();
    const token = jwt.sign({ key: 'other', status: 2 }, 'test-engine-secret');
    await expect(service.callback('session', { token })).rejects.toThrow();
    expect(db.selectFrom).not.toHaveBeenCalled();
  });
  it('refuses to save a view-only session even with an authentic callback', async () => {
    const { service, db } = fixture();
    const row = {
      id: 'session',
      expiresAt: new Date(Date.now() + 10000),
      users: { user: { edit: false } },
    };
    const chain: any = {
      selectAll: () => chain,
      where: () => chain,
      executeTakeFirst: async () => row,
    };
    db.selectFrom.mockReturnValue(chain);
    const token = jwt.sign(
      {
        key: 'session',
        status: 2,
        users: ['user'],
        url: 'http://office.local/cache',
      },
      'test-engine-secret',
    );
    await expect(service.callback('session', { token })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('replays a callback for a closed session without saving twice', async () => {
    const { service, db } = fixture();
    const row = {
      expiresAt: new Date(Date.now() + 10000),
      closedAt: new Date(),
    };
    const chain: any = {
      selectAll: () => chain,
      where: () => chain,
      executeTakeFirst: async () => row,
    };
    db.selectFrom.mockReturnValue(chain);
    const token = jwt.sign({ key: 'session', status: 2 }, 'test-engine-secret');
    await expect(service.callback('session', { token })).resolves.toEqual({
      error: 0,
    });
  });
});

describe('Office service-ticket directory revocation', () => {
  it.each(['resigned', 'exited', 'frozen', 'out_of_scope'])(
    'rejects source reads from %s members before opening bytes',
    async (directoryStatus) => {
      const { service, db, config } = fixture();
      config.get = (key: string) =>
        (
          ({
            FEISHU_SYNC_ENABLED: 'true',
            FEISHU_APP_ID: 'app',
            FEISHU_TENANT_KEY: 'tenant',
          }) as any
        )[key];
      const chain: any = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => ({
          directoryStatus,
          directoryCheckedAt: new Date(),
        }),
      };
      db.selectFrom.mockReturnValue(chain);
      const token = jwt.sign(
        { purpose: 'source', pageId: 'file', version: 1, userId: 'user' },
        'test-app-secret',
      );
      await expect(service.source(token)).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );
  it('rejects stale directory status for service tickets', async () => {
    const { service, db, config } = fixture();
    config.get = (key: string) =>
      (
        ({
          FEISHU_SYNC_ENABLED: 'true',
          FEISHU_APP_ID: 'app',
          FEISHU_TENANT_KEY: 'tenant',
        }) as any
      )[key];
    const chain: any = {
      select: () => chain,
      where: () => chain,
      executeTakeFirst: async () => ({
        directoryStatus: 'active',
        directoryCheckedAt: new Date(Date.now() - 3600000),
      }),
    };
    db.selectFrom.mockReturnValue(chain);
    const token = jwt.sign(
      { purpose: 'source', pageId: 'file', version: 1, userId: 'user' },
      'test-app-secret',
    );
    await expect(service.source(token)).rejects.toThrow(
      '飞书成员验证暂时不可用',
    );
  });
});
