import type {
  AgentConnection,
  Enrollment,
  ExamDurationHours,
  FinalizeReceipt,
  McpTokenIssue,
  OAuthConnectRequest,
  OAuthEnrollmentOption,
  PublicRound,
  RepoPreview,
} from '../types'
import { CONSENT_VERSION } from '../content/consent'
import { attachDurationHours } from '../lib/format'
import { normalizeEnrollment } from '../lib/exam'
import { ApiError, api } from './http'

function presentEnrollment(raw: unknown): Enrollment | null {
  const enrollment = normalizeEnrollment(raw)
  if (!enrollment) return null
  return attachDurationHours(raw, enrollment)
}

function takeEnrollment(data: unknown): Enrollment {
  if (!data || typeof data !== 'object') throw new ApiError('报名数据无效', 500)
  const record = data as { enrollment?: unknown }
  const raw = record.enrollment ?? data
  const enrollment = presentEnrollment(raw)
  if (!enrollment) throw new ApiError('报名数据无效', 500)
  return enrollment
}

export async function fetchBatches(): Promise<{ rounds: PublicRound[]; serverNow: string }> {
  const data = await api<{ rounds?: PublicRound[]; serverNow?: string }>('/api/batches')
  const rounds = Array.isArray(data.rounds) ? data.rounds : []
  return {
    serverNow: typeof data.serverNow === 'string' ? data.serverNow : '',
    rounds: rounds.map((round) => ({
      ...round,
      batches: Array.isArray(round.batches)
        ? round.batches.map((batch) => ({
            ...batch,
            directions: Array.isArray(batch.directions) ? batch.directions : [],
            enrollment: batch.enrollment ? presentEnrollment(batch.enrollment) ?? undefined : undefined,
          }))
        : [],
    })),
  }
}

export async function fetchMyEnrollments(): Promise<{ enrollments: Enrollment[]; serverNow: string }> {
  const data = await api<unknown>('/api/enrollments')
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { enrollments?: unknown; serverNow?: unknown })
    : null
  const list = Array.isArray(data) ? data : Array.isArray(record?.enrollments) ? record.enrollments : null
  if (!list) throw new ApiError('报名列表数据无效', 500)
  return {
    serverNow: record && typeof record.serverNow === 'string' ? record.serverNow : '',
    enrollments: list
      .map((item) => presentEnrollment(item))
      .filter((item): item is Enrollment => item !== null),
  }
}

export async function createEnrollment(batchId: string, direction: Enrollment['direction']): Promise<Enrollment> {
  const data = await api<unknown>('/api/enrollments', {
    method: 'POST',
    json: { batchId, direction },
  })
  return takeEnrollment(data)
}

