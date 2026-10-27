import { useEffect, useRef, useState } from 'react';
import type {
  RequirementPatch,
  RequirementSummary,
} from '@shared/api.interface';
import {
  WORKFLOW_FIELD_LABELS,
  WORKFLOW_REVIEW_LABELS,
  type WorkflowAssigneeRole,
  type WorkflowRequiredField,
} from '@shared/iteration-workflow';
import { ArrowRight, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { getRequirementReleaseReadiness } from '@/api';
import { UserSelect } from '@/components/business-ui/user-select';
import type { User } from '@/components/business-ui/types/user';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TiptapEditorComplete } from '@/components/business-ui/tiptap-editor';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useUpdateRequirement } from '@/hooks/use-workspace';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';
import {
  employeeUsers,
  employeeUserIds,
  employeePersonRefs,
  mergeEmployeeUsers,
  sameEmployeeUsers,
} from '@/lib/personnel-users';
import { errorMessage, plainText, nextStatus } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';
import MaterialTemplateButton from './MaterialTemplateButton';
import { isOnlyMaterialTemplate } from '@shared/material-templates';

export interface StatusTransitionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirement: RequirementSummary;
  initialTarget?: string;
  onOpenEngineering?: () => void;
  initialFocusField?: WorkflowRequiredField;
}
const memberPatch = {
  handlers: 'handlerLarkUserIds',
  developers: 'developerLarkUserIds',
  testers: 'testerLarkUserIds',
  productOwners: 'productOwnerLarkUserIds',
  releaseOwners: 'releaseOwnerLarkUserIds',
} as const;

