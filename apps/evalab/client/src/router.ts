import { createRouter, createWebHistory } from 'vue-router'
import { setUnauthorizedHandler } from './api/csrf'
import { landingPath } from './lib/nav'
import { clearSessionUser, ensureSession, useSession } from './session'

const { user } = useSession()

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior() {
    return { top: 0 }
  },
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/auth/LoginView.vue'),
      meta: { guest: true, title: '登录' },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('./views/auth/RegisterView.vue'),
      meta: { guest: true, title: '注册' },
    },
    {
      path: '/reset-password',
      name: 'reset',
      component: () => import('./views/auth/ResetView.vue'),
      meta: { title: '重置密码' },
    },
    {
      path: '/',
      component: () => import('./layouts/AppShell.vue'),
      meta: { auth: true },
      children: [
        {
          path: 'recruitment',
          name: 'recruitment',
          component: () => import('./views/candidate/RecruitmentView.vue'),
          meta: { role: 'CANDIDATE', title: '招新考核' },
        },
        {
          path: 'recruitment/prepare/:id',
          name: 'prepare',
          component: () => import('./views/candidate/PrepareView.vue'),
          meta: { role: 'CANDIDATE', title: '开考准备' },
        },
        {
          path: 'recruitment/exam/:id',
          name: 'exam',
          component: () => import('./views/candidate/ExamView.vue'),
          meta: { role: 'CANDIDATE', title: '考核' },
        },
        {
          path: 'submissions',
          name: 'submissions',
          component: () => import('./views/candidate/SubmissionsView.vue'),
          meta: { role: 'CANDIDATE', title: '我的提交' },
        },
        {
          path: 'profile',
          name: 'profile',
          component: () => import('./views/candidate/ProfileView.vue'),
          meta: { role: 'CANDIDATE', title: '个人信息' },
        },
        {
          path: 'mcp/connect',
          name: 'mcp-connect',
          component: () => import('./views/candidate/McpConnectView.vue'),
          meta: { role: 'CANDIDATE', title: '连接确认' },
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('./views/admin/OverviewView.vue'),
          meta: { role: 'ADMIN', title: '运营工作台' },
        },
        {
          path: 'admin/batches',
          name: 'admin-batches',
          component: () => import('./views/admin/BatchesView.vue'),
          meta: { role: 'ADMIN', title: '考核批次' },
        },
        {
          path: 'admin/questions',
          name: 'admin-questions',
          component: () => import('./views/admin/QuestionsView.vue'),
          meta: { role: 'ADMIN', title: '考核题库' },
        },
        {
          path: 'admin/candidates',
          name: 'admin-candidates',
          component: () => import('./views/admin/CandidatesView.vue'),
          meta: { role: 'ADMIN', title: '候选人与评审' },
        },
        {
          path: 'admin/candidates/:id',
          name: 'admin-candidate',
          component: () => import('./views/admin/CandidateDetailView.vue'),
          meta: { role: 'ADMIN', title: '考生详情' },
        },
        {
          path: 'admin/audit',
          name: 'admin-audit',
          component: () => import('./views/admin/AuditView.vue'),
          meta: { role: 'ADMIN', title: '操作记录' },
        },
      ],
    },
    {
      path: '/exam/:id',
      redirect: (to) => ({
        name: 'exam',
        params: { id: String(to.params.id) },
        query: to.query,
      }),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('./views/NotFoundView.vue'),
      meta: { title: '页面不存在' },
    },
  ],
})

function homeOf(role: string | undefined): string {
  return role === 'ADMIN' ? '/admin' : '/recruitment'
}

setUnauthorizedHandler(() => {
  clearSessionUser()
  const current = router.currentRoute.value
  if (current.name === 'login') return
  const redirect = current.fullPath
  void router.replace({
    name: 'login',
    query: redirect.startsWith('/') && redirect !== '/' && redirect !== '/login' ? { redirect } : {},
  })
})

router.beforeEach(async (to) => {
  if (to.path === '/api/public-identity/authorize') {
    window.location.replace(to.fullPath)
    return false
  }
  await ensureSession()
  const current = user.value
  if (to.meta.guest && current && !(to.path === '/login' && to.query.switch === '1')) return landingPath(current.role, to.query.redirect)
  const needsAuth = to.matched.some((record) => record.meta.auth)
  if (needsAuth && !current) {
    const redirect = to.fullPath
    return {
      name: 'login',
      query: redirect !== '/' ? { redirect } : {},
    }
  }
  if (to.meta.role && current && current.role !== to.meta.role) return homeOf(current.role)
  if (to.path === '/') return homeOf(current?.role)
  return true
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = title ? `${title} · 110 LAB` : '110 LAB · 实验室考核'
})

// A release may replace lazy chunks while an already-open tab still has the old index.
router.onError((error, to) => {
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk .* failed/i.test(String(error))) return
  const key = 'lab110.chunk-reload'
  try {
    const previous = Number(sessionStorage.getItem(key) || 0)
    if (Date.now() - previous < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
    window.location.replace(to.fullPath)
  } catch { /* Preserve the current page if storage is unavailable. */ }
})
