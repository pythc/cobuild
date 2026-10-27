<script setup lang="ts">
import { NButton, NInput, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { createQuestion, fetchAdminBatches, fetchQuestions, updateQuestion, uploadAttachment } from '../../api/admin'
import { type DeletionResult, type DeletionTarget } from '../../api/deletion'
import { messageOf } from '../../api/http'
import AdminDeleteDialog from '../../components/AdminDeleteDialog.vue'
import Field from '../../components/Field.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { clearDraft, readDraft, writeDraft } from '../../draft'
import { directionLabel, formatBytes } from '../../lib/format'
import type { AdminQuestion, Attachment, Direction } from '../../types'

interface EditorDraft {
  title: string
  content: string
  direction: Direction
  published: boolean
}

const message = useMessage()
const loadingBatches = ref(true)
const loadingQuestions = ref(false)
const batchError = ref('')
const listError = ref('')
const formError = ref('')
const batches = ref<Array<{ id: string; name: string; roundName: string }>>([])
const batchId = ref<string | null>(null)
const questions = ref<AdminQuestion[]>([])
const selectedId = ref<string | null>(null)
const title = ref('')
const content = ref('')
const contentMode = ref<'edit' | 'preview'>('edit')
const direction = ref<Direction>('PRODUCT')
const published = ref(false)
const attachments = ref<Attachment[]>([])
const saving = ref(false)
const uploading = ref(false)
const draftOffer = ref<EditorDraft | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<DeletionTarget | null>(null)
let ignoreDraftWrite = false

const batchOptions = computed(() =>
  batches.value.map((batch) => ({ label: `${batch.roundName ? `${batch.roundName} / ` : ''}${batch.name}`, value: batch.id })),
)
const directionOptions = [
  { label: '产品', value: 'PRODUCT' },
  { label: '开发测试', value: 'DEVELOPMENT_TEST' },
]
const draftKey = computed(() => (selectedId.value ? `question:${selectedId.value}` : `question-new:${batchId.value || 'none'}`))

function snapshot(): EditorDraft {
  return { title: title.value, content: content.value, direction: direction.value, published: published.value }
}

function apply(draft: EditorDraft): void {
  const already = ignoreDraftWrite
  ignoreDraftWrite = true
  title.value = draft.title
  content.value = draft.content
  direction.value = draft.direction
  published.value = draft.published
  ignoreDraftWrite = already
}

async function loadBatches(): Promise<void> {
  loadingBatches.value = true
  batchError.value = ''
  try {
    const rows = await fetchAdminBatches()
    batches.value = rows.map((batch) => ({ id: batch.id, name: batch.name, roundName: batch.roundName }))
    if (!batchId.value && rows[0]) batchId.value = rows[0].id
  } catch (cause) {
    batchError.value = messageOf(cause)
  } finally {
    loadingBatches.value = false
  }
}

async function loadQuestions(): Promise<void> {
  if (!batchId.value) {
    questions.value = []
    return
  }
  loadingQuestions.value = true
  listError.value = ''
  try {
    questions.value = await fetchQuestions(batchId.value)
  } catch (cause) {
    questions.value = []
    listError.value = messageOf(cause)
  } finally {
    loadingQuestions.value = false
  }
}

function lookForDraft(current: EditorDraft): void {
  const raw = readDraft(draftKey.value)
  draftOffer.value = null
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as EditorDraft
    if (parsed.title !== current.title || parsed.content !== current.content) draftOffer.value = parsed
  } catch {
    clearDraft(draftKey.value)
  }
}

function selectQuestion(question: AdminQuestion): void {
  ignoreDraftWrite = true
  selectedId.value = question.id
  const current: EditorDraft = {
    title: question.title,
    content: question.content,
    direction: question.direction === 'DEVELOPMENT_TEST' ? 'DEVELOPMENT_TEST' : 'PRODUCT',
    published: question.published,
  }
  apply(current)
  contentMode.value = 'edit'
  attachments.value = [...question.attachments]
  formError.value = ''
  ignoreDraftWrite = false
  lookForDraft(current)
}

