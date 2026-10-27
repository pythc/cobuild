import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Interval } from '@nestjs/schedule';
import { createHash, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import * as mime from 'mime-types';
import { load } from 'cheerio';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { StorageService } from '../../integrations/storage/storage.service';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { generateSlugId, isUserDisabled } from '../../common/helpers';
import { jsonToHtml } from '../../collaboration/collaboration.util';
import { CreateFileDto, DirectoryDto } from './office.dto';
import {
  engineUrl,
  extension,
  fileName,
  modernExtension,
  OFFICE_LIMIT,
  OFFICE_TYPES,
  officeType,
} from './office-policy';
import { blankOffice } from './office-templates';
import {
  assertDirectoryAccess,
  directoryEnabled,
} from '../feishu/feishu-directory-policy';
const json = (v: any) => sql`${JSON.stringify(v)}::text::jsonb`;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

@Injectable()
export class OfficeService {
  private working = false;
  private uploads = 0;
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private pages: PageRepo,
    private access: PageAccessService,
    private spaces: SpaceRepo,
    private ability: SpaceAbilityFactory,
    private storage: StorageService,
    private users: UserRepo,
  ) {}
  get enabled() {
    return (
      !!this.config.get('OFFICE_PUBLIC_URL') &&
      !!this.config.get('OFFICE_JWT_SECRET')
    );
  }
  private requireEngine() {
    if (!this.enabled)
      throw new ServiceUnavailableException('在线编辑服务尚未连接');
  }
  private get publicUrl() {
    return String(this.config.get('OFFICE_PUBLIC_URL')).replace(/\/$/, '');
  }
  private get internalUrl() {
    return String(
      this.config.get('OFFICE_INTERNAL_URL') || this.publicUrl,
    ).replace(/\/$/, '');
  }
  private get callbackBase() {
    return (
      String(
        this.config.get('OFFICE_CALLBACK_BASE_URL') ||
          this.config.get('APP_URL'),
      ).replace(/\/$/, '') + '/api'
    );
  }
  private get secret() {
    return this.config.getOrThrow<string>('OFFICE_JWT_SECRET');
  }
  private ticket(data: any, seconds = 3600) {
    return jwt.sign(data, this.config.getOrThrow('APP_SECRET'), {
      algorithm: 'HS256',
      expiresIn: seconds,
    });
  }
  private verifyTicket(token: string) {
    try {
      return jwt.verify(token, this.config.getOrThrow('APP_SECRET'), {
        algorithms: ['HS256'],
      }) as any;
    } catch {
      throw new UnauthorizedException('文件访问凭据已失效');
    }
  }
  async page(id: string, user: any, edit = false): Promise<any> {
    const page = await this.pages.findById(id, {
      includeContent: true,
      includeSpace: true,
    });
    if (
      !user ||
      !page ||
      page.deletedAt ||
      page.workspaceId !== user.workspaceId ||
      isUserDisabled(user)
    )
      throw new NotFoundException('文件不存在');
    if (edit) {
      if (page.isLocked) throw new ForbiddenException('此内容已锁定');
      await this.access.validateCanEdit(page, user);
    } else await this.access.validateCanView(page, user);
    return page;
  }
  private async member(id: string, pageId: string) {
    const page = await this.pages.findById(pageId);
    if (!page) throw new NotFoundException();
    const user = await this.users.findById(id, page.workspaceId);
    if (!user || isUserDisabled(user)) throw new UnauthorizedException();
    await this.assertMemberIdentity(user);
    return user;
  }
  private async assertMemberIdentity(user: any, db: Kysely<any> = this.db) {
    // Service tickets outlive browser sessions; apply the same directory policy.
    if (!directoryEnabled(this.config) && !this.config.get('FEISHU_APP_ID'))
      return;
    const identity = await db
      .selectFrom('feishuIdentities')
      .select(['directoryStatus', 'directoryCheckedAt'])
      .where('userId', '=', user.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('appId', '=', this.config.get('FEISHU_APP_ID', ''))
      .where('tenantKey', '=', this.config.get('FEISHU_TENANT_KEY', ''))
      .executeTakeFirst();
    if (directoryEnabled(this.config)) assertDirectoryAccess(identity);
    else if (
      !identity ||
      (identity.directoryStatus &&
        !['unknown', 'active'].includes(identity.directoryStatus))
    )
      throw new UnauthorizedException('飞书成员不可用');
  }
  private async writableLocation(spaceId: string, user: any, trx: Kysely<any>) {
    const space = await trx
      .selectFrom('spaces')
      .select(['workspaceId', 'isPersonal', 'creatorId', 'deletedAt'])
      .where('id', '=', spaceId)
      .forShare()
      .executeTakeFirst();
    if (
      !space ||
      space.deletedAt ||
      space.workspaceId !== user.workspaceId ||
      (space.isPersonal && space.creatorId !== user.id)
    )
      throw new ForbiddenException('当前空间不可写入');
    await this.assertMemberIdentity(user, trx);
  }
  async directory(a: DirectoryDto, user: any, edit = false) {
    const space = await this.spaces.findById(a.spaceId, user.workspaceId);
    if (!space) throw new NotFoundException('空间不存在');
    const ability = await this.ability.createForUser(user, a.spaceId);
    if (
      ability.cannot(
        edit ? SpaceCaslAction.Edit : SpaceCaslAction.Read,
        SpaceCaslSubject.Page,
      )
    )
      throw new ForbiddenException();
    if (a.parentPageId) {
      const parent = await this.page(a.parentPageId, user, edit);
      if (
        parent.spaceId !== a.spaceId ||
        ['file', 'office'].includes(parent.nodeType)
      )
        throw new BadRequestException('请选择文档或文件夹作为目标目录');
    }
    return space;
  }
  async list(a: DirectoryDto & { cursor?: string }, user: any) {
    await this.directory(a, user);
    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'nodeType',
        'fileExtension',
        'spaceId',
        'parentPageId',
        'position',
        'updatedAt',
        'isLocked',
      ])
      .where('spaceId', '=', a.spaceId)
      .where('deletedAt', 'is', null)
      .where(
        'parentPageId',
        a.parentPageId ? '=' : 'is',
        a.parentPageId || null,
      );
    // UUID cursor ordering avoids dropping same-position entries. UI follows all pages.
    if (a.cursor) query = query.where('id', '>', a.cursor);
    const rows = await query.orderBy('id').limit(100).execute();
    const items = [];
    for (const row of rows) {
      try {
        items.push({
          ...row,
          permissions: await this.access.validateCanViewWithPermissions(
            row as any,
            user,
          ),
        });
      } catch (e) {
        if (!(e instanceof ForbiddenException)) throw e;
      }
    }
    return {
      items,
      nextCursor: rows.length === 100 ? rows[99].id : null,
      officeEnabled: this.enabled,
    };
  }
  async latest(pageId: string, trx: Kysely<any> = this.db): Promise<any> {
    return trx
      .selectFrom('officeFileVersions')
      .selectAll()
      .where('pageId', '=', pageId)
      .orderBy('version', 'desc')
      .executeTakeFirst();
  }
  async info(id: string, user: any) {
    const page = await this.page(id, user);
    const versions = await this.db
      .selectFrom('officeFileVersions')
      .select([
        'id',
        'version',
        'fileName',
        'mimeType',
        'size',
        'sha256',
        'createdAt',
      ])
      .where('pageId', '=', page.id)
      .orderBy('version', 'desc')
      .limit(100)
      .execute();
    return {
      page,
      file: versions[0] || null,
      versions,
      officeEnabled: this.enabled,
      editorLegalUrl: this.enabled ? this.publicUrl + '/web-apps/110lab-editor/' : null,
      canEdit:
        !page.isLocked &&
        (await this.access.validateCanViewWithPermissions(page, user)).canEdit,
    };
  }
  private async insertNode(
    a: DirectoryDto,
    title: string,
    nodeType: string,
    ext: string | null,
    user: any,
    bytes?: Buffer,
    fixedId?: string,
  ) {
    await this.directory(a, user, true);
    const pageId = fixedId || randomUUID(),
      versionId = randomUUID();
    const storagePath = `${user.workspaceId}/office/${pageId}/${versionId}`;
    if (bytes) await this.storage.upload(storagePath, bytes);
    try {
      return await this.db.transaction().execute(async (t) => {
        await this.pages.lockPageHierarchySpaces([a.spaceId], t as any);
        await this.writableLocation(a.spaceId, user, t);
        if (a.parentPageId) {
          const parent = await t
            .selectFrom('pages')
            .select(['spaceId', 'deletedAt', 'isLocked', 'nodeType'])
            .where('id', '=', a.parentPageId)
            .executeTakeFirst();
          if (
            !parent ||
            parent.spaceId !== a.spaceId ||
            parent.deletedAt ||
            parent.isLocked ||
            ['file', 'office'].includes(parent.nodeType)
          )
            throw new ConflictException('目标目录已改变');
        }
        const last = await t
          .selectFrom('pages')
          .select('position')
          .where('spaceId', '=', a.spaceId)
          .where(
            'parentPageId',
            a.parentPageId ? '=' : 'is',
            a.parentPageId || null,
          )
          .where('deletedAt', 'is', null)
          .orderBy(sql`position collate "C"`, 'desc')
          .executeTakeFirst();
        const page = await this.pages.insertPage(
          {
            id: pageId,
            slugId: generateSlugId(),
            title,
            nodeType,
            fileExtension: ext,
            workspaceId: user.workspaceId,
            spaceId: a.spaceId,
            parentPageId: a.parentPageId || null,
            creatorId: user.id,
            lastUpdatedById: user.id,
            position: generateJitteredKeyBetween(last?.position || null, null),
          },
          t as any,
        );
        if (bytes)
          await t
            .insertInto('officeFileVersions')
            .values({
              id: versionId,
              pageId,
              version: 1,
              storagePath,
              fileName: title,
              mimeType: mime.lookup(title) || 'application/octet-stream',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              createdById: user.id,
            })
            .execute();
        return page;
      });
    } catch (e) {
      if (bytes) await this.storage.delete(storagePath).catch(() => {});
      throw e;
    }
  }
  async create(a: CreateFileDto, user: any) {
    if (a.type === 'folder')
      return this.insertNode(a, fileName(a.title), 'folder', null, user);
    if (a.type === 'md') {
      const title = fileName(a.title).replace(/\.md$/i, '') + '.md';
      return this.insertNode(a, title, 'file', 'md', user, Buffer.from(''));
    }
    if (!OFFICE_TYPES.includes(a.type as any))
      throw new BadRequestException('不支持此类型');
    if (a.mode !== 'file') this.requireEngine();
    const title =
      fileName(a.title).replace(/\.(docx|xlsx|pptx)$/i, '') + '.' + a.type;
    return this.insertNode(
      a,
      title,
      a.mode === 'file' ? 'file' : 'office',
      a.type,
      user,
      await blankOffice(a.type),
    );
  }
  async upload(
    a: DirectoryDto & { pageId?: string; expectedVersion?: number },
    file: any,
    user: any,
  ) {
    if (this.uploads >= 3)
      throw new ServiceUnavailableException('上传繁忙，请稍后重试');
    this.uploads++;
    try {
      if (a.pageId) await this.page(a.pageId, user, true);
      else await this.directory(a, user, true);
      const name = fileName(file.filename),
        ext = extension(name);
      const bytes = await file.toBuffer();
      if (
        file.file.truncated ||
        bytes.length > OFFICE_LIMIT ||
        (!bytes.length && !['md', 'markdown', 'mdown'].includes(ext))
      )
        throw new BadRequestException('文件为空或超过 50 MB');
      if (a.pageId) {
        const page = await this.page(a.pageId, user, true);
        if (
          !['file', 'office'].includes(page.nodeType) ||
          ext !== page.fileExtension
        )
          throw new BadRequestException('替换文件必须保持相同格式');
        if (!a.expectedVersion)
          throw new BadRequestException('替换文件需要确认当前版本');
        const saved = await this.saveVersion(
          page,
          user,
          bytes,
          name,
          a.expectedVersion,
        );
        return { ...page, fileVersion: saved.version };
      }
      return this.insertNode(a, name, 'file', ext, user, bytes);
    } finally {
      this.uploads--;
    }
  }
  private async saveVersion(
    page: any,
    user: any,
    bytes: Buffer,
    name: string,
    expected: number,
    sessionId?: string,
    close = false,
  ) {
    const id = randomUUID(),
      storagePath = `${page.workspaceId}/office/${page.id}/${id}`,
      sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.storage.upload(storagePath, bytes);
    let stored = false;
    try {
      return await this.db.transaction().execute(async (t) => {
        // Match handoff/move lock ordering before locking a page for writes.
        await this.pages.lockPageHierarchySpaces([page.spaceId], t as any);
        await sql`select pg_advisory_xact_lock(hashtext('office-file'),hashtext(${page.id}))`.execute(
          t,
        );
        const currentPage = await t
          .selectFrom('pages')
          .selectAll()
          .where('id', '=', page.id)
          .forUpdate()
          .executeTakeFirst();
        if (!currentPage || currentPage.deletedAt || currentPage.isLocked)
          throw new ConflictException('文件已删除或锁定');
        if (
          currentPage.spaceId !== page.spaceId ||
          currentPage.workspaceId !== user.workspaceId
        )
          throw new ForbiddenException('文件位置已改变，请重新打开');
        await this.writableLocation(currentPage.spaceId, user, t);
        const current = await this.latest(page.id, t);
        const session = sessionId
          ? await t
              .selectFrom('officeSessions')
              .selectAll()
              .where('id', '=', sessionId)
              .executeTakeFirst()
          : null;
        if (sessionId && (!session || session.closedAt)) return current;
        const base = session ? session.version : expected;
        if (current.version !== base)
          throw new ConflictException('文件已更新，请刷新后重试');
        if (current.sha256 === sha256) {
          if (sessionId && close)
            await t
              .updateTable('officeSessions')
              .set({ closedAt: new Date() })
              .where('id', '=', sessionId)
              .execute();
          return current;
        }
        const result = await t
          .insertInto('officeFileVersions')
          .values({
            id,
            pageId: page.id,
            version: current.version + 1,
            storagePath,
            fileName: name,
            mimeType: mime.lookup(name) || 'application/octet-stream',
            size: bytes.length,
            sha256,
            createdById: user.id,
          })
          .returningAll()
          .executeTakeFirst();
        if (sessionId)
          await t
            .updateTable('officeSessions')
            .set({
              version: result.version,
              ...(close ? { closedAt: new Date() } : {}),
            })
            .where('id', '=', sessionId)
            .execute();
        await this.pages.updatePage(
          { lastUpdatedById: user.id },
          page.id,
          t as any,
        );
        stored = true;
        return result;
      });
    } catch (e) {
      stored = false;
      throw e;
    } finally {
      if (!stored) await this.storage.delete(storagePath).catch(() => {});
    }
  }
  async download(id: string, user: any, version?: number): Promise<any> {
    const page = await this.page(id, user);
    if (!version) await this.saveBeforeExport(page);
    let q = this.db
      .selectFrom('officeFileVersions')
      .selectAll()
      .where('pageId', '=', page.id);
    if (version) q = q.where('version', '=', version);
    const file = await q.orderBy('version', 'desc').executeTakeFirst();
    if (!file) throw new NotFoundException('文件版本不存在');
    await this.page(id, await this.member(user.id, id));
    return { ...file, stream: await this.storage.readStream(file.storagePath) };
  }
  async cloneVersion(
    sourceId: string,
    targetId: string,
    user: any,
    trx: Kysely<any>,
  ) {
    const source = await this.latest(sourceId, trx);
    if (!source) throw new NotFoundException('源文件没有可复制的版本');
    const id = randomUUID(),
      storagePath = `${user.workspaceId}/office/${targetId}/${id}`;
    await this.storage.copy(source.storagePath, storagePath);
    try {
      await trx
        .insertInto('officeFileVersions')
        .values({
          ...source,
          id,
          pageId: targetId,
          version: 1,
          storagePath,
          createdById: user.id,
          createdAt: new Date(),
        })
        .execute();
      return storagePath;
    } catch (e) {
      await this.storage.delete(storagePath).catch(() => {});
      throw e;
    }
  }
  async restore(id: string, version: number, expected: number, user: any) {
    const page = await this.page(id, user, true),
      file = await this.download(id, user, version);
    file.stream?.destroy?.();
    return this.saveVersion(
      page,
      user,
      await this.storage.read(file.storagePath),
      file.fileName,
      expected,
    );
  }
  private inputUrl(
    pageId: string,
    version: number,
    userId: string,
    taskId?: string,
  ) {
    return (
      this.callbackBase +
      '/office/source?token=' +
      this.ticket({ purpose: 'source', pageId, version, userId, taskId })
    );
  }
  async source(token: string) {
    const a = this.verifyTicket(token);
    if (a.purpose !== 'source') throw new UnauthorizedException();
    const user = await this.member(a.userId, a.pageId);
    if (!user || isUserDisabled(user)) throw new UnauthorizedException();
    const page = await this.page(a.pageId, user);
    if (a.taskId) {
      const task = await this.db
        .selectFrom('officeTasks')
        .selectAll()
        .where('id', '=', a.taskId)
        .where('pageId', '=', page.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      if (!task?.result?.sourcePath) throw new NotFoundException();
      return {
        stream: await this.storage.readStream(task.result.sourcePath),
        fileName: 'document.' + (task.result.sourceExt || 'html'),
        mimeType:
          task.result.sourceExt === 'mht' ? 'multipart/related' : 'text/html',
      };
    }
    return this.download(page.id, user, a.version);
  }
  async editor(id: string, user: any) {
    this.requireEngine();
    const { page, file, canEdit } = await this.info(id, user);
    const documentType =
      page.fileExtension === 'pdf' ? 'pdf' : officeType(page.fileExtension);
    if (!file || !documentType)
      throw new BadRequestException('此文件不支持在线预览');
    const editable =
      documentType !== 'pdf' && page.nodeType === 'office' && canEdit;
    const session: any = await this.db.transaction().execute(async (t) => {
      await this.pages.lockPageHierarchySpaces([page.spaceId], t as any);
      const currentPage = await t
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', page.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !currentPage ||
        currentPage.deletedAt ||
        currentPage.spaceId !== page.spaceId ||
        currentPage.workspaceId !== user.workspaceId
      )
        throw new ForbiddenException('文件位置已改变，请重新打开');
      await this.writableLocation(currentPage.spaceId, user, t);
      if (editable && currentPage.isLocked)
        throw new ForbiddenException('此内容已锁定');
      await sql`select pg_advisory_xact_lock(hashtext('office-file'),hashtext(${page.id}))`.execute(
        t,
      );
      const current = await this.latest(page.id, t);
      let row = await t
        .selectFrom('officeSessions')
        .selectAll()
        .where('pageId', '=', page.id)
        .where('version', '=', current.version)
        .where('closedAt', 'is', null)
        .where('expiresAt', '>', new Date())
        .orderBy('expiresAt', 'desc')
        .executeTakeFirst();
      const permission = { edit: editable };
      if (!row)
        row = await t
          .insertInto('officeSessions')
          .values({
            id: randomUUID(),
            pageId: page.id,
            version: current.version,
            users: json({ [user.id]: permission }),
            expiresAt: new Date(Date.now() + 86400000),
          })
          .returningAll()
          .executeTakeFirst();
      else {
        row.users = { ...row.users, [user.id]: permission };
        await t
          .updateTable('officeSessions')
          .set({ users: json(row.users) })
          .where('id', '=', row.id)
          .execute();
      }
      return { ...row, sourceVersion: current.version };
    });
    const config: any = {
      documentType,
      document: {
        fileType: page.fileExtension,
        key: session.id,
        title: page.title,
        url: this.inputUrl(page.id, session.sourceVersion, user.id),
        permissions: {
          edit: editable,
          download: true,
          print: true,
          fillForms: false,
          chat: false,
          protect: false,
        },
      },
      editorConfig: {
        mode: editable ? 'edit' : 'view',
        lang: 'zh-CN',
        user: { id: user.id, name: user.name },
        callbackUrl: this.callbackBase + '/office/callback/' + session.id,
        customization: {
          autosave: true,
          forcesave: true,
          help: false,
          feedback: false,
          plugins: false,
          macros: false,
          suggestFeature: false,
          features: { featuresTips: false },
        },
      },
      width: '100%',
      height: '100%',
    };
    config.token = jwt.sign(config, this.secret, { algorithm: 'HS256' });
    return {
      // The bootstrap URL is immutable-cached too. Refresh it when the font set changes;
      // Office's standard font generator changes the nested SDK resource cache tag.
      scriptUrl:
        this.publicUrl +
        '/web-apps/apps/api/documents/api.js?v=110lab-clean-20261015',
      config,
      editable,
    };
  }
  async callback(id: string, body: any, authorization?: string) {
    let data: any;
    try {
      data = jwt.verify(
        body.token || authorization?.replace(/^Bearer\s+/i, ''),
        this.secret,
        { algorithms: ['HS256'] },
      );
      data = data.payload || data;
    } catch {
      throw new UnauthorizedException('无效的编辑服务签名');
    }
    if (data.key !== id) throw new BadRequestException('编辑会话不匹配');
    const session = await this.db
      .selectFrom('officeSessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!session || new Date(session.expiresAt).getTime() < Date.now())
      throw new NotFoundException('编辑会话已失效');
    if (session.closedAt) return { error: 0 };
    if (![2, 6].includes(data.status)) {
      if (data.status === 4)
        await this.db
          .updateTable('officeSessions')
          .set({ closedAt: new Date() })
          .where('id', '=', id)
          .execute();
      return { error: 0 };
    }
    const ids: string[] = data.users || [];
    const userId = ids.find((u) => session.users[u]?.edit === true);
    if (!userId) throw new ForbiddenException('此会话无写入权限');
    const user = await this.member(userId, session.pageId),
      page = await this.page(session.pageId, user, true);
    if (page.nodeType !== 'office') throw new ForbiddenException();
    const bytes = await this.fetchBytes(data.url);
    if (!bytes.length) throw new BadRequestException('编辑器返回了空文件');
    const current = await this.latest(page.id);
    await this.saveVersion(
      page,
      user,
      bytes,
      current.fileName,
      session.version,
      id,
      data.status === 2,
    );
    if (
      typeof data.userdata === 'string' &&
      /^export-[a-f0-9-]{36}$/.test(data.userdata)
    ) {
      await this.db
        .updateTable('officeSessions')
        .set({
          saveAcks: sql`jsonb_set(save_acks, array[${data.userdata}], to_jsonb(now()::text))`,
        })
        .where('id', '=', id)
        .execute();
    }
    return { error: 0 };
  }
  private async saveBeforeExport(page: any) {
    if (page.nodeType !== 'office') return;
    const session = await this.db
      .selectFrom('officeSessions')
      .selectAll()
      .where('pageId', '=', page.id)
      .where('closedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .orderBy('expiresAt', 'desc')
      .executeTakeFirst();
    if (!session) return;
    const nonce = 'export-' + randomUUID(),
      args: any = { c: 'forcesave', key: session.id, userdata: nonce };
    args.token = jwt.sign(args, this.secret, { algorithm: 'HS256' });
    const response = await fetch(this.internalUrl + '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException('暂时无法保存最新版本，请稍后导出');
    const result: any = await response.json();
    if ([1, 4].includes(result.error)) return; // No active editing session / no unsaved changes.
    if (result.error)
      throw new ServiceUnavailableException('最新版本保存失败，请稍后导出');
    for (let n = 0; n < 60; n++) {
      const row = await this.db
        .selectFrom('officeSessions')
        .select('saveAcks')
        .where('id', '=', session.id)
        .executeTakeFirst();
      if (row?.saveAcks?.[nonce]) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ServiceUnavailableException('仍在保存最新内容，请稍后导出');
  }
  private async fetchBytes(url: string) {
    const response = await fetch(
      engineUrl(url, [this.internalUrl, this.publicUrl]),
      { redirect: 'error', signal: AbortSignal.timeout(60000) },
    );
    if (!response.ok || !response.body)
      throw new ServiceUnavailableException('文件转换服务暂时不可用');
    if (Number(response.headers.get('content-length')) > OFFICE_LIMIT)
      throw new BadRequestException('转换后的文件超过 50 MB');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > OFFICE_LIMIT) {
        await response.body.cancel().catch(() => {});
        throw new BadRequestException('转换后的文件超过 50 MB');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  private async embedImages(html: string, user: any) {
    const dom = load(html);
    let embeddedSize = 0;
    for (const image of dom('img').toArray()) {
      const src = dom(image).attr('src') || '';
      const id = src.match(/\/api\/files\/([a-f0-9-]{36})\//i)?.[1];
      if (!id)
        throw new BadRequestException('请先将外链图片上传到文档，再导出 PDF');
      const file = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', id)
        .where('workspaceId', '=', user.workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (
        !file ||
        !file.pageId ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
          file.mimeType,
        )
      )
        throw new BadRequestException('文档包含无法导出的图片');
      await this.page(file.pageId, user);
      embeddedSize += Number(file.fileSize);
      if (embeddedSize > 20 * 1024 * 1024)
        throw new BadRequestException('文档中的图片总量超过 20 MB，请分开导出');
      dom(image).attr(
        'src',
        'data:' +
          file.mimeType +
          ';base64,' +
          (await this.storage.read(file.filePath)).toString('base64'),
      );
    }
    // Exported HTML must not ask the conversion worker to fetch embedded remote resources.
    dom('iframe,video,audio,script,link').remove();
    return dom.html();
  }
  async convert(id: string, format: string, purpose: string, user: any) {
    this.requireEngine();
    if (
      !['pdf', 'docx', 'xlsx', 'pptx'].includes(format) ||
      !['export', 'online-copy'].includes(purpose)
    )
      throw new BadRequestException('不支持此导出格式');
    const page = await this.page(id, user, purpose === 'online-copy');
    await this.saveBeforeExport(page);
    const current = await this.latest(page.id);
    if (page.nodeType === 'folder')
      throw new BadRequestException('请选择文件或文档');
    if (
      purpose === 'online-copy' &&
      (!current || format !== modernExtension(page.fileExtension))
    )
      throw new BadRequestException('此文件不能转换为在线副本');
    if (format !== 'pdf' && purpose !== 'online-copy')
      throw new BadRequestException('下载原件请使用文件下载入口');
    if (purpose === 'online-copy')
      await this.directory(
        { spaceId: page.spaceId, parentPageId: page.parentPageId },
        user,
        true,
      );
    const active = await this.db
      .selectFrom('officeTasks')
      .selectAll()
      .where('userId', '=', user.id)
      .where('state', 'in', ['queued', 'running'])
      .execute();
    if (active.length >= 10)
      throw new BadRequestException('请等待已有转换任务完成');
    const idTask = randomUUID();
    let result: any = {};
    if (!current) {
      const content = page.content || { type: 'doc', content: [] };
      let html =
        '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:"Noto Sans CJK SC",Arial,sans-serif;color:#242936;line-height:1.65}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}img{max-width:100%}pre{white-space:pre-wrap}h1{font-size:24pt}a{color:#1c5cbd}ol>li::marker,ul>li::marker{color:#1c5cbd}</style></head><body><h1>' +
        escape(page.title || '') +
        '</h1>' +
        jsonToHtml(content) +
        '</body></html>';
      html = await this.embedImages(html, user);
      const sourcePath = `${page.workspaceId}/office-tasks/${idTask}/source.html`;
      await this.storage.upload(sourcePath, Buffer.from(html));
      result = { sourcePath, sourceExt: 'html' };
    }
    try {
      return await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext('office-task-quota'),hashtext(${user.id}))`.execute(
          trx,
        );
        const pending = await trx
          .selectFrom('officeTasks')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('userId', '=', user.id)
          .where('state', 'in', ['queued', 'running'])
          .executeTakeFirst();
        if (pending.n >= 10)
          throw new BadRequestException('请等待已有转换任务完成');
        return trx
          .insertInto('officeTasks')
          .values({
            id: idTask,
            pageId: page.id,
            userId: user.id,
            sourceVersion: current?.version || 0,
            format,
            purpose,
            state: 'queued',
            result: json(result),
          })
          .returning(['id', 'state', 'createdAt'])
          .executeTakeFirst();
      });
    } catch (e) {
      if (result.sourcePath)
        await this.storage.delete(result.sourcePath).catch(() => {});
      throw e;
    }
  }
  async tasks(user: any) {
    const rows = await this.db
      .selectFrom('officeTasks')
      .selectAll()
      .where('userId', '=', user.id)
      .orderBy('createdAt', 'desc')
      .limit(30)
      .execute();
    const items = [];
    for (const row of rows) {
      try {
        const page = await this.page(row.pageId, user);
        const copy = row.result?.page;
        if (copy) await this.page(copy.id, user);
        items.push({
          id: row.id,
          title: page.title,
          state: row.state,
          error: row.error,
          createdAt: row.createdAt,
          format: row.format,
          purpose: row.purpose,
          resultPage: copy?.id,
          resultUrl: copy
            ? '/s/' + page.space.slug + '/p/' + copy.slugId
            : null,
          fileName: row.result?.fileName,
        });
      } catch (e) {
        if (
          !(e instanceof ForbiddenException) &&
          !(e instanceof NotFoundException)
        )
          throw e;
      }
    }
    return { items };
  }
  async task(id: string, user: any) {
    const task = await this.db
      .selectFrom('officeTasks')
      .selectAll()
      .where('id', '=', id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (!task) throw new NotFoundException('任务不存在');
    await this.page(task.pageId, user);
    return {
      id: task.id,
      pageId: task.pageId,
      state: task.state,
      format: task.format,
      purpose: task.purpose,
      createdAt: task.createdAt,
      error: task.error,
      result: task.result?.page || null,
    };
  }
  async result(id: string, user: any) {
    await this.task(id, user);
    const task = await this.db
      .selectFrom('officeTasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (task.state !== 'succeeded' || !task.result?.storagePath)
      throw new ConflictException('导出尚未完成');
    return {
      ...task.result,
      stream: await this.storage.readStream(task.result.storagePath),
    };
  }
  @Interval(60000)
  async cleanStorage() {
    const rows = await this.db
      .selectFrom('officeStorageGc')
      .selectAll()
      .limit(20)
      .execute();
    for (const row of rows) {
      try {
        await this.storage.delete(row.storagePath);
        await this.db
          .deleteFrom('officeStorageGc')
          .where('storagePath', '=', row.storagePath)
          .execute();
      } catch {
        /* Retain the row for a later retry. */
      }
    }
    await this.db
      .deleteFrom('officeTasks')
      .where('state', 'in', ['succeeded', 'failed'])
      .where('createdAt', '<', new Date(Date.now() - 14 * 86400000))
      .execute();
    await this.db
      .deleteFrom('officeSessions')
      .where('expiresAt', '<', new Date(Date.now() - 86400000))
      .execute();
  }
  @Interval(2000)
  async processTasks() {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      // A DB advisory lock protects against two API processes consuming the same job.
      await this.db.transaction().execute(async (t) => {
        const task = await t
          .selectFrom('officeTasks')
          .selectAll()
          .where('state', 'in', ['queued', 'running'])
          .orderBy('createdAt')
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!task) return;
        try {
          if (Date.now() - new Date(task.createdAt).getTime() > 600000)
            throw new Error('转换超时，请重试');
          const user = await this.member(task.userId, task.pageId),
            page = await this.page(
              task.pageId,
              user,
              task.purpose === 'online-copy',
            );
          const source = task.sourceVersion
            ? await t
                .selectFrom('officeFileVersions')
                .selectAll()
                .where('pageId', '=', page.id)
                .where('version', '=', task.sourceVersion)
                .executeTakeFirst()
            : null;
          const args: any = {
            async: true,
            filetype: source
              ? extension(source.fileName)
              : task.result?.sourceExt || 'html',
            outputtype: task.format,
            key: task.id,
            url: this.inputUrl(
              page.id,
              task.sourceVersion,
              user.id,
              source ? undefined : task.id,
            ),
          };
          args.token = jwt.sign(args, this.secret, { algorithm: 'HS256' });
          const res = await fetch(this.internalUrl + '/converter', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(20000),
          });
          if (!res.ok) throw new Error('转换服务暂时不可用');
          const response: any = await res.json();
          if (response.error)
            throw new Error('转换失败，错误码 ' + response.error);
          if (!response.endConvert) {
            await t
              .updateTable('officeTasks')
              .set({ state: 'running', updatedAt: new Date() })
              .where('id', '=', task.id)
              .execute();
            return;
          }
          const bytes = await this.fetchBytes(response.fileUrl);
          let result = { ...task.result };
          if (task.purpose === 'online-copy') {
            const existing = await this.pages.findById(task.id);
            const title =
              fileName(page.title).replace(/\.[^.]+$/, '') +
              '（在线）.' +
              task.format;
            result.page =
              existing ||
              (await this.insertNode(
                { spaceId: page.spaceId, parentPageId: page.parentPageId },
                title,
                'office',
                task.format,
                user,
                bytes,
                task.id,
              ));
          } else {
            const storagePath = `${page.workspaceId}/office-tasks/${task.id}/result`;
            await this.storage.upload(storagePath, bytes);
            result = {
              ...result,
              storagePath,
              fileName: page.title.replace(/\.[^.]+$/, '') + '.' + task.format,
              mimeType: mime.lookup(task.format) || 'application/pdf',
              size: bytes.length,
            };
          }
          await t
            .updateTable('officeTasks')
            .set({
              state: 'succeeded',
              result: json(result),
              updatedAt: new Date(),
            })
            .where('id', '=', task.id)
            .execute();
        } catch (e) {
          await t
            .updateTable('officeTasks')
            .set({
              state: 'failed',
              error: e instanceof Error ? e.message.slice(0, 250) : '转换失败',
              updatedAt: new Date(),
            })
            .where('id', '=', task.id)
            .execute();
        }
      });
    } finally {
      this.working = false;
    }
  }
}
