/** Safe, channel-specific explanations. Never expose raw provider bodies. */
export function safeNotificationError(message: string): string {
  if (!message) return '';
  if (/快照|snapshot/iu.test(message))
    return '通知发送时未能读取合并请求快照；这不代表需求已删除。';
  if (/权限|403|Forbidden|授权|身份/iu.test(message))
    return '飞书通知权限或收件人身份校验未通过。';
  if (/429|限流/u.test(message)) return '飞书通知限流，请稍后重试。';
  if (/unknown|ambiguous|超时|timeout|receipt_missing/iu.test(message))
    return '投递结果待核实，请勿重复发送。';
  if (/未找到|不存在|230001|230002/u.test(message))
    return '通知目标或关联记录不可访问，请核对收件人和合并请求。';
  const code = /^(?:feishu_)?\d{5,8}$/u.test(message)
    ? `（错误码 ${message}）`
    : '';
  return `通知投递失败${code}，请由管理员检查投递记录。`;
}
