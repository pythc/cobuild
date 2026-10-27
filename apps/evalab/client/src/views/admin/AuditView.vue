<script setup lang="ts">
import { NButton, useMessage } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { downloadExport, fetchAudit } from '../../api/admin'
import { messageOf, saveBlob, safeFilename } from '../../api/http'
import PageHeader from '../../components/PageHeader.vue'
import StateBlock from '../../components/StateBlock.vue'
import { formatDateTime, auditLabel } from '../../lib/format'
import { formatDetails } from '../../lib/text'
import type { AuditEvent } from '../../types'

const message = useMessage()
const loading = ref(true)
const error = ref('')
const events = ref<AuditEvent[]>([])
const exporting = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    events.value = await fetchAudit()
  } catch (cause) {
    events.value = []
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function exportCsv(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const file = await downloadExport()
    if (file.blob.size === 0) {
      message.error('服务器返回了空文件')
      return
    }
    saveBlob(file.blob, safeFilename(file.filename || '110lab-export.csv', '110lab-export.csv'))
    message.success('已开始下载')
  } catch (cause) {
    message.error(messageOf(cause))
  } finally {
    exporting.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section>
    <PageHeader title="操作记录">
      <template #actions>
        <n-button :loading="exporting" @click="exportCsv">导出 CSV</n-button>
      </template>
    </PageHeader>
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!loading && !error && events.length === 0"
      empty-title="还没有操作记录"
      @retry="load"
    >
      <div class="table-wrap card">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作者</th>
              <th>动作</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>{{ formatDateTime(event.createdAt) }}</td>
              <td>{{ event.actorName || '—' }}</td>
              <td>{{ auditLabel(event.action || '—') }}</td>
              <td><pre class="pre">{{ formatDetails(event.details) }}</pre></td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </section>
</template>
