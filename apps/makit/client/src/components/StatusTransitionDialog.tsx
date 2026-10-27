import { useEffect, useRef, useState } from 'react';
import type {
  RequirementAiReviewSummary,
  RequirementPatch,
  RequirementReleaseReadiness,
  RequirementSummary,
} from '@shared/api.interface';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { getPullRequestDetail, getRequirementReleaseReadiness } from '@/api';
import { UserSelect } from '@/components/business-ui/user-select';
import type { User } from '@/components/business-ui/types/user';
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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateRequirement } from '@/hooks/use-workspace';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';
import {
  errorMessage,
  nextStatus,
  plainText,
  STATUS_STYLES,
} from '@/lib/requirement-utils';
import {
  employeePersonRefs,
  employeeUserIds,
  employeeUsers,
  mergeEmployeeUsers,
  sameEmployeeUsers,
} from '@/lib/personnel-users';
import { cn } from '@/lib/utils';
import MaterialTemplateButton from './MaterialTemplateButton';
import { isOnlyMaterialTemplate } from '@shared/material-templates';
import ConfiguredStatusTransitionDialog, {
  type StatusTransitionProps,
} from './ConfiguredStatusTransitionDialog';
import TicketStatusTransitionDialog from './TicketStatusTransitionDialog';

export default function StatusTransitionDialog(props: StatusTransitionProps) {
  if (props.requirement.type === '工单') {
    return <TicketStatusTransitionDialog {...props} />;
  }
  return props.requirement.workflow ? (
    <ConfiguredStatusTransitionDialog {...props} />
  ) : (
    <LegacyStatusTransitionDialog {...props} />
  );
}

function MemberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: User[];
  onChange: (value: User[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">
        {label} *
      </Label>
      <UserSelect
        multiple
        valueType="object"
        accountType="lark"
        value={value}
        onChange={(next) => onChange(next || [])}
        onSelect={(selected) => {
          if (!selected.raw?.employee_id) return;
          onChange(mergeEmployeeUsers(value, [selected.raw]));
        }}
        closeOnSelect
        placeholder={`选择${label}`}
        tagClosable
        className="w-full"
      />
    </div>
  );
}

function suggestedHandlers(
  requirement: RequirementSummary,
  target: string,
): User[] {
  if (requirement.type === '缺陷') {
    if (['已解决', '已验证'].includes(target)) {
      return employeeUsers(
        requirement.personnelUserIds.testers,
        requirement.testers,
      );
    }
    return employeeUsers(
      requirement.personnelUserIds.handlers,
      requirement.handlers,
    );
  }
  if (target === '开发中') {
    return employeeUsers(
      requirement.personnelUserIds.developers,
      requirement.developers,
    );
  }
  if (['开发转测试', '测试中'].includes(target)) {
    return employeeUsers(
      requirement.personnelUserIds.testers,
      requirement.testers,
    );
  }
  if (['新', '需求已评审', '产品体验中'].includes(target)) {
    return employeeUsers(
      requirement.personnelUserIds.productOwners,
      requirement.productOwners,
    );
  }
  if (['待发布', '已发布'].includes(target)) {
    return employeeUsers(
      requirement.personnelUserIds.releaseOwners,
      requirement.releaseOwners,
    );
  }
  return employeeUsers(
    requirement.personnelUserIds.handlers,
    requirement.handlers,
  );
}

function userLabel(user: User): string {
  if (typeof user.name === 'string') return user.name;
  return user.name?.zh_cn || user.name?.en_us || '成员';
}

function parseGitHubPullRequestUrl(value: string): {
  repository: string;
  pullNumber: number;
} | null {
  const match: RegExpMatchArray | null = value
    .trim()
    .match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/iu,
    );
  if (!match) return null;
  return {
    repository: match[1],
    pullNumber: Number(match[2]),
  };
}

