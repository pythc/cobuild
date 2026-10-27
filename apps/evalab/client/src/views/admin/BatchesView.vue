<script setup lang="ts">
import { NButton, NDatePicker, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { createBatch, createRound, fetchAdminBatches, fetchRounds, updateBatch, type BatchInput } from '../../api/admin'
import { type DeletionResult, type DeletionTarget } from '../../api/deletion'
import { messageOf } from '../../api/http'
import AdminDeleteDialog from '../../components/AdminDeleteDialog.vue'
import Field from '../../components/Field.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { batchStatusLabel, descriptionDurationConflicts, formatDateTime, parseBeijingInput, formatDurationHours, readDurationHours } from '../../lib/format'
import type { AdminBatch, AdminRound, BatchStatus } from '../../types'

const ROUND_NAME_MAX = 80

const message = useMessage()
const loading = ref(true)
const error = ref('')
const rounds = ref<AdminRound[]>([])
const batches = ref<AdminBatch[]>([])
const selectedRoundId = ref<string | null>(null)
const roundName = ref('')
const roundError = ref('')
const roundNotice = ref('')
const creatingRound = ref(false)
const createdRound = ref<AdminRound | null>(null)
let roundsRevision = 0
const editorOpen = ref(false)
const saving = ref(false)
const formError = ref('')
const editingId = ref<string | null>(null)
const name = ref('')
const description = ref('')
const descriptionMode = ref<'edit' | 'preview'>('edit')
const roundId = ref<string | null>(null)
const status = ref<BatchStatus>('DRAFT')
const opensAt = ref<string | null>(null)
const closesAt = ref<string | null>(null)
const durationHours = ref<number | null>(null)
const preservedDuration = ref<number | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<DeletionTarget | null>(null)

const statusOptions = [
  { label: '草稿', value: 'DRAFT' },
  { label: '开放', value: 'OPEN' },
  { label: '已关闭', value: 'CLOSED' },
]
const durationOptions = computed(() => {
  const options = [
    { label: '24 小时', value: 24 },
    { label: '48 小时', value: 48 },
  ]
  const preserved = preservedDuration.value
  if (preserved !== null && preserved !== 24 && preserved !== 48) {
    options.unshift({ label: `${preserved} 小时`, value: preserved })
  }
  return options
})
const durationConflict = computed(() => descriptionDurationConflicts(description.value, durationHours.value))
const descriptionInputProps = computed(() => (
  durationConflict.value ? { 'aria-describedby': 'batch-duration-conflict' } : {}
))
const roundOptions = computed(() => rounds.value.map((round) => ({ label: round.name, value: round.id })))
const roundFormLocked = computed(() => loading.value || creatingRound.value || !!error.value)
const canCreateBatch = computed(() => !roundFormLocked.value && rounds.value.length > 0)
const selectedRound = computed(() => rounds.value.find((round) => round.id === selectedRoundId.value) ?? null)
const batchHeading = computed(() => selectedRound.value?.name ?? '全部轮次')
const visibleBatches = computed(() => {
  const round = selectedRound.value
  if (!round) return batches.value
  return batches.value.filter((batch) => batch.roundId === round.id)
})
const batchCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const batch of batches.value) counts.set(batch.roundId, (counts.get(batch.roundId) ?? 0) + 1)
  return counts
})
const roundNameInputProps = computed(() => {
  const describedBy = roundError.value ? 'round-name-err' : roundNotice.value ? 'round-name-hint' : ''
  return {
    id: 'round-name',
    maxlength: ROUND_NAME_MAX,
    'aria-invalid': !!roundError.value,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  }
})

watch(roundName, () => {
  roundError.value = ''
  roundNotice.value = ''
})

