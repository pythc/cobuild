<script setup lang="ts">
import { NButton } from 'naive-ui'

defineProps<{
  loading?: boolean
  error?: string
  empty?: boolean
  emptyTitle?: string
  emptyText?: string
}>()

defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" class="state-block" role="status">
    <h2>正在加载…</h2>
  </div>
  <div v-else-if="error" class="state-block" role="alert">
    <h2>加载失败</h2>
    <p>{{ error }}</p>
    <div class="row">
      <n-button type="primary" @click="$emit('retry')">重试</n-button>
    </div>
  </div>
  <div v-else-if="empty" class="state-block">
    <h2>{{ emptyTitle || '这里还没有内容' }}</h2>
    <p v-if="emptyText">{{ emptyText }}</p>
  </div>
  <slot v-else />
</template>