function startNew(): void {
  ignoreDraftWrite = true
  selectedId.value = null
  const current: EditorDraft = { title: '', content: '', direction: 'PRODUCT', published: false }
  apply(current)
  contentMode.value = 'edit'
  attachments.value = []
  formError.value = ''
  ignoreDraftWrite = false
  lookForDraft(current)
}

function restoreDraft(): void {
  if (!draftOffer.value) return
  apply(draftOffer.value)
  draftOffer.value = null
}

function discardDraft(): void {
  clearDraft(draftKey.value)
  draftOffer.value = null
}

watch([title, content, direction, published, draftKey], () => {
  if (ignoreDraftWrite || !batchId.value) return
  writeDraft(draftKey.value, JSON.stringify(snapshot()))
}, { flush: 'sync' })

let batchTicket = 0
watch(batchId, (id, previous) => {
  if (!id || id === previous) return
  const current = ++batchTicket
  ignoreDraftWrite = true
  selectedId.value = null
  ignoreDraftWrite = false
  void loadQuestions().then(() => {
    if (current === batchTicket) startNew()
  })
})

onMounted(async () => {
  await loadBatches()
  if (!batchId.value) startNew()
})

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 20 * 1024 * 1024) {
    formError.value = '单个附件不能超过 20MB'
    return
  }
  uploading.value = true
  formError.value = ''
  try {
    const attachment = await uploadAttachment(file)
    attachments.value = [...attachments.value, attachment]
    message.success('附件已上传')
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    uploading.value = false
  }
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((item) => item.id !== id)
}

