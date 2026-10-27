<script setup lang="ts">
import { computed } from 'vue'
import { coverageLabel, formatBytes, modelSourceLabel } from '../lib/format'
import { isPathLike, maskValue } from '../lib/text'
import type { MaterialManifest } from '../types'

const props = defineProps<{
  manifest: MaterialManifest | null | undefined
  payloadHash?: string
  repoSha?: string
}>()

const files = computed(() => props.manifest?.files ?? [])
const clients = computed(() => props.manifest?.clients ?? [])

function entries(parameters?: Record<string, string | number | boolean | null>) {
  if (!parameters) return []
  return Object.keys(parameters)
    .sort()
    .map((key) => ({ key, value: maskValue(parameters[key] ?? null) }))
}
</script>

<template>
  <div>
    <p class="tiny">客户端与模型信息由考生申报，未经独立核验。</p>
    <div v-if="payloadHash || repoSha" class="kv" style="margin-top: 10px">
      <template v-if="repoSha">
        <dt>清单 SHA</dt>
        <dd class="mono">{{ repoSha }}</dd>
      </template>
      <template v-if="payloadHash">
        <dt>载荷摘要</dt>
        <dd class="mono">{{ payloadHash }}</dd>
      </template>
    </div>

    <section class="manifest-block">
      <h3>文件</h3>
      <p v-if="files.length === 0" class="muted">清单里没有文件。</p>
      <ul v-else class="file-list">
        <li v-for="file in files" :key="`${file.name}-${file.sha256}`" class="file-row">
          <div>
            <strong>{{ file.name || '未命名文件' }}</strong>
            <div class="tiny">
              {{ formatBytes(file.bytes) }} · {{ coverageLabel(String(file.coverage || '')) }}
              · {{ isPathLike(file.source || '') ? '来源已登记' : file.source || '来源未标明' }}
            </div>
          </div>
          <span class="tiny mono">{{ file.sha256 ? file.sha256.slice(0, 12) : '无摘要' }}</span>
        </li>
      </ul>
    </section>

    <section class="manifest-block">
      <h3>客户端与模型</h3>
      <p v-if="clients.length === 0" class="muted">没有客户端记录。</p>
      <div v-for="(client, index) in clients" :key="`${client.name}-${index}`" class="card" style="margin-top: 8px">
        <strong>{{ client.name || '未命名客户端' }}</strong>
        <span v-if="client.version" class="tiny"> {{ client.version }}</span>
        <ul class="file-list">
          <li v-for="(model, modelIndex) in client.models || []" :key="`${model.name}-${modelIndex}`">
            <div>{{ model.name || '未命名模型' }}</div>
            <div class="tiny">来源：{{ modelSourceLabel(String(model.source || '')) }}</div>
            <div v-if="entries(model.parameters).length" class="tiny">
              <span v-for="entry in entries(model.parameters)" :key="entry.key">{{ entry.key }}={{ entry.value }} </span>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <section class="manifest-block">
      <h3>项目摘要</h3>
      <p class="prose" style="font-size: 13px">{{ manifest?.projectSummary?.trim() || '未提供摘要' }}</p>
    </section>
    <section class="manifest-block">
      <h3>协作摘要</h3>
      <p class="prose" style="font-size: 13px">{{ manifest?.collaborationSummary?.trim() || '未提供摘要' }}</p>
    </section>
  </div>
</template>
