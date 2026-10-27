import { requirementListStats, requirementListPeopleOptions, requirementIntroductionPreview } from '../../../shared/requirement-list-metadata';
import { selectRequirementList } from '../../../shared/requirement-list';
import { isTicketType, TICKET_STATUSES, requirementComplete } from '../../../shared/ticket-workflow';
import { PortalProjectService } from './portal-project.service';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthNPaasService,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { requirementCacheRevision } from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import type { WorkspaceDataFreshness, RequirementDetailCoreResponse, RequirementDetailSection, RequirementDetailSectionResponse } from '../../../shared/workspace-efficiency';
import type {
  AcceptanceItemSummary,
  ActivitySummary,
  CommentSummary,
  CurrentUserSummary,
  IterationSummary,
  RelationSummary,
  RequirementListQuery,
  RequirementListResponse,
  RequirementDetailResponse,
  RequirementEditContext,
  RequirementPersonnelResponse,
  RequirementSummary,
  WorkspaceOptions,
  WorkspaceBrowserResponse,
  WorkspaceResponse,
  WorkspaceSummaryResponse,
} from '@shared/api.interface';
import {
  type BaseField,
  type BaseRecord,
  type BaseRecordSearchFilter,
  FeishuService,
} from './feishu.service';
import {
  allowedStatuses,
  chatDeepLink,
  isOverdue,
  linkedIds,
  normalizeRequirementStatus,
  NORMAL_STATUS_ORDER,
  DEFECT_STATUS_ORDER,
  DEFECT_BRANCH_STATUSES,
  people,
  selectValues,
  statusRank,
  textValue,
  timestamp,
  uniqueStrings,
  urlValue,
} from './requirements.model';
import { requirementPlatformUrl } from './requirement-links';
import { RequirementAccessService } from './requirement-access.service';
import { IterationConfigurationStore } from './iteration-configuration.store';
import type { IterationConfigurationVersion } from '../../../shared/iteration-workflow';
import type { RequirementPatch } from '@shared/api.interface';

interface WorkspaceReferenceData {
  iterationRecords: BaseRecord[];
  requirementFields: BaseField[];
}

interface ParsedWorkspaceData {
  freshness: WorkspaceDataFreshness;
  currentUser: CurrentUserSummary;
  iterations: IterationSummary[];
  requirements: RequirementSummary[];
  options: WorkspaceOptions;
}

interface RequirementDetailSupportData {
  commentRecords: BaseRecord[];
  acceptanceRecords: BaseRecord[];
  relationRecords: BaseRecord[];
  eventRecords: BaseRecord[];
}

interface RequestIdentity {
  userId: string;
  userName: string;
  roles?: string[];
  appId?: string;
}

interface ArchivedRequirementRow extends Record<string, unknown> {
  requirement_id: string;
}

const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  code: '需求编号',
  title: '需求名称',
  type: '需求类型',
  source: '需求来源',
  tags: '需求标签',
  introduction: '需求介绍',
  acceptanceCriteria: '验收标准',
  selfTestReport: '自测报告',
  defectCause: '缺陷原因',
  gitBranchName: 'Git 分支名称',
  githubPullRequestUrl: 'GitHub 合并请求链接',
  iterationIds: '所属迭代',
  status: '状态',
  priority: '优先级',
  project: '项目',
  proposers: '提出人',
  handlers: '当前处理人',
  productOwners: '产品人员',
  developers: '研发人员',
  testers: '测试人员',
  foOwners: 'FO',
  followers: '关注人',
  releaseOwners: '发布负责人',
  startDate: '开始时间',
  deadline: '截止时间',
  developmentStart: '开发预计启动时间',
  developmentEnd: '开发预计结束时间',
  testDate: '预计提测时间',
  actualStart: '实际开始时间',
  actualTest: '实际提测时间',
  actualRelease: '实际发布时间',
  effort: '开发工作量',
  blocked: '是否阻塞',
  blocker: '阻塞原因',
  latestProgress: '最新进展',
};

const ACTIVITY_DATE_FIELDS: Set<string> = new Set([
  'startDate',
  'deadline',
  'developmentStart',
  'developmentEnd',
  'testDate',
  'actualStart',
  'actualTest',
  'actualRelease',
]);

function eventSnapshot(value: unknown): Record<string, unknown> | null {
  const raw: string = textValue(value);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function comparableActivityValue(value: unknown): unknown {
  if (value == null || value === '' || value === '未设置' || value === false) {
    return null;
  }
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value.map(comparableActivityValue);
  }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Number((value as Record<string, unknown>).__textLength || 0) === 0
  ) {
    return null;
  }
  return value;
}

function displayActivityValue(
  key: string,
  value: unknown,
  iterationNames: Map<string, string>,
): string {
  if (value == null || value === '' || value === '未设置') return '未设置';
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, '__textLength')
  ) {
    const length: number = Number(
      (value as Record<string, unknown>).__textLength || 0,
    );
    return length > 0 ? `已填写（${length} 字）` : '未填写';
  }
  if (Array.isArray(value)) {
    if (!value.length) return '未设置';
    if (key === 'iterationIds') {
      return value
        .map(
          (id: unknown): string => iterationNames.get(String(id)) || '未知迭代',
        )
        .join('、');
    }
    return (
      value
        .map((item: unknown): string => {
          if (!item || typeof item !== 'object') return String(item || '');
          const record: Record<string, unknown> = item as Record<
            string,
            unknown
          >;
          return String(record.name || record.id || '');
        })
        .filter(Boolean)
        .join('、') || '未设置'
    );
  }
  if (value === true) return '是';
  if (value === false) return '否';
  if (ACTIVITY_DATE_FIELDS.has(key)) {
    const dateValue: number | null = timestamp(value as string | number | null);
    if (dateValue) {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(dateValue));
    }
  }
  return String(value);
}

export type RequirementWriteSnapshot = Pick<
  RequirementSummary,
  | 'type'
  | 'introduction'
  | 'acceptanceCriteria'
  | 'selfTestReport'
  | 'defectCause'
  | 'gitBranchName'
  | 'githubPullRequestUrl'
  | 'status'
  | 'handlers'
  | 'productOwners'
  | 'developers'
  | 'testers'
  | 'foOwners'
  | 'releaseOwners'
  | 'updatedAt'
  | 'actualStartAt'
  | 'actualTestingAt'
  | 'actualReleaseAt'
>;

const CACHE_TTL_MS: number = 30_000;
@Injectable()
export class RequirementsQueryService {
  private readonly logger: Logger = new Logger(RequirementsQueryService.name);
  private requirementRecordsCache: {
    expiresAt: number;
    data: BaseRecord[];
  } | null = null;
  private requirementRecordsRequest: Promise<BaseRecord[]> | null = null;
  private requirementRecordsHaveContent = true;
  private requirementRequestHasContent = true;
  private referenceCache: {
    expiresAt: number;
    data: WorkspaceReferenceData;
  } | null = null;
  private referenceRequest: Promise<WorkspaceReferenceData> | null = null;
  private readonly detailSupportCache: Map<
    string,
    { expiresAt: number; data: RequirementDetailSupportData }
  > = new Map();
  private readonly detailSupportRequests: Map<
    string,
    Promise<RequirementDetailSupportData>
  > = new Map();

