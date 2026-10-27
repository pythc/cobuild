import { isTicketType } from '../../../shared/ticket-workflow';
import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { PersonRef, RequirementSummary } from '@shared/api.interface';
import { requirementPlatformUrl } from '../requirements/requirement-links';
import {
  confirmedWorkflowSource,
  markerOperation,
} from './workflow-source.model';

export type DeliveryState =
  | 'shadow'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'retry_wait'
  | 'failed'
  | 'suppressed'
  | 'unknown';
export type DeliveryOutcome = 'sent' | 'rejected' | 'unknown' | 'suppressed';
export interface DeliveryPayload {
  type: 'interactive' | 'post';
  receiveIdType: 'open_id' | 'user_id' | 'chat_id';
  content: Record<string, unknown>;
}
export interface DeliveryPlan {
  eventId: string;
  operationId?: string;
  source: 'requirement_workflow' | 'pr_reviewer' | 'operational_alert';
  owner: 'shadow' | 'managed_bot' | 'platform_pr' | 'platform_alert';
  kind: string;
  templateVersion: string;
  requirementId?: string;
  repository?: string;
  pullNumber?: number;
  channel: 'feishu_private' | 'feishu_group';
  targetId: string;
  targetName: string;
  platformUrl: string;
  payload: DeliveryPayload;
  policyMode: string;
  policyAllowed: boolean;
  policyReason: string;
}
export interface RequirementNotificationEvent {
  eventId: string;
  operationId?: string;
  requirementId: string;
  occurredAt: string;
  before: RequirementSummary | null;
  after: RequirementSummary;
  fields?: string[];
  actor: { id?: string; name: string };
  iterationTargets?: Array<{ id: string; name: string; chatId: string }>;
}

const PERSONNEL: Record<string, string> = {
  handlers: '当前处理人',
  productOwners: '产品人员',
  developers: '研发人员',
  testers: '测试人员',
  foOwners: 'FO',
  proposers: '提出人',
  followers: '关注人',
  releaseOwners: '发布负责人',
};
const LABELS: Record<string, string> = {
  ...PERSONNEL,
  title: '需求',
  status: '状态',
  priority: '优先级',
  project: '项目',
  iterationIds: '所属迭代',
  type: '需求类型',
  source: '需求来源',
  introduction: '需求介绍',
  acceptanceCriteria: '验收标准',
  selfTestReport: '自测报告',
  technicalDocument: '技术文档',
  defectCause: '缺陷原因',
  gitBranchName: 'Git 分支名称',
  githubPullRequestUrl: 'GitHub 合并请求链接',
  startAt: '开始时间',
  deadlineAt: '截止时间',
  developmentStartAt: '开发预计启动时间',
  developmentEndAt: '开发预计结束时间',
  testingAt: '预计提测',
  effort: '开发工作量',
  blocked: '是否阻塞',
  blocker: '阻塞原因',
  latestProgress: '最新进展',
};

export function deliveryDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalize(value: unknown): unknown {
  if (value == null || value === '' || value === '未设置') return null;
  if (Array.isArray(value))
    return [
      ...new Set(
        value.map((item: unknown): string =>
          typeof item === 'object' && item !== null && 'id' in item
            ? String(item.id)
            : String(item),
        ),
      ),
    ].sort();
  return value;
}

function names(people: PersonRef[]): string {
  return (
    people
      .map((person: PersonRef): string => person.name)
      .filter(Boolean)
      .join('、') || '未分配'
  );
}

function escape(value: string): string {
  return value.replace(
    /[&<>*~\[\]()#]/gu,
    (character: string): string => `&#${character.charCodeAt(0)};`,
  );
}

function column(content: string): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '4px 8px',
        elements: [{ tag: 'markdown', content }],
      },
    ],
  };
}

