import { TemplateImagesService } from './template-images.service';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { PageService } from '../page/services/page.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  htmlToJson,
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';
import { markdownToHtml } from '@docmost/editor-ext';
import { BUILTIN_TEMPLATES } from './builtins';
import {
  SaveTemplateDto,
  ApplyTemplateDto,
  DeleteTemplateDto,
} from './template.dto';
import { ForbiddenException } from '@nestjs/common';
/** Built-ins are immutable; saved templates are private to their author. */
@Injectable()
export class DocumentTemplateService {
  constructor(
    @InjectKysely() private db: KyselyDB,
    private pages: PageService,
    private repo: PageRepo,
    private access: PageAccessService,
    private abilities: SpaceAbilityFactory,
    private images: TemplateImagesService,
  ) {}
  async list(user: User) {
    const rows = await this.db
      .selectFrom('templates')
      .select(['id', 'title', 'description', 'createdAt', 'updatedAt'])
      .where('workspaceId', '=', user.workspaceId)
      .where('creatorId', '=', user.id)
      .where('spaceId', 'is', null)
      .orderBy('updatedAt', 'desc')
      .limit(500)
      .execute();
    return {
      items: [
        ...BUILTIN_TEMPLATES.map(({ html, children, ...x }) => ({
          ...x,
          builtin: true,
          canEdit: false,
          childCount: children?.length || 0,
        })),
        ...rows.map((x) => ({
          ...x,
          category: '我的模板',
          builtin: false,
          canEdit: true,
        })),
      ],
    };
  }
  async get(id: string, user: User) {
    const builtin = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (builtin)
      return {
        ...builtin,
        builtin: true,
        canEdit: false,
        html: jsonToHtml(htmlToJson(builtin.html)),
        markdown: jsonToMarkdown(htmlToJson(builtin.html)),
      };
    const row = await this.db
      .selectFrom('templates')
      .selectAll()
      .where('id', '=', this.uuid(id))
      .where('workspaceId', '=', user.workspaceId)
      .where('creatorId', '=', user.id)
      .where('spaceId', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('模板不存在');
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      updatedAt: row.updatedAt,
      category: '我的模板',
      builtin: false,
      canEdit: true,
      html: jsonToHtml(row.content as any),
      markdown: jsonToMarkdown(row.content as any),
    };
  }
  uuid(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new NotFoundException('模板不存在');
    return id;
  }
  async save(a: SaveTemplateDto, user: User) {
    const title = a.title.trim();
    if (!title) throw new BadRequestException('请填写模板名称');
    const content = htmlToJson(
      a.format === 'html' ? a.content : await markdownToHtml(a.content),
    );
    // Templates hold ordinary document content, never privileged embeds or member identities.
    const clean = (n: any): any => {
      if (
        [
          'mention',
          'base',
          'baseEmbed',
          'attachment',
          'fileAttachment',
          'transclusion',
          'iframe',
          'embed',
        ].includes(n.type)
      )
        return { type: 'paragraph', content: [] };
      return { ...n, ...(n.content ? { content: n.content.map(clean) } : {}) };
    };
    const value = {
      title,
      description: a.description?.trim() || '',
      content: clean(content),
      lastUpdatedById: user.id,
      updatedAt: new Date(),
    };
    if (a.id) {
      this.uuid(a.id);
      if (!a.expectedUpdatedAt)
        throw new BadRequestException('需要当前模板版本');
      const row = await this.db
        .updateTable('templates')
        .set(value)
        .where('id', '=', a.id)
        .where('workspaceId', '=', user.workspaceId)
        .where('creatorId', '=', user.id)
        .where('spaceId', 'is', null)
        .where('updatedAt', '=', new Date(a.expectedUpdatedAt))
        .returning('id')
        .executeTakeFirst();
      if (!row) {
        await this.get(a.id, user);
        throw new ConflictException('模板已被修改，请刷新后重试');
      }
      return this.get(row.id, user);
    }
    const row = await this.db
      .insertInto('templates')
      .values({ ...value, workspaceId: user.workspaceId, creatorId: user.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.get(row.id, user);
  }
  async remove(a: DeleteTemplateDto, user: User) {
    this.uuid(a.id);
    const row = await this.db
      .deleteFrom('templates')
      .where('id', '=', a.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('creatorId', '=', user.id)
      .where('spaceId', 'is', null)
      .where('updatedAt', '=', new Date(a.expectedUpdatedAt))
      .returning('id')
      .executeTakeFirst();
    if (!row) {
      await this.get(a.id, user);
      throw new ConflictException('模板已被修改，请刷新后重试');
    }
    return { deleted: true };
  }
  async apply(a: ApplyTemplateDto, user: User) {
    const template = await this.get(a.id, user);
    const ability = await this.abilities.createForUser(user, a.spaceId);
    if (
      !a.parentPageId &&
      ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)
    )
      throw new ForbiddenException();
    if (a.parentPageId) {
      const parent = await this.repo.findById(a.parentPageId);
      if (
        !parent ||
        parent.spaceId !== a.spaceId ||
        parent.workspaceId !== user.workspaceId ||
        parent.deletedAt
      )
        throw new NotFoundException('目录不存在');
      await this.access.validateCanEdit(parent, user);
    }
    const staged: string[] = [];
    try {
      return await this.db.transaction().execute(async (trx) => {
        const prepared = await this.images.prepare(
          template.html,
          user,
          a.spaceId,
          staged,
        );
        const page = await this.pages.create(
          user.id,
          user.workspaceId,
          {
            spaceId: a.spaceId,
            parentPageId: a.parentPageId,
            title: a.title?.trim() || template.title,
            content: prepared.html,
            format: 'html',
          },
          trx,
        );
        await this.images.attach(prepared.files, page.id, trx);
        if ((template as any).kind === 'directory') {
          await trx
            .updateTable('pages')
            .set({ nodeType: 'folder', content: null, ydoc: null })
            .where('id', '=', page.id)
            .execute();
          page.nodeType = 'folder';
        }
        const children = (template as any).children || [];
        const add = async (rows: any[], parentPageId: string) => {
          for (const node of rows) {
            const preparedChild = await this.images.prepare(
              node.html || '<p></p>',
              user,
              a.spaceId,
              staged,
            );
            const child = await this.pages.create(
              user.id,
              user.workspaceId,
              {
                spaceId: a.spaceId,
                parentPageId,
                title: node.title,
                content: preparedChild.html,
                format: 'html',
              },
              trx,
            );
            await this.images.attach(preparedChild.files, child.id, trx);
            if (node.kind === 'directory')
              await trx
                .updateTable('pages')
                .set({ nodeType: 'folder', content: null, ydoc: null })
                .where('id', '=', child.id)
                .execute();
            if (node.children) await add(node.children, child.id);
          }
        };
        await add(children, page.id);
        return { ...page, hasChildren: children.length > 0 };
      });
    } catch (error) {
      await this.images.clean(staged);
      throw error;
    }
  }
}
