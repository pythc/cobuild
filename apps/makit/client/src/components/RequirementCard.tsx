import type { RequirementSummary } from '@shared/api.interface';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  MessageSquareMore,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { getLightRequirementDetail } from '@/hooks/use-lazy-requirement-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  formatDate,
  nextStatus,
  plainText,
  PRIORITY_STYLES,
  STATUS_STYLES,
} from '@/lib/requirement-utils';
import PersonStack from './PersonStack';
import QuickPersonnelEditor from './QuickPersonnelEditor';
import RequirementTypeBadge from './RequirementTypeBadge';

export default function RequirementCard({
  requirement,
  compact = false,
  onAdvance,
  advancing = false,
  showPersonnel = false,
  returnTo,
}: {
  requirement: RequirementSummary;
  compact?: boolean;
  onAdvance?: (requirement: RequirementSummary) => void;
  advancing?: boolean;
  showPersonnel?: boolean;
  returnTo?: string;
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const detailReturnTo = returnTo || `${location.pathname}${location.search}`;
  const next = nextStatus(requirement);
  const intro = requirement.introductionPreview ?? plainText(requirement.introduction);
  return (
    <Card
      className={cn(
        'group relative overflow-hidden border-border/75 bg-card/95 transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-[0_18px_38px_-28px_hsl(221_83%_53%_/_0.58)]',
        requirement.blocked && 'border-destructive/40',
      )}
    >
      <div className={cn('p-4', compact && 'p-3')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <RequirementTypeBadge
                type={requirement.type}
                className="h-5 rounded px-1.5 text-[10px]"
              />
              <Badge
                variant="outline"
                className={cn(
                  'h-5 rounded px-1.5 text-[10px]',
                  PRIORITY_STYLES[requirement.priority],
                )}
              >
                {requirement.priority}
              </Badge>
              {requirement.blocked ? (
                <Badge
                  variant="outline"
                  className="h-5 rounded border-destructive/25 bg-destructive/5 px-1.5 text-[10px] text-destructive"
                >
                  <AlertTriangle className="size-3" />
                  阻塞
                </Badge>
              ) : null}
            </div>
            <Link
              to={`/requirements/${requirement.id}`}
              state={{ requirementReturnTo: detailReturnTo }}
              onMouseEnter={() => {
                void queryClient.prefetchQuery({
                  queryKey: ['requirement', requirement.id],
                  queryFn: ({ signal }) =>
                    getLightRequirementDetail(requirement.id, signal),
                  staleTime: 30_000,
                });
              }}
              className="line-clamp-2 text-sm font-semibold leading-5 hover:text-primary"
            >
              {requirement.title}
            </Link>
            {!compact && intro ? (
              <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {intro}
              </p>
            ) : null}
          </div>
          <Badge
            variant="outline"
            className={cn(
              'shrink-0 whitespace-nowrap',
              STATUS_STYLES[requirement.status],
            )}
          >
            {requirement.status}
          </Badge>
        </div>

        {showPersonnel ? (
          <div className="mt-3 grid gap-x-3 gap-y-1 border-t pt-3 sm:grid-cols-2">
            {[
              ['handlers', '处理人', requirement.handlers],
              ['productOwners', '产品', requirement.productOwners],
              ['developers', '研发', requirement.developers],
              ['testers', '测试', requirement.testers],
              ['foOwners', 'FO', requirement.foOwners],
            ].map(([role, label, people]) => (
              <div
                key={String(role)}
                className="grid min-w-0 grid-cols-[38px_minmax(0,1fr)] items-center text-xs"
              >
                <span className="text-muted-foreground">{String(label)}</span>
                <QuickPersonnelEditor
                  requirementId={requirement.id}
                  role={
                    role as
                      | 'handlers'
                      | 'productOwners'
                      | 'developers'
                      | 'testers'
                      | 'foOwners'
                  }
                  people={people as RequirementSummary['handlers']}
                  compact
                  editable={requirement.capabilities.canUpdate}
                />
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <PersonStack people={requirement.handlers} max={2} />
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {requirement.groupChatId ? (
              <span
                className="inline-flex items-center gap-1"
                title="已建立需求群"
              >
                <MessageSquareMore className="size-3.5" />
                已建群
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3.5" />
              {requirement.type === '工单' ? formatDate(requirement.deadlineAt) : requirement.effort == null ? '未设置工作量' : `开发 ${requirement.effort} 天`}
            </span>
          </div>
        </div>

        {onAdvance && next && requirement.capabilities.canUpdate ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 w-full justify-between px-2 text-xs text-muted-foreground hover:text-primary"
            onClick={() => onAdvance(requirement)}
            disabled={advancing}
          >
            推进至 {next}
            <ArrowRight className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
