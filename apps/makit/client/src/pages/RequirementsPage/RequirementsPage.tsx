import { RequirementSearchInput } from './RequirementSearchInput';
import { useDeferredValue, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  RequirementListQuery,
  RequirementListSortBy,
  RequirementListSortOrder,
  RequirementSummary,
} from '@shared/api.interface';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Layers3,
  LayoutGrid,
  List,
  LoaderCircle,
  RotateCcw,
  Search,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getLightRequirementDetail } from '@/hooks/use-lazy-requirement-detail';
import WorkspaceSavedViews from '@/components/WorkspaceSavedViews';
import { savedViewSearch } from '@/lib/saved-view-query';
import BulkEditRequirementsDialog from '@/components/BulkEditRequirementsDialog';
import RequirementCard from '@/components/RequirementCard';
import RequirementFormDialog from '@/components/RequirementFormDialog';
import RequirementTypeBadge from '@/components/RequirementTypeBadge';
import QuickPersonnelEditor from '@/components/QuickPersonnelEditor';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/WorkspaceStates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useBrowserRequirementList, useRefreshBrowserWorkspace } from '@/hooks/use-browser-workspace';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  formatDate,
  PRIORITY_STYLES,
  STATUS_STYLES,
} from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';

type ViewMode = 'table' | 'cards';
type GroupBy =
  | ''
  | 'status'
  | 'iteration'
  | 'project'
  | 'priority'
  | 'handler'
  | 'product'
  | 'developer'
  | 'tester'
  | 'fo';
type RiskFilter =
  | ''
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

const ALL_FILTER_VALUE: string = '__all__';
const RISK_FILTER_LABELS: Record<Exclude<RiskFilter, ''>, string> = {
  'in-progress': '进行中',
  overdue: '已逾期',
  blocked: '已阻塞',
  unassigned: '未分配处理人',
  'missing-personnel': '核心角色未分配',
  'missing-product': '未分配产品',
  'missing-developer': '未分配研发',
  'missing-tester': '未分配测试',
  unplanned: '未规划迭代',
  'missing-progress': '未填写进展',
};


function TableRowGroup({ children }: { children: ReactNode }): ReactNode {
  return children;
}


type PersonOption = { id: string; name: string };

type RequirementColumnKey =
  | 'select'
  | 'title'
  | 'status'
  | 'handler'
  | 'product'
  | 'developer'
  | 'tester'
  | 'fo'
  | 'priority'
  | 'iteration'
  | 'deadline'
  | 'risk';

const COLUMN_DEFAULTS: Record<RequirementColumnKey, number> = {
  select: 48,
  title: 380,
  status: 120,
  handler: 190,
  product: 190,
  developer: 190,
  tester: 190,
  fo: 190,
  priority: 100,
  iteration: 210,
  deadline: 130,
  risk: 100,
};

const PERSON_GROUPS: Partial<
  Record<
    GroupBy,
    keyof Pick<
      RequirementSummary,
      'handlers' | 'productOwners' | 'developers' | 'testers' | 'foOwners'
    >
  >
> = {
  handler: 'handlers',
  product: 'productOwners',
  developer: 'developers',
  tester: 'testers',
  fo: 'foOwners',
};

const UNASSIGNED_GROUPS: Partial<Record<GroupBy, string>> = {
  handler: '未分配处理人',
  product: '未分配产品',
  developer: '未分配研发',
  tester: '未分配测试',
  fo: '未分配 FO',
};

