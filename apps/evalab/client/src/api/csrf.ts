let csrfToken: string | null = null
let onUnauthorized: (() => void) | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function getCsrfToken(): string | null {
  return csrfToken
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

export function notifyUnauthorized(): void {
  onUnauthorized?.()
}
