import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { workspaceEfficiencyApi } from '@/api';
import type { RequirementBatch } from '@shared/requirement-batch';
import type {
  BulkRequirementPatch,
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorMessage } from '@/lib/requirement-utils';

type BulkField = 'status' | 'priority' | 'project' | 'iterationIds';

const CLEAR_ITERATION: string = '__clear_iteration__';

export default function BulkEditRequirementsDialog({
  open,
  onOpenChange,
  workspace,
  requirements,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Pick<WorkspaceResponse, 'iterations' | 'options'>;
  requirements: RequirementSummary[];
  onCompleted: () => void;
}) {
  const [field, setField] = useState<BulkField>('status');
  const [target, setTarget] = useState<string>('');
  const [preview, setPreview] = useState<RequirementBatch | null>(null);
  const queryClient = useQueryClient();
  const result = useQuery({
    queryKey: ['requirement-batch', preview?.id],
    queryFn: () => workspaceEfficiencyApi.getBatch(preview!.id),
    enabled: open && !!preview && preview.state !== 'preview',
    refetchInterval: (query) =>
      query.state.data?.items.some((item) =>
        ['queued', 'running', 'allowed'].includes(item.status),
      )
        ? 2000
        : false,
  });
  const batch = result.data || preview;
  const refreshed = useRef('');
  useEffect(() => {
    if (!batch || batch.state === 'preview') return;
    const confirmed = batch.items
      .filter((item) => item.status === 'succeeded')
      .map((item) => item.recordId)
      .sort()
      .join(',');
    const fingerprint = `${batch.id}:${confirmed}`;
    if (!confirmed || refreshed.current === fingerprint) return;
    refreshed.current = fingerprint;
    void queryClient.invalidateQueries({
      predicate: (query) =>
        [
          'workspace',
          'workspace-summary',
          'requirements',
          'requirement',
          'requirement-detail',
        ].includes(String(query.queryKey[0])),
    });
  }, [batch, queryClient]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (preview?.state === 'preview') {
        const saved = await workspaceEfficiencyApi.executeBatch(preview.id);
        setPreview(saved);
        queryClient.setQueryData(['requirement-batch', saved.id], saved);
        toast.success('已修改');
        onCompleted();
        return;
      }
      const patch: BulkRequirementPatch =
        field === 'iterationIds'
          ? { iterationIds: target === CLEAR_ITERATION ? [] : [target] }
          : ({ [field]: target } as BulkRequirementPatch);
      setPreview(
        await workspaceEfficiencyApi.previewBatch({
          clientMutationId: crypto.randomUUID(),
          items: requirements.map((item) => ({
            recordId: item.id,
            expectedUpdatedAt: item.updatedAt,
          })),
          patch,
        }),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const retry = useMutation({
    mutationFn: async () => {
      if (!batch) return;
      setPreview(
        await workspaceEfficiencyApi.retryBatchPreview(
          batch.id,
          crypto.randomUUID(),
        ),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const statusOptions = useMemo(
    (): string[] =>
      workspace.options.statuses.filter((status: string): boolean =>
        requirements.every(
          (item: RequirementSummary): boolean =>
            item.status === status || item.allowedStatuses.includes(status),
        ),
      ),
    [requirements, workspace.options.statuses],
  );

  const options = useMemo((): Array<{ value: string; label: string }> => {
    if (field === 'status') {
      return statusOptions.map((value: string) => ({ value, label: value }));
    }
    if (field === 'priority') {
      return workspace.options.priorities.map((value: string) => ({
        value,
        label: value,
      }));
    }
    if (field === 'project') {
      return workspace.options.projects.map((value: string) => ({
        value,
        label: value,
      }));
    }
    return [
      { value: CLEAR_ITERATION, label: '清空所属迭代' },
      ...workspace.iterations.map((iteration) => ({
        value: iteration.id,
        label: iteration.name,
      })),
    ];
  }, [field, statusOptions, workspace]);

  useEffect(() => {
    if (!open) return;
    setTarget('');
    setPreview(null);
  }, [field, open]);

  const submit = async (): Promise<void> => {
    if (!target) {
      toast.error('请选择目标值');
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            批量修改 {batch?.items.length ?? requirements.length} 项需求
          </DialogTitle>
          <DialogDescription className="sr-only">
            先预览影响，再确认符合条件的需求；逐项展示实际结果。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>修改字段</Label>
            <Select
              value={field}
              disabled={mutation.isPending || !!preview}
              onValueChange={(value) => setField(value as BulkField)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="status">状态</SelectItem>
                <SelectItem value="priority">优先级</SelectItem>
                <SelectItem value="project">项目</SelectItem>
                <SelectItem value="iterationIds">所属迭代</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>目标值</Label>
            <Select
              value={target}
              onValueChange={setTarget}
              disabled={mutation.isPending || !!preview}
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field === 'status' && !options.length ? (
              <p className="text-xs text-destructive">
                所选需求没有共同可流转的状态，请缩小选择范围。
              </p>
            ) : null}
          </div>
        </div>
        {batch && (
          <div className="rounded-lg border overflow-hidden">
            <div className="border-b bg-muted/30 px-4 py-3 text-sm font-medium">
              {batch.state === 'preview'
                ? `影响预览 · ${batch.items.filter((item) => item.status === 'allowed').length} 项可修改`
                : '逐项结果'}
            </div>
            <div className="max-h-72 overflow-y-auto divide-y">
              {batch.items.map((item) => (
                <div
                  key={item.recordId}
                  className="grid grid-cols-[1fr_auto] gap-2 px-4 py-3 text-sm"
                >
                  <Link
                    className="min-w-0 truncate hover:text-primary"
                    to={`/requirements/${encodeURIComponent(item.recordId)}`}
                  >
                    {item.code} {item.title}
                  </Link>
                  <span
                    className={
                      ['failed', 'blocked'].includes(item.status)
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {
                      {
                        allowed: '可修改',
                        blocked: '不满足条件',
                        skipped: '无变化',
                        queued: '待处理',
                        running: '处理中',
                        succeeded: '已修改',
                        failed: '未完成',
                        unknown: '待核实',
                      }[item.status]
                    }
                  </span>
                  {item.reason && (
                    <p className="col-span-2 text-xs text-muted-foreground break-words">
                      {item.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {result.isError && (
              <p className="p-3 text-sm text-destructive">
                暂时无法刷新结果，已确认的操作不会重复执行。
                <Button variant="ghost" onClick={() => void result.refetch()}>
                  重试查询
                </Button>
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {batch?.state && batch.state !== 'preview' ? '完成' : '取消'}
          </Button>
          {batch?.state === 'preview' && (
            <Button
              variant="outline"
              onClick={() => setPreview(null)}
              disabled={mutation.isPending}
            >
              返回调整
            </Button>
          )}
          {batch &&
            batch.state !== 'preview' &&
            batch.items.some((item) => item.status === 'failed') && (
              <Button
                variant="outline"
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
              >
                仅预览失败项重试
              </Button>
            )}
          {(!batch || batch.state === 'preview') && (
            <Button
              onClick={() => void submit()}
              disabled={
                mutation.isPending ||
                !target ||
                (batch?.state === 'preview' &&
                  !batch.items.some((item) => item.status === 'allowed'))
              }
            >
              {mutation.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : null}
              {batch?.state === 'preview' ? '确认修改可执行项' : '预览影响'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
