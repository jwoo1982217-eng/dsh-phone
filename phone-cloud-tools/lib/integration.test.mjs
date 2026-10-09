import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyPhoneCloudTools } from './index.mjs';

test('Android integration is default off, local-only, secret-free in status and rolls back credential commit failure', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'phone-hub-sdk-'))); t.after(() => rm(home, { recursive: true, force: true }));
  let fail = false, saved, handler, authority; const cleanup = [], routes = [];
  const ctx = {
    credentials: { resolve: async () => saved ? { value: saved } : undefined, set: async (_ref, value) => { if (fail) throw Error('disk failure'); saved = value; } },
    connection: { rpc: { handle: (_route, fn, options) => { handler = fn; authority = options.authority; } } },
    effect: fn => cleanup.push(fn()), webServer: { register: route => { routes.push(route); return () => {}; } },
  };
  const hub = await applyPhoneCloudTools(ctx, { home, android: true, bridge: { call: async () => ({ apps: [] }) }, getSkills: async () => [] });
  t.after(() => cleanup.reverse().forEach(fn => fn?.()));
  const call = async payload => handler('manage', payload);
  const initial = await call({ action: 'status' }); assert.equal(initial.value.enabled, false); assert.equal(initial.value.paired, false); assert.equal(authority, 'loopback');
  assert.equal(routes.length, 6); assert.ok(routes.some(route => route.path === '/phone-tools')); assert.ok(routes.some(route => route.path === '/hermes-remote'));
  await call({ action: 'pair', relay: 'ws://127.0.0.1:8789/relay' }); const original = saved;
  const exported = await call({ action: 'export' }); assert.match(exported.value.link, /^dsh-phone:\/\/tools/);
  const publicStatus = JSON.stringify((await call({ action: 'status' })).value); assert.equal(publicStatus.includes(JSON.parse(saved).pair.secret), false);
  fail = true; const rejected = await call({ action: 'revoke' }); assert.equal(rejected.ok, false); assert.equal(saved, original); assert.equal((await call({ action: 'status' })).value.paired, true);
  fail = false; await call({ action: 'revoke' }); assert.equal((await call({ action: 'status' })).value.paired, false); assert.equal(hub.config.enabled, false);
});

test('desktop runtime does not expose phone hub or register approval endpoints', async () => {
  assert.equal(await applyPhoneCloudTools({}, { android: false }), undefined);
});