function LegacyStatusTransitionDialog({
  open,
  onOpenChange,
  requirement,
  initialTarget,
  onOpenEngineering,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirement: RequirementSummary;
  initialTarget?: string;
  onOpenEngineering?: () => void;
}) {
  const targets = requirement.allowedStatuses.filter(
    (status) => status !== requirement.status,
  );
  const preferredTarget = nextStatus(requirement);
  const defaultTarget =
    initialTarget && targets.includes(initialTarget)
      ? initialTarget
      : preferredTarget && targets.includes(preferredTarget)
        ? preferredTarget
        : targets[0] || '';
  const [target, setTarget] = useState(defaultTarget);
  const [handlers, setHandlers] = useState<User[]>([]);
  const [developers, setDevelopers] = useState<User[]>([]);
  const [testers, setTesters] = useState<User[]>([]);
  const [productOwners, setProductOwners] = useState<User[]>([]);
  const [releaseOwners, setReleaseOwners] = useState<User[]>([]);
  const [defectCause, setDefectCause] = useState('');
  const [note, setNote] = useState('');
  const [githubPullRequestUrl, setGithubPullRequestUrl] = useState('');
  const [resolvingPullRequest, setResolvingPullRequest] = useState(false);
  const initializedRequirementId = useRef<string | null>(null);
  const updateMutation = useUpdateRequirement();

  useEffect(() => {
    if (!open) {
      initializedRequirementId.current = null;
      return;
    }
    if (initializedRequirementId.current === requirement.id) return;
    initializedRequirementId.current = requirement.id;
    setTarget(defaultTarget);
    const nextHandlers: User[] = suggestedHandlers(requirement, defaultTarget);
    setHandlers(
      nextHandlers.length
        ? nextHandlers
        : employeeUsers(
            requirement.personnelUserIds.handlers,
            requirement.handlers,
          ),
    );
    setDevelopers(
      employeeUsers(
        requirement.personnelUserIds.developers,
        requirement.developers,
      ),
    );
    setTesters(
      employeeUsers(requirement.personnelUserIds.testers, requirement.testers),
    );
    setProductOwners(
      employeeUsers(
        requirement.personnelUserIds.productOwners,
        requirement.productOwners,
      ),
    );
    setReleaseOwners(
      employeeUsers(
        requirement.personnelUserIds.releaseOwners,
        requirement.releaseOwners,
      ),
    );
    setDefectCause(requirement.defectCause);
    setNote('');
    setGithubPullRequestUrl(requirement.githubPullRequestUrl);
    setResolvingPullRequest(false);
  }, [defaultTarget, open, requirement]);

  const defect = requirement.type === '缺陷';
  const needsDefinition = !defect && target === '需求已评审';
  const needsDeveloper = !defect && target === '开发中';
  const needsTechnicalReview = !defect && target === '开发中';
  const needsTester =
    (!defect && ['开发转测试', '测试中'].includes(target)) ||
    (defect && target === '已验证');
  const needsProduct = !defect && target === '产品体验中';
  const needsRelease = !defect && ['待发布', '已发布'].includes(target);
  const readinessQuery = useQuery<RequirementReleaseReadiness>({
    queryKey: ['requirement-release-readiness', requirement.id, target],
    queryFn: ({ signal }) =>
      getRequirementReleaseReadiness(
        requirement.id,
        target as '待发布' | '已发布',
        signal,
      ),
    enabled: open && needsRelease,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const needsDefectCause = defect && target === '已解决';
  const needsDeliveryReview = !defect && target === '开发转测试';
  const needsAiGate =
    needsDefinition || needsTechnicalReview || needsDeliveryReview;
  const engineeringQuery = useRequirementEngineering(
    requirement.id,
    open && needsAiGate,
  );
  const gateType = needsDefinition
    ? 'clarity'
    : needsTechnicalReview
      ? 'technical_stability'
      : 'delivery_readiness';
  const gateReview: RequirementAiReviewSummary | null = needsAiGate
    ? engineeringQuery.data?.reviews[gateType] || null
    : null;
  const gateArtifact = needsTechnicalReview
    ? engineeringQuery.data?.artifacts.technical_design
    : needsDeliveryReview
      ? engineeringQuery.data?.artifacts.self_test_report
      : null;
  const gateReady = Boolean(
    gateReview?.current &&
    gateReview.status === 'completed' &&
    (gateReview.verdict !== 'blocked' || gateReview.overridden),
  );
  const needsNote = ['已拒绝', '重新打开'].includes(target) || (requirement.type === '工单' && ['已解决', '已关闭'].includes(target));
  const readinessChecks = (readinessQuery.data?.checks || []).map((check) =>
    check.key === 'release_owners' && releaseOwners.length
      ? {
          ...check,
          passed: true,
          detail: `已设置 ${releaseOwners.length} 人`,
        }
      : check,
  );
  const readinessBlockingReasons = readinessChecks
    .filter((check) => check.blocking && !check.passed)
    .map((check) => `${check.label}：${check.detail}`);
  const releaseReady =
    !needsRelease ||
    Boolean(
      readinessQuery.data &&
      !readinessQuery.isError &&
      readinessBlockingReasons.length === 0,
    );

  const submit = async (): Promise<void> => {
    if (!target) return;
    if (!handlers.length && !(requirement.type === '工单' && ['待分派','已关闭'].includes(target))) {
      toast.error('请先设置当前处理人');
      return;
    }
    if (needsDeveloper && !developers.length) {
      toast.error('请设置研发人员');
      return;
    }
    if (needsTester && !testers.length) {
      toast.error('请设置测试人员');
      return;
    }
    if (needsProduct && !productOwners.length) {
      toast.error('请设置产品人员');
      return;
    }
    if (needsRelease && !releaseOwners.length) {
      toast.error('请设置发布负责人');
      return;
    }
    if (needsRelease && readinessQuery.isFetching) {
      toast.error('正在检查发布就绪状态，请稍候');
      return;
    }
    if (needsRelease && readinessQuery.isError) {
      toast.error('发布就绪检查失败，请重试');
      void readinessQuery.refetch();
      return;
    }
    if (needsRelease && !readinessQuery.data) {
      toast.error('发布就绪检查尚未完成，请稍候');
      return;
    }
    if (needsRelease && !releaseReady) {
      toast.error(
        `发布就绪检查未通过：${readinessBlockingReasons
          .slice(0, 3)
          .join('、')}${readinessBlockingReasons.length > 3 ? '等' : ''}`,
      );
      return;
    }
    if (
      needsDefinition &&
      (!plainText(requirement.introduction) ||
        !plainText(requirement.acceptanceCriteria))
    ) {
      toast.error('完成评审前请填写需求介绍和验收标准');
      return;
    }
    if (needsDefectCause && (!defectCause.trim() || isOnlyMaterialTemplate(defectCause, 'defect_cause'))) {
      toast.error('流转到“已解决”时请填写缺陷原因');
      return;
    }
    if (needsAiGate && engineeringQuery.isFetching) {
      toast.error('正在读取 AI 评审结果，请稍候');
      return;
    }
    if (needsAiGate && !gateReady) {
      toast.error(
        needsDefinition
          ? '需求清晰度评审尚未通过'
          : needsTechnicalReview
            ? '技术与稳定性评审尚未通过'
            : '交付准备评审尚未通过',
      );
      return;
    }
    const parsedPullRequest =
      !defect && target === '开发转测试'
        ? parseGitHubPullRequestUrl(githubPullRequestUrl)
        : null;
    if (!defect && target === '开发转测试' && !parsedPullRequest) {
      toast.error('请填写完整的 GitHub 合并请求链接');
      return;
    }
    if (needsNote && !note.trim()) {
      toast.error(`流转到“${target}”时请填写处理说明`);
      return;
    }
    const patch: RequirementPatch = { status: target };
    const currentHandlers = employeeUsers(
      requirement.personnelUserIds.handlers,
      requirement.handlers,
    );
    const currentDevelopers = employeeUsers(
      requirement.personnelUserIds.developers,
      requirement.developers,
    );
    const currentTesters = employeeUsers(
      requirement.personnelUserIds.testers,
      requirement.testers,
    );
    const currentProductOwners = employeeUsers(
      requirement.personnelUserIds.productOwners,
      requirement.productOwners,
    );
    const currentReleaseOwners = employeeUsers(
      requirement.personnelUserIds.releaseOwners,
      requirement.releaseOwners,
    );
    if (!sameEmployeeUsers(handlers, currentHandlers)) {
      patch.handlerLarkUserIds = employeeUserIds(handlers);
    }
    if (!sameEmployeeUsers(developers, currentDevelopers)) {
      patch.developerLarkUserIds = employeeUserIds(developers);
    }
    if (!sameEmployeeUsers(testers, currentTesters)) {
      patch.testerLarkUserIds = employeeUserIds(testers);
    }
    if (!sameEmployeeUsers(productOwners, currentProductOwners)) {
      patch.productOwnerLarkUserIds = employeeUserIds(productOwners);
    }
    if (!sameEmployeeUsers(releaseOwners, currentReleaseOwners)) {
      patch.releaseOwnerLarkUserIds = employeeUserIds(releaseOwners);
    }
    if (needsDefectCause && defectCause !== requirement.defectCause) {
      patch.defectCause = defectCause;
    }
    if (needsNote) patch.latestProgress = note;
    if (parsedPullRequest) {
      try {
        setResolvingPullRequest(true);
        const detail = await getPullRequestDetail(parsedPullRequest.pullNumber);
        if (
          detail.pullRequest.repository.toLowerCase() !==
          parsedPullRequest.repository.toLowerCase()
        ) {
          toast.error('该链接不属于当前需求平台配置的 GitHub 仓库');
          return;
        }
        patch.gitBranchName = detail.pullRequest.headRef;
        patch.githubPullRequestUrl = detail.pullRequest.url;
      } catch (error) {
        toast.error(errorMessage(error));
        return;
      } finally {
        setResolvingPullRequest(false);
      }
    }
    onOpenChange(false);
    toast.success('已修改');
    void updateMutation
      .mutateAsync({
        recordId: requirement.id,
        input: {
          expectedUpdatedAt: requirement.updatedAt,
          intent: 'status-transition',
          patch,
        },
        optimistic: {
          handlers: employeePersonRefs(handlers),
          developers: employeePersonRefs(developers),
          testers: employeePersonRefs(testers),
          productOwners: employeePersonRefs(productOwners),
          releaseOwners: employeePersonRefs(releaseOwners),
          personnelUserIds: {
            ...requirement.personnelUserIds,
            handlers: employeeUserIds(handlers),
            developers: employeeUserIds(developers),
            testers: employeeUserIds(testers),
            productOwners: employeeUserIds(productOwners),
            releaseOwners: employeeUserIds(releaseOwners),
          },
        },
      })
      .catch((error: unknown): void => {
        toast.error(errorMessage(error));
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>流转需求状态</DialogTitle>
          <DialogDescription>
            每次流转必须有当前处理人；系统会按目标阶段检查必要角色和交付物。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[210px_minmax(0,1fr)]">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              目标状态
            </p>
            {targets.map((status) => (
              <Button
                key={status}
                type="button"
                variant={target === status ? 'default' : 'outline'}
                className="w-full justify-between"
                onClick={() => {
                  setTarget(status);
                  if (requirement.type === '工单' && status === '待分派') { setHandlers([]); return; }
                  const nextHandlers: User[] = suggestedHandlers(
                    requirement,
                    status,
                  );
                  if (nextHandlers.length) setHandlers(nextHandlers);
                }}
              >
                {status}
                <ArrowRight className="size-3.5" />
              </Button>
            ))}
            {!targets.length ? (
              <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                当前状态没有可执行的后续流转。
              </p>
            ) : null}
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-sm">
              <Badge
                variant="outline"
                className={cn(STATUS_STYLES[requirement.status])}
              >
                {requirement.status}
              </Badge>
              <ArrowRight className="size-4 text-muted-foreground" />
              <Badge variant="outline" className={cn(STATUS_STYLES[target])}>
                {target || '请选择'}
              </Badge>
            </div>
            <MemberField
              label="当前处理人"
              value={handlers}
              onChange={setHandlers}
            />
            <div className="rounded-lg border bg-muted/20 p-3 text-xs">
              <p className="font-medium text-foreground">交接预览</p>
              <p className="mt-1 text-muted-foreground">
                当前处理人将交接给
                {handlers.length
                  ? `：${handlers.map(userLabel).join('、')}`
                  : '未设置人员'}
                。已启用的飞书工作流会据此通知相关成员和绑定群聊。
              </p>
            </div>
            {needsDeveloper ? (
              <MemberField
                label="研发人员"
                value={developers}
                onChange={setDevelopers}
              />
            ) : null}
            {needsTester ? (
              <MemberField
                label="测试人员"
                value={testers}
                onChange={setTesters}
              />
            ) : null}
            {needsProduct ? (
              <MemberField
                label="产品人员"
                value={productOwners}
                onChange={setProductOwners}
              />
            ) : null}
            {needsRelease ? (
              <>
                <MemberField
                  label="发布负责人"
                  value={releaseOwners}
                  onChange={setReleaseOwners}
                />
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">发布就绪检查</p>
                    {readinessQuery.isFetching ? (
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    ) : releaseReady ? (
                      <span className="text-xs font-medium text-emerald-700">
                        已就绪
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-amber-700">
                        存在阻塞项
                      </span>
                    )}
                  </div>
                  {readinessQuery.isError ? (
                    <p className="mt-2 text-xs text-destructive">
                      {errorMessage(readinessQuery.error)}
                    </p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {readinessChecks.map((check) => (
                        <div
                          key={check.key}
                          className="flex items-start gap-2 text-xs"
                        >
                          {check.passed ? (
                            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                          )}
                          <span>
                            <span className="font-medium">{check.label}</span>
                            <span className="text-muted-foreground">
                              {' '}
                              · {check.detail}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    确认时会结合本窗口的人员变更重新检查。
                  </p>
                </div>
              </>
            ) : null}
            {needsAiGate ? (
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    {needsDefinition
                      ? '需求清晰度评审'
                      : needsTechnicalReview
                        ? '技术与稳定性评审'
                        : '交付准备评审'}
                  </p>
                  {engineeringQuery.isFetching ? (
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  ) : gateReady ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
                      <CheckCircle2 className="size-3.5" />
                      已就绪
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium text-amber-700">
                      <CircleAlert className="size-3.5" />
                      尚未就绪
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {needsDefinition
                    ? '需求介绍和验收标准必须已填写，且当前版本的清晰度评审不能存在阻断项。'
                    : needsTechnicalReview
                      ? '请先在“研发资料”中添加技术方案并完成技术与稳定性评审。'
                      : '请先在“研发资料”中添加自测报告并完成交付准备评审。'}
                </p>
                {gateReview?.status === 'completed' && gateReview.current ? (
                  <p className="mt-2 text-xs">
                    当前结果：{gateReview.score ?? 0} 分
                    {gateReview.overridden ? ' · 已风险放行' : ''}
                  </p>
                ) : null}
                {gateArtifact && !gateArtifact.readable ? (
                  <p className="mt-2 text-xs text-destructive">
                    {gateArtifact.errorMessage}
                  </p>
                ) : null}
                {onOpenEngineering && !needsDefinition ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-auto px-0"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenEngineering();
                    }}
                  >
                    前往研发资料
                  </Button>
                ) : null}
              </div>
            ) : null}
            {needsDefectCause ? (
              <>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    缺陷原因 *
                  </Label>
                  <div className="flex justify-end"><MaterialTemplateButton kind="defect_cause" value={defectCause} onChange={setDefectCause} html={false} /></div>
                  <Textarea
                    value={defectCause}
                    onChange={(event) => setDefectCause(event.target.value)}
                    placeholder="说明问题根因、触发条件和修复方式"
                    className="min-h-28"
                  />
                </div>
              </>
            ) : null}
            {needsDeliveryReview ? (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  GitHub 合并请求链接 *
                </Label>
                <Input
                  value={githubPullRequestUrl}
                  onChange={(event) =>
                    setGithubPullRequestUrl(event.target.value)
                  }
                  placeholder="https://github.com/组织/仓库/pull/123"
                />
                <p className="text-[11px] text-muted-foreground">
                  校验通过后会自动写入对应分支，并同步到合并请求页面。
                </p>
              </div>
            ) : null}
            {needsNote ? (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  处理说明 *
                </Label>
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="说明原因、结论和下一步"
                  className="min-h-24"
                />
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              !target ||
              resolvingPullRequest ||
              (needsRelease && readinessQuery.isFetching)
            }
          >
            {resolvingPullRequest ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : null}
            确认流转
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
