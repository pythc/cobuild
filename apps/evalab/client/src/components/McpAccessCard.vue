<script setup lang="ts">
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { fetchAgentConnections, issueMcpToken, revokeAgentConnection } from '../api/candidate'
import { messageOf } from '../api/http'
import { BRIDGE_PACKAGE, MCP_SERVER_NAME, UPLOAD_HELPER } from '../content/upload'
import { formatDateTime } from '../lib/format'
import type { AgentConnection } from '../types'
import CopyButton from './CopyButton.vue'

const props = defineProps<{
  enrollmentId: string
  connected: boolean
  enabled: boolean
}>()

const emit = defineEmits<{ refresh: [] }>()
const message = useMessage()
const pending = ref(false)
const tokenError = ref('')
const connectionsError = ref('')
const revokeError = ref('')
const token = ref('')
const issuedMcpUrl = ref('')
const expiresAt = ref('')
const connections = ref<AgentConnection[]>([])
const revoking = ref('')
const advancedOpen = ref(false)
let fetchingEnrollment = ''
let generation = 0
let poll = 0

const origin = computed(() => window.location.origin)
const mcpEndpoint = computed(() => `${origin.value}/mcp`)
const packageUrl = computed(() => `${origin.value}/downloads/${BRIDGE_PACKAGE}`)
const helperUrl = computed(() => `${origin.value}/downloads/${UPLOAD_HELPER}?v=0.2.2`)

const statusText = computed(() =>
  props.connected
    ? '连接测试已通过。'
    : '等待 Agent 连接并完成测试',
)

const agentInstructions = computed(() =>
  [
    `请连接远程 MCP「${MCP_SERVER_NAME}」，地址是 ${mcpEndpoint.value}。`,
    '如果你有 MCP 配置能力，请为当前客户端添加这个远程地址，传输用 Streamable HTTP，认证用 OAuth；没有配置权限时，告诉我在哪里添加。无需安装本地桥。浏览器会打开授权页，必须由我本人点击允许，不要代我同意。',
    '连上之后先调用 test_connection。成功后再调用 exam_status，读取本场真实状态、方向、题目、截止时间、已确认仓库 SHA、直接上传同意和材料回执。不要编造题目。连接、初始化和 test_connection 不要求上传文件，也不开始计时。',
    '当我要求提交材料时，所需材料只是当前 Agent 客户端、当前这段对话的原始日志文件。用当前会话 id、日志路径或会话索引元数据识别。同一段对话的原始日志分段才可一并包含。仅工作区相同不能证明属于当前对话。不要改用其他会话、其他客户端、重建的转录、摘要或转换后的导出。无法识别时如实报告阻碍，不要静默改用其他会话。',
    'exam_status 确认已有同意、考核进行中且仓库 SHA 已确认后，在现有文件权限内直接进行。不要再提问，不要再请求一次上传批准，不要让我重新选择文件，也不要重复已经知道的客户端、模型或项目信息。简短说明正在上传当前会话的原始日志；这是告知，不是确认关卡。不要隐瞒上传。',
    '调用 submit_materials，参数只含已确认的 repoSha、clients、projectSummary、collaborationSummary。已知的客户端或模型照实填写，没有的值用 unknown，不要猜测。不要在参数里放文件正文或文件哈希。',
    `然后下载返回的官方 helper 并运行：python3 ${UPLOAD_HELPER} --url UPLOAD_URL --token UPLOAD_TOKEN --snapshot --file RAW_LOG_PATH。只有同一当前对话的原始分段才重复 --file；也可以用 --ticket-file TICKET.json。当前会话原始日志不要使用 --payload-json。helper 地址：${helperUrl.value}。helper 在开始捕获时做逐字节快照，不改动原文件，并上传该快照。合计不超过 1 GiB，最多 20 个文件。不要把原始日志正文读进上下文，不要改写、脱敏、删减、重排、重新编码或重建。`,
    '缺少同意、权限、仓库确认，或无法识别、无法取得原始日志，都是阻碍：如实报告。不要绕过，不要改传另一段对话，也不要声称已完成。不要另行收集无关对话、其他项目、凭据库或隐藏说明文件。总结不能代替原始日志。',
    '上传后调用 exam_status，确认材料回执与仓库 SHA 一致。收到材料不等于交卷。必须由我在网页点击「确认交卷」，你不能宣称已交卷。',
  ].join('\n'),
)

