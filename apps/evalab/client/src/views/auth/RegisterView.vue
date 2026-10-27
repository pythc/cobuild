<script setup lang="ts">
import { NButton, NCheckbox, NInput } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { register, sendEmailCode } from '../../api/auth'
import { messageOf } from '../../api/http'
import Field from '../../components/Field.vue'
import RegistrationCheck from '../../components/RegistrationCheck.vue'
import { clearDraft, readDraft, writeDraft } from '../../draft'
import AuthLayout from '../../layouts/AuthLayout.vue'
import { emailError, normalizePhone, passwordError, personNameError, phoneError, requiredText, studentNoError } from '../../lib/text'
import { landingPath, redirectQuery } from '../../lib/nav'
import { setSessionUser } from '../../session'

const DRAFT = 'register-profile'
const route = useRoute()
const router = useRouter()
const accountConnection = computed(() => typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/api/public-identity/authorize?'))
const name = ref('')
const studentNo = ref('')
const college = ref('')
const major = ref('')
const phone = ref('')
const email = ref('')
const password = ref('')
const code = ref('')
const accepted = ref(false)
const challengeId = ref('')
const issuedFor = ref('')
const expiresIn = ref(0)
const errors = ref<Record<string, string>>({})
const formError = ref('')
const pending = ref(false)
const sending = ref(false)
const cooldown = ref(0)
const securityCheck = ref<InstanceType<typeof RegistrationCheck> | null>(null)
let timer = 0

const codeHint = computed(() => {
  if (!challengeId.value) return ''
  const minutes = Math.max(1, Math.round(expiresIn.value / 60))
  return `已发送，${minutes} 分钟内有效。`
})

onMounted(() => {
  const saved = readDraft(DRAFT)
  if (!saved) return
  try {
    const parsed = JSON.parse(saved) as Record<string, string>
    name.value = parsed.name ?? ''
    studentNo.value = parsed.studentNo ?? ''
    college.value = parsed.college ?? ''
    major.value = parsed.major ?? ''
    phone.value = parsed.phone ?? ''
    email.value = parsed.email ?? ''
  } catch {
    clearDraft(DRAFT)
  }
})

watch(email, () => {
  securityCheck.value?.cancel()
  if (email.value.trim() !== issuedFor.value) challengeId.value = ''
})

onUnmounted(() => window.clearInterval(timer))

watch([name, studentNo, college, major, phone, email], () => {
  writeDraft(
    DRAFT,
    JSON.stringify({
      name: name.value,
      studentNo: studentNo.value,
      college: college.value,
      major: major.value,
      phone: phone.value,
      email: email.value,
    }),
  )
})

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
    const proof = await securityCheck.value?.verify(sentTo)
    if (!proof || email.value.trim() !== sentTo) return
    const result = await sendEmailCode(sentTo, 'REGISTER', proof)
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

function validate(): boolean {
  const next: Record<string, string> = {
    name: personNameError(name.value) ?? '',
    studentNo: studentNoError(studentNo.value) ?? '',
    college: requiredText(college.value, '学院') ?? '',
    major: requiredText(major.value, '专业') ?? '',
    phone: phoneError(phone.value) ?? '',
    email: emailError(email.value) ?? '',
    password: passwordError(password.value) ?? '',
    code: code.value.trim() ? '' : '请输入邮箱验证码',
    accepted: accepted.value ? '' : '请确认考生身份与信息用途',
    challenge: challengeId.value ? '' : '请先获取邮箱验证码',
  }
  errors.value = next
  return Object.values(next).every((item) => !item)
}

async function submit(): Promise<void> {
  formError.value = ''
  if (!validate() || pending.value) return
  pending.value = true
  try {
    const result = await register({
      name: name.value.trim(),
      studentNo: studentNo.value.trim(),
      college: college.value.trim(),
      major: major.value.trim(),
      phone: normalizePhone(phone.value),
      email: email.value.trim(),
      password: password.value,
      challengeId: challengeId.value,
      code: code.value.trim(),
      acceptedPolicy: true,
      registrationContext: accountConnection.value ? 'ACCOUNT_TEAMING' : 'ASSESSMENT',
    })
    password.value = ''
    code.value = ''
    clearDraft(DRAFT)
    setSessionUser(result.user)
    await router.replace(landingPath(result.user.role, route.query.redirect))
  } catch (cause) {
    formError.value = messageOf(cause)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <AuthLayout title="注册">
    <form class="form-grid" @submit.prevent="submit">
      <p v-if="formError" class="banner danger" role="alert">{{ formError }}</p>
      <p v-if="errors.challenge" class="field-error" role="alert">{{ errors.challenge }}</p>
      <RegistrationCheck ref="securityCheck" />
      <Field label="姓名" for-id="name" :error="errors.name">
        <n-input id="name" v-model:value="name" :input-props="{ autocomplete: 'name' }" />
      </Field>
      <Field label="学号" for-id="student-no" :error="errors.studentNo">
        <n-input id="student-no" v-model:value="studentNo" :input-props="{ autocomplete: 'off', spellcheck: false, inputmode: 'numeric' }" />
      </Field>
      <Field label="学院" for-id="college" :error="errors.college">
        <n-input id="college" v-model:value="college" :input-props="{ autocomplete: 'organization' }" />
      </Field>
      <Field label="专业" for-id="major" :error="errors.major">
        <n-input id="major" v-model:value="major" />
      </Field>
      <Field label="手机" for-id="phone" :error="errors.phone">
        <n-input id="phone" v-model:value="phone" :input-props="{ autocomplete: 'tel', inputmode: 'tel' }" />
      </Field>
      <Field label="邮箱" for-id="email" :error="errors.email">
        <n-input id="email" v-model:value="email" placeholder="请输入邮箱" :input-props="{ autocomplete: 'email', spellcheck: false }" />
      </Field>
      <div class="row">
        <n-button :loading="sending" :disabled="sending || cooldown > 0" @click="sendCode">
          {{ cooldown > 0 ? `${cooldown} 秒后可再次发送` : challengeId ? '重新发送验证码' : '发送验证码' }}
        </n-button>
      </div>
      <Field label="邮箱验证码" for-id="code" :error="errors.code" :hint="codeHint">
        <n-input id="code" v-model:value="code" :input-props="{ autocomplete: 'one-time-code', inputmode: 'numeric', spellcheck: false }" />
      </Field>
      <Field label="密码" for-id="new-password" :error="errors.password" hint="至少 8 位，含字母和数字">
        <n-input id="new-password" v-model:value="password" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
      </Field>
      <label class="switch-row">
        <n-checkbox v-model:checked="accepted" />
        <span>{{ accountConnection ? '我确认是重邮在校生，资料真实，同意用于账号注册与竞赛组队。' : '我确认是重邮在校生，资料真实，并同意用于本次考核。' }}</span>
      </label>
      <p v-if="errors.accepted" class="field-error" role="alert">{{ errors.accepted }}</p>
      <n-button attr-type="submit" type="primary" :loading="pending" :disabled="pending">创建账号</n-button>
      <div class="auth-links">
        <RouterLink :to="{ path: '/login', query: redirectQuery(route.query.redirect) }">已有账号，去登录</RouterLink>
      </div>
    </form>
  </AuthLayout>
</template>
