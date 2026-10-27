import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page-access/page-access.service';

@Injectable()
export class PageReadingService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pages: PageRepo,
    private readonly access: PageAccessService,
  ) {}

  async visit(pageId: string, user: User) {
    const page = await this.pages.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== user.workspaceId)
      throw new NotFoundException('Page not found');
    await this.access.validateCanView(page, user);
    await this.db.transaction().execute(async tx => {
      // Bound retention even when several browser tabs update history together.
      await sql`select pg_advisory_xact_lock(hashtext(${user.workspaceId + ':' + user.id + ':reading'}))`.execute(tx);
      await tx.insertInto('pageReadingHistory')
        .values({ userId: user.id, workspaceId: user.workspaceId, pageId: page.id })
        .onConflict(c => c.columns(['userId', 'pageId']).doUpdateSet({ lastReadAt: sql`clock_timestamp()` }))
        .execute();
      await tx.deleteFrom('pageReadingHistory')
        .where('userId', '=', user.id).where('workspaceId', '=', user.workspaceId)
        .where('pageId', 'not in', tx.selectFrom('pageReadingHistory').select('pageId')
          .where('userId', '=', user.id).where('workspaceId', '=', user.workspaceId)
          .orderBy('lastReadAt', 'desc').orderBy('pageId').limit(100))
        .execute();
    });
    return { recorded: true };
  }

  async recent(user: User) {
    const rows = await this.db.selectFrom('pageReadingHistory as history')
      .innerJoin('pages', 'pages.id', 'history.pageId')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select(['pages.id', 'pages.slugId', 'pages.title', 'pages.icon', 'pages.nodeType', 'pages.fileExtension', 'pages.spaceId', 'pages.workspaceId', 'history.lastReadAt', 'spaces.name as spaceName', 'spaces.slug as spaceSlug'])
      .where('history.userId', '=', user.id).where('history.workspaceId', '=', user.workspaceId)
      .where('pages.workspaceId', '=', user.workspaceId).where('spaces.workspaceId', '=', user.workspaceId)
      .where('pages.deletedAt', 'is', null)
      .orderBy('history.lastReadAt', 'desc').orderBy('pages.id').limit(100).execute();
    const items = [];
    for (const row of rows) {
      try {
        // A read receipt is never an access grant. Recheck current permissions.
        await this.access.validateCanView(row as unknown as Page, user);
      } catch (error) {
        if (error instanceof ForbiddenException || error instanceof NotFoundException) continue;
        throw error;
      }
      items.push({ id: row.id, slugId: row.slugId, title: row.title, icon: row.icon, nodeType: row.nodeType, fileExtension: row.fileExtension, lastReadAt: row.lastReadAt, space: { id: row.spaceId, name: row.spaceName, slug: row.spaceSlug } });
      if (items.length === 6) break;
    }
    return { items };
  }
}
