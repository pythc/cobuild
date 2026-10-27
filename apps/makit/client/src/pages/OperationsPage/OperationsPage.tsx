import { useEffect, useState } from 'react';
import type { ChangeEvent, FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  History,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  OperationListQuery,
  OperationRecord,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';
import { operationsApi } from '@/api';
import { UserDisplay } from '@/components/business-ui/user-display';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState } from '@/components/WorkspaceStates';
import {
  OPERATIONS_QUERY_KEY,
  useOperationsAccess,
} from '@/hooks/use-operations';
import { cn } from '@/lib/utils';
import { OperationRuntimeTabs } from './OperationsRuntimeTabs';
import { OperationsInsightsTabs } from './OperationsInsightsTabs';
import { NotificationLedger } from './NotificationLedger';
import { OperationsError, OperationsPagination } from './OperationsCommon';
import { OperationDetail, OperationStatusBadge } from './OperationDetail';
import {
  OPERATION_STATUS,
  operationPage,
  operationStatus,
  operationTime,
  operationTitle,
} from './operations-presentation';

const PAGE_SIZE: number = 25;
function localDateInput(value: string | null): string {
  const time = value ? new Date(value) : null;
  if (!time || !Number.isFinite(time.getTime())) return '';
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
const TAB_CLASS: string =
  'flex-none rounded-none border-x-0 border-t-0 border-b-2 px-4 py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none';

const OperationsPage: FC = () => {
  const accessQuery = useOperationsAccess();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState<string>(params.get('search') || '');
  const [selected, setSelected] = useState<OperationRecord | null>(null);
  const [tab, setTab] = useState<string>('records');
  const canViewAll: boolean = Boolean(
    accessQuery.isSuccess && accessQuery.data?.canViewAll,
  );
  const scope: 'mine' | 'all' =
    canViewAll && params.get('scope') === 'all' ? 'all' : 'mine';
  const status: RequirementUpdateJobStatus | 'all' = operationStatus(
    params.get('status'),
  );
  const page: number = operationPage(params.get('page'));
  const searchValue: string = params.get('search')?.trim() || '';
  const searchKind = (
    ['requirementCode', 'requirementId', 'operationId', 'pullNumber'].includes(
      params.get('searchKind') || '',
    )
      ? params.get('searchKind')
      : 'requirementCode'
  ) as 'requirementCode' | 'requirementId' | 'operationId' | 'pullNumber';
  const queryInput: OperationListQuery = {
    scope,
    status,
    page,
    pageSize: PAGE_SIZE,
    [searchKind]:
      searchKind === 'pullNumber'
        ? searchValue
          ? Number(searchValue.replace(/^#/, ''))
          : undefined
        : searchValue || undefined,
    since: params.get('since') || undefined,
    until: params.get('until') || undefined,
  };
  const recordsQuery = useQuery({
    queryKey: [
      ...OPERATIONS_QUERY_KEY,
      'records',
      accessQuery.data?.userId,
      queryInput,
    ],
    queryFn: ({ signal }) => operationsApi.getRecords(queryInput, signal),
    enabled: canViewAll && tab === 'records',
    refetchInterval: (query): number =>
      query.state.data?.stats.queued || query.state.data?.stats.running
        ? 3_000
        : 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect((): void => {
    setSearch(params.get('search') || '');
  }, [params]);
  useEffect((): void => {
    if (!canViewAll) {
      setTab('records');
      setSelected(null);
    }
  }, [canViewAll]);

  const setFilter = (key: string, value: string): void => {
    const next: URLSearchParams = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
    setSelected(null);
  };
  const columns: TableColumnsType<OperationRecord> = [
    {
      title: '操作',
      key: 'operation',
      width: 260,
      render: (_: unknown, item: OperationRecord) => (
        <button
          type="button"
          className="min-w-0 text-left hover:text-primary focus-visible:rounded focus-visible:outline-primary"
          onClick={() => setSelected(item)}
        >
          <div className="font-medium">{operationTitle(item)}</div>
          <div className="mt-1 max-w-60 truncate text-xs text-muted-foreground">
            {item.fields.join('、') || '需求字段'}
          </div>
        </button>
      ),
    },
    {
      title: '需求',
      key: 'requirement',
      width: 160,
      render: (_: unknown, item: OperationRecord) => (
        <Link
          to={`/requirements/${encodeURIComponent(item.requirementId)}`}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <span className="max-w-32 truncate" title={item.requirementId}>
            {item.requirementCode || item.requirementId}
          </span>
          <ArrowUpRight className="size-3 shrink-0" />
        </Link>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 112,
      render: (_: unknown, item: OperationRecord) => (
        <OperationStatusBadge status={item.status} />
      ),
    },
    ...(scope === 'all'
      ? [
          {
            title: '操作人',
            key: 'actor',
            width: 150,
            render: (_: unknown, item: OperationRecord) =>
              item.actorUserId ? (
                <UserDisplay value={[item.actorUserId]} size="small" />
              ) : (
                '—'
              ),
          },
        ]
      : []),
    {
      title: '时间',
      key: 'time',
      width: 140,
      render: (_: unknown, item: OperationRecord) => (
        <span className="text-xs text-muted-foreground">
          {operationTime(item.createdAt)}
        </span>
      ),
    },
    {
      title: '结果',
      key: 'result',
      width: 280,
      render: (_: unknown, item: OperationRecord) => (
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn(
              'line-clamp-2 text-xs',
              item.status === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {item.errorMessage ||
              (item.status === 'succeeded' ? '已修改' : '—')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(item)}>
            详情
          </Button>
        </div>
      ),
    },
  ];

  if (accessQuery.isPending) return <LoadingState label="正在加载操作记录" />;
  if (accessQuery.isError || !accessQuery.data)
    return (
      <OperationsError
        message={accessQuery.error?.message || '无法确认查看权限'}
        onRetry={() => void accessQuery.refetch()}
      />
    );

  if (!canViewAll)
    return (
      <div className="rounded-xl border p-8 text-muted-foreground">
        仅管理员可查看操作记录。
      </div>
    );

  const stats = recordsQuery.data?.stats;
  const selectedCurrent: OperationRecord | null = selected
    ? recordsQuery.data?.items.find(
        (item: OperationRecord): boolean => item.id === selected.id,
      ) || selected
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">操作记录</h1>
        <div className="flex flex-wrap items-center gap-2">
          {accessQuery.data.canViewNotifications ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/notifications">
                PR 通知
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          ) : null}
          {accessQuery.data.canManageAdmins ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/operations/admins">
                <Settings2 className="size-4" />
                管理员设置
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        {canViewAll ? (
          <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0">
            <TabsTrigger className={TAB_CLASS} value="records">
              需求操作
            </TabsTrigger>
            <TabsTrigger className={TAB_CLASS} value="workflow">
              工作流通知
            </TabsTrigger>
            <TabsTrigger className={TAB_CLASS} value="reviews">
              AI 评审
            </TabsTrigger>
            <TabsTrigger className={TAB_CLASS} value="deliveries">
              通知投递
            </TabsTrigger>
            <TabsTrigger className={TAB_CLASS} value="usage">
              AI 用量
            </TabsTrigger>
          </TabsList>
        ) : null}
        <TabsContent value="records" className="mt-3 space-y-4">
          <div
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            data-ai-section-type="card-stat"
          >
            {[
              {
                key: 'all',
                label: '全部操作',
                value: stats?.total,
                icon: History,
                tone: 'text-primary bg-primary/10',
              },
              {
                key: 'running',
                label: '处理中',
                value: stats?.running,
                icon: RefreshCw,
                tone: 'text-blue-600 bg-blue-50',
              },
              {
                key: 'failed',
                label: '失败记录',
                value: stats?.failed,
                icon: AlertCircle,
                tone: 'text-red-600 bg-red-50',
              },
              {
                key: 'succeeded',
                label: '已完成',
                value: stats?.succeeded,
                icon: CheckCircle2,
                tone: 'text-emerald-600 bg-emerald-50',
              },
            ].map(({ key, label, value, icon: Icon, tone }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter('status', key)}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40',
                  status === key && 'border-primary/35 ring-1 ring-primary/10',
                )}
              >
                <div>
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <div className="mt-1.5 text-2xl font-semibold tabular-nums">
                    {value ?? '—'}
                  </div>
                </div>
                <span
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-xl',
                    tone,
                  )}
                >
                  <Icon className="size-4" />
                </span>
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b p-3">
              {canViewAll ? (
                <Select
                  value={scope}
                  onValueChange={(value: string) => setFilter('scope', value)}
                >
                  <SelectTrigger className="w-32" aria-label="操作范围">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mine">我的操作</SelectItem>
                    <SelectItem value="all">全部操作</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <span className="px-2 text-sm font-medium">我的操作</span>
              )}
              <Select
                value={status}
                onValueChange={(value: string) => setFilter('status', value)}
              >
                <SelectTrigger className="w-28" aria-label="操作状态">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {Object.entries(OPERATION_STATUS).map(([key, meta]) => (
                    <SelectItem key={key} value={key}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={searchKind}
                onValueChange={(value: string) =>
                  setFilter('searchKind', value)
                }
              >
                <SelectTrigger className="w-28" aria-label="搜索类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="requirementId">需求 ID</SelectItem>
                  <SelectItem value="requirementCode">需求编号</SelectItem>
                  <SelectItem value="operationId">操作编号</SelectItem>
                  <SelectItem value="pullNumber">PR 编号</SelectItem>
                </SelectContent>
              </Select>
              <form
                className="flex min-w-40 flex-1 items-center gap-2"
                onSubmit={(event): void => {
                  event.preventDefault();
                  setFilter('search', search.trim());
                }}
              >
                <Input
                  value={search}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    setSearch(event.target.value)
                  }
                  placeholder={
                    searchKind === 'operationId'
                      ? '搜索操作编号'
                      : searchKind === 'requirementCode'
                        ? 'REQ-…'
                        : searchKind === 'pullNumber'
                          ? 'PR 编号，如 38'
                          : '搜索需求 ID'
                  }
                  aria-label="搜索操作记录"
                  className="min-w-0"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="搜索"
                  type="submit"
                >
                  <Search className="size-4" />
                </Button>
              </form>
              <Input
                className="w-auto"
                aria-label="开始时间"
                type="datetime-local"
                value={localDateInput(params.get('since'))}
                onChange={(event) =>
                  setFilter(
                    'since',
                    event.target.value
                      ? new Date(event.target.value).toISOString()
                      : '',
                  )
                }
              />
              <Input
                className="w-auto"
                aria-label="结束时间"
                type="datetime-local"
                value={localDateInput(params.get('until'))}
                onChange={(event) =>
                  setFilter(
                    'until',
                    event.target.value
                      ? new Date(event.target.value).toISOString()
                      : '',
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void recordsQuery.refetch()}
                disabled={recordsQuery.isFetching}
                aria-label="刷新操作记录"
              >
                <RefreshCw
                  className={cn(
                    'size-4',
                    recordsQuery.isFetching && 'animate-spin',
                  )}
                />
              </Button>
            </div>
            {recordsQuery.isError ? (
              <div className="p-4">
                <OperationsError
                  message={recordsQuery.error.message}
                  onRetry={() => void recordsQuery.refetch()}
                />
              </div>
            ) : (
              <>
                <Table<OperationRecord>
                  rowKey="id"
                  columns={columns}
                  dataSource={recordsQuery.data?.items || []}
                  loading={recordsQuery.isPending}
                  pagination={false}
                  size="middle"
                  scroll={{ x: scope === 'all' ? 1180 : 1030 }}
                  locale={{
                    emptyText: (
                      <div className="py-12 text-sm text-muted-foreground">
                        暂无符合条件的操作
                      </div>
                    ),
                  }}
                />
                <OperationsPagination
                  page={page}
                  pageCount={recordsQuery.data?.pageCount || 1}
                  total={recordsQuery.data?.total || 0}
                  onChange={(value: number) => setFilter('page', String(value))}
                />
              </>
            )}
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            记录平台页面、MCP
            和批量操作发起的需求修改；核心修改与后续协作分别确认。
          </p>
          <OperationDetail
            currentUserId={accessQuery.data?.userId}
            item={recordsQuery.isError ? null : selectedCurrent}
            canManage={canViewAll}
            onChanged={() => void recordsQuery.refetch()}
            onClose={() => setSelected(null)}
          />
        </TabsContent>
        {canViewAll ? (
          <>
            <OperationRuntimeTabs userId={accessQuery.data.userId} tab={tab} />
            <TabsContent value="deliveries" className="mt-3">
              <NotificationLedger
                userId={accessQuery.data.userId}
                active={tab === 'deliveries'}
                canManage={canViewAll}
              />
            </TabsContent>
            <OperationsInsightsTabs
              userId={accessQuery.data.userId}
              tab={tab}
              canManage={canViewAll}
            />
          </>
        ) : null}
      </Tabs>
    </div>
  );
};

export default OperationsPage;
