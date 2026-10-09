import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function page() {
  const values = new Map(), events = new Map();
  const style = { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) };
  const media = { matches: true, addEventListener() {} };
  const viewport = { height: 800, scale: 1, addEventListener: (name, fn) => events.set(name, fn) };
  const window = { innerHeight: 800, visualViewport: viewport, matchMedia: () => media, addEventListener() {} };
  const document = { documentElement: { style }, body: { classList: { toggle() {} } }, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: (name, fn) => events.set(name, fn) };
  vm.runInNewContext(readFileSync(new URL('./presentation.js', import.meta.url), 'utf8'), {
    window, document, MutationObserver: class { observe() {} }, requestAnimationFrame: fn => fn(),
  });
  return { window, viewport, media, values, update: () => events.get('resize')() };
}

test('visual-viewport-only keyboard opening and closing updates the available chat height', () => {
  const p = page();
  p.viewport.height = 365; p.update();
  assert.equal(p.values.get('--dsh-phone-viewport-height'), '365px');
  p.viewport.height = 800; p.update();
  assert.equal(p.values.get('--dsh-phone-viewport-height'), '800px');
});
test('native WebView resizing does not apply keyboard height twice', () => {
  const p = page();
  p.window.innerHeight = 350; p.viewport.height = 350; p.update();
  assert.equal(p.values.get('--dsh-phone-viewport-height'), '350px');
});
test('pinch zoom and desktop layout do not collapse the chat frame', () => {
  const p = page();
  p.viewport.scale = 2; p.viewport.height = 400; p.update();
  assert.equal(p.values.get('--dsh-phone-viewport-height'), '800px');
  p.media.matches = false; p.update();
  assert.equal(p.values.has('--dsh-phone-viewport-height'), false);
});
