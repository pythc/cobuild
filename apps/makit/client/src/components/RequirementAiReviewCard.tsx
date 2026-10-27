import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type {
  RequirementAiReviewSummary,
  RequirementEngineeringResponse,
} from '@shared/api.interface';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  overrideRequirementReview,
  retryRequirementReview,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, formatDate } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';

const REVIEW_LABELS = {
  clarity: '需求清晰度评审',
  technical_stability: '技术与稳定性评审',
  delivery_readiness: '交付准备评审',
};

const VERDICT_LABELS = {
  passed: '通过',
  needs_attention: '建议完善',
  blocked: '存在阻断',
};

export default function RequirementAiReviewCard({
  requirementId,
  review,
  canUpdate,
  canOverride,
  compact = false,
  onUpdated,
}: {
  requirementId: string;
  review: RequirementAiReviewSummary;
  canUpdate: boolean;
  canOverride: boolean;
  compact?: boolean;
  onUpdated: (data: RequirementEngineeringResponse) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');
  const retryMutation = useMutation({
    mutationFn: () => retryRequirementReview(requirementId, review.type),
    onSuccess: (data) => {
      onUpdated(data);
      toast.success('已开始重新评审');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const overrideMutation = useMutation({
    mutationFn: () =>
      overrideRequirementReview(requirementId, review.type, { reason }),
    onSuccess: (data) => {
      onUpdated(data);
      setOverrideOpen(false);
      setReason('');
      toast.success('已记录风险放行');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const active = ['queued', 'running'].includes(review.status);
  const completed = review.status === 'completed';
  const stale = Boolean(review.id) && !review.current;
  const canExpand =
    !compact &&
    ((completed && review.current) || review.status === 'failed');
  const statusLabel = active
    ? review.status === 'queued'
      ? '等待评审'
      : '评审中'
    : review.status === 'failed'
      ? '评审失败'
      : completed && review.verdict
        ? VERDICT_LABELS[review.verdict]
        : '尚未评审';
  const accent = review.verdict === 'passed'
    ? 'border-emerald-200 bg-emerald-50/50'
    : review.verdict === 'blocked' || review.status === 'failed'
      ? 'border-red-200 bg-red-50/45'
      : 'border-amber-200 bg-amber-50/40';

  useEffect(() => {
    setExpanded(false);
  }, [review.id]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-background transition-colors',
        !compact && accent,
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 px-4 py-3',
          expanded && !compact && 'border-b',
        )}
      >
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left',
            canExpand &&
              'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          )}
          onClick={() => {
            if (canExpand) setExpanded((value) => !value);
          }}
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              !canExpand && 'opacity-0',
              expanded && 'rotate-90',
            )}
          />
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {active ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : review.verdict === 'passed' ? (
              <CheckCircle2 className="size-4" />
            ) : review.verdict === 'blocked' || review.status === 'failed' ? (
              <ShieldAlert className="size-4" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {REVIEW_LABELS[review.type]}
            </p>
            <p className="text-xs text-muted-foreground">
              {stale ? '内容已变化，需要重新评审' : statusLabel}
              {review.overridden ? ` · ${review.overriddenByName} 已放行` : ''}
              {review.finishedAt || review.createdAt
                ? ` · ${formatDate(review.finishedAt || review.createdAt, true)}`
                : ''}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-2">
          {completed && review.current && review.score != null ? (
            <span className="text-2xl font-semibold tabular-nums text-primary">
              {review.score}
              <span className="ml-0.5 text-xs font-normal">分</span>
            </span>
          ) : null}
          <Badge variant="outline">{stale ? '需更新' : statusLabel}</Badge>
          {canUpdate && (!active || stale) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
            >
              <RefreshCw className={cn('size-3.5', retryMutation.isPending && 'animate-spin')} />
              {review.id ? '重新评审' : '立即评审'}
            </Button>
          ) : null}
        </div>
      </div>

      {!compact && expanded && completed && review.current ? (
        <div className="space-y-4 p-4">
          {review.summary ? (
            <p className="text-sm leading-6 text-foreground/85">{review.summary}</p>
          ) : null}
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {review.dimensions.map((dimension) => (
              <div key={dimension.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium">{dimension.label}</span>
                  <span className="tabular-nums text-muted-foreground">{dimension.score}</span>
                </div>
                <Progress value={dimension.score} className="h-1.5" />
                {dimension.comment ? (
                  <p className="line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                    {dimension.comment}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {review.findings.length ? (
            <div className="space-y-2">
              {review.findings.map((finding, index) => (
                <div
                  key={`${finding.title}-${index}`}
                  className={cn(
                    'rounded-lg border bg-background/80 px-3 py-2.5 text-sm',
                    finding.severity === 'blocker' && 'border-red-200',
                    finding.severity === 'warning' && 'border-amber-200',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {finding.severity === 'blocker' ? (
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-600" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium">{finding.title}</p>
                      <p className="mt-1 leading-5 text-muted-foreground">{finding.description}</p>
                      {finding.recommendation ? (
                        <p className="mt-1 leading-5 text-foreground/80">
                          建议：{finding.recommendation}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
              未发现需要特别处理的问题。
            </div>
          )}
          {review.overridden ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              风险放行：{review.overrideReason}
            </div>
          ) : canOverride && ['blocked', 'needs_attention'].includes(review.verdict || '') ? (
            <Button variant="outline" size="sm" onClick={() => setOverrideOpen(true)}>
              风险放行
            </Button>
          ) : null}
        </div>
      ) : null}

      {!compact && expanded && review.status === 'failed' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-destructive">
          <span>{review.errorMessage || '评审服务暂时不可用，请重新评审。'}</span>
          {canOverride ? (
            <Button variant="outline" size="sm" onClick={() => setOverrideOpen(true)}>
              风险放行
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>记录风险放行</DialogTitle>
            <DialogDescription>
              放行不会修改 AI 结论，仅允许当前版本继续流转，并保留操作记录。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明已确认的风险、影响范围和后续措施"
            className="min-h-28"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideOpen(false)}>取消</Button>
            <Button
              onClick={() => overrideMutation.mutate()}
              disabled={reason.trim().length < 5 || overrideMutation.isPending}
            >
              {overrideMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认放行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
