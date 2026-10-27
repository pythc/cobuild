export type ModelSource = 'reported' | 'detected' | 'unknown';
export type Coverage = 'export' | 'partial';

export type MaterialModel = {
  name: string;
  parameters?: Record<string, string | number | boolean | null>;
  source: ModelSource;
};

export type MaterialClient = {
  name: string;
  version?: string;
  models: MaterialModel[];
};

export type MaterialFile = {
  name: string;
  sha256: string;
  bytes: number;
  source: string;
  coverage: Coverage;
};

export type MaterialManifest = {
  files: MaterialFile[];
  clients: MaterialClient[];
  projectSummary: string;
  collaborationSummary: string;
};

export type MaterialPayload = {
  schemaVersion: 1;
  repoSha: string;
  manifest: MaterialManifest;
  files: Array<{ name: string; content: string }>;
};

export type Selection = 'workspace-match' | 'user-selected';

export type CandidateKind = 'codex-jsonl' | 'cursor-export' | 'raw-export';

export type Candidate = {
  id: string;
  rootReal: string;
  fileReal: string;
  relativeName: string;
  kind: CandidateKind;
  selection: Selection;
  workspaceMatched: boolean;
  bytes: number;
  detected: {
    clientName: string;
    clientVersion?: string;
    modelName?: string;
    modelSource: 'detected' | 'unknown';
    provider?: string;
  };
};

export type PublicCandidate = {
  id: string;
  relativeName: string;
  kind: CandidateKind;
  selection: Selection;
  workspaceMatched: boolean;
  bytes: number;
  clientName: string;
  clientVersion?: string;
  modelName: string;
  modelSource: 'detected' | 'unknown';
};

export type BundlePreviewFile = {
  name: string;
  sha256: string;
  bytes: number;
  source: string;
  coverage: Coverage;
  redactions: number;
  excerpt: string;
  excerptTruncated: boolean;
  workspaceMatched: boolean;
  selection: Selection;
};

export type BundlePreview = {
  upload: false;
  payloadHash: string;
  repoSha: string;
  totalBytes: number;
  fileCount: number;
  files: BundlePreviewFile[];
  clients: MaterialClient[];
  projectSummary: string;
  collaborationSummary: string;
  warnings: string[];
  note: string;
};
