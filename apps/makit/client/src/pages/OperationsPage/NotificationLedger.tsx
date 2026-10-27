import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { operationsApi } from '@/api';
import type {
  NotificationLedgerItem,
  NotificationRetryPreview,
} from '@shared/notification-ledger';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { OperationsError, OperationsPagination } from './OperationsCommon';
import { operationTime } from './operations-presentation';

const states: Record<string, string> = {
  shadow: '仅记录',
  pending: '待发送',
  sending: '发送中',
  sent: '发送成功',
  retry_wait: '待重试',
  failed: '发送失败',
  suppressed: '策略跳过',
  unknown: '待核实',
};
export function NotificationLedger({
  userId,
  active,
  canManage,
}: {
  userId: string;
  active: boolean;
  canManage: boolean;
}) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<NotificationRetryPreview | null>(null);
  const query = useQuery({
    queryKey: ['operations', 'notification-deliveries', userId, page],
    queryFn: ({ signal }) => operationsApi.getDeliveries(page, signal),
    enabled: active,
    retry: false,
    refetchInterval: active ? 15000 : false,
  });
  const retry = useMutation({
    mutationFn: async () =>
      setPreview(await operationsApi.previewDeliveryRetry(selected)),
    onError: (error) => toast.error(error.message),
  });
  const confirm = useMutation({
    mutationFn: async () => {
      if (!preview) return;
      const result = await operationsApi.confirmDeliveryRetry(preview.token);
      toast.success(`已安排重试 ${result.acceptedCount} 条通知`);
      setPreview(null);
      setSelected([]);
      await query.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const columns: TableColumnsType<NotificationLedgerItem> = [
    ...(canManage
      ? [
          {
            title: '选择',
            key: 'select',
            width: 60,
            render: (_: unknown, row: NotificationLedgerItem) => (
              <Checkbox
                aria-label={`选择 ${row.targetName} 的失败通知`}
                checked={selected.includes(row.id)}
                disabled={row.state !== 'failed'}
                onCheckedChange={(checked) =>
                  setSelected((ids) =>
                    checked
                      ? [...new Set([...ids, row.id])]
                      : ids.filter((id) => id !== row.id),
                  )
                }
              />
            ),
          },
        ]
      : []),
    {
      title: '接收人 / 群',
      key: 'target',
      width: 190,
      render: (_, row) => (
        <div>
          <p className="font-medium">{row.targetName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.channel === 'feishu_group' ? '群聊' : '私聊'}
          </p>
        </div>
      ),
    },
    {
      title: '通知来源',
      key: 'source',
      width: 190,
      render: (_, row) => (
        <div className="text-xs">
          <p>
            {row.source === 'pr_reviewer'
              ? `PR #${row.pullNumber}`
              : row.source === 'operational_alert'
                ? '运行提醒'
                : row.requirementId || '需求协作'}
          </p>
          <a
            href={row.platformUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-primary"
          >
            查看平台记录
            <ArrowUpRight className="size-3" />
          </a>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 120,
      render: (_, row) => (
        <Badge
          variant="outline"
          className={
            row.state === 'failed'
              ? 'text-destructive'
              : row.state === 'unknown'
                ? 'text-amber-700'
                : ''
          }
        >
          {states[row.state] || '未知'}
        </Badge>
      ),
    },
    {
      title: '尝试 / 时间',
      key: 'time',
      width: 165,
      render: (_, row) => (
        <div className="text-xs">
          <p>
            {row.attempts} / {row.maxAttempts} 次
          </p>
          <p className="mt-1 text-muted-foreground">
            {operationTime(row.updatedAt)}
          </p>
        </div>
      ),
    },
    {
      title: '回执 / 原因',
      key: 'receipt',
      width: 290,
      render: (_, row) => (
        <div className="break-all text-xs text-muted-foreground">
          {row.messageId ||
            row.lastErrorCode ||
            (row.owner === 'shadow' ? '影子记录，不会外发' : '—')}
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
          <h2 className="text-sm font-semibold">通知投递台账</h2>
          <div className="flex gap-2">
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={!selected.length || retry.isPending || query.isError}
                onClick={() => retry.mutate()}
              >
                预览失败项重试 {selected.length || ''}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label="刷新投递台账"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
        {query.isError ? (
          <OperationsError
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <Table
              rowKey="id"
              columns={columns}
              dataSource={query.data?.items || []}
              loading={query.isPending}
              pagination={false}
              scroll={{ x: 1100 }}
              size="middle"
              locale={{ emptyText: '暂无投递记录' }}
            />
            <OperationsPagination
              page={page}
              pageCount={query.data?.pageCount || 1}
              total={query.data?.total || 0}
              onChange={(value) => {
                setPage(value);
                setSelected([]);
              }}
            />
          </>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {query.data?.coverageNote}
      </p>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => !open && !confirm.isPending && setPreview(null)}
      >
        <DialogContent className="max-w-2xl max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>确认通知重试</DialogTitle>
            <DialogDescription>
              只重试已确认失败的通知。成功、策略跳过和待核实记录不会重放。
            </DialogDescription>
          </DialogHeader>
          <div className="divide-y rounded-lg border">
            {preview?.items.map((item) => (
              <div key={item.id} className="p-3 text-sm">
                <p className="font-medium">
                  {item.targetName} · {item.eligible ? '可重试' : '不会重试'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.reason}
                </p>
                <a
                  className="mt-1 inline-block text-xs text-primary"
                  href={item.platformUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  核对目标记录
                </a>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPreview(null)}
              disabled={confirm.isPending}
            >
              取消
            </Button>
            <Button
              disabled={!preview?.eligibleCount || confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              确认重试 {preview?.eligibleCount || 0} 条
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
