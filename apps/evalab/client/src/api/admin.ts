import type {
  AdminBatch,
  MaterialsDocument,
  AdminCandidate,
  AdminQuestion,
  AdminRound,
  Attachment,
  AuditEvent,
  BatchStatus,
  Direction,
  Enrollment,
  Overview,
  Review,
  User,
} from '../types'
import { attachDurationHours } from '../lib/format'
import { normalizeEnrollment } from '../lib/exam'
import { ApiError, api, apiBlob, withQuery } from './http'

export async function fetchOverview(): Promise<Overview> {
  const data = await api<Overview>('/api/admin/overview')
  return {
    counts: data?.counts ?? {},
    recent: Array.isArray(data?.recent) ? data.recent : [],
  }
}

export async function fetchRounds(): Promise<AdminRound[]> {
  const data = await api<{ rounds?: AdminRound[] }>('/api/admin/rounds')
  return Array.isArray(data.rounds) ? data.rounds : []
}

function parseCreatedRound(data: unknown): AdminRound {
  if (!data || typeof data !== 'object') throw new ApiError('轮次创建没有返回有效结果', 500)
  const round = (data as { round?: unknown }).round
  if (!round || typeof round !== 'object') throw new ApiError('轮次创建没有返回有效结果', 500)
  const id = (round as { id?: unknown }).id
  const name = (round as { name?: unknown }).name
  if (typeof id !== 'string' || id.trim() === '' || typeof name !== 'string' || name.trim() === '') {
    throw new ApiError('轮次创建没有返回有效结果', 500)
  }
  return { id, name }
}

export async function createRound(name: string): Promise<AdminRound> {
  const data = await api<unknown>('/api/admin/rounds', {
    method: 'POST',
    json: { name },
  })
  return parseCreatedRound(data)
}

export async function fetchAdminBatches(): Promise<AdminBatch[]> {
  const data = await api<{ batches?: AdminBatch[] }>('/api/admin/batches')
  return Array.isArray(data.batches) ? data.batches : []
}

export interface BatchInput {
  roundId: string
  name: string
  description: string
  opensAt: string
  startClosesAt: string
  durationHours: number
  status: BatchStatus
}

function withDuration(raw: unknown): Enrollment | null {
  const enrollment = normalizeEnrollment(raw)
  if (!enrollment) return null
  return attachDurationHours(raw, enrollment)
}

export async function createBatch(body: BatchInput): Promise<void> {
  await api('/api/admin/batches', { method: 'POST', json: body })
}

export async function updateBatch(id: string, body: BatchInput): Promise<void> {
  await api(`/api/admin/batches/${encodeURIComponent(id)}`, { method: 'PATCH', json: body })
}

export async function fetchQuestions(batchId: string): Promise<AdminQuestion[]> {
  const data = await api<{ questions?: AdminQuestion[] }>(
    withQuery('/api/admin/questions', { batchId }),
  )
  return (Array.isArray(data.questions) ? data.questions : []).map((question) => ({
    ...question,
    attachments: Array.isArray(question.attachments) ? question.attachments : [],
  }))
}

export interface QuestionInput {
  batchId: string
  direction: Direction
  title: string
  content: string
  published: boolean
  attachmentIds: string[]
}

export async function createQuestion(body: QuestionInput): Promise<void> {
  await api('/api/admin/questions', { method: 'POST', json: body })
}

export async function updateQuestion(id: string, body: QuestionInput): Promise<void> {
  await api(`/api/admin/questions/${encodeURIComponent(id)}`, { method: 'PATCH', json: body })
}

export async function uploadAttachment(file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file, file.name)
  const data = await api<{ attachment?: Attachment }>('/api/admin/attachments', {
    method: 'POST',
    form,
  })
  if (!data.attachment?.id) throw new ApiError('附件上传没有返回编号', 500)
  return data.attachment
}

export async function fetchCandidates(query: {
  risk?: string
  search?: string
  state?: string
  batchId?: string
  offset?: string
}): Promise<AdminCandidate[]> {
  const data = await api<{ candidates?: AdminCandidate[] }>(
    withQuery('/api/admin/candidates', query),
  )
  return (Array.isArray(data.candidates) ? data.candidates : []).map((candidate) => ({
    ...candidate,
    enrollments: (Array.isArray(candidate.enrollments) ? candidate.enrollments : [])
      .map((item) => withDuration(item))
      .filter((item): item is Enrollment => item !== null),
  }))
}

export async function fetchAdminEnrollment(id: string): Promise<{
  enrollment: Enrollment
  user: User
  review: Review | null
}> {
  const data = await api<{ enrollment?: unknown; user?: User; review?: Review | null }>(
    `/api/admin/enrollments/${encodeURIComponent(id)}`,
  )
  const enrollment = withDuration(data.enrollment)
  if (!enrollment || !data.user) throw new ApiError('考生详情数据无效', 500)
  return { enrollment, user: data.user, review: data.review ?? null }
}

export async function extendEnrollment(id: string, minutes: number, reason: string): Promise<Enrollment> {
  const data = await api<{ enrollment?: unknown }>(
    `/api/admin/enrollments/${encodeURIComponent(id)}/extend`,
    { method: 'POST', json: { minutes, reason } },
  )
  const enrollment = withDuration(data.enrollment)
  if (!enrollment) throw new ApiError('延长截止时间的返回数据无效', 500)
  return enrollment
}

export async function saveReview(id: string, score: number, feedback: string): Promise<Review> {
  const data = await api<{ review?: Review }>(`/api/admin/enrollments/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    json: { score, feedback },
  })
  if (!data.review || typeof data.review.score !== 'number') throw new ApiError('评分没有保存成功', 500)
  return data.review
}

export async function publishReview(id: string): Promise<Review> {
  const data = await api<{ review?: Review }>(`/api/admin/enrollments/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    json: {},
  })
  if (!data.review) throw new ApiError('发布没有返回结果', 500)
  return data.review
}

export async function fetchAudit(): Promise<AuditEvent[]> {
  const data = await api<{ events?: AuditEvent[] }>('/api/admin/audit')
  return Array.isArray(data.events) ? data.events : []
}

export async function downloadExport(): Promise<{ blob: Blob; filename: string | null }> {
  return apiBlob('/api/admin/export')
}

export async function fetchMaterials(id: string): Promise<MaterialsDocument> {
  const data = await api<MaterialsDocument>(`/api/enrollments/${encodeURIComponent(id)}/materials`)
  return {
    payload: data?.payload ?? null,
    receipt: data?.receipt ?? null,
    bound: data?.bound,
    purged: data?.purged === true,
  }
}

