<script setup lang="ts">
import { ClipboardList, UserRoundCheck, Upload, ShieldCheck, ArrowRight, Check } from 'lucide-vue-next'
import { NButton, NCheckbox, NModal } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { acceptConsent, fetchBatches, fetchEnrollment, startEnrollment } from '../../api/candidate'
import { ApiError, messageOf } from '../../api/http'
import McpAccessCard from '../../components/McpAccessCard.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { serverNow, syncServerNow } from '../../clock'
import { consentSections, retentionNote } from '../../content/consent'
import { agreedDuration, assessStart, directionLabel, durationProblemMessage, formatDateTime, windowPhase } from '../../lib/format'
import { connectRequestId, connectReturnPath } from '../../lib/nav'
import type { Enrollment, ExamDurationHours, PublicBatch } from '../../types'

type PrepareStep = 1 | 2 | 3

const materialIcons = [ClipboardList, UserRoundCheck, Upload, ShieldCheck]

const steps: Array<{ id: PrepareStep; label: string }> = [
  { id: 1, label: '了解材料' },
  { id: 2, label: '连接 Agent' },
  { id: 3, label: '确认开始' },
]

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const error = ref('')
const actionError = ref('')
const enrollment = ref<Enrollment | null>(null)
const batch = ref<PublicBatch | null>(null)
const checked = ref(false)
const consenting = ref(false)
const starting = ref(false)
const confirmStart = ref(false)
const expectedDurationHours = ref<ExamDurationHours | null>(null)
const mustReconfirm = ref(false)
const step = ref<PrepareStep>(1)
const placed = ref(false)
const now = ref(serverNow())
let timer = 0
let poll = 0
let generation = 0

const id = computed(() => String(route.params.id || ''))
const connectBack = computed(() => {
  const request = connectRequestId(route.query.connect)
  return request ? connectReturnPath(request) : ''
})

const phase = computed(() => {
  if (!batch.value) return 'unknown' as const
  return windowPhase(now.value, batch.value.opensAt, batch.value.startClosesAt)
})

const liveDuration = computed(() => {
  if (!enrollment.value) return null
  return agreedDuration(enrollment.value.durationHours, batch.value ? batch.value.durationHours : null)
})

const durationMessage = computed(() => {
  if (!enrollment.value) return ''
  const message = durationProblemMessage(enrollment.value.durationHours, batch.value ? batch.value.durationHours : null)
  return message ?? ''
})

const startGate = computed(() => {
  const current = enrollment.value
  if (!current) return null
  if (!batch.value) {
    return { ok: false as const, durationHours: null, message: '暂时无法确认开考时间，请刷新重试。' }
  }
  return assessStart({
    now: now.value,
    opensAt: batch.value.opensAt,
    startClosesAt: batch.value.startClosesAt,
    status: batch.value.status,
    enrollmentDurationHours: current.durationHours,
    batchDurationHours: batch.value.durationHours,
  })
})

function consentReady(current: Enrollment): boolean {
  return current.consentAccepted && current.directUploadAccepted
}

function furthest(current: Enrollment): PrepareStep {
  if (!consentReady(current)) return 1
  if (!current.mcpConnected) return 2
  return 3
}

const maxStep = computed<PrepareStep>(() => (enrollment.value ? furthest(enrollment.value) : 1))

const canStart = computed(() => {
  const current = enrollment.value
  if (!current || current.state !== 'READY') return false
  if (!consentReady(current) || !current.mcpConnected) return false
  return startGate.value?.ok === true
})

const startReason = computed(() => {
  const current = enrollment.value
  if (!current) return ''
  if (!consentReady(current)) return '请先同意材料说明。'
  if (!current.mcpConnected) return '请先让 Agent 完成本人的连接测试。'
  const gate = startGate.value
  if (gate && !gate.ok && gate.message !== durationMessage.value) return gate.message
  return ''
})

function applyStep(current: Enrollment): void {
  const max = furthest(current)
  if (!placed.value) {
    step.value = max
    placed.value = true
    return
  }
  if (step.value > max) step.value = max
}

