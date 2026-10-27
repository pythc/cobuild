<script setup lang="ts">
import { redirectQuery } from '../../lib/nav'
import { NButton, NInput, useMessage } from 'naive-ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { logout, resetPassword, sendEmailCode } from '../../api/auth'
import { setCsrfToken } from '../../api/csrf'
import { messageOf } from '../../api/http'
import Field from '../../components/Field.vue'
import AuthLayout from '../../layouts/AuthLayout.vue'
import { emailError, passwordError } from '../../lib/text'
import { clearSessionUser, useSession } from '../../session'

const router = useRouter()
const route = useRoute()
const message = useMessage()
const { user } = useSession()
const email = ref('')
const code = ref('')
const password = ref('')
const confirm = ref('')
const challengeId = ref('')
const issuedFor = ref('')
const expiresIn = ref(0)
const errors = ref<Record<string, string>>({})
const formError = ref('')
const pending = ref(false)
const sending = ref(false)
const cooldown = ref(0)
let timer = 0

watch(email, () => {
  if (email.value.trim() !== issuedFor.value) challengeId.value = ''
})
onUnmounted(() => window.clearInterval(timer))

const codeHint = computed(() =>
  challengeId.value ? `已发送，${Math.max(1, Math.round(expiresIn.value / 60))} 分钟内有效。` : '',
)

function startCooldown(): void {
  cooldown.value = 60
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) window.clearInterval(timer)
  }, 1000)
}

async function sendCode(): Promise<void> {
  errors.value.email = emailError(email.value) ?? ''
  if (errors.value.email || sending.value || cooldown.value > 0) return
  sending.value = true
  formError.value = ''
  try {
    const sentTo = email.value.trim()
    const result = await sendEmailCode(sentTo, 'RESET')
    if (email.value.trim() !== sentTo) {
      formError.value = '邮箱已变化，请重新发送验证码'
      return
    }
    issuedFor.value = sentTo
    challengeId.value = result.challengeId
    expiresIn.value = result.expiresIn
    code.value = ''
    startCooldown()
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    sending.value = false
  }
}

async function submit(): Promise<void> {
  errors.value = {
    email: emailError(email.value) ?? '',
    code: code.value.trim() ? '' : '请输入验证码',
    challenge: challengeId.value ? '' : '请先获取邮箱验证码',
    password: passwordError(password.value) ?? '',
    confirm: password.value === confirm.value ? '' : '两次密码不一致',
  }
  formError.value = ''
  if (Object.values(errors.value).some(Boolean) || pending.value) return
  pending.value = true
  try {
    await resetPassword({
      email: email.value.trim(),
      challengeId: challengeId.value,
      code: code.value.trim(),
      password: password.value,
    })
    password.value = ''
    confirm.value = ''
    code.value = ''
    if (user.value) {
      try {
        await logout()
      } catch (cause) {
        message.error(`密码已重置，但退出登录失败：${messageOf(cause)}`)
        return
      }
      setCsrfToken(null)
      clearSessionUser()
    }
    await router.replace({ name: 'login', query: { notice: 'reset', ...redirectQuery(route.query.redirect) } })
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <AuthLayout title="重置密码">
    <form class="form-grid" @submit.prevent="submit">
      <p v-if="formError" class="banner danger" role="alert">{{ formError }}</p>
      <p v-if="errors.challenge" class="field-error" role="alert">{{ errors.challenge }}</p>
      <Field label="注册邮箱" for-id="reset-email" :error="errors.email">
        <n-input id="reset-email" v-model:value="email" :input-props="{ autocomplete: 'email', spellcheck: false }" />
      </Field>
      <div class="row">
        <n-button :loading="sending" :disabled="sending || cooldown > 0" @click="sendCode">
          {{ cooldown > 0 ? `${cooldown} 秒后可再次发送` : '发送验证码' }}
        </n-button>
      </div>
      <Field label="邮箱验证码" for-id="reset-code" :error="errors.code" :hint="codeHint">
        <n-input id="reset-code" v-model:value="code" :input-props="{ autocomplete: 'one-time-code', inputmode: 'numeric' }" />
      </Field>
      <Field label="新密码" for-id="reset-password" :error="errors.password" hint="至少 8 位，含字母和数字">
        <n-input id="reset-password" v-model:value="password" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
      </Field>
      <Field label="再次输入新密码" for-id="reset-confirm" :error="errors.confirm">
        <n-input id="reset-confirm" v-model:value="confirm" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
      </Field>
      <n-button attr-type="submit" type="primary" :loading="pending" :disabled="pending">重置密码</n-button>
      <div class="auth-links">
        <RouterLink :to="{ path: '/login', query: redirectQuery(route.query.redirect) }">返回登录</RouterLink>
        <RouterLink v-if="user" to="/">返回考核</RouterLink>
      </div>
    </form>
  </AuthLayout>
</template>
