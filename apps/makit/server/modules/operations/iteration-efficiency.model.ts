import type { RequirementSummary } from '@shared/api.interface';
import type {
  IterationAnalysisConfiguration,
  IterationEfficiencyRequirement,
} from '@shared/operations-insights.interface';
import type { IterationConfiguration } from '@shared/iteration-workflow';
import { WORKFLOW_FIELD_LABELS } from '@shared/iteration-workflow';
import {
  ANALYSIS_STAGE_LABELS,
  analysisElapsedMs,
  defaultIterationAnalysis,
} from '@shared/iteration-analysis';
import { insightDate, plainObject } from './operations-insights.model';

export interface EfficiencyEvent {
  id: string;
  operationId: string | null;
  requirementId: string;
  at: string;
  workflowVersion: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
export interface StageSample {
  kind: 'requirement' | 'defect';
  stage: string;
  hours: number;
  requirementId: string;
}
const normalizeStatus = (value: unknown): string => String(value || '');
const roundHours = (ms: number): number => Number((ms / 3_600_000).toFixed(2));
function blockedElapsed(
  events: EfficiencyEvent[],
  start: number,
  end: number,
  analysis: IterationAnalysisConfiguration,
): number {
  if (!analysis.excludeBlockedTime)
    return analysisElapsedMs(start, end, analysis.clock);
  let cursor = start,
    total = 0,
    blocked = false;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (at <= start) {
      blocked = event.after.blocked === true;
      continue;
    }
    if (at >= end) break;
    if (!blocked) total += analysisElapsedMs(cursor, at, analysis.clock);
    cursor = at;
    blocked = event.after.blocked === true;
  }
  if (!blocked) total += analysisElapsedMs(cursor, end, analysis.clock);
  return total;
}

