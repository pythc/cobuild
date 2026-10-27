import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { KnowledgeDocumentService } from '../knowledge/knowledge-document.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import * as Y from 'yjs';
import { canonical } from './review-yjs';

@Injectable()
export class ReviewService {
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private documents: KnowledgeDocumentService,
    private access: PageAccessService,
    private collab: CollaborationGateway,
  ) {}

  async list(pageId: string, principal: any) {
    await this.documents.page(pageId, principal);
    return this.db
      .selectFrom('documentSuggestions as s')
      .leftJoin('users as u', 'u.id', 's.creatorId')
      .leftJoin('users as r', 'r.id', 's.resolvedById')
      .select([
        's.id',
        's.pageId',
        's.original',
        's.replacement',
        's.status',
        's.creatorId',
        's.createdAt',
        's.resolvedAt',
        'u.name as creatorName',
        'r.name as resolvedByName',
      ])
      .where('s.pageId', '=', pageId)
      .orderBy('s.createdAt', 'desc')
      .limit(200)
      .execute();
  }

  async create(dto: any, principal: any) {
    const page = await this.documents.page(dto.pageId, principal);
    await this.access.validateCanComment(
      page,
      principal.user,
      principal.workspace.id,
    );
    if (page.nodeType && page.nodeType !== 'page')
      throw new BadRequestException('请在原生文档中提出修订');
    const existing = await this.db
      .selectFrom('documentSuggestions')
      .selectAll()
      .where('id', '=', dto.id)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.creatorId !== principal.user.id ||
        existing.pageId !== page.id ||
        existing.replacement !== dto.replacement ||
        canonical(
          typeof existing.selection === 'string'
            ? JSON.parse(existing.selection)
            : existing.selection,
        ) !== canonical(dto.selection)
      )
        throw new ConflictException('Request id already used');
      return { id: existing.id };
    }
    const snapshot: any = await this.collab.handleYjsEvent(
      'reviewRead',
      'page.' + page.id,
      { user: principal.user, selection: dto.selection },
    );
    if (snapshot?.error)
      throw new HttpException(snapshot.message, snapshot.error);
    if (!snapshot?.fingerprint)
      throw new ServiceUnavailableException('无法读取当前选区');
    if (snapshot.original === dto.replacement)
      throw new BadRequestException('建议与原文相同');
    await this.db
      .insertInto('documentSuggestions')
      .values({
        id: dto.id,
        pageId: page.id,
        creatorId: principal.user.id,
        original: snapshot.original,
        replacement: dto.replacement,
        selection: dto.selection,
        fingerprint: snapshot.fingerprint,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const saved = await this.db
      .selectFrom('documentSuggestions')
      .selectAll()
      .where('id', '=', dto.id)
      .executeTakeFirstOrThrow();
    if (
      saved.creatorId !== principal.user.id ||
      saved.pageId !== page.id ||
      saved.replacement !== dto.replacement ||
      canonical(
        typeof saved.selection === 'string'
          ? JSON.parse(saved.selection)
          : saved.selection,
      ) !== canonical(dto.selection)
    )
      throw new ConflictException('Request id already used');
    return { id: dto.id };
  }

  async decide(dto: any, principal: any) {
    const decision = await this.db.transaction().execute(async (trx) => {
      const s = await trx
        .selectFrom('documentSuggestions')
        .selectAll()
        .where('id', '=', dto.id)
        .forUpdate()
        .executeTakeFirst();
      if (!s) throw new NotFoundException();
      const page = await this.documents.page(s.pageId, principal, true);
      if (s.status !== 'pending') {
        if (s.status !== dto.decision)
          throw new ConflictException('建议已被处理');
        return { id: s.id, status: s.status };
      }
      let actorId = principal.user.id,
        resolvedAt = new Date();
      if (dto.decision === 'accepted') {
        const before = await this.documents.read(page.id, principal);
        // Preserve a history checkpoint, including before the first edit after a long idle period.
        await this.documents.saveReviewHistory(
          page,
          before.content,
          principal.user.id,
        );
      }
      // Decisions live in the same durable Yjs transaction as accepted text.
      // A retry after an unknown SQL outcome must reconcile this receipt first.
      const result: any = await this.collab.handleYjsEvent(
        'reviewApply',
        'page.' + page.id,
        {
          user: principal.user,
          suggestion: {
            ...s,
            selection:
              typeof s.selection === 'string'
                ? JSON.parse(s.selection)
                : s.selection,
            decision: dto.decision,
          },
        },
      );
      if (result?.error) throw new HttpException(result.message, result.error);
      if (!result?.stateVector || !result?.receipt)
        throw new ServiceUnavailableException('保存未确认，请重试同一建议');
      await this.documents.confirmStore(page.id, result.stateVector);
      actorId = result.receipt.actorId;
      resolvedAt = new Date(result.receipt.appliedAt);
      const status = result.receipt.decision || 'accepted';
      await trx
        .updateTable('documentSuggestions')
        .set({ status, resolvedById: actorId, resolvedAt })
        .where('id', '=', s.id)
        .execute();
      return { id: s.id, status };
    });
    if (decision.status !== dto.decision)
      throw new ConflictException('这条建议已被处理，已刷新为实际结果');
    return decision;
  }

  async checkpoint(
    pageId: string,
    stateVector: string,
    deleteRanges: any[],
    principal: any,
  ) {
    if (
      !deleteRanges.every(
        (r) =>
          r &&
          ['client', 'clock', 'len'].every(
            (k) => Number.isSafeInteger(r[k]) && r[k] >= 0,
          ),
      )
    )
      throw new BadRequestException('Invalid deletion ranges');
    let wanted: Map<number, number>;
    try {
      wanted = Y.decodeStateVector(Buffer.from(stateVector, 'base64'));
    } catch {
      throw new BadRequestException('Invalid state vector');
    }
    await this.documents.checkpoint(pageId, principal);
    const stored = await this.db
      .selectFrom('pages')
      .select(['ydoc', 'updatedAt'])
      .where('id', '=', pageId)
      .executeTakeFirst();
    const doc = new Y.Doc();
    try {
      if (stored?.ydoc) Y.applyUpdate(doc, stored.ydoc);
      const actual = Y.decodeStateVector(Y.encodeStateVector(doc));
      const storedDeletes = Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds
        .clients;
      const deletionsSaved = deleteRanges.every((r) =>
        (storedDeletes.get(r.client) || []).some(
          (d) => d.clock <= r.clock && d.clock + d.len >= r.clock + r.len,
        ),
      );
      return {
        durable:
          deletionsSaved &&
          [...wanted].every(
            ([client, clock]) => (actual.get(client) || 0) >= clock,
          ),
        updatedAt: stored?.updatedAt,
      };
    } finally {
      doc.destroy();
    }
  }

  async member(pageId: string, memberId: string, principal: any) {
    const page = await this.documents.page(pageId, principal);
    const member = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', memberId)
      .where('workspaceId', '=', principal.workspace.id)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .executeTakeFirst();
    if (!member) throw new NotFoundException('成员不可用');
    let canView = false;
    try {
      await this.access.validateCanView(page, member as any);
      canView = true;
    } catch (e: any) {
      if (![403, 404].includes(e.getStatus?.())) throw e;
    }
    const owner = await this.db
      .selectFrom('users')
      .select(['id', 'name'])
      .where('id', '=', page.creatorId)
      .executeTakeFirst();
    return {
      id: member.id,
      name: member.name,
      avatarUrl: member.avatarUrl,
      canView,
      owner: owner || null,
    };
  }
}
