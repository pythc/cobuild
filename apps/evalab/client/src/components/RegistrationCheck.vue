<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { api, ApiError } from '../api/http'
import type { AltchaWidgetElement } from 'altcha'

type RegistrationChallenge = Exclude<Parameters<AltchaWidgetElement['configure']>[0]['challenge'], string | null | undefined>

const host = ref<HTMLDivElement | null>(null)
const checking = ref(false)
let widget: AltchaWidgetElement | null = null
let controller: AbortController | null = null
let generation = 0

function cancel(): void {
  generation += 1
  controller?.abort()
  widget?.remove()
  widget = null
  checking.value = false
}

async function verify(email: string): Promise<string> {
  cancel()
  const current = generation
  checking.value = true
  const signal = new AbortController()
  controller = signal
  const timeout = window.setTimeout(() => signal.abort(), 45_000)
  try {
    await import('altcha')
    // Use the shared request path so embedded pages carry their partitioned-cookie marker.
    const challenge = await api<RegistrationChallenge>(`/api/auth/registration-challenge?email=${encodeURIComponent(email.trim().toLowerCase())}`)
    if (current !== generation || signal.signal.aborted || !host.value) throw new Error('cancelled')
    const element = document.createElement('altcha-widget')
    widget = element
    host.value.appendChild(element)
    await customElements.whenDefined('altcha-widget')
    await element.configure({
      challenge,
      credentials: 'same-origin', display: 'invisible', auto: 'off', workers: 2,
      humanInteractionSignature: false, hideFooter: true, hideLogo: true,
    })
    const result = await element.verify({ controller: signal, minDuration: 300 })
    if (current !== generation || !result?.payload || signal.signal.aborted) throw new Error('verification failed')
    return result.payload
  } catch {
    throw new ApiError('安全验证未完成，请重试', 400, 'REGISTRATION_VERIFICATION')
  } finally {
    window.clearTimeout(timeout)
    if (current === generation) {
      checking.value = false
      widget?.remove()
      widget = null
    }
  }
}

onBeforeUnmount(cancel)
defineExpose({ verify, cancel })
</script>

<template>
  <div ref="host" class="registration-check" aria-live="polite">
    <span v-if="checking" class="tiny">正在安全验证…</span>
  </div>
</template>

<style scoped>
.registration-check:empty { display: none; }
.registration-check { grid-column: 1 / -1; }
</style>