const bridgeInstructions = [
  '你正在协助完成 110 实验室考核。这个本地桥只作用于已配置的考核工作区和明确授权的上下文根目录。启动时不上传任何内容，也不能读取任意主目录。',
  '先调用 test_connection 做预检。exam_status 读取本场报名、截止时间、已确认仓库 SHA、同意和回执。开考前不要上传材料。',
  '当我要求提交材料时，所需材料只是当前 Agent 客户端、当前这段对话的原始日志文件。用当前会话 id、日志路径或会话索引元数据识别。同一段对话的原始日志分段才可一并包含。仅工作区相同不能证明属于当前对话。不要改用其他会话、其他客户端、重建的转录、摘要或转换后的导出。',
  'exam_status 确认已有同意、考核进行中且仓库 SHA 已确认后，在现有文件权限内直接进行。不要再提问，不要再请求一次上传批准，不要让我重新选择文件，也不要重复已经知道的客户端、模型或项目信息。简短说明正在上传当前会话的原始日志；这是告知，不是确认关卡。不要隐瞒上传。缺少同意、权限、仓库确认，或无法识别、无法取得原始日志，都是阻碍：如实报告。不要绕过，不要改传另一段对话，也不要声称已完成。',
  '路径已知时，用 find_candidate_files 的 explicitPaths 指向当前客户端当前会话的原始日志。该工具只返回候选元数据；同一工作区可能列出其他会话，只保留已核实属于当前对话的编号。不要把日志正文读进模型上下文。无法识别，或文件位于授权根目录之外时，报告阻碍，不要改用其他文件。',
  '调用 submit_files，传入这些 fileIds、已确认的 repoSha、客户端和模型元数据，以及根据已经可见的对话写成的简要项目与协作总结。未知的客户端或模型必须写成 unknown。网页已记录同意且我已要求提交后，不要再问选文件或上传确认。告诉我正在上传。不要隐瞒。',
  'submit_files 会在传输仍在增长的日志之前捕获逐字节快照。原文件不会被修改。只有快照开始之后追加的内容不在捕获版本中；已捕获的字节不会被过滤、脱敏、删减、转换或重建。哈希和文件正文由程序处理，不要放进工具参数。合计不超过 1 GiB，最多 20 个文件。',
  '上传后用 exam_status 核对回执和仓库 SHA。总结不能代替原始日志。这个桥不能完成交卷；必须由我在网页点击「确认交卷」。你不能宣称已交卷。',
].join('\n')

function mcpPathOf(url: string): string {
  try {
    const path = new URL(url).pathname
    if (!path || path === '/') return '/mcp'
    return path
  } catch {
    return '/mcp'
  }
}

const cursorConfig = computed(() => {
  if (!token.value) return ''
  const env: Record<string, string> = {
    ASSESSMENT_URL: origin.value,
    ASSESSMENT_MCP_TOKEN: token.value,
    ASSESSMENT_WORKSPACE: '/ABS/exam-project',
    ASSESSMENT_CONTEXT_ROOTS: JSON.stringify(['/ABS/exam-project']),
  }
  const path = mcpPathOf(issuedMcpUrl.value)
  if (path !== '/mcp') env.ASSESSMENT_MCP_PATH = path
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'npx',
          args: ['-y', packageUrl.value],
          env,
        },
      },
    },
    null,
    2,
  )
})

function stopPoll(): void {
  window.clearInterval(poll)
  poll = 0
}

function startPoll(): void {
  stopPoll()
  if (props.connected) return
  poll = window.setInterval(() => {
    if (document.hidden || props.connected) return
    emit('refresh')
    void loadConnections()
  }, 4000)
}

function onVisible(): void {
  if (document.hidden || props.connected) return
  emit('refresh')
  void loadConnections()
}

async function loadConnections(): Promise<void> {
  if (fetchingEnrollment === props.enrollmentId) return
  fetchingEnrollment = props.enrollmentId
  const current = ++generation
  const enrollmentId = props.enrollmentId
  try {
    const list = await fetchAgentConnections(enrollmentId)
    if (current !== generation || enrollmentId !== props.enrollmentId) return
    connections.value = list
    connectionsError.value = ''
  } catch (cause) {
    if (current !== generation || enrollmentId !== props.enrollmentId) return
    connectionsError.value = messageOf(cause)
  } finally {
    if (fetchingEnrollment === enrollmentId) fetchingEnrollment = ''
  }
}

