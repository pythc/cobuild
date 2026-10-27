import { Generated, Timestamp } from './db';
export interface FeishuIdentities {
  id: Generated<number>;
  provider: string;
  appId: string;
  tenantKey: string;
  subject: string;
  unionId: string | null;
  userId: string;
  workspaceId: string;
  directoryStatus: Generated<string>;
  directoryCheckedAt: Timestamp | null;
  lastEventAt: Timestamp | null;
}
