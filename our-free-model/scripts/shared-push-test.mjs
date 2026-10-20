import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

let bundle
new Function('window', fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))({ __ModuleLoader__: { load: value => { bundle = value } } })
const sharedPushSource = bundle.factory(() => ({})).__test.sharedPushSource
const tick = () => new Promise(resolve => setTimeout(resolve, 15))
async function until(fn) {
  for (let i = 0; i < 60; i++) { if (fn()) return; await tick() }
  assert.ok(fn(), 'asynchronous operation did not settle')
}
function sources() {
  const all = []
  class Source {
    listeners = new Map()
    closed = false
    constructor(url) { this.url = url; all.push(this) }
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }) }
    close() { this.closed = true }
  }
  return { all, Source, active: () => all.filter(x => !x.closed) }
}
const sharedApis = typeof globalThis.navigator?.locks?.request === 'function' && typeof BroadcastChannel === 'function'
const options = Source => ({ EventSource: Source, locks: navigator.locks, BroadcastChannel, document: new EventTarget() })

test('real Web Locks and BroadcastChannel share one SSE across three tabs and relay all event kinds', { skip: !sharedApis }, async () => {
  const s = sources(), received = [[], [], []]
  const handles = received.map((list) => {
    const h = sharedPushSource('/api/our-free-model/events', options(s.Source))
    for (const kind of ['hello', 'announcements', 'update', 'upgraded']) h.addEventListener(kind, e => list.push([kind, JSON.parse(e.data)]))
    return h
  })
  try {
    await until(() => s.all.length === 1)
    for (const kind of ['hello', 'announcements', 'update', 'upgraded']) s.all[0].emit(kind, { sample: kind })
    await until(() => received.every(x => x.length === 4))
    for (const r of received) assert.deepEqual(r.map(x => x[0]), ['hello', 'announcements', 'update', 'upgraded'])
    assert.equal(s.active().length, 1)
    assert.equal((await navigator.locks.query()).pending.length, 2)
  } finally { handles.forEach(h => h.close()) }
  await until(() => s.active().length === 0)
})

test('late tab gets hello; leader disposal hands over without duplicate upstream connections', { skip: !sharedApis }, async () => {
  const s = sources(), opts = options(s.Source), seen = []
  const first = sharedPushSource('/events', opts)
  await until(() => s.all.length === 1)
  s.all[0].emit('hello', { generation: 10 })
  const next = sharedPushSource('/events', opts)
  next.addEventListener('hello', e => seen.push(JSON.parse(e.data)))
  try {
    await until(() => seen.length === 1)
    assert.equal(seen[0].generation, 10)
    first.close(); first.close()
    await until(() => s.all.length === 2)
    assert.equal(s.active().length, 1)
    s.all[1].emit('hello', { generation: 11 })
    await until(() => seen.length === 2)
    assert.equal(seen[1].generation, 11)
  } finally { first.close(); next.close() }
})

test('queued tab cancellation and error disposal release leases; a later tab can recover', { skip: !sharedApis }, async () => {
  const s = sources(), opts = options(s.Source)
  const first = sharedPushSource('/events', opts)
  await until(() => s.all.length === 1)
  const cancelled = sharedPushSource('/events', opts)
  cancelled.close()
  const recovery = sharedPushSource('/events', opts)
  first.onerror = () => first.close()
  try {
    s.all[0].onerror()
    await until(() => s.all.length === 2)
    assert.equal(s.active().length, 1)
    let received = false
    recovery.addEventListener('update', () => { received = true })
    s.all[1].emit('update', { latest: 'sample' })
    assert.equal(received, true)
    assert.equal(s.all.length, 2, 'cancelled queued tab must not construct an EventSource')
  } finally { first.close(); cancelled.close(); recovery.close() }
  await until(() => s.active().length === 0)
  await tick()
  const state = await navigator.locks.query()
  assert.equal(state.held.length, 0); assert.equal(state.pending.length, 0)
})

test('without shared browser APIs hidden tabs release optional SSE and restore on visibility', () => {
  const s = sources(), doc = new EventTarget()
  doc.visibilityState = 'hidden'
  const h = sharedPushSource('/events', { EventSource: s.Source, locks: {}, document: doc })
  assert.equal(s.all.length, 0)
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(s.active().length, 1)
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(s.active().length, 0)
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(s.all.length, 2)
  h.close()
  doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(s.active().length, 0); assert.equal(s.all.length, 2)
})
