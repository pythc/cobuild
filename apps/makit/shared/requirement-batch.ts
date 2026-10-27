import type {
  BulkRequirementUpdateInput,
  BulkRequirementPatch,
  RequirementUpdateJobStatus,
  RequirementUpdateInput,
} from './api.interface';
export interface RequirementBatchItem {
  recordId: string;
  code: string;
  title: string;
  status: 'allowed' | 'blocked' | 'skipped' | RequirementUpdateJobStatus;
  reason: string;
  operationId?: string;
  input: RequirementUpdateInput;
}
export interface RequirementBatch {
  id: string;
  state: 'preview' | 'executing' | 'submitted';
  expiresAt: string;
  patch: BulkRequirementPatch;
  items: RequirementBatchItem[];
}
export interface RequirementBatchPreviewInput extends BulkRequirementUpdateInput {
  clientMutationId: string;
}
