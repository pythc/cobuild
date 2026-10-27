import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';
import { ArrowUpRight, RefreshCw, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { AiExecutionSummary } from '@shared/operations-insights.interface';
import * as api from '@/api/operations-insights';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { OperationsError, OperationsPagination } from './OperationsCommon';
import { operationTime } from './operations-presentation';
import { OperationsSettingsDialog } from './OperationsSettingsDialog';

const label: Record<string, string> = {
  feishu: '飞书',
  github: 'GitHub',
  deepseek: 'AI 模型',
  database: '数据库',
  experience: '使用体验',
  completed: '已完成',
  running: '执行中',
  failed: '未完成',
  stale: '内容已更新',
  adopted: '已采纳',
  ignored: '已忽略',
  pending: '观察中',
  open: '需处理',
  recovered: '已恢复',
  disabled: '未启用外发',
  queued: '已交给通知中心',
  clarity: '需求清晰度',
  technical_stability: '技术与稳定性',
  delivery_readiness: '交付准备',
};
const Metric = ({
  title,
  value,
  hint,
}: {
  title: string;
  value: string | number;
  hint?: string;
}) => (
  <div className="rounded-xl border bg-card p-4">
    <p className="text-xs text-muted-foreground">{title}</p>
    <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
      {value}
    </p>
    {hint && <p className="mt-2 text-[11px] text-muted-foreground">{hint}</p>}
  </div>
);

export function OperationsInsightsTabs({
  userId,
  tab,
  canManage,
}: {
  userId: string;
  tab: string;
  canManage: boolean;
}) {
  const [page, setPage] = useState(1),
    [settingsOpen, setSettingsOpen] = useState(false),
    [feedback, setFeedback] = useState<{
      row: AiExecutionSummary;
      action: 'adopted' | 'ignored';
    } | null>(null),
    [reason, setReason] = useState(''),
    [saving, setSaving] = useState(false);
  const executions = useQuery({
    queryKey: ['operations', 'insights', 'executions', userId, page],
    queryFn: ({ signal }) => api.getExecutions(page, signal),
    enabled: tab === 'usage',
    retry: false,
    refetchInterval: tab === 'usage' ? 15000 : false,
  });
  const executionColumns: TableColumnsType<AiExecutionSummary> = [
    {
      title: '评审',
      key: 'review',
      width: 190,
      render: (_, row) => (
        <div>
          <span className="font-medium">
            {label[row.reviewType] || row.reviewType}
          </span>
          <Link
            className="mt-1 flex items-center gap-1 text-xs text-primary"
            to={`/requirements/${row.requirementId}`}
          >
            {row.requirementId}
            <ArrowUpRight className="size-3" />
          </Link>
        </div>
      ),
    },
    {
      title: '结果',
      key: 'status',
      width: 110,
      render: (_, row) => (
        <Badge
          variant="outline"
          className={
            row.status === 'failed'
              ? 'border-red-200 bg-red-50 text-red-700'
              : ''
          }
        >
          {label[row.status] || row.status}
        </Badge>
      ),
    },
    {
      title: '模型 / 规则',
      key: 'model',
      width: 195,
      render: (_, row) => (
        <div className="text-xs">
          <p>{row.model}</p>
          <p className="mt-1 text-muted-foreground">
            {row.ruleSetVersion} · 第 {row.attempt} 次
          </p>
        </div>
      ),
    },
    {
      title: '输入 / 输出 token',
      key: 'tokens',
      width: 170,
      render: (_, row) => (
        <span className="tabular-nums">
          {row.inputTokens?.toLocaleString() ?? '未知'} /{' '}
          {row.outputTokens?.toLocaleString() ?? '未知'}
        </span>
      ),
    },
    {
      title: '估算费用',
      key: 'cost',
      width: 150,
      render: (_, row) => (
        <div className="text-xs">
          {row.estimatedCost === null
            ? '未知'
            : `${row.currency} ${row.estimatedCost.toFixed(6)}`}
          <p className="mt-1 text-muted-foreground">
            {row.pricingVersion || '未配置价格版本'}
          </p>
        </div>
      ),
    },
    {
      title: '执行时间',
      key: 'at',
      width: 145,
      render: (_, row) => operationTime(row.startedAt),
    },
    {
      title: '反馈 / 异常',
      key: 'feedback',
      width: 220,
      render: (_, row) => (
        <div className="text-xs">
          {row.errorMessage ? (
            <p className="text-destructive">{row.errorMessage}</p>
          ) : row.feedback ? (
            <p>
              {label[row.feedback]}：{row.feedbackReason}
            </p>
          ) : canManage && ['completed', 'stale'].includes(row.status) ? (
            <div className="flex gap-1">
              {(['adopted', 'ignored'] as const).map((action) => (
                <Button
                  key={action}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFeedback({ row, action });
                    setReason('');
                  }}
                >
                  {action === 'adopted' ? '采纳' : '忽略'}
                </Button>
              ))}
            </div>
          ) : (
            '—'
          )}
        </div>
      ),
    },
  ];
  const refresh = (busy: boolean, action: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={action}
      aria-label="刷新"
    >
      <RefreshCw className="size-4" />
    </Button>
  );
  return (
    <>
      <TabsContent value="usage" className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">AI 执行与用量</h2>
          <div className="flex gap-2">
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 className="size-4" />
                运行设置
              </Button>
            )}
            {refresh(executions.isFetching, () => void executions.refetch())}
          </div>
        </div>
        {executions.isError ? (
          <OperationsError
            message={executions.error.message}
            onRetry={() => void executions.refetch()}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                title="近 7 天执行次数"
                value={executions.data?.usage.executionCount ?? '—'}
              />
              <Metric
                title="已知输入 / 输出 token"
                value={
                  executions.data
                    ? `${executions.data.usage.inputTokens.toLocaleString()} / ${executions.data.usage.outputTokens.toLocaleString()}`
                    : '—'
                }
              />
              <Metric
                title="估算费用"
                value={
                  executions.data?.usage.estimatedCosts
                    .map((item) => `${item.currency} ${item.amount.toFixed(4)}`)
                    .join(' · ') || '未知'
                }
              />
              <Metric
                title="用量未知 / 费用未知"
                value={
                  executions.data
                    ? `${executions.data.usage.unknownUsageCount} / ${executions.data.usage.unknownCostCount}`
                    : '—'
                }
                hint="未返回 usage 的执行不会按 0 计费"
              />
            </div>
            {executions.data?.usage.budgetExceeded && (
              <div
                role="alert"
                className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              >
                今日估算费用超过提醒预算；必需评审仍正常执行。
              </div>
            )}
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table
                rowKey="id"
                columns={executionColumns}
                dataSource={executions.data?.items || []}
                loading={executions.isPending}
                pagination={false}
                size="middle"
                scroll={{ x: 1180 }}
                locale={{ emptyText: '暂无执行记录' }}
              />
              <OperationsPagination
                page={page}
                pageCount={executions.data?.pageCount || 1}
                total={executions.data?.total || 0}
                onChange={setPage}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              每次重试保留独立执行记录。价格按执行时版本估算，不等同于供应商账单。
            </p>
          </>
        )}
      </TabsContent>
      {canManage && (
        <OperationsSettingsDialog
          userId={userId}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
      <Dialog
        open={!!feedback}
        onOpenChange={(open) => !open && setFeedback(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {feedback?.action === 'adopted' ? '采纳评审建议' : '忽略评审建议'}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明实际采用了哪些建议，或为什么不适用"
            maxLength={1000}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFeedback(null)}>
              取消
            </Button>
            <Button
              disabled={saving || reason.trim().length < 2}
              onClick={() => {
                if (!feedback) return;
                setSaving(true);
                void api
                  .saveFeedback(feedback.row.id, feedback.action, reason.trim())
                  .then(() => {
                    toast.success('已修改');
                    setFeedback(null);
                    void executions.refetch();
                  })
                  .catch((error) => toast.error(error.message))
                  .finally(() => setSaving(false));
              }}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
