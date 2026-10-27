<script setup lang="ts">
import { computed } from 'vue'
import { pendingUploadBytes, uploadRatio } from '../lib/exam'
import { formatBytes, formatDateTime, uploadFailed, uploadStatusLabel } from '../lib/format'
import type { MaterialUpload } from '../types'

const props = defineProps<{
  upload: MaterialUpload
}>()

const pending = computed(() => pendingUploadBytes(props.upload))
const ratio = computed(() => uploadRatio(props.upload))
const percent = computed(() => Math.round(ratio.value * 1000) / 10)
const failed = computed(() => uploadFailed(props.upload.status))
const received = computed(() => {
  const key = props.upload.status.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return key === 'RECEIVED' || key === 'COMPLETE' || key === 'COMPLETED'
})
const label = computed(() => uploadStatusLabel(props.upload.status))
const tone = computed(() => (failed.value ? 'danger' : received.value ? 'ok' : 'warn'))
const described = computed(() => {
  if (props.upload.totalBytes <= 0) return `${label.value}，尚未申报体积`
  return `${label.value}，已接收 ${formatBytes(props.upload.receivedBytes)}，待接收 ${formatBytes(pending.value)}`
})
</script>

<template>
  <div class="stack">
    <p class="banner" :class="tone" role="status">{{ label }}</p>
    <div
      class="upload-meter"
      :data-failed="failed ? 'true' : undefined"
      role="progressbar"
      :aria-valuemin="0"
      :aria-valuemax="upload.totalBytes"
      :aria-valuenow="Math.min(upload.receivedBytes, upload.totalBytes)"
      :aria-valuetext="described"
    >
      <span :style="{ width: `${ratio * 100}%` }"></span>
    </div>
    <p class="tiny">
      <template v-if="upload.totalBytes > 0">已接收 {{ formatBytes(upload.receivedBytes) }} · 待接收 {{ formatBytes(pending) }} · 合计 {{ formatBytes(upload.totalBytes) }} · {{ percent }}%</template>
      <template v-else>已接收 {{ formatBytes(upload.receivedBytes) }} · 合计体积尚未申报</template>
      <template v-if="upload.expiresAt"> · 有效至 {{ formatDateTime(upload.expiresAt) }}</template>
    </p>
  </div>
</template>
