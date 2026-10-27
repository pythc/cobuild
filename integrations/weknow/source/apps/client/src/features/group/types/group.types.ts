export interface IGroup {
  groupId: string;
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isExternal?: boolean;
  creatorId: string | null;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
}
