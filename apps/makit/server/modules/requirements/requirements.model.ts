import { isTicketType, ticketAllowedStatuses, TICKET_STATUSES } from '../../../shared/ticket-workflow';
import { createHash } from 'node:crypto';
import type { PersonRef, RequirementPatch } from '@shared/api.interface';

export { NORMAL_STATUS_ORDER, STATUS_ORDER, DEFECT_STATUS_ORDER, DEFECT_BRANCH_STATUSES, timestamp, statusRank, workflowStatusSortRank, normalizeRequirementStatus } from "../../../shared/requirement-list-values";
import { NORMAL_STATUS_ORDER, DEFECT_STATUS_ORDER, DEFECT_BRANCH_STATUSES, timestamp, statusRank, normalizeRequirementStatus } from "../../../shared/requirement-list-values";

const DEFECT_TRANSITIONS: Readonly<Record<string, string[]>> = {
  新建: ['处理中', '已拒绝'],
  处理中: ['已解决', '已拒绝'],
  已解决: ['已验证', '重新打开'],
  已验证: ['已关闭', '重新打开'],
  重新打开: ['处理中'],
  已拒绝: ['重新打开'],
  已关闭: ['重新打开'],
};

export function textValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join('、');
  }
  if (typeof value === 'object') {
    const item: Record<string, unknown> = value as Record<string, unknown>;
    return textValue(item.text || item.name || item.id || item.value);
  }
  return '';
}

export function hasMeaningfulText(value: string): boolean {
  return Boolean(
    value
      .replace(/<style[^>]*>.*?<\/style>/gsu, ' ')
      .replace(/<script[^>]*>.*?<\/script>/gsu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/&nbsp;|&#160;/giu, ' ')
      .replace(/&amp;/giu, '&')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

export function selectValues(value: unknown): string[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean);
  }
  const text: string = textValue(value);
  return text ? [text] : [];
}

export function urlValue(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return urlValue(value[0]);
  if (typeof value === 'object') {
    const item: Record<string, unknown> = value as Record<string, unknown>;
    return textValue(item.link || item.url || item.href);
  }
  return '';
}

export function linkedIds(value: unknown): string[] {
  const collect = (cell: unknown): string[] => {
    if (typeof cell === 'string') return cell.trim() ? [cell.trim()] : [];
    if (Array.isArray(cell)) return cell.flatMap(collect);
    if (!cell || typeof cell !== 'object') return [];
    const record = cell as Record<string, unknown>;
    for (const key of ['link_record_ids', 'record_ids', 'record_id', 'id']) {
      if (record[key] !== undefined) return collect(record[key]);
    }
    return [];
  };
  return [...new Set(collect(value))];
}

function avatarUrl(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object'
    ? textValue((value as Record<string, unknown>).avatar_240 || (value as Record<string, unknown>).avatar_origin) : '';
  try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function people(value: unknown): PersonRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown): PersonRef | null => {
      if (!item || typeof item !== 'object') return null;
      const record: Record<string, unknown> = item as Record<string, unknown>;
      const id: string = textValue(record.id || record.open_id);
      if (!id) return null;
      return {
        id,
        name: textValue(record.name || record.text),
        avatarUrl: avatarUrl(record.avatar_url || record.avatar),
      };
    })
    .filter((item: PersonRef | null): item is PersonRef => Boolean(item));
}

export function uniquePeople(groups: PersonRef[][]): PersonRef[] {
  const result: PersonRef[] = [];
  const seen: Set<string> = new Set<string>();
  groups.flat().forEach((person: PersonRef): void => {
    if (!person.id || seen.has(person.id)) return;
    seen.add(person.id);
    result.push(person);
  });
  return result;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    JSON.stringify(uniqueStrings(left).sort()) ===
    JSON.stringify(uniqueStrings(right).sort())
  );
}

function normalizedOption(value: string): string {
  return value === '未设置' ? '' : value.trim();
}

