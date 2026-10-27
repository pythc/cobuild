import type {
  IterationMilestone,
  RequirementIterationWorkflow,
} from './iteration-workflow';
export type WorkspaceView =
  | 'my-work'
  | 'requirements'
  | 'iterations'
  | 'pull-requests'
  | 'notifications';

export interface GitHubActorSummary {
  login: string;
  avatarUrl: string;
}

export interface GitHubReviewerCandidate extends GitHubActorSummary {
  feishuEmployeeId: string;
  feishuName: string;
}

export interface PullRequestReviewerBindingInput {
  login: string;
  feishuEmployeeId: string;
}

export interface PullRequestCommentSummary {
  id: string;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
  author: GitHubActorSummary;
  path?: string;
  line?: number | null;
}

export interface PullRequestReviewSummary {
  id: string;
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
  author: GitHubActorSummary;
}

export interface PullRequestReviewThreadSummary {
  id: string;
  resolved: boolean;
  outdated: boolean;
  comments: PullRequestCommentSummary[];
}

export interface PullRequestCheckSummary {
  kind: 'check-run' | 'status-context';
  name: string;
  status: string;
  conclusion: string;
  url: string;
  completedAt: string | null;
}

export interface PullRequestRequirementLink {
  id: string;
  code: string;
  title: string;
  url: string;
  gitBranchName: string;
  githubPullRequestUrl: string;
  iterationIds: string[];
  iterationNames: string[];
}

export interface PullRequestSummary {
  repository: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  url: string;
  author: GitHubActorSummary;
  headRef: string;
  baseRef: string;
  mergeable: string;
  reviewDecision: string;
  checksStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  commentCount: number;
  reviewCount: number;
  reviewThreadCount: number;
  createdAt: string | null;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  syncedAt: string;
  linkedRequirements: PullRequestRequirementLink[];
  linkedIterationIds: string[];
  linkedIterationNames: string[];
  requestedReviewers: GitHubActorSummary[];
}

export interface PullRequestDetailResponse {
  pullRequest: PullRequestSummary;
  canManageReviewers: boolean;
  reviewerCandidates: GitHubReviewerCandidate[];
  comments: PullRequestCommentSummary[];
  completeness?: {
    comments: PullRequestCollectionCompleteness;
    reviews: PullRequestCollectionCompleteness;
    reviewThreads: PullRequestCollectionCompleteness;
  };
  reviews: PullRequestReviewSummary[];
  reviewThreads: PullRequestReviewThreadSummary[];
  checks: PullRequestCheckSummary[];
  reviewerNotifications: PullRequestReviewerNotificationSummary[];
}

export interface PullRequestCollectionCompleteness {
  loadedCount: number;
  totalCount: number;
  complete: boolean;
}

export interface PullRequestReviewerNotificationSummary {
  id: string;
  reviewerName: string;
  githubLogin: string;
  assignedByName: string;
  status: 'pending' | 'retrying' | 'delivered' | 'failed' | 'suppressed';
  attempts: number;
  errorMessage: string;
  createdAt: string;
  deliveredAt: string | null;
}

export type NotificationDeliveryStatus =
  | 'pending'
  | 'retrying'
  | 'delivered'
  | 'failed'
  | 'suppressed';

export interface NotificationDeliveryStats {
  total: number;
  pending: number;
  retrying: number;
  failed: number;
  delivered: number;
  suppressed: number;
  reconciling: number;
}

export interface NotificationDeliverySummary {
  id: string;
  kind: 'pull_request_reviewer';
  channel: 'feishu_private';
  status: NotificationDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  errorMessage: string;
  suppressionReason: string;
  recipientName: string;
  recipientEmployeeId: string;
  githubLogin: string;
  assignedByName: string;
  assignedByUserId: string;
  repository: string;
  pullNumber: number;
  pullTitle: string;
  pullPlatformUrl: string;
  pullExternalUrl: string;
  queuedAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
}

export interface NotificationDeliveryListResponse {
  fetchedAt: string;
  items: NotificationDeliverySummary[];
  stats: NotificationDeliveryStats;
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  coverage: {
    includedKinds: Array<NotificationDeliverySummary['kind']>;
    note: string;
  };
}

