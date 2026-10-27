import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { mountHostChannels } from '../src/host-channels.js'

const logger = { info() {}, warn() {} }
const settle = () => new Promise(resolve => setImmediate(resolve))
function mount(c, loadPack) {
  const states = []
  let completion
  const fiber = c.plugin({ name: 'ofm-integration', apply(ctx) {
    completion = mountHostChannels(ctx, { loadPack, onState: state => states.push(state), outlet: {}, logger })
  } })
  return { states, fiber, done: async () => { await fiber.ctx.fiber.await(); await completion } }
}
function shared(c, { legacy = false, pool = true } = {}) {
  const accountPool = { untouched: true }
  const fiber = c.plugin({ name: 'existing-jet-hub', apply(ctx) {
    ctx.provide('codeartsAuth', {})
    if (pool) ctx.provide('accountPool', accountPool)
    ctx.provide('connection', legacy ? { fetch: {} } : { rpc: { handle() {} } })
  } })
  return { fiber, accountPool }
}

test('fixed Cordis shares existing backend and preserves its exact account pool', async () => {
  const c = new Context(), existing = shared(c)
  await existing.fiber.ctx.fiber.await()
  const run = mount(c, () => { throw Error('embedded pack must not be imported') })
  await run.done(); await settle()
  assert.equal(run.states.at(-1).state, 'ready')
  assert.equal(run.states.at(-1).mode, 'shared')
  assert.equal(c.get('accountPool'), existing.accountPool)
  await run.fiber.dispose(); await existing.fiber.dispose()
})

test('host starting during dynamic import also suppresses duplicate pack apply', async () => {
  const c = new Context()
  let resolve, applied = 0
  const run = mount(c, () => new Promise(r => { resolve = r }))
  await run.fiber.ctx.fiber.await()
  const existing = shared(c)
  await existing.fiber.ctx.fiber.await()
  resolve({ apply() { applied++ } })
  await run.done(); await settle()
  assert.equal(applied, 0)
  assert.equal(run.states.at(-1).mode, 'shared')
  await run.fiber.dispose(); await existing.fiber.dispose()
})

test('waits for account pool publication and reports loss of shared service', async () => {
  const c = new Context(), existing = shared(c, { pool: false })
  await existing.fiber.ctx.fiber.await()
  const run = mount(c, () => { throw Error('must share') })
  await run.done(); await settle()
  assert.equal(run.states.at(-1).state, 'pending')
  const published = c.plugin({ name: 'pool-ready', apply(ctx) { ctx.provide('accountPool', {}) } })
  await settle(); assert.equal(run.states.at(-1).state, 'ready')
  await published.dispose(); await settle()
  assert.equal(run.states.at(-1).state, 'pending')
  await run.fiber.dispose(); await existing.fiber.dispose()
})

test('an old host retains the original legacy Jet Hub transport', async () => {
  const c = new Context(), existing = shared(c, { legacy: true })
  await existing.fiber.ctx.fiber.await()
  const run = mount(c, () => { throw Error('must share') })
  await run.done(); await settle()
  assert.equal(run.states.at(-1).mode, 'shared-legacy')
  await run.fiber.dispose(); await existing.fiber.dispose()
})

test('standalone composition keeps the embedded channel backend and options', async () => {
  const c = new Context(), calls = []
  const run = mount(c, async () => ({ apply(ctx, options) { calls.push(options) } }))
  await run.done()
  assert.equal(calls.length, 1); assert.equal(calls[0].disableOpencode, true)
  assert.deepEqual(run.states.at(-1), { state: 'ready', mode: 'embedded', error: '' })
  await run.fiber.dispose()
})

test('dispose during import cancels mounting; failed import can recover on a new mount', async () => {
  const c = new Context()
  let resolve, calls = 0
  const cancelled = mount(c, () => new Promise(r => { resolve = r }))
  await cancelled.fiber.ctx.fiber.await()
  await cancelled.fiber.dispose()
  resolve({ apply() { calls++ } }); await cancelled.done()
  assert.equal(calls, 0); assert.equal(cancelled.states.length, 0)
  const failed = mount(c, async () => { throw Error('fixture import failure') })
  await failed.done(); assert.equal(failed.states.at(-1).state, 'failed')
  await failed.fiber.dispose()
  const recovered = mount(c, async () => ({ apply() { calls++ } }))
  await recovered.done(); assert.equal(calls, 1); assert.equal(recovered.states.at(-1).state, 'ready')
  await recovered.fiber.dispose()
})

function clientHook(call) {
  let bundle
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', source)({ __ModuleLoader__: { load(value) { bundle = value } } })
  const react = { useMemo: fn => fn(), useRef: value => ({ current: value }), useState: value => [typeof value === "function" ? value() : value, () => {}], useEffect() {}, useCallback: fn => fn }
  const hook = bundle.factory(() => react).__test.useChannelRpc
  return summary => hook({ connection: { rpc: { call } } }, summary)
}

test('actual browser hook chooses the authenticated shared, legacy or embedded RPC and preserves payload', async () => {
  const calls = [], payload = { providers: ['buddy', 'gemini'] }
  const hook = clientHook(async (...args) => { calls.push(args); return { ok: true, value: { sample: true } } })
  for (const mode of ['shared', 'shared-legacy', 'embedded', undefined]) {
    assert.deepEqual(await hook({ channels: { mode } }).rpc('provider.status', payload), { sample: true })
  }
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['/jet-hub', 'manage'], ['/api', 'jet-hub'], ['/api', 'channel-pack'], ['/api', 'channel-pack']])
  for (const call of calls) {
    assert.equal(call[2].method, 'provider.status'); assert.equal(call[2].payload, payload)
    assert.ok(call[3] instanceof AbortSignal)
  }
})

test('browser hook surfaces original RPC error, forwards cancellation and recovers', async () => {
  let fail = true
  const hook = clientHook(async () => fail ? { ok: false, error: { message: 'original backend rejected request' } } : { ok: true, value: { ready: true } })
  const rpc = hook({ channels: { mode: 'shared' } }).rpc
  await assert.rejects(rpc('provider.status', {}), /original backend rejected request/)
  fail = false; assert.deepEqual(await rpc('provider.status', {}), { ready: true })
  const cancel = clientHook(async (_channel, _endpoint, _payload, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })))
  await assert.rejects(cancel({ channels: { mode: 'shared' } }).rpc('provider.status', {}, 5), /cancelled/)
})

test('actual settings shell passes the resolved summary to channels, ledger, logs and gateway', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { Shell, LedgerPage, LogsPage, GatewayPage,')
  const data = { channels: { state: 'ready', mode: 'shared' }, catalog: [] }
  for (const tab of ['channels', 'ledger', 'logs', 'gateway']) {
    let bundle
    const window = { localStorage: { getItem: () => tab }, __ModuleLoader__: { load: value => { bundle = value } } }
    new Function('window', source)(window)
    const react = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useRef: value => ({ current: value }), useEffect() {}, useMemo: fn => fn(),
    }
    const tests = bundle.factory(() => react).__test
    const node = tests.Shell({ data, summary: { data, reload() {} }, t: key => key, counts: {} })
    const page = node.children.at(-1)
    assert.equal(page.props.summary, data, tab + ' must receive the actual server summary')
    assert.equal(page.props.summary.channels.mode, 'shared')
  }
})
