<script setup lang="ts">
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { confirmRepository, previewRepository } from '../api/candidate'
import { messageOf } from '../api/http'
import { serverNow } from '../clock'
import { readDraft, writeDraft } from '../draft'
import { formatDateTime, formatRemain } from '../lib/format'
import { branchError, repoUrlError } from '../lib/text'
import type { Enrollment, RepoPreview } from '../types'
import CopyButton from './CopyButton.vue'
import Field from './Field.vue'

const props = defineProps<{
  enrollment: Enrollment
  writable: boolean
  title?: string
}>()

const emit = defineEmits<{ refresh: [] }>()
const message = useMessage()
const url = ref('')
const branch = ref('')
const urlError = ref('')
const branchMessage = ref('')
const preview = ref<RepoPreview | null>(null)
const previewError = ref('')
const loadingPreview = ref(false)
const confirming = ref(false)
const now = ref(serverNow())
let timer = 0

const draftKey = computed(() => `repo:${props.enrollment.id}`)
const locked = computed(() => props.enrollment.repository)
const mismatch = computed(() => {
  const repository = props.enrollment.repository
  const materials = props.enrollment.materials
  return Boolean(repository && materials && repository.sha !== materials.repoSha)
})

watch(
  () => props.enrollment.id,
  () => {
    const saved = readDraft(draftKey.value)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as { url?: string; branch?: string }
      url.value = parsed.url ?? ''
      branch.value = parsed.branch ?? ''
    } catch {
      url.value = ''
    }
  },
  { immediate: true },
)

watch([url, branch], () => {
  writeDraft(draftKey.value, JSON.stringify({ url: url.value, branch: branch.value }))
})

onUnmounted(() => window.clearInterval(timer))

function openPreview(): void {
  urlError.value = repoUrlError(url.value) ?? ''
  branchMessage.value = branchError(branch.value) ?? ''
  if (urlError.value || branchMessage.value) return
  loadingPreview.value = true
  previewError.value = ''
  const body = branch.value.trim() ? { url: url.value.trim(), branch: branch.value.trim() } : { url: url.value.trim() }
  previewRepository(props.enrollment.id, body)
    .then((result) => {
      preview.value = result
      now.value = serverNow()
      window.clearInterval(timer)
      timer = window.setInterval(() => {
        now.value = serverNow()
      }, 1000)
    })
    .catch((cause: unknown) => {
      preview.value = null
      previewError.value = messageOf(cause)
    })
    .finally(() => {
      loadingPreview.value = false
    })
}

function closePreview(): void {
  preview.value = null
  window.clearInterval(timer)
}

const previewRemain = computed(() => {
  if (!preview.value) return 0
  return new Date(preview.value.expiresAt).getTime() - now.value
})

async function confirm(): Promise<void> {
  if (!preview.value || confirming.value || previewRemain.value <= 0) return
  const shownSha = preview.value.sha
  confirming.value = true
  previewError.value = ''
  try {
    const enrollment = await confirmRepository(props.enrollment.id, preview.value.id)
    if (enrollment.repository?.sha && enrollment.repository.sha !== shownSha) {
      message.error('服务器锁定的 SHA 与预览不一致，请重新预览后再提交材料')
    } else {
      message.success('已锁定预览中的 SHA')
    }
    closePreview()
    emit('refresh')
  } catch (cause) {
    previewError.value = messageOf(cause)
  } finally {
    confirming.value = false
  }
}
</script>

<template>
  <article class="card">
    <div class="card-head">
      <h2>{{ title || '仓库' }}</h2>
      <span v-if="locked" class="pill" data-tone="done">SHA 已锁定</span>
    </div>
    <p class="tiny">支持 GitHub、Gitee 公开仓库。</p>
    <p v-if="mismatch" class="banner warn" style="margin-top: 10px">
      仓库 SHA 已变化。已有材料不能用于交卷，需要按当前 SHA 重新上传。
    </p>
    <dl v-if="locked" class="kv" style="margin-top: 12px">
      <dt>地址</dt>
      <dd class="mono">{{ locked.url }}</dd>
      <dt>分支</dt>
      <dd>{{ locked.branch || '—' }}</dd>
      <dt>SHA</dt>
      <dd><p class="sha">{{ locked.sha }}</p></dd>
      <dt>说明</dt>
      <dd>{{ locked.message || '—' }}</dd>
      <dt>作者</dt>
      <dd>{{ locked.author || '—' }}</dd>
      <dt>提交时间</dt>
      <dd>{{ formatDateTime(locked.committedAt) }}</dd>
      <dt>锁定时间</dt>
      <dd>{{ formatDateTime(locked.confirmedAt) }}</dd>
    </dl>
    <div v-if="locked" class="row" style="margin-top: 8px">
      <CopyButton :text="locked.sha" label="复制 SHA" />
    </div>
    <div v-if="writable" class="stack" style="margin-top: 14px">
      <Field label="仓库地址" for-id="repo-url" :error="urlError">
        <n-input
          id="repo-url"
          v-model:value="url"
          placeholder="https://github.com/org/repo"
          :input-props="{ spellcheck: false, autocomplete: 'off', 'aria-invalid': urlError ? 'true' : 'false' }"
        />
      </Field>
      <Field label="分支" for-id="repo-branch" :error="branchMessage" hint="留空则使用默认分支">
        <n-input id="repo-branch" v-model:value="branch" placeholder="可选" :input-props="{ spellcheck: false }" />
      </Field>
      <div>
        <n-button type="primary" :loading="loadingPreview" @click="openPreview">核对提交版本</n-button>
      </div>
      <p v-if="previewError && !preview" class="field-error" role="alert">{{ previewError }}</p>
    </div>
    <p v-else-if="!locked" class="muted" style="margin-top: 10px">当前不能修改仓库。</p>

    <n-modal
      :show="preview !== null"
      preset="card"
      title="确认仓库版本"
      :style="{ width: 'min(560px, calc(100vw - 24px))' }"
      :auto-focus="true"
      :trap-focus="true"
      :close-on-esc="!confirming"
      :mask-closable="!confirming"
      @update:show="(value) => { if (!value) closePreview() }"
    >
      <div v-if="preview" class="stack">
        <p class="banner">确认后，以此提交版本作为评审版本。</p>
        <p v-if="previewRemain <= 0" class="banner warn">预览已过期，请关闭后重新获取。</p>
        <p v-else class="tiny">预览剩余 {{ formatRemain(previewRemain) }}，过期后需要重新预览。</p>
        <p v-if="previewError" class="banner danger" role="alert">{{ previewError }}</p>
        <dl class="kv">
          <dt>SHA</dt>
          <dd><p class="sha">{{ preview.sha }}</p></dd>
          <dt>地址</dt>
          <dd class="mono">{{ preview.url }}</dd>
          <dt>分支</dt>
          <dd>{{ preview.branch || '—' }}</dd>
          <dt>说明</dt>
          <dd>{{ preview.message || '—' }}</dd>
          <dt>作者</dt>
          <dd>{{ preview.author || '—' }}</dd>
          <dt>提交时间</dt>
          <dd>{{ formatDateTime(preview.committedAt) }}</dd>
        </dl>
        <div class="row">
          <n-button type="primary" :loading="confirming" :disabled="previewRemain <= 0" @click="confirm">
            确认此版本
          </n-button>
          <n-button :disabled="confirming" @click="closePreview">取消</n-button>
        </div>
      </div>
    </n-modal>
  </article>
</template>