export function pruneRequirementPatch(
  patch: RequirementPatch,
  current: {
    title: string;
    introduction: string;
    acceptanceCriteria: string;
    selfTestReport: string;
    defectCause: string;
    gitBranchName: string;
    githubPullRequestUrl: string;
    type: string;
    source: string;
    tags: string[];
    status: string;
    priority: string;
    project: string;
    iterationIds: string[];
    startAt: string | number | null;
    deadlineAt: string | number | null;
    developmentStartAt: string | number | null;
    developmentEndAt: string | number | null;
    testingAt: string | number | null;
    actualStartAt: string | number | null;
    actualTestingAt: string | number | null;
    actualReleaseAt: string | number | null;
    effort: number | null;
    latestProgress: string;
    blocked: boolean;
    blocker: string;
    personnelUserIds: {
      handlers: string[];
      productOwners: string[];
      developers: string[];
      testers: string[];
      foOwners: string[];
      proposers: string[];
      followers: string[];
      releaseOwners: string[];
    };
  },
): RequirementPatch {
  const next: RequirementPatch = { ...patch };
  const equalText = (
    value: string | undefined,
    currentValue: string,
  ): boolean => value !== undefined && value.trim() === currentValue.trim();
  if (equalText(next.title, current.title)) delete next.title;
  if (equalText(next.introduction, current.introduction))
    delete next.introduction;
  if (equalText(next.acceptanceCriteria, current.acceptanceCriteria)) {
    delete next.acceptanceCriteria;
  }
  if (equalText(next.selfTestReport, current.selfTestReport)) {
    delete next.selfTestReport;
  }
  if (equalText(next.defectCause, current.defectCause)) {
    delete next.defectCause;
  }
  if (equalText(next.gitBranchName, current.gitBranchName)) {
    delete next.gitBranchName;
  }
  if (equalText(next.githubPullRequestUrl, current.githubPullRequestUrl)) {
    delete next.githubPullRequestUrl;
  }
  if (
    next.type !== undefined &&
    normalizedOption(next.type) === normalizedOption(current.type)
  )
    delete next.type;
  if (
    next.source !== undefined &&
    normalizedOption(next.source) === normalizedOption(current.source)
  )
    delete next.source;
  if (next.tags !== undefined && sameStringSet(next.tags, current.tags)) {
    delete next.tags;
  }
  if (next.status === current.status) delete next.status;
  if (
    next.priority !== undefined &&
    normalizedOption(next.priority) === normalizedOption(current.priority)
  )
    delete next.priority;
  if (
    next.project !== undefined &&
    normalizedOption(next.project) === normalizedOption(current.project)
  )
    delete next.project;
  if (
    next.iterationIds !== undefined &&
    sameStringSet(next.iterationIds, current.iterationIds)
  )
    delete next.iterationIds;
  const dateKeys: Array<
    | 'startAt'
    | 'deadlineAt'
    | 'developmentStartAt'
    | 'developmentEndAt'
    | 'testingAt'
    | 'actualStartAt'
    | 'actualTestingAt'
    | 'actualReleaseAt'
  > = [
    'startAt',
    'deadlineAt',
    'developmentStartAt',
    'developmentEndAt',
    'testingAt',
    'actualStartAt',
    'actualTestingAt',
    'actualReleaseAt',
  ];
  dateKeys.forEach((key): void => {
    if (
      next[key] !== undefined &&
      timestamp(next[key]) === timestamp(current[key])
    )
      delete next[key];
  });
  if (next.effort !== undefined && next.effort === current.effort) {
    delete next.effort;
  }
  if (equalText(next.latestProgress, current.latestProgress)) {
    delete next.latestProgress;
  }
  if (next.blocked === current.blocked) delete next.blocked;
  if (equalText(next.blocker, current.blocker)) delete next.blocker;
  const personnelKeys: Array<
    [keyof RequirementPatch, keyof typeof current.personnelUserIds]
  > = [
    ['handlerUserIds', 'handlers'],
    ['handlerLarkUserIds', 'handlers'],
    ['productOwnerUserIds', 'productOwners'],
    ['productOwnerLarkUserIds', 'productOwners'],
    ['developerUserIds', 'developers'],
    ['developerLarkUserIds', 'developers'],
    ['testerUserIds', 'testers'],
    ['testerLarkUserIds', 'testers'],
    ['foOwnerUserIds', 'foOwners'],
    ['foOwnerLarkUserIds', 'foOwners'],
    ['proposerUserIds', 'proposers'],
    ['proposerLarkUserIds', 'proposers'],
    ['followerUserIds', 'followers'],
    ['followerLarkUserIds', 'followers'],
    ['releaseOwnerUserIds', 'releaseOwners'],
    ['releaseOwnerLarkUserIds', 'releaseOwners'],
  ];
  personnelKeys.forEach(([patchKey, currentKey]): void => {
    const value: unknown = next[patchKey];
    if (
      Array.isArray(value) &&
      sameStringSet(value as string[], current.personnelUserIds[currentKey])
    ) {
      delete next[patchKey];
    }
  });
  return next;
}

