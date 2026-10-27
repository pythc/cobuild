<script setup lang="ts">
import { NButton, NInput, NInputNumber, useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { extendEnrollment, fetchAdminEnrollment, publishReview, saveReview } from '../../api/admin'
import { type DeletionResult, type DeletionTarget } from '../../api/deletion'
import { apiBlob, messageOf, saveBlob, safeFilename } from '../../api/http'
import AdminDeleteDialog from '../../components/AdminDeleteDialog.vue'
import Field from '../../components/Field.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import MaterialsDialog from '../../components/MaterialsDialog.vue'
import UploadStatus from '../../components/UploadStatus.vue'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import StatusPill from '../../components/StatusPill.vue'
import { directionLabel, display, formatBytes, formatDateTime } from '../../lib/format'
import type { Enrollment, Review, User } from '../../types'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(true)
const error = ref('')
const actionError = ref('')
const enrollment = ref<Enrollment | null>(null)
const user = ref<User | null>(null)
const review = ref<Review | null>(null)
const minutes = ref<number | null>(60)
const reason = ref('')
const score = ref<number | null>(null)
const feedback = ref('')
const extending = ref(false)
const reviewing = ref(false)
const publishing = ref(false)
const materialsOpen = ref(false)
const downloadError = ref('')
const deleteOpen = ref(false)
const deleteTarget = ref<DeletionTarget | null>(null)

const id = computed(() => String(route.params.id || ''))
const canExtend = computed(() => enrollment.value?.state === 'ACTIVE' || enrollment.value?.state === 'EXPIRED')
const canReview = computed(() => enrollment.value?.state === 'FINALIZED')

async function load(): Promise<void> {
  if (!id.value) {
    error.value = '缺少报名编号'
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const detail = await fetchAdminEnrollment(id.value)
    enrollment.value = detail.enrollment
    user.value = detail.user
    review.value = detail.review
    if (detail.review) {
      score.value = detail.review.score
      feedback.value = detail.review.feedback
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
watch(id, () => void load())

async function extend(): Promise<void> {
  if (!enrollment.value || !canExtend.value) return
  if (!minutes.value || minutes.value < 1 || minutes.value > 10080) {
    actionError.value = '延长分钟数需在 1 到 10080 之间'
    return
  }
  if (reason.value.trim().length < 2) {
    actionError.value = '请填写延长原因'
    return
  }
  extending.value = true
  actionError.value = ''
  try {
    enrollment.value = await extendEnrollment(enrollment.value.id, Math.round(minutes.value), reason.value.trim())
    reason.value = ''
    message.success('截止时间已更新')
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    extending.value = false
  }
}

async function reviewSave(): Promise<void> {
  if (!enrollment.value || !canReview.value) return
  if (score.value === null || score.value < 0 || score.value > 100 || !Number.isInteger(score.value)) {
    actionError.value = '分数需为 0 到 100 的整数'
    return
  }
  if (!feedback.value.trim()) {
    actionError.value = '请填写评语'
    return
  }
  reviewing.value = true
  actionError.value = ''
  try {
    review.value = await saveReview(enrollment.value.id, score.value, feedback.value.trim())
    message.success('评分已保存')
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    reviewing.value = false
  }
}

async function publish(): Promise<void> {
  if (!enrollment.value || !review.value || publishing.value) return
  publishing.value = true
  actionError.value = ''
  try {
    review.value = await publishReview(enrollment.value.id)
    message.success(review.value.publishedAt ? '结果已发布' : '发布请求已完成')
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    publishing.value = false
  }
}

async function download(attachmentId: string, name: string, url?: string): Promise<void> {
  downloadError.value = ''
  const path = url && url.startsWith('/api/') ? url : `/api/attachments/${encodeURIComponent(attachmentId)}`
  try {
    const file = await apiBlob(path)
    saveBlob(file.blob, safeFilename(file.filename || name, 'attachment'))
  } catch (cause) {
    downloadError.value = messageOf(cause)
  }
}

function openDeleteEnrollment(): void {
  if (!enrollment.value) return
  deleteTarget.value = { kind: 'enrollment', id: enrollment.value.id, action: '删除报名' }
  deleteOpen.value = true
}

async function onEnrollmentDeleted(result: DeletionResult): Promise<void> {
  if (result.ok !== true) return
  message.success('报名已删除')
  await router.push('/admin/candidates').catch(() => undefined)
}
</script>

<template>
  <section>
    <PageHeader :title="user?.name || '考生详情'">
      <template #actions>
        <n-button
          v-if="enrollment"
          size="small"
          type="error"
          quaternary
          attr-type="button"
          @click="openDeleteEnrollment"
        >删除报名</n-button>
        <RouterLink to="/admin/candidates">返回列表</RouterLink>
      </template>
    </PageHeader>
    <StateBlock :loading="loading && !enrollment" :error="error" empty-title="" @retry="load">
      <div v-if="enrollment && user" class="stack">
        <p v-if="actionError" class="banner danger" role="alert">{{ actionError }}</p>
        <article class="card">
          <div class="card-head">
            <h2>{{ enrollment.roundName }} · {{ enrollment.batchName }}</h2>
            <StatusPill :state="enrollment.state" />
          </div>
          <dl class="kv">
            <dt>学号</dt>
            <dd>{{ display(user.studentNo) }}</dd>
            <dt>邮箱</dt>
            <dd>{{ display(user.email) }}</dd>
            <dt>学院</dt>
            <dd>{{ display(user.college) }}</dd>
            <dt>专业</dt>
            <dd>{{ display(user.major) }}</dd>
            <dt>手机</dt>
            <dd>{{ display(user.phone) }}</dd>
            <dt>方向</dt>
            <dd>{{ directionLabel(enrollment.direction) || '—' }}</dd>
            <dt>开始</dt>
            <dd>{{ formatDateTime(enrollment.startedAt) }}</dd>
            <dt>截止</dt>
            <dd>{{ formatDateTime(enrollment.deadline) }}</dd>
            <dt>交卷</dt>
            <dd>{{ formatDateTime(enrollment.finalizedAt) }}</dd>
          </dl>
        </article>

        <article class="card">
          <h2>题目快照</h2>
          <template v-if="enrollment.question">
            <h3 class="card-title" style="margin-top: 8px">{{ enrollment.question.title }}</h3>
            <div style="margin-top: 8px">
              <MarkdownContent :source="enrollment.question.content" />
            </div>
            <p v-if="downloadError" class="field-error">{{ downloadError }}</p>
            <ul class="file-list">
              <li v-for="file in enrollment.question.attachments" :key="file.id" class="file-row">
                <span>{{ file.name }} <span class="tiny">{{ formatBytes(file.size) }}</span></span>
                <n-button size="small" @click="download(file.id, file.name, file.url)">下载</n-button>
              </li>
            </ul>
          </template>
          <p v-else class="muted" style="margin-top: 8px">尚未开考。</p>
        </article>

        <article class="card">
          <h2>仓库</h2>
          <dl v-if="enrollment.repository" class="kv" style="margin-top: 8px">
            <dt>地址</dt>
            <dd class="mono">{{ enrollment.repository.url }}</dd>
            <dt>分支</dt>
            <dd>{{ enrollment.repository.branch || '—' }}</dd>
            <dt>SHA</dt>
            <dd><p class="sha">{{ enrollment.repository.sha }}</p></dd>
            <dt>说明</dt>
            <dd>{{ enrollment.repository.message || '—' }}</dd>
            <dt>锁定时间</dt>
            <dd>{{ formatDateTime(enrollment.repository.confirmedAt) }}</dd>
          </dl>
          <p v-else class="muted" style="margin-top: 8px">还没有锁定仓库。</p>
        </article>

        <article class="card">
          <h2>MCP 材料</h2>
          <dl v-if="enrollment.materials" class="kv" style="margin-top: 8px">
            <dt>回执</dt>
            <dd class="mono">{{ enrollment.materials.id }}</dd>
            <dt>摘要</dt>
            <dd class="mono">{{ enrollment.materials.sha256 }}</dd>
            <dt>SHA</dt>
            <dd class="mono">{{ enrollment.materials.repoSha }}</dd>
            <dt>收到</dt>
            <dd>{{ formatDateTime(enrollment.materials.receivedAt) }}</dd>
            <dt>规模</dt>
            <dd>{{ enrollment.materials.fileCount }} 个文件 · {{ enrollment.materials.clientCount }} 个客户端</dd>
          </dl>
          <p v-else class="muted" style="margin-top: 8px">还没有材料回执。</p>
          <div v-if="enrollment.materialUpload" style="margin-top: 12px">
            <UploadStatus :upload="enrollment.materialUpload" />
          </div>
          <div class="row" style="margin-top: 10px">
            <n-button :disabled="!enrollment.materials" @click="materialsOpen = true">查看材料</n-button>
          </div>
        </article>

        <article class="card">
          <h2>延长截止时间</h2>
          <p v-if="enrollment.state === 'FINALIZED'" class="muted" style="margin-top: 8px">已经交卷，不能延长。</p>
          <p v-else-if="enrollment.state === 'READY'" class="muted" style="margin-top: 8px">尚未开始，没有截止时间可延长。</p>
          <form v-else class="form-grid" style="margin-top: 10px" @submit.prevent="extend">
            <Field label="延长分钟" for-id="extend-minutes">
              <n-input-number id="extend-minutes" v-model:value="minutes" :min="1" :max="10080" :precision="0" style="width: 100%" />
            </Field>
            <Field label="原因" for-id="extend-reason">
              <n-input id="extend-reason" v-model:value="reason" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" />
            </Field>
            <div>
              <n-button attr-type="submit" type="primary" :loading="extending" :disabled="!canExtend">延长</n-button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="card-head">
            <h2>评分与发布</h2>
            <span v-if="review?.publishedAt" class="pill" data-tone="done">已于 {{ formatDateTime(review.publishedAt) }} 发布</span>
            <span v-else-if="review" class="pill">未发布</span>
          </div>
          <p v-if="!canReview" class="muted">尚未交卷，不能评分。</p>
          <form v-else class="form-grid" style="margin-top: 10px" @submit.prevent="reviewSave">
            <p v-if="review?.publishedAt" class="tiny">修改评分不会再次发送通知。</p>
            <Field label="分数" for-id="score">
              <n-input-number id="score" v-model:value="score" :min="0" :max="100" :precision="0" style="width: 100%" />
            </Field>
            <Field label="评语" for-id="feedback">
              <n-input id="feedback" v-model:value="feedback" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" />
            </Field>
            <div class="row">
              <n-button attr-type="submit" type="primary" :loading="reviewing">保存评分</n-button>
              <n-button attr-type="button" :disabled="!review" :loading="publishing" @click="publish">发布结果</n-button>
            </div>
          </form>
        </article>
      </div>
    </StateBlock>
    <MaterialsDialog v-if="enrollment" v-model:show="materialsOpen" :enrollment-id="enrollment.id" />
    <AdminDeleteDialog v-model:show="deleteOpen" :target="deleteTarget" @deleted="onEnrollmentDeleted" />
  </section>
</template>
