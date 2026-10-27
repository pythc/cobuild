<script setup lang="ts">
import {
  BookOpen,
  CalendarDays,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  UserRound,
  Users,
  X,
} from 'lucide-vue-next'
import { NButton, useMessage } from 'naive-ui'
import { computed, nextTick, onUnmounted, ref, watch, type Component } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { logout } from '../api/auth'
import { setCsrfToken } from '../api/csrf'
import { messageOf } from '../api/http'
import AppMark from '../components/AppMark.vue'
import { clearSessionUser, useSession } from '../session'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const { user } = useSession()
const navOpen = ref(false)
const leaving = ref(false)
const sider = ref<HTMLElement | null>(null)

interface NavItem {
  label: string
  to: string
  icon: Component
  exact?: boolean
  match?: string
  gap?: boolean
}

const candidateNav: NavItem[] = [
  { label: '招新考核', to: '/recruitment', icon: ClipboardList, match: '/recruitment' },
  { label: '我的提交', to: '/submissions', icon: ScrollText, match: '/submissions' },
  { label: '个人信息', to: '/profile', icon: UserRound, match: '/profile' },
]

const adminNav: NavItem[] = [
  { label: '运营工作台', to: '/admin', icon: LayoutDashboard, exact: true },
  { gap: true, label: '', to: '', icon: LayoutDashboard },
  { label: '考核批次', to: '/admin/batches', icon: CalendarDays },
  { label: '考核题库', to: '/admin/questions', icon: BookOpen },
  { gap: true, label: '', to: '', icon: Users },
  { label: '候选人与评审', to: '/admin/candidates', icon: Users },
  { label: '操作记录', to: '/admin/audit', icon: ScrollText },
]

const items = computed(() => (user.value?.role === 'ADMIN' ? adminNav : candidateNav))
const home = computed(() => (user.value?.role === 'ADMIN' ? '/admin' : '/recruitment'))
const roleLabel = computed(() => (user.value?.role === 'ADMIN' ? '管理员' : '考生'))

function active(item: { to: string; exact?: boolean; match?: string }): boolean {
  if (item.exact) return route.path === item.to
  const base = item.match ?? item.to
  return route.path === base || route.path.startsWith(`${base}/`)
}

function closeNav(): void {
  navOpen.value = false
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeNav()
}

watch(navOpen, async (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
  if (open) {
    document.addEventListener('keydown', onKey)
    await nextTick()
    sider.value?.querySelector('a')?.focus()
  } else {
    document.removeEventListener('keydown', onKey)
  }
})

watch(() => route.fullPath, closeNav)
onUnmounted(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
})

async function signOut(): Promise<void> {
  if (leaving.value) return
  leaving.value = true
  try {
    await logout()
    setCsrfToken(null)
    clearSessionUser()
    await router.replace('/login')
  } catch (cause) {
    message.error(messageOf(cause))
  } finally {
    leaving.value = false
  }
}
</script>

<template>
  <div class="shell">
    <a class="skip" href="#main">跳到主要内容</a>
    <button v-if="navOpen" class="scrim" type="button" aria-label="关闭导航" @click="closeNav" />
    <aside ref="sider" class="sider" :class="{ open: navOpen }" :aria-label="user?.role === 'ADMIN' ? '管理导航' : '考生导航'">
      <RouterLink class="sider-brand" :to="home" @click="closeNav">
        <AppMark />
        <span>
          <span class="brand-name">110 LAB</span>
          <span class="brand-sub">实验室考核</span>
        </span>
      </RouterLink>
      <nav class="nav">
        <template v-for="(item, index) in items" :key="`${item.label}-${index}`">
          <div v-if="item.gap" class="nav-gap" />
          <RouterLink
            v-else
            class="nav-link"
            :class="{ active: active(item) }"
            :to="item.to"
            :aria-current="active(item) ? 'page' : undefined"
            @click="closeNav"
          >
            <component :is="item.icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
            {{ item.label }}
          </RouterLink>
        </template>
      </nav>
      <div class="sider-foot">
        <div class="who">
          <strong>{{ user?.name || '未命名' }}</strong>
          <span>{{ roleLabel }}</span>
        </div>
        <n-button quaternary size="small" :loading="leaving" aria-label="退出登录" @click="signOut">
          <LogOut :size="16" aria-hidden="true" />
        </n-button>
      </div>
    </aside>
    <div class="shell-main">
      <header class="topbar">
        <button class="icon-btn" type="button" :aria-expanded="navOpen" :aria-label="navOpen ? '关闭导航' : '打开导航'" @click="navOpen = !navOpen">
          <Menu v-if="!navOpen" :size="18" aria-hidden="true" />
          <X v-else :size="18" aria-hidden="true" />
        </button>
        <span class="topbar-title">{{ route.meta.title || '110 LAB' }}</span>
      </header>
      <main id="main" class="content" tabindex="-1">
        <router-view />
      </main>
    </div>
  </div>
</template>
