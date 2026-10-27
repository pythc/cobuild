import {
  isTicketType,
  ticketPatchError,
  ticketGroupName,
} from '../../../shared/ticket-workflow';
import type { BaseRecord } from './feishu.service';
import { WORKFLOW_FIELD_LABELS } from '../../../shared/iteration-workflow';
import { mergeOperationPatch } from '../../../shared/requirement-operation';
import { isOnlyMaterialTemplate } from '../../../shared/material-templates';
import type { RequirementWriteHooks } from './requirement-operation.types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthNPaasService } from '@lark-apaas/fullstack-nestjs-core';
import type {
  AcceptanceCreateInput,
  AcceptanceUpdateInput,
  BulkMutationResult,
  BulkRequirementUpdateInput,
  CommentCreateInput,
  CurrentUserSummary,
  GroupAction,
  MutationResult,
  OperationStage,
  RelationCreateInput,
  RequirementCreateInput,
  RequirementEditContext,
  RequirementPatch,
  RequirementSummary,
  RequirementUpdateInput,
  WorkspaceOptions,
  WorkspaceResponse,
} from '@shared/api.interface';
import { FeishuService, FeishuRequestError } from './feishu.service';
import { iterationAssignmentError } from '../../../shared/iteration-assignment';
import {
  hasMeaningfulText,
  isStatusOnlyRequirementPatch,
  isDefectType,
  textValue,
  linkedIds,
  pruneRequirementPatch,
  requirementUuid,
  resolveRequirementUpdateConflict,
  allowedStatuses,
  workflowStatuses,
  uniquePeople,
  uniqueStrings,
} from './requirements.model';
import type { RequirementUpdateConflictResolution } from './requirements.model';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementAccessService } from './requirement-access.service';
import { RequirementArchiveService } from './requirement-archive.service';
import { RequirementReleaseReadinessService } from './requirement-release-readiness.service';
import { RequirementAiReviewService } from './requirement-ai-review.service';

interface RequestIdentity {
  userId: string;
  userName: string;
  roles?: string[];
  appId?: string;
}

interface UserPatchDefinition {
  key:
    | 'handlerUserIds'
    | 'productOwnerUserIds'
    | 'developerUserIds'
    | 'testerUserIds'
    | 'foOwnerUserIds'
    | 'proposerUserIds'
    | 'followerUserIds'
    | 'releaseOwnerUserIds';
  field: string;
}

const USER_PATCHES: UserPatchDefinition[] = [
  { key: 'handlerUserIds', field: '当前处理人' },
  { key: 'productOwnerUserIds', field: '产品人员' },
  { key: 'developerUserIds', field: '研发人员' },
  { key: 'testerUserIds', field: '测试人员' },
  { key: 'foOwnerUserIds', field: 'FO' },
  { key: 'proposerUserIds', field: '提出人' },
  { key: 'followerUserIds', field: '关注人' },
  { key: 'releaseOwnerUserIds', field: '发布负责人' },
];

interface LarkUserPatchDefinition {
  key:
    | 'handlerLarkUserIds'
    | 'productOwnerLarkUserIds'
    | 'developerLarkUserIds'
    | 'testerLarkUserIds'
    | 'foOwnerLarkUserIds'
    | 'proposerLarkUserIds'
    | 'followerLarkUserIds'
    | 'releaseOwnerLarkUserIds';
  field: string;
}

const LARK_USER_PATCHES: LarkUserPatchDefinition[] = [
  { key: 'handlerLarkUserIds', field: '当前处理人' },
  { key: 'productOwnerLarkUserIds', field: '产品人员' },
  { key: 'developerLarkUserIds', field: '研发人员' },
  { key: 'testerLarkUserIds', field: '测试人员' },
  { key: 'foOwnerLarkUserIds', field: 'FO' },
  { key: 'proposerLarkUserIds', field: '提出人' },
  { key: 'followerLarkUserIds', field: '关注人' },
  { key: 'releaseOwnerLarkUserIds', field: '发布负责人' },
];

const MAX_TEXT_LENGTH: number = 50_000;
const CONFIGURED_PERSONNEL = {
  handlers: {
    miaoda: 'handlerUserIds',
    lark: 'handlerLarkUserIds',
    current: 'handlers',
  },
  developers: {
    miaoda: 'developerUserIds',
    lark: 'developerLarkUserIds',
    current: 'developers',
  },
  testers: {
    miaoda: 'testerUserIds',
    lark: 'testerLarkUserIds',
    current: 'testers',
  },
  productOwners: {
    miaoda: 'productOwnerUserIds',
    lark: 'productOwnerLarkUserIds',
    current: 'productOwners',
  },
  releaseOwners: {
    miaoda: 'releaseOwnerUserIds',
    lark: 'releaseOwnerLarkUserIds',
    current: 'releaseOwners',
  },
} as const;
const RELATION_TYPES: string[] = ['依赖', '被依赖', '相关', '重复'];

@Injectable()
export class RequirementsCommandService {
  private readonly logger: Logger = new Logger(RequirementsCommandService.name);

  constructor(
    private readonly feishu: FeishuService,
    private readonly query: RequirementsQueryService,
    private readonly authnService: AuthNPaasService,
    private readonly access: RequirementAccessService,
    private readonly archive: RequirementArchiveService,
    private readonly releaseReadiness: RequirementReleaseReadinessService,
    private readonly aiReviews: RequirementAiReviewService,
  ) {}

  private actor(currentUser: CurrentUserSummary): CurrentUserSummary {
    return currentUser;
  }

