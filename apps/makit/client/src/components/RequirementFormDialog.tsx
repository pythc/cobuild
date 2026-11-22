import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  RequirementCreateInput,
  RequirementPatch,
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { RequirementContentEditor } from '@/components/RequirementContentEditor';
import SingleIterationSelect from '@/components/SingleIterationSelect';
import { iterationAssignmentError } from '@shared/iteration-assignment';
import { UserSelect } from '@/components/business-ui/user-select';
import type { User } from '@/components/business-ui/types/user';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, plainText } from '@/lib/requirement-utils';
import {
  employeePersonRefs,
  employeeUserIds,
  employeeUsers,
  mergeEmployeeUsers,
  sameEmployeeUsers,
} from '@/lib/personnel-users';
import {
  useCreateRequirement,
  useUpdateRequirement,
} from '@/hooks/use-workspace';
import TicketFormDialog from './TicketFormDialog';

type PersonField =
  | 'handlerLarkUserIds'
  | 'productOwnerLarkUserIds'
  | 'developerLarkUserIds'
  | 'testerLarkUserIds'
  | 'foOwnerLarkUserIds'
  | 'followerLarkUserIds'
  | 'releaseOwnerLarkUserIds';

type ScalarFormField = Exclude<keyof FormState, PersonField>;

interface FormState {
  title: string;
  introduction: string;
  acceptanceCriteria: string;
  selfTestReport: string;
  gitBranchName: string;
  githubPullRequestUrl: string;
  type: string;
  source: string;
  status: string;
  priority: string;
  project: string;
  iterationIds: string[];
  effort: string;
  latestProgress: string;
  blocked: boolean;
  blocker: string;
  handlerLarkUserIds: User[];
  productOwnerLarkUserIds: User[];
  developerLarkUserIds: User[];
  testerLarkUserIds: User[];
  foOwnerLarkUserIds: User[];
  followerLarkUserIds: User[];
  releaseOwnerLarkUserIds: User[];
}

const PERSON_FIELDS: Array<{
  key: PersonField;
  label: string;
}> = [
  { key: 'handlerLarkUserIds', label: '当前处理人' },
  { key: 'productOwnerLarkUserIds', label: '产品人员' },
  { key: 'developerLarkUserIds', label: '研发人员' },
  { key: 'testerLarkUserIds', label: '测试人员' },
  { key: 'foOwnerLarkUserIds', label: 'FO' },
  { key: 'releaseOwnerLarkUserIds', label: '发布负责人' },
  { key: 'followerLarkUserIds', label: '关注人' },
];

const SCALAR_FORM_FIELDS: ScalarFormField[] = [
  'title',
  'introduction',
  'acceptanceCriteria',
  'selfTestReport',
  'gitBranchName',
  'githubPullRequestUrl',
  'type',
  'source',
  'status',
  'priority',
  'project',
  'iterationIds',
  'effort',
  'latestProgress',
  'blocked',
  'blocker',
];

function sameFormValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    );
  }
  return left === right;
}

