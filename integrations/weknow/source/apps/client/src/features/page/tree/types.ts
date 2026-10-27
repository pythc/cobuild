export type SpaceTreeNode = {
  nodeType?: "page" | "folder" | "file" | "office";
  fileExtension?: string;
  id: string;
  slugId: string;
  name: string;
  icon?: string;
  position: string;
  spaceId: string;
  parentPageId: string;
  hasChildren: boolean;
  isBase?: boolean;
  canEdit?: boolean;
  children: SpaceTreeNode[];
};
