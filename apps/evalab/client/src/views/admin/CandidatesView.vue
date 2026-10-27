<script setup lang="ts">
import { NButton, NInput, NSelect, useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAdminBatches, fetchCandidates } from '../../api/admin'
import { type DeletionResult, type DeletionTarget } from '../../api/deletion'
import { messageOf } from '../../api/http'
import AdminDeleteDialog from '../../components/AdminDeleteDialog.vue'
import AdminRegistrationRisk from '../../components/AdminRegistrationRisk.vue'
import { fetchRegistrationRisks, type RegistrationRisk } from '../../api/registrationRisk'
import Field from '../../components/Field.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import StatusPill from '../../components/StatusPill.vue'
import { directionLabel } from '../../lib/format'
import type { AdminCandidate } from '../../types'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(true)
const error = ref('')
const filterError = ref('')
const candidates = ref<AdminCandidate[]>([])
const risks = ref<Record<string, RegistrationRisk>>({})
const riskError = ref('')
const batches = ref<Array<{ label: string; value: string }>>([])
const PAGE = 100

function readOffset(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : 0
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(10000, Math.floor(raw / PAGE) * PAGE)
}

const search = ref<string | null>(typeof route.query.search === 'string' ? route.query.search : '')
const state = ref<string | null>(typeof route.query.state === 'string' ? route.query.state : null)
const batchId = ref<string | null>(typeof route.query.batchId === 'string' ? route.query.batchId : null)
const riskFilter = ref<string | null>(typeof route.query.risk === 'string' ? route.query.risk : null)
const riskOptions = [{label:'全部注册',value:''},{label:'待核查',value:'PENDING'},{label:'限制开考',value:'RESTRICTED'}]
const offset = ref(readOffset(route.query.offset))
const hasMore = ref(false)
const deleteOpen = ref(false)
const deleteTarget = ref<DeletionTarget | null>(null)
const pageNumber = computed(() => offset.value / PAGE + 1)
const showPager = computed(() => !loading.value && !error.value && (offset.value > 0 || hasMore.value || candidates.value.length > 0))
let debounce = 0
let ticket = 0

const stateOptions = [
  { label: '全部状态', value: '' },
  { label: '待开始', value: 'READY' },
  { label: '考核中', value: 'ACTIVE' },
  { label: '已交卷', value: 'FINALIZED' },
  { label: '已截止·未交卷', value: 'EXPIRED' },
]

async function load(): Promise<void> {
  const current = ++ticket
  loading.value = true
  error.value = ''
  const queryText = (search.value || '').trim()
  try {
    const rows = await fetchCandidates({
      search: queryText || undefined,
      state: state.value || undefined,
      risk: riskFilter.value || undefined,
      batchId: batchId.value || undefined,
      offset: String(offset.value),
    })
    if (current !== ticket) return
    candidates.value = rows
    risks.value = {}
    riskError.value = ''
    try {
      const data = await fetchRegistrationRisks(rows.map((candidate) => candidate.id))
      if (current !== ticket) return
      risks.value = Object.fromEntries(data.map((risk) => [risk.userId, risk]))
    } catch (cause) {
      if (current !== ticket) return
      riskError.value = messageOf(cause)
    }
    hasMore.value = rows.length === PAGE
    const query: Record<string, string> = {}
    if (queryText) query.search = queryText
    if (state.value) query.state = state.value
    if (riskFilter.value) query.risk = riskFilter.value
    if (batchId.value) query.batchId = batchId.value
    if (offset.value > 0) query.offset = String(offset.value)
    void router.replace({ query }).catch(() => undefined)
  } catch (cause) {
    if (current !== ticket) return
    candidates.value = []
    hasMore.value = false
    error.value = messageOf(cause)
  } finally {
    if (current === ticket) loading.value = false
  }
}

onMounted(async () => {
  try {
    const rows = await fetchAdminBatches()
    batches.value = rows.map((batch) => ({ label: batch.name, value: batch.id }))
  } catch (cause) {
    filterError.value = messageOf(cause)
  }
  await load()
})

function go(next: number): void {
  const clamped = Math.max(0, Math.min(10000, Math.floor(next / PAGE) * PAGE))
  if (clamped === offset.value) void load()
  else offset.value = clamped
}

watch(offset, () => void load())
watch(
  () => route.query.offset,
  (value) => {
    const next = readOffset(value)
    if (next !== offset.value) offset.value = next
  },
)
watch([state, batchId, riskFilter], () => go(0))
watch(search, () => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => go(0), 300)
})

