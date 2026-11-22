import {
  requirementListStats,
  requirementListPeopleOptions,
} from './requirement-list-metadata';
import type {
  CurrentUserSummary,
  PersonRef,
  RequirementSummary,
  RequirementListQuery,
  RequirementListGroup,
  RequirementListGroupBy,
  RequirementListResponse,
  RequirementListRiskFilter,
  RequirementListSortBy,
  RequirementListSortOrder,
  WorkspaceResponse,
} from './api.interface';
import { isTicketType, requirementInProgress } from './ticket-workflow';
import {
  normalizeRequirementStatus,
  workflowStatusSortRank,
  timestamp,
} from './requirement-list-values';
const uniqueStrings = (values: string[]): string[] => [
  ...new Set(values.filter(Boolean)),
];
interface GroupedRequirementRow {
  groupKey: string;
  groupLabel: string;
  item: RequirementSummary;
}

const GROUP_FIELDS = new Set([
  'status',
  'iteration',
  'project',
  'priority',
  'handler',
  'product',
  'developer',
  'tester',
  'fo',
]);
const DEFAULT_PAGE_SIZE: number = 25;
const MAX_PAGE_SIZE: number = 100;
const REQUIREMENT_SORT_FIELDS: ReadonlySet<RequirementListSortBy> = new Set([
  'risk',
  'updatedAt',
  'deadlineAt',
  'priority',
  'status',
  'title',
]);
const REQUIREMENT_RISK_FILTERS: ReadonlySet<RequirementListRiskFilter> =
  new Set([
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

class RequirementListSelector {
  private normalizedListQuery(
    query: RequirementListQuery,
  ): Required<
    Pick<
      RequirementListQuery,
      'page' | 'pageSize' | 'sortBy' | 'sortOrder' | 'mineOnly'
    >
  > &
    RequirementListQuery {
    const page: number = Math.max(1, Math.trunc(Number(query.page) || 1));
    const pageSize: number = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(Number(query.pageSize) || DEFAULT_PAGE_SIZE)),
    );
    const sortBy: RequirementListSortBy = REQUIREMENT_SORT_FIELDS.has(
      query.sortBy || 'risk',
    )
      ? query.sortBy || 'risk'
      : 'risk';
    const sortOrder: RequirementListSortOrder =
      query.sortOrder === 'asc' ? 'asc' : 'desc';
    return {
      ...query,
      page,
      pageSize,
      sortBy,
      sortOrder,
      mineOnly: query.mineOnly === true,
      groupBy:
        query.groupBy && GROUP_FIELDS.has(query.groupBy)
          ? query.groupBy
          : undefined,
      risk:
        query.risk && REQUIREMENT_RISK_FILTERS.has(query.risk)
          ? query.risk
          : undefined,
    };
  }
  private matchesListQuery(
    item: RequirementSummary,
    query: RequirementListQuery,
    currentPersonIds: ReadonlySet<string>,
  ): boolean {
    const keyword: string = query.search?.trim().toLowerCase() || '';
    if (
      keyword &&
      ![
        item.title,
        item.code,
        item.project,
        item.type,
        item.source,
        item.gitBranchName,
        item.iterationNames.join(' '),
        item.handlers.map((person: PersonRef): string => person.name).join(' '),
        item.productOwners
          .map((person: PersonRef): string => person.name)
          .join(' '),
        item.developers
          .map((person: PersonRef): string => person.name)
          .join(' '),
        item.testers.map((person: PersonRef): string => person.name).join(' '),
        item.foOwners.map((person: PersonRef): string => person.name).join(' '),
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    ) {
      return false;
    }
    if (query.excludeId && item.id === query.excludeId) return false;
    if (
      query.status &&
      item.status !== normalizeRequirementStatus(query.status)
    ) {
      return false;
    }
    if (query.priority && item.priority !== query.priority) return false;
    if (query.project && item.project !== query.project) return false;
    if (query.type && item.type !== query.type) return false;
    if (query.source && item.source !== query.source) return false;
    if (query.iterationId && !item.iterationIds.includes(query.iterationId)) {
      return false;
    }
    if (
      query.handlerId &&
      !item.handlers.some(
        (person: PersonRef): boolean => person.id === query.handlerId,
      )
    ) {
      return false;
    }
    if (
      query.productOwnerId &&
      !item.productOwners.some(
        (person: PersonRef): boolean => person.id === query.productOwnerId,
      )
    ) {
      return false;
    }
    if (
      query.developerId &&
      !item.developers.some(
        (person: PersonRef): boolean => person.id === query.developerId,
      )
    ) {
      return false;
    }
    if (
      query.testerId &&
      !item.testers.some(
        (person: PersonRef): boolean => person.id === query.testerId,
      )
    ) {
      return false;
    }
    if (
      query.foOwnerId &&
      !item.foOwners.some(
        (person: PersonRef): boolean => person.id === query.foOwnerId,
      )
    ) {
      return false;
    }
    if (query.mineOnly && !item.isMine) return false;
    if (
      query.participatingOnly &&
      ![
        item.handlers,
        item.proposers,
        item.productOwners,
        item.developers,
        item.testers,
        item.foOwners,
        item.releaseOwners,
        item.followers,
      ].some((people) => people.some((person) => currentPersonIds.has(person.id)))
    ) {
      return false;
    }
    if (query.risk === 'in-progress' && !requirementInProgress(item)) {
      return false;
    }
    if (
      query.risk === 'overdue' &&
      !item.risks.some((risk: string): boolean => risk.includes('逾期'))
    ) {
      return false;
    }
    if (query.risk === 'blocked' && !item.blocked) return false;
    if (query.risk === 'unassigned' && item.handlers.length > 0) return false;
    if (
      isTicketType(item.type) &&
      [
        'missing-product',
        'missing-developer',
        'missing-tester',
        'unplanned',
      ].includes(query.risk || '')
    )
      return false;
    if (isTicketType(item.type) && query.risk === 'missing-personnel')
      return item.handlers.length === 0;
    if (
      query.risk === 'missing-personnel' &&
      item.handlers.length > 0 &&
      item.productOwners.length > 0 &&
      item.developers.length > 0 &&
      item.testers.length > 0
    ) {
      return false;
    }
    if (query.risk === 'missing-product' && item.productOwners.length > 0) {
      return false;
    }
    if (query.risk === 'missing-developer' && item.developers.length > 0) {
      return false;
    }
    if (query.risk === 'missing-tester' && item.testers.length > 0) {
      return false;
    }
    if (query.risk === 'unplanned' && item.iterationIds.length > 0) {
      return false;
    }
    if (query.risk === 'missing-progress' && item.latestProgress.trim()) {
      return false;
    }
    return true;
  }
  private compareRequirements(
    left: RequirementSummary,
    right: RequirementSummary,
    sortBy: RequirementListSortBy,
    sortOrder: RequirementListSortOrder,
  ): number {
    const direction: number = sortOrder === 'asc' ? 1 : -1;
    let result: number;
    if (sortBy === 'title') {
      result = left.title.localeCompare(right.title, 'zh-CN');
    } else if (sortBy === 'status') {
      result =
        workflowStatusSortRank(left.status) -
        workflowStatusSortRank(right.status);
    } else if (sortBy === 'priority') {
      const priority: ReadonlyMap<string, number> = new Map([
        ['P0', 0],
        ['P1', 1],
        ['P2', 2],
        ['P3', 3],
      ]);
      result =
        (priority.get(left.priority) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.priority) ?? Number.MAX_SAFE_INTEGER);
    } else if (sortBy === 'deadlineAt') {
      result =
        Number(timestamp(left.deadlineAt) || Number.MAX_SAFE_INTEGER) -
        Number(timestamp(right.deadlineAt) || Number.MAX_SAFE_INTEGER);
    } else if (sortBy === 'updatedAt') {
      result =
        Number(timestamp(left.updatedAt) || 0) -
        Number(timestamp(right.updatedAt) || 0);
    } else {
      result =
        Number(Boolean(left.risks.length)) -
        Number(Boolean(right.risks.length));
    }
    if (result !== 0) return result * direction;
    return (
      Number(timestamp(right.updatedAt) || 0) -
      Number(timestamp(left.updatedAt) || 0)
    );
  }
  private groupKeys(
    item: RequirementSummary,
    groupBy: RequirementListGroupBy,
  ): Array<{ key: string; label: string }> {
    if (groupBy === 'status') {
      const label: string = item.status || '未设置状态';
      return [{ key: `status:${label}`, label }];
    }
    if (groupBy === 'iteration') {
      return item.iterationNames.length
        ? item.iterationNames.map((label: string, index: number) => ({
            key: `iteration:${item.iterationIds[index] || label}`,
            label,
          }))
        : [{ key: 'iteration:unplanned', label: '未规划迭代' }];
    }
    if (groupBy === 'project') {
      const label: string = item.project || '未设置项目';
      return [{ key: `project:${label}`, label }];
    }
    if (groupBy === 'priority') {
      const label: string = item.priority || '未设置优先级';
      return [{ key: `priority:${label}`, label }];
    }
    const people: PersonRef[] =
      groupBy === 'handler'
        ? item.handlers
        : groupBy === 'product'
          ? item.productOwners
          : groupBy === 'developer'
            ? item.developers
            : groupBy === 'tester'
              ? item.testers
              : item.foOwners;
    const unassignedLabel: string =
      groupBy === 'handler'
        ? '未分配处理人'
        : groupBy === 'product'
          ? '未分配产品'
          : groupBy === 'developer'
            ? '未分配研发'
            : groupBy === 'tester'
              ? '未分配测试'
              : '未分配 FO';
    return people.length
      ? people.map((person: PersonRef) => ({
          key: `${groupBy}:${person.id || person.name}`,
          label: person.name || '成员',
        }))
      : [{ key: `${groupBy}:unassigned`, label: unassignedLabel }];
  }
  private requirementGroups(
    items: RequirementSummary[],
    groupBy: RequirementListGroupBy,
    currentUser: CurrentUserSummary,
  ): RequirementListGroup[] {
    const groups: Map<string, RequirementListGroup> = new Map();
    const configuredIds = new Set(
      items.map((item) => item.workflow?.iterationId),
    );
    const configuredOrder =
      configuredIds.size === 1 && !configuredIds.has(undefined)
        ? uniqueStrings(items.flatMap((item) => item.workflow?.statuses || []))
        : [];
    items.forEach((item: RequirementSummary): void => {
      this.groupKeys(item, groupBy).forEach(({ key, label }): void => {
        const group: RequirementListGroup = groups.get(key) || {
          key,
          label,
          items: [],
          totalCount: 0,
        };
        group.items.push(item);
        group.totalCount = group.items.length;
        groups.set(key, group);
      });
    });
    const actorIds: ReadonlySet<string> = new Set(
      [
        currentUser.openId,
        currentUser.employeeId,
        currentUser.miaodaUserId,
      ].filter(Boolean),
    );
    return [...groups.values()].sort(
      (left: RequirementListGroup, right: RequirementListGroup): number => {
        if (groupBy === 'status') {
          if (configuredOrder.length)
            return (
              configuredOrder.indexOf(left.label) -
              configuredOrder.indexOf(right.label)
            );
          return (
            workflowStatusSortRank(left.label) -
            workflowStatusSortRank(right.label)
          );
        }
        const leftPersonId: string = left.key.split(':').slice(1).join(':');
        const rightPersonId: string = right.key.split(':').slice(1).join(':');
        const leftIsCurrentUser: boolean = actorIds.has(leftPersonId);
        const rightIsCurrentUser: boolean = actorIds.has(rightPersonId);
        if (leftIsCurrentUser !== rightIsCurrentUser) {
          return leftIsCurrentUser ? -1 : 1;
        }
        return left.label.localeCompare(right.label, 'zh-CN');
      },
    );
  }
  private groupedRequirementRows(
    groups: RequirementListGroup[],
  ): GroupedRequirementRow[] {
    return groups.flatMap(
      (group: RequirementListGroup): GroupedRequirementRow[] =>
        group.items.map(
          (item: RequirementSummary): GroupedRequirementRow => ({
            groupKey: group.key,
            groupLabel: group.label,
            item,
          }),
        ),
    );
  }
  private requirementGroupsFromRows(
    rows: GroupedRequirementRow[],
    totalCounts: ReadonlyMap<string, number>,
  ): RequirementListGroup[] {
    const groups: Map<string, RequirementListGroup> = new Map();
    rows.forEach((row: GroupedRequirementRow): void => {
      const group: RequirementListGroup = groups.get(row.groupKey) || {
        key: row.groupKey,
        label: row.groupLabel,
        items: [],
        totalCount: totalCounts.get(row.groupKey) || 0,
      };
      group.items.push(row.item);
      groups.set(row.groupKey, group);
    });
    return [...groups.values()];
  }
  select(
    snapshot: WorkspaceResponse,
    input: RequirementListQuery,
  ): RequirementListResponse {
    const query = this.normalizedListQuery(input);
    const currentPersonIds = new Set(
      query.participatingOnly
        ? [snapshot.currentUser.openId, snapshot.currentUser.employeeId].filter(Boolean)
        : [],
    );
    const filtered: RequirementSummary[] = snapshot.requirements
      .filter((item: RequirementSummary): boolean =>
        this.matchesListQuery(item, query, currentPersonIds),
      )
      .sort((left: RequirementSummary, right: RequirementSummary): number =>
        this.compareRequirements(left, right, query.sortBy, query.sortOrder),
      );
    const total: number = filtered.length;
    const allGroups: RequirementListGroup[] | undefined = query.groupBy
      ? this.requirementGroups(filtered, query.groupBy, snapshot.currentUser)
      : undefined;
    const groupedRows: GroupedRequirementRow[] | undefined = allGroups
      ? this.groupedRequirementRows(allGroups)
      : undefined;
    const rowTotal: number = groupedRows?.length ?? total;
    const pageCount: number =
      rowTotal === 0 ? 0 : Math.ceil(rowTotal / query.pageSize);
    const page: number = pageCount === 0 ? 1 : Math.min(query.page, pageCount);
    const offset: number = (page - 1) * query.pageSize;
    const groups: RequirementListGroup[] | undefined = groupedRows
      ? this.requirementGroupsFromRows(
          groupedRows.slice(offset, offset + query.pageSize),
          new Map(
            (allGroups || []).map(
              (group: RequirementListGroup): [string, number] => [
                group.key,
                group.totalCount,
              ],
            ),
          ),
        )
      : undefined;
    const items: RequirementSummary[] = groups
      ? [
          ...new Map(
            groups
              .flatMap((group: RequirementListGroup) => group.items)
              .map((item: RequirementSummary) => [item.id, item]),
          ).values(),
        ]
      : filtered.slice(offset, offset + query.pageSize);
    return {
      fetchedAt: snapshot.fetchedAt,
      freshness: snapshot.freshness,
      currentUser: snapshot.currentUser,
      stats: requirementListStats(snapshot.requirements),
      iterations: snapshot.iterations,
      options: snapshot.options,
      peopleOptions: requirementListPeopleOptions(snapshot.requirements),
      items,
      ...(groups ? { groups } : {}),
      ...(allGroups ? { groupCount: allGroups.length } : {}),
      rowTotal,
      total,
      page,
      pageSize: query.pageSize,
      pageCount,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    };
  }
}
const selector = new RequirementListSelector();
/** Pure local selection: no network, authorization or mutation side effects. */
export function selectRequirementList(
  snapshot: WorkspaceResponse,
  input: RequirementListQuery,
): RequirementListResponse {
  return selector.select(snapshot, input);
}
