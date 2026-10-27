import {ProjectActionService} from './project-action.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type {
  AcceptanceCreateInput,
  AcceptanceUpdateInput,
  BulkMutationResult,
  BulkRequirementUpdateInput,
  CommentCreateInput,
  CurrentUserSummary,
  GroupAction,
  McpCredentialExchangeInput,
  McpEncryptedCredentialResponse,
  McpCredentialStatus,
  MutationResult,
  RelationCreateInput,
  RequirementCreateInput,
  RequirementDetailResponse,
  RequirementAiReviewOverrideInput,
  RequirementAiReviewType,
  RequirementArtifactKind,
  RequirementArtifactUpsertInput,
  RequirementEngineeringResponse,
  RequirementEditContext,
  RequirementListQuery,
  RequirementListResponse,
  RequirementListRiskFilter,
  RequirementListSortBy,
  RequirementListSortOrder,
  RequirementPersonnelResponse,
  RequirementArchiveListResponse,
  RequirementReleaseReadiness,
  RequirementUpdateInput,
  RequirementUpdateJobAccepted,
  RequirementUpdateJobSummary,
  WorkspaceBrowserResponse,
  WorkspaceResponse,
  WorkspaceSummaryResponse,
} from '@shared/api.interface';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementBatchService } from './requirement-batch.service';
import { randomUUID } from 'node:crypto';
import { RequirementUpdateJobsService } from './requirement-update-jobs.service';
import { McpPersonalTokenService } from './mcp-personal-token.service';
import { RequirementArchiveService } from './requirement-archive.service';
import { RequirementReleaseReadinessService } from './requirement-release-readiness.service';
import { RequirementAiReviewService } from './requirement-ai-review.service';
import { IterationSettingsService } from './iteration-settings.service';
import type {
  IterationSettingsInput,
  IterationConfiguration,
} from '../../../shared/iteration-workflow';

import { PortalProjectService } from './portal-project.service';

interface RequestIdentity {
  userId: string;
  userName: string;
  roles: string[];
  appId: string;
}

const LIST_RISK_FILTERS: ReadonlySet<string> = new Set([
  'in-progress',
  'overdue',
  'blocked',
  'unassigned',
  'missing-personnel',
  'missing-product',
  'missing-developer',
  'missing-tester',
  'unplanned',
  'missing-progress',
]);

const LIST_SORT_FIELDS: ReadonlySet<string> = new Set([
  'risk',
  'updatedAt',
  'deadlineAt',
  'priority',
  'status',
  'title',
]);

@Controller('api/workspace')
export class RequirementsController {
  constructor(
    private readonly queryService: RequirementsQueryService,
    private readonly commandService: RequirementsCommandService,
    private readonly updateJobsService: RequirementUpdateJobsService,
    private readonly personalTokenService: McpPersonalTokenService,
    private readonly archiveService: RequirementArchiveService,
    private readonly releaseReadiness: RequirementReleaseReadinessService,
    private readonly aiReviewService: RequirementAiReviewService,
    private readonly iterationSettings: IterationSettingsService,
    private readonly batches: RequirementBatchService,
    private readonly portalProjects: PortalProjectService,
    private readonly projectActions: ProjectActionService,
  ) {}

  @NeedLogin()
  @Get('iterations/:iterationId/settings')
  @Header('Cache-Control', 'no-store, private')
  async getIterationSettings(
    @Param('iterationId') id: string,
    @Req() req: Request,
  ) {
    return this.iterationSettings.get(id, await this.currentUser(req));
  }

  @NeedLogin()
  @Post('iterations/:iterationId/settings/validate')
  async validateIterationSettings(
    @Param('iterationId') id: string,
    @Body() input: { configuration: IterationConfiguration },
    @Req() req: Request,
  ) {
    return this.iterationSettings.impact(
      id,
      input?.configuration,
      await this.currentUser(req),
    );
  }

  @NeedLogin()
  @Post('iterations/:iterationId/settings/draft')
  async saveIterationSettings(
    @Param('iterationId') id: string,
    @Body() input: IterationSettingsInput,
    @Req() req: Request,
  ) {
    return this.iterationSettings.save(id, input, await this.currentUser(req));
  }

