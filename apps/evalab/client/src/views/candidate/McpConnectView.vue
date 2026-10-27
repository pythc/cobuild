<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { decideOAuthRequest, fetchOAuthRequest } from '../../api/candidate'
import { messageOf } from '../../api/http'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { materialScopeSummary } from '../../content/consent'
import { directionLabel, formatDateTime, stateLabel } from '../../lib/format'
import { connectRequestId } from '../../lib/nav'
import type { OAuthConnectRequest } from '../../types'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const actionError = ref('')
const request = ref<OAuthConnectRequest | null>(null)
const selectedId = ref('')
const selectionMissing = ref(false)
const deciding = ref<'approve' | 'deny' | ''>('')
const leaving = ref(false)
let generation = 0

const requestId = computed(() => connectRequestId(route.query.request))
const chosen = computed(() => request.value?.enrollments.find((item) => item.id === selectedId.value) ?? null)
const scopeWarning = computed(() => {
  const scopes = (request.value?.scopes ?? []).map((item) => item.trim()).filter(Boolean)
  if (scopes.length === 0) return '服务器没有返回授权范围。请取消，再让 Agent 重新发起。'
  if (scopes.length !== 1 || scopes[0] !== 'assessment') {
    return `服务器列出的范围是：${scopes.join('、')}。这和本页说明不一致，请取消后重试。`
  }
  return ''
})
const canApprove = computed(() => {
  const current = request.value
  if (!current || deciding.value || leaving.value) return false
  if (scopeWarning.value) return false
  if (!current.redirectOrigin.trim()) return false
  return !!chosen.value
})

const recruitmentTo = computed(() =>
  requestId.value ? { path: '/recruitment', query: { connect: requestId.value } } : '/recruitment',
)

function httpRedirect(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password) return null
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

function choiceKey(id: string): string {
  return `lab110.mcp-connect.${id}`
}

function readChoice(id: string): string {
  try {
    return sessionStorage.getItem(choiceKey(id)) ?? ''
  } catch {
    return ''
  }
}

function writeChoice(id: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(choiceKey(id), value)
    else sessionStorage.removeItem(choiceKey(id))
  } catch {
    /* The in-memory choice still applies for this page view. */
  }
}

function resetChoice(): void {
  selectedId.value = ''
  selectionMissing.value = false
}

function syncSelection(enrollments: { id: string }[]): void {
  const ids = new Set(enrollments.map((item) => item.id))
  const request = requestId.value
  const stored = request ? readChoice(request) : ''
  if (selectedId.value && ids.has(selectedId.value)) return
  if (selectedId.value && !ids.has(selectedId.value)) {
    selectedId.value = ''
    selectionMissing.value = true
    if (request) writeChoice(request, 'none')
    return
  }
  if (stored === 'none') {
    selectionMissing.value = true
    return
  }
  if (stored && ids.has(stored)) {
    selectedId.value = stored
    return
  }
  if (stored) {
    selectionMissing.value = true
    if (request) writeChoice(request, 'none')
    return
  }
  const only = enrollments.length === 1 ? enrollments[0] : undefined
  if (only && request) {
    selectedId.value = only.id
    writeChoice(request, only.id)
  }
}

function choose(id: string): void {
  selectedId.value = id
  selectionMissing.value = false
  const request = requestId.value
  if (request) writeChoice(request, id)
}

