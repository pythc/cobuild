import type { FC, ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  OperationRecord,
  OperationStage,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';
import { UserDisplay } from '@/components/business-ui/user-display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { OperationRecoveryActions } from './OperationRecoveryActions';
import {
  OPERATION_STATUS,
  operationTime,
  operationTitle,
} from './operations-presentation';

const OperationStatusBadge: FC<{ status: RequirementUpdateJobStatus }> = ({
  status,
}) => (
  <Badge variant="outline" className={OPERATION_STATUS[status].tone}>
    {OPERATION_STATUS[status].label}
  </Badge>
);

const OperationDetail: FC<{
  item: OperationRecord | null;
  onClose: () => void;
  canManage?: boolean;
  currentUserId?: string;
  onChanged?: () => void;
}> = ({ item, onClose, canManage, currentUserId, onChanged }) => (
  <Dialog
    open={Boolean(item)}
    onOpenChange={(open: boolean): void => {
      if (!open) onClose();
    }}
  >
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{item ? operationTitle(item) : '操作详情'}</DialogTitle>
        <DialogDescription className="sr-only">
          查看操作结果和各阶段执行情况
        </DialogDescription>
      </DialogHeader>
      {item ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <OperationStatusBadge status={item.status} />
            <span className="text-xs text-muted-foreground">
              {operationTime(item.createdAt)}
            </span>
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">修改字段</dt>
            <dd className="break-words">{item.fields.join('、') || '—'}</dd>
            {item.targetStatus ? (
              <>
                <dt className="text-muted-foreground">目标状态</dt>
                <dd>{item.targetStatus}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">操作人</dt>
            <dd>
              {item.actorUserId ? (
                <UserDisplay value={[item.actorUserId]} size="small" />
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-muted-foreground">操作编号</dt>
            <dd className="break-all font-mono text-xs text-muted-foreground">
              {item.id}
            </dd>
            {item.source && (
              <>
                <dt className="text-muted-foreground">来源</dt>
                <dd>
                  {{ web: '平台页面', mcp: 'MCP', bulk: '批量修改' }[
                    item.source
                  ] || item.source}
                </dd>
              </>
            )}
            {item.workflowVersion && (
              <>
                <dt className="text-muted-foreground">流程版本</dt>
                <dd>{item.workflowVersion}</dd>
              </>
            )}
            {item.traceId && (
              <>
                <dt className="text-muted-foreground">追踪编号</dt>
                <dd className="break-all font-mono text-xs">{item.traceId}</dd>
              </>
            )}
          </dl>
          {item.errorMessage ? (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm"
            >
              <p className="font-medium text-destructive">
                {item.status === 'unknown'
                  ? '本次修改结果待核实'
                  : '本次修改未完成'}
              </p>
              <p className="break-words">{item.errorMessage}</p>
              {item.errorCode ? (
                <p className="font-mono text-xs text-muted-foreground">
                  {item.errorCode}
                </p>
              ) : null}
            </div>
          ) : null}
          <ol className="space-y-0 rounded-xl border bg-muted/15 px-4">
            {item.stages.map(
              (stage: OperationStage, index: number): ReactNode => (
                <li
                  key={stage.key}
                  className={cn(
                    'relative flex gap-3 py-4',
                    index < item.stages.length - 1 &&
                      'border-b border-border/65',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full',
                      stage.status === 'succeeded'
                        ? 'bg-emerald-100 text-emerald-700'
                        : stage.status === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {stage.status === 'succeeded' ? (
                      <CheckCircle2 className="size-4" />
                    ) : stage.status === 'failed' ? (
                      <AlertCircle className="size-4" />
                    ) : (
                      <Clock3 className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium">{stage.label}</div>
                    <p className="break-words text-xs leading-relaxed text-muted-foreground">
                      {stage.detail}
                    </p>
                  </div>
                </li>
              ),
            )}
          </ol>
          <div className="flex flex-wrap justify-end gap-2">
            {canManage && (
              <OperationRecoveryActions
                item={item}
                onChanged={onChanged || onClose}
              />
            )}
            <Button asChild>
              <Link
                to={`/requirements/${encodeURIComponent(item.requirementId)}${item.status === 'failed' && item.actorUserId === currentUserId ? `?recoveryOf=${encodeURIComponent(item.id)}` : ''}`}
              >
                {item.status === 'failed' ? '查看最新值 / 修正' : '查看需求'}
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          </div>
        </>
      ) : null}
    </DialogContent>
  </Dialog>
);

export { OperationStatusBadge, OperationDetail };
