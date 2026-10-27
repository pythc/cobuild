import { ApiError, api, messageOf } from './http'

export const DELETION_CONFIRMATION = '删除'

export type DeletionKind = 'round' | 'batch' | 'question' | 'candidate' | 'enrollment'

export interface DeletionCounts {
  batches: number
  questions: number
  enrollments: number
  materials: number
  files: number
}

export interface DeletionPreview {
  kind: DeletionKind
  id: string
  title: string
  allowed: boolean
  reason: string | null
  fingerprint: string
  counts: DeletionCounts
  consequences: string[]
}

export interface DeletionResult {
  ok: true
  kind: DeletionKind
  id: string
  filesQueued: number
}

export interface DeletionTarget {
  kind: DeletionKind
  id: string
  action: string
}

const KINDS = new Set<string>(['round', 'batch', 'question', 'candidate', 'enrollment'])

function isKind(value: unknown): value is DeletionKind {
  return typeof value === 'string' && KINDS.has(value)
}

function deletionPath(kind: DeletionKind, id: string): string {
  return `/api/admin/deletions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
}

function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError('删除预览数据无效', 500)
  return value
}

export function parseDeletionPreview(data: unknown): DeletionPreview {
  if (!data || typeof data !== 'object') throw new ApiError('删除预览数据无效', 500)
  const preview = (data as { preview?: unknown }).preview
  if (!preview || typeof preview !== 'object') throw new ApiError('删除预览数据无效', 500)
  const row = preview as Record<string, unknown>
  if (!isKind(row.kind) || typeof row.id !== 'string' || row.id.trim() === '') {
    throw new ApiError('删除预览数据无效', 500)
  }
  if (typeof row.title !== 'string') throw new ApiError('删除预览数据无效', 500)
  if (typeof row.allowed !== 'boolean') throw new ApiError('删除预览数据无效', 500)
  if (!(row.reason === null || typeof row.reason === 'string')) throw new ApiError('删除预览数据无效', 500)
  if (typeof row.fingerprint !== 'string' || row.fingerprint.trim() === '') {
    throw new ApiError('删除预览数据无效', 500)
  }
  if (!row.counts || typeof row.counts !== 'object') throw new ApiError('删除预览数据无效', 500)
  const counts = row.counts as Record<string, unknown>
  const consequences = row.consequences
  if (!Array.isArray(consequences) || !consequences.every((item): item is string => typeof item === 'string')) {
    throw new ApiError('删除预览数据无效', 500)
  }
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    allowed: row.allowed,
    reason: row.reason,
    fingerprint: row.fingerprint,
    counts: {
      batches: requireCount(counts.batches),
      questions: requireCount(counts.questions),
      enrollments: requireCount(counts.enrollments),
      materials: requireCount(counts.materials),
      files: requireCount(counts.files),
    },
    consequences,
  }
}

export async function fetchDeletionPreview(kind: DeletionKind, id: string): Promise<DeletionPreview> {
  const data = await api<unknown>(deletionPath(kind, id))
  const preview = parseDeletionPreview(data)
  if (preview.kind !== kind || preview.id !== id) throw new ApiError('删除预览与当前对象不一致', 500)
  return preview
}

export async function deleteAdminRecord(kind: DeletionKind, id: string, fingerprint: string): Promise<DeletionResult> {
  const data = await api<unknown>(deletionPath(kind, id), {
    method: 'DELETE',
    json: { confirmation: DELETION_CONFIRMATION, fingerprint },
  })
  if (!data || typeof data !== 'object') throw new ApiError('删除没有返回有效结果', 500)
  const body = data as { ok?: unknown; kind?: unknown; id?: unknown; filesQueued?: unknown }
  if (body.ok !== true) throw new ApiError('删除没有返回有效结果', 500)
  if (body.kind !== kind) throw new ApiError('删除结果与当前对象不一致', 500)
  if (body.id !== id) throw new ApiError('删除结果与当前对象不一致', 500)
  const filesQueued = body.filesQueued === undefined ? 0 : body.filesQueued
  if (typeof filesQueued !== 'number' || !Number.isFinite(filesQueued) || filesQueued < 0) {
    throw new ApiError('删除没有返回有效结果', 500)
  }
  return { ok: true, kind, id, filesQueued }
}

export function isStaleDeletionPreview(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 409 || error.code === 'PREVIEW_CHANGED')
}

export function deletionFailureMessage(error: unknown): string {
  if (!isStaleDeletionPreview(error)) return messageOf(error)
  const server = error.message.trim()
  if (!server || server === '请求失败（409）') return '删除预览已变化，请刷新预览后再删除。'
  if (/刷新预览|请刷新/.test(server)) return server
  const text = server.replace(/[。．.]+$/u, '')
  return `${text}。请刷新预览后再删除。`
}
