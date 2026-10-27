<script setup lang="ts">
import { Calendar, Clock } from 'lucide-vue-next'
import { NButton, NSelect } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createEnrollment, fetchBatches, updateEnrollment } from '../../api/candidate'
import { messageOf } from '../../api/http'
import MarkdownContent from '../../components/MarkdownContent.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import StatusPill from '../../components/StatusPill.vue'
import { serverNow, syncServerNow } from '../../clock'
import { attemptAccessibleAfterStartCloses, batchEnrollAllowed, directionLabel, formatDateTime, isDurationHours, validInstant, windowPhase } from '../../lib/format'
import { connectRequestId } from '../../lib/nav'
import type { Direction, Enrollment, PublicBatch, PublicRound } from '../../types'

const route = useRoute()
const router = useRouter()
const pendingConnect = computed(() => connectRequestId(route.query.connect))
const loading = ref(true)
const error = ref('')
const actionError = ref('')
const rounds = ref<PublicRound[]>([])
const now = ref(serverNow())
const directionChoice = ref<Record<string, string>>({})
const batchChoice = ref<Record<string, string>>({})
const busy = ref('')
let timer = 0

type StartPhase = '未开放' | '可开始' | '开考入口已关闭' | '暂未开放'

function taken(round: PublicRound): { batch: PublicBatch; enrollment: Enrollment } | null {
  for (const batch of round.batches) {
    if (batch.enrollment) return { batch, enrollment: batch.enrollment }
  }
  return null
}

function syncChoices(): void {
  for (const round of rounds.value) {
    const found = taken(round)
    if (!found) continue
    if (!directionChoice.value[round.id]) directionChoice.value[round.id] = found.enrollment.direction
    if (!batchChoice.value[round.id]) batchChoice.value[round.id] = found.enrollment.batchId
  }
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const data = await fetchBatches()
    if (data.serverNow) syncServerNow(data.serverNow)
    now.value = serverNow()
    rounds.value = data.rounds
    syncChoices()
  } catch (cause) {
    if (!silent || rounds.value.length === 0) error.value = messageOf(cause)
    else actionError.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    now.value = serverNow()
  }, 1000)
})
onUnmounted(() => window.clearInterval(timer))

function startPhase(batch: PublicBatch): StartPhase {
  if (batch.status === 'CLOSED') return '开考入口已关闭'
  if (batch.status && batch.status !== 'OPEN') return '暂未开放'
  const phase = windowPhase(now.value, batch.opensAt, batch.startClosesAt)
  if (phase === 'before') return '未开放'
  if (phase === 'closed') return '开考入口已关闭'
  if (phase === 'open') return '可开始'
  return '暂未开放'
}

function phaseTone(phase: StartPhase): 'ready' | 'active' | 'expired' {
  if (phase === '可开始') return 'active'
  if (phase === '开考入口已关闭') return 'expired'
  return 'ready'
}

function canEnroll(batch: PublicBatch): boolean {
  const phase = windowPhase(now.value, batch.opensAt, batch.startClosesAt)
  return batchEnrollAllowed(batch.status) && (phase === 'before' || phase === 'open')
}

function shownDuration(batch: PublicBatch): 24 | 48 | null {
  const hours = batch.enrollment && batch.enrollment.state !== 'READY'
    ? batch.enrollment.durationHours
    : batch.durationHours
  return isDurationHours(hours) ? hours : null
}

function durationFoot(batch: PublicBatch): string {
  const hours = shownDuration(batch)
  if (!hours) return '考核时长无法确认'
  return `开考后连续计时 ${hours} 小时`
}

function choose(roundId: string, direction: string): void {
  directionChoice.value = { ...directionChoice.value, [roundId]: direction }
}

async function enroll(batch: PublicBatch, round: PublicRound): Promise<void> {
  const direction = directionChoice.value[round.id]
  if (direction !== 'PRODUCT' && direction !== 'DEVELOPMENT_TEST') {
    actionError.value = '请先选择方向'
    return
  }
  busy.value = batch.id
  actionError.value = ''
  try {
    const enrollment = await createEnrollment(batch.id, direction)
    await router.push(prepareTarget(enrollment.id))
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    busy.value = ''
  }
}

