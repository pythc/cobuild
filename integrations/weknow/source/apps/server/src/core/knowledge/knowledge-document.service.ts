import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import {
  htmlToJson,
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';
import { markdownToHtml } from '@docmost/editor-ext';
import { PageAccessService } from '../page/page-access/page-access.service';
import { KnowledgePrincipal } from './knowledge-oauth.service';
import {
  blockList,
  revision,
  validateDocument,
  previewPatches,
} from './knowledge-blocks';

@Injectable()
export class KnowledgeDocumentService {
  constructor(
    private pages: PageRepo,
    private history: PageHistoryRepo,
    private access: PageAccessService,
    private collab: CollaborationGateway,
    @InjectKysely() private db: Kysely<any>,
  ) {}
  async page(
    id: string,
    p: KnowledgePrincipal,
    edit = false,
    allowDeleted = false,
  ) {
    const page = await this.pages.findById(id, {
      includeContent: true,
      includeYdoc: true,
    });
    if (
      !page ||
      page.workspaceId !== p.workspace.id ||
      (!allowDeleted && page.deletedAt)
    )
      throw new NotFoundException('Document not found');
    if (edit && page.nodeType && page.nodeType !== 'page')
      throw new BadRequestException(
        'Use the file APIs for file and folder nodes',
      );
    if (edit) await this.access.validateCanEdit(page, p.user);
    else await this.access.validateCanView(page, p.user);
    return page;
  }
  async read(id: string, p: KnowledgePrincipal) {
    const page = await this.page(id, p);
    const live: any = await this.collab.handleYjsEvent(
      'knowledgeRead',
      'page.' + page.id,
      { user: p.user },
    );
    if (!live?.content)
      throw new ServiceUnavailableException('Live document is unavailable');
    // Opening an unloaded collaborative document can persist its initial Ydoc
    // and advance updatedAt. Re-read after that completes, and recheck access
    // in case it was moved, deleted or permissions changed during the read.
    const current = await this.page(page.id, p);
    const permissions = await this.access.validateCanViewWithPermissions(
      current,
      p.user,
    );
    return { ...live, page: current, permissions };
  }
  format(content: any, format: string) {
    return format === 'json'
      ? content
      : format === 'html'
        ? jsonToHtml(content)
        : jsonToMarkdown(content);
  }
  async parse(
    content: any,
    format: string = 'markdown',
    p?: KnowledgePrincipal,
  ) {
    if (content === undefined)
      throw new BadRequestException('Content required');
    const json =
      format === 'json'
        ? structuredClone(content)
        : htmlToJson(
            format === 'html' ? content : await markdownToHtml(content),
          );
    validateDocument(json);
    if (p) {
      const visit = async (node: any) => {
        if (node.type === 'mention' && node.attrs?.entityType === 'user') {
          const id = node.attrs.entityId;
          if (
            typeof id !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(id) ||
            !(await this.db
              .selectFrom('users')
              .select('id')
              .where('id', '=', id)
              .where('workspaceId', '=', p.workspace.id)
              .where('deletedAt', 'is', null)
              .where('deactivatedAt', 'is', null)
              .executeTakeFirst())
          )
            throw new BadRequestException('Mentioned member unavailable');
          node.attrs.creatorId = p.user.id;
        }
        for (const child of node.content || []) await visit(child);
      };
      await visit(json);
    }
    return json;
  }
  async get(a: any, p: KnowledgePrincipal) {
    const v = await this.read(a.pageId, p),
      content = this.format(v.content, a.format);
    const serialized =
      typeof content === 'string' ? content : JSON.stringify(content);
    // Never return truncated JSON pretending it is a complete editable document.
    const truncated = serialized.length > a.maxCharacters;
    return {
      id: v.page.id,
      title: v.page.title,
      icon: v.page.icon,
      spaceId: v.page.spaceId,
      parentPageId: v.page.parentPageId,
      updatedAt: v.page.updatedAt,
      revision: v.revision,
      permissions: v.permissions,
      format: a.format,
      content: truncated ? serialized.slice(0, a.maxCharacters) : content,
      truncated,
      totalCharacters: serialized.length,
      url: `/p/${v.page.slugId}`,
    };
  }
  async blocks(a: any, p: KnowledgePrincipal) {
    const v = await this.read(a.pageId, p),
      items = blockList(v.content);
    return {
      pageId: v.page.id,
      revision: v.revision,
      items: items.slice(a.offset, a.offset + a.limit),
      total: items.length,
      nextOffset: a.offset + a.limit < items.length ? a.offset + a.limit : null,
    };
  }
  async saveReviewHistory(page: any, content: any, userId: string) {
    await this.history.saveHistory(
      { ...page, content },
      { contributorIds: [userId] },
    );
  }
  async patch(a: any, p: KnowledgePrincipal) {
    const page = await this.page(a.pageId, p, true),
      before = await this.read(page.id, p);
    if (before.revision !== a.expectedRevision)
      throw new ConflictException('revision_conflict');
    const patches = [];
    for (const patch of a.patches) {
      patches.push({
        ...patch,
        ...(!['delete_block', 'replace_text'].includes(patch.operation)
          ? {
              prosemirrorJson: await this.parse(patch.content, patch.format, p),
            }
          : {}),
      });
    }
    // Save the actual live content before applying any edit; the editor's history queue remains active.
    previewPatches(before.content, patches);
    await this.history.saveHistory(
      { ...page, content: before.content },
      { contributorIds: [p.user.id] },
    );
    const result: any = await this.collab.handleYjsEvent(
      'knowledgePatch',
      'page.' + page.id,
      { user: p.user, expectedRevision: a.expectedRevision, patches },
    );
    if (result?.error) {
      if (result.error === 409) throw new ConflictException(result.message);
      if (result.error === 400) throw new BadRequestException(result.message);
      throw new ServiceUnavailableException('Write could not be confirmed');
    }
    if (!result?.stateVector)
      throw new ServiceUnavailableException('Write could not be confirmed');
    // Hocuspocus catches store hook failures. A successful API result requires a DB state vector
    // containing the write, rather than relying on disconnect() having resolved.
    const saved = await this.confirmStore(page.id, result.stateVector);
    return {
      pageId: page.id,
      revision: result.revision,
      replacements: result.replacements,
      updatedAt: saved.updatedAt,
    };
  }
  async checkpoint(id: string, p: KnowledgePrincipal) {
    const page = await this.page(id, p);
    const result: any = await this.collab.handleYjsEvent(
      'knowledgeCheckpoint',
      'page.' + page.id,
      { user: p.user },
    );
    if (!result?.stateVector)
      throw new ServiceUnavailableException(
        'Checkpoint could not be confirmed',
      );
    await this.confirmStore(page.id, result.stateVector);
  }
  async confirmStore(pageId: string, stateVector: string) {
    const saved = await this.pages.findById(pageId, { includeYdoc: true });
    const durable = new Y.Doc();
    try {
      if (!saved?.ydoc)
        throw new ServiceUnavailableException('Write durability is unknown');
      Y.applyUpdate(durable, new Uint8Array(saved.ydoc));
      const needed = Y.decodeStateVector(Buffer.from(stateVector, 'base64')),
        actual = Y.decodeStateVector(Y.encodeStateVector(durable));
      for (const [client, clock] of needed)
        if ((actual.get(client) || 0) < clock)
          throw new ServiceUnavailableException('Write durability is unknown');
    } finally {
      durable.destroy();
    }
    return saved;
  }
  async metadata(a: any, p: KnowledgePrincipal) {
    const page = await this.page(a.pageId, p, true);
    return this.db.transaction().execute(async (trx) => {
      const current = await this.pages.findById(page.id, {
        withLock: true,
        trx: trx as any,
      });
      if (
        new Date(current.updatedAt).getTime() !==
        new Date(a.expectedUpdatedAt).getTime()
      )
        throw new ConflictException('metadata_conflict');
      const changes: any = { lastUpdatedById: p.user.id };
      if (a.title !== undefined) changes.title = a.title;
      if (a.icon !== undefined) changes.icon = a.icon;
      if (a.title === undefined && a.icon === undefined)
        throw new BadRequestException('Title or icon required');
      await this.pages.updatePage(changes, page.id, trx as any);
      const updated = await this.pages.findById(page.id, { trx: trx as any });
      return {
        pageId: page.id,
        title: updated.title,
        icon: updated.icon,
        updatedAt: updated.updatedAt,
      };
    });
  }
  async restore(a: any, p: KnowledgePrincipal) {
    const h = await this.history.findById(a.historyId, {
      includeContent: true,
    });
    const page = await this.page(a.pageId, p, true);
    if (!h || h.workspaceId !== p.workspace.id || h.pageId !== page.id)
      throw new NotFoundException('History not found');
    return this.patch(
      {
        pageId: page.id,
        expectedRevision: a.expectedRevision,
        patches: [
          { operation: 'replace_document', content: h.content, format: 'json' },
        ],
      },
      p,
    );
  }
}
