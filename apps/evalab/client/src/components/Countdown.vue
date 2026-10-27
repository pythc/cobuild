<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { serverNow } from '../clock'
import { formatRemain } from '../lib/format'

const props = defineProps<{
  deadline: string | null
  prefix?: string
}>()

const now = ref(serverNow())
let timer = 0

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = serverNow()
  }, 1000)
})

onUnmounted(() => window.clearInterval(timer))

const remain = computed(() => {
  if (!props.deadline) return null
  const deadline = new Date(props.deadline).getTime()
  if (!Number.isFinite(deadline)) return null
  return deadline - now.value
})

const text = computed(() => {
  if (remain.value === null) return props.deadline ? '时间无效' : '未开始'
  if (remain.value <= 0) return '已截止'
  return formatRemain(remain.value)
})

const urgent = computed(() => remain.value !== null && remain.value > 0 && remain.value < 60 * 60 * 1000)
</script>

<template>
  <p class="timer" :data-urgent="urgent ? 'true' : undefined" role="timer">
    <span class="tiny">{{ prefix || '剩余时间' }}</span>
    <strong class="num">{{ text }}</strong>
  </p>
</template>
