import type {
  RequirementSummary,
  WorkspaceStats,
  RequirementPeopleOptions,
  PersonRef,
} from './api.interface';
import { requirementComplete, requirementInProgress } from './ticket-workflow';
export function requirementListStats(
  requirements: RequirementSummary[],
): WorkspaceStats {
  return {
    total: requirements.length,
    mine: requirements.filter(
      (item: RequirementSummary): boolean => item.isMine,
    ).length,
    inProgress: requirements.filter((item: RequirementSummary): boolean =>
      requirementInProgress(item),
    ).length,
    blocked: requirements.filter(
      (item: RequirementSummary): boolean => item.blocked,
    ).length,
    overdue: requirements.filter((item: RequirementSummary): boolean =>
      item.risks.some((risk: string): boolean => risk.includes('逾期')),
    ).length,
    completed: requirements.filter((item: RequirementSummary): boolean =>
      requirementComplete(item),
    ).length,
  };
}

export function requirementListPeopleOptions(
  requirements: RequirementSummary[],
): RequirementPeopleOptions {
  const collect = (
    field: 'handlers' | 'productOwners' | 'developers' | 'testers' | 'foOwners',
  ): PersonRef[] => {
    const values: Map<string, PersonRef> = new Map<string, PersonRef>();
    requirements.forEach((requirement: RequirementSummary): void => {
      requirement[field].forEach((person: PersonRef): void => {
        if (!person.id) return;
        values.set(person.id, {
          id: person.id,
          name: person.name || '成员',
          avatarUrl: person.avatarUrl,
        });
      });
    });
    return [...values.values()].sort(
      (left: PersonRef, right: PersonRef): number =>
        left.name.localeCompare(right.name, 'zh-CN'),
    );
  };
  return {
    handlers: collect('handlers'),
    productOwners: collect('productOwners'),
    developers: collect('developers'),
    testers: collect('testers'),
    foOwners: collect('foOwners'),
  };
}

export function requirementIntroductionPreview(html: string): string {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gsu, ' ')
    .replace(/<script[^>]*>.*?<\/script>/gsu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}
