import type { Generated, Int8, Timestamp } from './db';
export interface WritingActivityTable {
  id: string;
  workspaceId: string;
  pageId: string;
  userId: string;
  bucket: Timestamp;
  charsDelta: Int8;
  edited: boolean;
  created: boolean;
}
export interface WritingStatisticsMetadataTable {
  id: Generated<boolean>;
  startedAt: Generated<Timestamp>;
}
