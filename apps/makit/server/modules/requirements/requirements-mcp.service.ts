import { BadRequestException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { personalRequirementTodos } from './requirement-personal-todos';
import type {
  CurrentUserSummary,
  MutationResult,
  PullRequestDetailResponse,
  PullRequestSummary,
  RequirementAiReviewType,
  RequirementPatch,
  RequirementUpdateInput,
  RequirementReleaseReadiness,
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import { PullRequestsService } from '../pull-requests/pull-requests.service';
import { pullRequestPlatformUrl } from './requirement-links';
import type { VerifiedMcpUser } from './mcp-auth.types';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementUpdateJobsService } from './requirement-update-jobs.service';
import { mcpMutationHash } from './requirement-operation.model';
import { prepareOperationInput } from '../../../shared/requirement-operation';
import { RequirementReleaseReadinessService } from './requirement-release-readiness.service';
import {
  RequirementAiReviewService,
  type RequirementAiReviewTriggerResult,
} from './requirement-ai-review.service';

const selectorSchema = z.object({
  requirement: z.string().min(1).describe('需求记录 ID、需求编号或完整标题'),
});

const mutationKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{8,128}$/u)
  .optional()
  .describe(
    '建议每次新修改生成唯一键；同一次请求重试必须复用此键和原参数。返回 jobId 后查询最终结果，unknown 不得重放。',
  );

type McpResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

function result(data: Record<string, unknown>): McpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}



@Injectable()
export class RequirementsMcpService {
  constructor(
    private readonly queryService: RequirementsQueryService,
    private readonly commandService: RequirementsCommandService,
    private readonly pullRequestsService: PullRequestsService,
    private readonly releaseReadiness: RequirementReleaseReadinessService,
    private readonly aiReviewService: RequirementAiReviewService,
    private readonly updateJobsService: RequirementUpdateJobsService,
  ) {}

