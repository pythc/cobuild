import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  Check,
  GitBranch,
  History,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  defaultIterationTransition,
  ITERATION_STATUS_CATALOG,
  iterationConfigurationErrors,
  WORKFLOW_FIELD_LABELS,
  WORKFLOW_RELEASE_LABELS,
  WORKFLOW_REVIEW_LABELS,
  type IterationConfiguration,
  type IterationSettingsResponse,
  type IterationSettingsImpact,
  type IterationWorkflowKind,
  type IterationTransition,
} from '@shared/iteration-workflow';
import {
  getIterationSettings,
  getRequirementEditContext,
  saveIterationSettings,
  validateIterationSettings,
} from '@/api';
import { useCurrentPlatformUser } from '@/hooks/use-workspace';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { LoadingState, ErrorState } from '@/components/WorkspaceStates';
import { errorMessage, formatDate } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';
import { IterationAnalysisSettings } from '@/components/IterationAnalysisSettings';

function Choices<T extends string>({
  labels,
  selected,
  onChange,
  mandatory = [],
}: {
  labels: Record<T, string>;
  selected: T[];
  onChange: (items: T[]) => void;
  mandatory?: T[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(Object.entries(labels) as [T, string][]).map(([key, label]) => (
        <label
          key={key}
          className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm has-[[data-state=checked]]:border-blue-200 has-[[data-state=checked]]:bg-blue-50/60"
        >
          <Checkbox
            checked={selected.includes(key)}
            disabled={mandatory.includes(key)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selected, key]
                  : selected.filter((x) => x !== key),
              )
            }
          />
          {label}
          {mandatory.includes(key) && (
            <span className="ml-auto text-xs text-muted-foreground">必选</span>
          )}
        </label>
      ))}
    </div>
  );
}

