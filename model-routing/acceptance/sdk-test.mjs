/**
 * Real-SDK integration test: boots the kernel's own LlmRuntime, registers the
 * routing adapter plus two mock member providers, and drives the whole chain.
 * No network, no DSH process, no model cost.
 */
import {fileURLToPath,pathToFileURL} from 'node:url'
const modules = process.env.DSH_SDK_MODULES || fileURLToPath(new URL('../../desktop-runtime/node_modules',import.meta.url))
const {Context} = await import(pathToFileURL(modules + '/@deepseek-ai/cordis/lib/index.js'))
const {default:LlmRuntime} = await import(pathToFileURL(modules + '/@deepseek-ai/dsh-llm/lib/index.js'))
import { RoutingAdapter, ROUTING_PROVIDER } from '../src/adapter.js'
import { normalizeGroup } from '../src/groups.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

const behavior = new Map()
function memberAdapter(provider) {
  return {
    providerInfo: p => ({ id: p, name: p }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (p, m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    async listModels(p) { return [{ provider: p, id: `${p}-1`, name: p }] },
    async resolveModel(p, model) { return { provider: p, id: model, name: model, context: { contextWindow: 200000 } } },
    async prepareCall(p, model) { return { model: await this.resolveModel(p, model), stream: options => this.stream(options) } },
    async *stream(options) {
      const mode = behavior.get(options.provider) ?? 'ok'
      if (mode === 'rate-limit') {
        // Real adapters carry a structured failure snapshot; the kernel only
        // preserves a code when error.code matches error.failure.code.
        const error = new Error('mock 429')
        error.code = 'RATE_LIMIT'
        error.status = 429
        error.failure = { message: 'mock 429', code: 'RATE_LIMIT', status: 429 }
        throw error
      }
      if (mode === 'emit-then-fail') {
        yield { type: 'text-delta', index: 0, text: 'partial-output' }
        const error = new Error('mock boom after output'); error.code = 'SERVER'; error.status = 500
        throw error
      }
      if (mode === 'slow') {
        for (let tick = 0; tick < 20; tick += 1) {
          if (options.signal?.aborted) {
            const error = new Error('aborted by caller')
            error.code = 'ABORTED'
            throw error
          }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        yield { type: 'text-delta', index: 0, text: 'late' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: `[${options.provider}]` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const ctx = new Context()
const llm = new LlmRuntime(ctx)
llm.registerAdapter(['mock-a'], memberAdapter('mock-a'))
llm.registerAdapter(['mock-b'], memberAdapter('mock-b'))

const diagnostics = []
const state = { version: 1, groups: [] }
const routing = new RoutingAdapter({ llm, state: () => state, record: entry => diagnostics.push(entry), log: () => {} })
llm.registerAdapter([ROUTING_PROVIDER], routing)
check('routing adapter registers against the real LlmRuntime', true)

async function run(options) {
  const chunks = []
  for await (const chunk of llm.stream({ ...options })) chunks.push(chunk)
  return chunks
}
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const lastFinish = chunks => chunks.filter(c => c.type === 'finish').at(-1)?.reason

const { group: orderGroup } = normalizeGroup({
  name: 'sdk-order', strategy: 'order',
  members: [{ provider: 'mock-a', model: 'mock-a-1' }, { provider: 'mock-b', model: 'mock-b-1' }]
})
const { group: smartGroup } = normalizeGroup({
  name: 'sdk-smart', strategy: 'smart',
  members: [{ provider: 'mock-a', model: 'mock-a-1', tier: 'strong' }, { provider: 'mock-b', model: 'mock-b-1', tier: 'cheap' }],
  smart: { strongThreshold: 0.55, longContextTokens: 1000 }
})
state.groups = [orderGroup, smartGroup]

console.log('\n[1] registration + plain stream')
{
  behavior.clear()
  diagnostics.length = 0
  const chunks = await run({ provider: ROUTING_PROVIDER, model: orderGroup.id, messages: [{ role: 'user', content: 'hi' }] })
  check('served by first member', textOf(chunks) === '[mock-a]', textOf(chunks))
  check('terminal finish is stop', lastFinish(chunks)?.kind === 'stop', JSON.stringify(lastFinish(chunks)))
  check('diagnostic outcome ok', diagnostics.at(-1)?.outcome === 'ok', diagnostics.at(-1)?.outcome)
}

console.log('\n[2] 429 failure arrives as a finish event and switches')
{
  behavior.clear(); behavior.set('mock-a', 'rate-limit')
  diagnostics.length = 0
  const probe = await run({ provider: 'mock-a', model: 'mock-a-1', messages: [{ role: 'user', content: 'x' }] })
  const probeFinish = lastFinish(probe)
  check('kernel turns a thrown 429 into finish(error), not an exception', probeFinish?.kind === 'error', JSON.stringify(probeFinish))
  const chunks = await run({ provider: ROUTING_PROVIDER, model: orderGroup.id, messages: [{ role: 'user', content: 'hi' }] })
  check('switched to second member', textOf(chunks) === '[mock-b]', textOf(chunks))
  check('call ends ok after switch', lastFinish(chunks)?.kind === 'stop', JSON.stringify(lastFinish(chunks)))
  const attempts = diagnostics.at(-1)?.attempts ?? []
  check('first attempt recorded as failed, not ok', attempts[0]?.result?.startsWith('failed:rateLimit'), JSON.stringify(attempts.map(a => a.result)))
  check('second attempt recorded ok', attempts[1]?.result === 'ok', JSON.stringify(attempts.map(a => a.result)))
}

console.log('\n[3] smart split: simple → cheap, hard → strong')
routing.cooldown.clear()
{
  behavior.clear(); diagnostics.length = 0
  await run({ provider: ROUTING_PROVIDER, model: smartGroup.id, messages: [{ role: 'user', content: '今天几号？' }] })
  check('simple request served by cheap member', textOf(await run({ provider: ROUTING_PROVIDER, model: smartGroup.id, messages: [{ role: 'user', content: '你好' }] })) === '[mock-b]')
  const hard = '```ts\nimport x from "y"\n```\nstack trace TypeError\n为什么设计失败，请分析根因并重构。' + 'x'.repeat(6000)
  check('hard request served by strong member', textOf(await run({ provider: ROUTING_PROVIDER, model: smartGroup.id, messages: [{ role: 'user', content: hard }] })) === '[mock-a]')
  check('diagnostic carries score + rules', diagnostics.some(e => e.strategy === 'smart' && e.rules.length > 0), JSON.stringify(diagnostics.map(e => e.rules)))
}

console.log('\n[4] failure after output is not replayed')
routing.cooldown.clear()
{
  behavior.clear(); behavior.set('mock-a', 'emit-then-fail')
  diagnostics.length = 0
  const chunks = await run({ provider: ROUTING_PROVIDER, model: orderGroup.id, messages: [{ role: 'user', content: 'hi' }] })
  const finish = lastFinish(chunks)
  check('partial output is kept', textOf(chunks) === 'partial-output', textOf(chunks))
  check('stream ends with finish(error)', finish?.kind === 'error', JSON.stringify(finish))
  check('no second member attempted', !chunks.some(c => c.type === 'text-delta' && c.text === '[mock-b]'))
  check('diagnostic outcome failed-after-output', diagnostics.at(-1)?.outcome === 'failed-after-output', diagnostics.at(-1)?.outcome)
}

console.log('\n[5] cancel propagates without switching')
routing.cooldown.clear()
{
  behavior.clear(); behavior.set('mock-a', 'slow')
  diagnostics.length = 0
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  const chunks = await run({ provider: ROUTING_PROVIDER, model: orderGroup.id, messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
  const finish = lastFinish(chunks)
  check('aborted finish', finish?.kind === 'aborted', JSON.stringify(finish))
  check('no failover on cancel', !chunks.some(c => c.type === 'text-delta' && c.text === '[mock-b]'))
  check('diagnostic outcome aborted', diagnostics.at(-1)?.outcome === 'aborted', diagnostics.at(-1)?.outcome)
}

console.log('\n[6] missing contract method reproduces the original failure')
{
  const broken = {
    providerInfo: p => ({ id: p, name: p }),
    async listModels() { return [] },
    async resolveModel(p, m) { return { provider: p, id: m, name: m } },
    async prepareCall(p, m) { return { model: await this.resolveModel(p, m), stream: () => (async function* () {})() } },
    async *stream() {}
  }
  let message = ''
  try { llm.registerAdapter(['broken-probe'], broken) } catch (error) { message = String(error?.message ?? error) }
  check('plain object without providerRetryPolicy is rejected', message.includes('providerRetryPolicy'), message)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
if (fail) process.exitCode = 1