/** Same compact Card 2.0 structure as the established bot; never includes PRD text. */
function card(
  event: RequirementNotificationEvent,
  title: string,
  lines: string[],
  group: boolean,
): Record<string, unknown> {
  const requirement: RequirementSummary = event.after;
  const url: string = requirementPlatformUrl(event.requirementId);
  const ticket = isTicketType(requirement.type);
  const handlers: string = group
    ? requirement.handlers
        .filter((person: PersonRef): boolean =>
          /^[A-Za-z0-9_-]+$/u.test(person.id),
        )
        .map((person: PersonRef): string => `<at id=${person.id}></at>`)
        .join('、') || '未分配'
    : escape(names(requirement.handlers));
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: title },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: {
        tag: 'plain_text',
        content: `由 ${event.actor.name || '成员'} 修改`,
      },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'wiki-bitable_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: requirement.status },
          color: 'blue',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '8px 12px 12px 12px',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'markdown',
          content: `**[${escape(requirement.title)}](${url})**`,
          text_size: 'heading',
        },
        column(
          ticket
            ? `**工单编号**：${escape(requirement.code || '')}\n**优先级**：${escape(requirement.priority)}`
            : `**所属迭代**：${escape(requirement.iterationNames.join('、') || '未纳入迭代')}\n**项目 / 优先级**：${escape(requirement.project)} · ${escape(requirement.priority)}`,
        ),
        column(lines.join('\n')),
        column(
          `**当前处理人**：${handlers}\n\n> ${ticket ? (['已解决', '已关闭'].includes(requirement.status) ? '处理结果已更新，可打开工单查看。' : '请打开工单跟进处理。') : '请核对变更并推进后续工作。'}`,
        ),
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: ticket ? '查看工单' : '查看需求',
          },
          type: 'primary_filled',
          width: 'fill',
          behaviors: [{ type: 'open_url', default_url: url }],
        },
      ],
    },
  };
}

export function deliveryPolicy(
  channel: DeliveryPlan['channel'],
  targetId: string,
  source: DeliveryPlan['source'],
): { mode: string; allowed: boolean; reason: string } {
  const mode: string =
    source === 'pr_reviewer'
      ? process.env.PR_REVIEWER_NOTIFICATION_MODE || 'disabled'
      : process.env.NOTIFICATION_MODE || 'disabled';
  const allowlist: string =
    channel === 'feishu_group'
      ? process.env.NOTIFICATION_ALLOWED_CHAT_IDS || ''
      : source === 'pr_reviewer'
        ? process.env.PR_REVIEWER_NOTIFICATION_ALLOWED_USER_IDS || ''
        : process.env.NOTIFICATION_ALLOWED_USER_IDS || '';
  const allowed: boolean =
    mode === 'live' ||
    (mode === 'test_only' &&
      allowlist
        .split(',')
        .map((id: string): string => id.trim())
        .includes(targetId));
  return {
    mode: ['live', 'test_only'].includes(mode) ? mode : 'disabled',
    allowed,
    reason: allowed
      ? 'allowed'
      : mode === 'test_only'
        ? 'outside_test_allowlist'
        : 'notifications_disabled',
  };
}