  private validateText(value: string, label: string): string {
    const normalized: string = value.trim();
    if (normalized.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `${label}不能超过 ${MAX_TEXT_LENGTH} 个字符`,
      );
    }
    return normalized;
  }

  private validateDate(value: number | null, label: string): number | null {
    if (value === null) return null;
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(`${label}格式不正确`);
    }
    return value;
  }

  private validateOption(
    value: string,
    options: string[],
    label: string,
  ): void {
    if (value && !options.includes(value)) {
      throw new BadRequestException(`${label}“${value}”不是有效选项`);
    }
  }

  private validateTransition(
    type: string,
    current: string,
    next: string,
  ): void {
    if (!workflowStatuses(type).includes(next)) {
      throw new BadRequestException(
        isDefectType(type)
          ? `“${next}”不属于缺陷处理流程`
          : `“${next}”不属于需求研发流程`,
      );
    }
    if (!allowedStatuses(current, type).includes(next)) {
      throw new BadRequestException(
        `状态不能从“${current}”直接流转到“${next}”`,
      );
    }
  }

  private assertSingleIteration(value: unknown): void {
    const message = iterationAssignmentError(value);
    if (message) throw new BadRequestException(message);
  }

  private personnelCount(
    patch: RequirementPatch,
    current: RequirementSummary,
    keys: {
      miaoda: keyof RequirementPatch;
      lark: keyof RequirementPatch;
      current: keyof Pick<
        RequirementSummary,
        | 'handlers'
        | 'productOwners'
        | 'developers'
        | 'testers'
        | 'releaseOwners'
      >;
    },
  ): number {
    const larkValue: unknown = patch[keys.lark];
    if (Array.isArray(larkValue)) return larkValue.length;
    const miaodaValue: unknown = patch[keys.miaoda];
    if (Array.isArray(miaodaValue)) return miaodaValue.length;
    return current[keys.current].length;
  }

  private async validateTransitionRequirements(
    patch: RequirementPatch,
    current: RequirementSummary,
  ): Promise<void> {
    if (!patch.status || patch.status === current.status) return;
    if (isTicketType(patch.type ?? current.type)) return;
    if (current.workflow) {
      const edge = current.workflow.transitions.find(
        (item) => item.from === current.status && item.to === patch.status,
      );
      if (!edge) throw new BadRequestException('当前迭代未允许此状态流转');
      for (const field of edge.requiredFields) {
        if (field === 'technical_design' || field === 'self_test_report') {
          await this.aiReviews.assertArtifactReady(current, field);
        } else if (field in CONFIGURED_PERSONNEL) {
          const keys =
            CONFIGURED_PERSONNEL[field as keyof typeof CONFIGURED_PERSONNEL];
          if (!this.personnelCount(patch, current, keys))
            throw new BadRequestException(
              `请设置${WORKFLOW_FIELD_LABELS[field]}`,
            );
        } else {
          const key = field as
            | 'introduction'
            | 'acceptanceCriteria'
            | 'githubPullRequestUrl'
            | 'gitBranchName'
            | 'defectCause'
            | 'latestProgress';
          if (!hasMeaningfulText(patch[key] ?? current[key]) ||
            (key === 'defectCause' && isOnlyMaterialTemplate(patch[key] ?? current[key], 'defect_cause')))
            throw new BadRequestException(
              `请填写${WORKFLOW_FIELD_LABELS[field]}`,
            );
        }
      }
      await this.aiReviews.assertTransitionReady(
        {
          ...current,
          title: patch.title ?? current.title,
          introduction: patch.introduction ?? current.introduction,
          acceptanceCriteria:
            patch.acceptanceCriteria ?? current.acceptanceCriteria,
        },
        patch.status,
      );
      return;
    }
    if (
      this.personnelCount(patch, current, {
        miaoda: 'handlerUserIds',
        lark: 'handlerLarkUserIds',
        current: 'handlers',
      }) === 0
    ) {
      throw new BadRequestException('流转状态前必须设置当前处理人');
    }
    const next: string = patch.status;
    const type: string = patch.type || current.type;
    const developerCount: number = this.personnelCount(patch, current, {
      miaoda: 'developerUserIds',
      lark: 'developerLarkUserIds',
      current: 'developers',
    });
    const testerCount: number = this.personnelCount(patch, current, {
      miaoda: 'testerUserIds',
      lark: 'testerLarkUserIds',
      current: 'testers',
    });
    const productCount: number = this.personnelCount(patch, current, {
      miaoda: 'productOwnerUserIds',
      lark: 'productOwnerLarkUserIds',
      current: 'productOwners',
    });
    const releaseCount: number = this.personnelCount(patch, current, {
      miaoda: 'releaseOwnerUserIds',
      lark: 'releaseOwnerLarkUserIds',
      current: 'releaseOwners',
    });
    const defectCause: string =
      patch.defectCause === undefined ? current.defectCause : patch.defectCause;
    const githubPullRequestUrl: string = (
      patch.githubPullRequestUrl === undefined
        ? current.githubPullRequestUrl
        : patch.githubPullRequestUrl
    ).trim();
    if (!isDefectType(type) && next === '需求已评审') {
      if (!hasMeaningfulText(patch.introduction ?? current.introduction)) {
        throw new BadRequestException('完成需求评审前必须填写需求介绍');
      }
      if (
        !hasMeaningfulText(
          patch.acceptanceCriteria ?? current.acceptanceCriteria,
        )
      ) {
        throw new BadRequestException('完成需求评审前必须填写验收标准');
      }
    }
    if (!isDefectType(type) && next === '开发中' && developerCount === 0) {
      throw new BadRequestException('进入开发前必须设置研发人员');
    }
    if (
      (!isDefectType(type) && ['开发转测试', '测试中'].includes(next)) ||
      (isDefectType(type) && next === '已验证')
    ) {
      if (testerCount === 0) {
        throw new BadRequestException('进入测试或验证阶段前必须设置测试人员');
      }
    }
    if (isDefectType(type) && next === '已解决' && (!hasMeaningfulText(defectCause) || isOnlyMaterialTemplate(defectCause, 'defect_cause'))) {
      throw new BadRequestException('流转到“已解决”时必须填写缺陷原因');
    }
    if (!isDefectType(type) && next === '开发转测试' && !githubPullRequestUrl) {
      throw new BadRequestException(
        '开发转测试前必须填写 GitHub 合并请求链接并完成关联',
      );
    }
    if (!isDefectType(type) && next === '产品体验中' && productCount === 0) {
      throw new BadRequestException('进入产品体验前必须设置产品人员');
    }
    if (
      !isDefectType(type) &&
      ['待发布', '已发布'].includes(next) &&
      releaseCount === 0
    ) {
      throw new BadRequestException('进入发布阶段前必须设置发布负责人');
    }
    if (
      ['已拒绝', '重新打开'].includes(next) &&
      !(patch.latestProgress ?? '').trim()
    ) {
      throw new BadRequestException(`流转到“${next}”时必须填写处理说明`);
    }
    if (!isDefectType(type)) {
      await this.aiReviews.assertTransitionReady(current, next);
    }
  }

  private async convertUsers(
    userIds: string[],
  ): Promise<Array<{ id: string }>> {
    const ids: string[] = uniqueStrings(userIds);
    if (!ids.length) return [];
    const converted: Array<string | null> =
      await this.authnService.getBatchLarkUserIds(ids);
    const failed: string[] = ids.filter(
      (_id: string, index: number): boolean => !converted[index],
    );
    if (failed.length) {
      throw new BadRequestException(
        `有 ${failed.length} 位成员未关联飞书账号，人员字段未更新`,
      );
    }
    return converted
      .filter((id: string | null): id is string => Boolean(id))
      .map((id: string): { id: string } => ({ id }));
  }

  private async convertPersonnelPatch(
    patch: RequirementPatch,
  ): Promise<Record<string, unknown>> {
    const entries: Array<Promise<[string, unknown]>> = USER_PATCHES.filter(
      (definition: UserPatchDefinition): boolean =>
        patch[definition.key] !== undefined,
    ).map(
      (definition: UserPatchDefinition): Promise<[string, unknown]> =>
        this.convertUsers(patch[definition.key] || []).then(
          (value: Array<{ id: string }>): [string, unknown] => [
            definition.field,
            value,
          ],
        ),
    );
    const fields: Record<string, unknown> = Object.fromEntries(
      await Promise.all(entries),
    );
    LARK_USER_PATCHES.forEach((definition: LarkUserPatchDefinition): void => {
      const value: string[] | undefined = patch[definition.key];
      if (value === undefined) return;
      fields[definition.field] = uniqueStrings(value).map(
        (id: string): { id: string } => ({ id }),
      );
    });
    return fields;
  }

  private actorFields(
    currentUser: CurrentUserSummary,
  ): Record<string, unknown> {
    if (!currentUser.employeeId) {
      throw new BadRequestException('当前账号未关联飞书员工身份，无法写入');
    }
    return {
      最近操作人: [{ id: currentUser.employeeId }],
      最近操作人名称: currentUser.name,
      最近操作时间: Date.now(),
    };
  }

  private activitySnapshot(
    requirement: RequirementSummary,
    modifiedBy?: CurrentUserSummary,
  ): Record<string, unknown> {
    return {
      code: requirement.code,
      title: requirement.title,
      type: requirement.type,
      source: requirement.source,
      tags: requirement.tags,
      introduction: requirement.introduction,
      acceptanceCriteria: requirement.acceptanceCriteria,
      selfTestReport: requirement.selfTestReport,
      defectCause: requirement.defectCause,
      gitBranchName: requirement.gitBranchName,
      githubPullRequestUrl: requirement.githubPullRequestUrl,
      iterationIds: requirement.iterationIds,
      status: requirement.status,
      priority: requirement.priority,
      project: requirement.project,
      proposers: requirement.proposers,
      handlers: requirement.handlers,
      productOwners: requirement.productOwners,
      developers: requirement.developers,
      testers: requirement.testers,
      foOwners: requirement.foOwners,
      followers: requirement.followers,
      releaseOwners: requirement.releaseOwners,
      startDate: requirement.startAt,
      deadline: requirement.deadlineAt,
      developmentStart: requirement.developmentStartAt,
      developmentEnd: requirement.developmentEndAt,
      testDate: requirement.testingAt,
      actualStart: requirement.actualStartAt,
      actualTest: requirement.actualTestingAt,
      actualRelease: requirement.actualReleaseAt,
      effort: requirement.effort,
      blocked: requirement.blocked,
      blocker: requirement.blocker,
      latestProgress: requirement.latestProgress,
      ...(modifiedBy
        ? {
            modifiedBy: {
              id: modifiedBy.employeeId,
              name: modifiedBy.name,
            },
          }
        : {}),
    };
  }

  private async recordActivity(
    recordId: string,
    before: RequirementSummary,
    after: RequirementSummary,
    actor: CurrentUserSummary,
    labels: string[],
    intent: RequirementUpdateInput['intent'],
    operationId?: string,
    throwOnFailure = false,
  ): Promise<boolean> {
    try {
      await this.feishu.createRecord(
        this.query.table('FEISHU_COLLABORATION_TABLE'),
        {
          需求: [recordId],
          事件类型: intent === 'status-transition' ? '状态流转' : '需求更新',
          状态: '已完成',
          负载摘要: labels.join('、'),
          触发来源: '需求协作平台',
          ...(operationId ? { 事件键: `platform-operation:${operationId}` } : {}),
          变更前: JSON.stringify(this.activitySnapshot(before)),
          变更后: JSON.stringify(this.activitySnapshot(after, actor)),
        },
        'user_id',
      );
      this.query.invalidateDetailSupport?.();
      return true;
    } catch (error) {
      if (throwOnFailure) throw error;
      this.logger.warn(
        `需求 ${recordId} 已更新，但写入变更历史失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async hasConfirmedActivity(operationId: string): Promise<boolean> {
    const rows = await this.feishu.searchRecords(this.query.table('FEISHU_COLLABORATION_TABLE'), {
      conjunction: 'and', conditions: [{ fieldName: '事件键', operator: 'is', value: [`platform-operation:${operationId}`] }],
    }, 'user_id');
    return rows.length > 0;
  }

  async recordConfirmedActivity(before: RequirementSummary, after: RequirementSummary, actor: CurrentUserSummary,
    labels: string[], intent: RequirementUpdateInput['intent'], operationId: string): Promise<void> {
    if (await this.hasConfirmedActivity(operationId)) return;
    await this.recordActivity(after.id, before, after, actor, labels, intent, operationId, true);
  }

  private async patchFields(
    patch: RequirementPatch,
    options: WorkspaceOptions,
    current: RequirementSummary | null,
  ): Promise<{ fields: Record<string, unknown>; labels: string[] }> {
    const ticketError = ticketPatchError(patch, current);
    if (ticketError) throw new BadRequestException(ticketError);
    const fields: Record<string, unknown> = {};
    const labels: string[] = [];
    if (patch.title !== undefined) {
      const title: string = patch.title.trim();
      if (!title) throw new BadRequestException('需求标题不能为空');
      if (title.length > 500) {
        throw new BadRequestException('需求标题不能超过 500 个字符');
      }
      fields['需求'] = title;
      labels.push('需求标题');
    }
    if (patch.introduction !== undefined) {
      fields['需求介绍'] = this.validateText(patch.introduction, '需求介绍');
      labels.push('需求介绍');
    }
    if (patch.acceptanceCriteria !== undefined) {
      fields['验收标准'] = this.validateText(
        patch.acceptanceCriteria,
        '验收标准',
      );
      labels.push('验收标准');
    }
    if (patch.selfTestReport !== undefined) {
      fields['自测报告'] = this.validateText(patch.selfTestReport, '自测报告');
      labels.push('自测报告');
    }
    if (patch.defectCause !== undefined) {
      fields['缺陷原因'] = this.validateText(patch.defectCause, '缺陷原因');
      labels.push('缺陷原因');
    }
    if (patch.gitBranchName !== undefined) {
      fields['Git 分支名称'] = this.validateText(
        patch.gitBranchName,
        'Git 分支名称',
      );
      labels.push('Git 分支名称');
    }
    if (patch.githubPullRequestUrl !== undefined) {
      const value: string = this.validateText(
        patch.githubPullRequestUrl,
        'GitHub 合并请求链接',
      );
      if (
        value &&
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/iu.test(value)
      ) {
        throw new BadRequestException('GitHub 合并请求链接格式不正确');
      }
      fields['GitHub 合并请求链接'] = value
        ? { link: value, text: value }
        : null;
      labels.push('GitHub 合并请求链接');
    }
    if (patch.type !== undefined) {
      this.validateOption(patch.type, options.types, '需求类型');
      fields['需求类型'] = patch.type || null;
      labels.push('需求类型');
    }
    if (patch.source !== undefined) {
      this.validateOption(patch.source, options.sources, '需求来源');
      fields['需求来源'] = patch.source || null;
      labels.push('需求来源');
    }
    if (patch.tags !== undefined) {
      const tags: string[] = uniqueStrings(patch.tags);
      const invalid: string[] = tags.filter(
        (tag: string): boolean => !options.tags.includes(tag),
      );
      if (invalid.length) {
        throw new BadRequestException(`需求标签不存在：${invalid.join('、')}`);
      }
      fields['需求标签'] = tags;
      labels.push('需求标签');
    }
    if (patch.status !== undefined) {
      this.validateOption(patch.status, options.statuses, '状态');
      const type: string = patch.type || current?.type || '产品需求';
      if (!current && !workflowStatuses(type).includes(patch.status)) {
        throw new BadRequestException(
          isDefectType(type)
            ? `缺陷不能以“${patch.status}”作为初始状态`
            : `需求不能以“${patch.status}”作为初始状态`,
        );
      }
      if (current && patch.status !== current.status) {
        if (current.workflow) {
          if (!current.allowedStatuses.includes(patch.status))
            throw new BadRequestException('当前迭代未允许此状态流转');
        } else this.validateTransition(type, current.status, patch.status);
        await this.validateTransitionRequirements(patch, current);
      }
      fields['状态'] = patch.status;
      labels.push('状态');
      if(patch.actualStartAt!==undefined)throw new BadRequestException('开发开始时间由状态流转自动记录');
      if (
        patch.status === '开发中' &&
        current?.status !== '开发中'
      ) {
        fields['实际开始时间'] = Date.now();
        labels.push('实际开始时间');
      }
      if (
        patch.status === '测试中' &&
        !current?.actualTestingAt &&
        patch.actualTestingAt === undefined
      ) {
        fields['实际提测时间'] = Date.now();
        labels.push('实际提测时间');
      }
      if (
        patch.status === '已发布' &&
        !current?.actualReleaseAt &&
        patch.actualReleaseAt === undefined
      ) {
        fields['实际发布时间'] = Date.now();
        labels.push('实际发布时间');
      }
    }
    if (patch.priority !== undefined) {
      this.validateOption(patch.priority, options.priorities, '优先级');
      fields['优先级'] = patch.priority;
      labels.push('优先级');
    }
    if (patch.project !== undefined) {
      this.validateOption(patch.project, options.projects, '项目');
      fields['项目'] = patch.project || null;
      labels.push('项目');
    }
    if (patch.iterationIds !== undefined) {
      fields['所属迭代'] = uniqueStrings(patch.iterationIds);
      labels.push('所属迭代');
    }
    if(patch.actualStartAt!==undefined)throw new BadRequestException('开发开始时间由状态流转自动记录');
    for (const key of ['startAt', 'deadlineAt', 'developmentStartAt', 'developmentEndAt', 'testingAt'] as const) {
      if (patch[key] !== undefined && !(key === 'deadlineAt' && isTicketType(patch.type || current?.type || ''))) throw new BadRequestException('该日期字段已停用，请刷新客户端');
    }
    const dateFields: Array<{
      key:
        | 'startAt'
        | 'deadlineAt'
        | 'developmentStartAt'
        | 'developmentEndAt'
        | 'testingAt'
        | 'actualStartAt'
        | 'actualTestingAt'
        | 'actualReleaseAt';
      field: string;
      label: string;
    }> = [
      { key: 'startAt', field: '开始时间', label: '开始时间' },
      { key: 'deadlineAt', field: '截止时间', label: '截止时间' },
      {
        key: 'developmentStartAt',
        field: '开发预计启动时间',
        label: '开发预计启动时间',
      },
      {
        key: 'developmentEndAt',
        field: '开发预计结束时间',
        label: '开发预计结束时间',
      },
      {
        key: 'testingAt',
        field: '预计提测时间',
        label: '预计提测时间',
      },
      {
        key: 'actualStartAt',
        field: '实际开始时间',
        label: '实际开始时间',
      },
      {
        key: 'actualTestingAt',
        field: '实际提测时间',
        label: '实际提测时间',
      },
      {
        key: 'actualReleaseAt',
        field: '实际发布时间',
        label: '实际发布时间',
      },
    ];
    dateFields.forEach((definition): void => {
      const value: number | null | undefined = patch[definition.key];
      if (value === undefined) return;
      fields[definition.field] = this.validateDate(value, definition.label);
      labels.push(definition.label);
    });
    if (patch.effort !== undefined) {
      if (
        patch.effort !== null &&
        (!Number.isFinite(patch.effort) || patch.effort < 0)
      ) {
        throw new BadRequestException('开发工作量必须是非负的自然日数');
      }
      fields['工作量'] = patch.effort;
      labels.push('开发工作量');
    }
    if (patch.latestProgress !== undefined) {
      fields['最新进展'] = this.validateText(patch.latestProgress, '最新进展');
      labels.push('最新进展');
    }
    if (patch.blocked !== undefined) {
      fields['是否阻塞'] = patch.blocked;
      labels.push('是否阻塞');
      if (!patch.blocked) fields['阻塞原因'] = '';
    }
    if (patch.blocker !== undefined && patch.blocked !== false) {
      fields['阻塞原因'] = this.validateText(patch.blocker, '阻塞原因');
      labels.push('阻塞原因');
    }
    const userFields: Record<string, unknown> =
      await this.convertPersonnelPatch(patch);
    Object.entries(userFields).forEach(
      ([field, value]: [string, unknown]): void => {
        fields[field] = value;
        labels.push(field);
      },
    );
    return { fields, labels };
  }

  async createRequirement(
    input: RequirementCreateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    return this.createRequirementAs(
      input,
      this.actor(await this.query.currentUser(identity)),
    );
  }

  async createRequirementAs(
    input: RequirementCreateInput,
    actor: CurrentUserSummary,
    source?: {
      marker: string;
      beforeWrite: () => Promise<void>;
      confirmed: (record: BaseRecord) => Promise<void>;
    },
  ): Promise<MutationResult> {
    this.assertSingleIteration(input.iterationIds ?? []);
    const workspace = await this.query.requirementEditContext(false);
    this.access.assertCanCreate(actor);
    const validIterationIds: Set<string> = new Set(
      workspace.iterations.map((iteration): string => iteration.id),
    );
    const invalid: string[] = (input.iterationIds || []).filter(
      (id: string): boolean => !validIterationIds.has(id),
    );
    if (invalid.length) throw new BadRequestException('包含不存在的迭代');
    const patch: RequirementPatch = {
      ...input,
      status: isTicketType(input.type || '')
        ? (input.handlerLarkUserIds ?? input.handlerUserIds ?? []).length
          ? '处理中'
          : '待分派'
        : isDefectType(input.type || '')
          ? '新建'
          : '新',
      priority: input.priority || 'P2',
    };
    const { fields, labels } = await this.patchFields(
      patch,
      workspace.options,
      null,
    );
    fields['提出人'] = [{ id: actor.employeeId }];
    Object.assign(fields, this.actorFields(actor));
    if (source) {
      fields['Relay 会话标识'] = source.marker;
      await source.beforeWrite();
    }
    const record = await this.feishu.createRecord(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
      fields,
      'user_id',
    );
    if (source) {
      if (
        !record?.record_id ||
        textValue(record.fields?.['Relay 会话标识']) !== source.marker
      )
        throw new Error('未收到可核验的建单回执');
      await source.confirmed(record);
    }
    this.query.invalidate();
    try {
      const created: RequirementSummary = await this.query.requirementByIdAs(
        record.record_id,
        actor,
      );
      await this.aiReviews.onRequirementCreated(created, actor);
    } catch (error) {
      this.logger.warn(
        `需求 ${record.record_id} 已创建，但 AI 评审任务未入队：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      success: true,
      message: isTicketType(input.type || '')
        ? '工单已创建'
        : input.iterationIds?.length
          ? '需求已创建并纳入迭代，现有协作服务将完成群通知和人员通知'
          : '需求已创建；纳入迭代后会自动同步至对应迭代群',
      recordId: record.record_id,
      updatedFields: [...labels, '提出人'],
    };
  }

  async updateRequirement(
    recordId: string,
    input: RequirementUpdateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    return this.updateRequirementAs(recordId, input, currentUser);
  }

  async updateRequirementAs(
    recordId: string,
    input: RequirementUpdateInput,
    currentUser: CurrentUserSummary,
  ): Promise<MutationResult> {
    return this.applyRequirementUpdateAs(recordId, input, currentUser, true);
  }

  /**
   * Executes a previously authorized background update without relying on an
   * HTTP request's database role context. The caller must obtain the archive
   * snapshot through a short service-role transaction immediately beforehand.
   */
  async updateRequirementAsWorker(
    recordId: string,
    input: RequirementUpdateInput,
    currentUser: CurrentUserSummary,
    archivedIds: ReadonlySet<string>,
    beforePersist: () => Promise<void>,
    operationId?: string,
    writeHooks?: RequirementWriteHooks,
  ): Promise<MutationResult> {
    return this.applyRequirementUpdateAs(
      recordId,
      input,
      currentUser,
      true,
      archivedIds,
      beforePersist,
      operationId,
      writeHooks,
    );
  }

  async preflightRequirementUpdateAs(
    recordId: string,
    input: RequirementUpdateInput,
    currentUser: CurrentUserSummary,
  ): Promise<MutationResult> {
    return this.applyRequirementUpdateAs(recordId, input, currentUser, false);
  }

  private async applyRequirementUpdateAs(
    recordId: string,
    input: RequirementUpdateInput,
    currentUser: CurrentUserSummary,
    persist: boolean,
    archivedIds?: ReadonlySet<string>,
    beforePersist?: () => Promise<void>,
    operationId?: string,
    writeHooks?: RequirementWriteHooks,
  ): Promise<MutationResult> {
    if (!input?.patch || typeof input.patch !== 'object') {
      throw new BadRequestException('缺少需求变更内容');
    }
    if (input.patch.iterationIds !== undefined) {
      this.assertSingleIteration(input.patch.iterationIds);
    }
    await this.archive.assertActive(recordId, archivedIds);
    const [workspace, current]: [RequirementEditContext, RequirementSummary] =
      await Promise.all([
        this.query.requirementEditContext(false),
        this.query.requirementByIdAs(recordId, currentUser, archivedIds),
      ]);
    this.access.assertCanUpdate(current, input.patch, currentUser);
    this.assertSingleIteration(
      input.patch.iterationIds === undefined
        ? current.iterationIds
        : input.patch.iterationIds,
    );
    const merged = mergeOperationPatch(current, input);
    if (
      merged.conflicts.length &&
      (input.baseValues || input.personnelChanges)
    ) {
      throw new ConflictException({
        message: '这些字段已被其他人修改，请确认差异后重试',
        errorCode: 'FIELD_CONFLICT',
        conflicts: merged.conflicts,
      });
    }
    const effectivePatch: RequirementPatch = pruneRequirementPatch(
      merged.patch,
      current,
    );
    if (
      isTicketType(effectivePatch.type ?? current.type) &&
      effectivePatch.status === undefined
    ) {
      const ids =
        effectivePatch.handlerLarkUserIds ?? effectivePatch.handlerUserIds;
      if (ids) {
        if (ids.length && current.status === '待分派')
          effectivePatch.status = '处理中';
        if (!ids.length && ['处理中', '待补充'].includes(current.status))
          effectivePatch.status = '待分派';
      }
    }
    if (!Object.keys(effectivePatch).length) {
      return {
        success: true,
        message: '没有实际变更，未写入需求表，也不会触发协作通知',
        recordId,
        updatedFields: [],
      };
    }
    const conflictResolution: RequirementUpdateConflictResolution =
      (input.baseValues || input.personnelChanges) && !merged.conflicts.length ? 'proceed' : resolveRequirementUpdateConflict(
        input.expectedUpdatedAt,
        current.updatedAt,
        effectivePatch,
        current.status,
        current.type,
      );
    if (conflictResolution === 'already-applied') {
      return {
        success: true,
        message: `需求状态已是“${current.status}”，无需重复更新`,
        recordId,
        updatedFields: [],
      };
    }
    if (conflictResolution === 'conflict') {
      const statusOnly: boolean = isStatusOnlyRequirementPatch(effectivePatch);
      throw new ConflictException({
        code: 'REQUIREMENT_VERSION_CONFLICT',
        message: statusOnly
          ? `需求当前状态已更新为“${current.status}”，请按最新状态重新操作`
          : '需求刚刚发生了冲突变更。你填写的内容已保留，请核对最新状态后再次提交',
        currentStatus: current.status,
        currentUpdatedAt: current.updatedAt,
      });
    }
    if (effectivePatch.iterationIds !== undefined) {
      const validIds: Set<string> = new Set(
        workspace.iterations.map((iteration): string => iteration.id),
      );
      const invalid: string[] = effectivePatch.iterationIds.filter(
        (id: string): boolean => !validIds.has(id),
      );
      if (invalid.length) throw new BadRequestException('包含不存在的迭代');
    }
    const governedCurrent =
      effectivePatch.type !== undefined ||
      effectivePatch.iterationIds !== undefined
        ? await this.query.requirementWithWorkflow(current, effectivePatch)
        : current;
    if (
      governedCurrent.workflow &&
      !governedCurrent.workflow.statuses.includes(current.status)
    )
      throw new BadRequestException(
        '当前状态不在目标迭代的流程中，请先调整状态再移动迭代或修改类型',
      );
    const { fields, labels } = await this.patchFields(
      effectivePatch,
      workspace.options,
      governedCurrent,
    );
    if (!labels.length) throw new BadRequestException('没有可更新的需求字段');
    // Admission still validates permissions, the transition and required
    // fields above. Authoritative release checks may refresh GitHub for tens
    // of seconds: run them once in the durable worker, before any write, not
    // inside the enqueue HTTP request as well. Direct/MCP writes stay gated.
    if (
      persist &&
      effectivePatch.status &&
      ['待发布', '已发布'].includes(effectivePatch.status)
    ) {
      await this.releaseReadiness.assertReady(
        governedCurrent,
        effectivePatch.status,
        effectivePatch,
      );
    }
    if (!persist) {
      return {
        success: true,
        message: '校验通过',
        recordId,
        updatedFields: labels,
      };
    }
    if (beforePersist) {
      await beforePersist();
    } else {
      await this.archive.assertActive(recordId, archivedIds);
    }
    Object.assign(fields, this.actorFields(currentUser));
    await this.query.assertWorkflowVersion(governedCurrent);
    if (writeHooks) await writeHooks.beforeWrite(current, fields, labels);
    const receipt = await this.feishu.updateRecord(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
      recordId,
      fields,
      'user_id',
    );
    this.query.invalidateRequirement(recordId);
    const operationStages: OperationStage[] = [
      { key: 'write', label: '需求写入', status: 'succeeded', detail: '飞书已确认写入' },
      { key: 'history', label: '变更历史', status: 'unknown', detail: '未确认' },
      { key: 'review', label: 'AI 评审', status: 'unknown', detail: '未确认' },
      { key: 'notification', label: '协作通知', status: 'unknown', detail: '由协作机器人独立处理' },
    ];
    if (writeHooks) {
      if (receipt?.record_id !== recordId || !receipt.fields) {
        throw new Error('远端未返回可核验的需求写入回执');
      }
      const updated = await this.query.summaryFromRecordAs(receipt, currentUser);
      const result: MutationResult = {
        success: true, message: '已修改', recordId, updatedFields: labels,
        operationStages: operationStages.map((stage) =>
          stage.key === 'write' ? stage : { ...stage, status: 'pending', detail: '等待独立处理' }),
      };
      await writeHooks.confirmed(current, updated, receipt, result);
      return result;
    }
    try {
      const updated: RequirementSummary = await this.query.requirementByIdAs(
        recordId,
        currentUser,
        archivedIds,
      );
      const historyRecorded: boolean = await this.recordActivity(
        recordId,
        current,
        updated,
        currentUser,
        labels,
        input.intent,
        operationId,
      );
      operationStages[1].status = historyRecorded ? 'succeeded' : 'failed';
      try {
        await this.aiReviews.onRequirementUpdated(
          current,
          updated,
          currentUser,
        );
        operationStages[2].status = 'succeeded';
        operationStages[2].detail = '评审触发检查完成，不代表评审已经完成';
      } catch (error) {
        operationStages[2].status = 'failed';
        this.logger.warn(
          `需求 ${recordId} 已更新，但 AI 评审任务未入队：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } catch (error) {
      operationStages[1].status = 'failed';
      operationStages[2].status = 'failed';
      this.logger.warn(
        `需求 ${recordId} 已更新，但生成变更历史快照失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      success: true,
      message: '已修改',
      recordId,
      updatedFields: labels,
      operationStages,
    };
  }

  async bulkUpdateRequirements(
    input: BulkRequirementUpdateInput,
    identity: RequestIdentity,
  ): Promise<BulkMutationResult> {
    if (!input?.patch || typeof input.patch !== 'object') {
      throw new BadRequestException('缺少批量变更内容');
    }
    if (input.patch.iterationIds !== undefined) {
      this.assertSingleIteration(input.patch.iterationIds);
    }
    const items = input.items || [];
    if (!items.length) throw new BadRequestException('请选择需要更新的需求');
    if (items.length > 100) {
      throw new BadRequestException('单次最多批量更新 100 项需求');
    }
    const uniqueIds: Set<string> = new Set(
      items.map((item): string => item.recordId),
    );
    if (uniqueIds.size !== items.length || uniqueIds.has('')) {
      throw new BadRequestException('批量需求列表包含空值或重复项');
    }
    const workspace: WorkspaceResponse = await this.query.workspace(
      identity,
      true,
    );
    const currentUser: CurrentUserSummary = this.actor(workspace.currentUser);
    const archivedIds: Set<string> = await this.archive.activeIds();
    const currentById: Map<string, RequirementSummary> = new Map(
      workspace.requirements.map(
        (item: RequirementSummary): [string, RequirementSummary] => [
          item.id,
          item,
        ],
      ),
    );
    if (input.patch.iterationIds !== undefined) {
      const validIds: Set<string> = new Set(
        workspace.iterations.map((iteration): string => iteration.id),
      );
      const invalid: string[] = input.patch.iterationIds.filter(
        (id: string): boolean => !validIds.has(id),
      );
      if (invalid.length) throw new BadRequestException('包含不存在的迭代');
    }
    const records: Array<{
      recordId: string;
      fields: Record<string, unknown>;
      labels: string[];
    }> = [];
    let skippedCount: number = 0;
    const governedRequirements: RequirementSummary[] = [];
    for (const item of items) {
      const current: RequirementSummary | undefined = currentById.get(
        item.recordId,
      );
      if (!current) throw new NotFoundException(`未找到需求 ${item.recordId}`);
      if (archivedIds.has(current.id)) {
        throw new ConflictException(`需求“${current.title}”已归档`);
      }
      this.access.assertCanUpdate(current, input.patch, currentUser);
      this.assertSingleIteration(
        input.patch.iterationIds === undefined
          ? current.iterationIds
          : input.patch.iterationIds,
      );
      const governedCurrent = await this.query.requirementWithWorkflow(
        current,
        input.patch,
      );
      if (
        governedCurrent.workflow &&
        !governedCurrent.workflow.statuses.includes(current.status)
      )
        throw new BadRequestException(
          `需求“${current.title}”的状态不在目标迭代流程中`,
        );
      if (
        input.patch.status &&
        input.patch.status !== current.status &&
        !governedCurrent.allowedStatuses.includes(input.patch.status)
      ) {
        throw new BadRequestException(
          `需求“${current.title}”不能从“${current.status}”流转到“${input.patch.status}”`,
        );
      }
      const effectivePatch: RequirementPatch = pruneRequirementPatch(
        input.patch,
        current,
      );
      if (!Object.keys(effectivePatch).length) {
        skippedCount += 1;
        continue;
      }
      const resolution: RequirementUpdateConflictResolution =
        resolveRequirementUpdateConflict(
          item.expectedUpdatedAt,
          current.updatedAt,
          effectivePatch,
          current.status,
          current.type,
        );
      if (resolution === 'conflict') {
        throw new ConflictException(
          `需求“${current.title}”已被其他人更新，请刷新列表后重新提交`,
        );
      }
      if (resolution === 'already-applied') {
        skippedCount += 1;
        continue;
      }
      if (
        effectivePatch.status &&
        ['待发布', '已发布'].includes(effectivePatch.status)
      ) {
        await this.releaseReadiness.assertReady(
          governedCurrent,
          effectivePatch.status,
          effectivePatch,
        );
      }
      const prepared = await this.patchFields(
        effectivePatch,
        workspace.options,
        governedCurrent,
      );
      governedRequirements.push(governedCurrent);
      records.push({
        recordId: current.id,
        fields: {
          ...prepared.fields,
          ...this.actorFields(currentUser),
        },
        labels: prepared.labels,
      });
    }
    if (!records.length) {
      return {
        success: true,
        message: '所选需求已是目标值，未写入需求表，也不会触发协作通知',
        affectedCount: 0,
        skippedCount,
        recordIds: [],
        updatedFields: [],
      };
    }
    for (const requirement of governedRequirements)
      await this.query.assertWorkflowVersion(requirement);
    await this.feishu.batchUpdateRecords(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
      records,
      'user_id',
    );
    this.query.invalidate();
    const labels: string[] = uniqueStrings(
      records.flatMap((record): string[] => record.labels),
    );
    return {
      success: true,
      message: `已修改 ${records.length} 项需求，跳过 ${skippedCount} 项无变化记录`,
      affectedCount: records.length,
      skippedCount,
      recordIds: records.map((record): string => record.recordId),
      updatedFields: labels,
    };
  }

  async addComment(
    recordId: string,
    input: CommentCreateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    await this.query.requirementById(recordId, identity);
    const content: string = this.validateText(input?.content || '', '评论');
    if (!content) throw new BadRequestException('评论内容不能为空');
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    this.access.assertCanComment(currentUser);
    await this.feishu.createRecord(
      this.query.table('FEISHU_COMMENTS_TABLE'),
      {
        评论内容: content,
        需求: [recordId],
        评论人: [{ id: currentUser.employeeId }],
        评论人名称: currentUser.name,
        是否已编辑: false,
      },
      'user_id',
    );
    this.query.invalidateDetailSupport?.();
    return {
      success: true,
      message: '评论已发布',
      recordId,
      updatedFields: ['评论'],
    };
  }

  async addAcceptanceItem(
    recordId: string,
    input: AcceptanceCreateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    const requirement: RequirementSummary = await this.query.requirementById(
      recordId,
      identity,
    );
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    this.access.assertCanManageAcceptance(requirement, currentUser);
    const title: string = (input?.title || '').trim();
    if (!title) throw new BadRequestException('验收项不能为空');
    const owners: Array<{ id: string }> = await this.convertUsers(
      input.ownerUserIds || [],
    );
    const record = await this.feishu.createRecord(
      this.query.table('FEISHU_ACCEPTANCE_TABLE'),
      {
        验收项: title,
        需求: [recordId],
        是否完成: false,
        负责人: owners,
        备注: this.validateText(input.note || '', '验收项备注'),
      },
      'user_id',
    );
    this.query.invalidateDetailSupport?.();
    return {
      success: true,
      message: '验收项已添加',
      recordId: record.record_id,
      updatedFields: ['验收项'],
    };
  }

  async updateAcceptanceItem(
    itemId: string,
    input: AcceptanceUpdateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    const acceptanceRecord = await this.feishu.getRecord(
      this.query.table('FEISHU_ACCEPTANCE_TABLE'),
      itemId,
    );
    const requirementId: string = linkedIds(acceptanceRecord.fields['需求'])[0];
    if (!requirementId) throw new NotFoundException('验收项未关联需求');
    await this.archive.assertActive(requirementId);
    const requirement: RequirementSummary = await this.query.requirementById(
      requirementId,
      identity,
    );
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    this.access.assertCanManageAcceptance(requirement, currentUser);
    const fields: Record<string, unknown> = {};
    const labels: string[] = [];
    if (input.completed !== undefined) {
      fields['是否完成'] = input.completed;
      labels.push('是否完成');
    }
    if (input.title !== undefined) {
      const title: string = input.title.trim();
      if (!title) throw new BadRequestException('验收项不能为空');
      fields['验收项'] = title;
      labels.push('验收项');
    }
    if (input.note !== undefined) {
      fields['备注'] = this.validateText(input.note, '验收项备注');
      labels.push('备注');
    }
    if (input.ownerUserIds !== undefined) {
      fields['负责人'] = await this.convertUsers(input.ownerUserIds);
      labels.push('负责人');
    }
    if (!labels.length) throw new BadRequestException('没有可更新的验收项');
    await this.feishu.updateRecord(
      this.query.table('FEISHU_ACCEPTANCE_TABLE'),
      itemId,
      fields,
      'user_id',
    );
    this.query.invalidateDetailSupport?.();
    return {
      success: true,
      message: '验收项已更新',
      recordId: itemId,
      updatedFields: labels,
    };
  }

  async addRelation(
    recordId: string,
    input: RelationCreateInput,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    const requirement: RequirementSummary = await this.query.requirementById(
      recordId,
      identity,
    );
    if (!input?.targetRequirementId || input.targetRequirementId === recordId) {
      throw new BadRequestException('请选择另一条需求作为关联目标');
    }
    await this.query.requirementById(input.targetRequirementId, identity);
    if (!RELATION_TYPES.includes(input.type)) {
      throw new BadRequestException('不支持的需求关系类型');
    }
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    this.access.assertCanManageRelations(requirement, currentUser);
    const record = await this.feishu.createRecord(
      this.query.table('FEISHU_RELATIONS_TABLE'),
      {
        关系说明: this.validateText(input.description || '', '关系说明'),
        源需求: [recordId],
        目标需求: [input.targetRequirementId],
        关系类型: input.type,
        创建人: [{ id: currentUser.employeeId }],
        创建人名称: currentUser.name,
      },
      'user_id',
    );
    this.query.invalidateDetailSupport?.();
    return {
      success: true,
      message: '需求关联已建立',
      recordId: record.record_id,
      updatedFields: ['需求关联'],
    };
  }

  private desiredGroupPeople(requirement: RequirementSummary) {
    const ownerId: string = process.env.OWNER_OPEN_ID?.trim() || '';
    if (!ownerId) throw new BadRequestException('未配置需求群群主');
    return uniquePeople([
      [{ id: ownerId, name: '周灿宇' }],
      requirement.handlers,
      ...(isTicketType(requirement.type)
        ? [requirement.proposers]
        : [
            requirement.productOwners,
            requirement.developers,
            requirement.testers,
            requirement.foOwners || [],
            requirement.releaseOwners,
          ]),
    ]);
  }

  async runGroupAction(
    recordId: string,
    action: GroupAction,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    const workspace = await this.query.workspace(identity, true);
    const requirement = workspace.requirements.find(
      (item) => item.id === recordId,
    );
    if (!requirement) throw new NotFoundException('未找到该需求');
    return this.performGroupAction(
      requirement,
      action,
      this.actor(workspace.currentUser),
    );
  }

  async runGroupActionAs(
    recordId: string,
    action: GroupAction,
    actor: CurrentUserSummary,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    return this.performGroupAction(
      await this.query.requirementByIdAs(recordId, actor),
      action,
      actor,
    );
  }

  private async performGroupAction(
    requirement: RequirementSummary,
    action: GroupAction,
    currentUser: CurrentUserSummary,
  ): Promise<MutationResult> {
    const recordId = requirement.id;
    this.access.assertCanManageGroup(requirement, currentUser);
    if (isTicketType(requirement.type) && !requirement.groupChatId && requirement.groupStatus === '创建中')
      throw new ConflictException('讨论群创建结果待核对，请先核对群 ID，不会重复创建');
    let peopleToSync = this.desiredGroupPeople(requirement);
    // Native record reads use user_id while the IM API explicitly uses open_id.
    // Normalize ticket participants through the directory before any write; never
    // pass an employee ID into an open_id request or infer identity from names.
    if (isTicketType(requirement.type)) {
      peopleToSync = uniquePeople([await Promise.all(peopleToSync.map(async person => {
        if (person.id.startsWith('ou_')) return person;
        const member = await this.feishu.getUserByEmployeeId(person.id);
        if (member.employeeId !== person.id || !member.openId.startsWith('ou_'))
          throw new BadRequestException('无法确认讨论群成员身份');
        return {id:member.openId,name:member.name};
      }))]);
    }
    if (action === 'sync' && !requirement.groupChatId) {
      throw new BadRequestException('需求尚未创建协作群');
    }
    if (requirement.groupChatId) {
      const existingIds: Set<string> = new Set(
        await this.feishu.listChatMemberIds(requirement.groupChatId),
      );
      const missingIds: string[] = peopleToSync
        .map((person): string => person.id)
        .filter((id: string): boolean => !existingIds.has(id));
      await this.feishu.addChatMembers(requirement.groupChatId, missingIds);
      await this.feishu.updateRecord(
        this.query.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        {
          群成员同步时间: Date.now(),
          拉群状态: '已创建',
          ...this.actorFields(currentUser),
        },
        'user_id',
      );
      this.query.invalidate();
      return {
        success: true,
        message: missingIds.length
          ? `已同步 ${missingIds.length} 位新成员`
          : '需求群成员已是最新',
        recordId,
        updatedFields: ['群成员'],
      };
    }

    await this.feishu.updateRecord(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
      recordId,
      {
        拉群状态: '创建中',
        ...this.actorFields(currentUser),
      },
      'user_id',
    );
    let ticketChatId: string | undefined;
    try {
      const ownerId: string = process.env.OWNER_OPEN_ID?.trim() || '';
      const chatId: string = await this.feishu.createChat({
        uuid: requirementUuid(recordId),
        name: isTicketType(requirement.type)
          ? ticketGroupName(requirement.title, requirement.priority)
          : requirement.title.slice(0, 60),
        description: `${isTicketType(requirement.type) ? '工单讨论群' : '需求协作群'}：${requirement.title}`,
        ownerId,
        memberIds: peopleToSync.map((person): string => person.id),
      });
      if (isTicketType(requirement.type)) ticketChatId = chatId;
      const createdAt: number = Date.now();
      const chatLink: string = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
      await this.feishu.updateRecord(
        this.query.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        {
          需求群ID: chatId,
          需求群链接: { link: chatLink, text: '打开需求群' },
          拉群状态: '已创建',
          拉群时间: createdAt,
          群成员同步时间: createdAt,
          ...this.actorFields(currentUser),
        },
        'user_id',
      );
      try {
        await this.feishu.updateRecord(
          this.query.table('FEISHU_REQUIREMENTS_TABLE'),
          recordId,
          { 需求群聊: [{ id: chatId }] },
          'user_id',
        );
      } catch (error) {
        this.logger.warn(
          `需求群 ${chatId} 群组件字段回写失败，群 ID 和状态已成功保存：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        const permanentLink: string =
          await this.feishu.createPermanentChatLink(chatId);
        if (permanentLink) {
          await this.feishu.updateRecord(
            this.query.table('FEISHU_REQUIREMENTS_TABLE'),
            recordId,
            {
              需求群链接: {
                link: permanentLink,
                text: '打开需求群',
              },
            },
            'user_id',
          );
        }
      } catch (error) {
        this.logger.warn(
          `需求群 ${chatId} 永久链接创建失败，已保留可用的会话直链：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        await this.feishu.sendGroupPost(
          chatId,
          isTicketType(requirement.type) ? '工单讨论群已建立' : '需求协作群已建立',
          requirement.title,
          requirement.url,
          peopleToSync,
          `requirement-group-${recordId}`.slice(0, 50),
          isTicketType(requirement.type),
        );
      } catch (error) {
        this.logger.warn(
          `需求群 ${chatId} 首条协作消息发送失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      this.query.invalidate();
      return {
        success: true,
        message: '需求群已创建并同步相关成员',
        recordId,
        updatedFields: ['需求群'],
      };
    } catch (error) {
      await this.feishu.updateRecord(
        this.query.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        {
          拉群状态: isTicketType(requirement.type) && (ticketChatId || !(error instanceof FeishuRequestError && error.remoteRejected)) ? '创建中' : '失败',
          ...(ticketChatId ? {需求群ID:ticketChatId,需求群链接:{link:`https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(ticketChatId)}`,text:'打开需求群'}} : {}),
          ...this.actorFields(currentUser),
        },
        'user_id',
      );
      if (isTicketType(requirement.type)) this.query.invalidate();
      throw error;
    }
  }

  async deleteRequirement(
    recordId: string,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    await this.archive.assertActive(recordId);
    const requirement: RequirementSummary = await this.query.requirementById(
      recordId,
      identity,
    );
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    return this.archive.archive(requirement, currentUser);
  }

  async permanentlyDeleteRequirement(
    recordId: string,
    identity: RequestIdentity,
  ): Promise<MutationResult> {
    const currentUser: CurrentUserSummary = this.actor(
      await this.query.currentUser(identity),
    );
    return this.archive.permanentlyDelete(recordId, currentUser);
  }
}
