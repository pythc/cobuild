import type {
  NotificationDeliveryStatus,
  NotificationDeliverySummary,
} from '@shared/api.interface';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Inbox,
  Info,
  MinusCircle,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/WorkspaceStates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useNotificationDeliveries } from '@/hooks/use-notifications';
import { cn } from '@/lib/utils';

const PAGE_SIZE: number = 25;
const ALL_STATUS: string = 'all';
const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'retrying',
  'failed',
  'delivered',
  'suppressed',
]);

const STATUS_META: Record<
  NotificationDeliveryStatus,
  { label: string; className: string }
> = {
  pending: {
    label: '待发送',
    className: 'border-slate-200 bg-slate-50 text-slate-700',
  },
  retrying: {
    label: '等待重试',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  failed: {
    label: '发送失败',
    className: 'border-red-200 bg-red-50 text-red-700',
  },
  delivered: {
    label: '已送达',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  suppressed: {
    label: '已抑制',
    className: 'border-violet-200 bg-violet-50 text-violet-700',
  },
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed: Date = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function StatusBadge({ status }: { status: NotificationDeliveryStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={meta.className}>
      {meta.label}
    </Badge>
  );
}

function DeliverySource({ item }: { item: NotificationDeliverySummary }) {
  return (
    <div className="min-w-0">
      <Link
        to={`/pull-requests/${item.pullNumber}`}
        className="line-clamp-2 font-medium text-foreground hover:text-primary hover:underline"
      >
        #{item.pullNumber} {item.pullTitle}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{item.repository}</span>
        <a
          href={item.pullExternalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-primary"
        >
          GitHub
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus: string = searchParams.get('status') || ALL_STATUS;
  const rawStatus: string = VALID_STATUSES.has(requestedStatus)
    ? requestedStatus
    : ALL_STATUS;
  const status: NotificationDeliveryStatus | undefined =
    rawStatus === ALL_STATUS
      ? undefined
      : (rawStatus as NotificationDeliveryStatus);
  const page: number = Math.max(
    1,
    Math.trunc(Number(searchParams.get('page')) || 1),
  );
  const query = useNotificationDeliveries(status, page, PAGE_SIZE);

  const setFilter = (nextStatus: string): void => {
    const next = new URLSearchParams(searchParams);
    if (nextStatus === ALL_STATUS) next.delete('status');
    else next.set('status', nextStatus);
    next.delete('page');
    setSearchParams(next);
  };

  const setPage = (nextPage: number): void => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete('page');
    else next.set('page', String(nextPage));
    setSearchParams(next);
  };

  if (query.isLoading && !query.data) {
    return <LoadingState label="正在加载通知运行记录" />;
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        message={query.error?.message || '获取通知运行记录失败'}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;
  const stats = [
    {
      key: ALL_STATUS,
      label: '全部记录',
      value: data.stats.total,
      icon: Inbox,
      tone: 'bg-blue-50 text-blue-700',
    },
    {
      key: 'pending',
      label: '待发送',
      value: data.stats.pending,
      icon: Clock3,
      tone: 'bg-slate-100 text-slate-700',
    },
    {
      key: 'retrying',
      label: '等待重试',
      value: data.stats.retrying,
      icon: RotateCw,
      tone: 'bg-amber-50 text-amber-700',
    },
    {
      key: 'failed',
      label: '发送失败',
      value: data.stats.failed,
      icon: AlertCircle,
      tone: 'bg-red-50 text-red-700',
    },
    {
      key: 'delivered',
      label: '已送达',
      value: data.stats.delivered,
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-700',
    },
    {
      key: 'suppressed',
      label: '已抑制',
      value: data.stats.suppressed,
      icon: MinusCircle,
      tone: 'bg-violet-50 text-violet-700',
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          通知运行中心
        </h1>
        <Button
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw
            className={cn('size-4', query.isFetching && 'animate-spin')}
          />
          刷新记录
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map(({ key, label, value, icon: Icon, tone }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/30',
              rawStatus === key && 'border-primary ring-1 ring-primary/20',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span
                className={cn(
                  'grid size-8 place-items-center rounded-lg',
                  tone,
                )}
              >
                <Icon className="size-4" />
              </span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </button>
        ))}
      </div>

      <div className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          {data.coverage.note}
          {data.stats.reconciling > 0
            ? ` 当前另有 ${data.stats.reconciling} 条评审变更正在等待 GitHub 权威状态补偿。`
            : ''}
        </p>
      </div>

      <Card className="overflow-hidden rounded-lg shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
          <Select value={rawStatus} onValueChange={setFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUS}>全部状态</SelectItem>
              <SelectItem value="pending">待发送</SelectItem>
              <SelectItem value="retrying">等待重试</SelectItem>
              <SelectItem value="failed">发送失败</SelectItem>
              <SelectItem value="delivered">已送达</SelectItem>
              <SelectItem value="suppressed">已抑制</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            共 {data.total} 条
          </span>
        </div>

        {data.items.length ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">状态</TableHead>
                    <TableHead className="w-[190px]">收件人</TableHead>
                    <TableHead>来源合并请求</TableHead>
                    <TableHead className="w-[190px]">尝试与时间</TableHead>
                    <TableHead className="w-[260px]">失败原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="align-top">
                        <StatusBadge status={item.status} />
                        <p className="mt-2 text-xs text-muted-foreground">
                          飞书私聊
                        </p>
                      </TableCell>
                      <TableCell className="align-top">
                        <p className="font-medium">{item.recipientName}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          GitHub: {item.githubLogin || '未绑定'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          由 {item.assignedByName} 添加
                        </p>
                      </TableCell>
                      <TableCell className="align-top">
                        <DeliverySource item={item} />
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        <p className="tabular-nums">
                          尝试 {item.attempts}/{item.maxAttempts} 次
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          入队 {formatDateTime(item.queuedAt)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.deliveredAt
                            ? `送达 ${formatDateTime(item.deliveredAt)}`
                            : item.lastAttemptAt
                              ? `最近尝试 ${formatDateTime(item.lastAttemptAt)}`
                              : '尚未尝试'}
                        </p>
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        {item.errorMessage || item.suppressionReason ? (
                          <p
                            className={cn(
                              'break-words',
                              item.status === 'suppressed'
                                ? 'text-violet-700'
                                : 'text-red-700',
                            )}
                            title={item.errorMessage || item.suppressionReason}
                          >
                            {item.errorMessage || item.suppressionReason}
                          </p>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="divide-y md:hidden">
              {data.items.map((item) => (
                <div key={item.id} className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <StatusBadge status={item.status} />
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {item.attempts}/{item.maxAttempts} 次
                    </span>
                  </div>
                  <DeliverySource item={item} />
                  <div className="text-sm">
                    <span className="font-medium">{item.recipientName}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · GitHub {item.githubLogin || '未绑定'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    入队 {formatDateTime(item.queuedAt)}
                    {item.deliveredAt
                      ? ` · 送达 ${formatDateTime(item.deliveredAt)}`
                      : item.lastAttemptAt
                        ? ` · 最近尝试 ${formatDateTime(item.lastAttemptAt)}`
                        : ''}
                  </p>
                  {item.errorMessage || item.suppressionReason ? (
                    <p
                      className={cn(
                        'rounded-md px-3 py-2 text-sm',
                        item.status === 'suppressed'
                          ? 'bg-violet-50 text-violet-700'
                          : 'bg-red-50 text-red-700',
                      )}
                    >
                      {item.errorMessage || item.suppressionReason}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : (
          <CardContent className="p-4">
            <EmptyState
              title="没有对应的通知记录"
              description="可切换状态查看其他已持久化的投递记录。"
            />
          </CardContent>
        )}

        {data.pageCount > 1 ? (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-sm text-muted-foreground">
              第 {data.page} / {data.pageCount} 页
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.page <= 1}
                onClick={() => setPage(data.page - 1)}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page >= data.pageCount}
                onClick={() => setPage(data.page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