export function requirementDeliveryPlans(
  event: RequirementNotificationEvent,
): DeliveryPlan[] {
  const before: Record<string, unknown> =
    (event.before as unknown as Record<string, unknown>) || {};
  const after: Record<string, unknown> = event.after as unknown as Record<
    string,
    unknown
  >;
  const ticket = isTicketType(event.after.type);
  const ticketFields = new Set([
    'handlers',
    'title',
    'status',
    'priority',
    'introduction',
    'latestProgress',
    'blocked',
    'blocker',
    'deadlineAt',
  ]);
  const fields: string[] = Object.keys(LABELS).filter(
    (key: string): boolean =>
      (!ticket || ticketFields.has(key)) &&
      (!event.fields ||
        event.fields.includes(key) ||
        event.fields.includes(LABELS[key])) &&
      deliveryDigest(normalize(before[key])) !==
        deliveryDigest(normalize(after[key])),
  );
  if (!fields.length) return [];
  const plans: Map<string, DeliveryPlan> = new Map();
  const add = (
    targetId: string,
    targetName: string,
    group: boolean,
    kind: string,
    title: string,
    lines: string[],
  ): void => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(targetId)) return;
    const channel: DeliveryPlan['channel'] = group
      ? 'feishu_group'
      : 'feishu_private';
    const policy = deliveryPolicy(channel, targetId, 'requirement_workflow');
    plans.set(`${channel}:${targetId}`, {
      eventId: event.eventId,
      operationId: event.operationId,
      source: 'requirement_workflow',
      // A same-write marker is mandatory; historical shadow rows never become pending.
      owner:
        confirmedWorkflowSource() &&
        process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot' &&
        event.operationId &&
        markerOperation(event.after.notificationMarker) === event.operationId
          ? 'managed_bot'
          : 'shadow',
      kind,
      templateVersion: 'requirement-card-v1',
      requirementId: event.requirementId,
      channel,
      targetId,
      targetName,
      platformUrl: requirementPlatformUrl(event.requirementId),
      payload: {
        type: 'interactive',
        receiveIdType: group ? 'chat_id' : 'open_id',
        content: card(event, title, lines, group),
      },
      policyMode: policy.mode,
      policyAllowed: policy.allowed,
      policyReason: policy.reason,
    });
  };
  const changed: string[] = fields.map((key: string): string =>
    ticket && key === 'title'
      ? '工单标题'
      : ticket && key === 'introduction'
        ? '问题描述'
        : ticket && key === 'latestProgress'
          ? '处理进展'
          : LABELS[key],
  );
  const changeLines: string[] = [`**变更字段**：${escape(changed.join('、'))}`];
  if (fields.includes('status'))
    changeLines.push(
      `**状态**：${escape(event.before?.status || '新建')} → ${escape(event.after.status)}`,
    );
  const assignments: Map<string, { person: PersonRef; roles: string[] }> =
    new Map();
  for (const [key, label] of Object.entries(PERSONNEL)) {
    if (!fields.includes(key)) continue;
    const oldIds: Set<string> = new Set(
      ((before[key] || []) as PersonRef[]).map(
        (person: PersonRef): string => person.id,
      ),
    );
    for (const person of (after[key] || []) as PersonRef[]) {
      if (oldIds.has(person.id)) continue;
      const entry = assignments.get(person.id) || { person, roles: [] };
      entry.roles.push(label);
      assignments.set(person.id, entry);
    }
  }
  for (const { person, roles } of assignments.values())
    add(
      person.id,
      person.name,
      false,
      'assignment',
      ticket ? '您收到一张新工单' : '您收到一项新的工作',
      [`**分配字段**：${escape(roles.join('、'))}`, ...changeLines],
    );
  if (fields.some((key: string): boolean => !(key in PERSONNEL))) {
    for (const person of event.after.handlers)
      if (!assignments.has(person.id))
        add(
          person.id,
          person.name,
          false,
          'change',
          ticket
            ? fields.includes('status')
              ? '工单状态更新'
              : '您负责的工单已更新'
            : '您负责的需求已更新',
          changeLines,
        );
  }
  // Do not turn routine text/date edits into new group broadcasts.
  if (
    event.after.groupChatId &&
    fields.some((key) => key === 'status' || key in PERSONNEL)
  )
    add(
      event.after.groupChatId,
      ticket ? '工单讨论群' : '需求协作群',
      true,
      'requirement-group',
      ticket
        ? fields.includes('status')
          ? '工单状态更新'
          : '工单处理人更新'
        : '需求协作更新',
      changeLines,
    );
  const addedIterationIds: Set<string> = new Set(
    event.after.iterationIds.filter(
      (id: string): boolean => !event.before?.iterationIds.includes(id),
    ),
  );
  for (const target of ticket ? [] : event.iterationTargets || []) {
    if (fields.includes('status') || addedIterationIds.has(target.id))
      add(
        target.chatId,
        target.name,
        true,
        'iteration-group',
        fields.includes('status') ? '需求状态更新通知' : '迭代收到新的需求',
        changeLines,
      );
  }
  return [...plans.values()];
}

export function verifyWorkerToken(value: unknown): void {
  const expected: string =
    process.env.WORKFLOW_DELIVERY_WORKER_TOKEN?.trim() || '';
  if (expected.length < 32 || typeof value !== 'string' || value.length > 512)
    throw new UnauthorizedException('工作流服务身份无效');
  const given: Buffer = Buffer.from(value);
  const wanted: Buffer = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    throw new UnauthorizedException('工作流服务身份无效');
}
