<script setup lang="ts">
import { NButton, NInput, NModal } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  DELETION_CONFIRMATION,
  deletionFailureMessage,
  deleteAdminRecord,
  fetchDeletionPreview,
  isStaleDeletionPreview,
  type DeletionPreview,
  type DeletionResult,
  type DeletionTarget,
} from '../api/deletion'
import { messageOf } from '../api/http'
import Field from './Field.vue'

const props = defineProps<{
  show: boolean
  target: DeletionTarget | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  deleted: [result: DeletionResult]
}>()

const COUNT_ROWS = [
  { key: 'batches', label: '批次' },
  { key: 'questions', label: '题目' },
  { key: 'enrollments', label: '报名' },
  { key: 'materials', label: '材料' },
  { key: 'files', label: '文件' },
] as const

const loading = ref(false)
const deleting = ref(false)
const preview = ref<DeletionPreview | null>(null)
const loadError = ref('')
const actionError = ref('')
const confirmation = ref('')
const previewStale = ref(false)
let serial = 0

const busy = computed(() => loading.value || deleting.value)
const open = computed({
  get: () => props.show,
  set: (value: boolean) => {
    if (!value && deleting.value) return
    emit('update:show', value)
  },
})
const visibleCounts = computed(() => COUNT_ROWS.filter((row) => (preview.value?.counts[row.key] ?? 0) > 0))
const canSubmit = computed(() => {
  const current = preview.value
  return !!current
    && current.allowed
    && !previewStale.value
    && !busy.value
    && confirmation.value === DELETION_CONFIRMATION
})

function sameTarget(token: number, target: DeletionTarget): boolean {
  return token === serial
    && props.show
    && props.target?.kind === target.kind
    && props.target.id === target.id
}

async function loadPreview(token: number, target: DeletionTarget): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const next = await fetchDeletionPreview(target.kind, target.id)
    if (!sameTarget(token, target)) return
    preview.value = next
    previewStale.value = false
    actionError.value = ''
    confirmation.value = ''
  } catch (cause) {
    if (!sameTarget(token, target)) return
    loadError.value = messageOf(cause)
  } finally {
    if (token === serial) loading.value = false
  }
}

function refresh(): void {
  const target = props.target
  if (!props.show || !target || deleting.value) return
  const token = ++serial
  confirmation.value = ''
  previewStale.value = true
  void loadPreview(token, target)
}

watch(
  () => [props.show, props.target?.kind ?? '', props.target?.id ?? ''] as const,
  () => {
    if (deleting.value) return
    const token = ++serial
    const target = props.target
    if (!props.show || !target) {
      loading.value = false
      return
    }
    confirmation.value = ''
    actionError.value = ''
    previewStale.value = false
    loadError.value = ''
    preview.value = null
    void loadPreview(token, target)
  },
)

onBeforeUnmount(() => {
  serial += 1
})

function requestClose(): void {
  if (deleting.value) return
  emit('update:show', false)
}

async function submitDelete(): Promise<void> {
  const target = props.target
  const current = preview.value
  if (!target || !current || busy.value || previewStale.value || !current.allowed) return
  if (current.kind !== target.kind || current.id !== target.id) return
  if (confirmation.value !== DELETION_CONFIRMATION) return
  const fingerprint = current.fingerprint
  deleting.value = true
  actionError.value = ''
  try {
    const result = await deleteAdminRecord(target.kind, target.id, fingerprint)
    if (result.ok !== true) {
      actionError.value = '删除没有完成'
      return
    }
    emit('deleted', result)
    emit('update:show', false)
  } catch (cause) {
    actionError.value = deletionFailureMessage(cause)
    if (isStaleDeletionPreview(cause)) previewStale.value = true
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="open"
    preset="card"
    :title="target?.action || '删除'"
    :style="{ width: 'min(520px, calc(100vw - 24px))' }"
    :auto-focus="true"
    :trap-focus="true"
    :closable="!deleting"
    :close-on-esc="!deleting"
    :mask-closable="!deleting"
  >
    <div v-if="loading && !preview" role="status">正在读取删除预览…</div>
    <div v-else-if="!preview" class="form-grid">
      <p class="banner danger" role="alert">{{ loadError || '没有读到删除预览。' }}</p>
      <div class="row">
        <n-button v-if="target" :disabled="busy" @click="refresh">重试</n-button>
        <n-button :disabled="deleting" @click="requestClose">关闭</n-button>
      </div>
    </div>
    <div v-else class="form-grid">
      <p class="delete-title">{{ preview.title || '未命名' }}</p>
      <div v-if="visibleCounts.length">
        <h3 class="card-title">关联记录</h3>
        <dl class="kv">
          <template v-for="row in visibleCounts" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd class="num">{{ preview.counts[row.key] }}</dd>
          </template>
        </dl>
      </div>
      <div v-if="preview.consequences.length">
        <h3 class="card-title">删除范围</h3>
        <ul class="delete-notes">
          <li v-for="(line, index) in preview.consequences" :key="index">{{ line }}</li>
        </ul>
      </div>
      <p v-if="!preview.allowed" class="banner danger" role="alert">{{ preview.reason || '当前不能删除。' }}</p>
      <p v-if="loading" class="tiny" role="status">正在刷新预览…</p>
      <p v-if="loadError" class="banner danger" role="alert">{{ loadError }}</p>
      <p v-if="actionError" class="banner danger" role="alert">{{ actionError }}</p>
      <form v-if="preview.allowed" class="form-grid" @submit.prevent="submitDelete">
        <Field label="确认删除" for-id="admin-delete-confirm" hint="此操作不可恢复，请输入“删除”确认。">
          <n-input
            id="admin-delete-confirm"
            v-model:value="confirmation"
            :disabled="busy"
            autocomplete="off"
            placeholder="删除"
          />
        </Field>
        <div class="row">
          <n-button attr-type="submit" type="error" :loading="deleting" :disabled="!canSubmit">
            {{ target?.action || '删除' }}
          </n-button>
          <n-button attr-type="button" :loading="loading" :disabled="busy" @click="refresh">刷新预览</n-button>
          <n-button attr-type="button" :disabled="deleting" @click="requestClose">取消</n-button>
        </div>
      </form>
      <div v-else class="row">
        <n-button :loading="loading" :disabled="busy" @click="refresh">刷新预览</n-button>
        <n-button :disabled="deleting" @click="requestClose">关闭</n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.delete-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.card-title { margin: 0; }
.delete-notes {
  margin: 6px 0 0;
  padding-left: 1.15em;
  font-size: 13px;
}
.delete-notes li + li { margin-top: 4px; }
</style>