async function load(): Promise<void> {
  const revision = roundsRevision
  loading.value = true
  error.value = ''
  try {
    const [roundRows, batchRows] = await Promise.all([fetchRounds(), fetchAdminBatches()])
    const fetched = roundRows.slice().reverse()
    if (revision === roundsRevision) {
      rounds.value = fetched
    } else {
      const fetchedIds = new Set(fetched.map((round) => round.id))
      const kept = rounds.value.filter((round) => !fetchedIds.has(round.id))
      rounds.value = [...kept, ...fetched]
    }
    batches.value = batchRows
    if (selectedRoundId.value && !rounds.value.some((round) => round.id === selectedRoundId.value)) {
      selectedRoundId.value = null
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function roundNameError(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return '请填写轮次名称'
  if (trimmed.length > ROUND_NAME_MAX) return '轮次名称不能超过 80 个字'
  return ''
}

async function addRound(): Promise<void> {
  if (roundFormLocked.value) return
  const trimmed = roundName.value.trim()
  const invalid = roundNameError(roundName.value)
  if (invalid) {
    roundNotice.value = ''
    roundError.value = invalid
    return
  }
  const existing = rounds.value.find((round) => round.name.trim() === trimmed)
  if (existing) {
    selectedRoundId.value = existing.id
    roundError.value = ''
    roundNotice.value = '已有同名轮次，已选中'
    return
  }
  creatingRound.value = true
  roundError.value = ''
  roundNotice.value = ''
  try {
    const created = await createRound(trimmed)
    roundsRevision += 1
    rounds.value = [created, ...rounds.value.filter((round) => round.id !== created.id)]
    selectedRoundId.value = created.id
    createdRound.value = created
    roundName.value = ''
    message.success('轮次已创建')
  } catch (cause) {
    roundError.value = messageOf(cause)
  } finally {
    creatingRound.value = false
  }
}

function openCreate(explicitRoundId?: string): void {
  if (!canCreateBatch.value) return
  const explicit = typeof explicitRoundId === 'string'
    && rounds.value.some((round) => round.id === explicitRoundId)
    ? explicitRoundId
    : null
  editingId.value = null
  name.value = ''
  description.value = ''
  descriptionMode.value = 'edit'
  roundId.value = explicit ?? selectedRound.value?.id ?? rounds.value[0]?.id ?? null
  status.value = 'DRAFT'
  opensAt.value = null
  closesAt.value = null
  durationHours.value = null
  preservedDuration.value = null
  formError.value = ''
  editorOpen.value = true
}

function openEdit(batch: AdminBatch): void {
  editingId.value = batch.id
  name.value = batch.name
  description.value = batch.description
  descriptionMode.value = 'edit'
  roundId.value = batch.roundId
  status.value = batch.status
  opensAt.value = formatDateTime(batch.opensAt).replaceAll('/', '-')
  closesAt.value = formatDateTime(batch.startClosesAt).replaceAll('/', '-')
  const hours = readDurationHours(batch.durationHours)
  durationHours.value = hours
  preservedDuration.value = hours
  formError.value = ''
  editorOpen.value = true
}

async function save(): Promise<void> {
  if (!name.value.trim()) {
    formError.value = '请填写批次名称'
    return
  }
  if (!roundId.value) {
    formError.value = '请选择轮次'
    return
  }
  const openIso = parseBeijingInput(opensAt.value)
  const closeIso = parseBeijingInput(closesAt.value)
  if (!openIso || !closeIso) {
    formError.value = '请填写开放时间和开始截止时间'
    return
  }
  if (closeIso <= openIso) {
    formError.value = '开始截止时间需要晚于开放时间'
    return
  }
  const selectedDuration = durationToSave()
  if (selectedDuration === null) {
    formError.value = '请选择 24 或 48 小时'
    return
  }
  const body: BatchInput = {
    roundId: roundId.value,
    name: name.value.trim(),
    description: description.value.trim(),
    opensAt: openIso,
    startClosesAt: closeIso,
    durationHours: selectedDuration,
    status: status.value,
  }
  saving.value = true
  formError.value = ''
  try {
    if (editingId.value) await updateBatch(editingId.value, body)
    else await createBatch(body)
    editorOpen.value = false
    await load()
    message.success('批次已保存')
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}

function durationToSave(): number | null {
  const value = durationHours.value
  if (value === 24 || value === 48) return value
  return null
}

function openDelete(target: DeletionTarget): void {
  deleteTarget.value = target
  deleteOpen.value = true
}

async function onDeleted(result: DeletionResult): Promise<void> {
  if (result.ok !== true) return
  if (result.kind === 'round') {
    if (createdRound.value?.id === result.id) createdRound.value = null
    if (selectedRoundId.value === result.id) selectedRoundId.value = null
  }
  message.success(result.kind === 'round' ? '轮次已删除' : '批次已删除')
  await load()
  if (result.kind === 'round') {
    rounds.value = rounds.value.filter((round) => round.id !== result.id)
    batches.value = batches.value.filter((batch) => batch.roundId !== result.id)
    if (selectedRoundId.value === result.id) selectedRoundId.value = null
  } else if (result.kind === 'batch') {
    batches.value = batches.value.filter((batch) => batch.id !== result.id)
  }
}
</script>

<template>
  <section>
    <PageHeader title="考核批次">
      <template #actions>
        <n-button type="primary" :disabled="!canCreateBatch" @click="openCreate()">新建批次</n-button>
      </template>
    </PageHeader>
    <div class="card round-panel">
      <div class="card-head">
        <h2>轮次</h2>
        <n-button
          v-if="selectedRound"
          size="small"
          type="error"
          quaternary
          attr-type="button"
          :aria-label="`删除轮次 ${selectedRound.name}`"
          @click="openDelete({ kind: 'round', id: selectedRound.id, action: '删除轮次' })"
        >删除轮次</n-button>
      </div>
      <form class="round-form" @submit.prevent="addRound">
        <Field class="round-field" label="轮次名称" for-id="round-name" :error="roundError" :hint="roundNotice">
          <n-input
            v-model:value="roundName"
            class="round-name"
            placeholder="例如 2026 秋季招新"
            :disabled="roundFormLocked"
            :maxlength="ROUND_NAME_MAX"
            :input-props="roundNameInputProps"
          />
        </Field>
        <n-button attr-type="submit" :loading="creatingRound" :disabled="roundFormLocked">创建轮次</n-button>
      </form>
      <p v-if="createdRound" class="banner ok created-banner" role="status">
        已创建轮次「{{ createdRound.name }}」。
        <button type="button" class="inline-action" :disabled="!canCreateBatch" @click="openCreate(createdRound.id)">新建批次</button>
      </p>
      <div v-if="rounds.length" class="round-list" role="group" aria-label="轮次筛选">
        <button
          type="button"
          class="round-chip"
          :aria-pressed="!selectedRound"
          @click="selectedRoundId = null"
        >
          <span class="round-chip-name">全部轮次</span>
          <span class="round-chip-count num">{{ batches.length }} 个批次</span>
        </button>
        <button
          v-for="round in rounds"
          :key="round.id"
          type="button"
          class="round-chip"
          :aria-pressed="selectedRound?.id === round.id"
          @click="selectedRoundId = round.id"
        >
          <span class="round-chip-name">{{ round.name }}</span>
          <span class="round-chip-count num">{{ batchCounts.get(round.id) ?? 0 }} 个批次</span>
        </button>
      </div>
      <p v-else-if="!loading && !error" class="tiny round-empty">还没有轮次</p>
    </div>
    <StateBlock :loading="loading" :error="error" @retry="load">
      <div class="table-wrap card">
        <div v-if="rounds.length" class="batch-head">
          <h2>{{ batchHeading }}</h2>
        </div>
        <div v-if="visibleBatches.length === 0" class="state-block">
          <h2>{{ selectedRound ? '本轮次还没有批次' : '还没有批次' }}</h2>
          <p v-if="!selectedRound && rounds.length === 0">先创建轮次，再新建批次。</p>
          <div v-if="rounds.length" class="row">
            <n-button type="primary" :disabled="!canCreateBatch" @click="openCreate(selectedRound ? selectedRound.id : undefined)">新建批次</n-button>
          </div>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>批次</th>
              <th>轮次</th>
              <th>开放</th>
              <th>最晚开考时间</th>
              <th>时长</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in visibleBatches" :key="batch.id">
              <td>
                <strong>{{ batch.name }}</strong>
                <div v-if="batch.description" class="batch-note">
                  <MarkdownContent :source="batch.description" />
                </div>
              </td>
              <td>{{ batch.roundName || '—' }}</td>
              <td>{{ formatDateTime(batch.opensAt) }}</td>
              <td>{{ formatDateTime(batch.startClosesAt) }}</td>
              <td class="num compact-cell">{{ formatDurationHours(batch.durationHours) }}</td>
              <td class="compact-cell">{{ batchStatusLabel(batch.status) }}</td>
              <td>
                <div class="row">
                  <n-button size="small" @click="openEdit(batch)">编辑</n-button>
                  <n-button
                    size="small"
                    type="error"
                    quaternary
                    attr-type="button"
                    @click="openDelete({ kind: 'batch', id: batch.id, action: '删除批次' })"
                  >删除</n-button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <n-modal
      v-model:show="editorOpen"
      preset="card"
      :title="editingId ? '编辑批次' : '新建批次'"
      :style="{ width: 'min(560px, calc(100vw - 24px))' }"
      :auto-focus="true"
      :trap-focus="true"
      :close-on-esc="!saving"
      :mask-closable="!saving"
    >
      <form class="form-grid" @submit.prevent="save">
        <p v-if="formError" class="banner danger" role="alert">{{ formError }}</p>
        <Field label="名称" for-id="batch-name">
          <n-input id="batch-name" v-model:value="name" />
        </Field>
        <Field label="说明（支持 Markdown）" for-id="batch-desc">
          <div class="md-field">
            <div class="md-switch" role="group" aria-label="说明编辑或预览">
              <button type="button" :aria-pressed="descriptionMode === 'edit'" @click="descriptionMode = 'edit'">编辑</button>
              <button type="button" :aria-pressed="descriptionMode === 'preview'" @click="descriptionMode = 'preview'">预览</button>
            </div>
            <n-input
              v-show="descriptionMode === 'edit'"
              id="batch-desc"
              v-model:value="description"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 6 }"
              :input-props="descriptionInputProps"
            />
            <div v-if="descriptionMode === 'preview'" class="md-preview">
              <MarkdownContent v-if="description.trim()" :source="description" />
              <p v-else class="muted">暂无内容</p>
            </div>
          </div>
        </Field>
        <p v-if="durationConflict" id="batch-duration-conflict" class="banner warn" role="status">
          说明里的 24/48 小时与所选时长不一致。保存不会改写说明。
        </p>
        <Field label="轮次" for-id="batch-round">
          <n-select id="batch-round" v-model:value="roundId" :options="roundOptions" placeholder="选择轮次" />
        </Field>
        <Field label="开放时间（北京时间）" for-id="batch-open">
          <n-date-picker id="batch-open" v-model:formatted-value="opensAt" value-format="yyyy-MM-dd HH:mm" type="datetime" format="yyyy-MM-dd HH:mm" clearable style="width: 100%" />
        </Field>
        <Field label="最晚开考时间（北京时间）" for-id="batch-close" hint="此时间之后不能再开始，已开始的答卷按各自截止时间结束。">
          <n-date-picker id="batch-close" v-model:formatted-value="closesAt" value-format="yyyy-MM-dd HH:mm" type="datetime" format="yyyy-MM-dd HH:mm" clearable style="width: 100%" />
        </Field>
        <Field label="考核时长" for-id="batch-duration" hint="修改时长只影响尚未开考的报名。">
          <n-select id="batch-duration" v-model:value="durationHours" :options="durationOptions" placeholder="选择 24 或 48 小时" />
        </Field>
        <Field label="状态" for-id="batch-status">
          <n-select id="batch-status" v-model:value="status" :options="statusOptions" />
        </Field>
        <div class="row">
          <n-button attr-type="submit" type="primary" :loading="saving">保存</n-button>
          <n-button :disabled="saving" @click="editorOpen = false">取消</n-button>
        </div>
      </form>
    </n-modal>
    <AdminDeleteDialog v-model:show="deleteOpen" :target="deleteTarget" @deleted="onDeleted" />
  </section>
</template>

<style scoped>
.compact-cell { white-space: nowrap; }
.round-panel { margin-bottom: 12px; }
.round-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
}
.round-field { flex: 1 1 220px; min-width: 0; }
.round-name { width: 100%; }
.created-banner { margin-top: 12px; overflow-wrap: anywhere; }
.inline-action {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.inline-action:disabled { opacity: 0.55; cursor: not-allowed; }
.round-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.round-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 34px;
  padding: 4px 10px 4px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: #fff;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
}
.round-chip:hover { border-color: var(--cobalt); }
.round-chip[aria-pressed="true"] {
  border-color: var(--cobalt);
  background: var(--cobalt-soft);
  color: var(--cobalt-deep);
  font-weight: 650;
}
.round-chip-name { overflow-wrap: anywhere; }
.round-chip-count {
  flex: none;
  color: var(--faint);
  font-size: 12px;
  font-weight: 600;
}
.round-chip[aria-pressed="true"] .round-chip-count { color: var(--cobalt-deep); }
.round-empty { margin-top: 10px; }
.batch-head { margin-bottom: 12px; }
.batch-note {
  margin-top: 4px;
  color: var(--faint);
  font-size: 12px;
  line-height: 1.45;
  min-width: 0;
  overflow-wrap: anywhere;
}
.md-field { display: grid; gap: 8px; min-width: 0; }
.md-switch {
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #f8fafc;
}
.md-switch button {
  appearance: none;
  border: 0;
  background: transparent;
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.md-switch button[aria-pressed="true"] {
  background: #fff;
  color: var(--cobalt-deep);
  box-shadow: 0 0 0 1px var(--line);
}
.md-preview {
  min-height: 72px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
