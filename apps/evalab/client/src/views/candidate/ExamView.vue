<script setup lang="ts">
import { NButton, NCheckbox, NModal } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { acceptConsent, fetchEnrollment, finalizeEnrollment } from '../../api/candidate'
import { apiBlob, messageOf, saveBlob, safeFilename } from '../../api/http'
import CopyButton from '../../components/CopyButton.vue'
import Countdown from '../../components/Countdown.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import McpAccessCard from '../../components/McpAccessCard.vue'
import PageHeader from '../../components/PageHeader.vue'
import RepoPanel from '../../components/RepoPanel.vue'
import StateBlock from '../../components/StateBlock.vue'
import StatusPill from '../../components/StatusPill.vue'
import UploadStatus from '../../components/UploadStatus.vue'
import { serverNow, syncServerNow } from '../../clock'
import { directUploadUpdate } from '../../content/consent'
import { uploadInstructionText } from '../../content/upload'
import { canFinalize, finalizeChecks, isUploadInFlight, writesOpen } from '../../lib/exam'
import { directionLabel, formatBytes, formatDateTime, validInstant } from '../../lib/format'
import type { Enrollment, FinalizeReceipt } from '../../types'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const error = ref('')
const actionError = ref('')
const enrollment = ref<Enrollment | null>(null)
const now = ref(serverNow())
const confirmOpen = ref(false)
const acknowledged = ref(false)
const finalizing = ref(false)
const uploadChecked = ref(false)
const consenting = ref(false)
const receipt = ref<FinalizeReceipt | null>(null)
const downloadError = ref('')
let timer = 0
let poll = 0
let generation = 0
let disposed = false

const id = computed(() => String(route.params.id || ''))
const shownReceipt = computed(() => receipt.value ?? enrollment.value?.submission ?? null)
const writable = computed(() => (enrollment.value ? writesOpen(enrollment.value, now.value) : false))
const uploadText = computed(() => {
  const sha = enrollment.value?.repository?.sha
  if (!sha) return ''
  return uploadInstructionText(window.location.origin, sha)
})
const canCopyUpload = computed(() => Boolean(writable.value && enrollment.value?.directUploadAccepted && uploadText.value))
const copyHold = computed(() => {
  if (!enrollment.value || canCopyUpload.value) return ''
  if (!writable.value) return '当前不能再上传。'
  if (!enrollment.value.repository?.sha) return '先锁定仓库 SHA，才能复制包含当前版本的说明。'
  if (!enrollment.value.directUploadAccepted) return '先同意直接上传范围，才能复制新的上传说明。'
  return ''
})
const checks = computed(() => (enrollment.value ? finalizeChecks(enrollment.value, now.value) : []))
const readyToSubmit = computed(() => (enrollment.value ? canFinalize(enrollment.value, now.value) : false))
const deadlineIso = computed(() => {
  const deadline = enrollment.value?.deadline
  return validInstant(deadline) ? deadline : ''
})

const heading = computed(() => {
  const state = enrollment.value?.state
  if (state === 'FINALIZED') return '已交卷'
  if (state === 'EXPIRED') return '已截止·未交卷'
  if (state === 'ACTIVE' && enrollment.value?.deadline && now.value >= new Date(enrollment.value.deadline).getTime()) {
    return '已截止·未交卷'
  }
  return '考核进行中'
})

function jumpToStep(step: string): void {
  document.getElementById(step)?.scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
}

async function load(silent = false): Promise<void> {
  if (!id.value) {
    error.value = '缺少报名编号'
    loading.value = false
    return
  }
  const current = ++generation
  if (!silent) loading.value = true
  try {
    const detail = await fetchEnrollment(id.value)
    if (current !== generation) return
    if (detail.serverNow) syncServerNow(detail.serverNow)
    now.value = serverNow()
    enrollment.value = detail.enrollment
    error.value = ''
    if (detail.enrollment.state === 'READY') await router.replace(`/recruitment/prepare/${detail.enrollment.id}`)
  } catch (cause) {
    if (current !== generation) return
    if (!silent || !enrollment.value) error.value = messageOf(cause)
    else actionError.value = messageOf(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}

function pollDelay(): number {
  const upload = enrollment.value?.materialUpload
  if (upload && writable.value && isUploadInFlight(upload)) return 2000
  return 8000
}

function armPoll(): void {
  window.clearInterval(poll)
  if (disposed) return
  poll = window.setInterval(() => {
    if (!document.hidden) void load(true)
  }, pollDelay())
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    now.value = serverNow()
  }, 1000)
  armPoll()
})
onUnmounted(() => {
  disposed = true
  window.clearInterval(timer)
  window.clearInterval(poll)
})
watch(id, () => {
  uploadChecked.value = false
  void load()
})
watch(
  () => enrollment.value?.materialUpload?.status,
  () => armPoll(),
)