function refreshNow(): void {
  emit('refresh')
  void loadConnections()
}

function onAdvancedToggle(event: Event): void {
  const target = event.currentTarget
  if (target instanceof HTMLDetailsElement) advancedOpen.value = target.open
}

async function issue(): Promise<void> {
  if (pending.value || !props.enabled) return
  const targetEnrollment = props.enrollmentId
  pending.value = true
  tokenError.value = ''
  token.value = ''
  try {
    const issued = await issueMcpToken(targetEnrollment)
    if (targetEnrollment !== props.enrollmentId) return
    token.value = issued.token
    issuedMcpUrl.value = issued.mcpUrl
    expiresAt.value = issued.expiresAt
    advancedOpen.value = true
    message.success('令牌已签发，请立即复制配置')
    await loadConnections()
    emit('refresh')
  } catch (cause) {
    tokenError.value = messageOf(cause)
  } finally {
    pending.value = false
  }
}

async function revoke(connectionId: string): Promise<void> {
  if (revoking.value) return
  revoking.value = connectionId
  revokeError.value = ''
  try {
    await revokeAgentConnection(props.enrollmentId, connectionId)
    await loadConnections()
    emit('refresh')
    if (connections.value.some((item) => item.id === connectionId)) {
      revokeError.value = '撤销请求已返回，但这条连接仍在列表中。请再试一次。'
    }
  } catch (cause) {
    revokeError.value = messageOf(cause)
  } finally {
    revoking.value = ''
  }
}

onMounted(() => {
  void loadConnections()
  startPoll()
  document.addEventListener('visibilitychange', onVisible)
})

onUnmounted(() => {
  generation += 1
  stopPoll()
  document.removeEventListener('visibilitychange', onVisible)
})

watch(
  () => props.connected,
  (connected) => {
    if (connected) {
      stopPoll()
      void loadConnections()
      return
    }
    startPoll()
  },
)

watch(
  () => props.enrollmentId,
  () => {
    token.value = ''
    issuedMcpUrl.value = ''
    expiresAt.value = ''
    tokenError.value = ''
    revokeError.value = ''
    connections.value = []
    void loadConnections()
    startPoll()
  },
)
</script>

