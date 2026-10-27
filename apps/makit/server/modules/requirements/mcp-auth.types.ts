import type { CurrentUserSummary } from '@shared/api.interface';

export interface McpWriteProof {
  credentialId: string;
  tokenVersion: number;
  subjectHash: string;
}

export interface VerifiedMcpUser extends CurrentUserSummary {
  mcpWriteProof: McpWriteProof;
}
