import type {
  MutationResult,
  OperationRecord,
  OperationStage,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';
import type { requirementUpdateJob } from '../../database/schema';

export type StoredOperation = Pick<
  typeof requirementUpdateJob.$inferSelect,
  | 'id'
  | 'requirementId'
  | 'actorUserId'
  | 'actorUserName'
  | 'inputJson'
  | 'resultJson'
  | 'errorMessage'
  | 'createdAt'
  | 'finishedAt'
  | 'status'
  | 'attempts'
>;

const FIELD_LABELS: Record<string, string> = {
  title: '需求标题',
  status: '状态',
  priority: '优先级',
  project: '项目',
  iterationIds: '所属迭代',
  type: '需求类型',
  source: '需求来源',
  tags: '需求标签',
  introduction: '需求介绍',
  acceptanceCriteria: '验收标准',
  selfTestReport: '自测报告',
  defectCause: '缺陷原因',
  gitBranchName: 'Git 分支名称',
  githubPullRequestUrl: 'GitHub 合并请求链接',
  handlerUserIds: '当前处理人',
  handlerLarkUserIds: '当前处理人',
  productOwnerUserIds: '产品人员',
  productOwnerLarkUserIds: '产品人员',
  developerUserIds: '研发人员',
  developerLarkUserIds: '研发人员',
  testerUserIds: '测试人员',
  testerLarkUserIds: '测试人员',
  releaseOwnerUserIds: '发布负责人',
  releaseOwnerLarkUserIds: '发布负责人',
  proposerUserIds: '提出人',
  proposerLarkUserIds: '提出人',
  followerUserIds: '关注人',
  followerLarkUserIds: '关注人',
  foOwnerUserIds: 'FO',
  foOwnerLarkUserIds: 'FO',
  startAt: '开始时间',
  deadlineAt: '截止时间',
  developmentStartAt: '开发预计启动时间',
  developmentEndAt: '开发预计结束时间',
  testingAt: '预计提测时间',
  actualStartAt: '实际开始时间',
  actualTestingAt: '实际提测时间',
  actualReleaseAt: '实际发布时间',
  latestProgress: '最新进展',
  effort: '开发工作量',
  blocked: '是否阻塞',
  blocker: '阻塞原因',
};

export function operationErrorCode(message: string): string {
  if (!message) return '';
  if (/已被.*更新|版本|冲突|409/u.test(message)) return 'CONFLICT';
  if (/权限|403|Forbidden|授权|身份/u.test(message)) return 'PERMISSION';
  if (/归档|不存在|未找到/u.test(message)) return 'NOT_AVAILABLE';
  if (
    /必须|需要填写|不能为空|不支持|不能从|不在.*流程|无效|缺少/u.test(message)
  )
    return 'VALIDATION';
  if (/429|限流/u.test(message)) return 'RATE_LIMIT';
  if (
    /超时|timeout|ETIMEDOUT|AbortError|ECONN|socket hang up|网络|租约|未知|\b50[0234]\b/iu.test(
      message,
    )
  )
    return 'UNCONFIRMED';
  return 'DEPENDENCY';
}

/** Never expose arbitrary provider response bodies, PRD text or credentials. */
export function safeOperationError(message: string): string {
  const code: string = operationErrorCode(message);
  const known: Record<string, string> = {
    CONFLICT: '需求已更新，请查看最新值后重新修改。',
    PERMISSION: '当前权限或身份校验未通过，请联系管理员确认。',
    NOT_AVAILABLE: '需求已归档、删除或不可访问，请查看最新状态。',
    VALIDATION: '修改未通过业务校验，请检查目标状态和必填内容。',
    RATE_LIMIT: '外部服务限流，请稍后查看结果。',
    UNCONFIRMED: '未能确认最终结果，请先查看最新值，避免重复提交。',
    DEPENDENCY: '依赖服务处理异常，请凭操作编号联系管理员排查。',
  };
  return known[code] || '';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function json(value: string | null): Record<string, unknown> {
  try {
    return object(JSON.parse(value || '{}'));
  } catch {
    return {};
  }
}
export function operationDate(
  value: Date | string | number | null,
): string | null {
  if (value == null) return null;
  const date: Date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function operationRecord(row: StoredOperation): OperationRecord {
  const input: Record<string, unknown> = object(json(row.inputJson).input);
  const patch: Record<string, unknown> = object(input.patch);
  let fields: string[] = [
    ...new Set(
      Object.keys(patch).map(
        (key: string): string => FIELD_LABELS[key] || '其他字段',
      ),
    ),
  ];
  const storedResult: Record<string, unknown> = json(row.resultJson);
  if (
    storedResult.success === true &&
    Array.isArray(storedResult.updatedFields)
  ) {
    const knownLabels: Set<string> = new Set(Object.values(FIELD_LABELS));
    fields = [
      ...new Set(
        storedResult.updatedFields.filter(
          (value: unknown): value is string =>
            typeof value === 'string' && knownLabels.has(value),
        ),
      ),
    ];
  }
  const status: RequirementUpdateJobStatus = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'unknown',
  ].includes(row.status)
    ? (row.status as RequirementUpdateJobStatus)
    : 'failed';
  const stages: OperationStage[] = [
    {
      key: 'write',
      label: '需求写入',
      status:
        status === 'succeeded'
          ? 'succeeded'
          : status === 'failed'
            ? 'failed'
            : status === 'unknown'
              ? 'unknown'
              : 'pending',
      detail: '',
    },
    {
      key: 'history',
      label: '变更历史',
      status: 'unknown',
      detail: '旧记录未保存分项结果',
    },
    {
      key: 'review',
      label: '评审触发检查',
      status: 'unknown',
      detail: '请查看需求内的评审记录',
    },
    {
      key: 'notification',
      label: '协作通知',
      status: 'unknown',
      detail: '由协作机器人独立处理，请查看通知记录',
    },
  ];
  if (
    status === 'failed' &&
    operationErrorCode(row.errorMessage || '') === 'UNCONFIRMED'
  ) {
    stages[0].status = 'unknown';
    stages[0].detail = '最终结果未确认，请先查看需求最新值';
  }
  const storedStages: unknown[] = Array.isArray(storedResult.operationStages)
    ? storedResult.operationStages
    : [];
  for (const stage of stages) {
    const found: Record<string, unknown> | undefined = storedStages
      .map(object)
      .find(
        (candidate: Record<string, unknown>): boolean =>
          candidate.key === stage.key,
      );
    if (
      found &&
      ['succeeded', 'failed', 'pending', 'unknown'].includes(
        String(found.status),
      )
    ) {
      stage.status = found.status as OperationStage['status'];
      // Details are generated by this server, but old JSON is still treated as data.
      stage.detail =
        stage.status === 'failed'
          ? '此环节未完成，请查看对应记录'
          : stage.status === 'succeeded'
            ? '已确认'
            : stage.detail;
      if (stage.key === 'review' && stage.status === 'succeeded')
        stage.detail = '触发检查已完成；评审结果请查看 AI 评审记录';
    }
  }
  const result: MutationResult | null = row.resultJson
    ? {
        success: storedResult.success === true,
        message: storedResult.success === true ? '已修改' : '修改未完成',
        recordId: row.requirementId,
        updatedFields: fields,
        operationStages: stages,
      }
    : null;
  return {
    id: row.id,
    requirementId: row.requirementId,
    status,
    attempts: row.attempts,
    result,
    errorMessage: safeOperationError(row.errorMessage || ''),
    errorCode: operationErrorCode(row.errorMessage || ''),
    actorUserId: row.actorUserId,
    actorName: row.actorUserName === '待解析' ? '' : row.actorUserName,
    intent: input.intent === 'status-transition' ? 'status-transition' : 'edit',
    fields,
    targetStatus:
      typeof patch.status === 'string' ? patch.status.slice(0, 80) : '',
    createdAt: operationDate(row.createdAt),
    finishedAt: operationDate(row.finishedAt),
    stages,
  };
}
