import type {
  RequirementPatch,
  RequirementSummary,
} from '@shared/api.interface';
import {
  employeeUserIds,
  employeeUsers,
  sameEmployeeUsers,
} from './personnel-users';
import {
  dateInputToTimestamp,
  editorHtml,
  toDateInput,
} from './requirement-utils';

export function ticketEditInitialState(requirement: RequirementSummary) {
  return {
    title: requirement.title,
    introduction: editorHtml(requirement.introduction),
    latestProgress: requirement.latestProgress,
    priority: requirement.priority,
    project: requirement.project,
    deadline: toDateInput(requirement.deadlineAt),
    handlers: employeeUsers(
      requirement.personnelUserIds.handlers,
      requirement.handlers,
    ),
  };
}

type TicketEditState = ReturnType<typeof ticketEditInitialState>;

/** Write only visible changed fields; hidden legacy data and exact dates survive. */
export function ticketEditPatch(
  original: RequirementSummary,
  baseline: TicketEditState,
  form: TicketEditState,
): RequirementPatch {
  const patch: RequirementPatch = {};
  for (const key of [
    'title',
    'introduction',
    'latestProgress',
    'priority',
    'project',
  ] as const) {
    if (form[key] !== baseline[key]) patch[key] = form[key];
  }
  if (form.deadline !== baseline.deadline)
    patch.deadlineAt = dateInputToTimestamp(form.deadline);
  if (!sameEmployeeUsers(form.handlers, baseline.handlers)) {
    patch.handlerLarkUserIds = employeeUserIds(form.handlers);
    if (original.status === '待分派' && form.handlers.length)
      patch.status = '处理中';
  }
  return patch;
}
