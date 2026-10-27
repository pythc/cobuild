/// <reference types="vite/client" />

import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    guest?: boolean
    auth?: boolean
    role?: 'CANDIDATE' | 'ADMIN'
  }
}