  constructor(
    private readonly feishu: FeishuService,
    private readonly authnService: AuthNPaasService,
    private readonly access: RequirementAccessService,
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly iterationConfigurations: IterationConfigurationStore,
    @Optional() private readonly serviceDatabase?: ServiceRoleDatabaseExecutor,
    @Optional() private readonly portalProjects?: PortalProjectService,
  ) {}

  private readonly dirtyRequirements = new Set<string>();
  private readonly dirtyEpochs = new Map<string, number>();
  private dirtySequence = 0;
  private readonly revisions = new Map<string, number>();
  private cacheLoadedAt: string = '';
  private cacheIsStale: boolean = false;
  private referenceIsStale = false;
  private recordsGeneration = 0;
  private referenceGeneration = 0;
  private browserRecordsRefresh: Promise<BaseRecord[]> | null = null;

  invalidateRequirement(recordId: string): void {
    this.dirtyRequirements.add(recordId);
    this.dirtyEpochs.set(recordId, ++this.dirtySequence);
    this.invalidateDetailSupport(recordId);
  }

  async commitRequirement(recordId: string, _confirmedRecord?: BaseRecord, operationId?: string): Promise<void> {
    this.invalidateRequirement(recordId);
    // List records use open_id; the confirmed write response uses employee IDs.
    // Reload only this row in the proper namespace instead of corrupting person fields.
    if (this.serviceDatabase) {
      const rows = await this.serviceDatabase.run((db) => db.execute<{ revision: number }>(
        db.insert(requirementCacheRevision).values({ requirementId: recordId, operationId: operationId || null })
          .onConflictDoUpdate({ target: requirementCacheRevision.requirementId, set: {
            revision: sql`${requirementCacheRevision.revision} + 1`, operationId: operationId || null, updatedAt: sql`CURRENT_TIMESTAMP`,
          } }).returning({ revision: requirementCacheRevision.revision }),
      ));
      this.revisions.set(recordId, rows[0].revision);
    }
  }

  private async synchronizeCacheRevisions(): Promise<void> {
    if (!this.serviceDatabase) return;
    const rows = await this.serviceDatabase.run((db) => db.execute<{ requirementId: string; revision: number }>(
      db.select({ requirementId: sql<string>`${requirementCacheRevision.requirementId}`.as('requirementId'), revision: requirementCacheRevision.revision })
        .from(requirementCacheRevision).limit(1001),
    ));
    if (rows.length > 1000) {
      // No silent waterline truncation: fall back to the authoritative list.
      this.invalidate();
      this.invalidateDetailSupport();
      return;
    }
    for (const row of rows) {
      if ((this.revisions.get(row.requirementId) || 0) < row.revision) {
        this.invalidateRequirement(row.requirementId);
        this.revisions.set(row.requirementId, row.revision);
      }
    }
  }

  async requirementWithWorkflow(
    requirement: RequirementSummary,
    patch: RequirementPatch = {},
  ): Promise<RequirementSummary> {
    const result = {
      ...requirement,
      type: patch.type ?? requirement.type,
      iterationIds: patch.iterationIds ?? requirement.iterationIds,
    };
    result.allowedStatuses = allowedStatuses(result.status, result.type);
    this.iterationConfigurations.decorate(
      result,
      result.iterationIds.length === 1
        ? await this.iterationConfigurations.publishedMap(
            result.iterationIds[0],
          )
        : new Map(),
    );
    return result;
  }

  async assertWorkflowVersion(requirement: RequirementSummary): Promise<void> {
    if (requirement.iterationIds.length === 1)
      await this.iterationConfigurations.assertVersion(
        requirement.iterationIds[0],
        requirement.workflow?.version || 0,
      );
  }

  private applyIterationMilestones(
    iterations: IterationSummary[],
    versions: Map<string, IterationConfigurationVersion>,
  ): void {
    for (const item of iterations) {
      const version = versions.get(item.id);
      if (version) {
        item.configurationVersion = version.version;
        item.milestones = version.configuration.milestones;
        const due = (id: string) =>
          item.milestones?.find((m) => m.id === id)?.dueAt || null;
        item.startAt = due('start');
        item.reviewAt = due('review');
        item.developmentAt = due('development');
        item.testingAt = due('testing');
        item.releaseAt = due('release');
        item.endAt = due('release');
      }
    }
  }

  private async activeArchiveIds(
    database: PostgresJsDatabase = this.db,
  ): Promise<Set<string>> {
    const rows = await database.execute<ArchivedRequirementRow>(sql`
      SELECT requirement_id FROM requirement_archive_active_ids()
    `);
    return new Set(
      rows.map((row: ArchivedRequirementRow): string => row.requirement_id),
    );
  }

  table(name: string): string {
    const value: string = process.env[name]?.trim() || '';
    if (!value) throw new NotFoundException(`缺少配置 ${name}`);
    return value;
  }

  invalidate(): void {
    this.recordsGeneration++;
    this.requirementRecordsCache = null;
  }

  invalidateReference(): void {
    this.referenceGeneration++;
    this.referenceCache = null;
  }

  invalidateDetailSupport(recordId?: string): void {
    if (!recordId) this.detailSupportCache.clear();
    else for (const key of this.detailSupportCache.keys()) {
      if (key === recordId || key.startsWith(`${recordId}:`)) this.detailSupportCache.delete(key);
    }
  }

