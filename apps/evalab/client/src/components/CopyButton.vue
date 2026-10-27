<script setup lang="ts">
import { NButton, useMessage } from 'naive-ui'
import { ref } from 'vue'
import { copyText } from '../lib/text'

const props = defineProps<{
  text: string
  label?: string
  disabled?: boolean
}>()

const message = useMessage()
const pending = ref(false)

async function copy(): Promise<void> {
  if (!props.text || props.disabled || pending.value) return
  pending.value = true
  const ok = await copyText(props.text)
  pending.value = false
  if (ok) message.success('已复制')
  else message.error('复制失败，请手动选择文本')
}
</script>

<template>
  <n-button size="small" :disabled="disabled || !text || pending" @click="copy">{{ label || '复制' }}</n-button>
</template>
