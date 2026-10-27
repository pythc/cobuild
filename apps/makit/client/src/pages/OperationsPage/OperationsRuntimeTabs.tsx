import { useState } from 'react';
import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  OperationsReviewRecord,
  WorkflowNotificationRecord,
} from '@shared/api.interface';
import { operationsApi } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { OPERATIONS_QUERY_KEY } from '@/hooks/use-operations';
import { cn } from '@/lib/utils';
import { OperationsError, OperationsPagination } from './OperationsCommon';
import { operationTime } from './operations-presentation';

const REVIEW_LABELS: Record<string, string> = {
  clarity: '需求清晰度',
  technical: '技术与稳定性',
  delivery: '交付准备',
  requirement_clarity: '需求清晰度',
  technical_stability: '技术与稳定性',
  delivery_readiness: '交付准备',
};
const REVIEW_STATUS: Record<string, string> = {
  not_started: '未发起',
  queued: '待评审',
  running: '评审中',
  succeeded: '已评审',
  completed: '已评审',
  failed: '评审失败',
  stale: '内容已更新',
  superseded: '内容已更新',
  skipped: '无需评审',
};

export const OperationRuntimeTabs: FC<{ userId: string; tab: string }> = ({
  userId,
  tab,
}) => {
  const [reviewPage, setReviewPage] = useState<number>(1);
  const [notificationPage, setNotificationPage] = useState<number>(1);
  const reviews = useQuery({
    queryKey: [...OPERATIONS_QUERY_KEY, 'reviews', userId, reviewPage],
    queryFn: ({ signal }) =>
      operationsApi.getReviews({ page: reviewPage, pageSize: 25 }, signal),
    enabled: tab === 'reviews',
    retry: false,
    refetchInterval: tab === 'reviews' ? 15_000 : false,
  });
  const notifications = useQuery({
    queryKey: [...OPERATIONS_QUERY_KEY, 'workflow', userId, notificationPage],
    queryFn: ({ signal }) =>
      operationsApi.getWorkflowNotifications(
        { page: notificationPage, pageSize: 25 },
        signal,
      ),
    enabled: tab === 'workflow',
    retry: false,
    refetchInterval: false,
  });
  const reviewColumns: TableColumnsType<OperationsReviewRecord> = [
    {
      title: '评审类型',
      key: 'type',
      width: 180,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <span className="font-medium">
          {REVIEW_LABELS[row.reviewType] || row.reviewType}
        </span>
      ),
    },
    {
      title: '需求',
      key: 'requirement',
      width: 180,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <Link
          to={`/requirements/${encodeURIComponent(row.requirementId)}`}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {row.requirementId}
          <ArrowUpRight className="size-3" />
        </Link>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <Badge
          variant="outline"
          className={cn(
            row.status === 'failed' && 'border-red-200 bg-red-50 text-red-700',
          )}
        >
          {REVIEW_STATUS[row.status] || row.status}
        </Badge>
      ),
    },
    {
      title: '得分',
      key: 'score',
      width: 85,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <span className="tabular-nums">{row.score ?? '—'}</span>
      ),
    },
    {
      title: '最近更新',
      key: 'updatedAt',
      width: 140,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <span className="text-xs text-muted-foreground">
          {operationTime(row.updatedAt)}
        </span>
      ),
    },
    {
      title: '异常原因',
      key: 'error',
      width: 300,
      render: (_: unknown, row: OperationsReviewRecord) => (
        <span className="break-words text-xs text-destructive">
          {row.errorMessage || '—'}
        </span>
      ),
    },
  ];
  const notificationColumns: TableColumnsType<WorkflowNotificationRecord> = [
    {
      title: '事件',
      key: 'event',
      width: 150,
      render: (_: unknown, row: WorkflowNotificationRecord) => (
        <span className="font-medium">{row.eventType || '需求变更'}</span>
      ),
    },
    {
      title: '需求',
      key: 'requirements',
      width: 185,
      render: (_: unknown, row: WorkflowNotificationRecord) => (
        <div className="flex flex-wrap gap-1">
          {row.requirementIds.map((id: string) => (
            <Link
              key={id}
              to={`/requirements/${encodeURIComponent(id)}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {id}
              <ArrowUpRight className="size-3" />
            </Link>
          ))}
        </div>
      ),
    },
    {
      title: '执行状态',
      key: 'status',
      width: 120,
      render: (_: unknown, row: WorkflowNotificationRecord) => (
        <Badge variant="outline">{row.status || '未知'}</Badge>
      ),
    },
    {
      title: '最近更新',
      key: 'updatedAt',
      width: 140,
      render: (_: unknown, row: WorkflowNotificationRecord) => (
        <span className="text-xs text-muted-foreground">
          {operationTime(row.updatedAt)}
        </span>
      ),
    },
    {
      title: '摘要 / 异常',
      key: 'summary',
      width: 380,
      render: (_: unknown, row: WorkflowNotificationRecord) => (
        <div className="space-y-1 text-xs">
          <p className="break-words text-muted-foreground">
            {row.summary || '—'}
          </p>
          {row.errorMessage ? (
            <p className="break-words text-destructive">{row.errorMessage}</p>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <TabsContent value="reviews" className="mt-3">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">AI 评审记录</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={reviews.isFetching}
              onClick={() => void reviews.refetch()}
              aria-label="刷新评审记录"
            >
              <RefreshCw
                className={cn('size-4', reviews.isFetching && 'animate-spin')}
              />
            </Button>
          </div>
          {reviews.isError ? (
            <div className="p-4">
              <OperationsError
                message={reviews.error.message}
                onRetry={() => void reviews.refetch()}
              />
            </div>
          ) : (
            <>
              <Table<OperationsReviewRecord>
                rowKey="id"
                columns={reviewColumns}
                dataSource={reviews.data?.items || []}
                loading={reviews.isPending}
                pagination={false}
                size="middle"
                scroll={{ x: 1080 }}
                locale={{ emptyText: '暂无评审记录' }}
              />
              <OperationsPagination
                page={reviewPage}
                pageCount={reviews.data?.pageCount || 1}
                total={reviews.data?.total || 0}
                onChange={setReviewPage}
              />
            </>
          )}
        </div>
      </TabsContent>
      <TabsContent value="workflow" className="mt-3 space-y-3">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">工作流通知记录</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={notifications.isFetching}
              onClick={() => void notifications.refetch()}
              aria-label="刷新工作流通知记录"
            >
              <RefreshCw
                className={cn(
                  'size-4',
                  notifications.isFetching && 'animate-spin',
                )}
              />
            </Button>
          </div>
          {notifications.isError ? (
            <div className="p-4">
              <OperationsError
                message={notifications.error.message}
                onRetry={() => void notifications.refetch()}
              />
            </div>
          ) : (
            <>
              <Table<WorkflowNotificationRecord>
                rowKey="id"
                columns={notificationColumns}
                dataSource={notifications.data?.items || []}
                loading={notifications.isPending}
                pagination={false}
                size="middle"
                scroll={{ x: 1040 }}
                locale={{ emptyText: '暂无工作流通知记录' }}
              />
              <OperationsPagination
                page={notificationPage}
                pageCount={notifications.data?.pageCount || 1}
                total={notifications.data?.total || 0}
                onChange={setNotificationPage}
              />
            </>
          )}
        </div>
        {notifications.data?.coverageNote ? (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            {notifications.data.coverageNote}
          </p>
        ) : null}
      </TabsContent>
    </>
  );
};
