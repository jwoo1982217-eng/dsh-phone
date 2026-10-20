import { CODE, UpstreamError } from './http.js'
import { decodeWindow } from './store.js'
import { windowTokens } from './stream.js'

/** A short, cancellable measurement, independent of normal chat settings. */
export async function runBenchmark({ adapter, entry, snapshot, effort, signal, timeoutMs = 60000 }) {
  const levels = Array.isArray(entry.efforts) ? entry.efforts : []
  const selected = effort || ['disabled', 'off', 'minimal', 'low'].find(id => levels.includes(id)) || levels[0] || 'light'
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('测速已取消'))
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`快速测速超过 ${Math.round(timeoutMs / 1000)} 秒，已取消上游请求；共享池可能正在排队，请稍后再试。`)), timeoutMs)
  const started = Date.now()
  let firstFrame, usage
  let sawReasoning = false, text = ''
  // A speed probe must neither continue a truncated turn nor silently restart.
  const local = { ...snapshot, settings: { ...snapshot.settings, streamRecovery: { enabled: false, totalTimeoutMs: timeoutMs, maxContinuationMs: timeoutMs } } }
  try {
    if (controller.signal.aborted) throw controller.signal.reason
    for await (const chunk of adapter.stream({
      provider: 'our-free-model', model: entry.id,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      reasoningEffort: selected, maxTokens: 1024,
      sessionId: `bench:${entry.id}:${selected}`, signal: controller.signal,
    }, entry, local)) {
      if (['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) {
        firstFrame ??= Date.now()
        if (chunk.type === 'reasoning-delta') sawReasoning = true
        if (chunk.type === 'text-delta') text += chunk.text
      }
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
      }
    }
    if (controller.signal.aborted) throw controller.signal.reason
    if (text.trim() === '') throw new UpstreamError('快速测速没有收到可见回答', CODE.empty)
    const ms = Date.now() - started
    const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)
    return { model: entry.id, effort: selected, preset: 'quick', ok: true, totalMs: ms,
      ttftMs: firstFrame === undefined ? ms : firstFrame - started,
      outputTokens: usage?.outputTokens ?? 0, reasoningTokens: usage?.reasoningTokens ?? 0,
      tokensPerSecond: measured.tps, sample: text.slice(0, 60) }
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamError(controller.signal.reason.message, signal?.aborted ? CODE.aborted : CODE.timeout)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
