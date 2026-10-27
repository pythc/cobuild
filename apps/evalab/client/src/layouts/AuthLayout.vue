<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { redirectQuery } from '../lib/nav'
import AppMark from '../components/AppMark.vue'
defineProps<{ title: string }>()
const route = useRoute()
const accountConnection = computed(() => typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/api/public-identity/authorize?'))
</script>

<template>
  <div class="auth-screen">
    <aside class="auth-aside">
      <RouterLink class="sider-brand auth-brand" :to="{ path: '/login', query: { ...redirectQuery(route.query.redirect), ...(route.query.switch === '1' ? { switch: '1' } : {}) } }">
        <AppMark />
        <span class="brand-name">110 LAB</span>
      </RouterLink>
      <div class="auth-story">
        <h1 v-if="accountConnection">110 LAB<br />账号登录<span class="auth-dot">。</span></h1>
        <h1 v-else>110 实验室<br />考核系统<span class="auth-dot">。</span></h1>
      </div>
      <div class="auth-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
    </aside>
    <main class="auth-main" id="main">
      <section class="auth-card">
        <div class="auth-mobile-brand"><AppMark /><span>{{ accountConnection ? '110 LAB 账号' : '110 实验室考核系统' }}</span></div>
        <h2>{{ title }}</h2>
        <slot />
      </section>
    </main>
  </div>
</template>