export function isDefectType(type: string): boolean {
  return type === '缺陷';
}

export function workflowStatuses(type: string): string[] {
  if (isTicketType(type)) return [...TICKET_STATUSES];
  return isDefectType(type)
    ? [...DEFECT_STATUS_ORDER, ...DEFECT_BRANCH_STATUSES]
    : NORMAL_STATUS_ORDER;
}

export function allowedStatuses(status: string, type = '产品需求'): string[] {
  if (isTicketType(type)) return ticketAllowedStatuses(status);
  if (isDefectType(type)) {
    const next: string[] | undefined = DEFECT_TRANSITIONS[status];
    if (next) return [status, ...next];
    return [status, '新建'];
  }
  const normalizedStatus: string = normalizeRequirementStatus(status);
  const current: number | null = statusRank(normalizedStatus);
  if (current == null) return [normalizedStatus, NORMAL_STATUS_ORDER[0]];
  return NORMAL_STATUS_ORDER.filter(
    (_item: string, index: number): boolean => Math.abs(index - current) <= 1,
  );
}

export type RequirementUpdateConflictResolution =
  | 'proceed'
  | 'rebase'
  | 'already-applied'
  | 'conflict';

export function isStatusOnlyRequirementPatch(patch: RequirementPatch): boolean {
  const changedKeys: string[] = Object.entries(patch)
    .filter(([, value]: [string, unknown]): boolean => value !== undefined)
    .map(([key]: [string, unknown]): string => key);
  return changedKeys.length === 1 && changedKeys[0] === 'status';
}

export function resolveRequirementUpdateConflict(
  expectedUpdatedAt: unknown,
  currentUpdatedAt: unknown,
  patch: RequirementPatch,
  currentStatus: string,
  currentType = '产品需求',
): RequirementUpdateConflictResolution {
  if (timestamp(expectedUpdatedAt) === timestamp(currentUpdatedAt)) {
    return 'proceed';
  }
  if (!isStatusOnlyRequirementPatch(patch) || !patch.status) {
    return 'conflict';
  }
  const nextStatus: string = normalizeRequirementStatus(patch.status);
  const normalizedCurrentStatus: string =
    normalizeRequirementStatus(currentStatus);
  if (nextStatus === normalizedCurrentStatus) return 'already-applied';
  if (
    allowedStatuses(normalizedCurrentStatus, currentType).includes(nextStatus)
  ) {
    return 'rebase';
  }
  return 'conflict';
}

export function requirementUuid(recordId: string): string {
  const hex: string = createHash('sha256')
    .update(`feishu-requirement-group:${recordId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function chatDeepLink(chatId: string): string {
  if (!chatId) return '';
  return (
    'https://applink.feishu.cn/client/chat/open?openChatId=' +
    encodeURIComponent(chatId)
  );
}

export function isOverdue(value: unknown, now: number = Date.now()): boolean {
  const at: number | null = timestamp(value);
  return at != null && at < now;
}

export function formatShanghaiTimestamp(value: number): string {
  const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const values: Record<string, string> = Object.fromEntries(
    parts.map((part: Intl.DateTimeFormatPart): [string, string] => [
      part.type,
      part.value,
    ]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