function initialState(
  workspace: Pick<WorkspaceResponse, 'iterations' | 'options'>,
  requirement?: RequirementSummary,
): FormState {
  return {
    title: requirement?.title || '',
    introduction: requirement?.introduction || '',
    acceptanceCriteria: requirement?.acceptanceCriteria || '',
    selfTestReport: requirement?.selfTestReport || '',
    gitBranchName: requirement?.gitBranchName || '',
    githubPullRequestUrl: requirement?.githubPullRequestUrl || '',
    type:
      requirement?.type === '未设置'
        ? ''
        : requirement?.type || workspace.options.types[0] || '',
    source:
      requirement?.source === '未设置'
        ? ''
        : requirement?.source || workspace.options.sources[0] || '',
    status:
      requirement?.status ||
      (workspace.options.statuses.includes('新')
        ? '新'
        : workspace.options.statuses[0]) ||
      '新',
    priority:
      requirement?.priority === '未设置'
        ? ''
        : requirement?.priority ||
          (workspace.options.priorities.includes('P2')
            ? 'P2'
            : workspace.options.priorities[0]) ||
          'P2',
    project:
      requirement?.project === '未设置' ? '' : requirement?.project || '',
    iterationIds: requirement?.iterationIds || [],
    effort: requirement?.effort == null ? '' : String(requirement.effort),
    latestProgress: requirement?.latestProgress || '',
    blocked: requirement?.blocked || false,
    blocker: requirement?.blocker || '',
    handlerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.handlers || [],
      requirement?.handlers || [],
    ),
    productOwnerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.productOwners || [],
      requirement?.productOwners || [],
    ),
    developerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.developers || [],
      requirement?.developers || [],
    ),
    testerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.testers || [],
      requirement?.testers || [],
    ),
    foOwnerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.foOwners || [],
      requirement?.foOwners || [],
    ),
    followerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.followers || [],
      requirement?.followers || [],
    ),
    releaseOwnerLarkUserIds: employeeUsers(
      requirement?.personnelUserIds.releaseOwners || [],
      requirement?.releaseOwners || [],
    ),
  };
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Label className="text-xs font-medium text-muted-foreground">
      {children}
    </Label>
  );
}

function DeferredIntroductionEditor({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const frame: number = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-56 w-full items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        正在加载编辑器
      </div>
    );
  }

  return (
    <RequirementContentEditor
      value={value}
      onValueChange={onValueChange}
      placeholder="填写背景与目标、用户场景、方案说明及边界"
      className="min-h-56 max-h-[420px] w-full"
    />
  );
}

export default function RequirementFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Pick<WorkspaceResponse, 'iterations' | 'options'>;
  requirement?: RequirementSummary;
}) {
  return props.requirement?.type === '工单' ? (
    <TicketFormDialog {...props} requirement={props.requirement} />
  ) : (
    <StandardRequirementFormDialog {...props} />
  );
}

