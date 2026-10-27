import { ref } from 'vue'

const offsetMs = ref(0)

export function syncServerNow(iso: string | null | undefined): void {
  if (!iso) return
  const server = new Date(iso).getTime()
  if (Number.isNaN(server)) return
  offsetMs.value = server - Date.now()
}

export function serverNow(): number {
  return Date.now() + offsetMs.value
}

export function useServerClock() {
  return { serverNow, syncServerNow, offsetMs }
}
