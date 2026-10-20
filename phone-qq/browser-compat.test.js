import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./browser-compat.js', import.meta.url), 'utf8');
function legacy() {
  class LegacySignal {}
  const context = { AbortSignal: LegacySignal, AbortController, DOMException, setTimeout };
  vm.runInNewContext(source, context);
  return context.AbortSignal;
}
test('older WebViews combine cancellation and clean all subscriptions while preserving the original abort reason', () => {
  const Signal = legacy(), a = new AbortController(), b = new AbortController();
  let adds = 0, removes = 0;
  for (const signal of [a.signal, b.signal]) {
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { adds++; return add(...args); };
    signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  }
  const combined = Signal.any([a.signal, b.signal]), reason = { code: 'cancelled-by-user' };
  assert.equal(combined.aborted, false); b.abort(reason);
  assert.equal(combined.aborted, true); assert.equal(combined.reason, reason);
  assert.equal(adds, 2); assert.equal(removes, 2); a.abort('later'); assert.equal(combined.reason, reason);
  assert.throws(() => Signal.any([a.signal, null])); assert.equal(Signal.any([]).aborted, false);
});
test('already cancelled inputs abort immediately in input order, and native implementations are preserved', () => {
  const Signal = legacy(), a = new AbortController(), b = new AbortController();
  a.abort('first'); b.abort('second'); assert.equal(Signal.any([a.signal, b.signal]).reason, 'first');
  const original = AbortSignal.any; vm.runInNewContext(source, { AbortSignal, AbortController, DOMException, setTimeout });
  assert.equal(AbortSignal.any, original);
});
test('the timeout fallback cancels with TimeoutError instead of failing to construct a request', async () => {
  const Signal = legacy(), signal = Signal.timeout(5);
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.reason.name, 'TimeoutError'); assert.throws(() => Signal.timeout(-1)); assert.throws(() => Signal.timeout('5'));
});
