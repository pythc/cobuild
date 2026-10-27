<script setup lang="ts">
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import { ref } from 'vue'
import { changeRegistrationRisk, type RegistrationRisk } from '../api/registrationRisk'
import { messageOf } from '../api/http'
import Field from './Field.vue'

const props = defineProps<{ userId: string; name: string; risk?: RegistrationRisk }>()
const emit = defineEmits<{ changed: [] }>()
const message = useMessage()
const open = ref(false)
const reason = ref('')
const error = ref('')
const pending = ref(false)

const riskLabels: Record<string, string> = {
  BROWSER_3_ACCOUNTS_DAY: '同一浏览器在 24 小时内注册了多个账号',
  IP_30_ACCOUNTS_DAY: '同一网络在 24 小时内集中注册，需结合校园共用网络核查',
}
function show(): void { reason.value = ''; error.value = ''; open.value = true }
async function act(action: 'RESTRICT_START' | 'ALLOW_START' | 'CLEAR_FLAG'): Promise<void> {
  if (pending.value) return
  if (!reason.value.trim()) { error.value = '请填写核查说明'; return }
  pending.value = true
  error.value = ''
  try {
    await changeRegistrationRisk(props.userId, action, reason.value.trim())
    message.success(action === 'RESTRICT_START' ? '已限制新开考' : action === 'ALLOW_START' ? '已解除开考限制' : '已标记核查完成')
    open.value = false
    emit('changed')
  } catch (cause) { error.value = messageOf(cause) }
  finally { pending.value = false }
}
</script>

<template>
  <div class="risk-entry">
    <span v-if="risk?.startRestricted" class="risk-tag restricted">限制开考</span>
    <span v-else-if="risk?.reviewState === 'PENDING' && risk.reasons.length" class="risk-tag">待核查</span>
    <n-button size="small" quaternary :disabled="!risk" @click="show">注册核查</n-button>
  </div>
  <n-modal v-model:show="open" preset="card" :title="`${name} · 注册核查`" style="width: min(520px, calc(100vw - 32px))" :mask-closable="!pending" :closable="!pending">
    <div class="stack">
      <p v-if="error" class="banner danger" role="alert">{{ error }}</p>
      <div v-if="risk?.reasons.length" class="banner">
        <p v-for="item in risk.reasons" :key="item">{{ riskLabels[item] ?? '注册行为需要核查' }}</p>
      </div>
      <p v-else class="muted">暂无注册异常标记。</p>
      <p v-if="risk?.startRestricted" class="banner danger">限制原因：{{ risk.restrictionReason }}</p>
      <Field label="核查说明" for-id="risk-reason">
        <n-input id="risk-reason" v-model:value="reason" type="textarea" :maxlength="500" :disabled="pending" placeholder="填写处理依据" />
      </Field>
      <p class="tiny">限制仅影响新开考，已开始的考核不受影响。</p>
      <div class="row actions">
        <n-button v-if="risk?.reviewState === 'PENDING' && risk.reasons.length" :disabled="pending" @click="act('CLEAR_FLAG')">标记已核查</n-button>
        <n-button v-if="risk?.startRestricted" type="primary" :loading="pending" @click="act('ALLOW_START')">解除限制</n-button>
        <n-button v-else type="error" secondary :loading="pending" @click="act('RESTRICT_START')">限制新开考</n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.risk-entry { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.risk-tag { color: #94601b; background: #fff2d7; padding: 3px 9px; border-radius: 20px; font-size: 12px; }
.risk-tag.restricted { color: #a22b33; background: #fff0f0; }
.actions { justify-content: flex-end; flex-wrap: wrap; }
</style>