function go(next: PrepareStep): void {
  const current = enrollment.value
  if (!current || next > furthest(current)) return
  placed.value = true
  step.value = next
}

function previous(): void {
  if (step.value === 1) return
  placed.value = true
  step.value = (step.value === 3 ? 2 : 1) as PrepareStep
}

function next(): void {
  const current = enrollment.value
  if (!current || step.value === 3) return
  const target: PrepareStep = step.value === 1 ? 2 : 3
  if (target > furthest(current)) return
  placed.value = true
  step.value = target
}

async function load(silent = false): Promise<boolean> {
  if (!id.value) {
    error.value = '缺少报名编号'
    loading.value = false
    return false
  }
  const current = ++generation
  if (!silent) loading.value = true
  try {
    const [detail, batches] = await Promise.all([fetchEnrollment(id.value), fetchBatches()])
    if (current !== generation) return false
    if (detail.serverNow) syncServerNow(detail.serverNow)
    else if (batches.serverNow) syncServerNow(batches.serverNow)
    now.value = serverNow()
    enrollment.value = detail.enrollment
    batch.value = batches.rounds.flatMap((round) => round.batches).find((item) => item.id === detail.enrollment.batchId) ?? null
    error.value = ''
    applyStep(detail.enrollment)
    if (detail.enrollment.state !== 'READY') {
      confirmStart.value = false
      await router.replace(`/recruitment/exam/${detail.enrollment.id}`)
    }
    return true
  } catch (cause) {
    if (current !== generation) return false
    if (!silent || !enrollment.value) error.value = messageOf(cause)
    else actionError.value = messageOf(cause)
    return false
  } finally {
    if (current === generation) loading.value = false
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    now.value = serverNow()
  }, 1000)
  poll = window.setInterval(() => {
    if (!document.hidden && enrollment.value?.state === 'READY' && !(step.value === 2 && !enrollment.value.mcpConnected)) void load(true)
  }, 4000)
})
onUnmounted(() => {
  generation += 1
  window.clearInterval(timer)
  window.clearInterval(poll)
})
watch(id, () => {
  placed.value = false
  step.value = 1
  checked.value = false
  void load()
})

async function consent(): Promise<void> {
  if (!enrollment.value || !checked.value || consenting.value) return
  consenting.value = true
  actionError.value = ''
  try {
    const nextEnrollment = await acceptConsent(enrollment.value.id)
    generation += 1
    enrollment.value = nextEnrollment
    placed.value = true
    if (nextEnrollment.consentAccepted && nextEnrollment.directUploadAccepted) step.value = 2
    else actionError.value = '服务器没有确认直接上传同意，请重试。'
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    consenting.value = false
  }
}

function askStart(): void {
  if (!canStart.value || starting.value) return
  const hours = startGate.value?.ok ? startGate.value.durationHours : null
  if (hours !== 24 && hours !== 48) return
  expectedDurationHours.value = hours
  mustReconfirm.value = false
  actionError.value = ''
  confirmStart.value = true
}

async function reloadTiming(): Promise<void> {
  const ok = await load(true)
  if (!confirmStart.value) return
  if (!ok || !enrollment.value || enrollment.value.state !== 'READY') {
    expectedDurationHours.value = null
    mustReconfirm.value = true
    return
  }
  const hours = agreedDuration(enrollment.value.durationHours, batch.value ? batch.value.durationHours : null)
  expectedDurationHours.value = hours
  mustReconfirm.value = true
  actionError.value = hours ? '时长已变更，请按最新时长重新确认。' : '考核时长无法确认，暂时不能开始。'
}

