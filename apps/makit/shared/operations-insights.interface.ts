export type DependencyName =
  | 'feishu'
  | 'github'
  | 'deepseek'
  | 'database'
  | 'experience';
export type DependencyOutcome =
  | 'success'
  | 'timeout'
  | 'rate_limited'
  | 'permission'
  | 'validation'
  | 'network'
  | 'server_error'
  | 'unknown';
export interface DependencyMetric {
  dependency: DependencyName;
  operation: string;
  count: number;
  failures: number;
  validationRejections: number;
  p50Ms: number;
  p95Ms: number;
  latestAt: string | null;
  outcomes: Partial<Record<DependencyOutcome, number>>;
}
export interface ScannerHeartbeat {
  scanner: string;
  instanceId: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  status: string;
  stale: boolean;
  errorCode: string | null;
  buildVersion: string | null;
}
export interface AiPricing {
  version: string;
  model: string;
  currency: 'CNY' | 'USD';
  inputPerMillion: number;
  cachedInputPerMillion: number | null;
  outputPerMillion: number;
  effectiveAt: string;
}
export interface AiRuntimePolicy {
  concurrency: number;
  debounceSeconds: number;
  dailyBudget: number | null;
  pricing: AiPricing | null;
}
export interface AlertRuntimePolicy {
  enabled: boolean;
  receiverUserIds: string[];
  minimumSamples: number;
  consecutiveWindows: number;
  cooldownMinutes: number;
  backlogMinutes: number;
  heartbeatMinutes: number;
  failureRatePercent: number;
}
export interface OperationsSettings {
  revision: number;
  ai: AiRuntimePolicy;
  alerts: AlertRuntimePolicy;
}
export interface AiExecutionSummary {
  id: string;
  reviewId: string;
  requirementId: string;
  batchId: string;
  attempt: number;
  reviewType: string;
  sourceHash: string;
  model: string;
  ruleSetVersion: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  pricingVersion: string | null;
  estimatedCost: number | null;
  currency: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  feedback: 'adopted' | 'ignored' | null;
  feedbackReason: string | null;
}
export interface AiExecutionsResponse {
  items: AiExecutionSummary[];
  total: number;
  page: number;
  pageCount: number;
  usage: {
    executionCount: number;
    inputTokens: number;
    outputTokens: number;
    unknownUsageCount: number;
    unknownCostCount: number;
    estimatedCosts: Array<{ currency: string; amount: number }>;
    budgetExceeded: boolean;
  };
}
export interface AlertIncident {
  id: string;
  ruleKey: string;
  scope: string;
  status: 'pending' | 'open' | 'recovered';
  firstSeenAt: string;
  lastSeenAt: string;
  openedAt: string | null;
  recoveredAt: string | null;
  consecutiveWindows: number;
  notificationState: string;
  evidence: { title: string; actual: number; threshold: number; unit: string };
}
export interface OperationsHealth {
  fetchedAt: string;
  since: string;
  database: { available: boolean; durationMs: number };
  process: { uptimeSeconds: number; buildVersion: string | null };
  dependencies: DependencyMetric[];
  scanners: ScannerHeartbeat[];
  business: {
    accepted: number;
    confirmed: number;
    failed: number;
    validationRejected?: number;
    recovery?: { failed: number; corrected: number; percent: number | null };
    unknown: number;
    queued: number;
    oldestQueuedAt: string | null;
    aiQueued: number;
    aiRunning: number;
    aiSuperseded: number;
    stalePrSnapshots: number;
    notificationUnknown: number;
  };
  probe: { configured: boolean; externalRunnerVerified: false; path: string };
  sampling: { retainedDays: number; droppedSinceStart: number };
}
export interface IterationStatusAnalysis {
  id: string;
  status: string;
  stage:
    | 'intake'
    | 'development'
    | 'testing'
    | 'experience'
    | 'release'
    | 'done';
  start: boolean;
  terminal: boolean;
}
export interface IterationAnalysisConfiguration {
  clock: 'calendar' | 'weekdays';
  timezone: 'Asia/Shanghai';
  excludeBlockedTime: boolean;
  statuses: Record<'requirement' | 'defect', IterationStatusAnalysis[]>;
  milestoneGates: Record<
    string,
    { requirementStatusId: string; defectStatusId: string | null }
  >;
}
export interface IterationEfficiencyRequirement {
  id: string;
  code: string;
  title: string;
  kind: 'requirement' | 'defect';
  status: string;
  stage: string;
  enteredAt: string | null;
  dwellHours: number | null;
  waitingFor: string[];
  missingFields: string[];
  blocked: boolean;
  blockingRequirementIds: string[];
  milestoneRisks: string[];
  returns: number;
  reopens: number;
  deadline: string | null;
  completedAt: string | null;
  sourceEventIds: string[];
  operationIds: string[];
  historyComplete: boolean;
}
export interface IterationEfficiencyResponse {
  iterationId: string;
  iterationName: string;
  fetchedAt: string;
  clock: 'calendar' | 'weekdays';
  timezone: string;
  excludeBlockedTime: boolean;
  configurationVersion: number | null;
  historyMissing: number;
  requirements: IterationEfficiencyRequirement[];
  distributions: Array<{
    kind: 'requirement' | 'defect';
    stage: string;
    count: number;
    medianHours: number | null;
    p85Hours: number | null;
    requirementIds: string[];
  }>;
  scopeChanges: Array<{
    eventId: string;
    operationId: string | null;
    requirementId: string;
    kind: 'added' | 'removed';
    at: string;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    requirementIds: string[];
    firstReviewHours: number | null;
    lastReviewAt: string | null;
    waitingReviewHours: number | null;
    repeatReviewHours?: number | null;
    repeatReviewSamples?: number;
    basis: string;
    complete: boolean;
  }>;
  coverage: string[];
}