<template>
  <div class="stack">
    <p class="banner" :class="connected ? 'ok' : 'warn'" role="status">{{ statusText }}</p>
    <div>
      <p class="field-label">MCP 地址</p>
      <p class="sha">{{ mcpEndpoint }}</p>
      <div class="row" style="margin-top: 8px">
        <CopyButton :text="agentInstructions" label="复制连接说明" />
        <CopyButton :text="mcpEndpoint" label="仅复制地址" />
        <n-button size="small" @click="refreshNow">刷新状态</n-button>
      </div>
    </div>
    <ol class="steps connection-steps">
      <li><strong>复制连接说明</strong>，发给你正在使用的 Agent。</li>
      <li>在它打开的网页里登录，并选择本次考核、允许连接。</li>
      <li>让 Agent 完成连接测试。这里显示通过后，就可以继续。</li>
    </ol>
    <details class="rules"><summary>需要手动添加？</summary><p class="tiny">在客户端的 MCP 设置中添加上方地址，传输选 Streamable HTTP，认证选 OAuth。连接后让 Agent 调用 test_connection。</p></details>

    <div>
      <h3 class="card-title">已授权的连接</h3>
      <p v-if="connections.length" class="tiny">客户端名称由对方提供；授权后还需完成连接测试。</p>
      <p v-if="connectionsError" class="field-error" role="alert">{{ connectionsError }}</p>
      <p v-else-if="connections.length === 0" class="tiny">暂无连接</p>
      <ul v-if="connections.length" class="connection-list">
        <li v-for="item in connections" :key="item.id">
          <div>
            <strong>{{ item.clientName || '未命名客户端' }}</strong>
            <span class="tiny">
              授权于 {{ formatDateTime(item.createdAt) }}
              · {{ item.lastUsedAt ? `最近使用 ${formatDateTime(item.lastUsedAt)}` : '还没有使用记录' }}
            </span>
          </div>
          <n-popconfirm @positive-click="revoke(item.id)">
            <template #trigger>
              <n-button size="small" :loading="revoking === item.id" :disabled="revoking !== ''">撤销</n-button>
            </template>
            撤销后，这个客户端不能再使用本次授权。确定撤销？
          </n-popconfirm>
        </li>
      </ul>
      <p v-if="revokeError" class="field-error" role="alert">{{ revokeError }}</p>
    </div>

    <details class="rules" :open="advancedOpen" @toggle="onAdvancedToggle">
      <summary>高级接入（兼容旧客户端）</summary>
      <p class="tiny">旧的本地桥接需要单独签发令牌。远程 OAuth 连接不必使用这里的配置。</p>
      <ol class="setup-steps">
        <li>
          <strong>签发令牌</strong>
          <span class="tiny">签发后需重新测试，并会撤销已有连接。请保存接入配置。</span>
          <div class="row">
            <n-popconfirm v-if="token || connections.length || connected" @positive-click="issue">
              <template #trigger>
                <n-button size="small" :loading="pending" :disabled="!enabled">重新签发</n-button>
              </template>
              签发兼容令牌会撤销已有连接（包括 OAuth 连接），需要重新测试。确定继续？
            </n-popconfirm>
            <n-button v-else size="small" type="primary" :loading="pending" :disabled="!enabled" @click="issue">
              签发接入令牌
            </n-button>
          </div>
        </li>
        <li>
          <strong>安装桥接</strong>
          <span class="tiny">使用下方配置可自动安装，也可手动下载。</span>
          <div class="row">
            <a class="text-link" :href="packageUrl" :download="BRIDGE_PACKAGE">下载 {{ BRIDGE_PACKAGE }}</a>
          </div>
        </li>
        <li>
          <strong>复制旧客户端配置</strong>
          <span class="tiny">把 <span class="mono">/ABS/exam-project</span> 换成考核项目的绝对路径。对话导出放入该目录；如需读取外部会话文件，只添加你授权的本次考核目录。</span>
          <CopyButton :text="cursorConfig" label="复制 JSON 配置" />
          <p v-if="!token" class="tiny">先签发令牌，配置里才会带上本次令牌。</p>
        </li>
        <li>
          <strong>复制桥接说明</strong>
          <span class="tiny">贴给使用本地桥接的助手。它会上传当前会话原始日志的字节快照，不再逐份请求网页批准。</span>
          <CopyButton :text="bridgeInstructions" label="复制桥接说明" />
        </li>
      </ol>
      <p v-if="tokenError" class="field-error" role="alert">{{ tokenError }}</p>
      <details class="rules">
        <summary>环境变量、令牌和工具名称</summary>
        <ul>
          <li><span class="mono">ASSESSMENT_URL</span>：当前站点来源 {{ origin }}。不要带路径、查询或凭据。</li>
          <li><span class="mono">ASSESSMENT_MCP_TOKEN</span>：本次签发的令牌。网页不会保存它；复制到 MCP 配置后请妥善保管。</li>
          <li><span class="mono">ASSESSMENT_WORKSPACE</span>：考核项目的绝对目录。</li>
          <li><span class="mono">ASSESSMENT_CONTEXT_ROOTS</span>：JSON 字符串数组，仅包含你授权的本次考核目录。</li>
          <li>启动命令是 <span class="mono">npx -y {{ packageUrl }}</span>。</li>
          <li>本地工具：test_connection、exam_status、find_candidate_files、submit_files。</li>
          <li>远程工具：test_connection、exam_status、submit_materials。文件用 helper 按原始字节上传，网页不显示上传票据。</li>
          <li>连接后调用 test_connection，返回页面刷新状态。</li>
        </ul>
        <div v-if="token" class="stack" style="margin-top: 10px">
          <p class="banner warn">离开或刷新后无法再次查看此令牌。</p>
          <label class="field-label" for="mcp-token">本次令牌 · 有效至 {{ formatDateTime(expiresAt) }}</label>
          <textarea id="mcp-token" class="sha" readonly rows="3" :value="token" autocomplete="off" spellcheck="false" />
          <CopyButton :text="token" label="复制令牌" />
        </div>
      </details>
    </details>
  </div>
</template>
