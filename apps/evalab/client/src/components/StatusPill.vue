<script setup lang="ts">
import { stateLabel, stateTone } from '../lib/format'

defineProps<{ state: string }>()
</script>

<template>
  <span class="pill" :data-tone="stateTone(state)">{{ stateLabel(state) }}</span>
</template>