  private async loadDetailSupport(
    recordId: string,
    section?: RequirementDetailSection,
  ): Promise<RequirementDetailSupportData> {
    const cacheKey = section ? `${recordId}:${section}` : recordId;
    const now: number = Date.now();
    this.detailSupportCache.forEach(
      (
        entry: { expiresAt: number; data: RequirementDetailSupportData },
        key: string,
      ): void => {
        if (entry.expiresAt <= now) this.detailSupportCache.delete(key);
      },
    );
    const cached:
      | { expiresAt: number; data: RequirementDetailSupportData }
      | undefined = this.detailSupportCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const pending: Promise<RequirementDetailSupportData> | undefined =
      this.detailSupportRequests.get(cacheKey);
    if (pending) return pending;
    const linkedFilter = (fieldName: string): BaseRecordSearchFilter => ({
      conjunction: 'and',
      conditions: [
        {
          fieldName,
          operator: 'contains',
          value: [recordId],
        },
      ],
    });
    const request: Promise<RequirementDetailSupportData> = Promise.all([
      !section || section === 'comments' ? this.feishu.searchRecords(
        this.table('FEISHU_COMMENTS_TABLE'),
        linkedFilter('需求'),
        'user_id',
      ) : Promise.resolve([]),
      !section || section === 'acceptance' ? this.feishu.searchRecords(
        this.table('FEISHU_ACCEPTANCE_TABLE'),
        linkedFilter('需求'),
        'user_id',
      ) : Promise.resolve([]),
      !section || section === 'relations' ? this.feishu.searchRecords(
        this.table('FEISHU_RELATIONS_TABLE'),
        {
          conjunction: 'or',
          conditions: [
            {
              fieldName: '源需求',
              operator: 'contains',
              value: [recordId],
            },
            {
              fieldName: '目标需求',
              operator: 'contains',
              value: [recordId],
            },
          ],
        },
        'user_id',
      ) : Promise.resolve([]),
      !section || section === 'activities' ? this.feishu.searchRecords(
        this.table('FEISHU_COLLABORATION_TABLE'),
        linkedFilter('需求'),
        'user_id',
      ) : Promise.resolve([]),
    ]).then(
      ([commentRecords, acceptanceRecords, relationRecords, eventRecords]) => ({
        commentRecords,
        acceptanceRecords,
        relationRecords,
        eventRecords,
      }),
    );
    this.detailSupportRequests.set(cacheKey, request);
    try {
      const data: RequirementDetailSupportData = await request;
      this.detailSupportCache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        data,
      });
      return data;
    } finally {
      if (this.detailSupportRequests.get(cacheKey) === request) {
        this.detailSupportRequests.delete(cacheKey);
      }
    }
  }

  requirementUrl(recordId: string): string {
    return requirementPlatformUrl(recordId);
  }

  private async loadRequirementRecords(
    forceRefresh: boolean,
    includeContent = true,
    allowStale = false,
    readFreshness?: WorkspaceDataFreshness,
  ): Promise<BaseRecord[]> {
    // Capture metadata when this read chooses its data, before other awaits or
    // a background refresh can replace the shared cache and its timestamp.
    const snapshot = (data: BaseRecord[], stale = false): BaseRecord[] => {
      if (readFreshness) {
        readFreshness.loadedAt = this.cacheLoadedAt;
        readFreshness.stale = stale;
      }
      return data;
    };
    this.cacheIsStale = false;
    try {
      await this.synchronizeCacheRevisions();
      if (!forceRefresh && this.requirementRecordsCache && this.requirementRecordsCache.expiresAt > Date.now() && this.dirtyRequirements.size) {
        const changed = [...this.dirtyRequirements];
        const epochs = new Map(this.dirtyEpochs);
        const records = await Promise.all(changed.map((id) => this.feishu.getRecord(this.table('FEISHU_REQUIREMENTS_TABLE'), id, 'open_id')));
        const replacements = new Map(records.map((record) => [record.record_id, record]));
        this.requirementRecordsCache.data = this.requirementRecordsCache.data.map((record) => replacements.get(record.record_id) || record);
        const existing = new Set(this.requirementRecordsCache.data.map((record) => record.record_id));
        this.requirementRecordsCache.data.push(...records.filter((record) => !existing.has(record.record_id)));
        // In-flight full reads started before these confirmed rows must not
        // subsequently replace the reconciled cache.
        this.recordsGeneration++;
        changed.forEach((id) => { if (this.dirtyEpochs.get(id) === epochs.get(id)) { this.dirtyRequirements.delete(id); this.dirtyEpochs.delete(id); } });
      }
    } catch (error) {
      if (forceRefresh || !this.requirementRecordsCache || (includeContent && !this.requirementRecordsHaveContent)) throw error;
      // If invalidation cannot be verified, do not pretend the old list is current.
      this.cacheIsStale = true;
      this.logger.warn('需求缓存更新暂不可用，保留最近可信数据');
      return snapshot(this.requirementRecordsCache.data, true);
    }
    const now: number = Date.now();
    if (
      !forceRefresh &&
      this.requirementRecordsCache &&
      (!includeContent || this.requirementRecordsHaveContent) &&
      this.requirementRecordsCache.expiresAt > now
    ) {
      return snapshot(this.requirementRecordsCache.data);
    }
    // Only browser reads may reuse a bounded old snapshot. Known writes and
    // explicit refreshes must still wait for the authoritative source.
    if (!forceRefresh && allowStale && !this.dirtyRequirements.size &&
      this.requirementRecordsCache && (!includeContent || this.requirementRecordsHaveContent) &&
      this.requirementRecordsCache.expiresAt > now - 120_000) {
      this.cacheIsStale = true;
      const previous = snapshot(this.requirementRecordsCache.data, true);
      if (!this.browserRecordsRefresh && !this.requirementRecordsRequest) {
        const refresh = this.loadRequirementRecords(true, includeContent);
        this.browserRecordsRefresh = refresh;
        void refresh.catch((error: unknown) => this.logger.warn(
          `需求后台刷新失败：${error instanceof Error ? error.message : String(error)}`,
        )).finally(() => {
          if (this.browserRecordsRefresh === refresh) this.browserRecordsRefresh = null;
        });
      }
      return previous;
    }
    if (!forceRefresh && this.requirementRecordsRequest && (!includeContent || this.requirementRequestHasContent)) {
      await this.requirementRecordsRequest;
      return this.loadRequirementRecords(false, includeContent, false, readFreshness);
    }
    if (this.requirementRecordsRequest) {
      await this.requirementRecordsRequest;
    }
    const generation = this.recordsGeneration;
    const loadingEpochs = new Map(this.dirtyEpochs);
    const omittedFields = new Set(['需求介绍', '验收标准', '自测报告', '缺陷原因']);
    const fieldNames = includeContent ? undefined : (await this.loadReference(false)).requirementFields
      .map((field) => field.name).filter((name) => !omittedFields.has(name));
    // An empty projection must not become an accidental "all fields" request.
    if (fieldNames && !fieldNames.length) throw new Error('需求字段尚未就绪，请稍后刷新');
    const request: Promise<BaseRecord[]> = this.feishu.listRecords(
      this.table('FEISHU_REQUIREMENTS_TABLE'),
      fieldNames,
    );
    this.requirementRecordsRequest = request;
    this.requirementRequestHasContent = includeContent;
    try {
      const data: BaseRecord[] = await request;
      if (generation !== this.recordsGeneration) {
        return this.requirementRecordsCache && (!includeContent || this.requirementRecordsHaveContent)
          ? snapshot(this.requirementRecordsCache.data, this.requirementRecordsCache.expiresAt <= Date.now())
          : snapshot(data, true);
      }
      this.requirementRecordsCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        data,
      };
      this.cacheLoadedAt = new Date().toISOString();
      this.requirementRecordsHaveContent = includeContent;
      for (const [id, epoch] of loadingEpochs) if (this.dirtyEpochs.get(id) === epoch) { this.dirtyRequirements.delete(id); this.dirtyEpochs.delete(id); }
      return snapshot(data);
    } catch (error) {
      if (!forceRefresh && this.requirementRecordsCache && (!includeContent || this.requirementRecordsHaveContent)) {
        this.cacheIsStale = true;
        this.logger.warn(
          `飞书需求表暂时不可用，继续使用最近一次成功数据：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return snapshot(this.requirementRecordsCache.data, true);
      }
      throw error;
    } finally {
      if (this.requirementRecordsRequest === request) {
        this.requirementRecordsRequest = null;
      }
    }
  }

  private async loadReference(
    forceRefresh: boolean,
    allowStale = false,
    readFreshness?: { stale: boolean },
  ): Promise<WorkspaceReferenceData> {
    const snapshot = (data: WorkspaceReferenceData, stale = false): WorkspaceReferenceData => {
      if (readFreshness) readFreshness.stale = stale;
      return data;
    };
    const now: number = Date.now();
    if (
      !forceRefresh &&
      this.referenceCache &&
      this.referenceCache.expiresAt > now
    ) {
      return snapshot(this.referenceCache.data);
    }
    if (!forceRefresh && allowStale && this.referenceCache &&
      this.referenceCache.expiresAt > now - 120_000) {
      this.referenceIsStale = true;
      const previous = snapshot(this.referenceCache.data, true);
      if (!this.referenceRequest) void this.loadReference(true).catch((error: unknown) =>
        this.logger.warn(`需求元数据后台刷新失败：${error instanceof Error ? error.message : String(error)}`),
      );
      return previous;
    }
    if (!forceRefresh && this.referenceRequest) {
      const pending = await this.referenceRequest;
      return snapshot(pending, !this.referenceCache || this.referenceCache.data !== pending ||
        this.referenceCache.expiresAt <= Date.now());
    }
    if (forceRefresh && this.referenceRequest) await this.referenceRequest;
    const generation = this.referenceGeneration;
    const request: Promise<WorkspaceReferenceData> = Promise.all([
      this.feishu.listRecords(this.table('FEISHU_ITERATIONS_TABLE')),
      this.feishu.listFields(this.table('FEISHU_REQUIREMENTS_TABLE')),
    ]).then(
      ([iterationRecords, requirementFields]: [
        BaseRecord[],
        BaseField[],
      ]): WorkspaceReferenceData => ({
        iterationRecords,
        requirementFields,
      }),
    );
    this.referenceRequest = request;
    try {
      const data: WorkspaceReferenceData = await request;
      if (generation !== this.referenceGeneration) return snapshot(data, true);
      this.referenceIsStale = false;
      this.referenceCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        data,
      };
      return snapshot(data);
    } catch (error) {
      if (!forceRefresh && this.referenceCache) {
        this.referenceIsStale = true;
        this.logger.warn(
          `飞书需求元数据暂时不可用，继续使用最近一次成功数据：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return snapshot(this.referenceCache.data, true);
      }
      throw error;
    } finally {
      if (this.referenceRequest === request) this.referenceRequest = null;
    }
  }

  async memberAvatar(openId: string): Promise<{avatarUrl:string}> {
    return {avatarUrl:await this.feishu.getAvatarByOpenId(openId)};
  }

  async currentUser(identity: RequestIdentity): Promise<CurrentUserSummary> {
    if (!identity.userId) throw new UnauthorizedException('请先登录');
    const employeeId: string =
      (await this.authnService.getCurrentUserLarkUserId()) || '';
    let openId: string = '';
    if (employeeId) {
      try {
        openId = await this.feishu.getOpenIdByEmployeeId(employeeId);
      } catch (error) {
        this.logger.warn(
          `当前用户 open_id 解析失败，“与我相关”筛选暂不可用：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.access.decorate({
      miaodaUserId: identity.userId,
      employeeId,
      openId,
      name: identity.userName || '当前用户',
      platformAppId:
        identity.appId?.trim() ||
        process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
        process.env.MIAODA_APP_ID?.trim() ||
        '',
      platformRoleIds: identity.roles || [],
    });
  }

  private parseIteration(record: BaseRecord): IterationSummary {
    const fields: Record<string, unknown> = record.fields;
    return {
      id: record.record_id,
      name: textValue(fields['迭代名称']) || '未命名迭代',
      status: textValue(fields['状态']) || '规划中',
      goal: textValue(fields['迭代目标']),
      owner: people(fields['负责人']),
      startAt: (fields['开始时间'] as string | number | null) || null,
      endAt: (fields['结束时间'] as string | number | null) || null,
      reviewAt: (fields['需求评审时间'] as string | number | null) || null,
      developmentAt: (fields['开发启动时间'] as string | number | null) || null,
      testingAt: (fields['提测时间'] as string | number | null) || null,
      releaseAt: (fields['发布时间'] as string | number | null) || null,
      requirementCount: 0,
      completedCount: 0,
      completionRate: 0,
    };
  }

  private requirementRisks(
    requirement: RequirementSummary,
    iterations: Map<string, IterationSummary>,
  ): string[] {
    const risks: string[] = [];
    if (requirement.blocked) risks.push('已阻塞');
    if (!requirement.handlers.length) risks.push('未分配处理人');
    const completed: boolean = requirementComplete(requirement);
    if (!completed && isOverdue(requirement.deadlineAt)) {
      risks.push('需求已逾期');
    }
    if (!completed && !requirement.latestProgress.trim()) {
      risks.push('未填写最新进展');
    }
    if (requirement.type === '缺陷' || isTicketType(requirement.type)) return [...new Set(risks)];
    const rank: number = statusRank(requirement.status) ?? -1;
    requirement.iterationIds.forEach((iterationId: string): void => {
      const iteration: IterationSummary | undefined =
        iterations.get(iterationId);
      if (!iteration) return;
      if (rank < 1 && isOverdue(iteration.reviewAt)) {
        risks.push('需求评审里程碑逾期');
      }
      if (rank < 3 && isOverdue(iteration.developmentAt)) {
        risks.push('开发里程碑逾期');
      }
      if (rank < 5 && isOverdue(iteration.testingAt)) {
        risks.push('提测里程碑逾期');
      }
      if (rank < 7 && isOverdue(iteration.releaseAt || iteration.endAt)) {
        risks.push('发布里程碑逾期');
      }
    });
    return [...new Set(risks)];
  }

  private parseRequirement(
    record: BaseRecord,
    iterationNames: Map<string, string>,
    currentPersonId: string,
  ): RequirementSummary {
    const fields: Record<string, unknown> = record.fields;
    const iterationIds: string[] = linkedIds(fields['所属迭代']);
    const handlers = people(fields['当前处理人']);
    const productOwners = people(fields['产品人员']);
    const developers = people(fields['研发人员']);
    const testers = people(fields['测试人员']);
    const foOwners = people(fields['FO']);
    const proposers = people(fields['提出人']);
    const followers = people(fields['关注人']);
    const releaseOwners = people(fields['发布负责人']);
    const groupChatId: string = textValue(fields['需求群ID']);
    const rawEffort: unknown = fields['工作量'];
    const effortValue: number =
      rawEffort == null || rawEffort === '' ? Number.NaN : Number(rawEffort);
    const type: string = textValue(fields['需求类型']) || '未设置';
    const status: string = normalizeRequirementStatus(
      textValue(fields['状态']) || (type === '缺陷' ? '新建' : '新'),
    );
    return {
      id: record.record_id,
      code: textValue(fields['需求编号']) || record.record_id,
      notificationMarker: textValue(fields['平台操作标识']),
      title: textValue(fields['需求']) || '未命名需求',
      url: this.requirementUrl(record.record_id),
      introduction: textValue(fields['需求介绍']),
      acceptanceCriteria: textValue(fields['验收标准']),
      selfTestReport: textValue(fields['自测报告']),
      defectCause: textValue(fields['缺陷原因']),
      gitBranchName: textValue(fields['Git 分支名称']),
      githubPullRequestUrl: urlValue(fields['GitHub 合并请求链接']),
      type,
      source: textValue(fields['需求来源']) || '未设置',
      tags: selectValues(fields['需求标签']),
      status,
      allowedStatuses: allowedStatuses(status, type),
      priority: textValue(fields['优先级']) || '未设置',
      project: textValue(fields['项目']) || '未设置',
      iterationIds,
      iterationNames: iterationIds
        .map((id: string): string => iterationNames.get(id) || '')
        .filter(Boolean),
      handlers,
      productOwners,
      developers,
      testers,
      foOwners,
      proposers,
      followers,
      releaseOwners,
      personnelUserIds: {
        handlers: [],
        productOwners: [],
        developers: [],
        testers: [],
        foOwners: [],
        proposers: [],
        followers: [],
        releaseOwners: [],
      },
      startAt: null,
      deadlineAt: isTicketType(type) ? (fields['截止时间'] as string | number | null) || null : null,
      developmentStartAt: null,
      developmentEndAt: null,
      testingAt: null,
      actualStartAt: (fields['实际开始时间'] as string | number | null) || null,
      actualTestingAt:
        (fields['实际提测时间'] as string | number | null) || null,
      actualReleaseAt:
        (fields['实际发布时间'] as string | number | null) || null,
      effort: Number.isFinite(effortValue) ? effortValue : null,
      latestProgress: textValue(fields['最新进展']),
      blocked: fields['是否阻塞'] === true,
      blocker: textValue(fields['阻塞原因']),
      updatedAt: (fields['更新时间'] as string | number | null) || null,
      updatedByName:
        textValue(fields['最近操作人名称']) ||
        people(fields['最近操作人'])[0]?.name ||
        people(fields['最后修改人'])[0]?.name ||
        '',
      groupChatId,
      groupLink: urlValue(fields['需求群链接']) || chatDeepLink(groupChatId),
      groupStatus: textValue(fields['拉群状态']) || '未创建',
      isMine:
        Boolean(currentPersonId) &&
        handlers.some(
          (person: { id: string }): boolean => person.id === currentPersonId,
        ),
      risks: [],
      capabilities: {
        canUpdate: false,
        canArchive: false,
        canManageGroup: false,
        canManageAcceptance: false,
        canManageRelations: false,
        canComment: false,
      },
    };
  }

  private withCapabilities(
    requirement: RequirementSummary,
    currentUser: CurrentUserSummary,
  ): RequirementSummary {
    const canUpdate: boolean = this.access.canUpdate(requirement, currentUser);
    return {
      ...requirement,
      capabilities: {
        canUpdate,
        canArchive: this.access.canArchive(requirement, currentUser),
        canManageGroup: canUpdate,
        canManageAcceptance: canUpdate,
        canManageRelations: canUpdate,
        canComment: this.access.canComment(currentUser),
      },
    };
  }

  private async options(fields: BaseField[], catalog?: { normalization: Record<string, string>; names: string[] }): Promise<WorkspaceOptions> {
    const values = (name: string): string[] =>
      fields
        .find((field: BaseField): boolean => field.name === name)
        ?.options.map((option: { name?: string }): string => option.name || '')
        .filter(Boolean) || [];
    return {
      statuses: uniqueStrings([
        ...NORMAL_STATUS_ORDER,
        ...DEFECT_STATUS_ORDER,
        ...DEFECT_BRANCH_STATUSES,
        ...TICKET_STATUSES,
      ]),
      priorities: values('优先级'),
      projects: catalog ? uniqueStrings([...values('项目').map((name) => Object.hasOwn(catalog.normalization, name) ? catalog.normalization[name] : name), ...catalog.names]) : this.portalProjects?.normalizeOptions ? await this.portalProjects.normalizeOptions(values('项目')) : uniqueStrings([...values('项目'), ...await this.portalProjects?.names() || []]),
      types: values('需求类型'),
      sources: values('需求来源'),
      tags: values('需求标签'),
    };
  }

  private async parsedWorkspace(
    currentUser: CurrentUserSummary,
    forceRefresh: boolean,
    includeContent = true,
    allowStale = false,
  ): Promise<ParsedWorkspaceData> {
    const recordFreshness: WorkspaceDataFreshness = { loadedAt: '', stale: false };
    const referenceFreshness = { stale: false };
    const [requirementRecords, reference, archivedIds, configurations, catalog]: [
      BaseRecord[],
      WorkspaceReferenceData,
      Set<string>,
      Map<string, IterationConfigurationVersion>,
      { normalization: Record<string, string>; names: string[] },
    ] = await Promise.all([
      this.loadRequirementRecords(forceRefresh, includeContent, allowStale, recordFreshness),
      this.loadReference(forceRefresh, allowStale, referenceFreshness),
      this.activeArchiveIds(),
      this.iterationConfigurations.publishedMap(),
      this.portalProjects?.readCatalog() || Promise.resolve({ normalization: {}, names: [] }),
    ]);
    const iterations: IterationSummary[] = reference.iterationRecords
      .map(
        (record: BaseRecord): IterationSummary => this.parseIteration(record),
      )
      .sort(
        (left: IterationSummary, right: IterationSummary): number =>
          Number(timestamp(right.startAt) || 0) -
          Number(timestamp(left.startAt) || 0),
      );
    this.applyIterationMilestones(iterations, configurations);
    const iterationNames: Map<string, string> = new Map(
      iterations.map((item: IterationSummary): [string, string] => [
        item.id,
        item.name,
      ]),
    );
    const iterationById: Map<string, IterationSummary> = new Map(
      iterations.map((item: IterationSummary): [string, IterationSummary] => [
        item.id,
        item,
      ]),
    );
    const projectNames: Record<string, string> = catalog.normalization;
    const requirements: RequirementSummary[] = requirementRecords
      .filter(
        (record: BaseRecord): boolean => !archivedIds.has(record.record_id),
      )
      .map(
        (record: BaseRecord): RequirementSummary =>
          this.withCapabilities(
            this.parseRequirement(record, iterationNames, currentUser.openId),
            currentUser,
          ),
      )
      .map(
        (item: RequirementSummary): RequirementSummary => ({
          ...item,
          project: Object.hasOwn(projectNames, item.project) ? projectNames[item.project] : item.project,
          risks: this.requirementRisks(item, iterationById),
        }),
      );

    requirements.forEach((item) =>
      this.iterationConfigurations.decorate(item, configurations),
    );
    iterations.forEach((iteration: IterationSummary): void => {
      const related: RequirementSummary[] = requirements.filter(
        (item: RequirementSummary): boolean =>
          item.iterationIds.includes(iteration.id),
      );
      iteration.requirementCount = related.length;
      iteration.completedCount = related.filter(
        (item: RequirementSummary): boolean =>
          requirementComplete(item),
      ).length;
      iteration.completionRate = related.length
        ? Math.round((iteration.completedCount / related.length) * 100)
        : 0;
    });

    return {
      currentUser,
      iterations,
      requirements,
      options: await this.options(reference.requirementFields, catalog),
      freshness: { ...recordFreshness, stale: recordFreshness.stale || referenceFreshness.stale },
    };
  }

  async workspace(
    identity: RequestIdentity,
    forceRefresh: boolean,
  ): Promise<WorkspaceResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    return this.workspaceAs(currentUser, forceRefresh);
  }

  async workspaceAs(
    currentUser: CurrentUserSummary,
    forceRefresh: boolean,
  ): Promise<WorkspaceResponse> {
    const parsed: ParsedWorkspaceData = await this.parsedWorkspace(
      currentUser,
      forceRefresh,
      true,
    );
    const requirements: RequirementSummary[] = [...parsed.requirements].sort(
      (left: RequirementSummary, right: RequirementSummary): number =>
        Number(Boolean(right.risks.length)) -
          Number(Boolean(left.risks.length)) ||
        Number(timestamp(right.updatedAt) || 0) -
          Number(timestamp(left.updatedAt) || 0),
    );

    return {
      fetchedAt: parsed.freshness.loadedAt,
      freshness: parsed.freshness,
      currentUser,
      stats: requirementListStats(requirements),
      iterations: parsed.iterations,
      requirements,
      options: parsed.options,
    };
  }

  async browserWorkspace(
    identity: RequestIdentity,
    forceRefresh: boolean,
  ): Promise<WorkspaceBrowserResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    // Keep linked cells authoritative. Projected Bitable search can omit iteration metadata.
    const parsed = await this.parsedWorkspace(
      currentUser, forceRefresh, true, !forceRefresh,
    );
    return {
      ...parsed,
      requirements: parsed.requirements.map((item: RequirementSummary) => ({
        ...item,
        introduction: '',
        introductionPreview: requirementIntroductionPreview(item.introduction),
        acceptanceCriteria: '',
        selfTestReport: '',
        defectCause: '',
        contentOmitted: true,
      })),
      complete: true,
      fetchedAt: parsed.freshness.loadedAt,
      freshness: parsed.freshness,
      stats: requirementListStats(parsed.requirements),
      peopleOptions: requirementListPeopleOptions(parsed.requirements),
    };
  }

  async workspaceSummary(
    identity: RequestIdentity,
    forceRefresh: boolean,
  ): Promise<WorkspaceSummaryResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    return this.workspaceSummaryAs(currentUser, forceRefresh);
  }

  async workspaceSummaryAs(
    currentUser: CurrentUserSummary,
    forceRefresh: boolean,
  ): Promise<WorkspaceSummaryResponse> {
    const parsed: ParsedWorkspaceData = await this.parsedWorkspace(
      currentUser,
      forceRefresh,
    );
    return {
      fetchedAt: parsed.freshness.loadedAt,
      freshness: parsed.freshness,
      currentUser,
      stats: requirementListStats(parsed.requirements),
      iterations: parsed.iterations,
      options: parsed.options,
      peopleOptions: requirementListPeopleOptions(parsed.requirements),
    };
  }

  async requirementEditContext(
    forceRefresh: boolean = false,
  ): Promise<RequirementEditContext> {
    const reference: WorkspaceReferenceData =
      await this.loadReference(forceRefresh);
    return {
      iterations: reference.iterationRecords.map(
        (record: BaseRecord): IterationSummary => this.parseIteration(record),
      ),
      options: await this.options(reference.requirementFields),
    };
  }

  async requirementsPage(
    identity: RequestIdentity,
    input: RequirementListQuery,
    forceRefresh: boolean,
  ): Promise<RequirementListResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    const parsed: ParsedWorkspaceData = await this.parsedWorkspace(
      currentUser,
      forceRefresh,
      // Iteration filtering needs authoritative linked cells; projected search responses may omit relation metadata.
      Boolean(input.iterationId) || input.includeContent !== false,
    );
    return selectRequirementList({
      fetchedAt: parsed.freshness.loadedAt,
      ...parsed,
      stats: requirementListStats(parsed.requirements),
    }, input);
  }

  async requirementById(
    recordId: string,
    identity: RequestIdentity,
  ): Promise<RequirementSummary> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    return this.requirementByIdAs(recordId, currentUser);
  }

  async requirementByIdAs(
    recordId: string,
    currentUser: CurrentUserSummary,
    archivedIdsOverride?: ReadonlySet<string>,
  ): Promise<RequirementSummary> {
    const [record, archivedIds]: [
      BaseRecord,
      Set<string>,
    ] = await Promise.all([
      this.feishu.getRecord(
        this.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        'user_id',
      ),
      archivedIdsOverride
        ? Promise.resolve(new Set(archivedIdsOverride))
        : this.activeArchiveIds(),
    ]);
    if (!record?.record_id || archivedIds.has(recordId)) {
      throw new NotFoundException('未找到该需求');
    }
    return this.summaryFromRecordAs(record, currentUser);
  }

  /** Internal worker read: keep the database role scoped to the archive RPC only.
   * Never wrap Feishu/network calls in a database transaction or fall back to an
   * anonymous request context. Actor capabilities and archive filtering still apply.
   */
  async requirementByIdForWorker(
    recordId: string,
    currentUser: CurrentUserSummary,
  ): Promise<RequirementSummary> {
    if (!this.serviceDatabase) {
      throw new ServiceUnavailableException('后台数据库执行身份尚未就绪');
    }
    const archivedIds: Set<string> = await this.serviceDatabase.run(
      (database: PostgresJsDatabase) => this.activeArchiveIds(database),
    );
    if (archivedIds.has(recordId)) throw new NotFoundException('未找到该需求');
    return this.requirementByIdAs(recordId, currentUser, archivedIds);
  }

  /** Map only the supplied authoritative record; never attribute a later read to this write. */
  async summaryFromRecordAs(record: BaseRecord, currentUser: CurrentUserSummary): Promise<RequirementSummary> {
    const reference = await this.loadReference(false);
    const iterations: IterationSummary[] = reference.iterationRecords.map(
      (item: BaseRecord): IterationSummary => this.parseIteration(item),
    );
    const configurationVersions =
      await this.iterationConfigurations.publishedMap();
    this.applyIterationMilestones(iterations, configurationVersions);
    const iterationNames: Map<string, string> = new Map(
      iterations.map((item: IterationSummary): [string, string] => [
        item.id,
        item.name,
      ]),
    );
    const iterationById: Map<string, IterationSummary> = new Map(
      iterations.map((item: IterationSummary): [string, IterationSummary] => [
        item.id,
        item,
      ]),
    );
    const requirement: RequirementSummary = this.withCapabilities(
      this.parseRequirement(record, iterationNames, currentUser.employeeId),
      currentUser,
    );
    const projectNames: Record<string, string> = await this.portalProjects?.normalization?.() || {};
    requirement.project = Object.hasOwn(projectNames, requirement.project) ? projectNames[requirement.project] : requirement.project;
    this.iterationConfigurations.decorate(requirement, configurationVersions);
    const personnelFields: Record<string, unknown> = record.fields;
    requirement.personnelUserIds = {
      handlers: people(personnelFields['当前处理人']).map(
        (person): string => person.id,
      ),
      productOwners: people(personnelFields['产品人员']).map(
        (person): string => person.id,
      ),
      developers: people(personnelFields['研发人员']).map(
        (person): string => person.id,
      ),
      testers: people(personnelFields['测试人员']).map(
        (person): string => person.id,
      ),
      foOwners: people(personnelFields['FO']).map(
        (person): string => person.id,
      ),
      proposers: people(personnelFields['提出人']).map(
        (person): string => person.id,
      ),
      followers: people(personnelFields['关注人']).map(
        (person): string => person.id,
      ),
      releaseOwners: people(personnelFields['发布负责人']).map(
        (person): string => person.id,
      ),
    };
    requirement.risks = this.requirementRisks(requirement, iterationById);
    return requirement;
  }

  async requirementWriteSnapshot(
    recordId: string,
  ): Promise<RequirementWriteSnapshot> {
    const record: BaseRecord = await this.feishu.getRecord(
      this.table('FEISHU_REQUIREMENTS_TABLE'),
      recordId,
    );
    const fields: Record<string, unknown> = record.fields;
    return {
      type: textValue(fields['需求类型']) || '未设置',
      introduction: textValue(fields['需求介绍']),
      acceptanceCriteria: textValue(fields['验收标准']),
      selfTestReport: textValue(fields['自测报告']),
      defectCause: textValue(fields['缺陷原因']),
      gitBranchName: textValue(fields['Git 分支名称']),
      githubPullRequestUrl: urlValue(fields['GitHub 合并请求链接']),
      status: normalizeRequirementStatus(
        textValue(fields['状态']) ||
          (textValue(fields['需求类型']) === '缺陷' ? '新建' : '新'),
      ),
      handlers: people(fields['当前处理人']),
      productOwners: people(fields['产品人员']),
      developers: people(fields['研发人员']),
      testers: people(fields['测试人员']),
      foOwners: people(fields['FO']),
      releaseOwners: people(fields['发布负责人']),
      updatedAt: (fields['更新时间'] as string | number | null) || null,
      actualStartAt: (fields['实际开始时间'] as string | number | null) || null,
      actualTestingAt:
        (fields['实际提测时间'] as string | number | null) || null,
      actualReleaseAt:
        (fields['实际发布时间'] as string | number | null) || null,
    };
  }

  async detailCore(recordId: string, identity: RequestIdentity): Promise<RequirementDetailCoreResponse> {
    return {
      requirement: await this.requirementByIdAs(recordId, await this.currentUser(identity)),
      freshness: { loadedAt: new Date().toISOString(), stale: false },
    };
  }

  async detailSection<T extends RequirementDetailSection>(recordId: string, identity: RequestIdentity, section: T): Promise<RequirementDetailSectionResponse<T>> {
    await this.synchronizeCacheRevisions();
    const detail = await this.detail(recordId, identity, section);
    const values = { comments: detail.comments, acceptance: detail.acceptanceItems, relations: detail.relations, activities: detail.activities };
    const cached = this.detailSupportCache.get(`${recordId}:${section}`);
    return {
      requirementId: recordId, section, items: values[section],
      freshness: { loadedAt: new Date(cached ? cached.expiresAt - CACHE_TTL_MS : Date.now()).toISOString(), stale: false },
    };
  }

  async requirementPersonnel(
    recordId: string,
  ): Promise<RequirementPersonnelResponse> {
    const [record, archivedIds]: [BaseRecord, Set<string>] = await Promise.all([
      this.feishu.getRecord(
        this.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        'user_id',
      ),
      this.activeArchiveIds(),
    ]);
    if (archivedIds.has(recordId)) throw new NotFoundException('未找到该需求');
    const fields: Record<string, unknown> = record.fields;
    return {
      recordId,
      updatedAt: (fields['更新时间'] as string | number | null) || null,
      personnelUserIds: {
        handlers: people(fields['当前处理人']).map(
          (person): string => person.id,
        ),
        productOwners: people(fields['产品人员']).map(
          (person): string => person.id,
        ),
        developers: people(fields['研发人员']).map(
          (person): string => person.id,
        ),
        testers: people(fields['测试人员']).map((person): string => person.id),
        foOwners: people(fields['FO']).map((person): string => person.id),
        proposers: people(fields['提出人']).map((person): string => person.id),
        followers: people(fields['关注人']).map((person): string => person.id),
        releaseOwners: people(fields['发布负责人']).map(
          (person): string => person.id,
        ),
      },
    };
  }

  private parseComment(record: BaseRecord): CommentSummary {
    const fields: Record<string, unknown> = record.fields;
    return {
      id: record.record_id,
      content: textValue(fields['评论内容']),
      author: people(fields['评论人'])[0] || null,
      authorName:
        textValue(fields['评论人名称']) ||
        people(fields['评论人'])[0]?.name ||
        '',
      createdAt: (fields['创建时间'] as string | number | null) || null,
      updatedAt: (fields['更新时间'] as string | number | null) || null,
      edited: fields['是否已编辑'] === true,
    };
  }

  private parseAcceptance(record: BaseRecord): AcceptanceItemSummary {
    const fields: Record<string, unknown> = record.fields;
    return {
      id: record.record_id,
      title: textValue(fields['验收项']),
      completed: fields['是否完成'] === true,
      owner: people(fields['负责人']),
      note: textValue(fields['备注']),
      createdAt: (fields['创建时间'] as string | number | null) || null,
      updatedAt: (fields['更新时间'] as string | number | null) || null,
    };
  }

  async detail(
    recordId: string,
    identity: RequestIdentity,
    section?: RequirementDetailSection,
  ): Promise<RequirementDetailResponse> {
    const currentUser: CurrentUserSummary = await this.currentUser(identity);
    const [record, support, reference, archivedIds]: [
      BaseRecord,
      RequirementDetailSupportData,
      WorkspaceReferenceData,
      Set<string>,
    ] = await Promise.all([
      this.feishu.getRecord(
        this.table('FEISHU_REQUIREMENTS_TABLE'),
        recordId,
        'user_id',
      ),
      this.loadDetailSupport(recordId, section),
      this.loadReference(false),
      this.activeArchiveIds(),
    ]);
    if (!record?.record_id || archivedIds.has(recordId)) {
      throw new NotFoundException('未找到该需求');
    }
    const iterations: IterationSummary[] = reference.iterationRecords.map(
      (item: BaseRecord): IterationSummary => this.parseIteration(item),
    );
    const configurationVersions =
      await this.iterationConfigurations.publishedMap();
    this.applyIterationMilestones(iterations, configurationVersions);
    const iterationNames: Map<string, string> = new Map(
      iterations.map((iteration: IterationSummary): [string, string] => [
        iteration.id,
        iteration.name,
      ]),
    );
    const iterationById: Map<string, IterationSummary> = new Map(
      iterations.map(
        (iteration: IterationSummary): [string, IterationSummary] => [
          iteration.id,
          iteration,
        ],
      ),
    );
    const requirement: RequirementSummary = this.withCapabilities(
      this.parseRequirement(record, iterationNames, currentUser.openId),
      currentUser,
    );
    const projectNames: Record<string, string> = await this.portalProjects?.normalization?.() || {};
    requirement.project = Object.hasOwn(projectNames, requirement.project) ? projectNames[requirement.project] : requirement.project;
    this.iterationConfigurations.decorate(requirement, configurationVersions);
    requirement.risks = this.requirementRisks(requirement, iterationById);
    const { commentRecords, acceptanceRecords, relationRecords, eventRecords } =
      support;
    const personnelFields: Record<string, unknown> = record.fields;
    requirement.personnelUserIds = {
      handlers: people(personnelFields['当前处理人']).map(
        (person): string => person.id,
      ),
      productOwners: people(personnelFields['产品人员']).map(
        (person): string => person.id,
      ),
      developers: people(personnelFields['研发人员']).map(
        (person): string => person.id,
      ),
      testers: people(personnelFields['测试人员']).map(
        (person): string => person.id,
      ),
      foOwners: people(personnelFields['FO']).map(
        (person): string => person.id,
      ),
      proposers: people(personnelFields['提出人']).map(
        (person): string => person.id,
      ),
      followers: people(personnelFields['关注人']).map(
        (person): string => person.id,
      ),
      releaseOwners: people(personnelFields['发布负责人']).map(
        (person): string => person.id,
      ),
    };
    const comments: CommentSummary[] = commentRecords
      .filter((record: BaseRecord): boolean =>
        linkedIds(record.fields['需求']).includes(recordId),
      )
      .map((record: BaseRecord): CommentSummary => this.parseComment(record))
      .sort(
        (left: CommentSummary, right: CommentSummary): number =>
          Number(timestamp(left.createdAt) || 0) -
          Number(timestamp(right.createdAt) || 0),
      );
    const acceptanceItems: AcceptanceItemSummary[] = acceptanceRecords
      .filter((record: BaseRecord): boolean =>
        linkedIds(record.fields['需求']).includes(recordId),
      )
      .map(
        (record: BaseRecord): AcceptanceItemSummary =>
          this.parseAcceptance(record),
      );
    const relatedRelationRecords: BaseRecord[] = relationRecords.filter(
      (record: BaseRecord): boolean => {
        const sourceIds: string[] = linkedIds(record.fields['源需求']);
        const targetIds: string[] = linkedIds(record.fields['目标需求']);
        return sourceIds.includes(recordId) || targetIds.includes(recordId);
      },
    );
    const relatedRequirementIds: string[] = [
      ...new Set(
        relatedRelationRecords.flatMap((record: BaseRecord): string[] => {
          const ids: string[] = [
            ...linkedIds(record.fields['源需求']),
            ...linkedIds(record.fields['目标需求']),
          ];
          return ids.filter((id: string): boolean => id !== recordId);
        }),
      ),
    ];
    const titleEntries: Array<[string, string] | null> = await Promise.all(
      relatedRequirementIds.map(
        async (id: string): Promise<[string, string] | null> => {
          try {
            const related: BaseRecord = await this.feishu.getRecord(
              this.table('FEISHU_REQUIREMENTS_TABLE'),
              id,
            );
            return [id, textValue(related.fields['需求']) || '关联需求'];
          } catch (error) {
            this.logger.warn(
              `关联需求 ${id} 读取失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
        },
      ),
    );
    const titleById: Map<string, string> = new Map(
      titleEntries.filter(
        (entry: [string, string] | null): entry is [string, string] =>
          entry !== null,
      ),
    );
    const relations: RelationSummary[] = relatedRelationRecords.map(
      (record: BaseRecord): RelationSummary => {
        const fields: Record<string, unknown> = record.fields;
        const sourceIds: string[] = linkedIds(fields['源需求']);
        const targetIds: string[] = linkedIds(fields['目标需求']);
        const otherId: string = sourceIds.includes(recordId)
          ? targetIds[0] || ''
          : sourceIds[0] || '';
        return {
          id: record.record_id,
          type: textValue(fields['关系类型']),
          description: textValue(fields['关系说明']),
          sourceRequirementIds: sourceIds,
          targetRequirementIds: targetIds,
          targetTitle: titleById.get(otherId) || '关联需求',
          createdByName:
            textValue(fields['创建人名称']) ||
            people(fields['创建人'])[0]?.name ||
            '',
          createdAt: (fields['创建时间'] as string | number | null) || null,
        };
      },
    );
    const activities: ActivitySummary[] = eventRecords
      .filter((record: BaseRecord): boolean =>
        linkedIds(record.fields['需求']).includes(recordId),
      )
      .map((record: BaseRecord): ActivitySummary => {
        const before: Record<string, unknown> | null = eventSnapshot(
          record.fields['变更前'],
        );
        const after: Record<string, unknown> | null = eventSnapshot(
          record.fields['变更后'],
        );
        const changes = !after
          ? []
          : Object.entries(ACTIVITY_FIELD_LABELS)
              .filter(([key]): boolean => {
                if (before && !Object.hasOwn(before, key)) return false;
                return (
                  JSON.stringify(comparableActivityValue(before?.[key])) !==
                  JSON.stringify(comparableActivityValue(after[key]))
                );
              })
              .map(([key, label]) => ({
                field: label,
                before: displayActivityValue(
                  key,
                  before?.[key],
                  iterationNames,
                ),
                after: displayActivityValue(key, after[key], iterationNames),
              }));
        const actor: unknown = after?.modifiedBy;
        const actorName: string =
          actor && typeof actor === 'object'
            ? String(
                (actor as Record<string, unknown>).name ||
                  (actor as Record<string, unknown>).id ||
                  '',
              )
            : '';
        return {
          id: record.record_id,
          type: textValue(record.fields['事件类型']),
          status: textValue(record.fields['状态']),
          summary: textValue(record.fields['负载摘要']),
          source: textValue(record.fields['触发来源']),
          actorName,
          changes,
          createdAt:
            (record.fields['创建时间'] as string | number | null) ||
            (record.fields['更新时间'] as string | number | null) ||
            null,
        };
      })
      .sort(
        (left: ActivitySummary, right: ActivitySummary): number =>
          Number(timestamp(right.createdAt) || 0) -
          Number(timestamp(left.createdAt) || 0),
      )
      .slice(0, 20);
    return {
      requirement,
      comments,
      acceptanceItems,
      relations,
      activities,
    };
  }
}
