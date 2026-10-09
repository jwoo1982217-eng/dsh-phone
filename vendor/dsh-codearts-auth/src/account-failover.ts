/** 只处理明确的账号额度/限流；内容拒绝、模型饱和、取消与网络错误不换号。 */
export function accountQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; message?: unknown; cause?: unknown }
  const code = String(e.code ?? '').toUpperCase()
  const message = typeof e.message === 'string' ? e.message : ''
  if (/\b(?:3009|14003)\b/.test(message + ' ' + code)) return false
  if (['AUTH', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'CONTENT_FILTER', 'HTTP_401', 'HTTP_403'].includes(code)) return false
  return ['QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'INSUFFICIENT_BALANCE', 'CREDITS_EXHAUSTED', 'RATE_LIMITED', 'RATE_LIMIT'].includes(code)
    || /额度(?:已)?(?:用尽|耗尽|不足)|余额不足|积分不足|insufficient[_ ](?:quota|balance|credits)|quota[_ ](?:exceeded|exhausted)/i.test(message)
}

export function streamError(chunk: unknown): unknown {
  const c = chunk as any
  return c?.type === 'finish' && c.reason?.kind === 'error' ? (c.reason.error ?? c.reason) : undefined
}
export function hasStreamOutput(chunk: unknown): boolean {
  const c = chunk as any
  if (c?.type === 'block-start' && c.blockType === 'tool-call') return true
  if (c?.type === 'block-end' && (c.block?.type === 'tool-call' || (['text', 'reasoning'].includes(c.block?.type) && c.block.text))) return true
  return ['text-delta', 'reasoning-delta', 'tool-call', 'tool-call-start', 'tool-call-delta', 'tool-input-delta', 'tool-input-start'].includes(c?.type)
}
