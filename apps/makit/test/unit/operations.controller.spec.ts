import type { Request } from 'express';
import type { OperationsAccess } from '@shared/api.interface';
import {
  OperationsController,
  operationPage,
} from '../../server/modules/operations/operations.controller';
import type { OperationsAccessService } from '../../server/modules/operations/operations-access.service';
import type { OperationsService } from '../../server/modules/operations/operations.service';

describe('operations controller boundaries', () => {
  it('allows only own minimal save progress without exposing administrator audit fields', async () => {
    const audit = {
      id: 'job',
      requirementId: 'recTest',
      status: 'running',
      attempts: 1,
      result: null,
      errorMessage: '',
      createdAt: null,
      finishedAt: null,
      traceId: 'private-trace',
      fields: ['private-field'],
    };
    const list = jest.fn().mockResolvedValue({
      items: [audit],
      scope: 'mine',
      stats: { running: 1 },
      page: 1,
    });
    const controller = new OperationsController(
      { access: async () => member } as OperationsAccessService,
      { list } as unknown as OperationsService,
    );
    const result = await controller.progress({} as Request, {
      scope: 'all',
      actorUserId: 'victim',
    });
    expect(list).toHaveBeenCalledWith(
      member,
      expect.objectContaining({ scope: 'mine' }),
    );
    expect(list.mock.calls[0][1]).not.toHaveProperty('actorUserId');
    expect(result.items[0]).not.toHaveProperty('traceId');
    expect(result.items[0]).not.toHaveProperty('fields');
    expect(result.items[0].requirementId).toBe('recTest');
  });
  const member: OperationsAccess = {
    userId: '123',
    role: 'member',
    canViewAll: false,
    canManageAdmins: false,
    canViewNotifications: false,
  };
  it('rejects global access without executing the read service', async () => {
    const list = jest.fn();
    const controller = new OperationsController(
      {
        assertGlobal: async () => {
          throw new Error('仅运行管理员可查看记录');
        },
      } as OperationsAccessService,
      { list } as unknown as OperationsService,
    );
    await expect(
      controller.records({} as Request, { scope: 'all' }),
    ).rejects.toThrow('仅运行管理员');
    expect(list).not.toHaveBeenCalled();
  });
  it.each([
    '0',
    '-1',
    'Infinity',
    'NaN',
    '1.1',
    '999999999999999999999',
    '1e2',
  ])('rejects invalid pagination %s', (value) =>
    expect(() => operationPage(value, 1, 100)).toThrow(),
  );
  it('rejects runtime array pagination rather than coercing a single element', () => {
    expect(() => operationPage(['1'] as unknown as string, 1, 100)).toThrow();
  });
  it('ignores a forged actor and validates identifiers', async () => {
    const list = jest.fn();
    const controller = new OperationsController(
      { assertGlobal: async () => member } as OperationsAccessService,
      { list } as unknown as OperationsService,
    );
    await controller.records({} as Request, {
      actorUserId: 'victim',
      page: '1',
    });
    expect(list).toHaveBeenCalledWith(
      member,
      expect.not.objectContaining({ actorUserId: 'victim' }),
    );
    await expect(
      controller.records({} as Request, { operationId: "' OR true--" }),
    ).rejects.toThrow('格式');
    await expect(
      controller.records({} as Request, { status: 'hack' }),
    ).rejects.toThrow('状态');
  });
});
