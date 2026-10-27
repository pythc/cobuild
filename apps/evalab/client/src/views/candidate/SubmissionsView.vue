<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchMyEnrollments } from '../../api/candidate'
import { messageOf } from '../../api/http'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import StatusPill from '../../components/StatusPill.vue'
import { syncServerNow } from '../../clock'
import { directionLabel, formatDateTime } from '../../lib/format'
import type { Enrollment } from '../../types'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const rows = ref<Enrollment[]>([])

const empty = computed(() => rows.value.length === 0)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchMyEnrollments()
    if (data.serverNow) syncServerNow(data.serverNow)
    rows.value = data.enrollments
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function open(enrollment: Enrollment): void {
  const path = enrollment.state === 'READY' ? 'prepare' : 'exam'
  void router.push(`/recruitment/${path}/${enrollment.id}`)
}
</script>

<template>
  <section>
    <PageHeader
      title="我的提交"
    />
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!loading && !error && empty"
      empty-title="还没有报名"
      empty-text="先到招新考核选择一个批次和方向。"
      @retry="load"
    >
      <div class="table-wrap card">
        <table class="data-table">
          <thead>
            <tr>
              <th>轮次</th>
              <th>批次</th>
              <th>方向</th>
              <th>状态</th>
              <th>交卷</th>
              <th>成绩</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in rows" :key="item.id">
              <td>{{ item.roundName || '—' }}</td>
              <td>{{ item.batchName || '—' }}</td>
              <td>{{ directionLabel(item.direction) || '—' }}</td>
              <td><StatusPill :state="item.state" /></td>
              <td>{{ formatDateTime(item.finalizedAt) }}</td>
              <td>
                <template v-if="item.result">{{ item.result.score }} 分</template>
                <template v-else-if="item.state === 'FINALIZED'">结果未发布</template>
                <template v-else>—</template>
              </td>
              <td><n-button size="small" @click="open(item)">查看</n-button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </section>
</template>
