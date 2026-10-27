import type { IterationAnalysisConfiguration } from './operations-insights.interface';
import { iterationAnalysisErrors } from './iteration-analysis';
/** Stable status names also exist in the source Base. Never invent an enum here. */
export const ITERATION_STATUS_CATALOG = {
  requirement: [
    '新',
    '需求已评审',
    '开发中',
    '开发转测试',
    '测试中',
    '产品体验中',
    '待发布',
    '已发布',
  ],
  defect: [
    '新建',
    '处理中',
    '已解决',
    '已验证',
    '已关闭',
    '重新打开',
    '已拒绝',
  ],
} as const;
export type IterationWorkflowKind = keyof typeof ITERATION_STATUS_CATALOG;
export const WORKFLOW_FIELD_LABELS = {
  handlers: '当前处理人',
  introduction: '需求介绍',
  acceptanceCriteria: '验收标准',
  developers: '研发人员',
  testers: '测试人员',
  productOwners: '产品人员',
  releaseOwners: '发布负责人',
  technical_design: '技术方案',
  self_test_report: '自测报告',
  githubPullRequestUrl: 'GitHub 合并请求链接',
  gitBranchName: 'Git 分支',
  defectCause: '缺陷原因',
  latestProgress: '处理说明',
} as const;
export type WorkflowRequiredField = keyof typeof WORKFLOW_FIELD_LABELS;
export const WORKFLOW_REVIEW_LABELS = {
  clarity: '需求清晰度评审',
  technical_stability: '技术与稳定性评审',
  delivery_readiness: '交付准备评审',
} as const;
export type WorkflowReview = keyof typeof WORKFLOW_REVIEW_LABELS;
export const WORKFLOW_RELEASE_LABELS = {
  acceptance_items: '已建立验收项',
  acceptance_complete: '验收项全部完成',
  self_test_report: '自测报告已填写',
  testers: '测试人员已设置',
  release_owners: '发布负责人已设置',
  git_branch: '已设置开发关联',
  pull_request: '已关联合并请求',
  pull_request_snapshot_fresh: '合并请求数据为最新',
  pull_request_not_draft: '合并请求不是草稿',
  github_checks: 'GitHub 检查通过',
  github_review: '代码评审无阻塞',
  review_threads: '评审讨论已闭环',
  pull_request_state: '合并请求状态有效',
} as const;
export type WorkflowReleaseCheck = keyof typeof WORKFLOW_RELEASE_LABELS;
export type WorkflowAssigneeRole =
  | 'handlers'
  | 'developers'
  | 'testers'
  | 'productOwners'
  | 'releaseOwners';
export interface IterationTransition {
  from: string;
  to: string;
  requiredFields: WorkflowRequiredField[];
  reviews: WorkflowReview[];
  releaseChecks: WorkflowReleaseCheck[];
  assigneeRole: WorkflowAssigneeRole;
}
export interface IterationWorkflow {
  statuses: string[];
  transitions: IterationTransition[];
}
export interface IterationMilestone {
  id: string;
  name: string;
  dueAt: string | null;
}
export interface IterationConfiguration {
  version: 1;
  workflows: Record<IterationWorkflowKind, IterationWorkflow>;
  milestones: IterationMilestone[];
  analysis?: IterationAnalysisConfiguration;
}
export interface IterationConfigurationVersion {
  version: number;
  publishedAt: string;
  publishedBy: string;
  configuration: IterationConfiguration;
}
export interface IterationSettingsResponse {
  iterationId: string;
  iterationName: string;
  revision: number;
  draft: IterationConfiguration;
  published: IterationConfigurationVersion | null;
  history: IterationConfigurationVersion[];
}
export interface IterationSettingsInput {
  expectedRevision: number;
  configuration: IterationConfiguration;
}
export interface IterationSettingsImpact {
  valid: boolean;
  requirementCount: number;
  errors: string[];
  changes: string[];
}
export interface RequirementIterationWorkflow extends IterationWorkflow {
  iterationId: string;
  version: number;
}

export function iterationWorkflowKind(type: string): IterationWorkflowKind {
  return type === '缺陷' ? 'defect' : 'requirement';
}

