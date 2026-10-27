<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login } from '../../api/auth'
import { messageOf } from '../../api/http'
import Field from '../../components/Field.vue'
import AuthLayout from '../../layouts/AuthLayout.vue'
import { landingPath, redirectQuery } from '../../lib/nav'
import { setSessionUser } from '../../session'

const route = useRoute()
const router = useRouter()
const account = ref('')
const password = ref('')
const accountError = ref('')
const passwordError = ref('')
const formError = ref('')
const pending = ref(false)
const notice = route.query.notice === 'reset' ? '密码已重置，请重新登录。' : ''

async function submit(): Promise<void> {
  accountError.value = account.value.trim() ? '' : '请输入邮箱或学号'
  passwordError.value = password.value ? '' : '请输入密码'
  formError.value = ''
  if (accountError.value || passwordError.value || pending.value) return
  pending.value = true
  try {
    const result = await login(account.value.trim(), password.value)
    password.value = ''
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
  <AuthLayout title="登录">
    <form class="form-grid" @submit.prevent="submit">
      <p v-if="notice" class="banner ok">{{ notice }}</p>
      <p v-if="formError" class="banner danger" role="alert">{{ formError }}</p>
      <Field label="邮箱或学号" for-id="account" :error="accountError">
        <n-input
          id="account"
          v-model:value="account"
          placeholder="请输入邮箱或学号"
          :input-props="{ autocomplete: 'username', spellcheck: false, 'aria-invalid': accountError ? 'true' : 'false', 'aria-describedby': accountError ? 'account-err' : undefined }"
        />
      </Field>
      <Field label="密码" for-id="password" :error="passwordError">
        <n-input
          id="password"
          v-model:value="password"
          type="password"
          show-password-on="click"
          :input-props="{ autocomplete: 'current-password', 'aria-invalid': passwordError ? 'true' : 'false' }"
        />
      </Field>
      <n-button attr-type="submit" type="primary" :loading="pending" :disabled="pending">登录</n-button>
      <div class="auth-links">
        <RouterLink :to="{ path: '/register', query: redirectQuery(route.query.redirect) }">注册账号</RouterLink>
        <RouterLink :to="{ path: '/reset-password', query: redirectQuery(route.query.redirect) }">忘记密码</RouterLink>
      </div>
    </form>
  </AuthLayout>
</template>
