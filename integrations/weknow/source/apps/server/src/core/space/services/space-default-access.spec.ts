import { ServiceUnavailableException } from '@nestjs/common';
import { SpaceService } from './space.service';
import { SpaceRole } from '../../../common/helpers/types/permission';

describe('new team space access', () => {
  const user = { id: 'creator', workspaceId: 'workspace' } as any;
  const input = { name: 'Team notes', slug: 'team-notes' };

  function setup(isPersonal = false) {
    const space = { id: 'new-space', ...input, isPersonal };
    const trx = { marker: 'same-transaction' };
    const db = {
      transaction: jest.fn(() => ({
        execute: (callback: (tx: unknown) => unknown) => callback(trx),
      })),
    };
    const spaces = {
      slugExists: jest.fn().mockResolvedValue(false),
      insertSpace: jest.fn().mockResolvedValue(space),
      findById: jest.fn().mockResolvedValue({ ...space, memberCount: 27 }),
    };
    const members = {
      addUserToSpace: jest.fn().mockResolvedValue(undefined),
      addGroupToSpace: jest.fn().mockResolvedValue(undefined),
    };
    const groups = {
      getDefaultGroup: jest.fn().mockResolvedValue({ id: 'everyone' }),
    };
    const audit = { log: jest.fn() };
    const service = new SpaceService(
      spaces as any,
      members as any,
      {} as any,
      {} as any,
      {} as any,
      db as any,
      {} as any,
      audit as any,
      groups as any,
    );
    return { service, spaces, members, groups, db, trx, audit };
  }

  it('grants the workspace default group writer access and retains the creator as admin in the same transaction', async () => {
    const { service, spaces, members, groups, trx } = setup();
    const result = await service.createSpace(user, user.workspaceId, input);
    expect(groups.getDefaultGroup).toHaveBeenCalledWith(user.workspaceId, trx);
    expect(members.addUserToSpace).toHaveBeenCalledWith(
      user.id,
      result.id,
      SpaceRole.ADMIN,
      user.workspaceId,
      trx,
    );
    expect(members.addGroupToSpace).toHaveBeenCalledWith(
      'everyone',
      result.id,
      SpaceRole.WRITER,
      user.workspaceId,
      trx,
    );
    expect(members.addGroupToSpace).toHaveBeenCalledTimes(1);
    expect(spaces.findById).toHaveBeenCalledWith(result.id, user.workspaceId, {
      includeMemberCount: true,
      trx,
    });
    expect(result.memberCount).toBe(27);
  });

  it('never grants the default group access to a personal space', async () => {
    const { service, members, groups } = setup(true);
    const result = await service.createSpace(
      user,
      user.workspaceId,
      input,
      undefined,
      { isPersonal: true },
    );
    expect(groups.getDefaultGroup).not.toHaveBeenCalled();
    expect(members.addGroupToSpace).not.toHaveBeenCalled();
    expect(members.addUserToSpace).toHaveBeenCalledWith(
      user.id,
      result.id,
      SpaceRole.ADMIN,
      user.workspaceId,
      expect.anything(),
    );
    expect(result.memberCount).toBe(1);
  });

  it('fails the creation transaction if the authoritative all-members group is missing', async () => {
    const { service, groups, members, audit } = setup();
    groups.getDefaultGroup.mockResolvedValue(undefined);
    await expect(
      service.createSpace(user, user.workspaceId, input),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(members.addGroupToSpace).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('propagates group grant failures rather than reporting successful creation', async () => {
    const { service, members, audit } = setup();
    members.addGroupToSpace.mockRejectedValue(new Error('grant failed'));
    await expect(
      service.createSpace(user, user.workspaceId, input),
    ).rejects.toThrow('grant failed');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('uses an existing caller transaction for both the space and its permissions', async () => {
    const { service, db, trx, spaces, members, groups } = setup();
    await service.createSpace(user, user.workspaceId, input, trx as any);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(spaces.insertSpace).toHaveBeenCalledWith(
      expect.objectContaining({ isPersonal: false }),
      trx,
    );
    expect(groups.getDefaultGroup).toHaveBeenCalledWith(user.workspaceId, trx);
    expect(members.addGroupToSpace.mock.calls[0][4]).toBe(trx);
  });

  it('leaves low-level workspace bootstrap creation unchanged, avoiding duplicate default-group grants', async () => {
    const { service, members, groups, trx } = setup();
    await service.create(user.id, user.workspaceId, input, trx as any);
    expect(groups.getDefaultGroup).not.toHaveBeenCalled();
    expect(members.addGroupToSpace).not.toHaveBeenCalled();
  });
});
