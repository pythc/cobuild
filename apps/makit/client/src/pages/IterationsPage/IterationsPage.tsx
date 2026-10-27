import type {
  CurrentUserSummary,
  IterationSummary,
  PersonRef,
  RequirementSummary,
} from '@shared/api.interface';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ChevronRight,
  CircleDot,
  Flag,
  GitPullRequest,
  ListChecks,
  Target,
  UserMinus,
  UsersRound,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import PersonStack from '@/components/PersonStack';
import RequirementCard from '@/components/RequirementCard';
import { IterationEfficiencyPanel } from '@/components/IterationEfficiencyPanel';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/WorkspaceStates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useBrowserWorkspace } from '@/hooks/use-browser-workspace';
import { iterationDeliveryTiming } from '@/lib/iteration-health';
import {
  dateTimestamp,
  formatDate,
  STATUS_ORDER,
} from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';

const DELIVERY_STAGES = [
  {
    label: '需求准备',
    statuses: ['新', '新建', '已拒绝'],
    progress: 5,
  },
  {
    label: '开发处理',
    statuses: ['需求已评审', '开发中', '处理中', '重新打开'],
    progress: 35,
  },
  {
    label: '测试验证',
    statuses: ['开发转测试', '测试中', '已解决'],
    progress: 65,
  },
  {
    label: '发布准备',
    statuses: ['产品体验中', '待发布', '已验证'],
    progress: 85,
  },
  {
    label: '交付完成',
    statuses: ['已发布', '已关闭'],
    progress: 100,
  },
];

function deliveryProgress(requirements: RequirementSummary[]): number {
  if (!requirements.length) return 0;
  const total = requirements.reduce((sum, requirement) => {
    const stage = DELIVERY_STAGES.find((item) =>
      item.statuses.includes(requirement.status),
    );
    return sum + (stage?.progress ?? 5);
  }, 0);
  return Math.round(total / requirements.length);
}

interface IterationMemberProgress {
  key: string;
  person: PersonRef | null;
  requirements: RequirementSummary[];
  riskyCount: number;
  blockedCount: number;
  earliestDeadline: number | null;
  isCurrentUser: boolean;
}

function earliestDeadline(requirements: RequirementSummary[]): number | null {
  const timestamps: number[] = requirements
    .map((requirement: RequirementSummary): number | null =>
      dateTimestamp(requirement.deadlineAt),
    )
    .filter(
      (timestamp: number | null): timestamp is number => timestamp != null,
    );
  return timestamps.length ? Math.min(...timestamps) : null;
}

