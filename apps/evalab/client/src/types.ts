export type Role = 'CANDIDATE' | 'ADMIN'
export type Direction = 'PRODUCT' | 'DEVELOPMENT_TEST'
export type EnrollmentState = 'READY' | 'ACTIVE' | 'FINALIZED' | 'EXPIRED'
export type BatchStatus = 'DRAFT' | 'OPEN' | 'CLOSED'
export type ExamDurationHours = 24 | 48
export type ModelSource = 'reported' | 'detected' | 'unknown'
export type FileCoverage = 'export' | 'partial'

export interface User {
  id: string
  role: Role
  name: string
  studentNo?: string
  college?: string
  major?: string
  phone?: string
  email?: string
}

export interface Attachment {
  id: string
  name: string
  size: number
  url: string
}

export interface QuestionSnapshot {
  title: string
  content: string
  attachments: Attachment[]
}

export interface RepositoryLock {
  id: string
  url: string
  branch: string
  sha: string
  message: string
  author: string
  committedAt: string
  confirmedAt: string
}

export interface MaterialsSummary {
  id: string
  sha256: string
  repoSha: string
  receivedAt: string
  clientCount: number
  fileCount: number
  coverage: string
}

export interface MaterialUpload {
  id: string
  status: string
  totalBytes: number
  receivedBytes: number
  expiresAt: string
}

export interface MaterialModel {
  name: string
  parameters?: Record<string, string | number | boolean | null>
  source: ModelSource | string
}

export interface MaterialClient {
  name: string
  version?: string
  models: MaterialModel[]
}

export interface MaterialFileMeta {
  name: string
  sha256: string
  bytes: number
  source: string
  coverage: FileCoverage | string
}

export interface MaterialManifest {
  files: MaterialFileMeta[]
  clients: MaterialClient[]
  projectSummary: string
  collaborationSummary: string
}

export interface Approval {
  id: string
  manifest: MaterialManifest
  payloadHash: string
  repoSha: string
  state: string
  expiresAt: string
}

export interface PublishedResult {
  score: number
  feedback: string
  publishedAt: string
}

export interface Enrollment {
  id: string
  roundId: string
  batchId: string
  batchName: string
  roundName: string
  direction: Direction | string
  state: EnrollmentState
  mcpConnected: boolean
  consentAccepted: boolean
  directUploadAccepted: boolean
  startedAt: string | null
  deadline: string | null
  /** Batch config before start; snapshot after start. Absent when the payload omitted it. */
  durationHours?: number | null
  finalizedAt: string | null
  question: QuestionSnapshot | null
  repository: RepositoryLock | null
  materials: MaterialsSummary | null
  materialUpload: MaterialUpload | null
  approvals: Approval[]
  result: PublishedResult | null
  submission?: {
    id: string
    submittedAt: string
    sha: string
    materialsHash: string
  } | null
}

export interface PublicBatch {
  id: string
  name: string
  description: string
  status?: BatchStatus
  opensAt: string
  startClosesAt: string
  durationHours: number | null
  directions: Direction[]
  directionCounts?: { PRODUCT: number; DEVELOPMENT_TEST: number }
  enrollment?: Enrollment
}

export interface PublicRound {
  id: string
  name: string
  batches: PublicBatch[]
}

export interface RepoPreview {
  id: string
  url: string
  branch: string
  sha: string
  message: string
  author: string
  committedAt: string
  expiresAt: string
}

export interface MaterialFileBody {
  name: string
  content: string
}

export interface MaterialFileLink {
  id: string
  name: string
  bytes: number
  sha256: string
  downloadUrl: string
}

export interface MaterialPayload {
  schemaVersion: number
  repoSha: string
  manifest: MaterialManifest
  files: Array<MaterialFileBody | MaterialFileLink>
}

export interface MaterialsDocument {
  payload: MaterialPayload | null
  receipt: Record<string, unknown> | null
  bound?: boolean
  purged?: boolean
}

export interface FinalizeReceipt {
  id: string
  submittedAt: string
  sha: string
  materialsHash: string
}

export interface AdminRound {
  id: string
  name: string
}

export interface AdminBatch {
  id: string
  roundId: string
  roundName: string
  name: string
  description: string
  opensAt: string
  startClosesAt: string
  durationHours: number | null
  status: BatchStatus
}

export interface AdminQuestion {
  id: string
  batchId: string
  direction: Direction
  title: string
  content: string
  published: boolean
  attachments: Attachment[]
}

export interface AdminCandidate {
  id: string
  role: Role
  name: string
  studentNo?: string
  college?: string
  major?: string
  phone?: string
  email?: string
  enrollments: Enrollment[]
}

export interface Review {
  score: number
  feedback: string
  publishedAt: string | null
}

export interface AuditEvent {
  id: string
  actorName: string
  action: string
  createdAt: string
  details: unknown
}

export interface Overview {
  counts: {
    candidates?: number
    batches?: number
    active?: number
    finalized?: number
    unreviewed?: number
  }
  recent: unknown[]
}

export interface McpTokenIssue {
  token: string
  mcpUrl: string
  expiresAt: string
}

export interface AgentConnection {
  id: string
  clientName: string
  createdAt: string
  lastUsedAt: string | null
}

export interface OAuthEnrollmentOption {
  id: string
  roundName: string
  batchName: string
  direction: string
  state: string
  deadline: string | null
}

export interface OAuthConnectRequest {
  id: string
  clientName: string
  redirectOrigin: string
  expiresAt: string
  scopes: string[]
  enrollments: OAuthEnrollmentOption[]
}
