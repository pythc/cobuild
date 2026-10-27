import { OfficeService } from '../office/office.service';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  HttpException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  KnowledgeOAuthService,
  KnowledgePrincipal,
} from './knowledge-oauth.service';
import { KnowledgeNativeService } from './knowledge-native.service';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeFileService } from './knowledge-file.service';
import {
  catalogForClient,
  operation,
  availableOperation,
} from './knowledge-catalog';
import { hash } from './knowledge-policy';
import { stableJson } from './knowledge-blocks';

@Injectable()
export class KnowledgeOperationService {
  constructor(
    private office: OfficeService,
    private oauth: KnowledgeOAuthService,
    private native: KnowledgeNativeService,
    private docs: KnowledgeDocumentService,
    private files: KnowledgeFileService,
    @InjectKysely() private db: Kysely<any>,
  ) {}
  async execute(name: string, input: any, p: KnowledgePrincipal) {
    const o = operation(name);
    if (!o) throw new NotFoundException('Unknown operation');
    if (!availableOperation(name, p.scopes)) this.oauth.require(p, o.scope);
    const parsed = o.schema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'invalid_arguments',
        issues: parsed.error.issues.map((v) => ({
          path: v.path,
          message: v.message,
        })),
      });
    const a: any = parsed.data;
    if (!o.mutates) return this.run(o, a, p);
    const id = randomUUID(),
      inputHash = hash(stableJson(a));
    const claimed = await this.db
      .insertInto('knowledgeOperations')
      .values({
        id,
        grantId: p.grant.id,
        requestId: a.requestId,
        name: o.name,
        inputHash,
        state: 'running',
      })
      .onConflict((c) => c.columns(['grantId', 'requestId']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!claimed) {
      const prior = await this.db
        .selectFrom('knowledgeOperations')
        .selectAll()
        .where('grantId', '=', p.grant.id)
        .where('requestId', '=', a.requestId)
        .executeTakeFirstOrThrow();
      if (prior.name !== name || prior.inputHash !== inputHash)
        throw new ConflictException('request_id_conflict');
      return {
        operationId: prior.id,
        state: prior.state,
        replayed: true,
        receipt: prior.receipt,
        errorCode: prior.errorCode,
      };
    }
    try {
      const value = await this.run(o, a, p),
        receipt = this.receipt(value, a);
      await this.db
        .updateTable('knowledgeOperations')
        .set({
          state: 'succeeded',
          receipt: sql`${JSON.stringify(receipt)}::text::jsonb`,
          finishedAt: new Date(),
        })
        .where('id', '=', id)
        .execute();
      return { operationId: id, state: 'succeeded', result: value };
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 503,
        state = status < 500 ? 'failed' : 'unknown';
      await this.db
        .updateTable('knowledgeOperations')
        .set({ state, errorCode: 'http_' + status, finishedAt: new Date() })
        .where('id', '=', id)
        .execute();
      throw new HttpException(
        {
          code: state === 'unknown' ? 'operation_unknown' : 'operation_failed',
          operationId: id,
          state,
          detail:
            status < 500 && error instanceof HttpException
              ? error.getResponse()
              : 'Inspect the operation receipt before retrying; do not change requestId',
        },
        status,
      );
    }
  }
  private receipt(v: any, a: any) {
    const r: any = {};
    for (const k of [
      'pageId',
      'spaceId',
      'groupId',
      'commentId',
      'attachmentId',
      'labelId',
    ])
      if (a[k] !== undefined) r[k] = a[k];
    for (const k of [
      'id',
      'pageId',
      'spaceId',
      'groupId',
      'commentId',
      'attachmentId',
      'revision',
      'updatedAt',
      'ticketId',
      'expiresAt',
      'watching',
    ])
      if (v && v[k] !== undefined) r[k] = v[k];
    return r;
  }
  async receiptGet(id: string, p: KnowledgePrincipal) {
    const row = await this.db
      .selectFrom('knowledgeOperations')
      .select([
        'id',
        'name',
        'state',
        'receipt',
        'errorCode',
        'createdAt',
        'finishedAt',
      ])
      .where('id', '=', id)
      .where('grantId', '=', p.grant.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Operation not found');
    if (
      row.state === 'running' &&
      new Date(row.createdAt).getTime() < Date.now() - 120000
    )
      return { ...row, state: 'unknown', errorCode: 'result_unconfirmed' };
    return row;
  }
  private async run(o: any, a: any, p: KnowledgePrincipal): Promise<any> {
    const { requestId, ...args } = a;
    switch (o.custom) {
      case 'managedUpload':
        return this.files.managedUploadTicket(args, p);
      case 'managedDownload':
        return this.files.managedDownloadTicket(args, p);
      case 'managedResult':
        return this.files.managedResultTicket(args, p);
      case 'directoryList':
        return this.office.list(args, p.user);
      case 'fileCreate':
        return this.office.create(args, p.user);
      case 'fileInfo':
        return this.office.info(args.pageId, p.user);
      case 'fileConvert':
        return this.office.convert(
          args.pageId,
          args.format,
          args.purpose,
          p.user,
        );
      case 'fileTask':
        return this.office.task(args.taskId, p.user);
      case 'fileRestore':
        return this.office.restore(
          args.pageId,
          args.version,
          args.expectedVersion,
          p.user,
        );
      case 'connection':
        return {
          connected: true,
          service: '110lab knowledge',
          transport: 'Streamable HTTP',
          user: { id: p.user.id, name: p.user.name },
          workspaceId: p.workspace.id,
          scopes: p.scopes,
        };
      case 'whoami':
        return {
          user: {
            id: p.user.id,
            name: p.user.name,
            avatarUrl: p.user.avatarUrl,
            role: p.user.role,
          },
          workspace: { id: p.workspace.id, name: p.workspace.name },
          scopes: p.scopes,
          connectionId: p.grant.id,
          expiresAt: p.grant.expiresAt,
        };
      case 'capabilities':
        return {
          operations: catalogForClient().filter((v) =>
            availableOperation(v.name, p.scopes),
          ),
          limits: {
            attachmentBytes: 20 * 1024 * 1024,
            managedFileBytes: 50 * 1024 * 1024,
            pendingFileTasks: 10,
            documentCharacters: 200000,
            patches: 100,
          },
          version: '1.0',
        };
      case 'operation':
        return this.receiptGet(a.operationId, p);
      case 'documentGet':
        return this.docs.get(a, p);
      case 'documentBlocks':
        return this.docs.blocks(a, p);
      case 'documentMetadata':
        return this.docs.metadata(a, p);
      case 'documentPatch':
        return this.docs.patch(a, p);
      case 'historyRestore':
        return this.docs.restore(a, p);
      case 'uploadTicket':
        return this.files.uploadTicket(a, p);
      case 'downloadTicket':
        return this.files.downloadTicket(a, p);
      case 'fileTicketGet':
        return this.files.get(a.ticketId, p);
      case 'exportTicket':
        return this.files.exportTicket(a, p);
      case 'mailPrepare':
        return this.files.mailPrepare(a, p);
      case 'commentCreate':
      case 'commentUpdate': {
        const { body, ...bodyArgs } = args;
        return this.native.request(
          o.route,
          {
            ...bodyArgs,
            content: JSON.stringify(await this.docs.parse(body, 'markdown', p)),
          },
          p,
        );
      }
    }
    const body = { ...args, ...o.defaults };
    if (o.name === 'kb_document_duplicate')
      await this.docs.checkpoint(body.pageId, p);
    if (o.name === 'kb_document_create' && body.content !== undefined) {
      body.content = await this.docs.parse(body.content, body.format, p);
      body.format = 'json';
    }
    if (
      ['kb_space_member_remove', 'kb_space_member_role'].includes(o.name) &&
      !!body.userId === !!body.groupId
    )
      throw new BadRequestException('Specify exactly one member or group');
    if (
      o.name === 'kb_space_members_add' &&
      !body.userIds.length &&
      !body.groupIds.length
    )
      throw new BadRequestException('Select at least one member or group');
    if (o.name === 'kb_document_purge') {
      const page = await this.docs.page(body.pageId, p, true, true);
      const role = await this.db
        .selectFrom('spaceMembers')
        .select('role')
        .where('spaceId', '=', page.spaceId)
        .where('userId', '=', p.user.id)
        .where('role', '=', 'admin')
        .executeTakeFirst();
      if (!role)
        throw new ForbiddenException(
          'Permanent deletion requires a direct space administrator',
        );
    }
    if (o.name === 'kb_search') {
      body.offset = body.cursor ? Number(body.cursor) : 0;
      if (
        !Number.isSafeInteger(body.offset) ||
        body.offset < 0 ||
        body.offset > 10000
      )
        throw new BadRequestException('Invalid search cursor');
      delete body.cursor;
    }
    return this.native.request(o.route, body, p);
  }
}