function memberStatusCounts(
  requirements: RequirementSummary[],
): Array<{ status: string; count: number }> {
  const counts: Map<string, number> = new Map();
  requirements.forEach((requirement: RequirementSummary): void => {
    counts.set(requirement.status, (counts.get(requirement.status) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([status, count]: [string, number]) => ({ status, count }))
    .sort(
      (
        left: { status: string; count: number },
        right: { status: string; count: number },
      ): number => {
        const leftIndex: number = STATUS_ORDER.indexOf(left.status);
        const rightIndex: number = STATUS_ORDER.indexOf(right.status);
        if (leftIndex < 0 && rightIndex < 0) {
          return left.status.localeCompare(right.status, 'zh-CN');
        }
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      },
    );
}

function buildMemberProgress(
  requirements: RequirementSummary[],
  currentUser: CurrentUserSummary,
): IterationMemberProgress[] {
  const buckets: Map<
    string,
    { person: PersonRef; requirements: RequirementSummary[] }
  > = new Map();
  const unassigned: RequirementSummary[] = [];
  requirements.forEach((requirement: RequirementSummary): void => {
    if (!requirement.handlers.length) {
      unassigned.push(requirement);
      return;
    }
    requirement.handlers.forEach((person: PersonRef): void => {
      const key: string = person.id || person.name;
      const bucket = buckets.get(key) || { person, requirements: [] };
      bucket.requirements.push(requirement);
      buckets.set(key, bucket);
    });
  });
  const currentIds: Set<string> = new Set(
    [
      currentUser.employeeId,
      currentUser.miaodaUserId,
      currentUser.openId,
    ].filter(Boolean),
  );
  const rows: IterationMemberProgress[] = [...buckets.entries()].map(
    ([key, bucket]: [
      string,
      { person: PersonRef; requirements: RequirementSummary[] },
    ]): IterationMemberProgress => ({
      key,
      person: bucket.person,
      requirements: bucket.requirements,
      riskyCount: bucket.requirements.filter(
        (requirement: RequirementSummary): boolean =>
          requirement.risks.length > 0,
      ).length,
      blockedCount: bucket.requirements.filter(
        (requirement: RequirementSummary): boolean => requirement.blocked,
      ).length,
      earliestDeadline: earliestDeadline(bucket.requirements),
      isCurrentUser:
        currentIds.has(bucket.person.id) ||
        bucket.person.name === currentUser.name,
    }),
  );
  if (unassigned.length) {
    rows.push({
      key: '__unassigned__',
      person: null,
      requirements: unassigned,
      riskyCount: unassigned.filter(
        (requirement: RequirementSummary): boolean =>
          requirement.risks.length > 0,
      ).length,
      blockedCount: unassigned.filter(
        (requirement: RequirementSummary): boolean => requirement.blocked,
      ).length,
      earliestDeadline: earliestDeadline(unassigned),
      isCurrentUser: false,
    });
  }
  return rows.sort(
    (left: IterationMemberProgress, right: IterationMemberProgress): number => {
      if (left.isCurrentUser !== right.isCurrentUser) {
        return left.isCurrentUser ? -1 : 1;
      }
      if (left.person == null || right.person == null) {
        return left.person == null ? 1 : -1;
      }
      if (left.riskyCount !== right.riskyCount) {
        return right.riskyCount - left.riskyCount;
      }
      if (left.requirements.length !== right.requirements.length) {
        return right.requirements.length - left.requirements.length;
      }
      return left.person.name.localeCompare(right.person.name, 'zh-CN');
    },
  );
}

export default function IterationsPage() {
  const workspaceQuery = useBrowserWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();

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
  if (!workspace.iterations.length) {
    return (
      <EmptyState
        title="暂无迭代"
        description="迭代由管理驾驶舱统一维护，创建后会在这里供全员查看。"
      />
    );
  }

  const requestedId = searchParams.get('iteration');
  const selected =
    workspace.iterations.find((iteration) => iteration.id === requestedId) ||
    workspace.iterations[0];
  const related = workspace.requirements.filter((requirement) =>
    requirement.iterationIds.includes(selected.id),
  );
  const delivered = related.filter((item) =>
    ['已发布', '已关闭'].includes(item.status),
  );
  const unfinished = related.filter(
    (item) => !['已发布', '已关闭'].includes(item.status),
  );
  const blocked = unfinished.filter((item) => item.blocked);
  const overdue = unfinished.filter((item) =>
    item.risks.some((risk) => risk.includes('逾期')),
  );
  const inProgress = unfinished.filter(
    (item) => !['新', '新建'].includes(item.status),
  );
  const missingPersonnel = unfinished.filter(
    (item) =>
      !item.handlers.length ||
      !item.productOwners.length ||
      !item.developers.length ||
      !item.testers.length,
  );
  const progressRate = deliveryProgress(related);
  const memberProgress = buildMemberProgress(unfinished, workspace.currentUser);
  const deliveryTiming = iterationDeliveryTiming(selected, unfinished.length);
  const statusCounts = DELIVERY_STAGES.map((stage) => ({
    status: stage.label,
    count: related.filter((item) => stage.statuses.includes(item.status))
      .length,
  })).filter((item) => item.count > 0);

  const healthIssues = [
    deliveryTiming.highRisk
      ? `迭代已逾期 ${deliveryTiming.overdueDays} 天，仍有 ${unfinished.length} 项未完成`
      : '',
    blocked.length ? `${blocked.length} 项阻塞` : '',
    overdue.length ? `${overdue.length} 项逾期` : '',
    missingPersonnel.length ? `${missingPersonnel.length} 项角色不完整` : '',
    !deliveryTiming.deadlineAt ? '未设置交付截止时间' : '',
    !selected.goal?.trim() ? '未填写迭代目标' : '',
  ].filter(Boolean);

  const milestones = selected.milestones?.map((m) => ({
    label: m.name,
    value: m.dueAt,
  })) ?? [
    { label: '开始', value: selected.startAt },
    { label: '需求评审', value: selected.reviewAt },
    { label: '开发启动', value: selected.developmentAt },
    { label: '提测', value: selected.testingAt },
    { label: '发布', value: selected.releaseAt || selected.endAt },
  ];
  const attentionStats = [
    {
      label: '进行中',
      value: inProgress.length,
      icon: CircleDot,
      tone: 'bg-blue-50 text-blue-600',
      href: `/requirements?iteration=${selected.id}&risk=in-progress`,
    },
    {
      label: '阻塞',
      value: blocked.length,
      icon: AlertTriangle,
      tone: 'bg-red-50 text-red-600',
      href: `/requirements?iteration=${selected.id}&risk=blocked`,
    },
    {
      label: '逾期',
      value: overdue.length,
      icon: CalendarClock,
      tone: 'bg-orange-50 text-orange-600',
      href: `/requirements?iteration=${selected.id}&risk=overdue`,
    },
    {
      label: '角色不完整',
      value: missingPersonnel.length,
      icon: UserMinus,
      tone: 'bg-violet-50 text-violet-600',
      href: `/requirements?iteration=${selected.id}&risk=missing-personnel`,
    },
  ];

  return (
    <div className="space-y-5">
      {workspaceQuery.isError || workspace.freshness?.stale ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">当前展示最近一次成功读取的数据（{formatDate(workspace.fetchedAt, true)}）。</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">迭代</h1>
        {workspace.currentUser.miaodaUserId && (
          <Button asChild variant="outline">
            <Link to={`/iterations/${selected.id}/settings`}>迭代设置</Link>
          </Button>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden rounded-lg shadow-none">
          <div className="border-b px-4 py-3 text-sm font-semibold">
            迭代列表
          </div>
          <div className="max-h-64 overflow-y-auto p-2 xl:max-h-[760px]">
            {workspace.iterations.map((iteration: IterationSummary) => {
              const iterationRequirements = workspace.requirements.filter(
                (requirement) =>
                  requirement.iterationIds.includes(iteration.id),
              );
              const iterationProgress = deliveryProgress(iterationRequirements);
              return (
                <button
                  key={iteration.id}
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set('iteration', iteration.id);
                    setSearchParams(next, { replace: true });
                  }}
                  className={cn(
                    'mb-1 w-full rounded-lg border border-transparent px-3 py-3 text-left transition-colors hover:bg-muted',
                    selected.id === iteration.id &&
                      'border-primary/20 bg-primary/[0.06]',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-sm font-medium">
                      {iteration.name}
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {formatDate(iteration.startAt)} —{' '}
                      {formatDate(iteration.endAt)}
                    </span>
                    <span>阶段推进 {iterationProgress}%</span>
                  </div>
                  <Progress className="mt-2 h-1" value={iterationProgress} />
                </button>
              );
            })}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <details
            className="group rounded-lg border bg-card p-4"
            open={searchParams.get('view') === 'efficiency'}
            onToggle={(event) => {
              const expanded = event.currentTarget.open;
              const next = new URLSearchParams(searchParams);
              if (expanded) next.set('view', 'efficiency');
              else next.delete('view');
              if (next.toString() !== searchParams.toString())
                setSearchParams(next, { replace: true });
            }}
          >
            <summary className="cursor-pointer text-sm font-semibold text-primary">
              迭代效能
            </summary>
            {searchParams.get('view') === 'efficiency' && (
              <div className="mt-4">
                <IterationEfficiencyPanel
                  key={selected.id}
                  iterationId={selected.id}
                  userId={workspace.currentUser.miaodaUserId}
                />
              </div>
            )}
          </details>
          <Card className="overflow-hidden rounded-lg shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  <Badge variant="secondary">{selected.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDate(selected.startAt)} — {formatDate(selected.endAt)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  交付截止：{formatDate(deliveryTiming.deadlineAt)}
                  {deliveryTiming.usesEndDateFallback &&
                  deliveryTiming.deadlineAt
                    ? '（按迭代结束时间）'
                    : ''}
                </p>
              </div>
              <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:items-center">
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/requirements?iteration=${selected.id}`}>
                    <ListChecks className="size-4" />
                    需求列表
                  </Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/pull-requests?iteration=${selected.id}`}>
                    <GitPullRequest className="size-4" />
                    合并请求
                  </Link>
                </Button>
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
              {attentionStats.map(
                ({ label, value, icon: Icon, tone, href }) => (
                  <Link
                    key={label}
                    to={href}
                    className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/35 hover:bg-primary/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {label}
                      </span>
                      <span
                        className={`grid size-8 place-items-center rounded-lg ${tone}`}
                      >
                        <Icon className="size-4" />
                      </span>
                    </div>
                    <p className="mt-2 text-2xl font-semibold tabular-nums">
                      {value}
                    </p>
                    <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground group-hover:text-primary">
                      查看需求
                      <ArrowRight className="size-3" />
                    </span>
                  </Link>
                ),
              )}
            </div>

            <div className="border-t px-4 py-4 sm:px-5">
              <div
                className={cn(
                  'rounded-lg border px-4 py-3',
                  deliveryTiming.highRisk
                    ? 'border-red-200 bg-red-50/70'
                    : healthIssues.length
                      ? 'border-orange-200 bg-orange-50/70'
                      : 'border-emerald-200 bg-emerald-50/70',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      {deliveryTiming.highRisk
                        ? '迭代健康：高风险'
                        : healthIssues.length
                          ? '迭代健康：需关注'
                          : '迭代健康：正常'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      已交付 {delivered.length}/{related.length} 项；尚有{' '}
                      {unfinished.length} 项未交付。
                    </p>
                  </div>
                  <Badge variant="outline">
                    阶段推进 {progressRate}% · 交付完成{' '}
                    {related.length
                      ? Math.round((delivered.length / related.length) * 100)
                      : 0}
                    %
                  </Badge>
                </div>
                {healthIssues.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {healthIssues.map((issue) => (
                      <Badge
                        key={issue}
                        variant="outline"
                        className="bg-background/70"
                      >
                        {issue}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="border-t px-5 py-5">
              <div className="mb-4 flex items-center gap-2">
                <Flag className="size-4 text-primary" />
                <h3 className="text-sm font-semibold">关键里程碑</h3>
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="relative grid min-w-[560px] grid-cols-5 gap-2">
                  <div className="absolute left-[9%] right-[9%] top-2 h-px bg-border" />
                  {milestones.map((milestone, index) => {
                    const at = dateTimestamp(milestone.value);
                    const passed = at != null && at <= Date.now();
                    return (
                      <div
                        key={milestone.label}
                        className="relative text-center"
                      >
                        <span
                          className={cn(
                            'mx-auto block size-4 rounded-full border-2 border-background ring-1 ring-border',
                            passed ? 'bg-primary ring-primary/40' : 'bg-muted',
                            index === 0 && 'bg-emerald-500 ring-emerald-400/50',
                          )}
                        />
                        <p className="mt-2 text-xs font-medium">
                          {milestone.label}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {formatDate(milestone.value)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="p-5 pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Target className="size-4 text-primary" />
                  迭代目标
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 pt-2">
                <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {selected.goal || '未填写迭代目标'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-5 pb-3">
                <CardTitle className="text-base">阶段分布</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-5 pt-2">
                {statusCounts.length ? (
                  statusCounts.map(({ status, count }) => (
                    <div key={status} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">
                        {status}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{
                            width: `${Math.max(4, (count / related.length) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="w-7 text-right text-xs font-medium tabular-nums">
                        {count}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    迭代内暂无需求
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <UsersRound className="size-4 text-primary" />
                成员进展
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link
                  to={`/requirements?iteration=${selected.id}&group=handler`}
                >
                  查看全部
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 p-5 pt-2">
              {memberProgress.length ? (
                memberProgress.map((member: IterationMemberProgress) => {
                  const statusCountsForMember = memberStatusCounts(
                    member.requirements,
                  );
                  const href = member.person
                    ? `/requirements?iteration=${selected.id}&handler=${member.person.id}&group=status`
                    : `/requirements?iteration=${selected.id}&risk=unassigned&group=status`;
                  return (
                    <Link
                      key={member.key}
                      to={href}
                      className="grid gap-3 rounded-lg border px-4 py-3 transition-colors hover:border-primary/30 hover:bg-primary/[0.02] sm:grid-cols-[minmax(150px,0.8fr)_minmax(220px,1.5fr)_auto] sm:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {member.person ? (
                          <PersonStack
                            people={[member.person]}
                            max={1}
                            showNames
                          />
                        ) : (
                          <span className="text-sm font-medium text-muted-foreground">
                            未分配处理人
                          </span>
                        )}
                        {member.isCurrentUser ? (
                          <Badge variant="secondary">我</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {statusCountsForMember.map(
                          ({
                            status,
                            count,
                          }: {
                            status: string;
                            count: number;
                          }) => (
                            <Badge key={status} variant="outline">
                              {status} {count}
                            </Badge>
                          ),
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground sm:justify-end">
                        <span>{member.requirements.length} 项</span>
                        {member.riskyCount ? (
                          <span className="text-orange-700">
                            风险 {member.riskyCount}
                          </span>
                        ) : null}
                        {member.blockedCount ? (
                          <span className="text-red-700">
                            阻塞 {member.blockedCount}
                          </span>
                        ) : null}
                        <span>
                          最早截止 {formatDate(member.earliestDeadline)}
                        </span>
                        <ChevronRight className="size-4" />
                      </div>
                    </Link>
                  );
                })
              ) : (
                <EmptyState
                  title="当前没有待推进事项"
                  description="迭代需求进入执行阶段后，会按当前处理人汇总在这里。"
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
              <CardTitle className="text-base">迭代需求</CardTitle>
              <span className="text-xs text-muted-foreground">
                {related.length} 项
              </span>
            </CardHeader>
            <CardContent className="grid gap-3 p-5 pt-2 md:grid-cols-2 xl:grid-cols-3">
              {related.length ? (
                related
                  .slice(0, 12)
                  .map((requirement: RequirementSummary) => (
                    <RequirementCard
                      key={requirement.id}
                      requirement={requirement}
                      compact
                    />
                  ))
              ) : (
                <div className="md:col-span-2 xl:col-span-3">
                  <EmptyState
                    title="迭代内暂无需求"
                    description="在需求池创建或编辑需求时选择该迭代。"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