export function requirementEfficiency(
  requirement: RequirementSummary,
  events: EfficiencyEvent[],
  config: IterationConfiguration,
  history: Map<number, IterationConfiguration>,
  availableArtifacts: Set<string>,
  now: number,
  iterationId?: string,
): { requirement: IterationEfficiencyRequirement; samples: StageSample[] } {
  const kind = requirement.type === '缺陷' ? 'defect' : 'requirement',
    analysis = config.analysis || defaultIterationAnalysis(config),
    current = analysis.statuses[kind].find(
      (item) => item.status === requirement.status,
    );
  const ordered = [...events].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    ),
    transitions = ordered.filter(
      (event) =>
        normalizeStatus(event.before.status) !==
        normalizeStatus(event.after.status),
    );
  const metadata = (event: EfficiencyEvent, statusName: string) => {
    const version = event.workflowVersion
      ? Number(event.workflowVersion.split(':').at(-1))
      : NaN;
    const workflow = plainObject(event.before.workflow);
    // Version numbers are scoped to an iteration, never globally unique.
    const historical =
      !iterationId || workflow.iterationId === iterationId
        ? history.get(version)
        : undefined;
    // Unknown historical rules must not be rewritten using today's mapping.
    const mapping = historical
      ? historical.analysis || defaultIterationAnalysis(historical)
      : null;
    return {
      item: mapping?.statuses[kind].find((item) => item.status === statusName),
      analysis: mapping || analysis,
      known: Boolean(mapping),
    };
  };
  const samples: StageSample[] = [];
  let enteredAt: string | null = null,
    knownStatus = '',
    phaseEntry: EfficiencyEvent | null = null,
    phaseStage = '',
    returns = 0,
    reopens = 0;
  for (const event of transitions) {
    const before = normalizeStatus(event.before.status),
      after = normalizeStatus(event.after.status),
      from = metadata(event, before).item,
      to = metadata(event, after);
    const gap = knownStatus && before !== knownStatus;
    if (gap || !to.known) phaseEntry = null;
    if (phaseEntry && phaseStage !== to.item?.stage) {
      const phaseAnalysis = metadata(
        phaseEntry,
        normalizeStatus(phaseEntry.after.status),
      ).analysis;
      samples.push({
        kind,
        stage: phaseStage,
        hours: roundHours(
          blockedElapsed(
            ordered,
            Date.parse(phaseEntry.at),
            Date.parse(event.at),
            phaseAnalysis,
          ),
        ),
        requirementId: requirement.id,
      });
      phaseEntry = null;
    }
    if (
      to.item &&
      !to.item.terminal &&
      (!from || from.stage !== to.item.stage)
    ) {
      phaseEntry = event;
      phaseStage = to.item.stage;
    }
    if (
      from &&
      to.item &&
      ['testing', 'experience'].includes(from.stage) &&
      to.item.stage === 'development'
    )
      returns++;
    if ((from?.terminal && !to.item?.terminal) || after === '重新打开')
      reopens++;
    knownStatus = after;
    enteredAt = to.known ? event.at : null;
  }
  if (knownStatus !== requirement.status) enteredAt = null;
  const flow = config.workflows[kind],
    position = flow.statuses.indexOf(requirement.status);
  const edge =
    flow.transitions.find(
      (item) =>
        item.from === requirement.status &&
        flow.statuses.indexOf(item.to) > position,
    ) || flow.transitions.find((item) => item.from === requirement.status);
  const missingFields: string[] = [];
  if (edge && !current?.terminal)
    for (const field of edge.requiredFields) {
      if (field === 'technical_design' || field === 'self_test_report') {
        if (
          !availableArtifacts.has(field) &&
          !(field === 'self_test_report' && requirement.selfTestReport?.trim())
        )
          missingFields.push(WORKFLOW_FIELD_LABELS[field]);
        continue;
      }
      const raw = (requirement as unknown as Record<string, unknown>)[field];
      const empty = Array.isArray(raw)
        ? !raw.length
        : typeof raw === 'string'
          ? !raw
              .replace(/<[^>]*>/gu, '')
              .replace(/&nbsp;/gu, ' ')
              .trim()
          : raw === null || raw === undefined;
      if (empty) missingFields.push(WORKFLOW_FIELD_LABELS[field]);
    }
  const milestoneRisks: string[] = [];
  for (const milestone of config.milestones) {
    const gate = analysis.milestoneGates[milestone.id],
      targetId =
        kind === 'defect' ? gate?.defectStatusId : gate?.requirementStatusId;
    if (!targetId || current?.terminal) continue;
    const reached =
      current?.id === targetId ||
      transitions.some(
        (event) =>
          metadata(event, normalizeStatus(event.after.status)).item?.id ===
          targetId,
      );
    if (reached) continue;
    if (milestone.dueAt && Date.parse(milestone.dueAt) < now)
      milestoneRisks.push(`${milestone.name}：目标达成未确认`);
    else if (requirement.blocked)
      milestoneRisks.push(`${milestone.name}：存在阻塞`);
  }
  const completed = transitions
    .filter(
      (event) =>
        metadata(event, normalizeStatus(event.after.status)).item?.terminal,
    )
    .at(-1);
  return {
    requirement: {
      id: requirement.id,
      code: requirement.code,
      title: requirement.title,
      kind,
      status: requirement.status,
      stage: current?.stage || 'unknown',
      enteredAt,
      dwellHours:
        enteredAt && !current?.terminal
          ? roundHours(
              blockedElapsed(ordered, Date.parse(enteredAt), now, analysis),
            )
          : null,
      waitingFor: current?.terminal
        ? []
        : requirement.handlers.map((person) => person.name),
      missingFields,
      blocked: requirement.blocked,
      blockingRequirementIds: [],
      milestoneRisks,
      returns,
      reopens,
      deadline: insightDate(requirement.deadlineAt),
      completedAt: current?.terminal ? completed?.at || null : null,
      sourceEventIds: transitions.map((event) => event.id),
      operationIds: [
        ...new Set(
          transitions
            .map((event) => event.operationId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
      historyComplete:
        !!transitions[0] &&
        !normalizeStatus(transitions[0].before.status) &&
        transitions.every(
          (event) => metadata(event, normalizeStatus(event.after.status)).known,
        ) &&
        knownStatus === requirement.status &&
        !gapInHistory(transitions),
    },
    samples,
  };
}
function gapInHistory(events: EfficiencyEvent[]): boolean {
  return events.some(
    (event, index) =>
      index > 0 &&
      normalizeStatus(event.before.status) !==
        normalizeStatus(events[index - 1].after.status),
  );
}
export function efficiencySnapshot(value: unknown): Record<string, unknown> {
  try {
    return plainObject(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    return {};
  }
}
export { ANALYSIS_STAGE_LABELS };
