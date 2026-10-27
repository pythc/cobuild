export type ProjectAction =
  | 'read'
  | 'knowledge_link'
  | 'milestone_add'
  | 'milestone_set';
export interface LiveProject {
  id: string;
  name: string;
  revision: number;
  archived: boolean;
  phase: string;
  canEdit: boolean;
  ownerSubject: string;
  ownerName: string;
  members: Array<{ subject: string; name: string }>;
  links: {
    knowledgeSpace?: string;
    docs: string;
    repository: string;
    requirements: string;
    demo: string;
  };
  milestones: Array<{
    id: string;
    title: string;
    assignee: string;
    dueAt: string | null;
    status: 'open' | 'done';
    revision: number;
    canChange: boolean;
  }>;
}