export function defaultIterationTransition(
  from: string,
  to: string,
  kind: IterationWorkflowKind,
): IterationTransition {
  const requiredFields: WorkflowRequiredField[] = ['handlers'];
  const reviews: WorkflowReview[] = [];
  let assigneeRole: WorkflowAssigneeRole = 'handlers';
  if (kind === 'requirement') {
    if (to === '需求已评审')
      requiredFields.push('introduction', 'acceptanceCriteria');
    if (to === '开发中') {
      requiredFields.push('developers');
      assigneeRole = 'developers';
    }
    if (['开发转测试', '测试中'].includes(to)) {
      requiredFields.push('testers');
      assigneeRole = 'testers';
    }
    if (to === '开发转测试') requiredFields.push('githubPullRequestUrl');
    if (to === '产品体验中') {
      requiredFields.push('productOwners');
      assigneeRole = 'productOwners';
    }
    if (['待发布', '已发布'].includes(to)) {
      requiredFields.push('releaseOwners');
      assigneeRole = 'releaseOwners';
    }
    if (from === '新' && to === '需求已评审') reviews.push('clarity');
    if (from === '需求已评审' && to === '开发中') {
      requiredFields.push('technical_design');
      reviews.push('technical_stability');
    }
    if (from === '开发中' && to === '开发转测试') {
      requiredFields.push('self_test_report');
      reviews.push('delivery_readiness');
    }
  } else {
    if (to === '已解决') requiredFields.push('defectCause');
    if (to === '已验证') {
      requiredFields.push('testers');
      assigneeRole = 'testers';
    }
    if (['重新打开', '已拒绝'].includes(to))
      requiredFields.push('latestProgress');
  }
  return {
    from,
    to,
    requiredFields,
    reviews,
    assigneeRole,
    releaseChecks:
      kind === 'requirement' && ['待发布', '已发布'].includes(to)
        ? (Object.keys(WORKFLOW_RELEASE_LABELS) as WorkflowReleaseCheck[])
        : [],
  };
}

