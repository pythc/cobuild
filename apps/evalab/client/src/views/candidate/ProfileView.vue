<script setup lang="ts">
import PageHeader from '../../components/PageHeader.vue'
import { display } from '../../lib/format'
import { useSession } from '../../session'

const { user } = useSession()
</script>

<template>
  <section>
    <PageHeader title="个人信息" />
    <article v-if="user" class="card">
      <dl class="kv">
        <dt>姓名</dt>
        <dd>{{ display(user.name) }}</dd>
        <dt>学号</dt>
        <dd>{{ display(user.studentNo) }}</dd>
        <dt>学院</dt>
        <dd>{{ display(user.college) }}</dd>
        <dt>专业</dt>
        <dd>{{ display(user.major) }}</dd>
        <dt>手机</dt>
        <dd>{{ display(user.phone) }}</dd>
        <dt>邮箱</dt>
        <dd>{{ display(user.email) }}</dd>
      </dl>
      <p class="tiny" style="margin-top: 14px">
        <RouterLink to="/reset-password">重置密码</RouterLink>
      </p>
    </article>
    <p v-else class="muted">没有读取到个人信息。</p>
  </section>
</template>
