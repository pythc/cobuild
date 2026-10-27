export const MCP_SERVER_NAME = '110-lab-assessment'
export const BRIDGE_PACKAGE = 'context-bridge-0.2.2.tgz'
export const UPLOAD_HELPER = 'upload-materials.py'
export const MAX_UPLOAD_BYTES = 1073741824

export function uploadInstructionText(origin: string, repoSha: string): string {
  const helperUrl = `${origin}/downloads/${UPLOAD_HELPER}?v=0.2.2`
  return [
    `请使用 MCP「${MCP_SERVER_NAME}」提交本场考核材料。远程地址：${origin}/mcp。`,
    `当前仓库 SHA（必须原样使用）：${repoSha}`,
    '',
    '所需材料只是当前 Agent 客户端、当前这段对话的原始日志文件。用当前会话 id、日志路径或会话索引元数据确认它属于当前对话。仅工作区相同不能证明属于当前对话。同一段对话的原始日志分段可以一并包含。不要改用其他会话、其他客户端、重建的转录、摘要或转换后的导出。',
    'exam_status 确认已有直接上传同意、考核进行中且仓库 SHA 已确认后，在现有文件权限内直接进行。不要再提问，不要再请求一次上传批准，不要让我重新选择文件，也不要重复已经知道的客户端、模型或项目信息。简短说明正在上传当前会话的原始日志；这是告知，不是确认关卡。不要隐瞒上传。',
    '缺少同意、权限、仓库确认，或无法识别、无法取得原始日志，都是阻碍：如实报告。不要绕过，不要改传另一段对话，也不要声称已完成。',
    '',
    '按顺序执行。不要把原始日志正文读进模型上下文，也不要改写、脱敏、删减、重排格式、重新编码或重建：',
    '1. 调用 exam_status，确认同意、进行中的考核和已确认的仓库 SHA。连接、初始化和 test_connection 不要求上传，也不开始计时。',
    `2. 调用 submit_materials。参数只含 repoSha（${repoSha}）、clients、projectSummary、collaborationSummary。`,
    '   clients 为 [{name, version?, models:[{name, source, parameters?}]}]，source 只能是 reported、detected 或 unknown。',
    '   已知的客户端或模型照实填写；没有的值用 unknown，不要猜测。项目与协作总结只根据已经可见的上下文简要写。',
    '   不要在参数里放文件正文或文件哈希。',
    `3. 返回短时上传票据和官方 helper 地址，含 uploadUrl、uploadToken、helperUrl、expiresAt，状态应为 AWAITING_FILES。合计上限 ${MAX_UPLOAD_BYTES} 字节（1 GiB），最多 20 个文件，分块 4194304 字节（4 MiB），支持断点续传。网页不显示 uploadToken。`,
    '4. 下载 helper，对当前客户端当前会话的原始日志路径运行。它会在开始捕获时对每个文件做逐字节快照，不改动原文件，并上传该快照。快照开始之后追加的日志不在其中；捕获的字节不会被过滤或截断。',
    `   helper：${helperUrl}（若返回的 helperUrl 不同，以返回值为准）。`,
    '   python3 upload-materials.py --url UPLOAD_URL --token UPLOAD_TOKEN --snapshot --file RAW_LOG_PATH',
    '   只有同一当前对话的原始日志分段才再重复 --file。',
    '   或把返回的票据写入仅本人可读的 JSON，改用 python3 upload-materials.py --ticket-file TICKET.json --snapshot --file RAW_LOG_PATH',
    '   当前会话的原始日志不要使用 --payload-json。',
    '   中断后按服务器已接收偏移继续。上传请求不要跟随重定向。',
    '5. 核对返回的回执后再报告成功，并调用 exam_status，确认材料回执与仓库 SHA 一致。',
    '',
    '收到材料不等于交卷完成。必须由我在网页上点击「确认交卷」后，这场考核才结束。你不能宣称已交卷。',
    '复制、哈希和传输由代码按字节完成。不要另行收集无关对话、其他项目、凭据库或隐藏的说明文件。总结不能代替原始日志。',
  ].join('\n')
}