export async function updateEnrollment(
  id: string,
  body: { batchId?: string; direction?: Enrollment['direction'] },
): Promise<Enrollment> {
  const data = await api<unknown>(`/api/enrollments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: body,
  })
  return takeEnrollment(data)
}

export async function fetchEnrollment(id: string): Promise<{ enrollment: Enrollment; serverNow: string }> {
  const data = await api<{ enrollment?: unknown; serverNow?: string }>(
    `/api/enrollments/${encodeURIComponent(id)}`,
  )
  const enrollment = presentEnrollment(data.enrollment)
  if (!enrollment) throw new ApiError('报名数据无效', 500)
  return { enrollment, serverNow: typeof data.serverNow === 'string' ? data.serverNow : '' }
}

export async function acceptConsent(id: string): Promise<Enrollment> {
  const data = await api<unknown>(`/api/enrollments/${encodeURIComponent(id)}/consent`, {
    method: 'POST',
    json: { version: CONSENT_VERSION, accepted: true },
  })
  return takeEnrollment(data)
}

export async function issueMcpToken(id: string): Promise<McpTokenIssue> {
  const data = await api<McpTokenIssue>(`/api/enrollments/${encodeURIComponent(id)}/mcp-token`, {
    method: 'POST',
    json: {},
  })
  if (!data?.token || !data.mcpUrl) throw new ApiError('服务器没有返回接入令牌', 500)
  return data
}

export async function startEnrollment(
  id: string,
  expectedDurationHours: ExamDurationHours,
): Promise<{ enrollment: Enrollment; serverNow: string }> {
  const data = await api<{ enrollment?: unknown; serverNow?: string }>(
    `/api/enrollments/${encodeURIComponent(id)}/start`,
    { method: 'POST', json: { confirmed: true, expectedDurationHours } },
  )
  const enrollment = presentEnrollment(data.enrollment)
  if (!enrollment) throw new ApiError('开始考核的返回数据无效', 500)
  return { enrollment, serverNow: typeof data.serverNow === 'string' ? data.serverNow : '' }
}

export async function previewRepository(
  id: string,
  body: { url: string; branch?: string },
): Promise<RepoPreview> {
  const data = await api<{ preview?: RepoPreview }>(
    `/api/enrollments/${encodeURIComponent(id)}/repository/preview`,
    { method: 'POST', json: body },
  )
  if (!data.preview?.id || !data.preview.sha) throw new ApiError('仓库预览数据无效', 500)
  return data.preview
}

export async function confirmRepository(id: string, previewId: string): Promise<Enrollment> {
  const data = await api<unknown>(`/api/enrollments/${encodeURIComponent(id)}/repository/confirm`, {
    method: 'POST',
    json: { previewId },
  })
  return takeEnrollment(data)
}

export async function finalizeEnrollment(
  id: string,
  body: { repositoryId: string; materialsId: string; confirmed: true },
): Promise<{ enrollment: Enrollment; receipt: FinalizeReceipt }> {
  const data = await api<{ enrollment?: unknown; receipt?: FinalizeReceipt }>(
    `/api/enrollments/${encodeURIComponent(id)}/finalize`,
    { method: 'POST', json: body },
  )
  const enrollment = presentEnrollment(data.enrollment)
  if (!enrollment || !data.receipt?.id) throw new ApiError('交卷回执无效', 500)
  return { enrollment, receipt: data.receipt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value == null) return null
  if (typeof value === 'string') return value
  return undefined
}

function takeEnrollmentOption(value: unknown): OAuthEnrollmentOption | null {
  const row = isRecord(value) ? value : null
  if (!row || typeof row.id !== 'string' || !row.id) return null
  if (typeof row.roundName !== 'string' || typeof row.batchName !== 'string') return null
  if (typeof row.direction !== 'string' || typeof row.state !== 'string') return null
  const deadline = optionalTimestamp(row.deadline)
  if (deadline === undefined) return null
  return {
    id: row.id,
    roundName: row.roundName,
    batchName: row.batchName,
    direction: row.direction,
    state: row.state,
    deadline,
  }
}

export async function fetchOAuthRequest(id: string): Promise<OAuthConnectRequest> {
  const data = await api<unknown>(`/api/oauth/requests/${encodeURIComponent(id)}`)
  const root = isRecord(data) ? data : null
  const request = root && isRecord(root.request) ? root.request : null
  if (!request || typeof request.id !== 'string' || request.id.toLowerCase() !== id.toLowerCase()) {
    throw new ApiError('连接请求数据无效', 500)
  }
  if (typeof request.clientName !== 'string' || typeof request.redirectOrigin !== 'string') {
    throw new ApiError('连接请求数据无效', 500)
  }
  if (typeof request.expiresAt !== 'string') throw new ApiError('连接请求数据无效', 500)
  const scopes = stringList(request.scopes)
  if (!scopes || !Array.isArray(request.enrollments)) throw new ApiError('连接请求数据无效', 500)
  const enrollments: OAuthEnrollmentOption[] = []
  for (const item of request.enrollments) {
    const enrollment = takeEnrollmentOption(item)
    if (!enrollment) throw new ApiError('连接请求数据无效', 500)
    enrollments.push(enrollment)
  }
  return {
    id: request.id,
    clientName: request.clientName,
    redirectOrigin: request.redirectOrigin,
    expiresAt: request.expiresAt,
    scopes,
    enrollments,
  }
}

export async function decideOAuthRequest(
  id: string,
  body: { approved: false } | { approved: true; enrollmentId: string },
): Promise<string> {
  const data = await api<{ redirectUrl?: unknown }>(`/api/oauth/requests/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    json: body,
  })
  if (!data || typeof data.redirectUrl !== 'string' || !data.redirectUrl.trim()) {
    throw new ApiError('服务器没有返回跳转地址', 500)
  }
  return data.redirectUrl
}

export async function fetchAgentConnections(enrollmentId: string): Promise<AgentConnection[]> {
  const data = await api<{ connections?: unknown }>(
    `/api/enrollments/${encodeURIComponent(enrollmentId)}/connections`,
  )
  if (!data || !Array.isArray(data.connections)) throw new ApiError('连接列表数据无效', 500)
  return data.connections.map((item) => {
    const row = isRecord(item) ? item : null
    if (!row || typeof row.id !== 'string' || !row.id) throw new ApiError('连接列表数据无效', 500)
    if (typeof row.clientName !== 'string' || typeof row.createdAt !== 'string') {
      throw new ApiError('连接列表数据无效', 500)
    }
    const lastUsedAt = optionalTimestamp(row.lastUsedAt)
    if (lastUsedAt === undefined) throw new ApiError('连接列表数据无效', 500)
    return { id: row.id, clientName: row.clientName, createdAt: row.createdAt, lastUsedAt }
  })
}

export async function revokeAgentConnection(enrollmentId: string, connectionId: string): Promise<void> {
  const data = await api<{ ok?: unknown }>(
    `/api/enrollments/${encodeURIComponent(enrollmentId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  )
  if (!data || data.ok !== true) throw new ApiError('撤销没有完成', 500)
}
