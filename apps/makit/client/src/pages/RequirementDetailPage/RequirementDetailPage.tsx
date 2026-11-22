import { useEffect, useMemo, useState } from 'react';
import './ticket-responsive.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptanceItemSummary,
  PullRequestSummary,
  RelationCreateInput,
  RequirementEditContext,
  RequirementArtifactKind,
  WorkspaceBrowserResponse,
} from '@shared/api.interface';
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  UsersRound,
} from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  addAcceptanceItem,
  addComment,
  addRelation,
  deleteRequirement,
  getRequirementPullRequests,
  runGroupAction,
  updateAcceptanceItem,
} from '@/api';
import InlineRequirementFieldEditor from '@/components/InlineRequirementFieldEditor';
import RequirementClarityReviewPanel from '@/components/RequirementClarityReviewPanel';
import { RequirementContentEditor } from '@/components/RequirementContentEditor';
import RequirementEngineeringPanel from '@/components/RequirementEngineeringPanel';
import RequirementFormDialog from '@/components/RequirementFormDialog';
import RequirementMarkdown from '@/components/RequirementMarkdown';
import RequirementTypeBadge from '@/components/RequirementTypeBadge';
import {
  downloadRelayResource,
  relayResourcePath,
} from '@/components/relay/relay-resource';
import QuickPersonnelEditor from '@/components/QuickPersonnelEditor';
import StatusTransitionDialog from '@/components/StatusTransitionDialog';
import { ErrorState, LoadingState } from '@/components/WorkspaceStates';
import { UserSelect } from '@/components/business-ui/user-select';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  errorMessage,
  formatDate,
  hasMarkdownFormatting,
  parseRequirementContent,
  peopleLabel,
  STATUS_STYLES,
} from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';
import { useBrowserRequirementList, BROWSER_WORKSPACE_QUERY_KEY } from '@/hooks/use-browser-workspace';
import { useRequirementEditContext } from '@/hooks/use-requirement-edit-context';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';
import { useLazyRequirementDetail } from '@/hooks/use-lazy-requirement-detail';
import RequirementNextAction from '@/components/RequirementNextAction';
import type { WorkflowRequiredField } from '@shared/iteration-workflow';

const NORMAL_PHASES = [
  { label: '需求阶段', statuses: ['新', '需求已评审'] },
  { label: '开发阶段', statuses: ['开发中', '开发转测试'] },
  { label: '测试阶段', statuses: ['测试中', '产品体验中'] },
  { label: '部署阶段', statuses: ['待发布'] },
  { label: '发布阶段', statuses: ['已发布'] },
];

const DEFECT_PHASES = [
  { label: '新建', statuses: ['新建', '已拒绝'] },
  { label: '处理', statuses: ['处理中', '重新打开'] },
  { label: '已解决', statuses: ['已解决'] },
  { label: '已验证', statuses: ['已验证'] },
  { label: '已关闭', statuses: ['已关闭'] },
];

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ticket-field-row grid min-h-10 grid-cols-[104px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
      <span className="flex min-h-9 items-center text-muted-foreground">
        {label}
      </span>
      <div className="flex min-h-9 min-w-0 items-center">{children}</div>
    </div>
  );
}

