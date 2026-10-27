import { getCsrfToken, notifyUnauthorized, setCsrfToken } from './csrf'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const SILENT_401 = new Set([
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/email-code',
  '/api/auth/reset-password',
])

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message || '请求失败'
  return '请求失败'
}

function errorMessage(data: unknown, status: number): { message: string; code?: string } {
  let message = ''
  let code: string | undefined
  if (data && typeof data === 'object') {
    const body = data as { message?: unknown; code?: unknown }
    if (typeof body.message === 'string' && body.message.trim()) message = body.message.trim()
    if (typeof body.code === 'string' && body.code.trim()) code = body.code
  }
  if (!message) {
    if (status === 401) message = '登录已失效，请重新登录'
    else if (status === 403) message = '没有权限执行此操作'
    else if (status === 404) message = '内容不存在或已不可用'
    else if (status === 429) message = '操作过于频繁，请稍后再试'
    else if (status === 0) message = '网络异常，请稍后重试'
    else message = `请求失败（${status}）`
  }
  return code ? { message, code } : { message }
}

const JSON_TIMEOUT_MS = 20_000
const BLOB_TIMEOUT_MS = 60_000

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function fetchWithTimeout(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers(init.headers)
    if (window.parent !== window) headers.set('X-Lab-Embedded', '1')
    return await fetch(path, { ...init, headers, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('请求超时。请检查网络后重试。', 0, 'TIMEOUT')
    }
    throw new ApiError('网络异常，请稍后重试', 0)
  } finally {
    window.clearTimeout(timer)
  }
}

export async function api<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; json?: unknown; form?: FormData } = {},
): Promise<T> {
  const method = init.method ?? 'GET'
  const headers = new Headers()
  headers.set('Accept', 'application/json')
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  if (method !== 'GET') {
    const csrf = getCsrfToken()
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }
  const response = await fetchWithTimeout(path, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers,
    body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  }, JSON_TIMEOUT_MS)
  const data = await readBody(response)
  if (!response.ok) {
    const parsed = errorMessage(data, response.status)
    const pathOnly = path.split('?')[0] ?? path
    if (response.status === 401 && !SILENT_401.has(pathOnly)) {
      setCsrfToken(null)
      notifyUnauthorized()
    }
    throw new ApiError(parsed.message, response.status, parsed.code)
  }
  return data as T
}

export function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value)
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1] ?? null
}

export function safeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop()?.replace(/[^\w.\-\u4e00-\u9fff ()[\]]+/g, '_') ?? ''
  const trimmed = base.trim().slice(0, 180)
  return trimmed || fallback
}

export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const response = await fetchWithTimeout(path, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: '*/*' },
  }, BLOB_TIMEOUT_MS)
  if (!response.ok) {
    const data = await readBody(response)
    const parsed = errorMessage(data, response.status)
    if (response.status === 401) {
      setCsrfToken(null)
      notifyUnauthorized()
    }
    throw new ApiError(parsed.message, response.status, parsed.code)
  }
  const blob = await response.blob()
  const filename = filenameFromDisposition(response.headers.get('content-disposition'))
  return { blob, filename }
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = safeFilename(filename, 'download')
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}
