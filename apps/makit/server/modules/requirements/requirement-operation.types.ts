import type { MutationResult, RequirementSummary } from '@shared/api.interface';
import type { BaseRecord } from './feishu.service';

export interface RequirementWriteHooks {
  beforeWrite(
    before: RequirementSummary,
    fields: Record<string, unknown>,
    labels: string[],
  ): Promise<void>;
  confirmed(
    before: RequirementSummary,
    after: RequirementSummary,
    receipt: BaseRecord,
    result: MutationResult,
  ): Promise<void>;
}
