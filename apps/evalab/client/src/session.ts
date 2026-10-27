import { ref } from 'vue'
import { fetchMe } from './api/auth'
import { setCsrfToken } from './api/csrf'
import { ApiError } from './api/http'
import type { User } from './types'

const user = ref<User | null>(null)
const ready = ref(false)
const error = ref('')
let inflight: Promise<void> | null = null

async function load(force: boolean): Promise<void> {
  if (ready.value && !force) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const me = await fetchMe()
      user.value = me.user
      setCsrfToken(me.csrfToken)
      error.value = ''
    } catch (cause) {
      user.value = null
      setCsrfToken(null)
      if (cause instanceof ApiError && cause.status === 401) error.value = ''
      else error.value = cause instanceof ApiError ? cause.message : '无法确认登录状态'
    } finally {
      ready.value = true
      inflight = null
    }
  })()
  return inflight
}

export function ensureSession(): Promise<void> {
  return load(false)
}

export function retrySession(): Promise<void> {
  ready.value = false
  error.value = ''
  return load(true)
}

export function setSessionUser(next: User | null): void {
  user.value = next
  ready.value = true
  error.value = ''
}

export function clearSessionUser(): void {
  user.value = null
  setCsrfToken(null)
}

export function useSession() {
  return { user, ready, error, ensureSession, retrySession, setSessionUser, clearSessionUser }
}
