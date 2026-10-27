import type { RequirementUpdateJobSummary } from '@shared/api.interface';

/** A session-only index: no document bodies, credentials or user fields are persisted. */
export class OperationRecoveryTracker {
  private readonly pending: Map<string, string> = new Map();

  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  forget(ids: string[]): void {
    ids.forEach((id: string): void => {
      this.pending.delete(id);
    });
  }

  observe(items: RequirementUpdateJobSummary[]): string[] {
    const completedRequirements: Set<string> = new Set();
    for (const item of items) {
      if (item.status === 'queued' || item.status === 'running') {
        this.pending.set(item.id, item.requirementId);
      } else if (this.pending.has(item.id)) {
        this.pending.delete(item.id);
        completedRequirements.add(item.requirementId);
      }
    }
    return [...completedRequirements];
  }
}