async function save(): Promise<void> {
  if (!batchId.value) {
    formError.value = '请选择批次'
    return
  }
  if (!title.value.trim() || !content.value.trim()) {
    formError.value = '请填写题目标题和内容'
    return
  }
  saving.value = true
  formError.value = ''
  const body = {
    batchId: batchId.value,
    direction: direction.value,
    title: title.value.trim(),
    content: content.value.trim(),
    published: published.value,
    attachmentIds: attachments.value.map((item) => item.id),
  }
  try {
    if (selectedId.value) await updateQuestion(selectedId.value, body)
    else await createQuestion(body)
    clearDraft(draftKey.value)
    draftOffer.value = null
    await loadQuestions()
    message.success('题目已保存')
    if (!selectedId.value) startNew()
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}

function openDeleteQuestion(): void {
  if (!selectedId.value || saving.value || uploading.value) return
  deleteTarget.value = { kind: 'question', id: selectedId.value, action: '删除题目' }
  deleteOpen.value = true
}

async function onQuestionDeleted(result: DeletionResult): Promise<void> {
  if (result.ok !== true) return
  const removedId = result.id
  const previousIndex = questions.value.findIndex((question) => question.id === removedId)
  const wasSelected = selectedId.value === removedId
  ignoreDraftWrite = true
  clearDraft(`question:${removedId}`)
  if (wasSelected) draftOffer.value = null
  message.success('题目已删除')
  await loadQuestions()
  questions.value = questions.value.filter((question) => question.id !== removedId)
  if (!wasSelected && selectedId.value && questions.value.some((question) => question.id === selectedId.value)) {
    ignoreDraftWrite = false
    return
  }
  const following = previousIndex >= 0 ? questions.value[previousIndex] : undefined
  const preceding = previousIndex > 0 ? questions.value[previousIndex - 1] : undefined
  const next = following ?? preceding ?? null
  if (next) selectQuestion(next)
  else startNew()
}
</script>

<template>
  <section>
    <PageHeader
      title="考核题库"
    />
    <div class="card" style="margin-bottom: 12px">
      <Field label="批次" for-id="question-batch" :error="batchError">
        <n-select id="question-batch" v-model:value="batchId" :options="batchOptions" :loading="loadingBatches" placeholder="选择批次" />
      </Field>
    </div>
    <StateBlock
      :loading="loadingQuestions && questions.length === 0 && !listError"
      :error="listError"
      :empty="false"
      @retry="loadQuestions"
    >
      <div class="editor-grid">
        <aside class="card">
          <div class="row" style="justify-content: space-between">
            <h2>题目</h2>
            <n-button size="small" @click="startNew">新建</n-button>
          </div>
          <p v-if="!batchId" class="muted" style="margin-top: 8px">请先选择批次。</p>
          <p v-else-if="questions.length === 0" class="muted" style="margin-top: 8px">该批次还没有题目。</p>
          <div v-else style="margin-top: 8px">
            <button
              v-for="question in questions"
              :key="question.id"
              type="button"
              class="question-item"
              :class="{ active: selectedId === question.id }"
              @click="selectQuestion(question)"
            >
              <strong>{{ question.title || '未命名题目' }}</strong>
              <div class="tiny">{{ directionLabel(question.direction) }} · {{ question.published ? '已发布' : '未发布' }}</div>
            </button>
          </div>
        </aside>
        <form class="card form-grid" @submit.prevent="save">
          <div class="row" style="justify-content: space-between">
            <h2>{{ selectedId ? '编辑题目' : '新题目' }}</h2>
            <n-button
              v-if="selectedId"
              attr-type="button"
              size="small"
              type="error"
              quaternary
              :disabled="saving || uploading"
              @click="openDeleteQuestion"
            >删除题目</n-button>
          </div>
          <p v-if="draftOffer" class="banner">
            发现未保存的草稿。
            <button type="button" @click="restoreDraft">恢复</button>
            <button type="button" @click="discardDraft">丢弃</button>
          </p>
          <p v-if="formError" class="banner danger" role="alert">{{ formError }}</p>
          <Field label="方向" for-id="q-direction">
            <n-select id="q-direction" v-model:value="direction" :options="directionOptions" />
          </Field>
          <Field label="标题" for-id="q-title">
            <n-input id="q-title" v-model:value="title" />
          </Field>
          <Field label="内容（支持 Markdown）" for-id="q-content">
            <div class="md-field">
              <div class="md-switch" role="group" aria-label="内容编辑或预览">
                <button type="button" :aria-pressed="contentMode === 'edit'" @click="contentMode = 'edit'">编辑</button>
                <button type="button" :aria-pressed="contentMode === 'preview'" @click="contentMode = 'preview'">预览</button>
              </div>
              <n-input
                v-show="contentMode === 'edit'"
                id="q-content"
                v-model:value="content"
                type="textarea"
                :autosize="{ minRows: 10, maxRows: 20 }"
              />
              <div v-if="contentMode === 'preview'" class="md-preview">
                <MarkdownContent v-if="content.trim()" :source="content" />
                <p v-else class="muted">暂无内容</p>
              </div>
            </div>
          </Field>
          <div>
            <span class="field-label">附件</span>
            <p class="tiny">单个文件不超过 20 MB</p>
            <ul v-if="attachments.length" class="file-list">
              <li v-for="file in attachments" :key="file.id" class="file-row">
                <span>{{ file.name }} <span class="tiny">{{ formatBytes(file.size) }}</span></span>
                <n-button size="small" @click="removeAttachment(file.id)">从本题移除</n-button>
              </li>
            </ul>
            <label class="row" style="margin-top: 8px">
              <input class="sr-only" type="file" :disabled="uploading" @change="onFile" />
              <span class="pill">{{ uploading ? '正在上传…' : '选择文件上传' }}</span>
            </label>
          </div>
          <label class="switch-row">
            <n-switch v-model:value="published" />
            <span>发布到抽题池</span>
          </label>
          <p v-if="selectedId" class="tiny">修改不影响已开考的答卷。</p>
          <div>
            <n-button attr-type="submit" type="primary" :loading="saving" :disabled="!batchId">保存题目</n-button>
          </div>
        </form>
      </div>
    </StateBlock>
    <AdminDeleteDialog v-model:show="deleteOpen" :target="deleteTarget" @deleted="onQuestionDeleted" />
  </section>
</template>

<style scoped>
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
  min-height: 160px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
