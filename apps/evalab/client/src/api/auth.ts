import type { User } from '../types'
import { ApiError } from './http'
import { setCsrfToken } from './csrf'
import { api } from './http'

export interface AuthResult {
  user: User
  csrfToken: string
}

export async function fetchMe(): Promise<AuthResult> {
  const data = await api<AuthResult>('/api/auth/me')
  if (!data?.user || !data.csrfToken) throw new ApiError('登录状态数据无效', 500)
  return data
}

export async function login(account: string, password: string): Promise<AuthResult> {
  const data = await api<AuthResult>('/api/auth/login', {
    method: 'POST',
    json: { account, password },
  })
  setCsrfToken(data.csrfToken)
  return data
}

export async function register(body: {
  name: string
  studentNo: string
  college: string
  major: string
  phone: string
  email: string
  password: string
  challengeId: string
  code: string
  acceptedPolicy: true
  registrationContext?: 'ASSESSMENT' | 'ACCOUNT_TEAMING'
}): Promise<AuthResult> {
  const data = await api<AuthResult>('/api/auth/register', { method: 'POST', json: body })
  setCsrfToken(data.csrfToken)
  return data
}

export async function sendEmailCode(
  email: string,
  purpose: 'REGISTER' | 'RESET',
  registrationProof?: string,
): Promise<{ challengeId: string; expiresIn: number }> {
  return api('/api/auth/email-code', {
    method: 'POST',
    json: { email, purpose, ...(registrationProof ? { registrationProof } : {}) },
  })
}

export async function resetPassword(body: {
  email: string
  challengeId: string
  code: string
  password: string
}): Promise<{ ok: true }> {
  return api('/api/auth/reset-password', { method: 'POST', json: body })
}

export async function logout(): Promise<{ ok: true }> {
  return api('/api/auth/logout', { method: 'POST', json: {} })
}