async function acceptUpload(): Promise<void> {
  const current = enrollment.value
  if (!current || !uploadChecked.value || consenting.value || current.directUploadAccepted) return
  consenting.value = true
  actionError.value = ''
  try {
    const next = await acceptConsent(current.id)
    if (!next.directUploadAccepted) {
      actionError.value = '服务器没有确认直接上传同意，请重试。'
      enrollment.value = next
      return
    }
    generation += 1
    enrollment.value = next
    uploadChecked.value = false
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    consenting.value = false
  }
}

async function download(attachmentId: string, name: string, url?: string): Promise<void> {
  downloadError.value = ''
  const path = url && url.startsWith('/api/') ? url : `/api/attachments/${encodeURIComponent(attachmentId)}`
  try {
    const file = await apiBlob(path)
    if (file.blob.size === 0) {
      downloadError.value = '服务器返回了空文件'
      return
    }
    saveBlob(file.blob, safeFilename(file.filename || name, 'attachment'))
  } catch (cause) {
    downloadError.value = messageOf(cause)
  }
}

async function finalize(): Promise<void> {
  const current = enrollment.value
  if (!current?.repository || !current.materials || !acknowledged.value || finalizing.value || !readyToSubmit.value) return
  finalizing.value = true
  actionError.value = ''
  try {
    const result = await finalizeEnrollment(current.id, {
      repositoryId: current.repository.id,
      materialsId: current.materials.id,
      confirmed: true,
    })
    generation += 1
    enrollment.value = result.enrollment
    receipt.value = result.receipt
    confirmOpen.value = false
    acknowledged.value = false
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    finalizing.value = false
  }
}
</script>

