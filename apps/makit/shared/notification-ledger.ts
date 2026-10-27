export interface NotificationLedgerItem {
  id: string; eventId: string; operationId: string | null; source: string; owner: string; kind: string;
  requirementId: string | null; repository: string | null; pullNumber: number | null;
  channel: string; targetName: string; platformUrl: string; state: string; attempts: number;
  maxAttempts: number; messageId: string | null; lastErrorCode: string | null; confirmedAt: string | null; updatedAt: string;
}
export interface NotificationLedgerPage { items: NotificationLedgerItem[]; total: number; page: number; pageSize: number; pageCount: number; coverageNote: string }
export interface NotificationRetryPreview { token: string; expiresAt: string; eligibleCount: number; rejectedCount: number; items: Array<NotificationLedgerItem & { eligible: boolean; reason: string }> }
