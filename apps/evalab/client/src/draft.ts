const PREFIX = '110lab-draft:'

export function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writeDraft(key: string, value: string): void {
  try {
    if (!value) sessionStorage.removeItem(PREFIX + key)
    else sessionStorage.setItem(PREFIX + key, value)
  } catch {
    // Session storage may be unavailable; the form still works in memory.
  }
}

export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(PREFIX + key)
  } catch {
    // Ignore storage failures.
  }
}