async function load(): Promise<void> {
  const id = requestId.value
  if (!id) {
    request.value = null
    error.value = route.query.request ? '连接请求无效。' : '缺少连接请求。请从 Agent 打开的授权链接进入。'
    loading.value = false
    return
  }
  const current = ++generation
  loading.value = !request.value
  actionError.value = ''
  try {
    const next = await fetchOAuthRequest(id)
    if (current !== generation) return
    request.value = next
    syncSelection(next.enrollments)
    error.value = ''
  } catch (cause) {
    if (current !== generation) return
    if (!request.value) error.value = messageOf(cause)
    else actionError.value = messageOf(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}

async function finish(kind: 'approve' | 'deny'): Promise<void> {
  const id = requestId.value
  if (!id || deciding.value || leaving.value) return
  const enrollmentId = chosen.value?.id ?? ''
  if (kind === 'approve' && (!canApprove.value || !enrollmentId)) return
  deciding.value = kind
  actionError.value = ''
  try {
    const redirectUrl =
      kind === 'approve'
        ? await decideOAuthRequest(id, { approved: true, enrollmentId })
        : await decideOAuthRequest(id, { approved: false })
    const target = httpRedirect(redirectUrl)
    if (!target) {
      actionError.value = '服务器返回的跳转地址无效。'
      return
    }
    leaving.value = true
    window.location.assign(target)
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    if (!leaving.value) deciding.value = ''
  }
}

onMounted(() => {
  void load()
})

watch(requestId, () => {
  generation += 1
  request.value = null
  resetChoice()
  void load()
})
</script>

<template>
  <section>
    <PageHeader title="连接确认" description="Agent 请求连接你的一场考核。只有你点击允许后才会同意。" />
    <StateBlock :loading="loading && !request" :error="error" empty-title="" @retry="load()">
      <div v-if="request" class="stack">
        <p v-if="actionError" class="banner danger" role="alert">{{ actionError }}</p>
        <article class="card">
          <dl class="kv">
            <dt>客户端</dt>
            <dd>{{ request.clientName || '未提供名称' }} <span class="tiny">由对方自行填写，本站未核验</span></dd>
            <dt>回调来源</dt>
            <dd class="mono">{{ request.redirectOrigin || '未提供' }}</dd>
            <dt>有效至</dt>
            <dd>{{ formatDateTime(request.expiresAt) }}</dd>
          </dl>
          <div class="manifest-block">
            <h3>材料范围</h3>
            <p class="muted">{{ materialScopeSummary }}</p>
            <p v-if="scopeWarning" class="banner warn" style="margin-top: 8px">{{ scopeWarning }}</p>
          </div>
        </article>

        <article v-if="request.enrollments.length === 0" class="card">
          <h2>还没有可连接的考核</h2>
          <p class="muted" style="margin-top: 8px">请先到招新考核报名，并同意材料说明。这个连接请求会保留，完成后回到这里重试。</p>
          <div class="row" style="margin-top: 12px">
            <RouterLink class="text-link" :to="recruitmentTo">招新考核</RouterLink>
            <n-button @click="load()">重试</n-button>
          </div>
        </article>

        <article v-else class="card">
          <h2>选择考核</h2>
          <p v-if="request.enrollments.length > 1" class="tiny">有多场考核时，请自己选择。刷新不会自动改成另一场。</p>
          <p v-if="selectionMissing" class="banner warn" style="margin-top: 8px">刚才选中的考核已不在列表中，请重新选择。不会自动换成另一场。</p>
          <p v-else-if="!chosen" class="tiny" style="margin-top: 8px">请选择要连接的考核。</p>
          <div class="stack" style="margin-top: 10px" role="radiogroup" aria-label="选择要连接的考核">
            <button
              v-for="item in request.enrollments"
              :key="item.id"
              type="button"
              class="choice"
              role="radio"
              :aria-checked="selectedId === item.id"
              :disabled="deciding !== ''"
              @click="choose(item.id)"
            >
              <strong>{{ item.roundName || '未命名轮次' }} · {{ item.batchName || '未命名批次' }}</strong>
              <small>
                {{ directionLabel(item.direction) || '方向未标明' }}
                · {{ stateLabel(item.state) }}
                <template v-if="item.deadline"> · 截止 {{ formatDateTime(item.deadline) }}</template>
              </small>
            </button>
          </div>
        </article>

        <div class="row">
          <n-button type="primary" :disabled="!canApprove" :loading="deciding === 'approve'" @click="finish('approve')">
            允许连接
          </n-button>
          <n-button :disabled="deciding !== ''" :loading="deciding === 'deny'" @click="finish('deny')">取消</n-button>
        </div>
        <p v-if="leaving" class="tiny">正在回到发起连接的客户端。</p>
      </div>
    </StateBlock>
  </section>
</template>
