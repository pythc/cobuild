import { WritingBuffer } from '../../core/writing/writing-policy';
import {
  afterUnloadDocumentPayload,
  afterLoadDocumentPayload,
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getPageId, jsonToText, tiptapExtensions } from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();
  private readonly writing = new WritingBuffer();
  private lastWriter: Map<string, any> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
  ) {}

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    if (!document.isEmpty('default')) {
      return;
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const doc = new Y.Doc();
      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(doc, dbState);
      return doc;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);
      return ydoc;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    return new Y.Doc();
  }

  async afterLoadDocument(data: afterLoadDocumentPayload) {
    try {
      this.writing.loaded(
        data.documentName,
        jsonToText(TiptapTransformer.fromYdoc(data.document, 'default')) || '',
      );
    } catch {
      this.writing.unloaded(data.documentName);
      this.logger.warn('Writing statistics baseline unavailable');
    }
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    const { documentName, document } = data;
    let lastContext = data.lastContext;
    const readOnlyActor = lastContext?.knowledgeReadOnly
      ? this.lastWriter.get(documentName)
      : undefined;

    const pageId = getPageId(documentName);

    const tiptapJson = TiptapTransformer.fromYdoc(document, 'default');
    const ydocState = Buffer.from(Y.encodeStateAsUpdate(document));

    let textContent = null;

    try {
      textContent = jsonToText(tiptapJson);
    } catch (err) {
      this.logger.warn('jsonToText' + err?.['message']);
    }

    let page: Page = null;
    const editingUserIds = this.consumeContributors(documentName);
    const writing = this.writing.take(documentName);

    try {
      await executeTx(this.db, async (trx) => {
        page = await this.pageRepo.findById(pageId, {
          withLock: true,
          includeContent: true,
          trx,
        });

        if (!page) {
          this.logger.error(`Page with id ${pageId} not found`);
          return;
        }

        const space = await trx
          .selectFrom('spaces')
          .select(['isPersonal', 'creatorId', 'deletedAt'])
          .where('id', '=', page.spaceId)
          .executeTakeFirst();
        const actorId = readOnlyActor?.id || lastContext?.user?.id;
        if (
          !space ||
          space.deletedAt ||
          (space.isPersonal && actorId !== space.creatorId)
        ) {
          page = null;
          return;
        }
        if (isDeepStrictEqual(tiptapJson, page.content)) {
          if (lastContext?.knowledgeDurable)
            await trx
              .updateTable('pages')
              .set({ ydoc: ydocState })
              .where('id', '=', page.id)
              .execute();
          page = null;
          return;
        }
        if (lastContext?.knowledgeReadOnly)
          lastContext = {
            user: readOnlyActor || {
              id: page.lastUpdatedById || page.creatorId,
            },
          };

        let contributorIds = undefined;
        try {
          const existingContributors = page.contributorIds || [];
          contributorIds = Array.from(
            new Set([
              ...existingContributors,
              ...editingUserIds,
              page.creatorId,
            ]),
          );
        } catch (err) {
          //this.logger.debug('Contributors error:' + err?.['message']);
        }

        await this.pageRepo.updatePage(
          {
            content: tiptapJson,
            textContent: textContent,
            ydoc: ydocState,
            lastUpdatedById: lastContext.user.id,
            contributorIds: contributorIds,
          },
          pageId,
          trx,
        );

        if (!space.isPersonal && page.nodeType === 'page' && writing.length) {
          await trx
            .insertInto('writingActivity')
            .values(
              writing.map((row) => ({
                id: row.id,
                workspaceId: page.workspaceId,
                pageId: page.id,
                userId: row.userId,
                bucket: row.bucket,
                charsDelta: row.charsDelta,
                edited: true,
                created: false,
              })),
            )
            .onConflict((c) => c.column('id').doNothing())
            .execute();
        }
        this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
      });
    } catch (err) {
      this.writing.restore(documentName, writing);
      page = null;
      this.logger.error(`Failed to update page ${pageId}`, err);
    }

    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          lastUpdatedById: lastContext?.user?.id,
          lastUpdatedBy: lastContext?.user
            ? {
                id: lastContext.user?.id,
                name: lastContext.user?.name,
                avatarUrl: lastContext.user?.avatarUrl,
              }
            : undefined,
        }),
      );

      await this.syncTransclusion(pageId, page.workspaceId, tiptapJson);
    }

    if (page) {
      await this.collabHistory.addContributors(pageId, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      if (userMentions.length > 0) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          pageId,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.aiQueue.add(QueueJob.PAGE_CONTENT_UPDATED, {
        pageIds: [pageId],
        workspaceId: page.workspaceId,
      });

      await this.enqueuePageHistory(page);
    }
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    const userId = data.context?.knowledgeReadOnly
      ? undefined
      : data.context?.user?.id;
    try {
      this.writing.changed(
        documentName,
        userId,
        jsonToText(TiptapTransformer.fromYdoc(data.document, 'default')) || '',
      );
    } catch {
      this.writing.unloaded(documentName);
      this.logger.warn('Writing statistics attribution unavailable');
    }

    if (!userId || data.context?.knowledgeReadOnly) return;
    this.lastWriter.set(documentName, data.context.user);

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.lastWriter.delete(documentName);
    this.writing.unloaded(documentName);
  }

  private consumeContributors(documentName: string): string[] {
    const contributorSet = this.contributors.get(documentName);
    if (!contributorSet) return [];
    const userIds = [...contributorSet];
    this.contributors.delete(documentName);
    return userIds;
  }

  private async enqueuePageHistory(page: Page): Promise<void> {
    const pageAge = Date.now() - new Date(page.createdAt).getTime();
    const delay =
      pageAge < HISTORY_FAST_THRESHOLD
        ? HISTORY_FAST_INTERVAL
        : HISTORY_INTERVAL;

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id } as IPageHistoryJob,
      { jobId: page.id, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
  }
}
