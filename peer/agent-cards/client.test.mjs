import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
for (const [id, path] of [['dsh-peer', './client.js'], ['dsh-phone-qq', '../../phone-qq/cards-client.js']]) {
  test(id + ' browser entry registers the actual package ID and a settings section', () => {
    let loaded, entry, component; const entries = [];
    const window = { innerHeight: 800, __ModuleLoader__: { load(value) { loaded = value; } } };
    vm.runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), { window, Symbol, document: { createElement: () => ({}), head: { append() {} } } });
    assert.equal(loaded.id, id);
    const plugin = loaded.factory();
    plugin.apply({ on: () => () => {}, slots: { entriesOfSlot: () => [], inject(slot, fn) { assert.equal(slot, 'settings.section'); fn(); }, register(options, render) { entries.push([options, render]); return () => {}; } } });
    [entry, component] = entries[0];
    assert.equal(entry.id, 'agent-persona-cards'); assert.equal(entry.label, 'Agent 人设');
    const iframe = component(); assert.equal(iframe.$$typeof, Symbol.for('react.element')); assert.equal(iframe.props.src, '/agent-cards'); assert.equal(iframe.props.title, 'Agent 人设');
    assert.equal(entries[1][0].label, '插件市场'); assert.equal(entries[1][1]().props.src, '/controlled-market');
    for (const [, render] of entries) {
      const frame = render();
      assert.equal(typeof frame.ref, 'function');
      assert.match(frame.props.style.height, /^\d+px$/, 'every iframe has a working fallback without CSS viewport functions');
    }
  });
}