export default function RequirementDetailPage() {
  const { recordId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo =
    typeof (location.state as { requirementReturnTo?: unknown } | null)
      ?.requirementReturnTo === 'string'
      ? (location.state as { requirementReturnTo: string }).requirementReturnTo
      : '/requirements';
  const editContextQuery = useRequirementEditContext();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [acceptanceTitle, setAcceptanceTitle] = useState('');
  const showAcceptancePreview = useMemo(
    () => hasMarkdownFormatting(acceptanceTitle),
    [acceptanceTitle],
  );
  const [acceptanceOwners, setAcceptanceOwners] = useState<string[]>([]);
  const [relationType, setRelationType] =
    useState<RelationCreateInput['type']>('相关');
  const [relationTarget, setRelationTarget] = useState('');
  const [relationDescription, setRelationDescription] = useState('');
  const [relationSearch, setRelationSearch] = useState('');
  const [activeTab, setActiveTab] = useState('detail');
  const [engineeringFocus, setEngineeringFocus] = useState<{
    kind: RequirementArtifactKind;
    nonce: number;
  }>();
  const [transitionFocus, setTransitionFocus] =
    useState<WorkflowRequiredField>();

  const detailQuery = useLazyRequirementDetail(recordId, activeTab);
  const introductionValue = detailQuery.data?.requirement.introduction || '';
  const introduction = useMemo(
    () => parseRequirementContent(introductionValue),
    [introductionValue],
  );
  const cachedType = queryClient.getQueryData<WorkspaceBrowserResponse>(BROWSER_WORKSPACE_QUERY_KEY)
    ?.requirements.find((item) => item.id === recordId)?.type;
  const knownType = detailQuery.data?.requirement.type || cachedType;
  // Reuse the same query as the review panels; a known non-ticket may load
  // engineering alongside core rather than waiting for the body to render.
  useRequirementEngineering(recordId, Boolean(knownType && knownType !== '工单') && ['detail', 'engineering'].includes(activeTab));
  useEffect(() => {
    if (
      detailQuery.data?.requirement.type === '工单' &&
      ['acceptance', 'engineering'].includes(activeTab)
    ) {
      setActiveTab('detail');
    }
  }, [activeTab, detailQuery.data?.requirement.type]);
  const pullRequestsQuery = useQuery<PullRequestSummary[]>({
    queryKey: ['requirement', recordId, 'pull-requests'],
    queryFn: ({ signal }) => getRequirementPullRequests(recordId, signal),
    enabled:
      Boolean(recordId) &&
      activeTab === 'relations' &&
      Boolean(detailQuery.data) &&
      detailQuery.data?.requirement.type !== '工单',
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const relationCandidatesQuery = useBrowserRequirementList(
    {
      page: 1,
      pageSize: 50,
      search: relationSearch,
      excludeId: recordId,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    },
    Boolean(recordId) && activeTab === 'relations',
  );

  const invalidateDetail = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: ['requirement', recordId],
    });
  };

  const commentMutation = useMutation({
    mutationFn: () => addComment(recordId, { content: comment }),
    onSuccess: async (result) => {
      setComment('');
      toast.success(result.message);
      await invalidateDetail();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const acceptanceMutation = useMutation({
    mutationFn: () =>
      addAcceptanceItem(recordId, {
        title: acceptanceTitle,
        ownerUserIds: acceptanceOwners,
      }),
    onSuccess: async (result) => {
      setAcceptanceTitle('');
      setAcceptanceOwners([]);
      toast.success(result.message);
      await invalidateDetail();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const acceptanceToggleMutation = useMutation({
    mutationFn: ({
      item,
      completed,
    }: {
      item: AcceptanceItemSummary;
      completed: boolean;
    }) => updateAcceptanceItem(item.id, { completed }),
    onSuccess: async () => {
      await invalidateDetail();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const relationMutation = useMutation({
    mutationFn: () =>
      addRelation(recordId, {
        targetRequirementId: relationTarget,
        type: relationType,
        description: relationDescription,
      }),
    onSuccess: async (result) => {
      setRelationTarget('');
      setRelationDescription('');
      toast.success(result.message);
      await invalidateDetail();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const groupMutation = useMutation({
    mutationFn: (action: 'create' | 'sync') => runGroupAction(recordId, action),
    onSuccess: async (result) => {
      toast.success(result.message);
      await Promise.all([
        invalidateDetail(),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRequirement(recordId),
    onSuccess: async (result) => {
      toast.success(result.message);
      queryClient.removeQueries({ queryKey: ['requirement', recordId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['requirements'] }),
        queryClient.invalidateQueries({ queryKey: ['requirement-archive'] }),
      ]);
      navigate(returnTo, { replace: true });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (detailQuery.isLoading) {
    return <LoadingState label="正在加载需求详情" />;
  }
  if (!detailQuery.data) {
    return (
      <ErrorState
        message={
          detailQuery.error?.message ||
          editContextQuery.error?.message ||
          '未知错误'
        }
        onRetry={() => {
          void detailQuery.refetch();
          void editContextQuery.refetch();
        }}
      />
    );
  }

  const detail = detailQuery.data;
  const requirement = detail.requirement;
  const workspace: RequirementEditContext = editContextQuery.data || { iterations: [], options: { statuses: [], priorities: [], projects: [], types: [], sources: [], tags: [] } };
  const ticket = requirement.type === '工单';
  const defect = requirement.type === '缺陷';
  const phases = requirement.workflow
    ? requirement.workflow.statuses.map((status) => ({
        label: status,
        statuses: [status],
      }))
    : defect
      ? DEFECT_PHASES
      : NORMAL_PHASES;
  const currentPhase = Math.max(
    0,
    phases.findIndex((phase) => phase.statuses.includes(requirement.status)),
  );
  const relatedCandidates = relationCandidatesQuery.data?.items || [];
  const acceptanceCompleted = detail.acceptanceItems.filter(
    (item) => item.completed,
  ).length;

  return (
    <div className={cn('space-y-5', ticket && 'ticket-detail-page')}>
      {detailQuery.isError || editContextQuery.isError ? (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {editContextQuery.isError ? "编辑选项暂时无法加载，需求内容仍可查看。" : "暂时无法刷新，当前展示最近一次成功读取的内容。"}
          {editContextQuery.isError ? <Button variant="ghost" size="sm" onClick={() => void editContextQuery.refetch()}>重试编辑选项</Button> : null}
        </div>
      ) : null}
      <div className="ticket-detail-actions flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to={returnTo}>
            <ArrowLeft className="size-4" />
            返回需求池
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            <RefreshCw
              className={cn('size-4', detailQuery.isFetching && 'animate-spin')}
            />
            刷新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={requirement.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              在新窗口打开
            </a>
          </Button>
          {requirement.capabilities.canUpdate ? (
            <Button size="sm" disabled={!editContextQuery.data} onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              编辑
            </Button>
          ) : null}
          {requirement.capabilities.canArchive ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Archive className="size-4" />
                  归档
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认归档该需求？</AlertDialogTitle>
                  <AlertDialogDescription>
                    归档后“{requirement.title}
                    ”不会继续出现在需求池和迭代中；
                    需求内容及关联数据都会保留，管理员可在归档管理中恢复。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>
                    取消
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Archive className="size-4" />
                    )}
                    确认归档
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl border-border/75 shadow-sm">
        <div className={cn(!ticket && 'border-b', 'px-5 py-4')}>
          <div className="flex flex-wrap items-center gap-2">
            <RequirementTypeBadge type={requirement.type} />
            <span className="text-xs text-muted-foreground">
              {requirement.code}
            </span>
            {requirement.blocked ? (
              <Badge variant="destructive">阻塞</Badge>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <h1 className="max-w-5xl text-2xl font-semibold leading-8 tracking-tight">
              {requirement.title}
            </h1>
          </div>
        </div>

        {!ticket && (
          <div
            className="relative grid gap-1 overflow-x-auto bg-gradient-to-r from-muted/55 via-background to-primary/[0.035] px-5 py-4"
            style={{
              gridTemplateColumns: `repeat(${phases.length}, minmax(76px, 1fr))`,
            }}
          >
            <div className="absolute left-[10%] right-[10%] top-[26px] h-px bg-border" />
            {phases.map((phase, index) => (
              <div key={phase.label} className="relative text-center">
                <span
                  className={cn(
                    'mx-auto grid size-5 place-items-center rounded-full border bg-background',
                    index < currentPhase &&
                      'border-primary bg-primary text-primary-foreground',
                    index === currentPhase &&
                      'border-primary text-primary shadow-[0_0_0_6px_hsl(221_83%_53%_/_0.08)] ring-4 ring-primary/10',
                  )}
                >
                  {index < currentPhase ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : (
                    <Circle className="size-2.5 fill-current" />
                  )}
                </span>
                <p
                  className={cn(
                    'mt-2 text-xs text-muted-foreground',
                    index === currentPhase && 'font-medium text-primary',
                  )}
                >
                  {phase.label}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div
        className={cn(
          'ticket-detail-columns grid gap-4 lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden',
          ticket ? 'lg:h-[calc(100dvh-300px)]' : 'lg:h-[calc(100dvh-390px)]',
        )}
      >
        <Card className="ticket-content-panel h-full min-w-0 overflow-hidden rounded-2xl border-border/75 shadow-sm">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="h-full min-h-0 gap-0"
          >
            <div className="shrink-0 overflow-x-auto border-b px-4 sm:px-5">
              <TabsList className="h-12 w-max min-w-full justify-start gap-5 rounded-none bg-transparent p-0 sm:gap-6">
                <TabsTrigger
                  className="h-12 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  value="detail"
                >
                  详细信息
                </TabsTrigger>
                {!ticket && (
                  <TabsTrigger
                    className="h-12 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                    value="acceptance"
                  >
                    验收项{' '}
                    {detailQuery.loadedSections.acceptance
                      ? `${acceptanceCompleted}/${detail.acceptanceItems.length}`
                      : ''}
                  </TabsTrigger>
                )}
                {!defect && !ticket ? (
                  <TabsTrigger
                    className="h-12 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                    value="engineering"
                  >
                    研发资料
                  </TabsTrigger>
                ) : null}
                <TabsTrigger
                  className="h-12 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  value="relations"
                >
                  关联{' '}
                  {detailQuery.loadedSections.relations
                    ? detail.relations.length +
                      (pullRequestsQuery.data?.length || 0)
                    : ''}
                </TabsTrigger>
                <TabsTrigger
                  className="h-12 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  value="activity"
                >
                  变更历史{' '}
                  {detailQuery.loadedSections.activities
                    ? detail.activities.length
                    : ''}
                </TabsTrigger>
              </TabsList>
            </div>

            {detailQuery.sectionError ? (
              <div
                role="status"
                className="mx-5 mt-3 shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                当前区域暂时无法刷新，其他操作不受影响。
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void detailQuery.refetchSection()}
                >
                  重试
                </Button>
              </div>
            ) : null}
            {detailQuery.sectionLoading ? (
              <div className="flex shrink-0 items-center gap-2 px-5 pt-3 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                读取当前区域
              </div>
            ) : null}
            <TabsContent
              value="detail"
              className="m-0 min-h-0 flex-1 space-y-6 overflow-y-auto p-5"
            >
              <section
                onClickCapture={(event) => {
                  const link = (event.target as HTMLElement).closest('a');
                  if (
                    !link ||
                    !relayResourcePath(link.href, window.location.origin)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  void downloadRelayResource(
                    link.href,
                    link.textContent === '下载完整对话快照'
                      ? 'relay-context.json'
                      : link.textContent || 'relay-file',
                  ).catch(() => toast.error('文件下载失败，请重试'));
                }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">
                    {ticket ? '问题描述' : '需求介绍'}
                  </h2>
                  {requirement.capabilities.canUpdate ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditOpen(true)}
                    >
                      <Pencil className="size-3.5" />
                      编辑内容
                    </Button>
                  ) : null}
                </div>
                {requirement.introduction ? (
                  introduction.format === 'richText' ? (
                    <RequirementContentEditor
                      value={introduction.value}
                      readOnly
                      className="min-h-0 w-full"
                    />
                  ) : (
                    <RequirementMarkdown
                      value={introduction.value}
                      className="overflow-x-auto rounded-lg border px-4 py-3 text-sm"
                    />
                  )
                ) : (
                  <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    尚未填写需求介绍
                  </div>
                )}
              </section>

              {!ticket && (
                <section>
                  <h2 className="mb-3 text-sm font-semibold">验收标准</h2>
                  <div className="whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 text-sm leading-6">
                    {requirement.acceptanceCriteria || '尚未填写验收标准'}
                  </div>
                </section>
              )}
              {!defect && !ticket ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold">AI 需求评审</h2>
                  <RequirementClarityReviewPanel requirementId={recordId} />
                </section>
              ) : null}

              {defect && requirement.defectCause ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold">缺陷原因</h2>
                  <div className="whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 text-sm leading-6">
                    {requirement.defectCause}
                  </div>
                </section>
              ) : null}

              <section>
                <h2 className="mb-3 text-sm font-semibold">
                  {ticket ? '处理进展' : '最新进展'}
                </h2>
                <div className="whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 text-sm leading-6">
                  {requirement.latestProgress || '尚未更新进展'}
                </div>
                {requirement.blocked ? (
                  <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    阻塞原因：{requirement.blocker || '未说明'}
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <h2 className="mb-3 text-sm font-semibold">
                  讨论区 · {detail.comments.length}
                </h2>
                <div className="space-y-3">
                  {detail.comments.map((item) => (
                    <div key={item.id} className="flex gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {(item.authorName || '成员').slice(-2)}
                      </span>
                      <div className="min-w-0 flex-1 rounded-lg bg-muted/45 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-medium">
                            {item.authorName || '成员'}
                            {item.edited ? '（已编辑）' : ''}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatDate(item.createdAt, true)}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                          {item.content}
                        </p>
                      </div>
                    </div>
                  ))}
                  {!detail.comments.length ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      暂无评论
                    </p>
                  ) : null}
                </div>
                {requirement.capabilities.canComment ? (
                  <div className="mt-4 flex items-end gap-2">
                    <Textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="补充结论、提出问题，或说明需要谁协同"
                      className="min-h-20 flex-1"
                    />
                    <Button
                      onClick={() => commentMutation.mutate()}
                      disabled={!comment.trim() || commentMutation.isPending}
                    >
                      {commentMutation.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                      发布
                    </Button>
                  </div>
                ) : null}
              </section>
            </TabsContent>

            {!defect && !ticket ? (
              <TabsContent
                value="engineering"
                className="m-0 min-h-0 flex-1 overflow-y-auto p-5"
              >
                <RequirementEngineeringPanel
                  requirementId={recordId}
                  focusRequest={engineeringFocus}
                />
              </TabsContent>
            ) : null}

            {!ticket && (
              <TabsContent
                value="acceptance"
                className="m-0 min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
              >
                {requirement.capabilities.canManageAcceptance ? (
                  <div className="rounded-lg border p-4">
                    <div className="grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_280px_auto]">
                      <Textarea
                        aria-label="新增验收项"
                        value={acceptanceTitle}
                        onChange={(event) =>
                          setAcceptanceTitle(event.target.value)
                        }
                        placeholder="新增一条可验证的验收项，支持 Markdown"
                        className="max-h-64"
                      />
                      <UserSelect
                        multiple
                        valueType="string"
                        accountType="apaas"
                        value={acceptanceOwners}
                        onChange={(value) => setAcceptanceOwners(value || [])}
                        placeholder="负责人（可选）"
                        className="w-full"
                      />
                      <Button
                        onClick={() => acceptanceMutation.mutate()}
                        disabled={
                          !acceptanceTitle.trim() ||
                          acceptanceMutation.isPending
                        }
                      >
                        <MessageSquarePlus className="size-4" />
                        添加
                      </Button>
                    </div>
                    {showAcceptancePreview && (
                      <div className="mt-3 max-h-52 overflow-auto rounded-lg border bg-muted/35 p-3">
                        <p className="mb-2 text-xs font-medium text-muted-foreground">预览</p>
                        <RequirementMarkdown value={acceptanceTitle} />
                      </div>
                    )}
                  </div>
                ) : null}
                <div className="space-y-2">
                  {detail.acceptanceItems.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border px-4 py-3',
                        requirement.capabilities.canManageAcceptance &&
                          'cursor-pointer hover:bg-muted/40',
                      )}
                      onClick={(event) => {
                        if (
                          !requirement.capabilities.canManageAcceptance ||
                          (event.target as Element).closest('a, button, input') ||
                          window.getSelection()?.toString()
                        ) return;
                        acceptanceToggleMutation.mutate({
                          item,
                          completed: !item.completed,
                        });
                      }}
                    >
                      <Checkbox
                        aria-labelledby={`acceptance-title-${item.id}`}
                        checked={item.completed}
                        disabled={!requirement.capabilities.canManageAcceptance}
                        onCheckedChange={(checked) =>
                          acceptanceToggleMutation.mutate({
                            item,
                            completed: checked === true,
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div
                          id={`acceptance-title-${item.id}`}
                          className={cn(
                            'overflow-x-auto text-sm font-medium',
                            item.completed &&
                              'text-muted-foreground line-through',
                          )}
                        >
                          <RequirementMarkdown value={item.title} className="[&>:first-child]:mt-0 [&>:last-child]:mb-0" />
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          负责人：{peopleLabel(item.owner)}
                          {item.note && (
                            <RequirementMarkdown
                              value={item.note}
                              className="overflow-x-auto text-inherit [&>:first-child]:mt-1 [&>:last-child]:mb-0"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {!detail.acceptanceItems.length ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      尚未拆分验收项
                    </p>
                  ) : null}
                </div>
              </TabsContent>
            )}
            <TabsContent
              value="relations"
              className="m-0 min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
            >
              {requirement.capabilities.canManageRelations ? (
                <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-[140px_minmax(0,1fr)]">
                  <Input
                    className="md:col-span-2"
                    value={relationSearch}
                    onChange={(event) => setRelationSearch(event.target.value)}
                    placeholder="按标题或需求编号搜索关联需求"
                  />
                  <Select
                    value={relationType}
                    onValueChange={(value) =>
                      setRelationType(value as RelationCreateInput['type'])
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['依赖', '被依赖', '相关', '重复'].map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={relationTarget}
                    onValueChange={setRelationTarget}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择目标需求" />
                    </SelectTrigger>
                    <SelectContent>
                      {relationCandidatesQuery.isFetching ? (
                        <SelectItem value="__loading__" disabled>
                          正在搜索需求…
                        </SelectItem>
                      ) : null}
                      {relatedCandidates.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                      {!relationCandidatesQuery.isFetching &&
                      !relatedCandidates.length ? (
                        <SelectItem value="__empty__" disabled>
                          没有匹配的需求
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                  <Input
                    className="md:col-span-2"
                    value={relationDescription}
                    onChange={(event) =>
                      setRelationDescription(event.target.value)
                    }
                    placeholder="关系说明（可选）"
                  />
                  <Button
                    className="md:col-span-2 md:justify-self-end"
                    onClick={() => relationMutation.mutate()}
                    disabled={!relationTarget || relationMutation.isPending}
                  >
                    <GitBranch className="size-4" />
                    建立关联
                  </Button>
                </div>
              ) : null}
              <div className="space-y-2">
                {pullRequestsQuery.data?.map((pullRequest) => (
                  <Link
                    key={`pr-${pullRequest.number}`}
                    to={`/pull-requests/${pullRequest.number}`}
                    className="flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:border-primary/30 hover:bg-primary/[0.02]"
                  >
                    <GitBranch className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        PR #{pullRequest.number} · {pullRequest.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {pullRequest.headRef} → {pullRequest.baseRef}
                      </span>
                    </span>
                    <Badge variant="outline">
                      {pullRequest.state === 'OPEN'
                        ? '进行中'
                        : pullRequest.state === 'MERGED'
                          ? '已合并'
                          : '已关闭'}
                    </Badge>
                  </Link>
                ))}
                {detail.relations.map((relation) => (
                  <div
                    key={relation.id}
                    className="flex items-center gap-3 rounded-lg border px-4 py-3"
                  >
                    <Badge variant="outline">{relation.type}</Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {relation.targetTitle}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {relation.description || '未填写关系说明'} ·{' '}
                        {relation.createdByName || '成员'}
                      </span>
                    </span>
                  </div>
                ))}
                {!detail.relations.length &&
                !pullRequestsQuery.data?.length &&
                !pullRequestsQuery.isLoading ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    {ticket ? '暂无关联记录' : '暂无关联需求或合并请求'}
                  </p>
                ) : null}
                {pullRequestsQuery.isError ? (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    合并请求关联暂时不可用，可稍后刷新。
                  </p>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent
              value="activity"
              className="m-0 min-h-0 flex-1 overflow-y-auto p-5"
            >
              <div className="mb-4 flex justify-end gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link
                    to={`/operations?requirementId=${encodeURIComponent(requirement.id)}`}
                  >
                    查看操作结果
                  </Link>
                </Button>
              </div>
              <div className="space-y-0">
                {detail.activities.map((activity, index) => (
                  <div key={activity.id} className="relative flex gap-3 pb-5">
                    {index < detail.activities.length - 1 ? (
                      <div className="absolute bottom-0 left-[7px] top-4 w-px bg-border" />
                    ) : null}
                    <span className="mt-1.5 size-3.5 shrink-0 rounded-full border-2 border-background bg-primary ring-1 ring-primary/30" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {activity.type}
                        </span>
                        <Badge variant="secondary">
                          {activity.status || '已触发'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(activity.createdAt, true)}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                        {activity.actorName
                          ? `${activity.actorName} 发起变更`
                          : activity.summary ||
                            activity.source ||
                            '协作工作流已处理'}
                      </p>
                      {activity.changes.length ? (
                        <div className="mt-2 space-y-1 rounded-md bg-muted/55 px-3 py-2">
                          {activity.changes.map((change) => (
                            <p key={change.field} className="text-xs leading-5">
                              <span className="font-medium">
                                {change.field}
                              </span>
                              <span className="text-muted-foreground">
                                {' '}
                                {change.before} → {change.after}
                              </span>
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!detail.activities.length ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    暂无工作流事件记录
                  </p>
                ) : null}
              </div>
            </TabsContent>
          </Tabs>
        </Card>

        <div className="ticket-properties-panel h-full min-h-0 space-y-4 overflow-y-auto pr-1">
          {!ticket && (
            <RequirementNextAction
              requirement={requirement}
              onAdvance={() => setTransitionOpen(true)}
              onLocate={(field) => {
                if (
                  field === 'technical_design' ||
                  field === 'self_test_report'
                ) {
                  setEngineeringFocus({ kind: field, nonce: Date.now() });
                  setActiveTab('engineering');
                } else {
                  setTransitionFocus(field);
                  setTransitionOpen(true);
                }
              }}
            />
          )}
          <Card className="rounded-2xl border-border/75 shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">基本信息</CardTitle>
            </CardHeader>
            <CardContent className="ticket-basic-fields px-4 pb-4">
              <FieldRow label="状态">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'group h-8 w-full justify-start rounded-md px-2',
                    STATUS_STYLES[requirement.status],
                  )}
                  onClick={() => setTransitionOpen(true)}
                  disabled={!requirement.capabilities.canUpdate}
                >
                  {requirement.status}
                  <Pencil className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </Button>
              </FieldRow>
              <FieldRow label="优先级">
                <InlineRequirementFieldEditor
                  requirementId={requirement.id}
                  expectedUpdatedAt={requirement.updatedAt}
                  editable={requirement.capabilities.canUpdate && Boolean(editContextQuery.data)}
                  patchKey="priority"
                  kind="select"
                  value={
                    requirement.priority === '未设置'
                      ? ''
                      : requirement.priority
                  }
                  options={workspace.options.priorities.map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </FieldRow>
              <FieldRow label="项目">
                <InlineRequirementFieldEditor
                  requirementId={requirement.id}
                  expectedUpdatedAt={requirement.updatedAt}
                  editable={requirement.capabilities.canUpdate && Boolean(editContextQuery.data)}
                  patchKey="project"
                  kind="select"
                  value={
                    requirement.project === '未设置' ? '' : requirement.project
                  }
                  options={workspace.options.projects.map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </FieldRow>
              {!ticket && (
                <FieldRow label="所属迭代">
                  <InlineRequirementFieldEditor
                    requirementId={requirement.id}
                    expectedUpdatedAt={requirement.updatedAt}
                    editable={requirement.capabilities.canUpdate && Boolean(editContextQuery.data)}
                    patchKey="iterationIds"
                    kind="iterations"
                    value={requirement.iterationIds}
                    options={workspace.iterations.map((iteration) => ({
                      value: iteration.id,
                      label: iteration.name,
                    }))}
                  />
                </FieldRow>
              )}
              <FieldRow label="类型">
                <InlineRequirementFieldEditor
                  requirementId={requirement.id}
                  expectedUpdatedAt={requirement.updatedAt}
                  editable={requirement.capabilities.canUpdate && Boolean(editContextQuery.data)}
                  patchKey="type"
                  kind="select"
                  value={requirement.type === '未设置' ? '' : requirement.type}
                  options={workspace.options.types.map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </FieldRow>
              {!ticket && (
                <FieldRow label="来源">
                  <InlineRequirementFieldEditor
                    requirementId={requirement.id}
                    expectedUpdatedAt={requirement.updatedAt}
                    editable={requirement.capabilities.canUpdate && Boolean(editContextQuery.data)}
                    patchKey="source"
                    kind="select"
                    value={
                      requirement.source === '未设置' ? '' : requirement.source
                    }
                    options={workspace.options.sources.map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="开发工作量">
                  <InlineRequirementFieldEditor
                    requirementId={requirement.id}
                    expectedUpdatedAt={requirement.updatedAt}
                    editable={requirement.capabilities.canUpdate}
                    patchKey="effort"
                    kind="number"
                    value={requirement.effort}
                    suffix=" 天"
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="Git 分支">
                  <InlineRequirementFieldEditor
                    requirementId={requirement.id}
                    expectedUpdatedAt={requirement.updatedAt}
                    editable={requirement.capabilities.canUpdate}
                    patchKey="gitBranchName"
                    value={requirement.gitBranchName}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="GitHub PR">
                  <InlineRequirementFieldEditor
                    requirementId={requirement.id}
                    expectedUpdatedAt={requirement.updatedAt}
                    editable={requirement.capabilities.canUpdate}
                    patchKey="githubPullRequestUrl"
                    value={requirement.githubPullRequestUrl}
                    placeholder="未关联"
                  />
                </FieldRow>
              )}
              <Separator className="my-1" />
              <FieldRow label="当前处理人">
                {ticket ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    disabled={!requirement.capabilities.canUpdate}
                    onClick={() => setEditOpen(true)}
                  >
                    {peopleLabel(requirement.handlers)}
                  </Button>
                ) : (
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="handlers"
                    people={requirement.handlers}
                    editable={requirement.capabilities.canUpdate}
                  />
                )}
              </FieldRow>
              {!ticket && (
                <FieldRow label="产品人员">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="productOwners"
                    people={requirement.productOwners}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="研发人员">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="developers"
                    people={requirement.developers}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="测试人员">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="testers"
                    people={requirement.testers}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="FO">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="foOwners"
                    people={requirement.foOwners}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="发布负责人">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="releaseOwners"
                    people={requirement.releaseOwners}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              {!ticket && (
                <FieldRow label="提出人">
                  <QuickPersonnelEditor
                    requirementId={requirement.id}
                    role="proposers"
                    people={requirement.proposers}
                    editable={requirement.capabilities.canUpdate}
                  />
                </FieldRow>
              )}
              <Separator className="my-1" />
              {ticket ? <FieldRow label="截止时间"><InlineRequirementFieldEditor requirementId={requirement.id} expectedUpdatedAt={requirement.updatedAt} editable={requirement.capabilities.canUpdate} patchKey="deadlineAt" kind="date" value={requirement.deadlineAt}/></FieldRow> : null}
              <FieldRow label="最近更新">
                {requirement.updatedByName || '成员'} ·{' '}
                {formatDate(requirement.updatedAt, true)}
              </FieldRow>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-border/75 shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <UsersRound className="size-4 text-primary" />
                {ticket ? '工单讨论群' : '需求协作群'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              <p className="text-xs leading-5 text-muted-foreground">
                {ticket
                  ? '同步当前处理人和发起人。'
                  : '自动同步当前处理人、产品、研发、测试、FO 和发布负责人。状态流转会在群内通知对应角色。'}
              </p>
              {requirement.groupLink ? (
                <Button className="w-full" variant="outline" asChild>
                  <a
                    href={requirement.groupLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {ticket ? '打开讨论群' : '打开需求群'}
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              ) : null}
              <Button
                className="w-full"
                onClick={() =>
                  groupMutation.mutate(
                    requirement.groupChatId ? 'sync' : 'create',
                  )
                }
                disabled={
                  groupMutation.isPending ||
                  !requirement.capabilities.canManageGroup
                }
              >
                {groupMutation.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <UsersRound className="size-4" />
                )}
                {requirement.groupChatId
                  ? '同步群成员'
                  : ticket
                    ? '创建讨论群'
                    : '一键创建需求群'}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                当前状态：{requirement.groupStatus}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {editOpen && requirement.capabilities.canUpdate && editContextQuery.data ? (
        <RequirementFormDialog
          open
          onOpenChange={setEditOpen}
          workspace={workspace}
          requirement={requirement}
        />
      ) : null}
      {requirement.capabilities.canUpdate ? (
        <StatusTransitionDialog
          open={transitionOpen}
          onOpenChange={(open) => {
            setTransitionOpen(open);
            if (!open) setTransitionFocus(undefined);
          }}
          initialFocusField={transitionFocus}
          requirement={requirement}
          onOpenEngineering={() => setActiveTab('engineering')}
        />
      ) : null}
    </div>
  );
}
