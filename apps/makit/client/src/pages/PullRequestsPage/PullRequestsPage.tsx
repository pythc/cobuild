import { useEffect, useMemo, useState } from 'react';
import type {
  GitHubActorSummary,
  GitHubReviewerCandidate,
  PullRequestCheckSummary,
  PullRequestCommentSummary,
  PullRequestReviewerNotificationSummary,
  PullRequestReviewSummary,
  PullRequestReviewThreadSummary,
  PullRequestSummary,
} from '@shared/api.interface';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  ChevronDown,
  CircleDot,
  Clock3,
  ExternalLink,
  FileCode2,
  GitCommit,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
  XCircle,
} from 'lucide-react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/WorkspaceStates';
import { UserSelect } from '@/components/business-ui/user-select';
import type { User } from '@/components/business-ui/types/user';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Streamdown } from '@/components/ui/streamdown';
import {
  usePullRequestDetail,
  usePullRequests,
  useRefreshPullRequests,
  useUpdatePullRequestReviewers,
} from '@/hooks/use-pull-requests';
import { cn } from '@/lib/utils';

const ALL: string = '__all__';

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed: Date = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function stateLabel(state: PullRequestSummary['state']): string {
  if (state === 'OPEN') return '进行中';
  if (state === 'MERGED') return '已合并';
  return '已关闭';
}

function reviewLabel(
  value: string,
  state?: PullRequestSummary['state'],
): string {
  if (value === 'APPROVED') return '已批准';
  if (value === 'CHANGES_REQUESTED') return '需修改';
  if (value === 'REVIEW_REQUIRED') return '待评审';
  if (value === 'COMMENTED') return '已评论';
  if (value === 'DISMISSED') return '已撤销';
  if (value === 'PENDING') return '待提交';
  if (state === 'MERGED') return '历史结论未采集';
  if (state === 'CLOSED') return '关闭前结论未采集';
  return '未设置';
}

function checksLabel(
  value: string,
  state?: PullRequestSummary['state'],
): string {
  if (value === 'SUCCESS') return '通过';
  if (value === 'FAILURE' || value === 'ERROR') return '失败';
  if (value === 'PENDING' || value === 'EXPECTED') return '运行中';
  if (state === 'MERGED') return '合并时结果未采集';
  if (state === 'CLOSED') return '关闭时结果未采集';
  return '未采集';
}

function mergeableLabel(
  value: string,
  state?: PullRequestSummary['state'],
): string {
  if (state === 'MERGED') return '已完成合并';
  if (state === 'CLOSED') return '已关闭，不再判定';
  if (value === 'MERGEABLE') return '可合并';
  if (value === 'CONFLICTING') return '存在冲突';
  return '待 GitHub 判定';
}

function isAutomatedActor(login: string): boolean {
  return /\[bot\]$|codex|copilot|github-actions/i.test(login);
}

function notificationStatusLabel(
  status: PullRequestReviewerNotificationSummary['status'],
): string {
  if (status === 'delivered') return '已送达';
  if (status === 'failed') return '发送失败';
  if (status === 'retrying') return '等待重试';
  if (status === 'suppressed') return '已抑制';
  return '等待发送';
}

