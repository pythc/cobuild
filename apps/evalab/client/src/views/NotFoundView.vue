<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppMark from '../components/AppMark.vue'
import { useSession } from '../session'

const { user } = useSession()
</script>

<template>
  <main class="gate" id="main">
    <section class="gate-card">
      <AppMark />
      <h1 style="margin-top: 12px">页面不存在</h1>
      <p class="muted" style="margin-top: 6px">这个地址没有对应的功能。</p>
      <div class="row" style="margin-top: 16px">
        <RouterLink v-if="user?.role === 'ADMIN'" to="/admin">返回工作台</RouterLink>
        <RouterLink v-else-if="user" to="/recruitment">返回招新考核</RouterLink>
        <RouterLink v-else to="/login">去登录</RouterLink>
      </div>
    </section>
  </main>
</template>
