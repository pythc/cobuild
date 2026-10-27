import { useBrowserWorkspace, useRefreshBrowserWorkspace } from '@/hooks/use-browser-workspace';
import { requirementComplete, requirementInProgress } from '@shared/ticket-workflow';
import type {
  IterationSummary,
  RequirementSummary,
} from '@shared/api.interface';
import { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CircleDot,
  Clock3,
  RefreshCw,
  UserRoundCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import PersonStack from '@/components/PersonStack';
import RequirementCard from '@/components/RequirementCard';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/WorkspaceStates';
import { formatDate } from '@/lib/requirement-utils';

const STAT_CARDS = [
  {
    key: 'mine',
    label: '我处理的',
    href: '/requirements?mine=1',
    icon: UserRoundCheck,
    tone: 'text-primary bg-primary/10',
  },
  {
    key: 'inProgress',
    label: '进行中',
    href: '/requirements?mine=1&risk=in-progress',
    icon: CircleDot,
    tone: 'text-blue-600 bg-blue-50',
  },
  {
    key: 'blocked',
    label: '阻塞',
    href: '/requirements?mine=1&risk=blocked',
    icon: AlertTriangle,
    tone: 'text-red-600 bg-red-50',
  },
  {
    key: 'overdue',
    label: '逾期',
    href: '/requirements?mine=1&risk=overdue',
    icon: Clock3,
    tone: 'text-orange-600 bg-orange-50',
  },
] as const;

export default function WorkbenchPage() {
  const workspaceQuery = useBrowserWorkspace();
  const refreshMutation = useRefreshBrowserWorkspace();
  const [actionGroup, setActionGroup] = useState<'pending' | 'blocked' | 'due'>('pending');

  if (workspaceQuery.isLoading) return <LoadingState />;
  if (!workspaceQuery.data) {
    return (
      <ErrorState
        message={workspaceQuery.error?.message || '未知错误'}
        onRetry={() => void workspaceQuery.refetch()}
      />
    );
  }

  const workspace = workspaceQuery.data;
  const mine: RequirementSummary[] = workspace.requirements.filter(
    (item: RequirementSummary) => item.isMine && !requirementComplete(item),
  );
  const deadline = (item: RequirementSummary): number => item.deadlineAt ? Number(item.deadlineAt) || Date.parse(String(item.deadlineAt)) : Number.POSITIVE_INFINITY;
  const due = mine.filter((item) => deadline(item) >= Date.now() && deadline(item) <= Date.now() + 7 * 86_400_000).sort((left, right) => deadline(left) - deadline(right));
  const blocked = mine.filter((item) => item.blocked);
  const actions = actionGroup === 'blocked' ? blocked : actionGroup === 'due' ? due : mine;
  const risks: RequirementSummary[] = mine.filter(
    (item: RequirementSummary) => item.risks.length > 0,
  );
  const recent: RequirementSummary[] = mine.slice(0, 5);
  const workStats = {
    mine: mine.length,
    inProgress: mine.filter(
      (item: RequirementSummary): boolean =>
        requirementInProgress(item),
    ).length,
    blocked: mine.filter((item: RequirementSummary): boolean => item.blocked)
      .length,
    overdue: mine.filter((item: RequirementSummary): boolean =>
      item.risks.some((risk: string): boolean => risk.includes('逾期')),
    ).length,
  };
  const activeIterations = workspace.iterations
    .filter((item: IterationSummary) => item.status !== '已完成')
    .slice(0, 4);

  return (
    <div className="space-y-7">
      {workspaceQuery.isError || workspace.freshness?.stale ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">当前展示最近一次成功读取的数据（{formatDate(workspace.fetchedAt, true)}）。</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">我的工作</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refreshMutation.mutateAsync()}
          disabled={refreshMutation.isPending}
        >
          <RefreshCw
            className={`size-4 ${refreshMutation.isPending ? 'animate-spin' : ''}`}
          />
          刷新数据
        </Button>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map(({ key, label, href, icon: Icon, tone }) => (
          <Link
            key={key}
            to={href}
            className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Card className="h-full rounded-xl border-border/75 bg-gradient-to-br from-card via-card to-primary/[0.025] shadow-xs transition-[transform,box-shadow,border-color] duration-300 ease-out group-hover:-translate-y-1 group-hover:border-primary/30 group-hover:shadow-md">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {workStats[key]}
                  </p>
                </div>
                <span
                  className={`grid size-9 place-items-center rounded-xl transition-transform duration-300 ease-out group-hover:-rotate-3 group-hover:scale-110 ${tone}`}
                >
                  <Icon className="size-4.5" />
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)]">
        <Card className="rounded-2xl border-border/75 shadow-sm">
          <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
            <CardTitle className="text-base">待我推进</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/requirements?mine=1">
                查看全部
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-2 lg:grid-cols-2">
            <div className="flex flex-wrap gap-1 border-b pb-2 lg:col-span-2" role="group" aria-label="我的行动分类">
              {([{ key: 'pending', title: '待我推进', count: mine.length }, { key: 'blocked', title: '待我解除阻塞', count: blocked.length }, { key: 'due', title: '7 天内到期', count: due.length }] as const).map((group) => <Button key={group.key} size="sm" variant={actionGroup === group.key ? 'secondary' : 'ghost'} onClick={() => setActionGroup(group.key)} className={actionGroup === group.key ? 'text-primary' : 'text-muted-foreground'}>{group.title}<span className="text-xs tabular-nums">{group.count}</span></Button>)}
            </div>
            {actions.length ? (
              actions
                .slice(0, actionGroup === 'pending' ? 6 : actions.length)
                .map((item) => (
                  <RequirementCard key={item.id} requirement={item} compact />
                ))
            ) : (
              <div className="lg:col-span-2">
                <EmptyState
                  title={actionGroup === 'blocked' ? '没有等待你解除的阻塞' : actionGroup === 'due' ? '没有 7 天内到期的需求' : '当前没有待你推进的需求'}
                  description="你成为当前处理人后，需求会自动出现在这里。"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/75 shadow-sm">
          <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
            <CardTitle className="text-base">风险提醒</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/requirements?mine=1&sortBy=risk&sortOrder=desc">
                查看全部
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 p-5 pt-2">
            {risks.length ? (
              risks.slice(0, 7).map((item) => (
                <Link
                  key={item.id}
                  to={`/requirements/${item.id}`}
                  state={{ requirementReturnTo: '/' }}
                  className="flex items-start gap-3 rounded-xl border border-border/75 px-3 py-2.5 transition-[transform,background-color,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-primary/20 hover:bg-primary/[0.025] hover:shadow-xs"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-sm font-medium">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {item.risks.join(' · ')}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <PersonStack people={item.handlers} max={1} showNames />
                      <span className="text-[11px] text-muted-foreground">
                        截止 {formatDate(item.deadlineAt)}
                      </span>
                    </span>
                  </span>
                </Link>
              ))
            ) : (
              <EmptyState
                title="没有识别到风险"
                description="当前需求均未触发阻塞或逾期规则。"
              />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
        <Card className="rounded-2xl border-border/75 shadow-sm">
          <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
            <CardTitle className="text-base">进行中的迭代</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/iterations">迭代视图</Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-2 sm:grid-cols-2">
            {activeIterations.map((iteration) => (
              <Link
                key={iteration.id}
                to={`/iterations?iteration=${iteration.id}`}
                className="rounded-xl border border-border/75 p-4 transition-[transform,box-shadow,border-color,background-color] duration-250 ease-out hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/[0.025] hover:shadow-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {iteration.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(iteration.startAt)} —{' '}
                      {formatDate(iteration.endAt)}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-primary">
                    {iteration.completionRate}%
                  </span>
                </div>
                <Progress
                  className="mt-3 h-1.5"
                  value={iteration.completionRate}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  已发布 {iteration.completedCount} /{' '}
                  {iteration.requirementCount}
                </p>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/75 shadow-sm">
          <CardHeader className="p-5 pb-3">
            <CardTitle className="text-base">最近更新</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-5 pt-2">
            {recent.map((item) => (
              <Link
                key={item.id}
                to={`/requirements/${item.id}`}
                state={{ requirementReturnTo: '/' }}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-[transform,background-color] duration-200 hover:translate-x-0.5 hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {item.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {item.updatedByName || '成员'} ·{' '}
                    {formatDate(item.updatedAt, true)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.status}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
