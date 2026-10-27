import { api } from './http'

export interface RegistrationRisk {
  userId: string
  reasons: string[]
  reviewState: 'PENDING' | 'CLEARED'
  startRestricted: boolean
  restrictionReason: string | null
}

export async function fetchRegistrationRisks(ids: string[]): Promise<RegistrationRisk[]> {
  if (!ids.length) return []
  const data = await api<{ risks: RegistrationRisk[] }>(`/api/admin/registration-risk?ids=${encodeURIComponent(ids.join(','))}`)
  return data.risks
}

export async function changeRegistrationRisk(userId: string, action: 'RESTRICT_START' | 'ALLOW_START' | 'CLEAR_FLAG', reason: string): Promise<void> {
  await api(`/api/admin/candidates/${userId}/registration-risk`, { method: 'PATCH', json: { action, reason } })
}