export default function ConfiguredStatusTransitionDialog({
  open,
  onOpenChange,
  requirement,
  initialTarget,
  onOpenEngineering,
  initialFocusField,
}: StatusTransitionProps) {
  const edges = requirement
    .workflow!.transitions.filter((e) => e.from === requirement.status)
    .sort(
      (left, right) =>
        requirement.workflow!.statuses.indexOf(left.to) -
        requirement.workflow!.statuses.indexOf(right.to),
    );
  const [target, setTarget] = useState(initialTarget || edges[0]?.to || '');
  const edge = edges.find((e) => e.to === target) || edges[0];
  const [members, setMembers] = useState<
    Partial<Record<WorkflowAssigneeRole, User[]>>
  >({});
  const [text, setText] = useState<Record<string, string>>({});
  const initialized = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !initialFocusField) return;
    const timer = window.setTimeout(() => {
      const field = contentRef.current?.querySelector<HTMLElement>(`[data-workflow-field="${initialFocusField}"]`);
      field?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      field?.querySelector<HTMLElement>('input,textarea,button,[contenteditable="true"]')?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open, initialFocusField]);
  const mutation = useUpdateRequirement();
  const fields = edge?.requiredFields || [];
  const engineering = useRequirementEngineering(
    requirement.id,
    open &&
      (fields.includes('technical_design') ||
        fields.includes('self_test_report') ||
        !!edge?.reviews.length),
  );
  const readiness = useQuery({
    queryKey: [
      'requirement-release-readiness',
      requirement.id,
      edge?.to,
      requirement.workflow?.version,
      requirement.updatedAt,
    ],
    queryFn: ({ signal }) =>
      getRequirementReleaseReadiness(
        requirement.id,
        edge!.to as '待发布' | '已发布',
        signal,
      ),
    enabled: open && !!edge?.releaseChecks.length,
    refetchOnWindowFocus: false,
  });
  // The server returns only checks enabled by the published transition.
  // Account for personnel supplied in this dialog, not just persisted fields.
  const readinessChecks = (readiness.data?.checks || []).map((check) => {
    const role =
      check.key === 'release_owners'
        ? 'releaseOwners'
        : check.key === 'testers'
          ? 'testers'
          : null;
    if (!role || !fields.includes(role)) return check;
    const count = members[role]?.length || 0;
    return {
      ...check,
      passed: count > 0,
      detail: count ? `已设置 ${count} 人` : '尚未设置',
    };
  });
  const blockingChecks = readinessChecks.filter(
    (check) => check.blocking && !check.passed,
  );
  const existingMembers = (role: WorkflowAssigneeRole) =>
    employeeUsers(requirement.personnelUserIds[role], requirement[role]);
  const prefill = (to: string) => {
    const role = edges.find((e) => e.to === to)?.assigneeRole || 'handlers';
    const proposed = existingMembers(role);
    setMembers((previous) => ({
      ...previous,
      handlers: proposed.length ? proposed : existingMembers('handlers'),
    }));
  };
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    const to = edges.some((e) => e.to === initialTarget)
      ? initialTarget!
      : nextStatus(requirement) || edges[0]?.to || '';
    setTarget(to);
    const initialMembers: Partial<Record<WorkflowAssigneeRole, User[]>> = {};
    for (const role of Object.keys(memberPatch) as WorkflowAssigneeRole[])
      initialMembers[role] = existingMembers(role);
    const role = edges.find((e) => e.to === to)?.assigneeRole || 'handlers';
    if (initialMembers[role]?.length)
      initialMembers.handlers = initialMembers[role];
    setMembers(initialMembers);
    setText(
      Object.fromEntries(
        [
          'introduction',
          'acceptanceCriteria',
          'githubPullRequestUrl',
          'gitBranchName',
          'defectCause',
          'latestProgress',
        ].map((key) => [
          key,
          String(requirement[key as keyof RequirementSummary] || ''),
        ]),
      ),
    );
  }, [open, requirement.id]);
  const submit = () => {
    if (!edge) return;
    const patch: RequirementPatch = { status: edge.to };
    const optimistic: Partial<RequirementSummary> = {};
    for (const field of fields) {
      if (field in memberPatch) {
        const role = field as WorkflowAssigneeRole;
        const selected = members[role] || [];
        if (!selected.length) {
          toast.error(`请设置${WORKFLOW_FIELD_LABELS[field]}`);
          return;
        }
        if (!sameEmployeeUsers(selected, existingMembers(role))) {
          patch[memberPatch[role]] = employeeUserIds(selected);
          optimistic[role] = employeePersonRefs(selected);
          optimistic.personnelUserIds = {
            ...(optimistic.personnelUserIds || requirement.personnelUserIds),
            [role]: employeeUserIds(selected),
          };
        }
      } else if (field === 'technical_design' || field === 'self_test_report') {
        const artifact = engineering.data?.artifacts[field];
        if (!artifact?.readable) {
          toast.error(`请先上传可读取的${WORKFLOW_FIELD_LABELS[field]}`);
          return;
        }
      } else {
        const content = text[field] || '';
        if (!plainText(content).trim() || field === 'defectCause' && isOnlyMaterialTemplate(content, 'defect_cause')) {
          toast.error(`请填写${WORKFLOW_FIELD_LABELS[field]}`);
          return;
        }
        if (content !== requirement[field]) patch[field] = content;
      }
    }
    for (const kind of edge.reviews) {
      const review = engineering.data?.reviews[kind];
      if (
        !review?.current ||
        (!review.overridden &&
          (review.status !== 'completed' || review.verdict === 'blocked'))
      ) {
        toast.error(`请先完成${WORKFLOW_REVIEW_LABELS[kind]}`);
        return;
      }
    }
    if (edge.releaseChecks.length) {
      if (readiness.isError) {
        toast.error('发布检查失败，请重试');
        void readiness.refetch();
        return;
      }
      if (readiness.isFetching || !readiness.data) {
        toast.error('发布检查尚未完成，请稍候');
        return;
      }
      if (blockingChecks.length) {
        toast.error(
          `发布检查未通过：${blockingChecks
            .slice(0, 3)
            .map((check) => `${check.label}：${check.detail}`)
            .join('；')}${blockingChecks.length > 3 ? '等' : ''}`,
        );
        return;
      }
    }
    onOpenChange(false);
    toast.success('已修改');
    void mutation
      .mutateAsync({
        recordId: requirement.id,
        input: {
          expectedUpdatedAt: requirement.updatedAt,
          intent: 'status-transition',
          patch,
        },
        optimistic,
      })
      .catch((error) => toast.error(errorMessage(error)));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>流转需求状态</DialogTitle>
          <DialogDescription className="sr-only">
            按当前迭代已发布的流转规则填写资料
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[190px_minmax(0,1fr)]">
          <div className="space-y-2">
            {edges.map((e) => (
              <Button
                key={e.to}
                variant={e === edge ? 'default' : 'outline'}
                className="h-12 w-full justify-between"
                onClick={() => {
                  setTarget(e.to);
                  prefill(e.to);
                }}
              >
                {e.to}
                <ArrowRight className="size-4" />
              </Button>
            ))}
            {!edges.length && (
              <p className="text-sm text-muted-foreground">没有可用的流转</p>
            )}
          </div>
          {edge && (
            <div className="space-y-5 rounded-xl border p-5">
              <div className="flex items-center gap-3 font-medium">
                <span>{requirement.status}</span>
                <ArrowRight className="size-4 text-muted-foreground" />
                <span className="text-blue-600">{edge.to}</span>
              </div>
              {fields.map((field) => (
                <div key={field} data-workflow-field={field} className="space-y-2">
                  <Label>{WORKFLOW_FIELD_LABELS[field]} *</Label>
                  {field === 'defectCause' ? <div className="flex justify-end"><MaterialTemplateButton kind="defect_cause" value={text[field] || ''} onChange={(value) => setText((current) => ({ ...current, [field]: value }))} html={false} /></div> : null}
                  {field in memberPatch ? (
                    <UserSelect
                      multiple
                      valueType="object"
                      accountType="lark"
                      value={members[field as WorkflowAssigneeRole] || []}
                      onChange={(value) =>
                        setMembers((previous) => ({
                          ...previous,
                          [field]: value || [],
                        }))
                      }
                      onSelect={(selected) => {
                        if (selected.raw?.employee_id)
                          setMembers((previous) => ({
                            ...previous,
                            [field]: mergeEmployeeUsers(
                              previous[field as WorkflowAssigneeRole] || [],
                              [selected.raw!],
                            ),
                          }));
                      }}
                      closeOnSelect
                      tagClosable
                      className="w-full"
                    />
                  ) : field === 'technical_design' ||
                    field === 'self_test_report' ? (
                    <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3 text-sm">
                      <span
                        className={cn(
                          !engineering.data?.artifacts[field]?.readable &&
                            'text-amber-700',
                        )}
                      >
                        {engineering.isLoading
                          ? '读取资料…'
                          : engineering.data?.artifacts[field]?.readable
                            ? '资料已就绪'
                            : '尚未提供可读取的资料'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onOpenChange(false);
                          onOpenEngineering?.();
                        }}
                      >
                        <FileText className="mr-1 size-4" />
                        查看资料
                      </Button>
                    </div>
                  ) : ['githubPullRequestUrl', 'gitBranchName'].includes(
                      field,
                    ) ? (
                    <Input
                      value={text[field] || ''}
                      onChange={(e) =>
                        setText((previous) => ({
                          ...previous,
                          [field]: e.target.value,
                        }))
                      }
                    />
                  ) : field === 'introduction' ? (
                    <TiptapEditorComplete
                      value={text[field] || ''}
                      onValueChange={(value) =>
                        setText((previous) => ({ ...previous, [field]: value }))
                      }
                      className="min-h-48 max-h-96"
                    />
                  ) : (
                    <Textarea
                      rows={4}
                      value={text[field] || ''}
                      onChange={(e) =>
                        setText((previous) => ({
                          ...previous,
                          [field]: e.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              ))}
              {!!edge.reviews.length && (
                <div className="space-y-2 border-t pt-4">
                  {edge.reviews.map((kind) => (
                    <div key={kind} className="flex justify-between text-sm">
                      <span>{WORKFLOW_REVIEW_LABELS[kind]}</span>
                      <span>
                        {engineering.data?.reviews[kind]?.overridden
                          ? '已风险放行'
                          : engineering.data?.reviews[kind]?.current &&
                              engineering.data.reviews[kind]?.status ===
                                'completed' &&
                              engineering.data.reviews[kind]?.verdict !==
                                'blocked'
                            ? '已完成'
                            : '待完成'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {!!edge.releaseChecks.length && (
                <div className="space-y-2 border-t pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">发布检查</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readiness.isFetching}
                      onClick={() => void readiness.refetch()}
                    >
                      重新检查
                    </Button>
                  </div>
                  {readiness.isFetching && (
                    <p role="status" className="text-sm text-muted-foreground">
                      正在检查发布条件…
                    </p>
                  )}
                  {readiness.isError && (
                    <p role="alert" className="text-sm text-destructive">
                      发布检查失败：{errorMessage(readiness.error)}
                    </p>
                  )}
                  {readinessChecks.map((check) => (
                    <p
                      key={check.key}
                      className={cn(
                        'text-sm',
                        check.passed ? 'text-green-700' : 'text-amber-700',
                      )}
                    >
                      {check.passed ? '✓' : '○'} {check.label}
                      {!check.passed && (
                        <span className="ml-2">{check.detail}</span>
                      )}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={
              !edge ||
              mutation.isPending ||
              (!!edge.releaseChecks.length && readiness.isFetching)
            }
            onClick={submit}
          >
            确认流转
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