  @NeedLogin()
  @Post('iterations/:iterationId/settings/publish')
  async publishIterationSettings(
    @Param('iterationId') id: string,
    @Body() input: IterationSettingsInput,
    @Req() req: Request,
  ) {
    return this.iterationSettings.save(
      id,
      input,
      await this.currentUser(req),
      true,
    );
  }

  private identity(req: Request): RequestIdentity {
    const userId: string = req.userContext?.userId || '';
    if (!userId) throw new UnauthorizedException('请先登录');
    return {
      userId,
      userName: req.userContext?.userName || '当前用户',
      roles: req.userContext?.roles || [],
      appId:
        req.userContext?.appId ||
        process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
        process.env.MIAODA_APP_ID?.trim() ||
        '',
    };
  }

  private async currentUser(req: Request): Promise<CurrentUserSummary> {
    const identity: RequestIdentity = this.identity(req);
    return this.queryService.currentUser(identity);
  }

  @NeedLogin()
  @Get('project-management')
  @Header('Cache-Control', 'no-store, private')
  async projectManagement(@Req() req: Request) {
    await this.currentUser(req);
    const projects = await this.portalProjects.list();
    return { projects };
  }

  @NeedLogin()
  @Get('members/:openId/avatar')
  @Header('Cache-Control', 'private, max-age=300')
  async memberAvatar(@Req() req: Request, @Param('openId') openId: string) {
    this.identity(req);
    return this.queryService.memberAvatar(openId);
  }

  @NeedLogin()
  @Post('project-management/action')
  @Header('Cache-Control', 'no-store, private')
  async projectAction(@Req() req: Request, @Body() body: unknown) {
    return this.projectActions.execute(await this.currentUser(req), body);
  }

  @NeedLogin()
  @Get('mcp-credential')
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  async mcpCredentialStatus(@Req() req: Request): Promise<McpCredentialStatus> {
    const currentUser: CurrentUserSummary = await this.currentUser(req);
    return await this.personalTokenService.status(currentUser);
  }