<template>
  <section>
    <PageHeader :title="heading" :description="enrollment ? `${enrollment.roundName} · ${enrollment.batchName}` : '加载答卷'">
      <template v-if="enrollment && writable" #actions>
        <Countdown :deadline="enrollment.deadline" />
      </template>
    </PageHeader>
    <StateBlock :loading="loading && !enrollment" :error="error" empty-title="" @retry="load()">
      <div v-if="enrollment" class="stack">
        <div class="row">
          <StatusPill :state="enrollment.state === 'ACTIVE' && enrollment.deadline && now >= new Date(enrollment.deadline).getTime() ? 'EXPIRED' : enrollment.state" />
          <span class="pill">{{ directionLabel(enrollment.direction) || '方向未标明' }}</span>
          <span class="tiny">开始于 {{ formatDateTime(enrollment.startedAt) }}（北京时间）</span>
        </div>
        <p v-if="deadlineIso" class="personal-deadline">
          个人截止时间
          <time :datetime="deadlineIso">{{ formatDateTime(deadlineIso) }}</time>
          <span class="zone">北京时间</span>
        </p>
        <p v-else class="banner danger" role="alert">个人截止时间无法确认。</p>
        <p v-if="enrollment.state === 'EXPIRED' || (enrollment.state === 'ACTIVE' && enrollment.deadline && now >= new Date(enrollment.deadline).getTime())" class="banner warn">
          已截止·未交卷。已有材料会保留，但不能再修改或确认交卷。
        </p>
        <p v-if="enrollment.state === 'FINALIZED'" class="banner ok">已于 {{ formatDateTime(enrollment.finalizedAt) }} 交卷，不能再修改。</p>
        <p v-if="actionError" class="banner danger" role="alert">{{ actionError }}</p>

        <nav v-if="writable" class="exam-submit-guide" aria-label="完成作答后如何交卷">
          <strong>完成项目后</strong>
          <button type="button" @click="jumpToStep('repository-step')">① 确认仓库</button>
          <span aria-hidden="true">→</span>
          <button type="button" @click="jumpToStep('materials-step')">② 发指令给 Agent 上传材料</button>
          <span aria-hidden="true">→</span>
          <button type="button" @click="jumpToStep('finalize-step')">③ 确认交卷</button>
        </nav>
        <article class="card">
          <h2>题目</h2>
          <template v-if="enrollment.question">
            <h3 class="card-title" style="margin-top: 8px">{{ enrollment.question.title || '未命名题目' }}</h3>
            <div style="margin-top: 8px">
              <MarkdownContent :source="enrollment.question.content" />
            </div>
            <p v-if="downloadError" class="field-error" role="alert">{{ downloadError }}</p>
            <ul v-if="enrollment.question.attachments.length" class="file-list">
              <li v-for="file in enrollment.question.attachments" :key="file.id" class="file-row">
                <span>{{ file.name }} <span class="tiny">{{ formatBytes(file.size) }}</span></span>
                <n-button size="small" @click="download(file.id, file.name, file.url)">下载</n-button>
              </li>
            </ul>
          </template>
          <p v-else class="banner danger" style="margin-top: 10px">题目加载失败，请刷新重试。</p>
        </article>

        <article v-if="writable && !enrollment.directUploadAccepted" class="card">
          <h2>更新上传范围</h2>
          <p class="muted" style="margin-top: 8px">{{ directUploadUpdate }}</p>
          <form class="stack" style="margin-top: 12px" @submit.prevent="acceptUpload">
            <label class="switch-row">
              <n-checkbox v-model:checked="uploadChecked" />
              <span>我同意按此范围直接上传本次考核材料。</span>
            </label>
            <div>
              <n-button attr-type="submit" type="primary" :disabled="!uploadChecked" :loading="consenting">同意</n-button>
            </div>
          </form>
        </article>

        <RepoPanel id="repository-step" title="1. 确认仓库版本" :enrollment="enrollment" :writable="writable" @refresh="load(true)" />

        <article id="materials-step" class="card">
          <div class="card-head">
            <h2>2. 把上传说明发给 Agent</h2>
            <span class="pill" :data-tone="enrollment.materials ? 'done' : 'ready'">
              {{ enrollment.materials ? '已收到回执' : '待上传' }}
            </span>
          </div>
          <p class="muted" style="margin-top: 8px">点击复制，把指令发给已连接的 Agent，它会直接上传当前这段对话的原始日志。合计最多 1 GB。</p>
          <div class="row" style="margin-top: 10px">
            <CopyButton :text="uploadText" label="复制上传说明" :disabled="!canCopyUpload" />
          </div>
          <p v-if="copyHold" class="tiny" style="margin-top: 8px">{{ copyHold }}</p>
          <details v-if="canCopyUpload" class="rules" style="margin-top: 10px"><summary>查看完整指令</summary><pre class="instruction-block" tabindex="0" aria-label="发给 Agent 的上传说明">{{ uploadText }}</pre></details>
          <p v-else-if="!enrollment.repository" class="muted" style="margin-top: 10px">锁定仓库后，这里会生成包含当前 SHA 的上传说明。</p>
          <p v-if="enrollment.repository && enrollment.materials && enrollment.repository.sha !== enrollment.materials.repoSha" class="banner warn" style="margin-top: 10px">
            回执里的 SHA 与当前仓库不一致，不能用于交卷。请按当前 SHA 重新上传。
          </p>
          <div v-if="enrollment.materialUpload" style="margin-top: 14px">
            <UploadStatus :upload="enrollment.materialUpload" />
          </div>
          <dl v-if="enrollment.materials" class="kv" style="margin-top: 14px">
            <dt>回执</dt>
            <dd class="mono">{{ enrollment.materials.id }}</dd>
            <dt>材料摘要</dt>
            <dd class="mono">{{ enrollment.materials.sha256 }}</dd>
            <dt>对应 SHA</dt>
            <dd class="mono">{{ enrollment.materials.repoSha }}</dd>
            <dt>收到时间</dt>
            <dd>{{ formatDateTime(enrollment.materials.receivedAt) }}</dd>
            <dt>规模</dt>
            <dd>{{ enrollment.materials.clientCount }} 个客户端 · {{ enrollment.materials.fileCount }} 个文件 · {{ enrollment.materials.coverage || '覆盖范围未标明' }}</dd>
          </dl>
          <p v-else-if="!enrollment.materialUpload" class="muted" style="margin-top: 10px">还没有材料回执。</p>
          <details v-if="writable" class="rules" style="margin-top: 14px">
            <summary>Agent 连接</summary>
            <McpAccessCard
              :enrollment-id="enrollment.id"
              :connected="enrollment.mcpConnected"
              :enabled="enrollment.directUploadAccepted"
              @refresh="load(true)"
            />
          </details>
        </article>

        <article v-if="enrollment.result" class="card">
          <h2>成绩</h2>
          <p class="stat" style="border: 0; padding: 8px 0">
            <b class="num">{{ enrollment.result.score }}</b>
            <span v-if="enrollment.result.publishedAt">已于 {{ formatDateTime(enrollment.result.publishedAt) }} 发布</span>
          </p>
          <p class="prose">{{ enrollment.result.feedback }}</p>
        </article>
        <article v-else-if="enrollment.state === 'FINALIZED'" class="card">
          <h2>成绩</h2>
          <p class="muted">结果尚未发布。</p>
        </article>

        <article v-if="shownReceipt" class="card">
          <h2>交卷回执</h2>
          <dl class="kv" style="margin-top: 8px">
            <dt>编号</dt>
            <dd class="mono">{{ shownReceipt.id }}</dd>
            <dt>提交时间</dt>
            <dd>{{ formatDateTime(shownReceipt.submittedAt) }}</dd>
            <dt>SHA</dt>
            <dd class="mono">{{ shownReceipt.sha }}</dd>
            <dt>材料哈希</dt>
            <dd class="mono">{{ shownReceipt.materialsHash }}</dd>
          </dl>
        </article>

        <div v-if="enrollment.state !== 'FINALIZED'" id="finalize-step" class="finalize-bar">
          <div class="stack" style="gap: 8px">
            <strong>3. 确认交卷</strong>
            <p class="tiny">{{ readyToSubmit ? '仓库与材料已就绪，确认后锁定本次作答。' : checks.filter(item => !item.ok).map(item => item.label).join(' · ') }}</p>
            <details class="rules"><summary>交卷条件</summary><ul class="checks">
              <li v-for="item in checks" :key="item.label">
                <span class="mark" :class="item.ok ? 'ok' : 'no'">{{ item.ok ? '✓' : '·' }}</span>
                <span>{{ item.label }}</span>
              </li>
            </ul></details>
          </div>
          <n-button type="primary" :disabled="!readyToSubmit" @click="confirmOpen = true">确认交卷</n-button>
        </div>
      </div>
    </StateBlock>

    <n-modal
      v-model:show="confirmOpen"
      preset="card"
      title="确认交卷"
      :style="{ width: 'min(560px, calc(100vw - 24px))' }"
      :auto-focus="true"
      :trap-focus="true"
      :close-on-esc="!finalizing"
      :mask-closable="!finalizing"
    >
      <div v-if="enrollment?.repository && enrollment.materials" class="stack">
        <p>交卷后不能再修改，即使截止时间还没到。请核对下面的仓库 SHA 和材料回执。</p>
        <dl class="kv">
          <dt>仓库 SHA</dt>
          <dd><p class="sha">{{ enrollment.repository.sha }}</p></dd>
          <dt>分支</dt>
          <dd>{{ enrollment.repository.branch || '—' }}</dd>
          <dt>说明</dt>
          <dd>{{ enrollment.repository.message || '—' }}</dd>
          <dt>材料回执</dt>
          <dd class="mono">{{ enrollment.materials.id }}</dd>
          <dt>材料摘要</dt>
          <dd class="mono">{{ enrollment.materials.sha256 }}</dd>
          <dt>材料 SHA</dt>
          <dd class="mono">{{ enrollment.materials.repoSha }}</dd>
          <dt>收到时间</dt>
          <dd>{{ formatDateTime(enrollment.materials.receivedAt) }}</dd>
        </dl>
        <label class="switch-row">
          <n-checkbox v-model:checked="acknowledged" />
          <span>我确认以上仓库版本与 MCP 材料一致，并现在交卷。</span>
        </label>
        <p v-if="actionError" class="banner danger" role="alert">{{ actionError }}</p>
        <div class="row">
          <n-button type="primary" :disabled="!acknowledged || !readyToSubmit" :loading="finalizing" @click="finalize">
            确认交卷
          </n-button>
          <n-button :disabled="finalizing" @click="confirmOpen = false">返回</n-button>
        </div>
      </div>
    </n-modal>
  </section>
</template>

<style scoped>
.personal-deadline {
  margin: 0;
  padding: 8px 12px;
  border: 1px solid #d5e3f5;
  border-radius: 12px;
  background: #f3f7fd;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.personal-deadline time { font-weight: 700; }
.personal-deadline .zone {
  margin-left: 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
</style>