async function start(): Promise<void> {
  const current = enrollment.value
  const expected = expectedDurationHours.value
  if (!current || starting.value || (expected !== 24 && expected !== 48)) return
  starting.value = true
  try {
    const gate = batch.value
      ? assessStart({
          now: now.value,
          opensAt: batch.value.opensAt,
          startClosesAt: batch.value.startClosesAt,
          status: batch.value.status,
          enrollmentDurationHours: current.durationHours,
          batchDurationHours: batch.value.durationHours,
        })
      : null
    if (!gate?.ok || gate.durationHours !== expected) {
      if (gate && !gate.ok && gate.durationHours === expected) {
        actionError.value = gate.message
        return
      }
      await reloadTiming()
      return
    }
    actionError.value = ''
    const result = await startEnrollment(current.id, expected)
    if (result.serverNow) syncServerNow(result.serverNow)
    confirmStart.value = false
    mustReconfirm.value = false
    await router.replace(`/recruitment/exam/${result.enrollment.id}`)
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'DURATION_CHANGED') {
      await reloadTiming()
      return
    }
    actionError.value = messageOf(cause)
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section class="prepare-page">
    <PageHeader title="开考准备">
      <template #actions>
        <RouterLink to="/recruitment">返回批次</RouterLink>
      </template>
    </PageHeader>
    <StateBlock :loading="loading && !enrollment" :error="error" empty-title="" @retry="load()">
      <div v-if="enrollment" class="stack">
        <p v-if="connectBack" class="banner">
          <template v-if="enrollment.consentAccepted && enrollment.directUploadAccepted">材料范围已确认，请 <RouterLink :to="connectBack">返回授权页允许连接</RouterLink>，再让 Agent 完成测试。</template>
          <template v-else>先完成下方材料说明，随后返回 Agent 的授权页。</template>
        </p>
        <article class="card">
          <div class="card-head">
            <h2>{{ enrollment.roundName }} · {{ enrollment.batchName }}</h2>
            <span class="pill">{{ directionLabel(enrollment.direction) || '方向未标明' }}</span>
          </div>
          <p v-if="batch" class="tiny">
            <template v-if="batch.status && batch.status !== 'OPEN'">该批次暂未开放开考 · </template>
            <template v-else-if="phase === 'closed'">开考入口已关闭 · </template>
            <template v-else-if="phase === 'before'">尚未到开始时间 · </template>
            <template v-else-if="phase === 'unknown'">开考时间无法确认 · </template>
            最晚开考时间 {{ formatDateTime(batch.startClosesAt) }}（北京时间）
            · {{ liveDuration ? `${liveDuration} 小时` : '时长无法确认' }}
          </p>
          <p v-else class="tiny">批次时间暂时无法确认。</p>
          <p v-if="durationMessage" class="banner danger" role="alert">{{ durationMessage }}</p>
        </article>
        <p v-if="actionError && !confirmStart" class="banner danger" role="alert">{{ actionError }}</p>

        <nav class="wizard-steps" aria-label="开考步骤">
          <button
            v-for="item in steps"
            :key="item.id"
            type="button"
            :aria-current="step === item.id ? 'step' : undefined"
            :disabled="item.id > maxStep"
            @click="go(item.id)"
          >
            <span class="wizard-index"><Check v-if="item.id < maxStep" :size="14" aria-hidden="true" /><template v-else>{{ item.id }}</template></span>
            {{ item.label }}
          </button>
        </nav>

        <article v-if="step === 1" class="card">
          <div class="card-head">
            <h2>了解材料</h2>
            <span class="pill" :data-tone="enrollment.consentAccepted && enrollment.directUploadAccepted ? 'done' : 'ready'">
              {{ enrollment.consentAccepted && enrollment.directUploadAccepted ? '已同意' : '待确认' }}
            </span>
          </div>
          <p class="muted">考核结束前，需提交项目仓库和 Agent 使用记录。</p>
          <div class="material-guide-grid">
          <div v-for="(section, index) in consentSections" :key="section.title" class="material-guide-card" :data-tone="index">
            <h3><component :is="materialIcons[index]" :size="20" aria-hidden="true" />{{ section.title }}</h3>
            <ul class="steps">
              <li v-for="item in section.items" :key="item">{{ item }}</li>
            </ul>
          </div>
          </div>
          <details class="material-details"><summary>保留时间</summary><p>{{ retentionNote }}</p><p>请不要提交其他项目、密码密钥或隐藏提示。文件按你选定的原始字节保存。客户端、模型和对话来源为提交者报告的信息，平台未独立核验。</p></details>
          <p v-if="enrollment.consentAccepted && enrollment.directUploadAccepted" class="banner ok" style="margin-top: 12px">已同意材料说明。</p>
          <form v-else class="stack" style="margin-top: 12px" @submit.prevent="consent">
            <label class="switch-row">
              <n-checkbox v-model:checked="checked" />
              <span>我已了解并同意上述材料范围，包括按原始字节直接上传。</span>
            </label>
            <div class="wizard-actions">
              <n-button class="wizard-next" attr-type="submit" type="primary" :disabled="!checked" :loading="consenting">同意并继续</n-button>
            </div>
          </form>
          <div v-if="enrollment.consentAccepted && enrollment.directUploadAccepted" class="wizard-actions">
            <n-button class="wizard-next" type="primary" @click="next">下一步</n-button>
          </div>
        </article>

        <article v-else-if="step === 2" class="card">
          <div class="card-head">
            <h2>连接 Agent</h2>
            <span class="pill" :data-tone="enrollment.mcpConnected ? 'done' : 'ready'">
              {{ enrollment.mcpConnected ? '测试已通过' : '待测试' }}
            </span>
          </div>
          <McpAccessCard
            :enrollment-id="enrollment.id"
            :connected="enrollment.mcpConnected"
            :enabled="enrollment.consentAccepted && enrollment.directUploadAccepted"
            @refresh="load(true)"
          />
          <p v-if="!enrollment.mcpConnected" class="tiny" style="margin-top: 8px">下一步要等连接测试通过。</p>
          <div class="wizard-actions">
            <n-button @click="previous">上一步</n-button>
            <n-button class="wizard-next" type="primary" :disabled="!enrollment.mcpConnected" @click="next">下一步</n-button>
          </div>
        </article>

        <article v-else class="card">
          <div class="card-head">
            <h2>确认开始</h2>
          </div>
          <div v-if="liveDuration" class="start-summary"><strong>{{ liveDuration }}<span>小时</span></strong><p>确认开始后连续计时，关闭页面也不会暂停。</p></div>
          <ul class="steps start-rules"><li>批次、方向与题目在开考后锁定。</li><li>截止前提交仓库和 Agent 使用记录，两者须对应同一版本。</li><li>最后点击“确认交卷”才算完成，交卷后不能修改。</li></ul>
          <p v-if="!canStart && startReason" class="tiny" style="margin-top: 8px">{{ startReason }}</p>
          <div class="wizard-actions">
            <n-button @click="previous">上一步</n-button>
            <n-button class="wizard-next" type="primary" :disabled="!canStart" @click="askStart">开始考核 <ArrowRight :size="16" style="margin-left:8px" /></n-button>
          </div>
        </article>
      </div>
    </StateBlock>

    <n-modal
      v-model:show="confirmStart"
      preset="card"
      title="确认开始"
      :style="{ width: 'min(480px, calc(100vw - 24px))' }"
      :auto-focus="true"
      :trap-focus="true"
      :close-on-esc="!starting"
      :mask-closable="!starting"
    >
      <p v-if="expectedDurationHours">确认后立即开始 {{ expectedDurationHours }} 小时计时，关闭页面也不会暂停。批次、方向和题目将锁定。</p>
      <p v-else>考核时长无法确认，暂时不能开始。</p>
      <p v-if="actionError" class="banner danger" style="margin-top: 10px" role="alert">{{ actionError }}</p>
      <div class="row" style="margin-top: 14px">
        <n-button type="primary" :disabled="expectedDurationHours !== 24 && expectedDurationHours !== 48" :loading="starting" @click="start">{{ mustReconfirm ? '重新确认并开始' : '确认开始' }}</n-button>
        <n-button :disabled="starting" @click="confirmStart = false">取消</n-button>
      </div>
    </n-modal>
  </section>
</template>
