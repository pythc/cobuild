import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { randomBytes, createHmac } from 'node:crypto';
import {
  KnowledgeOAuthService,
  KnowledgePrincipal,
} from './knowledge-oauth.service';
import { nativeRoutePolicy } from './knowledge-catalog';
import { stableJson } from './knowledge-blocks';
import { same } from './knowledge-policy';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageAccessService } from '../page/page-access/page-access.service';

/** Internal controller reuse, never a second public authentication path. */
@Injectable()
export class KnowledgeNativeService {
  private key = randomBytes(32);
  constructor(
    private http: HttpAdapterHost,
    private oauth: KnowledgeOAuthService,
    @InjectKysely() private db: Kysely<any>,
    private pages: PageRepo,
    private history: PageHistoryRepo,
    private access: PageAccessService,
  ) {}
  private seal(method: string, path: string, token: string, body: any) {
    return createHmac('sha256', this.key)
      .update(
        method + '\n' + path + '\n' + token + '\n' + stableJson(body ?? null),
      )
      .digest('hex');
  }
  async authenticate(req: any) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,''),
      path = req.url.split('?')[0],
      signature = req.headers['x-110lab-internal'];
    if (
      typeof signature !== 'string' ||
      !same(signature, this.seal(req.method, path, token, req.body))
    )
      throw new ForbiddenException('Use the versioned knowledge API or MCP');
    const scope = nativeRoutePolicy(req.method, path, req.body);
    if (!scope) throw new ForbiddenException('Endpoint is not delegated');
    const p = await this.oauth.verify(token);
    this.oauth.require(p, scope);
    if (req.raw.workspaceId && req.raw.workspaceId !== p.workspace.id)
      throw new ForbiddenException('Workspace mismatch');
    await this.preflight(req.body || {}, p);
    return p;
  }
  async preflight(body: any, p: KnowledgePrincipal) {
    for (const k of ['pageId', 'parentPageId'])
      if (body[k]) {
        const page = await this.pages.findById(body[k]);
        if (!page || page.workspaceId !== p.workspace.id)
          throw new NotFoundException('Document not found');
        await this.access.validateCanView(page, p.user);
      }
    if (body.historyId) {
      const h = await this.history.findById(body.historyId);
      if (!h || h.workspaceId !== p.workspace.id)
        throw new NotFoundException('History not found');
      const page = await this.pages.findById(h.pageId);
      await this.access.validateCanView(page, p.user);
    }
    for (const [k, table] of [
      ['spaceId', 'spaces'],
      ['groupId', 'groups'],
      ['commentId', 'comments'],
      ['attachmentId', 'attachments'],
      ['userId', 'users'],
      ['labelId', 'labels'],
    ] as const) {
      if (!body[k]) continue;
      const row = await this.db
        .selectFrom(table)
        .selectAll()
        .where('id', '=', body[k])
        .where('workspaceId', '=', p.workspace.id)
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Resource not found');
      if (row.pageId) {
        const page = await this.pages.findById(row.pageId);
        await this.access.validateCanView(page, p.user);
      }
    }
    for (const [k, table] of [
      ['userIds', 'users'],
      ['groupIds', 'groups'],
      ['labelIds', 'labels'],
    ] as const)
      for (const id of body[k] || []) {
        if (
          !(await this.db
            .selectFrom(table)
            .select('id')
            .where('id', '=', id)
            .where('workspaceId', '=', p.workspace.id)
            .executeTakeFirst())
        )
          throw new NotFoundException('Member, group or label not found');
      }
  }
  async request(route: string, body: any, p: KnowledgePrincipal) {
    const path = '/api/' + route;
    await this.preflight(body, p);
    const response = await this.http.httpAdapter.getInstance().inject({
      method: 'POST',
      url: path,
      headers: {
        host: new URL(this.oauth.origin).host,
        authorization: 'Bearer ' + p.rawToken,
        'x-110lab-internal': this.seal('POST', path, p.rawToken, body),
      },
      payload: body,
    });
    let value: any;
    try {
      value = response.json();
    } catch {
      throw new HttpException('Native response could not be decoded', 503);
    }
    if (response.statusCode >= 400)
      throw new HttpException(value, response.statusCode);
    return value?.data ?? value;
  }
}
