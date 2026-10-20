import { normalizeGroup, normalizeState } from '../src/groups.js'
import { scoreRequest, requestFeatures, chooseMember } from '../src/strategy.js'
import { RoutingAdapter } from '../src/adapter.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// ── fixtures ────────────────────────────────────────────────────────────────
const state = { version: 1, groups: [] }
const makeGroup = (raw) => {
  const { group, error } = normalizeGroup(raw)
  if (error) throw new Error(error)
  return group
}

const orderGroup = makeGroup({
  name: 'order-test', strategy: 'order',
  members: [{ provider: 'mock-a', model: 'strong-model' }, { provider: 'mock-b', model: 'cheap-model' }]
})

const smartGroup = makeGroup({
  name: 'smart-test', strategy: 'smart',
  members: [{ provider: 'mock-a', model: 'strong-model', tier: 'strong' }, { provider: 'mock-b', model: 'cheap-model', tier: 'cheap' }],
  smart: { strongThreshold: 0.55, longContextTokens: 1000 }
})

// ── mock LLM ────────────────────────────────────────────────────────────────
function makeLlm(script) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 200000 } }
    },
    async *stream(options) {
      calls.push(`${options.provider}/${options.model}`)
      const behaviour = script[`${options.provider}/${options.model}`] ?? script.default
      if (behaviour === 'fail') { const e = new Error('rate limited'); e.status = 429; throw e }
      if (behaviour === 'emit-then-fail') {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        const e = new Error('boom'); e.status = 500; throw e
      }
      yield { type: 'text-delta', index: 0, text: 'ok:' + options.provider }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const diag = []
const mkAdapter = (llm) => new RoutingAdapter({ llm, state: () => state, record: e => diag.push(e), log: () => {} })

async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }

console.log('\n[order: failover]')
{
  const llm = makeLlm({ 'mock-a/strong-model': 'fail', 'mock-b/cheap-model': 'ok' })
  state.groups = [orderGroup]
  const adapter = mkAdapter(llm)
  const chunks = await collect(adapter.stream({ model: orderGroup.id, provider: 'model-routing', messages: [{ role: 'user', content: 'hello' }] }))
  check('first member fails, second answers', chunks.some(c => c.type === 'text-delta' && c.text === 'ok:mock-b'), JSON.stringify(chunks))
  check('both members attempted in order', llm.calls.join('>') === 'mock-a/strong-model>mock-b/cheap-model', llm.calls.join('>'))
  check('diagnostics recorded', diag.at(-1)?.outcome === 'ok' && diag.at(-1)?.attempts?.length === 2)
}

console.log('\n[order: no switch after output]')
{
  diag.length = 0
  const llm = makeLlm({ 'mock-a/strong-model': 'emit-then-fail' })
  state.groups = [orderGroup]
  const adapter = mkAdapter(llm)
  const chunks = await collect(adapter.stream({ model: orderGroup.id, provider: 'model-routing', messages: [{ role: 'user', content: 'x' }] }))
  check('error surfaces in the SDK terminal protocol', chunks.findLast(c => c.type === 'finish')?.reason?.kind === 'error' && chunks.some(c => c.type === 'text-delta' && c.text === 'partial'))
  check('no second member after output', llm.calls.length === 1, llm.calls.join('>'))
  check('diagnostic says failed-after-output', diag.at(-1)?.outcome === 'failed-after-output', diag.at(-1)?.outcome)
}

console.log('\n[smart: simple → cheap]')
{
  diag.length = 0
  const llm = makeLlm({ default: 'ok' })
  state.groups = [smartGroup]
  const adapter = mkAdapter(llm)
  const simple = '你好，今天几号？'
  const chunks = await collect(adapter.stream({ model: smartGroup.id, provider: 'model-routing', messages: [{ role: 'user', content: simple }] }))
  check('cheap member chosen', llm.calls[0] === 'mock-b/cheap-model', llm.calls[0])
  check('score below threshold', diag.at(-1)?.score < 0.55, String(diag.at(-1)?.score))
}

console.log('\n[smart: hard → strong]')
{
  diag.length = 0
  const llm = makeLlm({ default: 'ok' })
  state.groups = [smartGroup]
  const adapter = mkAdapter(llm)
  const hard = '```ts\nimport x from "y"\n```\n报错 stack trace: TypeError\n为什么这个设计会失败？请分析根因并重构。' + 'x'.repeat(6000)
  const chunks = await collect(adapter.stream({ model: smartGroup.id, provider: 'model-routing', messages: [{ role: 'user', content: hard }] }))
  check('strong member chosen', llm.calls[0] === 'mock-a/strong-model', llm.calls[0])
  check('rules explain the choice', diag.at(-1)?.rules?.length >= 2, JSON.stringify(diag.at(-1)?.rules))
  check('score above threshold', diag.at(-1)?.score >= 0.55, String(diag.at(-1)?.score))
}

console.log('\n[capability: context too small]')
{
  diag.length = 0
  const small = makeGroup({ name: 'ctx', strategy: 'order', members: [{ provider: 'mock-a', model: 'tiny' }, { provider: 'mock-b', model: 'big' }] })
  state.groups = [small]
  const llm = {
    calls: [],
    async resolveModelInfo(provider, model) { return { provider, id: model, name: model, context: { contextWindow: model === 'tiny' ? 100 : 200000 } } },
    async *stream(options) { this.calls.push(`${options.provider}/${options.model}`); yield { type: 'text-delta', index: 0, text: 'ok' } }
  }
  const adapter = mkAdapter(llm)
  await collect(adapter.stream({ model: small.id, provider: 'model-routing', messages: [{ role: 'user', content: 'y'.repeat(2000) }] }))
  check('tiny member skipped for long input', !llm.calls.includes('mock-a/tiny'), llm.calls.join('>'))
  check('skipped reason recorded', diag.at(-1)?.attempts?.[0]?.skipped?.some(s => s.reason === '上下文容量不足'), JSON.stringify(diag.at(-1)?.attempts?.[0]?.skipped))
}

console.log('\n[validation]')
{
  check('rejects empty members', normalizeGroup({ name: 'x', members: [] }).error !== undefined)
  check('rejects unknown strategy', normalizeGroup({ name: 'x', strategy: 'round-robin', members: [{ provider: 'a', model: 'b' }] }).error !== undefined)
  check('rejects duplicate members', normalizeGroup({ name: 'x', members: [{ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }] }).error !== undefined)
  const ok = normalizeGroup({ name: 'stable', members: [{ provider: 'a', model: 'b' }] })
  check('stable id format', /^grp-[0-9a-f]{8}$/.test(ok.group.id), ok.group.id)
  const doc = normalizeState({ groups: [{ name: 'keep', members: [{ provider: 'a', model: 'b' }] }, { bad: true }] })
  check('normalizeState drops invalid', doc.groups.length === 1)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
if (fail) process.exitCode = 1
