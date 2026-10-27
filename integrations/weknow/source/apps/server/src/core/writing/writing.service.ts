import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { writingWeek } from './writing-policy';

@Injectable()
export class WritingService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly members: SpaceMemberRepo,
    private readonly permissions: PagePermissionRepo,
  ) {}
  async weekly(user: User) {
    const week = writingWeek();
    const meta = await this.db
      .selectFrom('writingStatisticsMetadata')
      .select('startedAt')
      .executeTakeFirst();
    const spaces = await this.members.getUserSpaceIds(user.id);
    const rows = spaces.length
      ? await this.db
          .selectFrom('writingActivity as a')
          .innerJoin('pages as p', 'p.id', 'a.pageId')
          .innerJoin('spaces as s', 's.id', 'p.spaceId')
          .innerJoin('users as u', 'u.id', 'a.userId')
          .select([
            'a.pageId',
            'a.userId',
            'u.name',
            'u.avatarUrl',
            sql<number>`sum(a.chars_delta)::float8`.as('characters'),
            sql<number>`count(distinct a.bucket) filter (where a.edited)::int`.as(
              'edits',
            ),
          ])
          .where('a.workspaceId', '=', user.workspaceId)
          .where('p.workspaceId', '=', user.workspaceId)
          .where('u.workspaceId', '=', user.workspaceId)
          .where('p.spaceId', 'in', spaces)
          .where('s.isPersonal', '=', false)
          .where('s.deletedAt', 'is', null)
          .where('p.deletedAt', 'is', null)
          .where('p.nodeType', '=', 'page')
          .where('u.deletedAt', 'is', null)
          .where('u.deactivatedAt', 'is', null)
          .where('a.bucket', '>=', week.start)
          .where('a.bucket', '<', week.end)
          .groupBy(['a.pageId', 'a.userId', 'u.name', 'u.avatarUrl'])
          .execute()
      : [];
    // Creation time and creator are recorded on each page, so this metric can
    // cover the entire current week even when activity recording began later.
    // Parent pages and subpages use the same query and permission filtering.
    const creations = spaces.length
      ? await this.db
          .selectFrom('pages as p')
          .innerJoin('spaces as s', 's.id', 'p.spaceId')
          .innerJoin('users as u', 'u.id', 'p.creatorId')
          .select(['p.id as pageId', 'p.creatorId as userId'])
          .where('p.workspaceId', '=', user.workspaceId)
          .where('u.workspaceId', '=', user.workspaceId)
          .where('p.spaceId', 'in', spaces)
          .where('s.isPersonal', '=', false)
          .where('s.deletedAt', 'is', null)
          .where('p.deletedAt', 'is', null)
          .where('p.nodeType', '=', 'page')
          .where('u.deletedAt', 'is', null)
          .where('u.deactivatedAt', 'is', null)
          .where('p.createdAt', '>=', week.start)
          .where('p.createdAt', '<', week.end)
          .execute()
      : [];
    const accessible = new Set(
      await this.permissions.filterAccessiblePageIds({
        pageIds: [
          ...new Set([...rows, ...creations].map((row) => row.pageId)),
        ],
        userId: user.id,
      }),
    );
    const people = new Map<
      string,
      {
        userId: string;
        name: string;
        avatarUrl: string;
        characters: number;
        edits: number;
        createdPages: number;
      }
    >();
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'avatarUrl'])
      .where('workspaceId', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .execute();
    for (const person of users)
      people.set(person.id, {
        userId: person.id,
        name: person.name,
        avatarUrl: person.avatarUrl,
        characters: 0,
        edits: 0,
        createdPages: 0,
      });
    for (const row of rows) {
      if (!accessible.has(row.pageId)) continue;
      const item = people.get(row.userId) || {
        userId: row.userId,
        name: row.name,
        avatarUrl: row.avatarUrl,
        characters: 0,
        edits: 0,
        createdPages: 0,
      };
      item.characters += Number(row.characters);
      item.edits += Number(row.edits);
      people.set(row.userId, item);
    }
    for (const page of creations) {
      if (!accessible.has(page.pageId)) continue;
      const person = people.get(page.userId);
      if (person) person.createdPages++;
    }
    return {
      start: week.start.toISOString(),
      end: week.end.toISOString(),
      timeZone: 'Asia/Shanghai',
      trackingSince: meta?.startedAt,
      members: [...people.values()],
      scope: 'visible-team-documents',
      editWindowMinutes: 5,
    };
  }
}