export default function IterationSettingsPage() {
  const { iterationId = '' } = useParams();
  const user = useCurrentPlatformUser();
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ['iteration-settings', iterationId],
    queryFn: ({ signal }) => getIterationSettings(iterationId, signal),
    enabled: Boolean(user.data?.miaodaUserId),
    refetchOnWindowFocus: false,
  });
  const [data, setData] = useState<IterationSettingsResponse | null>(null);
  const [draft, setDraft] = useState<IterationConfiguration | null>(null);
  const [tab, setTab] = useState<
    IterationWorkflowKind | 'milestones' | 'history' | 'analysis'
  >('requirement');
  const [edgeKey, setEdgeKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<IterationSettingsImpact | null>(null);
  const [sourceId, setSourceId] = useState('');
  const sourceContext = useQuery({
    queryKey: ['iteration-settings-sources'],
    queryFn: () => getRequirementEditContext(),
    enabled: Boolean(user.data?.miaodaUserId) && tab === 'history',
  });
  const [confirmReplace, setConfirmReplace] =
    useState<IterationConfiguration | null>(null);
  useEffect(() => {
    setData(settings.data || null);
    setDraft(settings.data?.draft || null);
    setImpact(null);
  }, [settings.data, iterationId]);
  const dirty =
    !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(data.draft);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    if (dirty) window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  if (
    user.isLoading ||
    (Boolean(user.data?.miaodaUserId) && settings.isLoading)
  )
    return <LoadingState />;
  if (!user.data?.miaodaUserId)
    return (
      <Card>
        <CardContent className="p-8">
          请先登录后管理迭代配置。
          <Link to="/iterations" className="ml-4 text-primary">
            返回迭代
          </Link>
        </CardContent>
      </Card>
    );
  if (settings.isError)
    return (
      <ErrorState
        message={errorMessage(settings.error)}
        onRetry={() => void settings.refetch()}
      />
    );
  if (!data || !draft) return <LoadingState />;
  const errors = iterationConfigurationErrors(draft);
  const kind: IterationWorkflowKind =
    tab === 'defect' ? 'defect' : 'requirement';
  const flow = draft.workflows[kind];
  const selectedEdge =
    flow.transitions.find((e) => `${e.from}|${e.to}` === edgeKey) ||
    flow.transitions[0];
  const changeFlow = (next: typeof flow) => {
    setDraft({ ...draft, workflows: { ...draft.workflows, [kind]: next } });
    setImpact(null);
  };
  const changeEdge = (next: IterationTransition) =>
    changeFlow({
      ...flow,
      transitions: flow.transitions.map((e) => (e === selectedEdge ? next : e)),
    });
  const save = async (publish = false) => {
    setBusy(true);
    try {
      const next = await saveIterationSettings(
        iterationId,
        { expectedRevision: data.revision, configuration: draft },
        publish,
      );
      setData(next);
      setDraft(next.draft);
      setImpact(null);
      cache.setQueryData(['iteration-settings', iterationId], next);
      if (publish) {
        void cache.invalidateQueries({ queryKey: ['workspace'] });
        void cache.invalidateQueries({ queryKey: ['workspace-summary'] });
        void cache.invalidateQueries({
          queryKey: ['requirement-edit-context'],
        });
        void cache.invalidateQueries({ queryKey: ['requirements'] });
        void cache.invalidateQueries({ queryKey: ['requirement'] });
      }
      toast.success(publish ? '配置已发布' : '草稿已保存');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    setBusy(true);
    try {
      setImpact(await validateIterationSettings(iterationId, draft));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="返回迭代">
            <Link to={`/iterations?iteration=${iterationId}`}>
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="truncate text-2xl font-semibold">
            {data.iterationName} · 迭代设置
          </h1>
          <Badge variant="secondary">
            {data.published
              ? `已发布 v${data.published.version}`
              : '沿用默认规则'}
          </Badge>
          {dirty && <Badge variant="outline">未保存</Badge>}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void settings.refetch()}
            disabled={busy || dirty}
          >
            重新加载
          </Button>
          <Button
            variant="outline"
            disabled={busy || !!errors.length}
            onClick={() => void save()}
          >
            <Save className="mr-2 size-4" />
            保存草稿
          </Button>
          <Button
            disabled={busy || !!errors.length}
            onClick={() => void preview()}
          >
            <Check className="mr-2 size-4" />
            检查并发布
          </Button>
        </div>
      </div>
      <div
        className="flex overflow-x-auto border-b"
        role="tablist"
        aria-label="迭代设置"
      >
        {[
          ['requirement', '需求工作流', GitBranch],
          ['defect', '缺陷工作流', GitBranch],
          ['milestones', '里程碑', CalendarDays],
          ['analysis', '统计口径', CalendarDays],
          ['history', '版本记录', History],
        ].map(([key, label, Icon]) => (
          <Button
            key={String(key)}
            role="tab"
            aria-selected={tab === key}
            variant="ghost"
            className={cn(
              'h-12 rounded-none border-b-2 border-transparent px-5',
              tab === key && 'border-blue-600 bg-blue-50/40 text-blue-600',
            )}
            onClick={() => {
              setTab(key as typeof tab);
              setEdgeKey('');
            }}
          >
            {typeof Icon !== 'string' && <Icon className="mr-2 size-4" />}
            {String(label)}
          </Button>
        ))}
      </div>
      {!!errors.length && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      <fieldset
        disabled={busy}
        className="min-w-0 space-y-5 disabled:opacity-60"
      >
        {tab === 'analysis' && (
          <IterationAnalysisSettings value={draft} onChange={setDraft} />
        )}
        {(tab === 'requirement' || tab === 'defect') && (
          <>
            <Card>
              <CardContent className="space-y-4 p-5">
                <h2 className="font-semibold">可用状态</h2>
                <div className="flex flex-wrap gap-2">
                  {ITERATION_STATUS_CATALOG[kind].map((status) => (
                    <label
                      key={status}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                        flow.statuses.includes(status) &&
                          'border-blue-200 bg-blue-50 text-blue-700',
                      )}
                    >
                      <Checkbox
                        checked={flow.statuses.includes(status)}
                        disabled={
                          status === ITERATION_STATUS_CATALOG[kind][0] ||
                          ['已发布', '已关闭'].includes(status)
                        }
                        onCheckedChange={(checked) =>
                          changeFlow({
                            statuses: checked
                              ? [...flow.statuses, status]
                              : flow.statuses.filter((s) => s !== status),
                            transitions: checked
                              ? flow.transitions
                              : flow.transitions.filter(
                                  (e) => e.from !== status && e.to !== status,
                                ),
                          })
                        }
                      />
                      {status}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {flow.statuses.map((status, index) => (
                    <div
                      key={status}
                      className="flex items-center gap-1 rounded-lg bg-muted/50 px-2 py-1"
                    >
                      <span className="px-1 text-sm">
                        {index + 1}. {status}
                      </span>
                      {[-1, 1].map((delta) => (
                        <Button
                          key={delta}
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={`${status}${delta < 0 ? '前移' : '后移'}`}
                          disabled={
                            index === 0 ||
                            index + delta < 1 ||
                            index + delta >= flow.statuses.length
                          }
                          onClick={() => {
                            const statuses = [...flow.statuses];
                            [statuses[index], statuses[index + delta]] = [
                              statuses[index + delta],
                              statuses[index],
                            ];
                            changeFlow({ ...flow, statuses });
                          }}
                        >
                          {delta < 0 ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <div className="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
              <Card>
                <CardContent className="space-y-3 p-4">
                  <h2 className="font-semibold">允许的流转</h2>
                  <div className="max-h-64 space-y-1 overflow-y-auto lg:max-h-[560px]">
                    {flow.transitions.map((e) => (
                      <Button
                        key={`${e.from}|${e.to}`}
                        variant="ghost"
                        className={cn(
                          'h-auto w-full justify-start py-3 text-sm',
                          e === selectedEdge && 'bg-blue-50 text-blue-700',
                        )}
                        onClick={() => setEdgeKey(`${e.from}|${e.to}`)}
                      >
                        {e.from}
                        <ArrowRight className="mx-2 size-3 shrink-0" />
                        {e.to}
                      </Button>
                    ))}
                  </div>
                  <div className="border-t pt-3">
                    <Select
                      value="__new__"
                      onValueChange={(value) => {
                        const [from, to] = value.split('|');
                        changeFlow({
                          ...flow,
                          transitions: [
                            ...flow.transitions,
                            defaultIterationTransition(from, to, kind),
                          ],
                        });
                        setEdgeKey(value);
                      }}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label="添加一条流转"
                      >
                        <SelectValue placeholder="＋ 添加一条流转" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__new__" disabled>
                          ＋ 添加一条流转
                        </SelectItem>
                        {flow.statuses.flatMap((from) =>
                          flow.statuses
                            .filter(
                              (to) =>
                                to !== from &&
                                !flow.transitions.some(
                                  (e) => e.from === from && e.to === to,
                                ),
                            )
                            .map((to) => (
                              <SelectItem
                                key={`${from}|${to}`}
                                value={`${from}|${to}`}
                              >
                                {from} → {to}
                              </SelectItem>
                            )),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
              {selectedEdge ? (
                <Card>
                  <CardContent className="space-y-6 p-6">
                    <div className="flex items-center justify-between">
                      <h2 className="flex items-center gap-3 text-lg font-semibold">
                        {selectedEdge.from}
                        <ArrowRight className="size-4 text-muted-foreground" />
                        {selectedEdge.to}
                      </h2>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除此流转"
                        onClick={() => {
                          changeFlow({
                            ...flow,
                            transitions: flow.transitions.filter(
                              (e) => e !== selectedEdge,
                            ),
                          });
                          setEdgeKey('');
                        }}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold">需要填写的内容</h3>
                      <Choices
                        labels={WORKFLOW_FIELD_LABELS}
                        selected={selectedEdge.requiredFields}
                        mandatory={['handlers']}
                        onChange={(requiredFields) =>
                          changeEdge({ ...selectedEdge, requiredFields })
                        }
                      />
                    </section>
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold">
                        预填下一步处理人
                      </h3>
                      <Select
                        value={selectedEdge.assigneeRole}
                        onValueChange={(value) =>
                          changeEdge({
                            ...selectedEdge,
                            assigneeRole:
                              value as IterationTransition['assigneeRole'],
                          })
                        }
                      >
                        <SelectTrigger className="max-w-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[
                            'handlers',
                            'developers',
                            'testers',
                            'productOwners',
                            'releaseOwners',
                          ].map((role) => (
                            <SelectItem key={role} value={role}>
                              {
                                WORKFLOW_FIELD_LABELS[
                                  role as keyof typeof WORKFLOW_FIELD_LABELS
                                ]
                              }
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </section>
                    {kind !== 'defect' && (
                      <section className="space-y-3 border-t pt-5">
                        <h3 className="text-sm font-semibold">
                          流转前必须完成的 AI 评审
                        </h3>
                        <Choices
                          labels={WORKFLOW_REVIEW_LABELS}
                          selected={selectedEdge.reviews}
                          onChange={(reviews) =>
                            changeEdge({ ...selectedEdge, reviews })
                          }
                        />
                      </section>
                    )}
                    {['待发布', '已发布'].includes(selectedEdge.to) && (
                      <section className="space-y-3 border-t pt-5">
                        <h3 className="text-sm font-semibold">发布检查</h3>
                        <Choices
                          labels={WORKFLOW_RELEASE_LABELS}
                          selected={selectedEdge.releaseChecks}
                          onChange={(releaseChecks) =>
                            changeEdge({ ...selectedEdge, releaseChecks })
                          }
                        />
                      </section>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-8 text-muted-foreground">
                    请添加允许的状态流转。
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}
        {tab === 'milestones' && (
          <Card>
            <CardContent className="space-y-5 p-6">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">迭代里程碑</h2>
                <Button
                  variant="outline"
                  disabled={draft.milestones.length >= 30}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      milestones: [
                        ...draft.milestones,
                        {
                          id: crypto.randomUUID(),
                          name: '新里程碑',
                          dueAt: null,
                        },
                      ],
                    })
                  }
                >
                  <Plus className="mr-2 size-4" />
                  添加里程碑
                </Button>
              </div>
              {draft.milestones.map((m, i) => (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border p-4"
                >
                  <span className="flex size-8 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-600">
                    {i + 1}
                  </span>
                  <Input
                    aria-label={`里程碑 ${i + 1} 名称`}
                    className="min-w-40 flex-1"
                    maxLength={80}
                    value={m.name}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        milestones: draft.milestones.map((item) =>
                          item.id === m.id
                            ? { ...item, name: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-44 justify-start">
                        <CalendarDays className="mr-2 size-4" />
                        {m.dueAt ? formatDate(m.dueAt) : '选择日期'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <Calendar
                        mode="single"
                        selected={m.dueAt ? new Date(m.dueAt) : undefined}
                        onSelect={(date) =>
                          setDraft({
                            ...draft,
                            milestones: draft.milestones.map((item) =>
                              item.id === m.id
                                ? {
                                    ...item,
                                    dueAt: date?.toISOString() || null,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        className="w-full"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            milestones: draft.milestones.map((item) =>
                              item.id === m.id
                                ? { ...item, dueAt: null }
                                : item,
                            ),
                          })
                        }
                      >
                        清空日期
                      </Button>
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除里程碑 ${m.name}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        milestones: draft.milestones.filter(
                          (item) => item.id !== m.id,
                        ),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {tab === 'history' && (
          <Card>
            <CardContent className="space-y-5 p-6">
              <h2 className="font-semibold">发布记录</h2>
              {!data.history.length && (
                <p className="text-sm text-muted-foreground">
                  尚未发布自定义配置
                </p>
              )}
              {[...data.history].reverse().map((version) => (
                <div
                  key={version.version}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">v{version.version}</Badge>
                    <span className="text-sm">
                      {version.publishedBy} ·{' '}
                      {new Date(version.publishedAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmReplace(version.configuration)}
                  >
                    恢复为草稿
                  </Button>
                </div>
              ))}
              <div className="space-y-3 border-t pt-5">
                <h3 className="text-sm font-semibold">
                  复制其他迭代的已发布配置
                </h3>
                <div className="flex gap-3">
                  <Select
                    value={sourceId || '__source__'}
                    onValueChange={setSourceId}
                  >
                    <SelectTrigger aria-label="来源迭代">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__source__" disabled>
                        选择来源迭代
                      </SelectItem>
                      {(sourceContext.data?.iterations || [])
                        .filter((item) => item.id !== iterationId)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    disabled={!sourceId.trim()}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const source = await getIterationSettings(
                          sourceId.trim(),
                        );
                        if (!source.published)
                          throw new Error('来源迭代尚未发布配置');
                        setConfirmReplace(source.published.configuration);
                      } catch (error) {
                        toast.error(errorMessage(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    读取配置
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </fieldset>
      <Dialog
        open={!!impact}
        onOpenChange={(open) => {
          if (!open && !busy) setImpact(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {impact?.valid ? '确认发布迭代配置' : '配置暂不可发布'}
            </DialogTitle>
            <DialogDescription>
              发布仅改变本迭代的规则与里程碑，不自动改变需求状态，也不发送通知。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>影响范围：{impact?.requirementCount} 项需求</p>
            {impact?.changes.map((change) => (
              <p key={change}>{change}</p>
            ))}
            {impact?.errors.map((error) => (
              <p key={error} className="text-destructive">
                {error}
              </p>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setImpact(null)}
            >
              返回编辑
            </Button>
            <Button
              disabled={busy || !impact?.valid}
              onClick={() => void save(true)}
            >
              确认发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirmReplace}
        onOpenChange={(open) => {
          if (!open) setConfirmReplace(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>替换当前草稿？</DialogTitle>
            <DialogDescription>
              当前未保存内容将被替换。恢复后仍需检查并发布，不会立即改变生效规则。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReplace(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setDraft(confirmReplace);
                setConfirmReplace(null);
                setImpact(null);
                toast.success('已载入草稿');
              }}
            >
              替换草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
