const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function connectRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : ''
}

export function connectReturnPath(requestId: string): string {
  return `/mcp/connect?request=${encodeURIComponent(requestId)}`
}

export function redirectQuery(value: unknown): { redirect: string } | Record<string, never> {
  if (typeof value !== 'string') return {}
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/login') || value.startsWith('/register')) {
    return {}
  }
  return { redirect: value }
}

export function landingPath(role: string | undefined, redirect: unknown): string {
  const value = typeof redirect === 'string' ? redirect : ''
  const safe =
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/login') &&
    !value.startsWith('/register')
  if (safe && value.startsWith('/api/public-identity/authorize?')) return value
  if (role === 'ADMIN') {
    if (safe && (value === '/admin' || value.startsWith('/admin/'))) return value
    return '/admin'
  }
  if (safe && !value.startsWith('/admin')) return value
  return '/recruitment'
}
