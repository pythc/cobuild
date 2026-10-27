import type { RequirementSummary } from '@shared/api.interface';
import {
  defaultIterationTransition,
  WORKFLOW_FIELD_LABELS,
  WORKFLOW_REVIEW_LABELS,
  type WorkflowRequiredField,
} from '@shared/iteration-workflow';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';
import { nextStatus, plainText } from '@/lib/requirement-utils';

export default function RequirementNextAction({
  requirement,
  onAdvance,
  onLocate,
}: {
  requirement: RequirementSummary;
  onAdvance: () => void;
  onLocate: (field: WorkflowRequiredField) => void;
}) {
  const next = nextStatus(requirement);
  const edge = next
    ? requirement.workflow?.transitions.find(
        (item) => item.from === requirement.status && item.to === next,
      ) ||
      defaultIterationTransition(
        requirement.status,
        next,
        requirement.type === '缺陷' ? 'defect' : 'requirement',
      )
    : null;
  const needsEngineering = Boolean(
    edge?.reviews.length ||
    edge?.requiredFields.some((field) =>
      ['technical_design', 'self_test_report'].includes(field),
    ),
  );
  const engineering = useRequirementEngineering(
    requirement.id,
    needsEngineering && requirement.type !== '缺陷',
  );
  if (!next || !edge || !requirement.capabilities.canUpdate) return null;
  const missing = edge.requiredFields.filter((field) => {
    if (field === 'technical_design' || field === 'self_test_report')
      return engineering.data
        ? !engineering.data.artifacts[field]?.readable
        : false;
    const value = requirement[field];
    return Array.isArray(value)
      ? !value.length
      : !plainText(String(value || '')).trim();
  });
  const reviewIssues = edge.reviews.filter((kind) => {
    const review = engineering.data?.reviews[kind];
    return (
      review &&
      (!review.current ||
        (!review.overridden &&
          (review.status !== 'completed' || review.verdict === 'blocked')))
    );
  });
  return (
    <section className="rounded-xl border border-primary/15 bg-primary/[0.035] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">下一步</span>
          <ArrowRight className="size-3.5 text-primary" />
          <span>{next}</span>
        </div>
        <Button size="sm" variant="outline" onClick={onAdvance}>
          准备流转
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
      {missing.length || reviewIssues.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {missing.map((field) => (
            <Button
              key={field}
              variant="ghost"
              size="sm"
              className="h-7 border border-amber-200 bg-amber-50 px-2 text-xs text-amber-800"
              onClick={() => onLocate(field)}
            >
              补充{WORKFLOW_FIELD_LABELS[field]}
            </Button>
          ))}
          {reviewIssues.map((kind) => (
            <Button
              key={kind}
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-amber-800"
              onClick={() =>
                onLocate(
                  kind === 'clarity'
                    ? 'introduction'
                    : kind === 'technical_stability'
                      ? 'technical_design'
                      : 'self_test_report',
                )
              }
            >
              {WORKFLOW_REVIEW_LABELS[kind]}待处理
            </Button>
          ))}
        </div>
      ) : engineering.isError ? (
        <p className="mt-2 text-xs text-amber-800">
          研发资料暂不可用，流转前仍将重新校验。
        </p>
      ) : needsEngineering && !engineering.data ? (
        <p className="mt-2 text-xs text-muted-foreground">正在核对所需资料</p>
      ) : (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          已填写必要资料，流转时仍将检查当前规则。
        </p>
      )}
    </section>
  );
}
