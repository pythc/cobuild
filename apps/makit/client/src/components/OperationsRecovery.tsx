import { useEffect, useMemo } from 'react';
import type { FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RequirementUpdateJobSummary } from '@shared/api.interface';
import { operationsApi } from '@/api';
import {
  OPERATIONS_QUERY_KEY,
  useOperationsAccess,
} from '@/hooks/use-operations';
import { invalidateRecoveredRequirement } from '@/hooks/use-workspace';
import { OperationRecoveryTracker } from '@/lib/operation-recovery';

/** Mounted outside route transitions so refresh recovery never replays a mutation. */
const OperationsRecovery: FC = () => {
  const access = useOperationsAccess();
  const queryClient = useQueryClient();
  const tracker: OperationRecoveryTracker = useMemo(
    () => new OperationRecoveryTracker(),
    [access.data?.userId],
  );
  const recovery = useQuery({
    queryKey: [...OPERATIONS_QUERY_KEY, 'recovery', access.data?.userId],
    enabled: access.isSuccess,
    retry: false,
    queryFn: async ({ signal }) => {
      const snapshot = await operationsApi.getProgress(
        { scope: 'mine', page: 1, pageSize: 100 },
        signal,
      );
      const items: RequirementUpdateJobSummary[] = [...snapshot.items];
      const unavailableIds: string[] = [];
      const warnings: string[] = [];
      // Old pending records can be outside the latest page; resume those too.
      for (const status of ['queued', 'running'] as const) {
        const visible: number = items.filter(
          (item: RequirementUpdateJobSummary) => item.status === status,
        ).length;
        if (snapshot.stats[status] > visible) {
          const pending = await operationsApi.getProgress(
            { scope: 'mine', status, page: 1, pageSize: 100 },
            signal,
          );
          items.push(...pending.items);
        }
      }
      const visibleIds: Set<string> = new Set(
        items.map((item: RequirementUpdateJobSummary) => item.id),
      );
      // An observed operation may finish and leave the page before the next refresh.
      for (const id of tracker.pendingIds.filter(
        (id: string) => !visibleIds.has(id),
      )) {
        if (signal.aborted) break;
        try {
          const found = await operationsApi.getProgress(
            { scope: 'mine', operationId: id, pageSize: 1 },
            signal,
          );
          if (found.items.length) items.push(...found.items);
          else unavailableIds.push(id);
        } catch (error: unknown) {
          if (signal.aborted) throw error;
          warnings.push(
            error instanceof Error ? error.message : '部分操作暂时无法确认',
          );
        }
      }
      return { snapshot, items, unavailableIds, warnings };
    },
    refetchInterval: (query): number => {
      const stats = query.state.data?.snapshot.stats;
      return stats && stats.queued + stats.running > 0 ? 3_000 : 60_000;
    },
    refetchIntervalInBackground: false,
  });

  useEffect((): void => {
    if (!access.isSuccess || recovery.isError || !recovery.data) return;
    const completed: string[] = tracker.observe(recovery.data.items);
    tracker.forget(recovery.data.unavailableIds);
    completed.forEach((id: string): void => {
      void invalidateRecoveredRequirement(queryClient, id);
    });
  }, [access.isSuccess, queryClient, recovery.data, recovery.isError, tracker]);

  if (!access.isSuccess || recovery.isError || !recovery.data) return null;
  const pending: number =
    recovery.data.snapshot.stats.running + recovery.data.snapshot.stats.queued;
  const warning: boolean = recovery.data.warnings.length > 0;
  if (!pending && !warning) return null;
  const pendingRequirementId = recovery.data.items.find((item) =>
    ['queued', 'running'].includes(item.status),
  )?.requirementId;
  return (
    <Link
      to={
        access.data?.canViewAll
          ? '/operations'
          : pending && pendingRequirementId
            ? `/requirements/${pendingRequirementId}`
            : '/requirements'
      }
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={
        warning
          ? '部分操作暂时无法确认，查看最新需求'
          : `${pending} 条操作处理中`
      }
      title={warning ? recovery.data.warnings[0] : undefined}
    >
      {warning ? (
        <AlertCircle className="size-4 text-destructive" />
      ) : (
        <LoaderCircle className="size-4 animate-spin text-primary motion-reduce:animate-none" />
      )}
      <span className="hidden 2xl:inline">
        {warning ? '查看结果' : '处理中'}
      </span>
      {pending ? <span className="tabular-nums">{pending}</span> : null}
    </Link>
  );
};

export default OperationsRecovery;