async function save(round: PublicRound, enrollment: Enrollment): Promise<void> {
  const direction = directionChoice.value[round.id]
  const batchId = batchChoice.value[round.id] || enrollment.batchId
  if (direction !== 'PRODUCT' && direction !== 'DEVELOPMENT_TEST') {
    actionError.value = '请选择方向'
    return
  }
  busy.value = enrollment.id
  actionError.value = ''
  try {
    await updateEnrollment(enrollment.id, { batchId, direction })
    await load(true)
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    busy.value = ''
  }
}

function prepareTarget(enrollmentId: string): string | { path: string; query: { connect: string } } {
  const request = pendingConnect.value
  return request
    ? { path: `/recruitment/prepare/${enrollmentId}`, query: { connect: request } }
    : `/recruitment/prepare/${enrollmentId}`
}

function continueTo(enrollment: Enrollment): void {
  if (enrollment.state === 'READY') {
    void router.push(prepareTarget(enrollment.id))
    return
  }
  void router.push(`/recruitment/exam/${enrollment.id}`)
}

function directionOptions(batch: PublicBatch | undefined) {
  return (batch?.directions ?? [])
    .filter((item): item is Direction => item === 'PRODUCT' || item === 'DEVELOPMENT_TEST')
    .map((item) => ({ label: directionLabel(item), value: item }))
}
</script>