function ResizableHeader({
  column,
  onResizeStart,
  children,
}: {
  column: RequirementColumnKey;
  onResizeStart: (
    column: RequirementColumnKey,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  children: ReactNode;
}) {
  return (
    <TableHead className="group relative border-b border-r bg-muted/55 last:border-r-0">
      {children}
      <button
        type="button"
        aria-label="调整列宽"
        className="absolute -right-1 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-center text-primary opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-70"
        onMouseDown={(event) => onResizeStart(column, event)}
      >
        <GripVertical className="size-3" />
      </button>
    </TableHead>
  );
}

function groupLabel(item: RequirementSummary, groupBy: GroupBy): string {
  if (groupBy === 'status') return item.status || '未设置状态';
  if (groupBy === 'iteration') {
    return item.iterationNames.join('、') || '未规划迭代';
  }
  if (groupBy === 'project') return item.project || '未设置项目';
  if (groupBy === 'priority') return item.priority || '未设置优先级';
  return '';
}

function groupRequirements(
  requirements: RequirementSummary[],
  groupBy: GroupBy,
): Array<{
  key: string;
  label: string;
  items: RequirementSummary[];
  totalCount: number;
}> {
  if (!groupBy) {
    return [
      {
        key: 'all',
        label: '',
        items: requirements,
        totalCount: requirements.length,
      },
    ];
  }
  const groups = new Map<
    string,
    { label: string; items: RequirementSummary[]; totalCount: number }
  >();
  requirements.forEach((item) => {
    const personField = PERSON_GROUPS[groupBy];
    if (personField) {
      const people = item[personField];
      if (!people.length) {
        const label = UNASSIGNED_GROUPS[groupBy] || '未分配';
        const key = `${groupBy}:unassigned`;
        const group = groups.get(key) || { label, items: [], totalCount: 0 };
        group.items.push(item);
        group.totalCount = group.items.length;
        groups.set(key, group);
        return;
      }
      const uniquePeople = new Map(
        people.map((person) => [person.id || person.name, person]),
      );
      uniquePeople.forEach((person, personId) => {
        const key = `${groupBy}:${personId}`;
        const group = groups.get(key) || {
          label: person.name || '成员',
          items: [],
          totalCount: 0,
        };
        group.items.push(item);
        group.totalCount = group.items.length;
        groups.set(key, group);
      });
      return;
    }
    const label = groupLabel(item, groupBy);
    const key = `${groupBy}:${label}`;
    const group = groups.get(key) || { label, items: [], totalCount: 0 };
    group.items.push(item);
    group.totalCount = group.items.length;
    groups.set(key, group);
  });
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

export default function RequirementsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState(COLUMN_DEFAULTS);
  const search = searchParams.get('q') || '';
  const deferredSearch = useDeferredValue(search);
  const status = searchParams.get('status') || '';
  const priority = searchParams.get('priority') || '';
  const project = searchParams.get('project') || '';
  const type = searchParams.get('type') || '';
  const source = searchParams.get('source') || '';
  const iterationId = searchParams.get('iteration') || '';
  const handlerId = searchParams.get('handler') || '';
  const productId = searchParams.get('product') || '';
  const developerId = searchParams.get('developer') || '';
  const testerId = searchParams.get('tester') || '';
  const foId = searchParams.get('fo') || '';
  const risk = (searchParams.get('risk') || '') as RiskFilter;
  const groupBy = (searchParams.get('group') || '') as GroupBy;
  const mineOnly = searchParams.get('mine') === '1';
  const page: number = Math.max(
    1,
    Math.trunc(Number(searchParams.get('page')) || 1),
  );
  const requestedPageSize: number = Math.trunc(
    Number(searchParams.get('pageSize')) || 25,
  );
  const pageSize: number = [25, 50, 100].includes(requestedPageSize)
    ? requestedPageSize
    : 25;
  const requestedSortBy: string = searchParams.get('sortBy') || 'risk';
  const sortBy: RequirementListSortBy = [
    'risk',
    'updatedAt',
    'deadlineAt',
    'priority',
    'status',
    'title',
  ].includes(requestedSortBy)
    ? (requestedSortBy as RequirementListSortBy)
    : 'risk';
  const sortOrder: RequirementListSortOrder =
    searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc';
  const view: ViewMode =
    searchParams.get('view') === 'cards' ? 'cards' : 'table';
  const effectiveView: ViewMode = isMobile ? 'cards' : view;
  const createOpen = searchParams.get('create') === '1';
  const createReturnTo = searchParams.get('returnTo') || '';
  const requirementQuery: RequirementListQuery = {
    page,
    pageSize,
    search: deferredSearch,
    status,
    priority,
    project,
    type,
    source,
    iterationId,
    handlerId,
    productOwnerId: productId,
    developerId,
    testerId,
    foOwnerId: foId,
    risk: risk || undefined,
    mineOnly,
    groupBy: groupBy || undefined,
    sortBy,
    sortOrder,
  };
  const workspaceQuery = useBrowserRequirementList(requirementQuery);
  const refreshMutation = useRefreshBrowserWorkspace();

  const updateParam = (key: string, value: string): void => {
    const next: URLSearchParams = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (!['page', 'create', 'view'].includes(key)) next.delete('page');
    setSearchParams(next, { replace: true });
    if (key !== 'create' && key !== 'view') setSelectedIds(new Set());
  };

  if (workspaceQuery.isLoading) return <LoadingState label="正在加载需求" />;
  if (!workspaceQuery.data) {
    return (
      <ErrorState
        message={workspaceQuery.error?.message || '未知错误'}
        onRetry={() => void workspaceQuery.refetch()}
      />
    );
  }
  const workspace = workspaceQuery.data;
  const handlerOptions: PersonOption[] = workspace.peopleOptions.handlers;
  const productOptions: PersonOption[] = workspace.peopleOptions.productOwners;
  const developerOptions: PersonOption[] = workspace.peopleOptions.developers;
  const testerOptions: PersonOption[] = workspace.peopleOptions.testers;
  const foOptions: PersonOption[] = workspace.peopleOptions.foOwners;
  const requirements: RequirementSummary[] = workspace.items;
  const groups = workspace.groups || groupRequirements(requirements, groupBy);
  const visibleRowCount: number = workspace.groups
    ? workspace.groups.reduce(
        (count: number, group): number => count + group.items.length,
        0,
      )
    : requirements.length;

  const selectedRequirements: RequirementSummary[] = requirements.filter(
    (item: RequirementSummary): boolean => selectedIds.has(item.id),
  );
  const visibleIds: string[] = requirements.map((item) => item.id);
  const selectedVisibleCount: number = visibleIds.filter(
    (id: string): boolean => selectedIds.has(id),
  ).length;
  const allVisibleSelected: boolean =
    visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const setCreateOpen = (open: boolean): void => {
    if (!open && createReturnTo) {
      navigate(createReturnTo, { replace: true });
      return;
    }
    updateParam('create', open ? '1' : '');
  };

  const resetFilters = (): void => {
    const next: URLSearchParams = new URLSearchParams(searchParams);
    [
      'q',
      'status',
      'priority',
      'project',
      'type',
      'source',
      'iteration',
      'handler',
      'product',
      'developer',
      'tester',
      'fo',
      'risk',
      'mine',
      'page',
    ].forEach((key: string): void => next.delete(key));
    setSearchParams(next, { replace: true });
    setSelectedIds(new Set());
  };
  const hasActiveFilters: boolean = Boolean(
    search.trim() ||
    status ||
    priority ||
    project ||
    type ||
    source ||
    iterationId ||
    handlerId ||
    productId ||
    developerId ||
    testerId ||
    foId ||
    risk ||
    mineOnly,
  );
  const activeFilterCount: number = [
    search,
    status,
    priority,
    project,
    type,
    source,
    iterationId,
    handlerId,
    productId,
    developerId,
    testerId,
    foId,
    risk,
    mineOnly ? '1' : '',
  ].filter(Boolean).length;
  const startColumnResize = (
    column: RequirementColumnKey,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const startX: number = event.clientX;
    const startWidth: number = columnWidths[column];
    const onMove = (moveEvent: MouseEvent): void => {
      const minimum: number = column === 'select' ? 44 : 80;
      setColumnWidths((current) => ({
        ...current,
        [column]: Math.max(minimum, startWidth + moveEvent.clientX - startX),
      }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const returnTo = `/requirements${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const filterChips: Array<{ key: string; label: string }> = [
    ...(search ? [{ key: 'q', label: `搜索：${search}` }] : []),
    ...(status ? [{ key: 'status', label: `状态：${status}` }] : []),
    ...(priority ? [{ key: 'priority', label: `优先级：${priority}` }] : []),
    ...(project ? [{ key: 'project', label: `项目：${project}` }] : []),
    ...(type ? [{ key: 'type', label: `类型：${type}` }] : []),
    ...(source ? [{ key: 'source', label: `来源：${source}` }] : []),
    ...(iterationId
      ? [
          {
            key: 'iteration',
            label: `迭代：${
              workspace.iterations.find(
                (iteration) => iteration.id === iterationId,
              )?.name || iterationId
            }`,
          },
        ]
      : []),
    ...(handlerId
      ? [
          {
            key: 'handler',
            label: `处理人：${
              handlerOptions.find((person) => person.id === handlerId)?.name ||
              handlerId
            }`,
          },
        ]
      : []),
    ...(productId
      ? [
          {
            key: 'product',
            label: `产品：${
              productOptions.find((person) => person.id === productId)?.name ||
              productId
            }`,
          },
        ]
      : []),
    ...(developerId
      ? [
          {
            key: 'developer',
            label: `研发：${
              developerOptions.find((person) => person.id === developerId)
                ?.name || developerId
            }`,
          },
        ]
      : []),
    ...(testerId
      ? [
          {
            key: 'tester',
            label: `测试：${
              testerOptions.find((person) => person.id === testerId)?.name ||
              testerId
            }`,
          },
        ]
      : []),
    ...(foId
      ? [
          {
            key: 'fo',
            label: `FO：${
              foOptions.find((person) => person.id === foId)?.name || foId
            }`,
          },
        ]
      : []),
    ...(risk
      ? [{ key: 'risk', label: `风险：${RISK_FILTER_LABELS[risk]}` }]
      : []),
    ...(mineOnly ? [{ key: 'mine', label: '仅我处理' }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">需求池</h1>
        <Button variant="outline" size="sm" disabled={refreshMutation.isPending}
          onClick={() => void refreshMutation.mutateAsync().catch(() => undefined)}>
          <RefreshCw className={cn('size-4', refreshMutation.isPending && 'animate-spin')} />刷新
        </Button>
      </div>
      {refreshMutation.isError ? <div role="status" className="text-sm text-destructive">刷新失败，请重试。</div> : null}
      {workspaceQuery.isError || workspaceQuery.data.freshness?.stale ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">当前展示最近一次成功读取的数据（{formatDate(workspaceQuery.data.fetchedAt, true)}）。</div> : null}

      <Card className="rounded-2xl border-border/75 bg-gradient-to-br from-card via-card to-primary/[0.018] p-3 shadow-sm md:sticky md:top-[69px] md:z-20 md:bg-background/90 md:backdrop-blur-xl">
        <div className="grid grid-cols-2 items-center gap-2 lg:grid-cols-[minmax(280px,1fr)_minmax(180px,220px)_minmax(140px,180px)_auto_auto_auto]">
          <div className="relative col-span-2 min-w-0 lg:col-span-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <RequirementSearchInput value={search} onSearch={(value) => updateParam('q', value)} />
          </div>
          <Select
            value={iterationId || ALL_FILTER_VALUE}
            onValueChange={(value) =>
              updateParam('iteration', value === ALL_FILTER_VALUE ? '' : value)
            }
          >
            <SelectTrigger className="h-10 w-full">
              <SelectValue placeholder="全部迭代" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER_VALUE}>全部迭代</SelectItem>
              {workspace.iterations.map((iteration) => (
                <SelectItem key={iteration.id} value={iteration.id}>
                  {iteration.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={groupBy || ALL_FILTER_VALUE}
            onValueChange={(value) =>
              updateParam('group', value === ALL_FILTER_VALUE ? '' : value)
            }
          >
            <SelectTrigger className="h-10 w-full">
              <Layers3 className="size-4" />
              <SelectValue placeholder="不分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER_VALUE}>不分组</SelectItem>
              <SelectItem value="status">按状态</SelectItem>
              <SelectItem value="iteration">按迭代</SelectItem>
              <SelectItem value="project">按项目</SelectItem>
              <SelectItem value="priority">按优先级</SelectItem>
              <SelectItem value="handler">按处理人</SelectItem>
              <SelectItem value="product">按产品</SelectItem>
              <SelectItem value="developer">按研发</SelectItem>
              <SelectItem value="tester">按测试</SelectItem>
              <SelectItem value="fo">按 FO</SelectItem>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-10 justify-between">
                <SlidersHorizontal className="size-4" />
                筛选
                {activeFilterCount ? (
                  <Badge className="ml-1 h-5 min-w-5 rounded-full px-1.5">
                    {activeFilterCount}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[75dvh] w-[720px] max-w-[calc(100vw-24px)] overflow-y-auto p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">筛选条件</p>
                  <p className="text-xs text-muted-foreground">
                    按字段与成员缩小需求范围
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetFilters}
                  disabled={!hasActiveFilters}
                >
                  <RotateCcw className="size-4" />
                  重置
                </Button>
              </div>
              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    状态
                  </span>
                  <Select
                    value={status || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'status',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部状态" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>全部状态</SelectItem>
                      {workspace.options.statuses.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    优先级
                  </span>
                  <Select
                    value={priority || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'priority',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部优先级" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>
                        全部优先级
                      </SelectItem>
                      {workspace.options.priorities.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    项目
                  </span>
                  <Select
                    value={project || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'project',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部项目" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>全部项目</SelectItem>
                      {workspace.options.projects.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    类型
                  </span>
                  <Select
                    value={type || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'type',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部类型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>全部类型</SelectItem>
                      {workspace.options.types.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    来源
                  </span>
                  <Select
                    value={source || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'source',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部来源" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>全部来源</SelectItem>
                      {workspace.options.sources.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    风险
                  </span>
                  <Select
                    value={risk || ALL_FILTER_VALUE}
                    onValueChange={(value) =>
                      updateParam(
                        'risk',
                        value === ALL_FILTER_VALUE ? '' : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="全部风险" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER_VALUE}>全部风险</SelectItem>
                      <SelectItem value="in-progress">进行中</SelectItem>
                      <SelectItem value="overdue">已逾期</SelectItem>
                      <SelectItem value="blocked">已阻塞</SelectItem>
                      <SelectItem value="unassigned">未分配处理人</SelectItem>
                      <SelectItem value="missing-personnel">
                        任一核心角色未分配
                      </SelectItem>
                      <SelectItem value="missing-product">
                        未分配产品
                      </SelectItem>
                      <SelectItem value="missing-developer">
                        未分配研发
                      </SelectItem>
                      <SelectItem value="missing-tester">未分配测试</SelectItem>
                      <SelectItem value="unplanned">未规划迭代</SelectItem>
                      <SelectItem value="missing-progress">
                        未填写进展
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    排序字段
                  </span>
                  <Select
                    value={sortBy}
                    onValueChange={(value: string) =>
                      updateParam('sortBy', value === 'risk' ? '' : value)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="风险优先" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="risk">风险优先</SelectItem>
                      <SelectItem value="updatedAt">最近更新</SelectItem>
                      <SelectItem value="priority">优先级</SelectItem>
                      <SelectItem value="status">状态</SelectItem>
                      <SelectItem value="title">标题</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    排序方向
                  </span>
                  <Select
                    value={sortOrder}
                    onValueChange={(value: string) =>
                      updateParam('sortOrder', value === 'desc' ? '' : value)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="降序" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">降序</SelectItem>
                      <SelectItem value="asc">升序</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {[
                  ['handler', '全部处理人', handlerId, handlerOptions],
                  ['product', '全部产品', productId, productOptions],
                  ['developer', '全部研发', developerId, developerOptions],
                  ['tester', '全部测试', testerId, testerOptions],
                  ['fo', '全部 FO', foId, foOptions],
                ].map(([key, label, current, options]) => (
                  <div key={String(key)} className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {String(label).replace('全部', '')}
                    </span>
                    <Select
                      value={(current as string) || ALL_FILTER_VALUE}
                      onValueChange={(value) =>
                        updateParam(
                          key as string,
                          value === ALL_FILTER_VALUE ? '' : value,
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={String(label)} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_FILTER_VALUE}>
                          {String(label)}
                        </SelectItem>
                        {(options as PersonOption[]).map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant={mineOnly ? 'secondary' : 'outline'}
            className="h-10"
            onClick={() => updateParam('mine', mineOnly ? '' : '1')}
          >
            我处理的
          </Button>
          <div className="col-span-2 flex h-10 items-center justify-between gap-3 lg:col-span-1 lg:justify-end">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              共 {workspace.total} 项
            </span>
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(value) => value && updateParam('view', value)}
              variant="outline"
              size="sm"
              className="hidden md:flex"
            >
              <ToggleGroupItem value="table" aria-label="列表视图">
                <List className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="cards" aria-label="卡片视图">
                <LayoutGrid className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.length ? (
            <>
              <span className="text-xs text-muted-foreground">已生效</span>
              {filterChips.map((filter) => (
                <Badge
                  key={filter.key}
                  variant="secondary"
                  className="gap-1 rounded-md py-1 pl-2 pr-1"
                >
                  <span className="max-w-64 truncate">{filter.label}</span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-background/80"
                    aria-label={`移除筛选：${filter.label}`}
                    onClick={() => updateParam(filter.key, '')}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                清除全部
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              当前未设置筛选
            </span>
          )}
        </div>
        <WorkspaceSavedViews
          legacyOwner={{ miaodaUserId: workspaceQuery.data.currentUser.miaodaUserId, employeeId: workspaceQuery.data.currentUser.employeeId }}
          config={{
            query: Object.fromEntries(Object.entries(requirementQuery).filter(([key, value]) => key !== 'page' && value !== undefined && value !== '')),
            viewMode: view === 'cards' ? 'cards' : 'list',
            columnWidths,
          }}
          onSelect={(config) => {
            setSearchParams(savedViewSearch(config), { replace: true });
            if (config.columnWidths) setColumnWidths({ ...COLUMN_DEFAULTS, ...config.columnWidths });
            setSelectedIds(new Set());
          }}
        />
      </div>

      {selectedRequirements.length ? (
        <Card className="flex flex-wrap items-center gap-3 rounded-lg border-primary/25 bg-primary/5 px-4 py-3 shadow-none">
          <span className="text-sm font-medium">
            已选择 {selectedRequirements.length} 项
          </span>
          <span className="text-xs text-muted-foreground">
            批量修改会先完成整批校验，单次最多 100 项
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              取消选择
            </Button>
            <Button
              size="sm"
              onClick={() => setBulkOpen(true)}
              disabled={selectedRequirements.length > 100}
            >
              批量修改
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="relative">
        {workspaceQuery.isPlaceholderData ? (
          <div className="absolute inset-0 z-30 flex min-h-40 items-start justify-center rounded-lg bg-background/75 pt-12 backdrop-blur-[1px]">
            <span className="inline-flex items-center gap-2 rounded-full border bg-background px-4 py-2 text-sm text-muted-foreground shadow-sm">
              <LoaderCircle className="size-4 animate-spin" />
              正在加载最新结果
            </span>
          </div>
        ) : null}
        <div
          className={cn(
            workspaceQuery.isPlaceholderData &&
              'pointer-events-none select-none opacity-60',
          )}
        >
          {requirements.length === 0 ? (
            <EmptyState
              title="没有符合条件的需求"
              description="调整筛选条件，或创建一条新的需求。"
            />
          ) : effectiveView === 'cards' ? (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                  {group.label ? (
                    <div className="flex items-center gap-2 px-1">
                      <h2 className="text-sm font-semibold">{group.label}</h2>
                      <Badge variant="secondary">
                        {group.items.length < group.totalCount
                          ? `本页 ${group.items.length} / 共 ${group.totalCount}`
                          : `${group.totalCount}`}
                      </Badge>
                    </div>
                  ) : null}
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.items.map((item) => (
                      <RequirementCard
                        key={item.id}
                        requirement={item}
                        showPersonnel
                        returnTo={returnTo}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden rounded-2xl border-border/75 shadow-sm">
              <div className="overflow-auto md:max-h-[calc(100dvh-245px)] md:min-h-[360px]">
                <Table
                  className="table-fixed border-collapse"
                  style={{
                    width: Object.values(columnWidths).reduce(
                      (total, width) => total + width,
                      0,
                    ),
                  }}
                >
                  <colgroup>
                    {(
                      Object.keys(COLUMN_DEFAULTS) as RequirementColumnKey[]
                    ).map((column) => (
                      <col
                        key={column}
                        style={{ width: columnWidths[column] }}
                      />
                    ))}
                  </colgroup>
                  <TableHeader className="sticky top-0 z-10 bg-background/90 shadow-sm backdrop-blur-xl">
                    <TableRow className="bg-muted/65 hover:bg-muted/65">
                      <ResizableHeader
                        column="select"
                        onResizeStart={startColumnResize}
                      >
                        <Checkbox
                          aria-label="选择当前筛选结果"
                          checked={
                            allVisibleSelected
                              ? true
                              : selectedVisibleCount > 0
                                ? 'indeterminate'
                                : false
                          }
                          onCheckedChange={(checked) => {
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              visibleIds.forEach((id: string): void => {
                                if (checked) next.add(id);
                                else next.delete(id);
                              });
                              return next;
                            });
                          }}
                        />
                      </ResizableHeader>
                      {[
                        ['title', '标题'],
                        ['status', '状态'],
                        ['handler', '处理人'],
                        ['product', '产品'],
                        ['developer', '研发'],
                        ['tester', '测试'],
                        ['fo', 'FO'],
                        ['priority', '优先级'],
                        ['iteration', '迭代'],
                        ['deadline', '开发工作量'],
                        ['risk', '风险'],
                      ].map(([column, label]) => (
                        <ResizableHeader
                          key={column}
                          column={column as RequirementColumnKey}
                          onResizeStart={startColumnResize}
                        >
                          {label}
                        </ResizableHeader>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((group) => (
                      <TableRowGroup key={group.key}>
                        {group.label ? (
                          <TableRow className="bg-muted/35 hover:bg-muted/35">
                            <TableCell colSpan={12} className="border-b py-2">
                              <span className="font-medium">{group.label}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {group.items.length < group.totalCount
                                  ? `本页 ${group.items.length} 项 / 共 ${group.totalCount} 项`
                                  : `${group.totalCount} 项`}
                              </span>
                            </TableCell>
                          </TableRow>
                        ) : null}
                        {group.items.map((item) => (
                          <TableRow
                            key={`${group.key}:${item.id}`}
                            className="transition-colors duration-150 hover:bg-primary/[0.028]"
                          >
                            <TableCell className="border-b border-r last:border-r-0">
                              <Checkbox
                                aria-label={`选择需求 ${item.title}`}
                                checked={selectedIds.has(item.id)}
                                onCheckedChange={(checked) =>
                                  setSelectedIds((current) => {
                                    const next = new Set(current);
                                    if (checked) next.add(item.id);
                                    else next.delete(item.id);
                                    return next;
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <div className="flex min-w-0 items-start gap-2">
                                <RequirementTypeBadge
                                  type={item.type}
                                  className="mt-0.5 h-5 shrink-0 rounded px-1.5 text-[10px]"
                                />
                                <div className="min-w-0">
                                  <Link
                                    to={`/requirements/${item.id}`}
                                    state={{ requirementReturnTo: returnTo }}
                                    onMouseEnter={() => {
                                      void queryClient.prefetchQuery({
                                        queryKey: ['requirement', item.id],
                                        queryFn: ({ signal }) =>
                                          getLightRequirementDetail(item.id, signal),
                                        staleTime: 30_000,
                                      });
                                    }}
                                    className="line-clamp-2 text-sm font-medium hover:text-primary"
                                  >
                                    {item.title}
                                  </Link>
                                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {item.code} · {item.project}
                                  </p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <Badge
                                variant="outline"
                                className={cn(
                                  'whitespace-nowrap',
                                  STATUS_STYLES[item.status],
                                )}
                              >
                                {item.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <QuickPersonnelEditor
                                requirementId={item.id}
                                role="handlers"
                                people={item.handlers}
                                compact
                                editable={item.capabilities.canUpdate}
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <QuickPersonnelEditor
                                requirementId={item.id}
                                role="productOwners"
                                people={item.productOwners}
                                compact
                                editable={item.capabilities.canUpdate}
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <QuickPersonnelEditor
                                requirementId={item.id}
                                role="developers"
                                people={item.developers}
                                compact
                                editable={item.capabilities.canUpdate}
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <QuickPersonnelEditor
                                requirementId={item.id}
                                role="testers"
                                people={item.testers}
                                compact
                                editable={item.capabilities.canUpdate}
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <QuickPersonnelEditor
                                requirementId={item.id}
                                role="foOwners"
                                people={item.foOwners}
                                compact
                                editable={item.capabilities.canUpdate}
                              />
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <Badge
                                variant="outline"
                                className={cn(PRIORITY_STYLES[item.priority])}
                              >
                                {item.priority}
                              </Badge>
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              <span className="line-clamp-2 text-sm">
                                {item.iterationNames.join('、') || '未规划'}
                              </span>
                            </TableCell>
                            <TableCell className="overflow-hidden whitespace-nowrap border-b border-r text-sm last:border-r-0">
                              {item.effort == null ? '未设置' : `${item.effort} 天`}
                            </TableCell>
                            <TableCell className="overflow-hidden border-b border-r last:border-r-0">
                              {item.risks.length ? (
                                <span
                                  className="inline-flex items-center gap-1 text-xs text-orange-600"
                                  title={item.risks.join('、')}
                                >
                                  <AlertTriangle className="size-3.5" />
                                  {item.risks.length} 项
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableRowGroup>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/75 bg-background/90 px-3 py-2.5 shadow-xs backdrop-blur">
        <div className="text-xs text-muted-foreground">
          {workspace.groups
            ? visibleRowCount
              ? `第 ${(workspace.page - 1) * workspace.pageSize + 1}–${
                  (workspace.page - 1) * workspace.pageSize + visibleRowCount
                } 行，共 ${workspace.rowTotal} 行、${
                  workspace.groupCount || 0
                } 个分组、${workspace.total} 项需求`
              : `共 ${workspace.groupCount || 0} 个分组、${workspace.total} 项需求`
            : requirements.length
              ? `第 ${(workspace.page - 1) * workspace.pageSize + 1}–${
                  (workspace.page - 1) * workspace.pageSize +
                  requirements.length
                } 项，共 ${workspace.total} 项`
              : `共 ${workspace.total} 项`}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={String(workspace.pageSize)}
            onValueChange={(value: string) => updateParam('pageSize', value)}
          >
            <SelectTrigger className="h-8 w-[94px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 {groupBy ? '行' : '项'}/页</SelectItem>
              <SelectItem value="50">50 {groupBy ? '行' : '项'}/页</SelectItem>
              <SelectItem value="100">
                100 {groupBy ? '行' : '项'}/页
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="min-w-[70px] text-center text-xs text-muted-foreground">
            {workspace.pageCount
              ? `${workspace.page} / ${workspace.pageCount}`
              : '0 / 0'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="上一页"
            disabled={workspace.page <= 1}
            onClick={() => updateParam('page', String(workspace.page - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="下一页"
            disabled={
              workspace.pageCount === 0 ||
              workspace.page >= workspace.pageCount
            }
            onClick={() => updateParam('page', String(workspace.page + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {createOpen ? (
        <RequirementFormDialog
          open
          onOpenChange={setCreateOpen}
          workspace={workspace}
        />
      ) : null}
      <BulkEditRequirementsDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        workspace={workspace}
        requirements={selectedRequirements}
        onCompleted={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