function StandardRequirementFormDialog({
  open,
  onOpenChange,
  workspace,
  requirement,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Pick<WorkspaceResponse, 'iterations' | 'options'>;
  requirement?: RequirementSummary;
}) {
  const baseline = useMemo(
    () => initialState(workspace, requirement),
    [requirement, workspace],
  );
  const [form, setForm] = useState<FormState>(() => baseline);
  const [introductionEditing, setIntroductionEditing] = useState(
    () => !requirement,
  );
  const [showFullForm, setShowFullForm] = useState(Boolean(requirement));
  const createMutation = useCreateRequirement();
  const updateMutation = useUpdateRequirement();
  const editing = Boolean(requirement);
  const saving = createMutation.isPending;
  const editingSession = useRef<string | null>(null);

  useEffect((): void => {
    if (!open) { editingSession.current = null; return; }
    const session = requirement?.id || 'new';
    // A background workspace refresh must not clear text being typed into an
    // open editor. Initialize only when opening or switching to another record.
    if (editingSession.current === session) return;
    editingSession.current = session;
    setForm(baseline);
    setIntroductionEditing(!requirement);
    setShowFullForm(Boolean(requirement));
  }, [baseline, open, requirement]);

  const statusOptions = useMemo(
    () =>
      editing && requirement
        ? [requirement.status]
        : workspace.options.statuses.filter((status) =>
            form.type === '缺陷'
              ? ['新建', '处理中', '已解决', '已验证', '已关闭'].includes(
                  status,
                )
              : ![
                  '新建',
                  '处理中',
                  '已解决',
                  '已验证',
                  '已关闭',
                  '重新打开',
                  '已拒绝',
                ].includes(status),
          ),
    [editing, form.type, requirement, workspace.options.statuses],
  );

  const set = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const optionList = (values: string[], fallback: string[]): string[] =>
    values.length ? values : fallback;

  const buildPatch = (): RequirementPatch => {
    const fullPatch: RequirementPatch = {
      title: form.title,
      introduction: form.introduction,
      acceptanceCriteria: form.acceptanceCriteria,
      selfTestReport: form.selfTestReport,
      gitBranchName: form.gitBranchName,
      githubPullRequestUrl: form.githubPullRequestUrl,
      type: form.type,
      source: form.source,
      status: form.status,
      priority: form.priority,
      project: form.project,
      iterationIds: form.iterationIds,
      effort: form.effort.trim() ? Number(form.effort) : null,
      latestProgress: form.latestProgress,
      blocked: form.blocked,
      blocker: form.blocked ? form.blocker : '',
    };
    const patch: RequirementPatch = editing
      ? (Object.fromEntries(
          SCALAR_FORM_FIELDS.filter(
            (key: ScalarFormField): boolean =>
              !sameFormValue(form[key], baseline[key]),
          ).map((key: ScalarFormField): [string, unknown] => [
            key,
            fullPatch[key as keyof RequirementPatch],
          ]),
        ) as RequirementPatch)
      : fullPatch;
    PERSON_FIELDS.forEach(({ key }) => {
      if (!editing || !sameEmployeeUsers(form[key], baseline[key])) {
        patch[key] = employeeUserIds(form[key]);
      }
    });
    return patch;
  };

  const buildOptimisticRequirement = (): Partial<RequirementSummary> => ({
    iterationNames: workspace.iterations
      .filter((iteration) => form.iterationIds.includes(iteration.id))
      .map((iteration) => iteration.name),
    handlers: employeePersonRefs(form.handlerLarkUserIds),
    productOwners: employeePersonRefs(form.productOwnerLarkUserIds),
    developers: employeePersonRefs(form.developerLarkUserIds),
    testers: employeePersonRefs(form.testerLarkUserIds),
    foOwners: employeePersonRefs(form.foOwnerLarkUserIds),
    followers: employeePersonRefs(form.followerLarkUserIds),
    releaseOwners: employeePersonRefs(form.releaseOwnerLarkUserIds),
    ...(requirement
      ? {
          personnelUserIds: {
            ...requirement.personnelUserIds,
            handlers: employeeUserIds(form.handlerLarkUserIds),
            productOwners: employeeUserIds(form.productOwnerLarkUserIds),
            developers: employeeUserIds(form.developerLarkUserIds),
            testers: employeeUserIds(form.testerLarkUserIds),
            foOwners: employeeUserIds(form.foOwnerLarkUserIds),
            followers: employeeUserIds(form.followerLarkUserIds),
            releaseOwners: employeeUserIds(form.releaseOwnerLarkUserIds),
          },
        }
      : {}),
  });

  const submit = async (): Promise<void> => {
    const iterationError = iterationAssignmentError(form.iterationIds);
    if (iterationError) {
      toast.error(iterationError);
      return;
    }
    if (!form.title.trim()) {
      toast.error('请填写需求标题');
      return;
    }
    const patch = buildPatch();
    if (requirement && !Object.keys(patch).length) {
      toast.info('没有实际变更');
      return;
    }
    if (requirement) {
      onOpenChange(false);
      toast.success('已修改');
      void updateMutation
        .mutateAsync({
          recordId: requirement.id,
          input: {
            expectedUpdatedAt: requirement.updatedAt,
            patch,
          },
          optimistic: buildOptimisticRequirement(),
        })
        .catch((error: unknown): void => {
          toast.error(errorMessage(error));
        });
      return;
    }
    try {
      const result = await createMutation.mutateAsync(
        patch as RequirementCreateInput,
      );
      toast.success(result.message);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0">
        <DialogHeader className="z-10 border-b bg-background px-4 py-4 pr-12 sm:px-6 sm:py-5">
          <DialogTitle>{editing ? '编辑需求' : '创建需求'}</DialogTitle>
          <DialogDescription>
            {editing
              ? '仅保存实际发生变化的字段，协作通知由当前安全策略统一控制。'
              : '创建后直接写入需求表，协作通知由当前安全策略统一控制。'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto bg-muted/20 px-3 py-4 sm:space-y-5 sm:px-6 sm:py-5">
          {!editing ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3">
              <div>
                <p className="text-sm font-medium">
                  {showFullForm ? '完整需求' : '快速创建'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {showFullForm
                    ? '填写需求定义、排期和全部协作角色。'
                    : '先记录标题、归属和当前处理人，其余信息可后续完善。'}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowFullForm((current: boolean) => !current)}
              >
                {showFullForm ? '收起非必填字段' : '完善更多信息'}
                <ChevronDown
                  className={showFullForm ? 'size-4 rotate-180' : 'size-4'}
                />
              </Button>
            </div>
          ) : null}
          <section className="space-y-4 rounded-xl border bg-background p-4 sm:p-5">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
                01 · 需求定义
              </p>
              <h3 className="mt-1 text-sm font-semibold">
                说明要解决的问题与完成标准
              </h3>
            </div>
            <div className="grid gap-4 md:grid-cols-12">
              <div className="space-y-2 md:col-span-8">
                <FieldLabel>需求标题 *</FieldLabel>
                <Input
                  value={form.title}
                  onChange={(event) => set('title', event.target.value)}
                  placeholder="用一句话说明用户问题与预期结果"
                  maxLength={500}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <FieldLabel>需求类型</FieldLabel>
                <Select
                  value={form.type}
                  onValueChange={(value) => {
                    setForm((current) => ({
                      ...current,
                      type: value,
                      status: value === '缺陷' ? '新建' : '新',
                    }));
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {optionList(workspace.options.types, [
                      '产品需求',
                      '技术需求',
                      '体验优化',
                    ]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <FieldLabel>优先级</FieldLabel>
                <Select
                  value={form.priority}
                  onValueChange={(value) => set('priority', value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {optionList(workspace.options.priorities, [
                      'P0',
                      'P1',
                      'P2',
                      'P3',
                    ]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {showFullForm ? (
              <div className="space-y-2">
                <FieldLabel>需求介绍</FieldLabel>
                {introductionEditing ? (
                  <DeferredIntroductionEditor
                    key={requirement?.id || 'new'}
                    value={form.introduction}
                    onValueChange={(value) => set('introduction', value)}
                  />
                ) : (
                  <button
                    type="button"
                    className="min-h-28 w-full rounded-md border bg-muted/15 p-4 text-left text-sm leading-6 transition-colors hover:border-primary/35 hover:bg-muted/30"
                    onClick={() => setIntroductionEditing(true)}
                  >
                    <span className="line-clamp-4 text-muted-foreground">
                      {plainText(form.introduction) || '尚未填写需求介绍'}
                    </span>
                    <span className="mt-3 block text-xs font-medium text-primary">
                      点击加载并编辑需求介绍
                    </span>
                  </button>
                )}
              </div>
            ) : null}

            {showFullForm ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel>验收标准</FieldLabel>
                  <Textarea
                    value={form.acceptanceCriteria}
                    onChange={(event) =>
                      set('acceptanceCriteria', event.target.value)
                    }
                    placeholder="逐条描述可验证的完成条件"
                    className="min-h-28"
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel>最新进展</FieldLabel>
                  <Textarea
                    value={form.latestProgress}
                    onChange={(event) =>
                      set('latestProgress', event.target.value)
                    }
                    placeholder="当前结论、下一步和需要协同的事项"
                    className="min-h-28"
                  />
                </div>
              </div>
            ) : null}
            {showFullForm ? (
              <div className="space-y-2">
                <FieldLabel>自测报告</FieldLabel>
                <Textarea
                  value={form.selfTestReport}
                  onChange={(event) =>
                    set('selfTestReport', event.target.value)
                  }
                  placeholder="开发提测时必填：覆盖范围、验证结果、遗留风险和相关链接"
                  className="min-h-24"
                />
              </div>
            ) : null}
          </section>

          <section className="space-y-4 rounded-xl border bg-background p-4 sm:p-5">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
                02 · 规划与范围
              </p>
              <h3 className="mt-1 text-sm font-semibold">
                明确归属、排期与交付边界
              </h3>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {showFullForm ? (
                <div className="space-y-2">
                  <FieldLabel>状态</FieldLabel>
                  <Select
                    value={form.status}
                    onValueChange={(value) => set('status', value)}
                    disabled
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-2">
                <FieldLabel>所属项目</FieldLabel>
                <Select
                  value={form.project}
                  onValueChange={(value) => set('project', value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {optionList(workspace.options.projects, ['未设置']).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              {showFullForm ? (
                <div className="space-y-2">
                  <FieldLabel>需求来源</FieldLabel>
                  <Select
                    value={form.source}
                    onValueChange={(value) => set('source', value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {optionList(workspace.options.sources, [
                        '内部规划',
                        '用户反馈',
                        '稳定性治理',
                      ]).map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {showFullForm ? (
                <div className="space-y-2">
                  <FieldLabel>开发工作量（自然日）</FieldLabel>
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={form.effort}
                    onChange={(event) => set('effort', event.target.value)}
                    placeholder="例如 2.5 天"
                  />
                </div>
              ) : null}
              {showFullForm ? (
                <div className="space-y-2 sm:col-span-2">
                  <FieldLabel>Git 分支名称</FieldLabel>
                  <Input
                    value={form.gitBranchName}
                    onChange={(event) =>
                      set('gitBranchName', event.target.value)
                    }
                    placeholder="dev/zhoucanyu/feature_coding"
                    maxLength={500}
                  />
                </div>
              ) : null}
              {showFullForm ? (
                <div className="space-y-2 sm:col-span-2">
                  <FieldLabel>GitHub 合并请求链接</FieldLabel>
                  <Input
                    value={form.githubPullRequestUrl}
                    onChange={(event) =>
                      set('githubPullRequestUrl', event.target.value)
                    }
                    placeholder="https://github.com/组织/仓库/pull/123"
                    maxLength={1000}
                  />
                </div>
              ) : null}
              <div className="space-y-2 sm:col-span-2">
                <FieldLabel>所属迭代</FieldLabel>
                <SingleIterationSelect
                  value={form.iterationIds}
                  options={workspace.iterations.map((iteration) => ({
                    value: iteration.id,
                    label: iteration.name,
                  }))}
                  onChange={(ids) => set('iterationIds', ids)}
                />
              </div>
            </div>

          </section>

          <section className="space-y-4 rounded-xl border bg-background p-4 sm:p-5">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
                03 · 协作成员
              </p>
              <h3 className="mt-1 text-sm font-semibold">
                分配各阶段的直接责任人
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                已选成员以标签展示，可直接点击成员右侧的 × 逐个移除。
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {PERSON_FIELDS.filter(
                ({ key }): boolean =>
                  showFullForm || key === 'handlerLarkUserIds',
              ).map(({ key, label }) => (
                <div key={key} className="space-y-2">
                  <FieldLabel>{label}</FieldLabel>
                  <UserSelect
                    multiple
                    valueType="object"
                    accountType="lark"
                    value={form[key]}
                    onChange={(value) => set(key, value || [])}
                    onSelect={(selected) => {
                      if (!selected.raw?.employee_id) return;
                      set(key, mergeEmployeeUsers(form[key], [selected.raw]));
                    }}
                    closeOnSelect
                    placeholder="搜索并选择成员"
                    tagClosable
                    className="w-full"
                  />
                </div>
              ))}
            </div>
          </section>

          {showFullForm ? (
            <section className="space-y-3 rounded-xl border bg-background p-4 sm:p-5">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={form.blocked}
                  onCheckedChange={(checked) =>
                    set('blocked', checked === true)
                  }
                />
                标记为阻塞
              </label>
              {form.blocked ? (
                <Textarea
                  value={form.blocker}
                  onChange={(event) => set('blocker', event.target.value)}
                  placeholder="说明阻塞原因、依赖方和解除条件"
                />
              ) : null}
            </section>
          ) : null}
        </div>

        <DialogFooter className="border-t bg-background px-4 py-3 max-sm:flex-row sm:px-6 sm:py-4">
          <Button
            variant="outline"
            className="max-sm:flex-1"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            className="max-sm:flex-1"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {editing ? '保存变更' : '创建需求'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