export function defaultIterationConfiguration(
  milestones: IterationMilestone[] = [],
): IterationConfiguration {
  const normal = [...ITERATION_STATUS_CATALOG.requirement];
  const defects: Record<string, string[]> = {
    新建: ['处理中', '已拒绝'],
    处理中: ['已解决', '已拒绝'],
    已解决: ['已验证', '重新打开'],
    已验证: ['已关闭', '重新打开'],
    重新打开: ['处理中'],
    已拒绝: ['重新打开'],
    已关闭: ['重新打开'],
  };
  return {
    version: 1,
    milestones,
    workflows: {
      requirement: {
        statuses: normal,
        transitions: normal.flatMap((from, i) =>
          normal
            .filter((_, j) => Math.abs(i - j) === 1)
            .map((to) => defaultIterationTransition(from, to, 'requirement')),
        ),
      },
      defect: {
        statuses: [...ITERATION_STATUS_CATALOG.defect],
        transitions: Object.entries(defects).flatMap(([from, targets]) =>
          targets.map((to) => defaultIterationTransition(from, to, 'defect')),
        ),
      },
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const owns = (v: object, key: string) =>
  Object.prototype.hasOwnProperty.call(v, key);
const stringList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.every((x) => typeof x === 'string') &&
  new Set(v).size === v.length;
/** Runtime validation shared by HTTP, storage, editor and tests. Reject rather than coerce. */
export function iterationConfigurationErrors(value: unknown): string[] {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isObject(value.workflows) ||
    !Array.isArray(value.milestones)
  )
    return ['迭代配置格式无效'];
  const errors: string[] = [];
  for (const kind of ['requirement', 'defect'] as const) {
    const flow = value.workflows[kind];
    const label = kind === 'defect' ? '缺陷' : '需求';
    if (
      !isObject(flow) ||
      !stringList(flow.statuses) ||
      !Array.isArray(flow.transitions) ||
      flow.transitions.length > 100
    ) {
      errors.push(`${label}流程格式无效`);
      continue;
    }
    const statuses = flow.statuses;
    const catalog: readonly string[] = ITERATION_STATUS_CATALOG[kind];
    const first = catalog[0],
      last = kind === 'defect' ? '已关闭' : '已发布';
    if (statuses[0] !== first || !statuses.includes(last))
      errors.push(`${label}必须保留初始状态“${first}”和完成状态“${last}”`);
    if (statuses.some((x) => !catalog.includes(x)))
      errors.push(`${label}包含不支持的状态`);
    const edges = new Set<string>();
    const graph = new Map<string, string[]>();
    for (const edge of flow.transitions) {
      if (
        !isObject(edge) ||
        typeof edge.from !== 'string' ||
        typeof edge.to !== 'string' ||
        !statuses.includes(edge.from) ||
        !statuses.includes(edge.to) ||
        edge.from === edge.to
      ) {
        errors.push(`${label}包含无效流转`);
        continue;
      }
      const key = `${edge.from}→${edge.to}`;
      if (edges.has(key)) errors.push(`重复流转：${key}`);
      edges.add(key);
      graph.set(edge.from, [...(graph.get(edge.from) || []), edge.to]);
      if (
        !stringList(edge.requiredFields) ||
        !edge.requiredFields.includes('handlers') ||
        edge.requiredFields.some((x) => !owns(WORKFLOW_FIELD_LABELS, x))
      )
        errors.push(`${key}的必填字段无效，每次流转必须有处理人`);
      if (
        !stringList(edge.reviews) ||
        edge.reviews.some((x) => !owns(WORKFLOW_REVIEW_LABELS, x)) ||
        (kind === 'defect' && edge.reviews.length > 0)
      )
        errors.push(`${key}的 AI 评审设置无效（缺陷不启用评审）`);
      if (
        !stringList(edge.releaseChecks) ||
        edge.releaseChecks.some((x) => !owns(WORKFLOW_RELEASE_LABELS, x)) ||
        (edge.releaseChecks.length > 0 &&
          !['待发布', '已发布'].includes(edge.to))
      )
        errors.push(`${key}的发布检查设置无效`);
      if (
        ![
          'handlers',
          'developers',
          'testers',
          'productOwners',
          'releaseOwners',
        ].includes(String(edge.assigneeRole))
      )
        errors.push(`${key}的处理人预填角色无效`);
      if (Array.isArray(edge.reviews) && Array.isArray(edge.requiredFields)) {
        const needs: Record<string, string[]> = {
          clarity: ['introduction', 'acceptanceCriteria'],
          technical_stability: ['technical_design'],
          delivery_readiness: ['self_test_report'],
        };
        for (const review of edge.reviews)
          if (
            owns(needs, String(review)) &&
            needs[String(review)].some(
              (field) => !(edge.requiredFields as unknown[]).includes(field),
            )
          )
            errors.push(`${key}启用评审时必须同时要求对应资料`);
      }
    }
    const reachable = (start: string) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length)
        for (const next of graph.get(queue.shift()!) || [])
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
      return seen;
    };
    if (statuses.some((x) => !reachable(first).has(x)))
      errors.push(`${label}存在从初始状态无法到达的状态`);
    if (statuses.some((x) => !reachable(x).has(last)))
      errors.push(`${label}存在无法流转到完成的状态`);
  }
  const ids = new Set<string>();
  if (value.milestones.length > 30) errors.push('里程碑最多 30 项');
  for (const m of value.milestones) {
    if (
      !isObject(m) ||
      typeof m.id !== 'string' ||
      !m.id.trim() ||
      m.id.length > 100 ||
      ids.has(m.id) ||
      typeof m.name !== 'string' ||
      !m.name.trim() ||
      m.name.length > 80 ||
      (m.dueAt !== null &&
        (typeof m.dueAt !== 'string' || !Number.isFinite(Date.parse(m.dueAt))))
    )
      errors.push('里程碑名称、时间或标识无效');
    if (isObject(m) && typeof m.id === 'string') ids.add(m.id);
  }
  if (!errors.length)
    errors.push(
      ...iterationAnalysisErrors(
        value.analysis,
        value as unknown as IterationConfiguration,
      ),
    );
  return [...new Set(errors)];
}