<template>
  <section>
    <PageHeader
      title="招新考核"
    />
    <p v-if="pendingConnect" class="banner" style="margin-bottom: 12px">
      连接请求仍保留。报名并在开考准备里同意材料后，
      <RouterLink :to="`/mcp/connect?request=${pendingConnect}`">返回连接确认</RouterLink>
      。
    </p>
    <details class="rules card">
      <summary>考核规则</summary>
      <ul>
        <li>每轮限一个批次和方向，开考后不可更改。</li>
        <li>开考后连续计时，无法暂停或换题。</li>
        <li>截止前须完成仓库和 MCP 材料提交，并点击确认交卷。</li>
        <li>到期不会自动交卷。</li>
      </ul>
    </details>
    <p v-if="actionError" class="banner danger" style="margin-top: 12px" role="alert">{{ actionError }}</p>
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rounds.length === 0"
      empty-title="当前没有考核批次"
      @retry="load()"
    >
      <div class="stack" style="margin-top: 12px">
        <section v-for="round in rounds" :key="round.id" class="round">
          <h2>{{ round.name }}</h2>
          <p v-if="round.batches.length === 0" class="muted">这一轮还没有批次。</p>
          <div v-else class="grid-cards">
            <article v-for="batch in round.batches" :key="batch.id" class="card">
              <div class="card-head">
                <h3 class="card-title">{{ batch.name }}</h3>
                <StatusPill v-if="batch.enrollment" :state="batch.enrollment.state" />
              </div>
              <div v-if="batch.description" class="batch-copy">
                <MarkdownContent :source="batch.description" />
              </div>
              <section class="schedule" :aria-label="`${batch.name}开考时间`">
                <div class="schedule-head">
                  <span class="pill" :data-tone="phaseTone(startPhase(batch))">{{ startPhase(batch) }}</span>
                  <span class="schedule-zone">北京时间</span>
                </div>
                <div class="schedule-rows">
                  <div class="schedule-row">
                    <span class="schedule-label">
                      <Calendar :size="14" aria-hidden="true" />
                      开放时间
                    </span>
                    <time v-if="validInstant(batch.opensAt)" class="schedule-value" :datetime="batch.opensAt">{{ formatDateTime(batch.opensAt) }}</time>
                    <span v-else class="schedule-value">—</span>
                  </div>
                  <div class="schedule-row">
                    <span class="schedule-label">
                      <Clock :size="14" aria-hidden="true" />
                      最晚开考时间
                    </span>
                    <time v-if="validInstant(batch.startClosesAt)" class="schedule-value" :datetime="batch.startClosesAt">{{ formatDateTime(batch.startClosesAt) }}</time>
                    <span v-else class="schedule-value">—</span>
                  </div>
                </div>
                <p class="schedule-foot" :data-invalid="shownDuration(batch) ? undefined : 'true'" :role="shownDuration(batch) ? undefined : 'status'">{{ durationFoot(batch) }}</p>
              </section>

              <template v-if="taken(round) && taken(round)?.batch.id !== batch.id">
                <p class="tiny" style="margin-top: 10px">本轮已选择「{{ taken(round)?.batch.name }}」。</p>
              </template>

              <template v-else-if="batch.enrollment">
                <p class="tiny" style="margin-top: 8px">当前方向：{{ directionLabel(batch.enrollment.direction) || '—' }}</p>
                <div v-if="batch.enrollment.state === 'READY'" class="stack" style="margin-top: 10px">
                  <div class="choice-grid" role="radiogroup" aria-label="调整方向">
                    <button
                      v-for="option in directionOptions(round.batches.find((item) => item.id === (batchChoice[round.id] || batch.id)) || batch)"
                      :key="option.value"
                      type="button"
                      class="choice"
                      role="radio"
                      :aria-checked="directionChoice[round.id] === option.value"
                      @click="choose(round.id, option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                  <label class="field-label" :for="`move-${round.id}`">调整到本轮其他批次</label>
                  <n-select
                    :id="`move-${round.id}`"
                    :value="batchChoice[round.id] || batch.enrollment.batchId"
                    :options="round.batches.map((item) => ({ label: item.name, value: item.id }))"
                    @update:value="(value) => (batchChoice[round.id] = String(value || ''))"
                  />
                  <div class="row">
                    <n-button
                      :loading="busy === batch.enrollment.id"
                      :disabled="busy !== ''"
                      @click="save(round, batch.enrollment)"
                    >
                      保存修改
                    </n-button>
                    <n-button type="primary" @click="continueTo(batch.enrollment)">进入准备</n-button>
                  </div>
                </div>
                <div v-else-if="attemptAccessibleAfterStartCloses(batch.enrollment.state)" class="row" style="margin-top: 10px">
                  <n-button type="primary" @click="continueTo(batch.enrollment)">
                    {{ batch.enrollment.state === 'FINALIZED' ? '查看交卷' : batch.enrollment.state === 'EXPIRED' ? '查看截止记录' : '继续作答' }}
                  </n-button>
                </div>
              </template>

              <template v-else>
                <div v-if="directionOptions(batch).length === 0" class="tiny" style="margin-top: 10px">该批次还没有可选方向。</div>
                <div v-else class="choice-grid" style="margin-top: 10px" role="radiogroup" :aria-label="`${batch.name}方向`">
                  <button
                    v-for="option in directionOptions(batch)"
                    :key="option.value"
                    type="button"
                    class="choice"
                    role="radio"
                    :aria-checked="directionChoice[round.id] === option.value"
                    :disabled="!canEnroll(batch)"
                    @click="choose(round.id, option.value)"
                  >
                    {{ option.label }}
                  </button>
                </div>
                <div class="row" style="margin-top: 10px">
                  <n-button
                    type="primary"
                    :loading="busy === batch.id"
                    :disabled="busy !== '' || !canEnroll(batch)"
                    @click="enroll(batch, round)"
                  >
                    报名并准备
                  </n-button>
                </div>
              </template>
            </article>
          </div>
        </section>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.batch-copy {
  color: var(--muted);
  min-width: 0;
  overflow-wrap: anywhere;
}
.schedule {
  margin-top: 10px;
  padding: 10px 12px 9px;
  border: 1px solid #d5e3f5;
  border-radius: 12px;
  background: #f3f7fd;
  min-width: 0;
  container-type: inline-size;
}
.schedule-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 8px;
  margin-bottom: 8px;
}
.schedule-zone {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
.schedule-rows { display: grid; gap: 8px; }
.schedule-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 2px 12px;
  min-width: 0;
}
.schedule-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.3;
}
.schedule-label :deep(svg) { flex: none; }
.schedule-value {
  min-width: 0;
  justify-self: end;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}
.schedule-foot {
  margin-top: 8px;
  color: var(--faint);
  font-size: 12px;
  line-height: 1.4;
}
.schedule-foot[data-invalid="true"] { color: var(--danger); }
@media (max-width: 640px) {
  .schedule-row { grid-template-columns: minmax(0, 1fr); }
  .schedule-value { justify-self: start; text-align: left; }
}
@container (max-width: 260px) {
  .schedule-row { grid-template-columns: minmax(0, 1fr); }
  .schedule-value { justify-self: start; text-align: left; }
}
</style>
