const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}/

export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '［私钥已隐藏］')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-［已隐藏］')
    .replace(/ghp_[A-Za-z0-9]{8,}/g, 'ghp_［已隐藏］')
    .replace(/AKIA[0-9A-Z]{8,}/g, 'AKIA［已隐藏］')
}

export function maskValue(value: string | number | boolean | null): string {
  if (value === null) return '空'
  if (typeof value === 'boolean') return value ? '是' : '否'
  const text = String(value)
  if (SECRET.test(text)) return '已隐藏（疑似密钥）'
  return text.length > 180 ? `${text.slice(0, 180)}…` : text
}

export function isPathLike(value: string): boolean {
  return /[/\\]/.test(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('~')
}

export function emailError(input: string): string | null {
  const value = input.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '请输入有效邮箱'
  if (value.length > 120) return '邮箱过长'
  return null
}

export function passwordError(input: string): string | null {
  if (input.length < 8) return '密码至少 8 位'
  if (input.length > 72) return '密码不超过 72 位'
  if (!/[A-Za-z]/.test(input) || !/\d/.test(input)) return '密码需同时包含字母和数字'
  return null
}

export function phoneError(input: string): string | null {
  const value = input.trim().replace(/[\s-]/g, '')
  if (!/^\+?\d{6,20}$/.test(value)) return '请输入有效手机号'
  return null
}

export function normalizePhone(input: string): string {
  return input.trim().replace(/[\s-]/g, '')
}

export function personNameError(input: string): string | null {
  const value = input.trim()
  if (!value) return '请填写姓名'
  if (value.length > 40) return '姓名过长'
  return null
}

export function studentNoError(input: string): string | null {
  const value = input.trim()
  if (!/^[A-Za-z0-9]{4,32}$/.test(value)) return '学号需为 4–32 位字母或数字'
  return null
}

export function requiredText(input: string, label: string, max = 40): string | null {
  const value = input.trim()
  if (!value) return `请填写${label}`
  if (value.length > max) return `${label}过长`
  return null
}

export function repoUrlError(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return '请输入完整的 HTTPS 仓库地址'
  }
  if (url.protocol !== 'https:') return '仅支持 HTTPS 地址'
  if (url.username || url.password) return '地址中不能包含账号或令牌'
  const host = url.hostname.toLowerCase()
  const allowed = host === 'github.com' || host === 'www.github.com' || host === 'gitee.com' || host === 'www.gitee.com'
  if (!allowed) return '仅支持 GitHub 或 Gitee 的仓库地址'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '不支持 IP 地址'
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return '请填写具体仓库，例如 https://github.com/org/repo'
  if (parts.some((part) => part === '.' || part === '..')) return '仓库路径不安全'
  return null
}

export function branchError(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.length > 200 || /\s/.test(value) || value.includes('..') || value.startsWith('-')) {
    return '分支名不正确'
  }
  return null
}

export function formatDetails(details: unknown): string {
  if (details == null || details === '') return '—'
  const text = typeof details === 'string' ? details : safeStringify(details)
  return redactText(text)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '—'
  }
}

export interface RecentItem {
  key: string
  title: string
  meta: string
  detail: string
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function readRecent(item: unknown, index: number): RecentItem {
  if (!item || typeof item !== 'object') {
    return { key: String(index), title: '记录', meta: '', detail: '' }
  }
  const record = item as Record<string, unknown>
  const title = stringField(record, ['action', 'title', 'type', 'message']) || '记录'
  const actor = stringField(record, ['actorName', 'actor', 'name'])
  const time = stringField(record, ['createdAt', 'at', 'time'])
  const detailSource = record.details ?? record.detail ?? record.summary
  const detail = detailSource == null ? '' : formatDetails(detailSource)
  return {
    key: stringField(record, ['id']) || String(index),
    title,
    meta: [actor, time].filter(Boolean).join(' · '),
    detail,
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection copy below.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