  @NeedLogin()
  @Post('mcp-credential')
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  async issueMcpCredential(
    @Req() req: Request,
    @Body() input?: McpCredentialExchangeInput,
  ): Promise<McpEncryptedCredentialResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(req);
    return await this.personalTokenService.issueEncrypted(
      currentUser,
      input?.publicKey || '',
      input?.requestNonce || '',
    );
  }

  @NeedLogin()
  @Post('mcp-credential/rotate')
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  async rotateMcpCredential(
    @Req() req: Request,
    @Body() input?: McpCredentialExchangeInput,
  ): Promise<McpEncryptedCredentialResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(req);
    return await this.personalTokenService.rotateEncrypted(
      currentUser,
      input?.publicKey || '',
      input?.requestNonce || '',
    );
  }

  private groupAction(value: string): GroupAction {
    if (value === 'create' || value === 'sync') return value;
    throw new BadRequestException('不支持的群操作');
  }

  private listQuery(
    raw: Record<string, string | undefined>,
  ): RequirementListQuery {
    const page: number = Math.max(1, Math.trunc(Number(raw.page) || 1));
    const pageSize: number = Math.min(
      100,
      Math.max(1, Math.trunc(Number(raw.pageSize) || 25)),
    );
    const risk: RequirementListRiskFilter | undefined = LIST_RISK_FILTERS.has(
      raw.risk || '',
    )
      ? (raw.risk as RequirementListRiskFilter)
      : undefined;
    const sortBy: RequirementListSortBy | undefined = LIST_SORT_FIELDS.has(
      raw.sortBy || '',
    )
      ? (raw.sortBy as RequirementListSortBy)
      : undefined;
    const sortOrder: RequirementListSortOrder | undefined =
      raw.sortOrder === 'asc' || raw.sortOrder === 'desc'
        ? raw.sortOrder
        : undefined;
    return {
      page,
      pageSize,
      search: raw.q,
      status: raw.status,
      priority: raw.priority,
      project: raw.project,
      type: raw.type,
      source: raw.source,
      iterationId: raw.iteration,
      handlerId: raw.handler,
      productOwnerId: raw.product,
      developerId: raw.developer,
      testerId: raw.tester,
      foOwnerId: raw.fo,
      risk,
      mineOnly: raw.mine === '1' || raw.mine === 'true',
      excludeId: raw.excludeId,
      groupBy: [
        'status',
        'iteration',
        'project',
        'priority',
        'handler',
        'product',
        'developer',
        'tester',
        'fo',
      ].includes(raw.groupBy || '')
        ? (raw.groupBy as RequirementListQuery['groupBy'])
        : undefined,
      sortBy,
      sortOrder,
      includeContent: raw.includeContent !== '0',
    };
  }

  @Get()
  async workspace(
    @Req() req: Request,
    @Query('refresh') refresh?: string,
  ): Promise<WorkspaceResponse> {
    return this.queryService.workspace(this.identity(req), refresh === 'true');
  }

  @NeedLogin()
  @Get('browser-index')
  async browserWorkspace(@Req() req: Request, @Query('refresh') refresh?: string): Promise<WorkspaceBrowserResponse> {
    return this.queryService.browserWorkspace(this.identity(req), refresh === 'true');
  }

  @Get('summary')
  async workspaceSummary(
    @Req() req: Request,
    @Query('refresh') refresh?: string,
  ): Promise<WorkspaceSummaryResponse> {
    return this.queryService.workspaceSummary(
      this.identity(req),
      refresh === 'true',
    );
  }

  @NeedLogin()
  @Get('current-user')
  async currentUserSummary(@Req() req: Request): Promise<CurrentUserSummary> {
    return this.currentUser(req);
  }

  @Get('requirements')
  async requirements(
    @Req() req: Request,
    @Query() query: Record<string, string | undefined>,
  ): Promise<RequirementListResponse> {
    return this.queryService.requirementsPage(
      this.identity(req),
      this.listQuery(query),
      query.refresh === 'true',
    );
  }

  @NeedLogin()
  @Get('requirements/edit-context')
  async requirementEditContext(
    @Req() req: Request,
  ): Promise<RequirementEditContext> {
    this.identity(req);
    return this.queryService.requirementEditContext(false);
  }

  @NeedLogin()
  @Post('requirements')
  async createRequirement(
    @Req() req: Request,
    @Body() input: RequirementCreateInput,
  ): Promise<MutationResult> {
    return this.commandService.createRequirement(input, this.identity(req));
  }

  @NeedLogin()
  @Get('requirement-archive')
  async requirementArchive(
    @Req() req: Request,
  ): Promise<RequirementArchiveListResponse> {
    return this.archiveService.list(await this.currentUser(req));
  }

  @NeedLogin()
  @Post('requirements/:recordId/restore')
  async restoreRequirement(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<MutationResult> {
    return this.archiveService.restore(recordId, await this.currentUser(req));
  }

  @NeedLogin()
  @Delete('requirements/:recordId/permanent')
  async permanentlyDeleteRequirement(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<MutationResult> {
    return this.commandService.permanentlyDeleteRequirement(
      recordId,
      this.identity(req),
    );
  }

  @NeedLogin()
  @Post('requirements/bulk-update')
  async bulkUpdateRequirements(
    @Req() req: Request,
    @Body() input: BulkRequirementUpdateInput,
  ): Promise<BulkMutationResult> {
    const actor = await this.currentUser(req);
    const preview = await this.batches.preview({ ...input, clientMutationId: randomUUID() }, actor);
    if (preview.items.some((item) => item.status === 'blocked')) {
      throw new BadRequestException('部分需求不满足修改条件，请使用批量预览逐项确认');
    }
    const batch = await this.batches.execute(preview.id, actor);
    return { success: !batch.items.some((item) => item.status === 'failed'),
      message: '已修改', batchId: batch.id, items: batch.items,
      affectedCount: batch.items.filter((item) => Boolean(item.operationId)).length,
      skippedCount: batch.items.filter((item) => item.status === 'skipped').length,
      recordIds: batch.items.filter((item) => Boolean(item.operationId)).map((item) => item.recordId) };
  }

  @Get('requirements/:recordId')
  async detail(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<RequirementDetailResponse> {
    await this.archiveService.assertActive(recordId);
    return this.queryService.detail(recordId, this.identity(req));
  }

  @NeedLogin()
  @Get('requirements/:recordId/engineering')
  async requirementEngineering(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<RequirementEngineeringResponse> {
    await this.archiveService.assertActive(recordId);
    return this.aiReviewService.workspace(recordId, this.identity(req));
  }

  @NeedLogin()
  @Patch('requirements/:recordId/artifacts/:kind')
  async saveRequirementArtifact(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Param('kind') kind: RequirementArtifactKind,
    @Body() input: RequirementArtifactUpsertInput,
  ): Promise<RequirementEngineeringResponse> {
    await this.archiveService.assertActive(recordId);
    return this.aiReviewService.saveArtifact(
      recordId,
      kind,
      input,
      this.identity(req),
    );
  }

  @NeedLogin()
  @Post('requirements/:recordId/reviews/:type/retry')
  async retryRequirementReview(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Param('type') type: RequirementAiReviewType,
  ): Promise<RequirementEngineeringResponse> {
    await this.archiveService.assertActive(recordId);
    return this.aiReviewService.retry(recordId, type, this.identity(req));
  }

  @NeedLogin()
  @Post('requirements/:recordId/reviews/:type/override')
  async overrideRequirementReview(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Param('type') type: RequirementAiReviewType,
    @Body() input: RequirementAiReviewOverrideInput,
  ): Promise<RequirementEngineeringResponse> {
    await this.archiveService.assertActive(recordId);
    return this.aiReviewService.override(
      recordId,
      type,
      input,
      this.identity(req),
    );
  }

  @Get('requirements/:recordId/release-readiness')
  async requirementReleaseReadiness(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Query('targetStatus') targetStatus?: string,
  ): Promise<RequirementReleaseReadiness> {
    await this.archiveService.assertActive(recordId);
    const requirement = await this.queryService.requirementById(
      recordId,
      this.identity(req),
    );
    return this.releaseReadiness.evaluate(
      requirement,
      targetStatus || '待发布',
    );
  }

  @Get('requirements/:recordId/personnel')
  async personnel(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<RequirementPersonnelResponse> {
    this.identity(req);
    return this.queryService.requirementPersonnel(recordId);
  }

  @NeedLogin()
  @Post('requirements/:recordId/update-jobs')
  async enqueueRequirementUpdate(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: RequirementUpdateInput,
  ): Promise<RequirementUpdateJobAccepted> {
    return this.updateJobsService.enqueue(recordId, input, this.identity(req));
  }

  @NeedLogin()
  @Get('requirement-update-jobs/:jobId')
  async requirementUpdateJob(
    @Req() req: Request,
    @Param('jobId') jobId: string,
  ): Promise<RequirementUpdateJobSummary> {
    return this.updateJobsService.get(jobId, this.identity(req));
  }

  @NeedLogin()
  @Patch('requirements/:recordId')
  async updateRequirement(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: RequirementUpdateInput,
  ): Promise<MutationResult> {
    return this.updateJobsService.enqueue(
      recordId,
      input,
      this.identity(req),
    );
  }

  @NeedLogin()
  @Delete('requirements/:recordId')
  async deleteRequirement(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<MutationResult> {
    return this.commandService.deleteRequirement(recordId, this.identity(req));
  }

  @NeedLogin()
  @Post('requirements/:recordId/comments')
  async addComment(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: CommentCreateInput,
  ): Promise<MutationResult> {
    return this.commandService.addComment(recordId, input, this.identity(req));
  }

  @NeedLogin()
  @Post('requirements/:recordId/acceptance')
  async addAcceptanceItem(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: AcceptanceCreateInput,
  ): Promise<MutationResult> {
    return this.commandService.addAcceptanceItem(
      recordId,
      input,
      this.identity(req),
    );
  }

  @NeedLogin()
  @Patch('acceptance/:itemId')
  async updateAcceptanceItem(
    @Req() req: Request,
    @Param('itemId') itemId: string,
    @Body() input: AcceptanceUpdateInput,
  ): Promise<MutationResult> {
    return this.commandService.updateAcceptanceItem(
      itemId,
      input,
      this.identity(req),
    );
  }

  @NeedLogin()
  @Post('requirements/:recordId/relations')
  async addRelation(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: RelationCreateInput,
  ): Promise<MutationResult> {
    return this.commandService.addRelation(recordId, input, this.identity(req));
  }

  @NeedLogin()
  @Post('requirements/:recordId/group/:action')
  async groupActionExecute(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Param('action') action: string,
  ): Promise<MutationResult> {
    return this.commandService.runGroupAction(
      recordId,
      this.groupAction(action),
      this.identity(req),
    );
  }
}