function openDelete(target: DeletionTarget): void {
  deleteTarget.value = target
  deleteOpen.value = true
}

async function onDeleted(result: DeletionResult): Promise<void> {
  if (result.ok !== true) return
  message.success(result.kind === 'candidate' ? '考生已删除' : '报名已删除')
  await load()
  if (result.kind === 'candidate') {
    candidates.value = candidates.value.filter((candidate) => candidate.id !== result.id)
  } else if (result.kind === 'enrollment') {
    candidates.value = candidates.value.map((candidate) => ({
      ...candidate,
      enrollments: candidate.enrollments.filter((enrollment) => enrollment.id !== result.id),
    }))
  }
  if (!error.value && candidates.value.length === 0 && offset.value > 0) go(offset.value - PAGE)
}
</script>

<template>
  <section>
    <PageHeader title="候选人与评审" />
    <p v-if="riskError" class="banner danger" role="alert">注册核查加载失败：{{ riskError }} <n-button text @click="load">重试</n-button></p>
    <div class="card" style="margin-bottom: 12px">
      <div class="split">
        <Field label="搜索" for-id="candidate-search">
          <n-input id="candidate-search" v-model:value="search" placeholder="姓名、学号或邮箱" clearable @keydown.enter="go(0)" />
        </Field>
        <div class="choice-grid">
          <Field label="状态" for-id="candidate-state">
            <n-select id="candidate-state" v-model:value="state" :options="stateOptions" placeholder="全部状态" />
          </Field>
          <Field label="注册核查" for-id="candidate-risk"><n-select id="candidate-risk" v-model:value="riskFilter" :options="riskOptions" placeholder="全部注册" /></Field>
          <Field label="批次" for-id="candidate-batch" :error="filterError">
            <n-select id="candidate-batch" v-model:value="batchId" :options="batches" clearable placeholder="全部批次" />
          </Field>
        </div>
      </div>
    </div>
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!loading && !error && candidates.length === 0"
      :empty-title="offset > 0 ? '这一页没有候选人' : '没有符合条件的候选人'"
      :empty-text="offset > 0 ? '回到上一页。' : '换一个关键词或筛选条件。'"
      @retry="load"
    >
      <div class="stack">
        <article v-for="candidate in candidates" :key="candidate.id" class="card">
          <div class="card-head">
            <div>
              <h2>{{ candidate.name || '未命名' }}</h2>
              <p class="tiny">{{ candidate.studentNo || '无学号' }} · {{ candidate.email || '无邮箱' }} · {{ candidate.college || '学院未填' }}</p>
            </div>
            <div class="delete-entry">
              <AdminRegistrationRisk :user-id="candidate.id" :name="candidate.name" :risk="risks[candidate.id]" @changed="load" />
              <n-button
                size="small"
                type="error"
                quaternary
                attr-type="button"
                @click="openDelete({ kind: 'candidate', id: candidate.id, action: '删除考生' })"
              >删除考生</n-button>
            </div>
          </div>
          <p v-if="candidate.enrollments.length === 0" class="muted">没有报名记录。</p>
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>轮次</th>
                  <th>批次</th>
                  <th>方向</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="enrollment in candidate.enrollments" :key="enrollment.id">
                  <td>{{ enrollment.roundName || '—' }}</td>
                  <td>{{ enrollment.batchName || '—' }}</td>
                  <td>{{ directionLabel(enrollment.direction) || '—' }}</td>
                  <td><StatusPill :state="enrollment.state" /></td>
                  <td>
                    <div class="row">
                      <n-button size="small" @click="router.push(`/admin/candidates/${enrollment.id}`)">查看</n-button>
                      <n-button
                        size="small"
                        type="error"
                        quaternary
                        attr-type="button"
                        @click="openDelete({ kind: 'enrollment', id: enrollment.id, action: '删除报名' })"
                      >删除报名</n-button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </StateBlock>
    <div v-if="showPager" class="row pager">
      <n-button :disabled="offset === 0 || loading" @click="go(offset - PAGE)">上一页</n-button>
      <span class="tiny">第 {{ pageNumber }} 页</span>
      <n-button :disabled="!hasMore || offset >= 10000 || loading" @click="go(offset + PAGE)">下一页</n-button>
    </div>
    <AdminDeleteDialog v-model:show="deleteOpen" :target="deleteTarget" @deleted="onDeleted" />
  </section>
</template>

<style scoped>
.delete-entry { flex: none; }
</style>
