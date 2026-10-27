import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { NotificationsController } from '../../server/modules/notifications/notifications.controller';
describe('business notification history', () => {
  it.each([[], ['viewer'], ['operations_viewer']].map((roles) => [roles]))(
    'allows any signed-in user %j without legacy privileged RPC',
    async (roles) => {
      const legacy = { list: jest.fn() },
        reader = { list: jest.fn().mockResolvedValue({ items: [] }) };
      const controller = new NotificationsController(
        legacy as never,
        {} as never,
        {} as never,
        {} as never,
        reader as never,
      );
      await controller.list(
        { userContext: { userId: 'member', roles } } as unknown as Request,
        'failed',
        '2',
        '25',
      );
      expect(reader.list).toHaveBeenCalledWith('failed', 2, 25);
      expect(legacy.list).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'anonymous_user_id'])(
    'rejects unauthenticated identity %j',
    async (userId) => {
      const reader = { list: jest.fn() };
      const controller = new NotificationsController(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        reader as never,
      );
      await expect(
        controller.list({ userContext: { userId } } as Request),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(reader.list).not.toHaveBeenCalled();
    },
  );
});
