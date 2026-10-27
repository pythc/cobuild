<script setup lang="ts">
defineProps<{
  label: string
  forId: string
  error?: string
  hint?: string
}>()
</script>

<template>
  <div class="field" :class="{ invalid: !!error }">
    <label class="field-label" :for="forId">{{ label }}</label>
    <slot />
    <p v-if="error" :id="`${forId}-err`" class="field-error" role="alert">{{ error }}</p>
    <p v-else-if="hint" :id="`${forId}-hint`" class="field-hint">{{ hint }}</p>
  </div>
</template>
