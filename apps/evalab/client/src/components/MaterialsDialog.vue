<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { fetchMaterials } from '../api/admin'
import { messageOf, safeFilename } from '../api/http'
import { formatBytes, formatDateTime } from '../lib/format'
import { materialDownloadHref, materialFilePath } from '../lib/materials'
import type { MaterialFileBody, MaterialPayload } from '../types'
import ManifestView from './ManifestView.vue'

const props = defineProps<{
  show: boolean
  enrollmentId: string
}>()

const emit = defineEmits<{ 'update:show': [boolean] }>()

const loading = ref(false)
const error = ref('')
const payload = ref<MaterialPayload | null>(null)
const receipt = ref<Record<string, unknown> | null>(null)
const bound = ref<boolean | undefined>(undefined)
const purged = ref(false)
const selected = ref('')
const expanded = ref(false)

const open = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
})

function schemaVersionOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

const version = computed(() => schemaVersionOf(payload.value?.schemaVersion))
const direct = computed(() => {
  if (version.value >= 2) return true
  if (version.value === 1) return false
  const files = payload.value?.files ?? []
  return files.length > 0 && files.every((file) => {
    const row = file as { content?: unknown; downloadUrl?: unknown }
    return typeof row.content !== 'string' && typeof row.downloadUrl === 'string' && row.downloadUrl.length > 0
  })
})

const legacyFiles = computed(() => {
  if (direct.value || purged.value) return []
  return (payload.value?.files ?? []).filter((file): file is MaterialFileBody => {
    return typeof (file as MaterialFileBody).content === 'string'
  })
})

const directFiles = computed(() => {
  if (!direct.value || purged.value) return []
  return (payload.value?.files ?? []).map((file) => {
    const row = file as Partial<MaterialFileBody> & { id?: unknown; bytes?: unknown; sha256?: unknown; downloadUrl?: unknown; name?: unknown }
    const id = typeof row.id === 'string' ? row.id : ''
    const downloadUrl = typeof row.downloadUrl === 'string' ? row.downloadUrl : ''
    const href = (downloadUrl && materialDownloadHref(downloadUrl)) || (id ? materialFilePath(props.enrollmentId, id) : null)
    return {
      id,
      name: typeof row.name === 'string' && row.name ? row.name : '未命名文件',
      bytes: typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? row.bytes : 0,
      sha256: typeof row.sha256 === 'string' ? row.sha256 : '',
      href,
    }
  })
})

const current = computed(() => legacyFiles.value.find((file) => file.name === selected.value) ?? null)
const preview = computed(() => {
  if (direct.value) return { text: '', clipped: false }
  const content = current.value?.content ?? ''
  if (content.includes('\u0000')) return { text: '此文件不是可阅读的文本。', clipped: false }
  const safe = content
  if (!expanded.value && safe.length > 200000) {
    return { text: safe.slice(0, 200000), clipped: true }
  }
  return { text: safe, clipped: false }
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  selected.value = ''
  expanded.value = false
  try {
    const doc = await fetchMaterials(props.enrollmentId)
    payload.value = doc.payload
    receipt.value = doc.receipt
    bound.value = doc.bound
    purged.value = doc.purged === true
  } catch (cause) {
    payload.value = null
    receipt.value = null
    bound.value = undefined
    purged.value = false
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.show,
  (visible) => {
    if (visible) void load()
  },
)

const timeKeys = new Set(['receivedAt', 'submittedAt', 'expiresAt'])

function receiptText(key: string): string {
  const value = receipt.value?.[key]
  if (typeof value !== 'string' || !value) return ''
  return timeKeys.has(key) ? formatDateTime(value) : value
}

const hasDocument = computed(() => Boolean(payload.value || receipt.value))
</script>

<template>
  <n-modal
    v-model:show="open"
    preset="card"
    title="材料与回执"
    :style="{ width: 'min(760px, calc(100vw - 24px))' }"
    :auto-focus="true"
    :trap-focus="true"
    :close-on-esc="true"
  >
    <div v-if="loading" role="status">正在读取材料…</div>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <n-button style="margin-top: 8px" @click="load">重试</n-button>
    </div>
    <div v-else-if="!hasDocument" class="muted">没有可查看的材料。</div>
    <div v-else class="stack">
      <p v-if="purged" class="banner warn">文件已按保留策略清除，下面只保留元数据。</p>
      <p v-else-if="bound === false" class="banner warn">材料已与当前仓库解绑。</p>
      <dl v-if="receipt" class="kv">
        <template v-for="key in ['id', 'sha256', 'sha', 'repoSha', 'materialsHash', 'receivedAt', 'submittedAt']" :key="key">
          <template v-if="receiptText(key)">
            <dt>{{ key }}</dt>
            <dd class="mono">{{ receiptText(key) }}</dd>
          </template>
        </template>
      </dl>
      <ManifestView
        v-if="payload?.manifest"
        :manifest="payload.manifest"
        :repo-sha="payload.repoSha"
      />
      <div v-if="direct && !purged">
        <h3 class="card-title">文件</h3>
        <p class="tiny">原始文件由浏览器直接下载，页面不会预先拉取内容。</p>
        <p v-if="directFiles.length === 0" class="muted">暂无文件。</p>
        <ul v-else class="file-list">
          <li v-for="file in directFiles" :key="file.id || file.name" class="file-row">
            <div>
              <strong>{{ file.name }}</strong>
              <div class="tiny">{{ formatBytes(file.bytes) }}<template v-if="file.sha256"> · {{ file.sha256 }}</template></div>
            </div>
            <a v-if="file.href" class="text-link" :href="file.href" :download="safeFilename(file.name, 'material')">下载</a>
            <span v-else class="tiny">下载地址不可用</span>
          </li>
        </ul>
      </div>
      <div v-else-if="!purged">
        <h3 class="card-title">文件正文</h3>
        <p v-if="legacyFiles.length === 0" class="muted">暂无正文。</p>
        <div v-else class="row" style="margin: 8px 0">
          <button
            v-for="file in legacyFiles"
            :key="file.name"
            type="button"
            class="choice"
            :aria-pressed="selected === file.name"
            @click="selected = file.name"
          >
            {{ file.name || '未命名文件' }}
          </button>
        </div>
        <pre v-if="current" class="pre" tabindex="0" aria-label="文件内容">{{ preview.text || '文件是空的。' }}</pre>
        <n-button v-if="preview.clipped" style="margin-top: 8px" @click="expanded = true">显示全部</n-button>
        <p v-if="preview.clipped" class="tiny">当前显示前 20 万字符。</p>
      </div>
    </div>
  </n-modal>
</template>
