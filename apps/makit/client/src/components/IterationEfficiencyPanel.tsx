import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';
import { RefreshCw } from 'lucide-react';
import type { IterationEfficiencyRequirement } from '@shared/operations-insights.interface';
import { ANALYSIS_STAGE_LABELS } from '@shared/iteration-analysis';
import { operationsInsightsApi } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/WorkspaceStates';

export function IterationEfficiencyPanel({
  iterationId,
  userId,
}: {
  iterationId: string;
  userId: string;
}) {
  const [kind, setKind] = useState<'requirement' | 'defect'>('requirement'),
    [stage, setStage] = useState('');
  const query = useQuery({
    queryKey: ['iteration-efficiency', iterationId, userId],
    queryFn: ({ signal }) =>
      operationsInsightsApi.getIterationEfficiency(iterationId, signal),
    retry: false,
  });
  const data = query.data;
  const columns: TableColumnsType<IterationEfficiencyRequirement> = [
    {
      title: '需求',
      key: 'requirement',
      width: 290,
      render: (_, row) => (
        <Link
          className="font-medium hover:text-primary"
          to={`/requirements/${row.id}`}
        >
          <span className="line-clamp-2">{row.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {row.code}
          </span>
        </Link>
      ),
    },
    {
      title: '状态 / 停留',
      key: 'state',
      width: 165,
      render: (_, row) => (
        <div>
          <Badge variant="outline">{row.status}</Badge>
          <p className="mt-2 text-xs text-muted-foreground">
            {row.dwellHours === null
              ? '停留时间未知'
              : `${row.dwellHours} 小时`}
          </p>
        </div>
      ),
    },
    {
      title: '等待与风险',
      key: 'risk',
      width: 290,
      render: (_, row) => (
        <div className="space-y-1 text-xs">
          <p>{row.waitingFor.join('、') || '无已识别的等待'}</p>
          {row.missingFields.length > 0 && (
            <p className="text-amber-700">
              待补：{row.missingFields.join('、')}
            </p>
          )}
          {row.milestoneRisks.map((risk) => (
            <p key={risk} className="text-destructive">
              {risk}
            </p>
          ))}
          {row.blockingRequirementIds.map((id) => (
            <Link
              key={id}
              className="mr-2 text-primary"
              to={`/requirements/${id}`}
            >
              依赖 {id}
            </Link>
          ))}
        </div>
      ),
    },
    {
      title: '计划 / 实际完成',
      key: 'deadline',
      width: 185,
      render: (_, row) => (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {row.deadline
              ? new Date(row.deadline).toLocaleDateString()
              : '未设置计划'}
          </p>
          <p>
            {row.completedAt
              ? new Date(row.completedAt).toLocaleDateString()
              : '未确认完成'}
          </p>
        </div>
      ),
    },
    {
      title: '退回 / 重开',
      key: 'returns',
      width: 110,
      render: (_, row) => `${row.returns} / ${row.reopens}`,
    },
    {
      title: '依据',
      key: 'basis',
      width: 130,
      render: (_, row) => (
        <div className="space-y-1 text-xs">
          {row.operationIds.length ? (
            <Link
              className="text-primary"
              to={`/operations?searchKind=operationId&search=${row.operationIds.at(-1)}`}
            >
              查看操作
            </Link>
          ) : (
            '无可靠历史'
          )}
          <p className="text-muted-foreground">
            {row.sourceEventIds.length} 条事件
            {!row.historyComplete ? ' · 历史不完整' : ''}
          </p>
        </div>
      ),
    },
  ];
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">迭代效能</h2>
        <div className="flex items-center gap-2">
          {(['requirement', 'defect'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? 'secondary' : 'ghost'}
              onClick={() => {
                setKind(value);
                setStage('');
              }}
            >
              {value === 'requirement' ? '需求' : '缺陷'}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新迭代效能"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      {query.isError ? (
        <ErrorState
          message={query.error.message}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data?.distributions
              .filter((item) => item.kind === kind)
              .map((item) => (
                <button
                  type="button"
                  key={item.stage}
                  onClick={() =>
                    setStage(stage === item.stage ? '' : item.stage)
                  }
                  className={`rounded-lg border p-3 text-left hover:border-primary/40 ${stage === item.stage ? 'border-primary bg-primary/5' : ''}`}
                >
                  <span className="text-xs text-muted-foreground">
                    {ANALYSIS_STAGE_LABELS[
                      item.stage as keyof typeof ANALYSIS_STAGE_LABELS
                    ] || item.stage}
                  </span>
                  <p className="mt-2 text-lg font-semibold">
                    {item.medianHours ?? '—'}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      小时 · 中位数
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    P85 {item.p85Hours ?? '—'} 小时 · {item.count} 个阶段样本
                  </p>
                </button>
              ))}
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table
              rowKey="id"
              columns={columns}
              dataSource={
                data?.requirements.filter(
                  (row) =>
                    row.kind === kind &&
                    (!stage ||
                      data.distributions.some(
                        (item) =>
                          item.kind === kind &&
                          item.stage === stage &&
                          item.requirementIds.includes(row.id),
                      )),
                ) || []
              }
              loading={query.isPending}
              pagination={{ pageSize: 15, showSizeChanger: false }}
              scroll={{ x: 1240 }}
              size="middle"
              locale={{ emptyText: '暂无符合条件的需求' }}
            />
          </div>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              范围变化与 PR 等待
            </summary>
            <div className="mt-3 space-y-2 text-sm">
              {data?.scopeChanges.map((change) => (
                <p key={change.eventId}>
                  <Link
                    className="text-primary"
                    to={`/requirements/${change.requirementId}`}
                  >
                    {change.requirementId}
                  </Link>{' '}
                  · {change.kind === 'added' ? '加入迭代' : '移出迭代'} ·{' '}
                  {new Date(change.at).toLocaleString()}
                </p>
              ))}
              {data?.pullRequests.map((pr) => (
                <div className="rounded border p-3" key={pr.number}>
                  <Link
                    className="text-primary"
                    to={`/pull-requests/${pr.number}`}
                  >
                    #{pr.number} {pr.title}
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    首次评审 {pr.firstReviewHours ?? '未知'} 小时 · 当前等待{' '}
                    {pr.waitingReviewHours ?? '未知'} 小时 · 再次评审中位数{' '}
                    {pr.repeatReviewHours ?? '未知'} 小时（
                    {pr.repeatReviewSamples ?? 0} 个样本）
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pr.basis}
                  </p>
                </div>
              ))}
              {!data?.scopeChanges.length && !data?.pullRequests.length && (
                <p className="text-muted-foreground">暂无可靠记录</p>
              )}
            </div>
          </details>
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              统计口径：{data?.clock === 'weekdays' ? '周一至周五' : '自然时间'}{' '}
              ·{' '}
              {data?.excludeBlockedTime ? '扣除已确认阻塞时段' : '包含阻塞时段'}{' '}
              · 历史缺失 {data?.historyMissing ?? '—'} 项
            </p>
            {data?.coverage.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
