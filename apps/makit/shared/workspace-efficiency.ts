import type {
  AcceptanceItemSummary,
  ActivitySummary,
  CommentSummary,
  RelationSummary,
  RequirementListQuery,
  RequirementSummary,
} from './api.interface';

export interface WorkspaceDataFreshness {
  loadedAt: string;
  stale: boolean;
  sourceVersion?: number;
  warning?: string;
}

export interface SavedViewConfig {
  query: Omit<RequirementListQuery, 'page' | 'excludeId'>;
  viewMode?: 'list' | 'cards';
  columnWidths?: Record<string, number>;
}

export interface WorkspaceSavedView {
  id: string;
  ownerUserId: string;
  scope: 'personal' | 'team';
  name: string;
  config: SavedViewConfig;
  version: number;
  canEdit: boolean;
}

export interface WorkspaceSavedViewInput {
  name: string;
  scope: 'personal' | 'team';
  config: SavedViewConfig;
  expectedVersion?: number;
}

export interface WorkspaceSavedViewsResponse {
  userId: string;
  items: WorkspaceSavedView[];
  canManageTeamViews: boolean;
}

export type RequirementDetailSection =
  | 'comments'
  | 'acceptance'
  | 'relations'
  | 'activities';

export interface RequirementDetailCoreResponse {
  requirement: RequirementSummary;
  freshness: WorkspaceDataFreshness;
}

export interface RequirementDetailSectionItems {
  comments: CommentSummary[];
  acceptance: AcceptanceItemSummary[];
  relations: RelationSummary[];
  activities: ActivitySummary[];
}

export interface RequirementDetailSectionResponse<
  T extends RequirementDetailSection = RequirementDetailSection,
> {
  requirementId: string;
  section: T;
  items: RequirementDetailSectionItems[T];
  freshness: WorkspaceDataFreshness;
}

const QUERY_STRING_KEYS = new Set([
  'search',
  'status',
  'priority',
  'project',
  'type',
  'source',
  'iterationId',
  'handlerId',
  'productOwnerId',
  'developerId',
  'testerId',
  'foOwnerId',
]);
const ENUMS: Record<string, readonly string[]> = {
  risk: [
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
  ],
  groupBy: [
    'status',
    'priority',
    'project',
    'iteration',
    'handler',
    'product',
    'developer',
    'tester',
    'fo',
  ],
  sortBy: ['updatedAt', 'deadlineAt', 'priority', 'status', 'title', 'risk'],
  sortOrder: ['asc', 'desc'],
};
const COLUMNS = new Set([
  'select',
  'title',
  'status',
  'handler',
  'product',
  'developer',
  'tester',
  'fo',
  'priority',
  'iteration',
  'deadline',
  'risk',
]);

/** Saved views are filters, never arbitrary URLs or executable configuration. */
export function validateSavedViewConfig(raw: unknown): raw is SavedViewConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['query', 'viewMode', 'columnWidths'].includes(key),
    )
  )
    return false;
  if (
    !value.query ||
    typeof value.query !== 'object' ||
    Array.isArray(value.query)
  )
    return false;
  for (const [key, item] of Object.entries(value.query)) {
    if (QUERY_STRING_KEYS.has(key)) {
      if (typeof item !== 'string' || item.length > 500) return false;
    } else if (key in ENUMS) {
      if (typeof item !== 'string' || !ENUMS[key].includes(item)) return false;
    } else if (key === 'mineOnly' || key === 'participatingOnly') {
      if (typeof item !== 'boolean') return false;
    } else if (key === 'pageSize') {
      if (!Number.isInteger(item) || Number(item) < 1 || Number(item) > 100)
        return false;
    } else return false;
  }
  if (
    value.viewMode !== undefined &&
    !['list', 'cards'].includes(String(value.viewMode))
  )
    return false;
  if (value.columnWidths !== undefined) {
    if (
      !value.columnWidths ||
      typeof value.columnWidths !== 'object' ||
      Array.isArray(value.columnWidths)
    )
      return false;
    for (const [key, width] of Object.entries(value.columnWidths)) {
      if (
        !COLUMNS.has(key) ||
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        width < 32 ||
        width > 1600
      )
        return false;
    }
  }
  return JSON.stringify(raw).length <= 10_000;
}