function stateBadgeClass(state: PullRequestSummary['state']): string {
  if (state === 'OPEN')
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (state === 'MERGED')
    return 'border-violet-200 bg-violet-50 text-violet-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function checksBadgeClass(value: string): string {
  if (value === 'SUCCESS')
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (value === 'FAILURE' || value === 'ERROR') {
    return 'border-red-200 bg-red-50 text-red-700';
  }
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

function Actor({ login, avatarUrl }: { login: string; avatarUrl: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-6">
        <AvatarImage src={avatarUrl} alt="" />
        <AvatarFallback className="text-[10px]">
          {login.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate text-sm">{login}</span>
    </div>
  );
}

function ReviewerGroup({ reviewers }: { reviewers: GitHubActorSummary[] }) {
  if (!reviewers.length) {
    return <span className="text-xs text-muted-foreground">未设置</span>;
  }
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      title={reviewers
        .map((reviewer: GitHubActorSummary) => reviewer.login)
        .join('、')}
    >
      <div className="flex -space-x-2">
        {reviewers.slice(0, 3).map((reviewer: GitHubActorSummary) => (
          <Avatar
            key={reviewer.login}
            className="size-6 border-2 border-background"
          >
            <AvatarImage src={reviewer.avatarUrl} alt="" />
            <AvatarFallback className="text-[9px]">
              {reviewer.login.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        ))}
      </div>
      <span className="truncate text-xs">
        {reviewers[0]?.login}
        {reviewers.length > 1 ? ` 等 ${reviewers.length} 人` : ''}
      </span>
    </div>
  );
}

interface GitHubReviewerPickerProps {
  candidates: GitHubActorSummary[];
  value: string[];
  onChange: (value: string[]) => void;
}

function GitHubReviewerPicker({
  candidates,
  value,
  onChange,
}: GitHubReviewerPickerProps) {
  const selected: Set<string> = new Set(
    value.map((login: string): string => login.toLowerCase()),
  );
  const toggle = (login: string): void => {
    const normalized: string = login.toLowerCase();
    if (selected.has(normalized)) {
      onChange(
        value.filter(
          (item: string): boolean => item.toLowerCase() !== normalized,
        ),
      );
      return;
    }
    onChange([...value, login]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between font-normal"
        >
          <span>
            {value.length ? `已选择 ${value.length} 位` : '选择 GitHub 账号'}
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        <Command>
          <CommandInput placeholder="搜索 GitHub 账号" />
          <CommandList>
            <CommandEmpty>没有可选账号</CommandEmpty>
            <CommandGroup>
              {candidates.map((candidate: GitHubActorSummary) => {
                const checked: boolean = selected.has(
                  candidate.login.toLowerCase(),
                );
                return (
                  <CommandItem
                    key={candidate.login}
                    value={candidate.login}
                    onSelect={() => toggle(candidate.login)}
                  >
                    <Avatar className="size-6">
                      <AvatarImage src={candidate.avatarUrl} alt="" />
                      <AvatarFallback className="text-[9px]">
                        {candidate.login.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.login}
                    </span>
                    <Check
                      className={cn(
                        'size-4',
                        checked ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PullRequestList() {
  const query = usePullRequests();
  const refresh = useRefreshPullRequests();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const search: string = searchParams.get('q') || '';
  const state: string = searchParams.get('state') || ALL;
  const iteration: string = searchParams.get('iteration') || ALL;
  const focus: string = searchParams.get('focus') || ALL;

  const setParam = (key: string, value: string): void => {
    const next: URLSearchParams = new URLSearchParams(searchParams);
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const filtered = useMemo((): PullRequestSummary[] => {
    const items: PullRequestSummary[] = query.data?.pullRequests || [];
    const keyword: string = search.trim().toLowerCase();
    return items.filter((pullRequest: PullRequestSummary): boolean => {
      if (state !== ALL && pullRequest.state !== state) return false;
      if (
        iteration !== ALL &&
        !pullRequest.linkedIterationIds.includes(iteration)
      ) {
        return false;
      }
      if (
        focus === 'waiting' &&
        !(
          pullRequest.state === 'OPEN' &&
          (pullRequest.reviewDecision === 'REVIEW_REQUIRED' ||
            pullRequest.reviewCount === 0)
        )
      ) {
        return false;
      }
      if (
        focus === 'changes' &&
        pullRequest.reviewDecision !== 'CHANGES_REQUESTED'
      ) {
        return false;
      }
      if (
        focus === 'checks' &&
        !['ERROR', 'FAILURE'].includes(pullRequest.checksStatus)
      ) {
        return false;
      }
      if (!keyword) return true;
      return [
        String(pullRequest.number),
        pullRequest.title,
        pullRequest.headRef,
        pullRequest.author.login,
        ...pullRequest.linkedRequirements.flatMap((requirement) => [
          requirement.code,
          requirement.title,
        ]),
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [focus, iteration, query.data?.pullRequests, search, state]);

  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        message={query.error?.message || '获取合并请求失败'}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const workspace = query.data;
  const stats = [
    {
      label: '进行中',
      value: workspace.stats.open,
      icon: GitPullRequest,
      filter: { key: 'state', value: 'OPEN' },
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: '待评审',
      value: workspace.stats.waitingReview,
      icon: Clock3,
      filter: { key: 'focus', value: 'waiting' },
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: '需修改',
      value: workspace.stats.changesRequested,
      icon: MessageSquare,
      filter: { key: 'focus', value: 'changes' },
      tone: 'bg-amber-50 text-amber-700',
    },
    {
      label: '检查失败',
      value: workspace.stats.checksFailed,
      icon: XCircle,
      filter: { key: 'focus', value: 'checks' },
      tone: 'bg-red-50 text-red-600',
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">合并请求</h1>
            <Badge variant="outline">{workspace.repository}</Badge>
            {workspace.stale ? (
              <Badge variant="secondary">数据待刷新</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              GitHub 同步于 {formatDateTime(workspace.syncedAt)}
            </span>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCw
            className={cn('size-4', refresh.isPending && 'animate-spin')}
          />
          刷新
        </Button>
      </div>

      {workspace.syncWarning ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          当前显示最近一次成功数据：{workspace.syncWarning}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, filter, tone }) => (
          <button
            key={label}
            type="button"
            className="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.02]"
            onClick={() => setParam(filter.key, filter.value)}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span
                className={cn(
                  'grid size-8 place-items-center rounded-lg',
                  tone,
                )}
              >
                <Icon className="size-4" />
              </span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </button>
        ))}
      </div>

      <Card className="overflow-hidden rounded-lg shadow-none">
        <div className="grid gap-3 border-b p-3 lg:grid-cols-[minmax(280px,1fr)_180px_240px_180px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setParam('q', event.target.value)}
              placeholder="搜索 PR、分支、作者或关联需求"
              className="pl-9"
            />
          </div>
          <Select
            value={state}
            onValueChange={(value) => setParam('state', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部状态</SelectItem>
              <SelectItem value="OPEN">进行中</SelectItem>
              <SelectItem value="MERGED">已合并</SelectItem>
              <SelectItem value="CLOSED">已关闭</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={iteration}
            onValueChange={(value) => setParam('iteration', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部迭代" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部迭代</SelectItem>
              {workspace.iterations.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={focus}
            onValueChange={(value) => setParam('focus', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部评审" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部评审</SelectItem>
              <SelectItem value="waiting">待评审</SelectItem>
              <SelectItem value="changes">需修改</SelectItem>
              <SelectItem value="checks">检查失败</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {filtered.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[1120px] table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/45">
                  <TableHead className="w-[390px] border-r">合并请求</TableHead>
                  <TableHead className="w-[260px] border-r">
                    关联需求 / 迭代
                  </TableHead>
                  <TableHead className="w-[150px] border-r">作者</TableHead>
                  <TableHead className="w-[190px] border-r">
                    GitHub 评审人
                  </TableHead>
                  <TableHead className="w-[120px] border-r">评审结论</TableHead>
                  <TableHead className="w-[110px] border-r">检查</TableHead>
                  <TableHead className="w-[130px]">更新</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((pullRequest: PullRequestSummary) => (
                  <TableRow
                    key={pullRequest.number}
                    className="cursor-pointer"
                    onClick={() =>
                      navigate(`/pull-requests/${pullRequest.number}`)
                    }
                  >
                    <TableCell className="border-r align-top">
                      <div className="flex items-start gap-3">
                        <GitPullRequest
                          className={cn(
                            'mt-1 size-4 shrink-0',
                            pullRequest.state === 'OPEN'
                              ? 'text-emerald-600'
                              : pullRequest.state === 'MERGED'
                                ? 'text-violet-600'
                                : 'text-muted-foreground',
                          )}
                        />
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-medium">
                            {pullRequest.title}
                          </p>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>#{pullRequest.number}</span>
                            <Badge
                              variant="outline"
                              className={cn(
                                'h-5 px-1.5 text-[10px]',
                                stateBadgeClass(pullRequest.state),
                              )}
                            >
                              {stateLabel(pullRequest.state)}
                            </Badge>
                            {pullRequest.draft ? <span>草稿</span> : null}
                          </div>
                          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {pullRequest.headRef} → {pullRequest.baseRef}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="border-r align-top">
                      {pullRequest.linkedRequirements.length ? (
                        <div className="space-y-1.5">
                          {pullRequest.linkedRequirements
                            .slice(0, 2)
                            .map((requirement) => (
                              <div key={requirement.id} className="min-w-0">
                                <p className="truncate text-xs font-medium text-primary">
                                  {requirement.code} · {requirement.title}
                                </p>
                              </div>
                            ))}
                          <p className="truncate text-[11px] text-muted-foreground">
                            {pullRequest.linkedIterationNames.join('、') ||
                              '未关联迭代'}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          未关联需求
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="border-r align-top">
                      <Actor {...pullRequest.author} />
                    </TableCell>
                    <TableCell className="border-r align-top">
                      <ReviewerGroup
                        reviewers={pullRequest.requestedReviewers}
                      />
                    </TableCell>
                    <TableCell className="border-r align-top">
                      <Badge variant="outline">
                        {reviewLabel(
                          pullRequest.reviewDecision,
                          pullRequest.state,
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="border-r align-top">
                      <Badge
                        variant="outline"
                        className={checksBadgeClass(pullRequest.checksStatus)}
                      >
                        {checksLabel(
                          pullRequest.checksStatus,
                          pullRequest.state,
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">
                      {formatDateTime(pullRequest.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-8">
            <EmptyState
              title="没有匹配的合并请求"
              description="调整筛选条件后重试。"
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewBlock({ review }: { review: PullRequestReviewSummary }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Actor {...review.author} />
        <div className="flex items-center gap-2">
          <Badge variant="outline">{reviewLabel(review.state)}</Badge>
          <span className="text-xs text-muted-foreground">
            {formatDateTime(review.submittedAt)}
          </span>
        </div>
      </div>
      {review.body ? (
        <Streamdown className="mt-3 break-words text-sm leading-6">
          {review.body}
        </Streamdown>
      ) : null}
    </div>
  );
}

function CommentBlock({ comment }: { comment: PullRequestCommentSummary }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Actor {...comment.author} />
        <span className="text-xs text-muted-foreground">
          {formatDateTime(comment.updatedAt || comment.createdAt)}
        </span>
      </div>
      {comment.path ? (
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {comment.path}
          {comment.line ? `:${comment.line}` : ''}
        </p>
      ) : null}
      {comment.body ? (
        <Streamdown className="mt-2 break-words text-sm leading-6">
          {comment.body}
        </Streamdown>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">无文字内容</p>
      )}
    </div>
  );
}

function ReviewThreadBlock({
  thread,
}: {
  thread: PullRequestReviewThreadSummary;
}) {
  const first: PullRequestCommentSummary | undefined = thread.comments[0];
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        thread.resolved ? 'bg-muted/20' : 'border-amber-200 bg-amber-50/40',
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              thread.resolved
                ? 'border-emerald-200 text-emerald-700'
                : 'border-amber-300 text-amber-800',
            )}
          >
            {thread.resolved ? '已解决' : '待处理'}
          </Badge>
          {thread.outdated ? <Badge variant="secondary">旧代码</Badge> : null}
          {first?.path ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {first.path}
              {first.line ? `:${first.line}` : ''}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {thread.comments.length} 条对话
        </span>
      </div>
      <div className="space-y-2">
        {thread.comments.map((comment: PullRequestCommentSummary) => (
          <CommentBlock key={comment.id} comment={comment} />
        ))}
      </div>
    </div>
  );
}

function NotificationBlock({
  notification,
}: {
  notification: PullRequestReviewerNotificationSummary;
}) {
  const failed: boolean = notification.status === 'failed';
  const delivered: boolean = notification.status === 'delivered';
  const suppressed: boolean = notification.status === 'suppressed';
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {notification.reviewerName || notification.githubLogin}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            GitHub：{notification.githubLogin || '未设置'}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            delivered && 'border-emerald-200 text-emerald-700',
            failed && 'border-red-200 text-red-700',
            suppressed && 'border-slate-200 text-slate-600',
            !delivered &&
              !failed &&
              !suppressed &&
              'border-amber-200 text-amber-700',
          )}
        >
          {notificationStatusLabel(notification.status)}
        </Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {delivered
          ? `送达于 ${formatDateTime(notification.deliveredAt)}`
          : suppressed
            ? '未进入发送队列'
            : `已尝试 ${notification.attempts} 次`}
      </p>
      {notification.errorMessage ? (
        <p className="mt-2 break-words text-xs text-red-700">
          {notification.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function CheckBlock({ check }: { check: PullRequestCheckSummary }) {
  const passed: boolean =
    check.conclusion === 'SUCCESS' || check.status === 'SUCCESS';
  const failed: boolean = ['FAILURE', 'ERROR', 'CANCELLED'].includes(
    check.conclusion || check.status,
  );
  const Icon = passed ? CheckCircle2 : failed ? XCircle : Clock3;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            passed
              ? 'text-emerald-600'
              : failed
                ? 'text-red-600'
                : 'text-amber-600',
          )}
        />
        <span className="truncate text-sm">{check.name}</span>
      </div>
      {check.url ? (
        <a
          href={check.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline"
        >
          详情
        </a>
      ) : null}
    </div>
  );
}

function PullRequestDetail({ pullNumber }: { pullNumber: number }) {
  const query = usePullRequestDetail(pullNumber);
  const refresh = useRefreshPullRequests();
  const updateReviewers = useUpdatePullRequestReviewers(pullNumber);
  const [reviewerLogins, setReviewerLogins] = useState<string[]>([]);
  const [reviewerBindings, setReviewerBindings] = useState<
    Record<string, User | null>
  >({});

  useEffect((): void => {
    if (query.data) {
      setReviewerLogins(
        query.data.pullRequest.requestedReviewers.map(
          (reviewer: GitHubActorSummary): string => reviewer.login,
        ),
      );
      setReviewerBindings(
        Object.fromEntries(
          query.data.reviewerCandidates.map(
            (candidate: GitHubReviewerCandidate): [string, User | null] => [
              candidate.login.toLowerCase(),
              candidate.feishuEmployeeId
                ? {
                    employee_id: candidate.feishuEmployeeId,
                    name: candidate.feishuName || '飞书成员',
                    user_type: '_employee',
                  }
                : null,
            ],
          ),
        ),
      );
    }
  }, [query.data]);

  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        message={query.error?.message || '获取合并请求详情失败'}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const {
    pullRequest,
    reviewerCandidates,
    comments,
    reviews,
    reviewThreads,
    checks,
    reviewerNotifications,
    canManageReviewers,
    completeness,
  } = query.data;
  const commentCompleteness = completeness?.comments || {
    loadedCount: comments.length,
    totalCount: pullRequest.commentCount,
    complete: comments.length >= pullRequest.commentCount,
  };
  const reviewCompleteness = completeness?.reviews || {
    loadedCount: reviews.length,
    totalCount: pullRequest.reviewCount,
    complete: reviews.length >= pullRequest.reviewCount,
  };
  const threadCompleteness = completeness?.reviewThreads || {
    loadedCount: reviewThreads.length,
    totalCount: pullRequest.reviewThreadCount,
    complete: reviewThreads.length >= pullRequest.reviewThreadCount,
  };
  const canEditReviewers: boolean =
    canManageReviewers && pullRequest.state === 'OPEN';
  const unresolvedThreads: PullRequestReviewThreadSummary[] =
    reviewThreads.filter(
      (thread: PullRequestReviewThreadSummary): boolean =>
        !thread.resolved && !thread.outdated,
    );
  const resolvedThreads: PullRequestReviewThreadSummary[] =
    reviewThreads.filter(
      (thread: PullRequestReviewThreadSummary): boolean =>
        thread.resolved || thread.outdated,
    );
  const humanReviews: PullRequestReviewSummary[] = reviews.filter(
    (review: PullRequestReviewSummary): boolean =>
      !isAutomatedActor(review.author.login),
  );
  const automatedReviews: PullRequestReviewSummary[] = reviews.filter(
    (review: PullRequestReviewSummary): boolean =>
      isAutomatedActor(review.author.login),
  );
  const selectableReviewerMap: Map<string, GitHubReviewerCandidate> = new Map();
  [...reviewerCandidates, ...pullRequest.requestedReviewers].forEach(
    (candidate: GitHubActorSummary): void => {
      if (
        candidate.login.toLowerCase() !== pullRequest.author.login.toLowerCase()
      ) {
        const known: GitHubReviewerCandidate | undefined =
          reviewerCandidates.find(
            (item: GitHubReviewerCandidate): boolean =>
              item.login.toLowerCase() === candidate.login.toLowerCase(),
          );
        selectableReviewerMap.set(candidate.login.toLowerCase(), {
          ...candidate,
          feishuEmployeeId: known?.feishuEmployeeId || '',
          feishuName: known?.feishuName || '',
        });
      }
    },
  );
  const selectableReviewers: GitHubReviewerCandidate[] = [
    ...selectableReviewerMap.values(),
  ];
  const reviewersChanged: boolean =
    JSON.stringify(
      reviewerLogins.map((login: string): string => login.toLowerCase()).sort(),
    ) !==
    JSON.stringify(
      pullRequest.requestedReviewers
        .map((reviewer: GitHubActorSummary): string =>
          reviewer.login.toLowerCase(),
        )
        .sort(),
    );
  const missingBindings: string[] = reviewerLogins.filter(
    (login: string): boolean =>
      !reviewerBindings[login.toLowerCase()]?.employee_id,
  );
  const changedBindings = reviewerLogins.flatMap((login: string) => {
    const candidate: GitHubReviewerCandidate | undefined =
      selectableReviewerMap.get(login.toLowerCase());
    const selected: User | null | undefined =
      reviewerBindings[login.toLowerCase()];
    const employeeId: string = selected?.employee_id || '';
    if (!employeeId || employeeId === candidate?.feishuEmployeeId) return [];
    return [{ login, feishuEmployeeId: employeeId }];
  });
  const reviewerConfigurationChanged: boolean =
    reviewersChanged || changedBindings.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
            <Link to="/pull-requests">
              <ArrowLeft className="size-4" />
              返回合并请求
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={stateBadgeClass(pullRequest.state)}
            >
              {stateLabel(pullRequest.state)}
            </Badge>
            {pullRequest.draft ? <Badge variant="secondary">草稿</Badge> : null}
            <span className="text-sm text-muted-foreground">
              #{pullRequest.number}
            </span>
          </div>
          <h1 className="mt-2 max-w-5xl text-2xl font-semibold leading-tight tracking-tight">
            {pullRequest.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <Actor {...pullRequest.author} />
            <span className="font-mono text-xs">
              {pullRequest.headRef} → {pullRequest.baseRef}
            </span>
            <span>GitHub 更新于 {formatDateTime(pullRequest.updatedAt)}</span>
            <span>平台同步于 {formatDateTime(pullRequest.syncedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw
              className={cn('size-4', refresh.isPending && 'animate-spin')}
            />
            刷新详情
          </Button>
          <Button variant="outline" asChild>
            <a href={pullRequest.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />在 GitHub 打开
            </a>
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: '提交', value: pullRequest.commitCount, icon: GitCommit },
          { label: '文件', value: pullRequest.changedFiles, icon: FileCode2 },
          {
            label: '新增',
            value: `+${pullRequest.additions}`,
            icon: CircleDot,
          },
          { label: '删除', value: `-${pullRequest.deletions}`, icon: XCircle },
          {
            label: '检查',
            value: checksLabel(pullRequest.checksStatus, pullRequest.state),
            icon: ShieldCheck,
          },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{label}</span>
              <Icon className="size-4" />
            </div>
            <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <Card className="rounded-lg shadow-none">
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-5">
          {[
            {
              label: '评审结论',
              value: reviewLabel(pullRequest.reviewDecision, pullRequest.state),
            },
            {
              label:
                pullRequest.state === 'OPEN' ? '待处理意见' : '历史未解决意见',
              value: `${unresolvedThreads.length} 项`,
            },
            {
              label: '代码检查',
              value: checksLabel(pullRequest.checksStatus, pullRequest.state),
            },
            {
              label: '合并状态',
              value: mergeableLabel(pullRequest.mergeable, pullRequest.state),
            },
            {
              label: '关联需求',
              value: `${pullRequest.linkedRequirements.length} 项`,
            },
          ].map((item) => (
            <div key={item.label} className="min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-1 truncate text-sm font-medium">{item.value}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">变更说明</CardTitle>
            </CardHeader>
            <CardContent>
              {pullRequest.body ? (
                <Streamdown className="text-sm leading-7">
                  {pullRequest.body}
                </Streamdown>
              ) : (
                <p className="text-sm text-muted-foreground">未填写变更说明</p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-3 text-base">
                <span>
                  {pullRequest.state === 'OPEN'
                    ? '待处理代码意见'
                    : '历史代码意见快照'}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    unresolvedThreads.length
                      ? 'border-amber-200 text-amber-800'
                      : 'border-emerald-200 text-emerald-700',
                  )}
                >
                  {unresolvedThreads.length} 项
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!threadCompleteness.complete ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  当前缓存展示 {threadCompleteness.loadedCount} /{' '}
                  {threadCompleteness.totalCount} 项代码意见；请到 GitHub
                  查看完整内容。
                </div>
              ) : null}
              {unresolvedThreads.length ? (
                unresolvedThreads.map((thread) => (
                  <ReviewThreadBlock key={thread.id} thread={thread} />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  当前没有未解决的代码评审意见。
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                常规评论 {commentCompleteness.loadedCount}
                {commentCompleteness.complete
                  ? ''
                  : ` / ${commentCompleteness.totalCount}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!commentCompleteness.complete ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  当前缓存展示 {commentCompleteness.loadedCount} /{' '}
                  {commentCompleteness.totalCount} 条评论；
                  <a
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    到 GitHub 查看完整评论
                  </a>
                  。
                </div>
              ) : null}
              {comments.length ? (
                comments.map((comment) => (
                  <CommentBlock key={comment.id} comment={comment} />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">暂无常规评论</p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">评审记录</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!reviewCompleteness.complete ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  当前缓存展示 {reviewCompleteness.loadedCount} /{' '}
                  {reviewCompleteness.totalCount} 条评审记录；请到 GitHub
                  查看完整内容。
                </div>
              ) : null}
              {humanReviews.length ? (
                humanReviews.map((review) => (
                  <ReviewBlock key={review.id} review={review} />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  暂无人工评审记录
                </p>
              )}
              {automatedReviews.length ? (
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm font-medium">
                    <span>自动评审记录 {automatedReviews.length} 条</span>
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pt-3">
                    {automatedReviews.map((review) => (
                      <ReviewBlock key={review.id} review={review} />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
              {resolvedThreads.length ? (
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm font-medium">
                    <span>
                      已解决或已过时代码意见 {resolvedThreads.length} 项
                    </span>
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pt-3">
                    {resolvedThreads.map((thread) => (
                      <ReviewThreadBlock key={thread.id} thread={thread} />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:sticky lg:top-24">
          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <UsersRound className="size-4" />
                GitHub 评审人
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {canEditReviewers ? (
                <GitHubReviewerPicker
                  candidates={selectableReviewers}
                  value={reviewerLogins}
                  onChange={setReviewerLogins}
                />
              ) : null}
              <ReviewerGroup
                reviewers={reviewerLogins.map(
                  (login: string): GitHubActorSummary =>
                    selectableReviewers.find(
                      (candidate: GitHubActorSummary): boolean =>
                        candidate.login.toLowerCase() === login.toLowerCase(),
                    ) || { login, avatarUrl: '' },
                )}
              />
              {canEditReviewers && reviewerLogins.length ? (
                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs font-medium">飞书通知接收人</p>
                  {reviewerLogins.map((login: string) => {
                    const candidate: GitHubReviewerCandidate | undefined =
                      selectableReviewerMap.get(login.toLowerCase());
                    return (
                      <div
                        key={login}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] items-center gap-2"
                      >
                        <Actor
                          login={login}
                          avatarUrl={candidate?.avatarUrl || ''}
                        />
                        <UserSelect
                          valueType="object"
                          accountType="lark"
                          value={reviewerBindings[login.toLowerCase()] || null}
                          onChange={(value) =>
                            setReviewerBindings((current) => ({
                              ...current,
                              [login.toLowerCase()]: value,
                            }))
                          }
                          closeOnSelect
                          placeholder="选择飞书成员"
                          className="min-w-0"
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">
                {canEditReviewers
                  ? '保存后直接更新 GitHub 待评审人；新添加的账号会收到 GitHub 原生通知，并由周催办私聊对应飞书成员。账号与飞书成员的绑定会长期复用。'
                  : pullRequest.state !== 'OPEN'
                    ? '已合并或已关闭的合并请求只能查看评审人。'
                    : '当前账号只有查看权限，平台管理员或编辑者可设置评审人。'}
              </p>
              {canEditReviewers && missingBindings.length ? (
                <p className="text-xs text-destructive">
                  请为 {missingBindings.join('、')} 选择飞书成员
                </p>
              ) : null}
              {canEditReviewers ? (
                <Button
                  className="w-full"
                  disabled={
                    !reviewerConfigurationChanged ||
                    missingBindings.length > 0 ||
                    updateReviewers.isPending
                  }
                  onClick={() =>
                    updateReviewers.mutate({
                      reviewerLogins,
                      reviewerBindings: changedBindings,
                    })
                  }
                >
                  {updateReviewers.isPending ? '保存中' : '保存评审人'}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {reviewerNotifications.length ? (
            <Card className="rounded-lg shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">飞书通知状态</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {reviewerNotifications.map((notification) => (
                  <NotificationBlock
                    key={notification.id}
                    notification={notification}
                  />
                ))}
                <p className="text-xs leading-5 text-muted-foreground">
                  展示平台实际排队和送达的飞书私聊；GitHub 原生通知以 GitHub
                  为准。
                </p>
              </CardContent>
            </Card>
          ) : null}

          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">关联交付</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {pullRequest.linkedRequirements.length ? (
                pullRequest.linkedRequirements.map((requirement) => (
                  <Link
                    key={requirement.id}
                    to={`/requirements/${requirement.id}`}
                    className="block rounded-lg border p-3 transition-colors hover:border-primary/30 hover:bg-primary/[0.02]"
                  >
                    <p className="text-xs font-medium text-primary">
                      {requirement.code}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm font-medium">
                      {requirement.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {requirement.iterationNames.join('、') || '未关联迭代'}
                    </p>
                  </Link>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  分支名和 PR 内容中未识别到需求编号。
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">检查项</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {checks.length ? (
                checks.map((check, index) => (
                  <CheckBlock key={`${check.name}-${index}`} check={check} />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">暂无检查项</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function PullRequestsPage() {
  const params = useParams<{ pullNumber?: string }>();
  const pullNumber: number | null = params.pullNumber
    ? Number(params.pullNumber)
    : null;
  if (pullNumber != null && Number.isFinite(pullNumber)) {
    return <PullRequestDetail pullNumber={pullNumber} />;
  }
  return <PullRequestList />;
}
