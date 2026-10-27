const FILE_ID = /^[0-9a-f-]{8,}$/i

export function materialFilePath(enrollmentId: string, fileId: string): string | null {
  if (!FILE_ID.test(enrollmentId) || !FILE_ID.test(fileId)) return null
  return `/api/enrollments/${encodeURIComponent(enrollmentId)}/materials/files/${encodeURIComponent(fileId)}`
}

export function materialDownloadHref(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed || /[\s\\]/.test(trimmed) || trimmed.startsWith('//')) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed, window.location.origin)
  } catch {
    return null
  }
  if (parsed.origin !== window.location.origin) return null
  if (parsed.username || parsed.password) return null
  if (!/^\/api\/enrollments\/[^/]+\/materials\/files\/[^/]+$/.test(parsed.pathname)) return null
  for (const key of parsed.searchParams.keys()) {
    if (/token|authorization|secret/i.test(key)) return null
  }
  return `${parsed.pathname}${parsed.search}`
}
