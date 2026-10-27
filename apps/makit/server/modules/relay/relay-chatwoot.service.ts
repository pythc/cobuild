import { z } from 'zod';
import { runRelayOperation } from './relay-chatwoot.operation';
import { sendRelayMessage } from './relay-chatwoot.send';
import { cleanRelayMessage } from './relay-chatwoot.message';
import { mapRelayTicket } from './relay-chatwoot.ticket';
import { downloadRelayAttachment } from './relay-chatwoot.attachment';
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createInput, updateInput } from './relay-chatwoot.input';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '../../../shared/api.interface';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import { RequirementsCommandService } from '../requirements/requirements-command.service';
import { requirementPlatformUrl } from '../requirements/requirement-links';
import { RelayIntakeService } from '../requirements/relay-intake.service';
import { RelayIntakeStore } from '../requirements/relay-intake.store';
import { ChatwootClient, ChatwootError } from './chatwoot-client';
import {
  RelayChatwootStore,
  type ConversationRow,
} from './relay-chatwoot.store';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
@Injectable()
export class RelayChatwootService {
  constructor(
    private readonly chat: ChatwootClient,
    private readonly store: RelayChatwootStore,
    private readonly intake: RelayIntakeService,
    private readonly intents: RelayIntakeStore,
    private readonly query: RequirementsQueryService,
    private readonly command: RequirementsCommandService,
  ) {}
  private principal(a: CurrentUserSummary) {
    return digest('makit-member:' + a.platformAppId + ':' + a.employeeId);
  }
  private origin() {
    const u = new URL(process.env.RELAY_PUBLIC_ORIGIN || '');
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !['https:', 'http:'].includes(u.protocol) ||
      (u.protocol === 'http:' &&
        !['localhost', '127.0.0.1'].includes(u.hostname))
    )
      throw new ServiceUnavailableException('Relay 地址尚未配置');
    return u.origin;
  }
  private publicUrl(path: string) {
    const base = process.env.RELAY_PUBLIC_BASE_URL || this.origin();
    const u = new URL(base);
    if (
      u.origin !== this.origin() ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new ServiceUnavailableException('Relay 地址配置不匹配');
    return base.replace(/\/+$/, '') + path;
  }
  private async isOperator(a: CurrentUserSummary, app?: string) {
    return this.chat.operator(a.employeeId, app);
  }
  private async operator(a: CurrentUserSummary, app?: string) {
    if (!(await this.isOperator(a, app)))
      throw new ForbiddenException('需要客服权限');
  }
  private async owned(id: string, a: CurrentUserSummary, operator: boolean) {
    const row = await this.store.conversation(id);
    if (!row || !this.chat.config().apps[row.app])
      throw new NotFoundException('咨询不存在');
    if (operator) await this.operator(a, row.app);
    else if (row.principal !== this.principal(a))
      throw new NotFoundException('咨询不存在');
    const remote = await this.chat.request(
      this.chat.account(`/conversations/${row.remote_id}`),
    );
    if (remote.inbox_id !== this.chat.config().apps[row.app].inboxId)
      throw new ConflictException('咨询所属应用已变化');
    return { row, remote };
  }
  private once<T>(
    a: CurrentUserSummary,
    op: string,
    key: string,
    payload: unknown,
    action: (marker: string) => Promise<T>,
    reconcile: (marker: string) => Promise<T | null>,
  ) {
    return runRelayOperation(
      this.store,
      this.principal(a),
      op,
      key,
      payload,
      action,
      reconcile,
    );
  }
  async profile(a: CurrentUserSummary) {
    return {
      id: a.employeeId,
      name: a.name,
      role: (await this.isOperator(a)) ? 'operator' : 'handler',
      mode: 'live-chatwoot',
      identity: 'cobuild',
      authenticated: true,
    };
  }
  async members(a: CurrentUserSummary) {
    return (await this.intake.members(a)).members
      .sort(
        (x, y) =>
          Number(!!y.isCurrent) - Number(!!x.isCurrent) ||
          x.name.localeCompare(y.name, 'zh-CN'),
      )
      .map((m) => ({ ...m, role: 'handler' }));
  }
  private async contact(a: CurrentUserSummary, app: string) {
    const p = this.principal(a),
      existing = await this.store.contacts(p, app);
    if (existing) return existing;
    // Chatwoot v4.18 ContactInboxWithContactBuilder finds the fixed source_id first;
    // retrying this identity provisioning call never creates a second contact inbox.
    const input = {
      ...this.chat.contactInput(app, p, a.name),
      source_id: 'relay_' + digest(p + '|' + app),
    };
    const v = await this.chat.request(this.chat.contact(app), {
      method: 'POST',
      body: input,
      public: true,
    });
    if (typeof v.source_id !== 'string' || !Number.isSafeInteger(v.id))
      throw new ChatwootError(false);
    await this.chat.request(this.chat.contact(app, v.source_id), {
      method: 'PATCH',
      body: input,
      public: true,
    });
    await this.store.saveContact(p, app, v.source_id, v.id);
    return { source_id: v.source_id, contact_id: v.id };
  }
  async begin(a: CurrentUserSummary, app: string, key: string) {
    if (!this.chat.config().apps[app])
      throw new BadRequestException('应用未配置');
    const c = await this.contact(a, app),
      p = this.principal(a);
    const save = async (v: any) => {
      if (
        !Number.isSafeInteger(v.id) ||
        v.inbox_id !== this.chat.config().apps[app].inboxId
      )
        throw new ChatwootError(false);
      const row: ConversationRow = {
        id: `cw_${this.chat.config().accountId}_${v.id}`,
        principal: p,
        app,
        remote_id: v.id,
        source_id: c.source_id,
        created_at: new Date().toISOString(),
      };
      await this.store.saveConversation(row);
      return { id: row.id };
    };
    return this.once(
      a,
      'begin:' + app,
      key,
      { app },
      async (marker) =>
        save(
          await this.chat.request(this.chat.account('/conversations'), {
            method: 'POST',
            body: {
              source_id: c.source_id,
              inbox_id: this.chat.config().apps[app].inboxId,
              contact_id: c.contact_id,
              status: 'open',
              custom_attributes: { relay_operation: marker, relay_app: app },
            },
          }),
        ),
      async (marker) => {
        const history = await this.chat.request(
          this.chat.account(`/contacts/${c.contact_id}/conversations`),
        );
        const values = history.payload;
        if (!Array.isArray(values)) throw new ChatwootError(false);
        const matches = values.filter(
          (v: any) =>
            v.inbox_id === this.chat.config().apps[app].inboxId &&
            v.custom_attributes?.relay_operation === marker,
        );
        if (matches.length > 1)
          throw new ConflictException('发现重复咨询，需人工核对');
        return matches[0] ? save(matches[0]) : null;
      },
    );
  }
  private cleanMessage(m: any, id: string, view: 'operator' | 'customer') {
    return cleanRelayMessage(m, id, view);
  }
  private async snapshot(
    row: ConversationRow,
    view: 'operator' | 'customer',
    remote?: any,
  ) {
    const value =
      remote ||
      (await this.chat.request(
        this.chat.account(`/conversations/${row.remote_id}`),
      ));
    const messages = await this.chat.messages(row.remote_id);
    return {
      id: row.id,
      customerId: row.principal,
      createdAt: row.created_at,
      name: value.meta?.sender?.name || value.contact?.name || '用户',
      app: row.app,
      title:
        messages
          .find((m: any) => m.message_type === 0 && !m.private)
          ?.content?.slice(0, 120) || '新咨询',
      state:
        value.status === 'resolved'
          ? 'resolved'
          : messages.some((m: any) => m.message_type === 1 && !m.private)
            ? 'open'
            : 'new',
      owner:
        value.meta?.assignee?.name ||
        messages.find((m: any) => m.message_type === 1 && !m.private)
          ?.content_attributes?.relay_sender_name ||
        '未接待',
      time: messages.length
        ? new Date(Number(messages.at(-1).created_at) * 1000).toISOString()
        : row.created_at,
      unread: false,
      messages: messages
        .filter(
          (m: any) =>
            view === 'operator' || (!m.private && m.message_type !== 2),
        )
        .map((m: any) => this.cleanMessage(m, row.id, view)),
    };
  }
  async state(a: CurrentUserSummary, view: 'operator' | 'customer') {
    const operator = view === 'operator';
    if (operator) await this.operator(a);
    const rows = await this.store.conversations(
      operator ? undefined : this.principal(a),
    );
    if (rows.length > 200)
      throw new ServiceUnavailableException('咨询过多，请按应用分页处理');
    const allowed: ConversationRow[] = [];
    for (const row of rows) {
      if (!this.chat.config().apps[row.app]) continue;
      if (!operator || (await this.isOperator(a, row.app))) allowed.push(row);
    }
    const conversations = [];
    for (const row of allowed)
      conversations.push(await this.snapshot(row, view));
    const tickets: any[] = [];
    const pendingConversions: any[] = [];
    if (operator)
      for (const row of allowed) {
        const intent = await this.intents.read(
          process.env.RELAY_SOURCE_ID || '',
          row.id,
        );
        if (!intent) continue;
        try {
          const result = await this.intake.get(row.id, a);
          const t = this.ticket(
            result.requirement,
            row.id,
            JSON.parse(intent.payload_json),
            typeof intent.created_at === 'string'
              ? intent.created_at
              : intent.created_at instanceof Date
                ? intent.created_at.toISOString()
                : undefined,
          );
          tickets.push({
            ...t,
            status: (
              {
                待分派: 'pending',
                处理中: 'processing',
                待补充: 'waiting',
                已解决: 'resolved',
                已关闭: 'closed',
              } as Record<string, string>
            )[t.status],
            priority: (
              { 较低: 'low', 普通: 'normal', 紧急: 'high' } as Record<
                string,
                string
              >
            )[t.priority],
          });
        } catch (e) {
          if (intent.requirement_id) {
            // The creation receipt is durable even when Base cannot currently be
            // read. Retain that confirmed identity; never offer another creation.
            const saved = JSON.parse(intent.payload_json);
            tickets.push({
              live: true,
              id: intent.requirement_id,
              conversationId: row.id,
              nativeUrl: requirementPlatformUrl(intent.requirement_id),
              title: saved.title,
              description: saved.description || '',
              code: '',
              status:
                e instanceof NotFoundException ? 'unavailable' : 'syncing',
              syncPending: true,
              priority: 'unknown',
              owner: '待同步',
              created: intent.created_at,
              events: [],
              replies: [],
              context: saved,
            });
          } else
            pendingConversions.push({
              conversationId: row.id,
              title:
                conversations.find((c) => c.id === row.id)?.title || '咨询',
              state: intent.state,
            });
        }
      }
    return {
      online: true,
      mode: 'live-chatwoot',
      profile: await this.profile(a),
      conversations,
      tickets,
      pendingConversions,
    };
  }
  async contextByMarker(marker: string, a: CurrentUserSummary) {
    return this.intake.context(marker, a);
  }
  async context(id: string, a: CurrentUserSummary) {
    const { row, remote } = await this.owned(id, a, true),
      c = await this.snapshot(row, 'operator', remote);
    return {
      capturedAt: new Date().toISOString(),
      customerName: c.name,
      sourceApp: this.chat.config().apps[row.app].name,
      sourceUrl:
        this.publicUrl('/relay') + '?conversation=' + encodeURIComponent(id),
      messages: c.messages,
    };
  }
  async send(
    id: string,
    a: CurrentUserSummary,
    body: unknown,
    key: string,
    operator: boolean,
  ) {
    const { row } = await this.owned(id, a, operator);
    return sendRelayMessage(
      this.chat,
      this.store,
      this.principal(a),
      row.remote_id,
      id,
      a,
      body,
      key,
      operator,
    );
  }
  async resolve(
    id: string,
    a: CurrentUserSummary,
    key: string,
    body: unknown = {},
  ) {
    const { status } = z
      .object({ status: z.enum(['open', 'resolved']).default('resolved') })
      .strict()
      .parse(body);
    const { row } = await this.owned(id, a, true);
    return this.once(
      a,
      'resolve:' + id,
      key,
      { status },
      async () => {
        await this.chat.request(
          this.chat.account(`/conversations/${row.remote_id}/toggle_status`),
          { method: 'POST', body: { status } },
        );
        return { resolved: true };
      },
      async () => {
        const v = await this.chat.request(
          this.chat.account(`/conversations/${row.remote_id}`),
        );
        return v.status === status ? { resolved: true } : null;
      },
    );
  }
  async create(a: CurrentUserSummary, body: unknown) {
    const v = createInput.parse(body),
      context = await this.context(v.conversationId, a);
    const members = await this.members(a);
    if (v.handlerIds.some((id) => !members.some((m) => m.id === id)))
      throw new BadRequestException('处理人无效');
    const result = await this.intake.create(
      {
        conversationId: v.conversationId,
        title: v.title,
        description: v.description,
        priority: { 较低: 'P3', 普通: 'P2', 紧急: 'P1' }[v.priority],
        sourceApp: context.sourceApp,
        customerName: context.customerName,
        sourceUrl: context.sourceUrl,
        handlerLarkUserIds: v.handlerIds,
        messages: context.messages.map((m) => ({
          id: m.id,
          content: m.content,
          time: m.time,
          private: m.private,
          side:
            m.side === 'customer'
              ? '用户'
              : m.side === 'operator'
                ? '客服'
                : '系统',
          attachments: m.attachments.map((f: any) => ({
            id: f.id,
            name: f.name,
            url: this.publicUrl(
              `/api/relay/native-attachments/${v.conversationId}/${f.id}`,
            ),
          })),
        })),
      },
      a,
    );
    return this.ticket(result.requirement, v.conversationId, context);
  }
  private ticket(
    r: RequirementSummary,
    id: string,
    context: any,
    createdAt?: string,
  ) {
    return mapRelayTicket(
      r,
      id,
      context,
      createdAt,
      this.publicUrl('/api/workspace/relay-context/'),
      process.env.RELAY_SOURCE_ID || '',
    );
  }
  async tickets(a: CurrentUserSummary, id?: string): Promise<any> {
    const rows = await this.store.conversations();
    const items = [];
    for (const row of rows) {
      const intent = await this.intents.read(
        process.env.RELAY_SOURCE_ID || '',
        row.id,
      );
      if (!intent?.requirement_id || (id && intent.requirement_id !== id))
        continue;
      const r = await this.intake.get(row.id, a);
      const context = JSON.parse(intent.payload_json);
      const ticket = this.ticket(
        r.requirement,
        row.id,
        context,
        typeof intent.created_at === 'string'
          ? intent.created_at
          : intent.created_at instanceof Date
            ? intent.created_at.toISOString()
            : undefined,
      );
      if (id) {
        const savedIds = new Set(
          (context.messages || []).map((m: any) => String(m.id)),
        );
        try {
          ticket.updates = (await this.chat.messages(row.remote_id))
            .filter(
              (m: any) => m.message_type !== 2 && !savedIds.has(String(m.id)),
            )
            .map((m: any) => this.cleanMessage(m, row.id, 'operator'))
            .map((m: any) => ({
              ...m,
              attachments: m.attachments.map((f: any) => ({
                ...f,
                url: `/api/relay/native-attachments/${row.id}/${f.id}`,
              })),
            }));
        } catch {
          ticket.updatesUnavailable = true;
          ticket.updates = [];
        }
      }
      items.push(ticket);
    }
    if (id && !items.length) throw new NotFoundException('工单不存在');
    return id ? items[0] : items;
  }
  async update(id: string, a: CurrentUserSummary, body: unknown, key: string) {
    const v = updateInput.parse(body);
    await this.tickets(a, id);
    const matches = (r: RequirementSummary) =>
      r.status === v.status &&
      r.latestProgress === v.note &&
      [...r.personnelUserIds.handlers].sort().join('|') ===
        [...new Set(v.handlerIds)].sort().join('|');
    await this.once(
      a,
      'ticket-update:' + id,
      key,
      v,
      async () => {
        await this.command.updateRequirementAs(
          id,
          {
            expectedUpdatedAt: v.revision,
            patch: {
              status: v.status,
              handlerLarkUserIds: v.handlerIds,
              latestProgress: v.note,
            },
          },
          a,
        );
        return { updated: true };
      },
      async () =>
        matches(await this.query.requirementByIdAs(id, a))
          ? { updated: true }
          : null,
    );
    return this.tickets(a, id);
  }
  async group(id: string, a: CurrentUserSummary) {
    const t = await this.tickets(a, id);
    await this.intake.group(t.conversationId, a);
    return this.tickets(a, id);
  }
  async attachment(
    id: string,
    fileId: string,
    a: CurrentUserSummary,
    operator: boolean,
    fromTicket = false,
  ) {
    let row: ConversationRow;
    if (fromTicket) {
      await this.intake.get(id, a); // Native ticket visibility is the authorization boundary.
      const stored = await this.store.conversation(id);
      if (!stored || !this.chat.config().apps[stored.app])
        throw new NotFoundException('咨询不存在');
      const remote = await this.chat.request(
        this.chat.account(`/conversations/${stored.remote_id}`),
      );
      if (remote.inbox_id !== this.chat.config().apps[stored.app].inboxId)
        throw new ConflictException('咨询所属应用已变化');
      row = stored;
    } else row = (await this.owned(id, a, operator)).row;
    const messages = await this.chat.messages(row.remote_id);
    const file = messages
      .filter(
        (m: any) =>
          fromTicket || operator || (!m.private && m.message_type !== 2),
      )
      .flatMap((m: any) => m.attachments || [])
      .find((f: any) => String(f.id) === fileId);
    if (!file) throw new NotFoundException('附件不存在');
    return downloadRelayAttachment(this.chat, file);
  }
}
