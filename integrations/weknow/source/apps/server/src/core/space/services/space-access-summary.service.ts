import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';

@Injectable()
export class SpaceAccessSummaryService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}
  async forUser(spaceId: string, user: User) {
    const space = await this.db.selectFrom('spaces').select('id')
      .where('id', '=', spaceId).where('workspaceId', '=', user.workspaceId).executeTakeFirst();
    if (!space) throw new NotFoundException('Space not found');
    const direct = await this.db.selectFrom('spaceMembers').select('role')
      .where('spaceId', '=', spaceId).where('userId', '=', user.id).execute();
    const groups = await this.db.selectFrom('spaceMembers')
      .innerJoin('groups', 'groups.id', 'spaceMembers.groupId')
      .innerJoin('groupUsers', 'groupUsers.groupId', 'groups.id')
      .select(['groups.id', 'groups.name', 'groups.isDefault', 'spaceMembers.role'])
      .where('spaceMembers.spaceId', '=', spaceId).where('groupUsers.userId', '=', user.id)
      .where('groups.workspaceId', '=', user.workspaceId).orderBy('groups.name').execute();
    const sources = [
      ...direct.map(row => ({ type: 'direct' as const, id: user.id, name: user.name, role: row.role, isDefault: false })),
      ...groups.map(row => ({ type: 'group' as const, ...row })),
    ];
    if (!sources.length) throw new ForbiddenException();
    const role = findHighestUserSpaceRole(sources.map(s => ({ userId: user.id, role: s.role })));
    if (![SpaceRole.ADMIN, SpaceRole.WRITER, SpaceRole.READER].includes(role as SpaceRole)) throw new ForbiddenException();
    return { role, sources };
  }
}
