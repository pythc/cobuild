<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../lib/markdown'

const props = defineProps<{ source: string }>()
const rendered = computed(() => renderMarkdown(props.source))
</script>

<template>
  <div class="markdown-body" v-html="rendered" />
</template>

<style scoped>
.markdown-body { min-width: 0; max-width: 100%; line-height: 1.8; overflow-wrap: anywhere; white-space: normal; }
.markdown-body :deep(> :first-child) { margin-top: 0; }
.markdown-body :deep(> :last-child) { margin-bottom: 0; }
.markdown-body :deep(p), .markdown-body :deep(ul), .markdown-body :deep(ol) { margin: 0.75em 0; }
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3),
.markdown-body :deep(h4), .markdown-body :deep(h5), .markdown-body :deep(h6) {
  margin: 1.3em 0 0.5em; color: var(--ink); line-height: 1.45; font-weight: 650;
}
.markdown-body :deep(h1) { font-size: 1.55em; }
.markdown-body :deep(h2) { font-size: 1.3em; }
.markdown-body :deep(h3) { font-size: 1.15em; }
.markdown-body :deep(h4), .markdown-body :deep(h5), .markdown-body :deep(h6) { font-size: 1em; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.65em; }
.markdown-body :deep(li + li) { margin-top: 0.25em; }
.markdown-body :deep(li > ul), .markdown-body :deep(li > ol) { margin: 0.25em 0; }
.markdown-body :deep(blockquote) {
  margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid #93b4ee;
  background: #f0f5fd; border-radius: 0 8px 8px 0; color: var(--muted);
}
.markdown-body :deep(blockquote > :first-child) { margin-top: 0; }
.markdown-body :deep(blockquote > :last-child) { margin-bottom: 0; }
.markdown-body :deep(code) {
  padding: 0.15em 0.35em; border-radius: 4px; background: #eef2f7;
  font-family: var(--mono); font-size: 0.9em;
}
.markdown-body :deep(pre) {
  max-width: 100%; overflow-x: auto; margin: 1em 0; padding: 14px 16px;
  border: 1px solid var(--line); border-radius: 10px; background: #f5f7fb;
  line-height: 1.65; white-space: pre; overflow-wrap: normal; tab-size: 2;
}
.markdown-body :deep(pre code) { padding: 0; background: transparent; font-size: 0.9em; }
.markdown-body :deep(.markdown-table) { max-width: 100%; margin: 1em 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.markdown-body :deep(table) { width: 100%; border-collapse: collapse; font-size: 0.95em; }
.markdown-body :deep(th), .markdown-body :deep(td) { min-width: 100px; padding: 9px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
.markdown-body :deep(th) { background: #f0f4fa; font-weight: 650; }
.markdown-body :deep(tr:first-child th) { border-top: 0; }
.markdown-body :deep(tr:last-child td) { border-bottom: 0; }
.markdown-body :deep(th:first-child), .markdown-body :deep(td:first-child) { border-left: 0; }
.markdown-body :deep(th:last-child), .markdown-body :deep(td:last-child) { border-right: 0; }
.markdown-body :deep(img) { display: block; max-width: 100%; height: auto; margin: 0.75em 0; border-radius: 8px; }
.markdown-body :deep(hr) { margin: 1.5em 0; border: 0; border-top: 1px solid var(--line); }
</style>