export interface PullRequestWorkspaceStats {
  total: number;
  open: number;
  waitingReview: number;
  changesRequested: number;
  checksFailed: number;
}

export interface PullRequestWorkspaceResponse {
  repository: string;
  fetchedAt: string;
  syncedAt: string | null;
  stale: boolean;
  syncWarning: string;
  stats: PullRequestWorkspaceStats;
  iterations: IterationSummary[];
  reviewerCandidates: GitHubReviewerCandidate[];
  pullRequests: PullRequestSummary[];
}

export interface PullRequestReviewerUpdateInput {
  reviewerLogins: string[];
  reviewerBindings?: PullRequestReviewerBindingInput[];
}

export interface PullRequestReviewerUpdateResult {
  success: boolean;
  message: string;
  reviewerLogins: string[];
  notificationQueuedCount: number;
}

export interface PullRequestRefreshResult {
  success: boolean;
  message: string;
  syncedCount: number;
  syncedAt: string;
}

export interface PersonRef {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface CurrentUserSummary {
  miaodaUserId: string;
  employeeId: string;
  openId: string;
  name: string;
  /** Miaoda app id used to rebuild platform authorization off-request. */
  platformAppId?: string;
  /** Normalized requirement-platform roles. */
  roles?: string[];
  /** Raw Miaoda platform role ids retained for authorization audit. */
  platformRoleIds?: string[];
  /** Effective access tier. A general member is never represented as editor. */
  accessLevel?: 'admin' | 'editor' | 'viewer' | 'member';
  capabilities?: RequirementPlatformCapabilities;
}

export interface RequirementPlatformCapabilities {
  canCreate: boolean;
  canViewArchive: boolean;
  canPermanentlyDelete: boolean;
  canViewNotifications: boolean;
  canViewOperations?: boolean;
  canManageOperationsAdmins?: boolean;
}

export interface OperationsAccess {
  userId: string;
  role: 'super_admin' | 'operations_admin' | 'member';
  canViewAll: boolean;
  canManageAdmins: boolean;
  canViewNotifications: boolean;
}

export type OperationStageStatus =
  | 'succeeded'
  | 'failed'
  | 'pending'
  | 'unknown';
export interface OperationStage {
  key: 'write' | 'history' | 'review' | 'notification';
  label: string;
  status: OperationStageStatus;
  detail: string;
}
export interface OperationRecord extends RequirementUpdateJobSummary {
  requirementCode?: string;
  source?: string;
  traceId?: string;
  executionStage?: string;
  workflowVersion?: string;
  actorUserId: string;
  actorName: string;
  intent: 'edit' | 'status-transition';
  fields: string[];
  targetStatus: string;
  errorCode: string;
  stages: OperationStage[];
}
export interface OperationListQuery {
  requirementCode?: string;
  pullNumber?: number;
  since?: string;
  until?: string;
  scope?: 'mine' | 'all';
  status?: RequirementUpdateJobStatus | 'all';
  requirementId?: string;
  operationId?: string;
  page?: number;
  pageSize?: number;
}
export interface OperationListResponse {
  fetchedAt: string;
  scope: 'mine' | 'all';
  items: OperationRecord[];
  stats: Record<RequirementUpdateJobStatus | 'total', number>;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}
export interface OperationProgressResponse extends Omit<
  OperationListResponse,
  'items'
> {
  items: RequirementUpdateJobSummary[];
}
export interface OperationsReviewRecord {
  id: string;
  requirementId: string;
  reviewType: string;
  status: string;
  score: number | null;
  attempts: number;
  errorMessage: string;
  updatedAt: string | null;
}
export interface OperationsReviewListResponse {
  items: OperationsReviewRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
export type { ForceRoleDTO } from '@lark-apaas/fullstack-nestjs-core';
export interface OperationsRoleMemberInput {
  userId: string;
  action: 'add' | 'remove';
}
export interface WorkflowNotificationRecord {
  id: string;
  requirementIds: string[];
  eventType: string;
  source: string;
  status: string;
  attempts: number;
  errorMessage: string;
  summary: string;
  updatedAt: string | null;
}
export interface WorkflowNotificationListResponse {
  items: WorkflowNotificationRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  coverageNote: string;
}

export interface McpCredentialStatus {
  available: boolean;
  issued: boolean;
  endpoint: string;
  personalTokenPreview: string;
  userName: string;
}

export interface McpCredentialResponse extends McpCredentialStatus {
  openApiKey: string;
  personalToken: string;
}

export interface McpCredentialExchangeInput {
  publicKey: string;
  requestNonce: string;
}

export interface McpEncryptedCredentialResponse extends McpCredentialStatus {
  version: 1;
  algorithm: 'RSA-OAEP-256+A256GCM';
  requestNonce: string;
  encryptedKey: string;
  iv: string;
  ciphertext: string;
}

export interface IterationSummary {
  configurationVersion?: number;
  milestones?: IterationMilestone[];
  id: string;
  name: string;
  status: string;
  goal: string;
  owner: PersonRef[];
  startAt: string | number | null;
  endAt: string | number | null;
  reviewAt: string | number | null;
  developmentAt: string | number | null;
  testingAt: string | number | null;
  releaseAt: string | number | null;
  requirementCount: number;
  completedCount: number;
  completionRate: number;
}

export interface RequirementSummary {
  /** Opaque, server-written source marker; not an editable business field. */
  notificationMarker?: string;
  contentOmitted?: boolean;
  /** Plain text preview only; never use as editable full content. */
  introductionPreview?: string;
  workflow?: RequirementIterationWorkflow;
  id: string;
  code: string;
  title: string;
  url: string;
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
  allowedStatuses: string[];
  priority: string;
  project: string;
  iterationIds: string[];
  iterationNames: string[];
  handlers: PersonRef[];
  productOwners: PersonRef[];
  developers: PersonRef[];
  testers: PersonRef[];
  foOwners: PersonRef[];
  proposers: PersonRef[];
  followers: PersonRef[];
  releaseOwners: PersonRef[];
  personnelUserIds: RequirementPersonnelUserIds;
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
  updatedAt: string | number | null;
  updatedByName: string;
  groupChatId: string;
  groupLink: string;
  groupStatus: string;
  isMine: boolean;
  risks: string[];
  capabilities: RequirementItemCapabilities;
}

export interface RequirementItemCapabilities {
  canUpdate: boolean;
  canArchive: boolean;
  canManageGroup: boolean;
  canManageAcceptance: boolean;
  canManageRelations: boolean;
  canComment: boolean;
}

export interface RequirementPersonnelUserIds {
  handlers: string[];
  productOwners: string[];
  developers: string[];
  testers: string[];
  foOwners: string[];
  proposers: string[];
  followers: string[];
  releaseOwners: string[];
}

export interface WorkspaceStats {
  total: number;
  mine: number;
  inProgress: number;
  blocked: number;
  overdue: number;
  completed: number;
}

export interface WorkspaceOptions {
  statuses: string[];
  priorities: string[];
  projects: string[];
  types: string[];
  sources: string[];
  tags: string[];
}

export interface RequirementEditContext {
  iterations: IterationSummary[];
  options: WorkspaceOptions;
}

export type RequirementListRiskFilter =
  | 'in-progress'
  | 'overdue'
  | 'blocked'
  | 'unassigned'
  | 'missing-personnel'
  | 'missing-product'
  | 'missing-developer'
  | 'missing-tester'
  | 'unplanned'
  | 'missing-progress';

export type RequirementListSortBy =
  | 'risk'
  | 'updatedAt'
  | 'deadlineAt'
  | 'priority'
  | 'status'
  | 'title';

export type RequirementListSortOrder = 'asc' | 'desc';

export type RequirementListGroupBy =
  | 'status'
  | 'iteration'
  | 'project'
  | 'priority'
  | 'handler'
  | 'product'
  | 'developer'
  | 'tester'
  | 'fo';

export interface RequirementListQuery {
  includeContent?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  priority?: string;
  project?: string;
  type?: string;
  source?: string;
  iterationId?: string;
  handlerId?: string;
  productOwnerId?: string;
  developerId?: string;
  testerId?: string;
  foOwnerId?: string;
  risk?: RequirementListRiskFilter;
  mineOnly?: boolean;
  excludeId?: string;
  groupBy?: RequirementListGroupBy;
  sortBy?: RequirementListSortBy;
  sortOrder?: RequirementListSortOrder;
}

export interface RequirementPeopleOptions {
  handlers: PersonRef[];
  productOwners: PersonRef[];
  developers: PersonRef[];
  testers: PersonRef[];
  foOwners: PersonRef[];
}

export interface WorkspaceSummaryResponse {
  freshness?: import('./workspace-efficiency').WorkspaceDataFreshness;
  fetchedAt: string;
  currentUser: CurrentUserSummary;
  stats: WorkspaceStats;
  iterations: IterationSummary[];
  options: WorkspaceOptions;
  peopleOptions: RequirementPeopleOptions;
}

export interface RequirementListResponse extends WorkspaceSummaryResponse {
  items: RequirementSummary[];
  groups?: RequirementListGroup[];
  groupCount?: number;
  /** Number of rendered requirement rows before pagination. */
  rowTotal: number;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sortBy: RequirementListSortBy;
  sortOrder: RequirementListSortOrder;
}

export interface RequirementListGroup {
  key: string;
  label: string;
  items: RequirementSummary[];
  /** Total rows in this group across all pages. */
  totalCount: number;
}

export interface WorkspaceResponse {
  freshness?: import('./workspace-efficiency').WorkspaceDataFreshness;
  fetchedAt: string;
  currentUser: CurrentUserSummary;
  stats: WorkspaceStats;
  iterations: IterationSummary[];
  requirements: RequirementSummary[];
  options: WorkspaceOptions;
}

/** Complete, lightweight browser index; never a page or a truncated subset. */
export interface WorkspaceBrowserResponse extends WorkspaceResponse {
  complete: true;
  peopleOptions: RequirementPeopleOptions;
}

export interface RequirementPatch {
  title?: string;
  introduction?: string;
  acceptanceCriteria?: string;
  selfTestReport?: string;
  defectCause?: string;
  gitBranchName?: string;
  githubPullRequestUrl?: string;
  type?: string;
  source?: string;
  tags?: string[];
  status?: string;
  priority?: string;
  project?: string;
  /** At most one iteration ID; [] explicitly clears the assignment. */
  iterationIds?: string[];
  handlerUserIds?: string[];
  productOwnerUserIds?: string[];
  developerUserIds?: string[];
  testerUserIds?: string[];
  foOwnerUserIds?: string[];
  proposerUserIds?: string[];
  followerUserIds?: string[];
  releaseOwnerUserIds?: string[];
  handlerLarkUserIds?: string[];
  productOwnerLarkUserIds?: string[];
  developerLarkUserIds?: string[];
  testerLarkUserIds?: string[];
  foOwnerLarkUserIds?: string[];
  proposerLarkUserIds?: string[];
  followerLarkUserIds?: string[];
  releaseOwnerLarkUserIds?: string[];
  startAt?: number | null;
  deadlineAt?: number | null;
  developmentStartAt?: number | null;
  developmentEndAt?: number | null;
  testingAt?: number | null;
  actualStartAt?: number | null;
  actualTestingAt?: number | null;
  actualReleaseAt?: number | null;
  effort?: number | null;
  latestProgress?: string;
  blocked?: boolean;
  blocker?: string;
}

export interface RequirementCreateInput extends RequirementPatch {
  title: string;
}

export interface RequirementUpdateInput {
  /** Explicit user-led correction of their own failed operation, never an automatic replay. */
  recoveryOf?: string;
  /** Stable across network retries; generated once per user action. */
  clientMutationId?: string;
  source?: 'web' | 'mcp' | 'bulk';
  /** Values the editor actually saw, only for fields being changed. */
  baseValues?: RequirementPatch;
  personnelChanges?: Partial<
    Record<
      keyof RequirementPersonnelUserIds,
      {
        add: string[];
        remove: string[];
        identityType: 'feishu';
      }
    >
  >;
  expectedUpdatedAt: string | number | null;
  intent?: 'edit' | 'status-transition';
  patch: RequirementPatch;
}

export interface MutationResult {
  success: boolean;
  message: string;
  recordId?: string;
  updatedFields?: string[];
  operationStages?: OperationStage[];
  errorCode?: string;
}

export type RequirementUpdateJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export interface RequirementUpdateJobAccepted extends MutationResult {
  jobId: string;
  jobStatus: RequirementUpdateJobStatus;
}

export interface RequirementUpdateJobSummary {
  id: string;
  requirementId: string;
  status: RequirementUpdateJobStatus;
  attempts: number;
  result: MutationResult | null;
  errorMessage: string;
  createdAt: string | number | null;
  finishedAt: string | number | null;
}

export interface BulkRequirementUpdateItem {
  recordId: string;
  expectedUpdatedAt: string | number | null;
}

export type BulkRequirementPatch = Pick<
  RequirementPatch,
  'status' | 'priority' | 'project' | 'iterationIds'
>;

export interface BulkRequirementUpdateInput {
  items: BulkRequirementUpdateItem[];
  patch: BulkRequirementPatch;
}

export interface BulkMutationResult extends MutationResult {
  batchId?: string;
  items?: import('./requirement-batch').RequirementBatchItem[];
  affectedCount: number;
  skippedCount: number;
  recordIds: string[];
}

export interface CommentSummary {
  id: string;
  content: string;
  author: PersonRef | null;
  authorName: string;
  createdAt: string | number | null;
  updatedAt: string | number | null;
  edited: boolean;
}

export interface AcceptanceItemSummary {
  id: string;
  title: string;
  completed: boolean;
  owner: PersonRef[];
  note: string;
  createdAt: string | number | null;
  updatedAt: string | number | null;
}

export interface RelationSummary {
  id: string;
  type: string;
  description: string;
  sourceRequirementIds: string[];
  targetRequirementIds: string[];
  targetTitle: string;
  createdByName: string;
  createdAt: string | number | null;
}

export interface ActivitySummary {
  id: string;
  type: string;
  status: string;
  summary: string;
  source: string;
  actorName: string;
  changes: ActivityFieldChange[];
  createdAt: string | number | null;
}

export interface ActivityFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface RequirementDetailResponse {
  requirement: RequirementSummary;
  comments: CommentSummary[];
  acceptanceItems: AcceptanceItemSummary[];
  relations: RelationSummary[];
  activities: ActivitySummary[];
}

export type RequirementArtifactKind = 'technical_design' | 'self_test_report';

export type RequirementArtifactSourceType = 'inline' | 'feishu_doc';

export type RequirementAiReviewType =
  | 'clarity'
  | 'technical_stability'
  | 'delivery_readiness';

export type RequirementAiReviewStatus =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export type RequirementAiReviewVerdict =
  | 'passed'
  | 'needs_attention'
  | 'blocked';

export interface RequirementArtifactSummary {
  kind: RequirementArtifactKind;
  sourceType: RequirementArtifactSourceType;
  content: string;
  documentUrl: string;
  documentTitle: string;
  readable: boolean;
  errorMessage: string;
  updatedByName: string;
  updatedAt: string | null;
}

export interface RequirementAiReviewDimension {
  key: string;
  label: string;
  score: number;
  weight: number;
  comment: string;
}

export interface RequirementAiReviewFinding {
  severity: 'blocker' | 'warning' | 'suggestion';
  title: string;
  description: string;
  recommendation: string;
}

export interface RequirementAiReviewSummary {
  id: string;
  type: RequirementAiReviewType;
  status: RequirementAiReviewStatus;
  verdict: RequirementAiReviewVerdict | null;
  score: number | null;
  summary: string;
  dimensions: RequirementAiReviewDimension[];
  findings: RequirementAiReviewFinding[];
  current: boolean;
  model: string;
  errorMessage: string;
  overridden: boolean;
  overrideReason: string;
  overriddenByName: string;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface RequirementEngineeringResponse {
  requirementId: string;
  artifacts: Record<RequirementArtifactKind, RequirementArtifactSummary | null>;
  reviews: Record<RequirementAiReviewType, RequirementAiReviewSummary>;
  history: RequirementAiReviewSummary[];
  canUpdate: boolean;
  canOverride: boolean;
}

export interface RequirementArtifactUpsertInput {
  sourceType: RequirementArtifactSourceType;
  content?: string;
  documentUrl?: string;
}

export interface RequirementAiReviewOverrideInput {
  reason: string;
}

export interface RequirementPersonnelResponse {
  recordId: string;
  updatedAt: string | number | null;
  personnelUserIds: RequirementPersonnelUserIds;
}

export interface RequirementArchiveSummary {
  requirementId: string;
  code: string;
  title: string;
  archivedAt: string;
  archivedByName: string;
  deletionStatus: 'idle' | 'deleting' | 'failed';
  deletionError: string;
}

export interface RequirementArchiveListResponse {
  items: RequirementArchiveSummary[];
}

export interface RequirementReleaseReadinessCheck {
  key: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
  url?: string;
}

export interface RequirementReleaseReadiness {
  requirementId: string;
  targetStatus: string;
  ready: boolean;
  checks: RequirementReleaseReadinessCheck[];
  blockingReasons: string[];
}

export interface CommentCreateInput {
  content: string;
}

export interface AcceptanceCreateInput {
  title: string;
  note?: string;
  ownerUserIds?: string[];
}

export interface AcceptanceUpdateInput {
  completed?: boolean;
  title?: string;
  note?: string;
  ownerUserIds?: string[];
}

export interface RelationCreateInput {
  targetRequirementId: string;
  type: '依赖' | '被依赖' | '相关' | '重复';
  description?: string;
}

export type GroupAction = 'create' | 'sync';

/** First-party project registration, authorized by a route-scoped OpenAPI key. */
export interface PortalProjectSyncRequest {
  sourceProjectId: string;
  name: string;
  summary: string;
  revision?: number;
  snapshot?: ProjectManagementSnapshot;
}
export interface PortalProjectLookupRequest {
  sourceProjectId: string;
}
export interface PortalProjectSummary {
  sourceProjectId: string;
  projectId: string;
  projectName: string;
  projectSummary: string;
  projectUrl: string;
  revision?: number;
  digest?: string | null;
}
export interface PortalProjectLookupResponse {
  project: PortalProjectSummary | null;
}

export interface ProjectManagementSnapshot {
  phase: 'exploring' | 'pending' | 'active' | 'needs_changes' | 'unconfigured';
  archived: boolean;
  ownerName: string;
  memberNames: string[];
  application: string;
  reviewNote: string;
  aliases: string[];
  links: {
    repository: string;
    requirements: string;
    docs: string;
    knowledgeSpace?: string;
    demo: string;
  };
  milestones: {
    id: string;
    title: string;
    assigneeName: string;
    dueAt: string | null;
    status: 'open' | 'done';
  }[];
  createdAt: string;
  updatedAt: string;
}
export interface ManagedProject extends PortalProjectSummary {
  sourceUrl: string;
  snapshot: ProjectManagementSnapshot | null;
  syncedAt: string;
}
export interface ProjectCatalogEntry {
  id: string;
  name: string;
}
export interface ProjectCatalogResponse {
  categories: ProjectCatalogEntry[];
}
export interface ProjectManagementResponse {
  projects: ManagedProject[];
}

/** Relay uses the signed-in Makit identity. Chatwoot credentials never reach the browser. */
export interface RelayProfile {
  id: string;
  name: string;
  role: 'operator' | 'handler';
  authenticated: true;
  mode: 'live-chatwoot';
  identity: 'cobuild';
}
export interface RelayAttachment {
  id?: string;
  name: string;
  kind: string;
  size: string;
  url?: string;
  data?: string;
}
export interface RelayMessage {
  id: string;
  side: 'customer' | 'operator' | 'system';
  senderName: string;
  content: string;
  time: string;
  private: boolean;
  attachments: RelayAttachment[];
}
export interface RelayConversation {
  id: string;
  app: string;
  name: string;
  title: string;
  state: 'new' | 'open' | 'resolved';
  owner: string;
  time: string;
  messages: RelayMessage[];
}
export interface RelayTicket {
  id: string;
  code: string;
  title: string;
  conversationId: string;
  status: string;
  nativeStatus?: string;
  nativeUrl: string;
  owner: string;
  syncPending?: boolean;
}
export interface RelayState {
  online: true;
  profile: RelayProfile;
  conversations: RelayConversation[];
  tickets: RelayTicket[];
  pendingConversions: {
    conversationId: string;
    title: string;
    state: string;
  }[];
}
export interface RelayCreateTicket {
  conversationId: string;
  title: string;
  description: string;
  priority: '较低' | '普通' | '紧急';
  handlerIds: string[];
}
export interface RelaySendMessage {
  content: string;
  private: boolean;
  attachments: RelayAttachment[];
}
