import type { Direction, EnrollmentState, ExamDurationHours } from '../types'

export function validInstant(iso: string | null | undefined): iso is string {
  if (!iso) return false
  return Number.isFinite(new Date(iso).getTime())
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!validInstant(iso)) return '—'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}/${pick('month')}/${pick('day')} ${hour}:${pick('minute')}`
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function formatRemain(ms: number): string {
  if (ms <= 0) return '00:00:00'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const clock = [minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  return `${String(hours).padStart(2, '0')}:${clock}`
}

export function directionLabel(direction: Direction | string): string {
  if (direction === 'PRODUCT') return '产品'
  if (direction === 'DEVELOPMENT_TEST') return '开发测试'
  return direction
}

export function stateLabel(state: EnrollmentState | string): string {
  if (state === 'READY') return '待开始'
  if (state === 'ACTIVE') return '考核中'
  if (state === 'FINALIZED') return '已交卷'
  if (state === 'EXPIRED') return '已截止·未交卷'
  return state
}

export function stateTone(state: EnrollmentState | string): 'ready' | 'active' | 'done' | 'expired' | 'neutral' {
  if (state === 'READY') return 'ready'
  if (state === 'ACTIVE') return 'active'
  if (state === 'FINALIZED') return 'done'
  if (state === 'EXPIRED') return 'expired'
  return 'neutral'
}

export function batchStatusLabel(status: string): string {
  if (status === 'DRAFT') return '草稿'
  if (status === 'OPEN') return '开放'
  if (status === 'CLOSED') return '已关闭'
  return status
}

export function windowPhase(now: number, opensAt: string, startClosesAt: string): 'before' | 'open' | 'closed' | 'unknown' {
  const open = new Date(opensAt).getTime()
  const close = new Date(startClosesAt).getTime()
  if (!Number.isFinite(now) || !Number.isFinite(open) || !Number.isFinite(close) || close <= open) return 'unknown'
  if (now < open) return 'before'
  if (now >= close) return 'closed'
  return 'open'
}

/** Date picker wall-clock strings are Beijing time, irrespective of the device timezone. */
export function parseBeijingInput(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return null
  const date = new Date(`${value.replace(' ', 'T')}:00+08:00`)
  if (!Number.isFinite(date.getTime()) || formatDateTime(date.toISOString()).replaceAll('/', '-') !== value) return null
  return date.toISOString()
}

export function isDurationHours(value: unknown): value is ExamDurationHours {
  return value === 24 || value === 48
}

export function readDurationHours(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

export function formatDurationHours(value: unknown): string {
  const hours = readDurationHours(value)
  return hours === null ? '—' : `${hours} 小时`
}

export function attachDurationHours<T extends object>(raw: unknown, enrollment: T): T & { durationHours: number | null } {
  const source = raw && typeof raw === 'object' ? (raw as { durationHours?: unknown }).durationHours : undefined
  return { ...enrollment, durationHours: readDurationHours(source) }
}

/** Enrollment duration is authoritative. A missing enrollment value is not replaced with the batch or with 24. */
export function agreedDuration(enrollmentHours: unknown, batchHours: unknown): ExamDurationHours | null {
  if (!isDurationHours(enrollmentHours)) return null
  if (batchHours == null) return enrollmentHours
  if (!isDurationHours(batchHours) || batchHours !== enrollmentHours) return null
  return enrollmentHours
}

export function durationProblemMessage(enrollmentHours: unknown, batchHours: unknown): string | null {
  if (agreedDuration(enrollmentHours, batchHours)) return null
  if (isDurationHours(enrollmentHours) && isDurationHours(batchHours) && enrollmentHours !== batchHours) {
    return '考核时长已变化，请刷新后再确认。'
  }
  return '考核时长无法确认，暂时不能开始。'
}

export type StartDecision =
  | { ok: true; durationHours: ExamDurationHours }
  | { ok: false; durationHours: ExamDurationHours | null; message: string }

export function assessStart(input: {
  now: number
  opensAt: string
  startClosesAt: string
  status?: string | null
  enrollmentDurationHours: unknown
  batchDurationHours: unknown
}): StartDecision {
  const problem = durationProblemMessage(input.enrollmentDurationHours, input.batchDurationHours)
  const duration = agreedDuration(input.enrollmentDurationHours, input.batchDurationHours)
  if (problem || !duration) {
    return { ok: false, durationHours: null, message: problem ?? '考核时长无法确认，暂时不能开始。' }
  }
  if (input.status && input.status !== 'OPEN') {
    return { ok: false, durationHours: duration, message: '该批次暂未开放开考。' }
  }
  const phase = windowPhase(input.now, input.opensAt, input.startClosesAt)
  if (phase === 'before') return { ok: false, durationHours: duration, message: '开始入口尚未开放。' }
  if (phase === 'closed') return { ok: false, durationHours: duration, message: '开考入口已关闭。' }
  if (phase !== 'open') return { ok: false, durationHours: duration, message: '暂时无法确认开考时间，请刷新重试。' }
  return { ok: true, durationHours: duration }
}

export function batchEnrollAllowed(status: string | null | undefined): boolean {
  return !status || status === 'OPEN'
}

/** Closing the start window does not hide an attempt that already began. */
export function attemptAccessibleAfterStartCloses(state: string): boolean {
  return state === 'ACTIVE' || state === 'FINALIZED' || state === 'EXPIRED'
}

function durationMentionPattern(): RegExp {
  return /(?<!\d)(24|48)(?!\d)\s*(?:个\s*)?(?:小时|小時|hours?|hrs?|h)(?![A-Za-z])/gi
}

export function explicitDurationMentions(description: string): ExamDurationHours[] {
  if (!description) return []
  const found: ExamDurationHours[] = []
  for (const match of description.matchAll(durationMentionPattern())) {
    const hours = Number(match[1])
    if (isDurationHours(hours)) found.push(hours)
  }
  return found
}

export function descriptionDurationConflicts(description: string, chosen: number | null): boolean {
  if (chosen === null || !Number.isFinite(chosen)) return false
  return explicitDurationMentions(description).some((hours) => hours !== chosen)
}

export function modelSourceLabel(source: string): string {
  if (source === 'reported') return '申报'
  if (source === 'detected') return '检测'
  if (source === 'unknown') return '未知'
  return source || '未标明'
}

export function coverageLabel(coverage: string): string {
  if (coverage === 'export') return '导出'
  if (coverage === 'partial') return '部分'
  return coverage || '未标明'
}

export function uploadStatusLabel(status: string): string {
  const key = status.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const labels: Record<string, string> = {
    AWAITING_FILES: '等待文件',
    UPLOADING: '正在接收',
    RECEIVING: '正在接收',
    IN_PROGRESS: '正在接收',
    TRANSFERRING: '正在接收',
    PENDING: '等待文件',
    RECEIVED: '文件已收齐',
    COMPLETE: '文件已收齐',
    COMPLETED: '文件已收齐',
    FAILED: '上传失败',
    ERROR: '上传失败',
    EXPIRED: '上传已过期',
    REVOKED: '上传已撤销',
    CANCELLED: '已取消',
    CANCELED: '已取消',
    REJECTED: '上传被拒绝',
  }
  return labels[key] ?? (status.trim() || '状态未知')
}

export function uploadFailed(status: string): boolean {
  const key = status.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return key === 'FAILED' || key === 'ERROR' || key === 'EXPIRED' || key === 'REVOKED' || key === 'CANCELLED' || key === 'CANCELED' || key === 'REJECTED'
}

export function countText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

export function display(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}


const auditLabels: Record<string, string> = {
 REGISTRATION_RESTRICT_START: '限制新开考', REGISTRATION_ALLOW_START: '解除开考限制', REGISTRATION_CLEAR_FLAG: '完成注册核查',
 LOGIN: '账号登录', REGISTER: '注册账号', RESET_PASSWORD: '重置密码',
 ROUND_CREATE: '创建招新轮次', BATCH_CREATE: '创建考核批次', BATCH_UPDATE: '更新考核批次',
 QUESTION_CREATE: '录入考核题目', QUESTION_UPDATE: '更新考核题目',
 ENROLL: '报名考核', ENROLLMENT_UPDATE: '调整报名', CONSENT: '确认材料授权',
 MCP_TOKEN_ROTATE: '更新 MCP 接入令牌', START: '开始考核', REPO_CONFIRM: '锁定仓库版本',
 APPROVE_MATERIALS: '批准材料上传', FINALIZE: '确认交卷', REVIEW: '保存评审',
 PUBLISH_RESULT: '发布考核成绩', EXTEND: '延长考核时间', EXPORT: '导出考核数据', PURGE_HISTORY: '按期清理材料'
}
export const auditLabel = (action: string): string => auditLabels[action] ?? action
