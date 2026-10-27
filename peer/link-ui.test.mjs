import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { connectionLink, newPair, parsePair } from './protocol.mjs';

const html = await readFile(new URL('./page.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function page({ role = 'phone', hash = '', managed = false } = {}) {
  const pair = newPair('wss://fixture.invalid/relay'), link = connectionLink(pair);
  const elements = new Map(), calls = [];
  const element = () => ({ value: '', children: [], hidden: false, disabled: false, textContent: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } });
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const state = { role, paired: false, connected: false, name: 'fixture', allowGateway: true, autoSync: false, remoteUrl: 'http://127.0.0.1:3081/' };
  const context = { URLSearchParams, navigator: { userAgent: 'Android', clipboard: { writeText: async value => { context.copied = value; } } },
    document: { getElementById: byId, querySelectorAll: () => [], createElement: element, hidden: false },
    location: { hash: hash === 'link' ? '#link=' + encodeURIComponent(link) : hash, pathname: '/phone-peer', href: '' },
    history: { replaceState() { context.location.hash = ''; } },
    setInterval(fn) { context.poll = fn; },
    fetch: async (_, init) => {
      const { payload } = JSON.parse(init.body); calls.push(payload);
      let value = state;
      if (payload.action === 'pair') { assert.deepEqual(parsePair(payload.code), pair); state.paired = true; }
      if (['create','code','prepare'].includes(payload.action)) value = { link, ...(managed ? { shareLink: 'https://fixture.invalid/connect#' + link.split('#')[1] } : {}), code: 'legacy-fixture' };
      return { ok: true, json: async () => ({ result: { ok: true, value: { ...value } } }) };
    },
  };
  vm.runInNewContext(script, context); await tick();
  return { context, byId, calls, state, link };
}

test('connection link waits for authenticated online state then enters Android computer view exactly once', async () => {
  const p = await page(); p.byId('code-input').value = p.link;
  await p.byId('pair').onclick();
  assert.equal(p.context.location.href, '');
  assert.equal(p.calls.filter(x => x.action === 'pair').length, 1);
  p.state.connected = true; p.context.poll(); await tick();
  assert.equal(p.context.location.href, 'dsh-phone://peer/remote');
  p.context.location.href = ''; p.context.poll(); await tick();
  assert.equal(p.context.location.href, '', 'Status polling must not repeat navigation');
});

test('desktop copy returns connection link; fragment prefill clears link history without silently pairing', async () => {
  const desktop = await page({ role: 'computer' });
  await desktop.byId('reveal').onclick(); await desktop.byId('copy').onclick();
  assert.equal(desktop.context.copied, desktop.link);
  const phone = await page({ hash: 'link' });
  assert.equal(phone.byId('code-input').value, phone.link);
  assert.equal(phone.context.location.hash, '');
  assert.equal(phone.calls.filter(x => x.action === 'pair').length, 0);
});


test('primary desktop prepare needs no relay field and copies the HTTPS saved share link', async () => {
  const p = await page({ role: 'computer', managed: true });
  await p.byId('prepare').onclick();
  assert.equal(p.context.copied, 'https://fixture.invalid/connect#' + p.link.split('#')[1]);
  await p.byId('copy').onclick();
  assert.equal(p.calls.filter(call => call.action === 'prepare').length, 1);
  assert.equal(Object.hasOwn(p.calls.find(call => call.action === 'prepare'), 'relay'), false);
  assert.equal(p.context.copied, 'https://fixture.invalid/connect#' + p.link.split('#')[1]);
  assert.equal(html.includes('adminKey'), false);
});

test('phone reconnect uses the saved pairing action without resubmitting pair or sync operations', async () => {
  const p = await page(); p.state.paired = true;
  await p.byId('reconnect').onclick();
  assert.equal(p.calls.filter(call => call.action === 'reconnect').length, 1);
  assert.equal(p.calls.filter(call => ['pair', 'sync.commit', 'create'].includes(call.action)).length, 0);
});
