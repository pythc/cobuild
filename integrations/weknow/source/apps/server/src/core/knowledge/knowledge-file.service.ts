import { OfficeService } from '../office/office.service';
import { OFFICE_LIMIT } from '../office/office-policy';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHmac } from 'node:crypto';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { AttachmentService } from '../attachment/services/attachment.service';
import { KnowledgeDocumentService } from './knowledge-document.service';
import {
  KnowledgeOAuthService,
  KnowledgePrincipal,
} from './knowledge-oauth.service';
import { hash, same } from './knowledge-policy';
import { NativeSessionService } from '../session/native-session.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Interval } from '@nestjs/schedule';

const json = (v: any) => sql`${JSON.stringify(v)}::text::jsonb`;
function safeName(v: string) {
  return (
    v.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 150) || 'document'
  );
}
@Injectable()
export class KnowledgeFileService {
  private uploads=0;
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private office: OfficeService,
    private config: ConfigService,
    private oauth: KnowledgeOAuthService,
    private docs: KnowledgeDocumentService,
    private storage: StorageService,
    private attachments: AttachmentRepo,
    private uploader: AttachmentService,
    private sessions: NativeSessionService,
    private workspaces: WorkspaceRepo,
  ) {}
  private token(row: any) {
    return (
      'kb_f_' +
      createHmac('sha256', this.config.getOrThrow('APP_SECRET'))
        .update(
          row.id +
            '\n' +
            row.grantId +
            '\n' +
            row.purpose +
            '\n' +
            new Date(row.expiresAt).toISOString(),
        )
        .digest('base64url')
    );
  }
  private describe(row: any) {
    return {
      ticketId: row.id,
      purpose: row.purpose,
      url: this.oauth.origin + '/api/knowledge/files/' + row.id,
      token: this.token(row),
      expiresAt: row.expiresAt,
      fileName: row.data.fileName,
      size: row.data.size,
      mimeType: row.data.mimeType,
      helperUrl: this.oauth.origin + '/knowledge-helper.py?v=0.2.0',
      helperVersion: '0.2.0',
    };
  }
  async get(id: string, p: KnowledgePrincipal) {
    const row = await this.db
      .selectFrom('knowledgeFileTickets')
      .selectAll()
      .where('id', '=', id)
      .where('grantId', '=', p.grant.id)
      .executeTakeFirst();
    if (!row)throw new NotFoundException('Ticket not found');
    for (const pageId of row.data.pageIds || [row.data.pageId])
      await this.docs.page(pageId, p);
    if(row.receipt?.state==='running'&&new Date(row.usedAt).getTime()<Date.now()-120000)row.receipt={state:'unknown'};
    if(new Date(row.expiresAt).getTime()<=Date.now())return {ticketId:row.id,purpose:row.purpose,expiresAt:row.expiresAt,expired:true,receipt:row.receipt};
    return { ...this.describe(row), receipt: row.receipt };
  }
  private async create(
    purpose: string,
    data: any,
    p: KnowledgePrincipal,
    bytes?: Buffer,
  ) {
    const row: any = {
      id: randomUUID(),
      grantId: p.grant.id,
      purpose,
      data,
      expiresAt: new Date(
        Math.min(Date.now() + 600000, new Date(p.grant.expiresAt).getTime()),
      ),
    };
    if (bytes) {
      if(bytes.length>20*1024*1024)throw new BadRequestException('Export exceeds 20 MiB; use the browser export');
      data.storagePath = p.workspace.id + '/knowledge-tickets/' + row.id;
      data.size = bytes.length;
    }
    try {
      await this.db.transaction().execute(async t=>{
        await sql`select pg_advisory_xact_lock(hashtext('knowledge:files:quota'))`.execute(t);
        const count=await t.selectFrom('knowledgeFileTickets').select(sql<number>`count(*)::int`.as('n')).where('grantId','=',p.grant.id).where('expiresAt','>',new Date()).executeTakeFirst();
        if(count.n>=20)throw new BadRequestException('At most 20 active file tickets per connection');
        await t
        .insertInto('knowledgeFileTickets')
        .values({ ...row, tokenHash: hash(this.token(row)), data: json(data) })
        .execute();
      });
      if(bytes)await this.storage.upload(data.storagePath,bytes);
    } catch (error) {
      await this.db.deleteFrom('knowledgeFileTickets').where('id','=',row.id).execute().catch(()=>{});
      if (data.storagePath)
        await this.storage.delete(data.storagePath).catch(() => {});
      throw error;
    }
    return this.describe(row);
  }
  async managedUploadTicket(a: any, p: KnowledgePrincipal) {
    if (safeName(a.fileName) !== a.fileName || a.size > OFFICE_LIMIT) throw new BadRequestException('Invalid file name or size');
    await this.office.directory(a,p.user,true);
    if(a.pageId) await this.office.page(a.pageId,p.user,true);
    return this.create('office-upload',{...a,pageIds:[a.pageId || a.parentPageId].filter(Boolean)},p);
  }
  async managedDownloadTicket(a: any,p: KnowledgePrincipal) {
    const file = await this.office.download(a.pageId,p.user,a.version);
    file.stream.destroy();
    return this.create('office-download',{pageId:a.pageId,version:file.version,fileName:file.fileName,mimeType:file.mimeType,size:file.size},p);
  }
  async managedResultTicket(a: any,p: KnowledgePrincipal) {
    const task = await this.office.task(a.taskId,p.user), file = await this.office.result(a.taskId,p.user);
    file.stream.destroy();
    return this.create('office-result',{pageId:task.pageId,taskId:a.taskId,fileName:file.fileName,mimeType:file.mimeType,size:file.size},p);
  }
  async uploadTicket(a: any, p: KnowledgePrincipal) {
    const page = await this.docs.page(a.pageId, p, true);
    if (safeName(a.fileName) !== a.fileName)
      throw new BadRequestException('Use a file name without path separators');
    return this.create(
      'upload',
      {
        pageId: page.id,
        fileName: a.fileName,
        size: a.size,
        mimeType: a.mimeType,
      },
      p,
    );
  }
  private async attachment(id: string, p: KnowledgePrincipal) {
    const a = await this.attachments.findById(id);
    if (!a || a.deletedAt || a.workspaceId !== p.workspace.id || !a.pageId)
      throw new NotFoundException('Attachment not found');
    await this.docs.page(a.pageId, p);
    if (Number(a.fileSize) > 20 * 1024 * 1024)
      throw new BadRequestException(
        'Use the browser to download files above 20 MiB',
      );
    return a;
  }
  async downloadTicket(a: any, p: KnowledgePrincipal) {
    const file = await this.attachment(a.attachmentId, p);
    return this.create(
      'download',
      {
        attachmentId: file.id,
        pageId: file.pageId,
        fileName: file.fileName,
        size: file.fileSize,
        mimeType: file.mimeType,
      },
      p,
    );
  }
  async exportTicket(a: any, p: KnowledgePrincipal) {
    const v = await this.docs.read(a.pageId, p),
      value = this.docs.format(v.content, a.format),
      fileName =
        safeName(v.page.title || 'document') +
        '.' +
        (a.format === 'markdown' ? 'md' : a.format);
    return {
      ...(await this.create(
        'export',
        {
          pageId: v.page.id,
          revision: v.revision,
          fileName,
          mimeType:
            a.format === 'html'
              ? 'text/html'
              : a.format === 'json'
                ? 'application/json'
                : 'text/markdown',
        },
        p,
        Buffer.from(
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        ),
      )),
      revision: v.revision,
    };
  }
  async mailPrepare(a: any, p: KnowledgePrincipal) {
    const documents = [];
    for (const id of a.pageIds) {
      const v = await this.docs.read(id, p);
      documents.push({
        id: v.page.id,
        title: v.page.title,
        revision: v.revision,
        fileName: safeName(v.page.title || 'document') + '.md',
        markdown: this.docs.format(v.content, 'markdown'),
        url: this.oauth.origin + '/p/' + v.page.slugId,
      });
    }
    const packageData = { version: 1, subject: a.subject, to: a.to, documents };
    const bytes = Buffer.from(JSON.stringify(packageData, null, 2));
    if (bytes.length > 2 * 1024 * 1024)
      throw new BadRequestException('Select fewer documents');
    const ticket = await this.create(
      'mail',
      {
        pageIds: documents.map((v) => v.id),
        fileName: 'knowledge-mail.json',
        mimeType: 'application/json',
      },
      p,
      bytes,
    );
    return {
      prepared: true,
      sent: false,
      documents: documents.map(({ markdown, ...metadata }) => metadata),
      mail: {
        subject: a.subject,
        to: a.to,
        body: documents.map((d) => `${d.title}\n${d.url}`).join('\n\n'),
      },
      package: ticket,
      next: 'Download the package with the helper, then use the existing lab mail draft, confirmation and send tools. No email has been sent.',
    };
  }
  async validate(id: string, bearer: unknown, purpose?: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new NotFoundException();
    const row = await this.db
      .selectFrom('knowledgeFileTickets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    const raw =
      typeof bearer === 'string' && /^Bearer\s+/i.test(bearer)
        ? bearer.replace(/^Bearer\s+/i,'')
        : '';
    if (
      !row ||
      !same(hash(raw), row.tokenHash) ||
      new Date(row.expiresAt).getTime() <= Date.now() ||
      (purpose && row.purpose !== purpose)
    )
      throw new UnauthorizedException('Invalid or expired file ticket');
    const grant = await this.db
      .selectFrom('knowledgeOAuthGrants')
      .selectAll()
      .where('id', '=', row.grantId)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (!grant || grant.resource !== this.oauth.resource)
      throw new UnauthorizedException('Connection revoked');
    const user = await this.sessions.validate(
        grant.userId,
        grant.workspaceId,
        grant.sessionId,
      ),
      workspace = await this.workspaces.findById(grant.workspaceId);
    const p: any = { user, workspace, grant, scopes: grant.scopes };
    if (!workspace) throw new UnauthorizedException();
    for (const pageId of row.data.pageIds || [row.data.pageId])
      await this.docs.page(pageId, p, row.purpose === 'upload');
    if (row.purpose === 'office-upload') {
      await this.office.directory(row.data,p.user,true);
      if(row.data.pageId) await this.office.page(row.data.pageId,p.user,true);
    }
    return { row, p };
  }
  async download(id: string, bearer: unknown) {
    const { row, p } = await this.validate(id, bearer);
    if (['upload','office-upload'].includes(row.purpose))
      throw new BadRequestException('This ticket only permits upload');
    let bytes: Buffer;
    if (row.purpose === 'office-download') {
      const file = await this.office.download(row.data.pageId,p.user,row.data.version);
      file.stream.destroy(); bytes = await this.storage.read(file.storagePath);
    } else if (row.purpose === 'office-result') {
      const file = await this.office.result(row.data.taskId,p.user);file.stream.destroy();bytes = await this.storage.read(file.storagePath);
    } else if (row.purpose === 'download') {
      const a = await this.attachment(row.data.attachmentId, p);
      bytes = await this.storage.read(a.filePath);
    } else bytes = await this.storage.read(row.data.storagePath);
    return { bytes, ...row.data };
  }
  async upload(id: string, bearer: unknown, file: any) {
    if(this.uploads>=4)throw new ServiceUnavailableException('Upload capacity reached; retry this same ticket later');
    this.uploads++;try{return await this.receiveUpload(id,bearer,file);}finally{this.uploads--;}
  }
  private async receiveUpload(id:string,bearer:unknown,file:any){
    const { row, p } = await this.validate(id, bearer);
    if (!['upload','office-upload'].includes(row.purpose)) throw new BadRequestException('This ticket cannot upload');
    if (!file || file.filename !== row.data.fileName)
      throw new BadRequestException('File must match the ticket');
    const bytes = await file.toBuffer();
    if (file.file?.truncated || bytes.length !== row.data.size)
      throw new BadRequestException('File size does not match');
    await this.validate(id,bearer,row.purpose);
    const claimed = await this.db
      .updateTable('knowledgeFileTickets')
      .set({ usedAt: new Date(), receipt: json({ state: 'running' }) })
      .where('id', '=', id)
      .where('usedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) {
      const old = await this.db
        .selectFrom('knowledgeFileTickets')
        .select('receipt')
        .where('id', '=', id)
        .executeTakeFirst();
      return { replayed: true, ...old.receipt };
    }
    try {
      if (row.purpose === 'office-upload') {
        const page = await this.office.upload(row.data,{...file,toBuffer:async()=>bytes},p.user);
        const info = await this.office.info(page.id,p.user);
        const receipt = {state:'succeeded',pageId:page.id,version:info.file.version,fileName:info.file.fileName,size:info.file.size};
        await this.db.updateTable('knowledgeFileTickets').set({receipt:json(receipt)}).where('id','=',id).execute();
        return receipt;
      }
      const page = await this.docs.page(row.data.pageId, p, true);
      const { Readable } = await import('node:stream');
      const attachment = await this.uploader.uploadFile({
        filePromise: Promise.resolve({ ...file, file: Readable.from(bytes) }),
        pageId: page.id,
        userId: p.user.id,
        spaceId: page.spaceId,
        workspaceId: p.workspace.id,
      });
      if (!attachment)
        throw new ServiceUnavailableException(
          'Upload result could not be confirmed',
        );
      const receipt = {
        state: 'succeeded',
        attachmentId: attachment.id,
        pageId: page.id,
        fileName: attachment.fileName,
        size: attachment.fileSize,
        url:
          '/api/files/' +
          attachment.id +
          '/' +
          encodeURIComponent(attachment.fileName),
      };
      await this.db
        .updateTable('knowledgeFileTickets')
        .set({ receipt: json(receipt) })
        .where('id', '=', id)
        .execute();
      return receipt;
    } catch (error) {
      await this.db
        .updateTable('knowledgeFileTickets')
        .set({ receipt: json({ state: 'unknown' }) })
        .where('id', '=', id)
        .execute();
      throw new ServiceUnavailableException(
        'Upload result unknown; do not create a new ticket to retry blindly',
      );
    }
  }
  @Interval('knowledge-ticket-cleanup', 60000)
  async cleanup() {
    try {
      const rows = await this.db
        .selectFrom('knowledgeFileTickets')
        .selectAll()
        .where('expiresAt', '<', new Date(Date.now() - 60000))
        .where(eb=>eb.or([eb('purpose','!=','upload'),eb('usedAt','is',null),eb('usedAt','<',new Date(Date.now()-7*86400000))]))
        .limit(100)
        .execute();
      for (const row of rows) {
        if (row.data.storagePath)
          await this.storage.delete(row.data.storagePath);
        await this.db
          .deleteFrom('knowledgeFileTickets')
          .where('id', '=', row.id)
          .execute();
      }
    } catch {
      /* A later sweep retries storage cleanup, without exposing document content in logs. */
    }
  }
}