  createServer(currentUser: VerifiedMcpUser): McpServer {
    const server = new McpServer({
      name: '110-requirement-collaboration',
      version: '1.0.0',
    });
    server.registerTool(
      'requirement_operation_get',
      {
        title: '查询需求修改结果',
        description:
          '根据修改返回的jobId查询最终结果。已接受不代表已落地；unknown时不得盲目重试或重复通知。',
        inputSchema: z.object({ operationId: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ operationId }) =>
        result({
          operation: await this.updateJobsService.getAs(
            operationId,
            currentUser,
          ),
        }),
    );

    server.registerTool(
      'my_requirement_todos',
      {
        title: '读取我的需求待办',
        description:
          '与工作台待我推进一致：当前处理人包含已认证用户，排除已发布、已关闭及已解决工单。只读，返回紧凑列表和分页游标；restartRequired 时从第一页重新读取。',
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(100),
          cursor: z.string().max(80).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (input) =>
        result(
          personalRequirementTodos(
            await this.workspace(currentUser, false),
            input,
          ),
        ),
    );

    server.registerTool(
      'requirements_list',
      {
        title: '查询需求列表',
        description:
          '按标题、编号、状态、项目或迭代筛选需求，返回后续工具需要的记录 ID。',
        inputSchema: z.object({
          query: z.string().optional().describe('标题或需求编号关键词'),
          status: z.string().optional(),
          project: z.string().optional(),
          iteration: z.string().optional().describe('迭代名称或记录 ID'),
          limit: z.number().int().min(1).max(100).default(30),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, status, project, iteration, limit }) => {
        const workspace = await this.workspace(currentUser, false);
        const keyword = (query || '').trim().toLowerCase();
        const requirements = workspace.requirements
          .filter((item) => {
            if (
              keyword &&
              !`${item.code} ${item.title}`.toLowerCase().includes(keyword)
            )
              return false;
            if (status && item.status !== status) return false;
            if (project && item.project !== project) return false;
            if (
              iteration &&
              !item.iterationIds.includes(iteration) &&
              !item.iterationNames.includes(iteration)
            )
              return false;
            return true;
          })
          .slice(0, limit)
          .map((item) => this.serializeRequirement(item));
        return result({ count: requirements.length, requirements });
      },
    );

    server.registerTool(
      'requirement_release_readiness',
      {
        title: '检查需求发布就绪状态',
        description:
          '只读检查需求进入待发布或已发布前的验收项、自测、人员、Git 分支、合并请求、检查与评审门禁。',
        inputSchema: selectorSchema.extend({
          targetStatus: z.enum(['待发布', '已发布']).default('待发布'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ requirement, targetStatus }) => {
        const current = await this.findRequirement(
          requirement,
          currentUser,
          false,
        );
        const readiness: RequirementReleaseReadiness =
          await this.releaseReadiness.evaluate(current, targetStatus);
        return result({ readiness });
      },
    );

    server.registerTool(
      'requirement_get',
      {
        title: '读取需求',
        description: '按记录 ID、需求编号或完整标题读取需求全部结构化字段。',
        inputSchema: selectorSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ requirement }) => {
        const found = await this.findRequirement(
          requirement,
          currentUser,
          false,
        );
        return result({ requirement: this.serializeRequirement(found) });
      },
    );

    server.registerTool(
      'requirement_trigger_review',
      {
        title: '触发需求 AI 评审',
        description:
          '手动触发或重新触发一项需求的指定 AI 评审。需求清晰度依赖需求介绍和验收标准；技术与交付评审依赖对应研发资料。',
        inputSchema: selectorSchema.extend({
          reviewType: z.enum([
            'clarity',
            'technical_stability',
            'delivery_readiness',
          ]),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ requirement, reviewType }) => {
        const current = await this.findRequirement(
          requirement,
          currentUser,
          true,
        );
        const workspace = await this.aiReviewService.retry(
          current.id,
          reviewType as RequirementAiReviewType,
          this.reviewIdentity(currentUser),
        );
        return result({
          requirement: this.serializeRequirement(current),
          review: workspace.reviews[reviewType],
        });
      },
    );

    server.registerTool(
      'iteration_trigger_available_reviews',
      {
        title: '按迭代补跑需求 AI 评审',
        description:
          '对指定迭代的全部非缺陷需求补跑当前资料可支持的评审；资料不足的评审会跳过并返回原因，不会发送飞书通知。',
        inputSchema: z.object({
          iteration: z.string().min(1).describe('迭代名称或记录 ID'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ iteration }) => {
        const workspace = await this.workspace(currentUser, true);
        const normalized = iteration.trim();
        const matches = workspace.iterations.filter(
          (item) => item.id === normalized || item.name === normalized,
        );
        if (!matches.length) {
          throw new BadRequestException(`未找到迭代：${iteration}`);
        }
        if (matches.length > 1) {
          throw new BadRequestException(
            `迭代名称不唯一，请使用记录 ID：${iteration}`,
          );
        }
        const target = matches[0];
        const requirements = workspace.requirements.filter((item) =>
          item.iterationIds.includes(target.id),
        );
        const items: Array<
          RequirementAiReviewTriggerResult & {
            code: string;
            title: string;
          }
        > = [];
        for (const requirement of requirements) {
          const trigger = await this.aiReviewService.triggerAvailable(
            requirement,
            currentUser,
          );
          items.push({
            ...trigger,
            code: requirement.code,
            title: requirement.title,
          });
        }
        return result({
          iteration: { id: target.id, name: target.name },
          requirementCount: requirements.length,
          triggeredCount: items.reduce(
            (total, item) => total + item.triggered.length,
            0,
          ),
          items,
        });
      },
    );

    server.registerTool(
      'requirement_update_fields',
      {
        title: '修改需求字段',
        description:
          '修改需求的基础字段、开发工作量、介绍、验收标准、进展或阻塞信息；只提交明确提供的字段。',
        inputSchema: selectorSchema.extend({
          clientMutationId: mutationKeySchema,
          title: z.string().min(1).optional(),
          introduction: z.string().optional(),
          acceptanceCriteria: z.string().optional(),
          selfTestReport: z.string().optional(),
          defectCause: z.string().optional(),
          gitBranchName: z.string().optional(),
          githubPullRequestUrl: z.string().url().optional(),
          type: z.string().optional(),
          source: z.string().optional(),
          priority: z.string().optional(),
          project: z.string().optional(),
          iterationIds: z
            .array(z.string().min(1))
            .max(1)
            .describe(
              '所属迭代，最多一个 ID；空数组表示清空，不得同时关联多个迭代',
            )
            .optional(),
          effort: z.number().nonnegative().nullable().optional().describe('开发工作量，单位为自然日，可填写小数；null 表示未设置'),
          latestProgress: z.string().optional(),
          blocked: z.boolean().optional(),
          blocker: z.string().optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const hash = mcpMutationHash('requirement_update_fields', input);
        const replay = await this.updateJobsService.replayMcpAs(
          input.clientMutationId,
          hash,
          currentUser,
        );
        if (replay) return result({ mutation: replay });
        const current = await this.findRequirement(
          input.requirement,
          currentUser,
          true,
        );
        const patch: RequirementPatch = {};
        const scalarKeys: Array<keyof RequirementPatch> = [
          'title',
          'introduction',
          'acceptanceCriteria',
          'selfTestReport',
          'defectCause',
          'gitBranchName',
          'githubPullRequestUrl',
          'type',
          'source',
          'priority',
          'project',
          'iterationIds',
          'effort',
          'latestProgress',
          'blocked',
          'blocker',
        ];
        scalarKeys.forEach((key) => {
          if (input[key] !== undefined) {
            (patch as Record<string, unknown>)[key] = input[key];
          }
        });
        const mutation = await this.update(
          current,
          patch,
          'edit',
          currentUser,
          input.clientMutationId,
          hash,
        );
        return result({ mutation });
      },
    );

    server.registerTool(
      'requirement_update_personnel',
      {
        title: '修改需求人员',
        description:
          '支持按角色 add 增加、remove 移除或 replace 调整为目标名单。userIds 使用飞书 user_id；replace 空数组移除读取时的成员，但保留其后的并发新增。优先使用明确增删。同次重试须复用 clientMutationId。',
        inputSchema: selectorSchema.extend({
          clientMutationId: mutationKeySchema,
          mode: z.enum(['replace', 'add', 'remove']).default('replace'),
          role: z.enum([
            'handlers',
            'productOwners',
            'developers',
            'testers',
            'foOwners',
            'releaseOwners',
            'proposers',
            'followers',
          ]),
          userIds: z.array(z.string()).describe('飞书 user_id 列表'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const { requirement, role, userIds, mode, clientMutationId } = input;
        const hash = mcpMutationHash('requirement_update_personnel', input);
        const replay = await this.updateJobsService.replayMcpAs(
          clientMutationId,
          hash,
          currentUser,
        );
        if (replay) return result({ mutation: replay });
        const current = await this.findRequirement(
          requirement,
          currentUser,
          true,
        );
        const patchKeys = {
          handlers: 'handlerLarkUserIds',
          productOwners: 'productOwnerLarkUserIds',
          developers: 'developerLarkUserIds',
          testers: 'testerLarkUserIds',
          foOwners: 'foOwnerLarkUserIds',
          releaseOwners: 'releaseOwnerLarkUserIds',
          proposers: 'proposerLarkUserIds',
          followers: 'followerLarkUserIds',
        } as const;
        const patch = { [patchKeys[role]]: userIds } as RequirementPatch;
        const personnelChanges: RequirementUpdateInput['personnelChanges'] =
          mode === 'replace'
            ? undefined
            : {
                [role]: {
                  identityType: 'feishu',
                  add: mode === 'add' ? userIds : [],
                  remove: mode === 'remove' ? userIds : [],
                },
              };
        const mutation = await this.update(
          current,
          patch,
          'edit',
          currentUser,
          clientMutationId,
          hash,
          personnelChanges,
        );
        return result({ mutation });
      },
    );

    server.registerTool(
      'requirement_transition_status',
      {
        title: '流转需求状态',
        description: '按需求工作流流转状态，并执行处理人、角色与交付物校验。',
        inputSchema: selectorSchema.extend({
          clientMutationId: mutationKeySchema,
          status: z.string().min(1),
          handlerUserIds: z.array(z.string()).optional(),
          selfTestReport: z.string().optional(),
          defectCause: z.string().optional(),
          githubPullRequestUrl: z.string().url().optional(),
          latestProgress: z.string().optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const hash = mcpMutationHash('requirement_transition_status', input);
        const replay = await this.updateJobsService.replayMcpAs(
          input.clientMutationId,
          hash,
          currentUser,
        );
        if (replay) return result({ mutation: replay });
        const {
          requirement,
          status,
          handlerUserIds,
          selfTestReport,
          defectCause,
          githubPullRequestUrl,
          latestProgress,
        } = input;
        const current = await this.findRequirement(
          requirement,
          currentUser,
          true,
        );
        const patch: RequirementPatch = { status };
        if (handlerUserIds !== undefined)
          patch.handlerLarkUserIds = handlerUserIds;
        if (selfTestReport !== undefined) patch.selfTestReport = selfTestReport;
        if (defectCause !== undefined) patch.defectCause = defectCause;
        if (githubPullRequestUrl !== undefined) {
          patch.githubPullRequestUrl = githubPullRequestUrl;
        }
        if (latestProgress !== undefined) patch.latestProgress = latestProgress;
        const mutation = await this.update(
          current,
          patch,
          'status-transition',
          currentUser,
          input.clientMutationId,
          hash,
        );
        return result({ mutation });
      },
    );

    server.registerTool(
      'pull_requests_list',
      {
        title: '查询合并请求列表',
        description:
          '查询当前仓库的 GitHub 合并请求、关联需求和迭代、检查状态及 GitHub 待评审人。',
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe('PR 编号、标题、分支或关联需求编号关键词'),
          state: z.enum(['OPEN', 'MERGED', 'CLOSED']).optional(),
          iteration: z.string().optional().describe('迭代名称或记录 ID'),
          reviewerLogin: z
            .string()
            .optional()
            .describe('GitHub 待评审人的 login'),
          limit: z.number().int().min(1).max(100).default(30),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, state, iteration, reviewerLogin, limit }) => {
        const workspace = await this.pullRequestsService.workspace(
          this.pullRequestIdentity(currentUser),
          false,
        );
        const keyword: string = (query || '').trim().toLowerCase();
        const pullRequests: Record<string, unknown>[] = workspace.pullRequests
          .filter((item: PullRequestSummary): boolean => {
            if (state && item.state !== state) return false;
            if (
              iteration &&
              !item.linkedIterationIds.includes(iteration) &&
              !item.linkedIterationNames.includes(iteration)
            )
              return false;
            if (
              reviewerLogin &&
              !item.requestedReviewers.some(
                (reviewer): boolean =>
                  reviewer.login.toLowerCase() === reviewerLogin.toLowerCase(),
              )
            )
              return false;
            if (!keyword) return true;
            const searchText: string = [
              item.number,
              item.title,
              item.headRef,
              item.baseRef,
              ...item.linkedRequirements.flatMap((linked) => [
                linked.code,
                linked.title,
              ]),
            ]
              .join(' ')
              .toLowerCase();
            return searchText.includes(keyword);
          })
          .slice(0, limit)
          .map(
            (item: PullRequestSummary): Record<string, unknown> =>
              this.serializePullRequest(item),
          );
        return result({
          repository: workspace.repository,
          syncedAt: workspace.syncedAt,
          stale: workspace.stale,
          reviewerCandidates: workspace.reviewerCandidates,
          count: pullRequests.length,
          pullRequests,
        });
      },
    );

    server.registerTool(
      'pull_request_get',
      {
        title: '读取合并请求详情',
        description:
          '读取一个合并请求的 GitHub 评论、评审、行内讨论、检查结果、关联需求和 GitHub 待评审人。',
        inputSchema: z.object({
          pullNumber: z.number().int().positive().describe('GitHub PR 编号'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ pullNumber }) => {
        const detail: PullRequestDetailResponse =
          await this.pullRequestsService.detail(
            pullNumber,
            this.pullRequestIdentity(currentUser),
          );
        return result({
          pullRequest: this.serializePullRequest(detail.pullRequest),
          reviewerCandidates: detail.reviewerCandidates,
          completeness: detail.completeness,
          comments: detail.comments,
          reviews: detail.reviews,
          reviewThreads: detail.reviewThreads,
          checks: detail.checks,
          reviewerNotifications: detail.reviewerNotifications,
        });
      },
    );

    server.registerTool(
      'pull_request_set_reviewers',
      {
        title: '设置 GitHub 评审人',
        description:
          '完整替换 GitHub 合并请求的待评审人。使用拥有仓库写权限的 GitHub login；首次使用某账号时通过 reviewerBindings 绑定飞书 user_id。新增评审人会收到 GitHub 原生通知和周催办飞书私聊。传空数组表示清空。',
        inputSchema: z.object({
          pullNumber: z.number().int().positive().describe('GitHub PR 编号'),
          reviewerLogins: z
            .array(z.string().min(1))
            .max(100)
            .describe('GitHub login 列表'),
          reviewerBindings: z
            .array(
              z.object({
                login: z.string().min(1).describe('GitHub login'),
                feishuEmployeeId: z
                  .string()
                  .min(1)
                  .describe('对应飞书成员的 user_id'),
              }),
            )
            .optional()
            .describe('首次绑定或修改映射时提供；已绑定账号可省略'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ pullNumber, reviewerLogins, reviewerBindings }) => {
        const mutation = await this.pullRequestsService.updateReviewers(
          pullNumber,
          reviewerLogins,
          this.pullRequestIdentity(currentUser),
          reviewerBindings || [],
          currentUser.mcpWriteProof,
        );
        return result({ mutation });
      },
    );

    server.registerTool(
      'pull_requests_refresh',
      {
        title: '刷新合并请求',
        description: '立即从 GitHub 刷新当前仓库的合并请求缓存。',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        return result({
          mutation: await this.pullRequestsService.refresh(
            this.pullRequestIdentity(currentUser),
          ),
        });
      },
    );

    return server;
  }

  private pullRequestIdentity(currentUser: VerifiedMcpUser): {
    userId: string;
    userName: string;
    roles: string[];
    employeeId: string;
    openId: string;
    mcpWriteProof: VerifiedMcpUser['mcpWriteProof'];
  } {
    return {
      userId: currentUser.miaodaUserId,
      userName: currentUser.name,
      roles: currentUser.roles || [],
      employeeId: currentUser.employeeId,
      openId: currentUser.openId,
      mcpWriteProof: currentUser.mcpWriteProof,
    };
  }

  private reviewIdentity(currentUser: VerifiedMcpUser): {
    userId: string;
    userName: string;
    roles: string[];
    appId: string;
  } {
    return {
      userId: currentUser.miaodaUserId,
      userName: currentUser.name,
      roles: currentUser.roles || [],
      appId: currentUser.platformAppId || '',
    };
  }

  private serializePullRequest(
    item: PullRequestSummary,
  ): Record<string, unknown> {
    return {
      repository: item.repository,
      number: item.number,
      title: item.title,
      state: item.state,
      draft: item.draft,
      platformUrl: pullRequestPlatformUrl(item.number),
      githubUrl: item.url,
      author: item.author,
      headRef: item.headRef,
      baseRef: item.baseRef,
      mergeable: item.mergeable,
      reviewDecision: item.reviewDecision,
      checksStatus: item.checksStatus,
      changedFiles: item.changedFiles,
      additions: item.additions,
      deletions: item.deletions,
      commitCount: item.commitCount,
      commentCount: item.commentCount,
      reviewCount: item.reviewCount,
      reviewThreadCount: item.reviewThreadCount,
      linkedRequirements: item.linkedRequirements,
      linkedIterationIds: item.linkedIterationIds,
      linkedIterationNames: item.linkedIterationNames,
      requestedReviewers: item.requestedReviewers,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      syncedAt: item.syncedAt,
    };
  }

  private async workspace(
    currentUser: CurrentUserSummary,
    forceRefresh: boolean,
  ): Promise<WorkspaceResponse> {
    return this.queryService.workspaceAs(currentUser, forceRefresh);
  }

  private async findRequirement(
    selector: string,
    currentUser: CurrentUserSummary,
    forceRefresh: boolean,
  ): Promise<RequirementSummary> {
    const workspace = await this.workspace(currentUser, forceRefresh);
    const normalized = selector.trim();
    // Stable identifiers take precedence even if another record's title happens
    // to equal the identifier. Never use list order to resolve a duplicate title.
    const byId = workspace.requirements.find((item) => item.id === normalized);
    const byCode = workspace.requirements.filter(
      (item) => item.code === normalized,
    );
    const byTitle = workspace.requirements.filter(
      (item) => item.title === normalized,
    );
    const matches = byId ? [byId] : byCode.length ? byCode : byTitle;
    if (matches.length === 0) {
      throw new BadRequestException(`未找到需求：${selector}`);
    }
    if (matches.length > 1) {
      const candidates = matches
        .slice(0, 10)
        .map(({ id, code, title }) => ({ id, code, title }));
      throw new BadRequestException({
        code: 'ambiguous_requirement',
        // The MCP SDK forwards Error.message rather than the HTTP response body.
        // Include bounded candidates there so a caller can select a stable ID.
        message: `匹配到多个需求，请使用唯一记录 ID 或需求编号。候选：${JSON.stringify(candidates)}${matches.length > 10 ? '（仅显示前10条，请查询列表缩小范围）' : ''}`,
        candidates,
        totalMatches: matches.length,
      });
    }
    const requirement = matches[0];
    const personnel = await this.queryService.requirementPersonnel(
      requirement.id,
    );
    return {
      ...requirement,
      personnelUserIds: personnel.personnelUserIds,
    };
  }

  private async update(
    current: RequirementSummary,
    patch: RequirementPatch,
    intent: 'edit' | 'status-transition',
    currentUser: CurrentUserSummary,
    clientMutationId?: string,
    mcpHash?: string,
    personnelChanges?: RequirementUpdateInput['personnelChanges'],
  ): Promise<MutationResult> {
    return this.updateJobsService.enqueueAs(
      current.id,
      prepareOperationInput(current, {
        expectedUpdatedAt: current.updatedAt,
        intent,
        patch,
        source: 'mcp',
        clientMutationId,
        personnelChanges,
      }),
      currentUser,
      mcpHash,
    );
  }

  private serializeRequirement(
    item: RequirementSummary,
  ): Record<string, unknown> {
    return {
      id: item.id,
      code: item.code,
      title: item.title,
      url: item.url,
      type: item.type,
      source: item.source,
      status: item.status,
      allowedStatuses: item.allowedStatuses,
      workflow: item.workflow || null,
      priority: item.priority,
      project: item.project,
      iterationIds: item.iterationIds,
      iterationNames: item.iterationNames,
      gitBranchName: item.gitBranchName,
      githubPullRequestUrl: item.githubPullRequestUrl,
      introduction: item.introduction,
      acceptanceCriteria: item.acceptanceCriteria,
      selfTestReport: item.selfTestReport,
      defectCause: item.defectCause,
      handlers: item.handlers,
      productOwners: item.productOwners,
      developers: item.developers,
      testers: item.testers,
      foOwners: item.foOwners,
      releaseOwners: item.releaseOwners,
      proposers: item.proposers,
      followers: item.followers,
      personnelUserIds: item.personnelUserIds,
      startAt: item.startAt,
      developmentStartAt: item.developmentStartAt,
      developmentEndAt: item.developmentEndAt,
      testingAt: item.testingAt,
      deadlineAt: item.deadlineAt,
      effort: item.effort,
      latestProgress: item.latestProgress,
      blocked: item.blocked,
      blocker: item.blocker,
      updatedAt: item.updatedAt,
      updatedByName: item.updatedByName,
    };
  }
}
