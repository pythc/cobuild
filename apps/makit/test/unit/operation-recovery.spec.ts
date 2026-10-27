import type {
  OperationRecord,
  RequirementUpdateJobSummary,
} from '@shared/api.interface';
import { OperationRecoveryTracker } from '../../client/src/lib/operation-recovery';
import {
  operationPage,
  operationStatus,
  operationTime,
} from '../../client/src/pages/OperationsPage/operations-presentation';

function job(
  id: string,
  status: RequirementUpdateJobSummary['status'],
  requirementId = 'test-requirement',
): RequirementUpdateJobSummary {
  return {
    id,
    status,
    requirementId,
    attempts: 1,
    result: null,
    errorMessage: '',
    createdAt: null,
    finishedAt: null,
  };
}

describe('operation recovery', () => {
  it('restores observed pending work and invalidates once on a terminal result', () => {
    const tracker = new OperationRecoveryTracker();
    expect(tracker.observe([job('a', 'queued')])).toEqual([]);
    expect(tracker.observe([job('a', 'running')])).toEqual([]);
    expect(tracker.observe([job('a', 'succeeded')])).toEqual([
      'test-requirement',
    ]);
    expect(tracker.observe([job('a', 'succeeded')])).toEqual([]);
    expect(tracker.pendingIds).toEqual([]);
  });

  it('does not treat historical failures as new completions or replay mutations', () => {
    const tracker = new OperationRecoveryTracker();
    expect(tracker.observe([job('historic', 'failed')])).toEqual([]);
    expect(tracker.pendingIds).toEqual([]);
  });

  it('keeps off-page pending jobs and deduplicates concurrent completions for one requirement', () => {
    const tracker = new OperationRecoveryTracker();
    tracker.observe([job('a', 'running'), job('b', 'queued')]);
    tracker.observe([]);
    expect(tracker.pendingIds).toEqual(['a', 'b']);
    expect(
      tracker.observe([job('a', 'failed'), job('b', 'succeeded')]),
    ).toEqual(['test-requirement']);
  });

  it('isolates user sessions and stores no operation bodies or actor data', () => {
    const previous = new OperationRecoveryTracker();
    previous.observe([
      {
        ...job('a', 'running'),
        actorName: 'Private Name',
        fields: ['details'],
      } as OperationRecord,
    ]);
    const next = new OperationRecoveryTracker();
    expect(next.observe([job('a', 'failed')])).toEqual([]);
    expect(JSON.stringify(previous)).not.toContain('Private Name');
    expect(JSON.stringify(previous)).not.toContain('details');
  });
});

describe('operation filters', () => {
  it.each(['-1', '0', 'NaN', '1.5', 'Infinity', null])(
    'rejects invalid page %s',
    (value) => {
      expect(operationPage(value)).toBe(1);
    },
  );
  it('bounds pages and rejects unknown statuses', () => {
    expect(operationPage('999999')).toBe(100000);
    expect(operationStatus('all')).toBe('all');
    expect(operationStatus('admin')).toBe('all');
    expect(operationStatus('failed')).toBe('failed');
    expect(operationTime('invalid')).toBe('—');
  });
});
