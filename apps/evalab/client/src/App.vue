<script setup lang="ts">
import { NButton, NConfigProvider, NMessageProvider, dateZhCN, zhCN } from 'naive-ui'
import { useRouter } from 'vue-router'
import { retrySession, useSession } from './session'
import { themeOverrides } from './theme'

const router = useRouter()
const { ready, error, user } = useSession()

async function retry(): Promise<void> {
  await retrySession()
  if (!error.value) await router.replace(user.value ? '/' : '/login')
}
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div v-if="!ready" class="boot" role="status">正在确认登录状态…</div>
      <div v-else-if="error" class="gate">
        <section class="gate-card">
          <h1>暂时无法确认登录状态</h1>
          <p class="muted" style="margin-top: 8px">{{ error }}</p>
          <div class="row" style="margin-top: 16px">
            <n-button type="primary" @click="retry">重试</n-button>
          </div>
        </section>
      </div>
      <router-view v-else />
    </n-message-provider>
  </n-config-provider>
</template>
