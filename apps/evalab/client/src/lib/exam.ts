import type { Direction, Enrollment, EnrollmentState, MaterialManifest, MaterialUpload } from '../types'

export function isEnrollmentState(value: string): value is EnrollmentState {
  return value === 'READY' || value === 'ACTIVE' || value === 'FINALIZED' || value === 'EXPIRED'
}

function asSubmission(value: unknown): Enrollment['submission'] {
  if (!value || typeof value !== 'object') return null
  const item = value as { id?: unknown; submittedAt?: unknown; sha?: unknown; materialsHash?: unknown }
  if (typeof item.id !== 'string' || typeof item.submittedAt !== 'string') return null
  return {
    id: item.id,
    submittedAt: item.submittedAt,
    sha: typeof item.sha === 'string' ? item.sha : '',
    materialsHash: typeof item.materialsHash === 'string' ? item.materialsHash : '',
  }
}

function finiteBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function normalizeMaterialUpload(value: unknown): MaterialUpload | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<MaterialUpload>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.status !== 'string' || !item.status.trim()) return null
  return {
    id: item.id,
    status: item.status,
    totalBytes: finiteBytes(item.totalBytes),
    receivedBytes: finiteBytes(item.receivedBytes),
    expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : '',
  }
}

function uploadKey(status: string): string {
  return status.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

const UPLOAD_SETTLED = new Set([
  'RECEIVED',
  'COMPLETE',
  'COMPLETED',
  'FAILED',
  'ERROR',
  'EXPIRED',
  'REVOKED',
  'CANCELLED',
  'CANCELED',
  'REJECTED',
])

const UPLOAD_ACTIVE = new Set(['AWAITING_FILES', 'UPLOADING', 'RECEIVING', 'IN_PROGRESS', 'TRANSFERRING', 'PENDING'])

export function isUploadInFlight(upload: MaterialUpload): boolean {
  const key = uploadKey(upload.status)
  if (UPLOAD_SETTLED.has(key)) return false
  if (UPLOAD_ACTIVE.has(key)) return true
  return upload.totalBytes <= 0 || upload.receivedBytes < upload.totalBytes
}

export function pendingUploadBytes(upload: MaterialUpload): number {
  return Math.max(0, upload.totalBytes - upload.receivedBytes)
}

export function uploadRatio(upload: MaterialUpload): number {
  if (upload.totalBytes <= 0) return 0
  const ratio = upload.receivedBytes / upload.totalBytes
  if (!Number.isFinite(ratio) || ratio < 0) return 0
  return Math.min(1, ratio)
}

function asManifest(value: unknown): MaterialManifest {
  const record = value && typeof value === 'object' ? (value as Partial<MaterialManifest>) : {}
  return {
    files: Array.isArray(record.files) ? record.files : [],
    clients: Array.isArray(record.clients) ? record.clients : [],
    projectSummary: typeof record.projectSummary === 'string' ? record.projectSummary : '',
    collaborationSummary: typeof record.collaborationSummary === 'string' ? record.collaborationSummary : '',
  }
}

export function normalizeEnrollment(raw: unknown): Enrollment | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<Enrollment>
  if (typeof value.id !== 'string' || typeof value.state !== 'string') return null
  if (!isEnrollmentState(value.state)) return null
  const question = value.question
  return {
    id: value.id,
    roundId: value.roundId ?? '',
    batchId: value.batchId ?? '',
    batchName: value.batchName ?? '',
    roundName: value.roundName ?? '',
    direction: typeof value.direction === 'string' ? value.direction : '',
    state: value.state,
    mcpConnected: value.mcpConnected === true,
    consentAccepted: value.consentAccepted === true,
    directUploadAccepted: value.directUploadAccepted === true,
    startedAt: value.startedAt ?? null,
    deadline: value.deadline ?? null,
    durationHours: typeof value.durationHours === 'number' && Number.isFinite(value.durationHours) ? value.durationHours : null,
    finalizedAt: value.finalizedAt ?? null,
    question: question
      ? {
          title: question.title ?? '',
          content: question.content ?? '',
          attachments: Array.isArray(question.attachments) ? question.attachments : [],
        }
      : null,
    repository: value.repository ?? null,
    materials: value.materials ?? null,
    materialUpload: normalizeMaterialUpload((value as { materialUpload?: unknown }).materialUpload),
    approvals: Array.isArray(value.approvals)
      ? value.approvals.map((item) => ({
          ...item,
          manifest: asManifest(item?.manifest),
          state: typeof item?.state === 'string' ? item.state : '',
        }))
      : [],
    result: value.result ?? null,
    submission: asSubmission((value as { submission?: unknown }).submission),
  }
}

export function pastDeadline(enrollment: Enrollment, now: number): boolean {
  if (!enrollment.deadline) return false
  const deadline = new Date(enrollment.deadline).getTime()
  return Number.isFinite(deadline) && now >= deadline
}

export function writesOpen(enrollment: Enrollment, now: number): boolean {
  return enrollment.state === 'ACTIVE' && !enrollment.finalizedAt && !pastDeadline(enrollment, now)
}

export interface CheckItem {
  ok: boolean
  label: string
}

export function finalizeChecks(enrollment: Enrollment, now: number): CheckItem[] {
  const repository = enrollment.repository
  const materials = enrollment.materials
  const matched = Boolean(repository && materials && repository.sha === materials.repoSha)
  const open = writesOpen(enrollment, now)
  return [
    { ok: Boolean(repository), label: repository ? '仓库 SHA 已锁定' : '尚未锁定仓库 SHA' },
    { ok: Boolean(materials), label: materials ? '已收到 MCP 材料回执' : '尚未收到 MCP 材料' },
    ...(repository && materials
      ? [{ ok: matched, label: matched ? '仓库 SHA 与材料一致' : '仓库 SHA 与材料不一致' }]
      : []),
    { ok: open, label: open ? '仍在截止时间之前' : '已超过截止时间或当前不能交卷' },
  ]
}

export function canFinalize(enrollment: Enrollment, now: number): boolean {
  return finalizeChecks(enrollment, now).every((item) => item.ok)
}

export function directionOf(value: string): Direction | null {
  if (value === 'PRODUCT' || value === 'DEVELOPMENT_TEST') return value
  return null
}
