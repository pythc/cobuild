<script setup lang="ts">
import { NButton, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { downloadExport, fetchOverview } from '../../api/admin'
import { messageOf, saveBlob, safeFilename } from '../../api/http'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { countText, formatDateTime, auditLabel } from '../../lib/format'
import { readRecent, type RecentItem } from '../../lib/text'
import type { Overview } from '../../types'

const message = useMessage()
const loading = ref(true)
const error = ref('')
const overview = ref<Overview | null>(null)
const exporting = ref(false)

const cards = [
  { key: 'candidates', label: '候选人' },
  { key: 'batches', label: '批次' },
  { key: 'active', label: '考核中' },
  { key: 'finalized', label: '已交卷' },
  { key: 'unreviewed', label: '待评审' },
] as const

const recent = computed<RecentItem[]>(() => (overview.value?.recent ?? []).map((item, index) => readRecent(item, index)))

function formatMeta(meta: string): string {
  if (!meta) return ''
  return meta
    .split(' · ')
    .map((part) => (/^\d{4}-\d{2}-\d{2}T/.test(part) ? formatDateTime(part) : part))
    .join(' · ')
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    overview.value = await fetchOverview()
  } catch (cause) {
    overview.value = null
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function exportCsv(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const file = await downloadExport()
    if (file.blob.size === 0) {
      message.error('服务器返回了空文件')
      return
    }
    saveBlob(file.blob, safeFilename(file.filename || '110lab-export.csv', '110lab-export.csv'))
    message.success('已开始下载')
  } catch (cause) {
    message.error(messageOf(cause))
  } finally {
    exporting.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section>
    <PageHeader title="运营工作台">
      <template #actions>
        <n-button :loading="exporting" @click="exportCsv">导出 CSV</n-button>
      </template>
    </PageHeader>
    <StateBlock :loading="loading" :error="error" empty-title="" @retry="load">
      <div v-if="overview" class="stack">
        <div class="stats">
          <article v-for="card in cards" :key="card.key" class="stat">
            <span>{{ card.label }}</span>
            <b class="num">{{ countText(overview.counts[card.key]) }}</b>
          </article>
        </div>
        <article class="card">
          <h2>近期动态</h2>
          <p v-if="recent.length === 0" class="muted" style="margin-top: 8px">暂无近期动态。</p>
          <ul v-else class="file-list">
            <li v-for="item in recent" :key="item.key" class="file-row">
              <div>
                <strong>{{ auditLabel(item.title) }}</strong>
                <div v-if="item.meta" class="tiny">{{ formatMeta(item.meta) }}</div>
                <pre v-if="item.detail && item.detail !== '—'" class="pre">{{ item.detail }}</pre>
              </div>
            </li>
          </ul>
        </article>
      </div>
    </StateBlock>
  </section>
</template>
