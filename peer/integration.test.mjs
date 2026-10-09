import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SettingsForms } from '@deepseek-ai/dsh-settings';
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from './relay.mjs';
import { ConfigSync } from './config-sync.mjs';
import { apply } from './index.mjs';
import { createOpenAiGateway } from '../vendor/dsh-codearts-auth/lib/openai-gateway/server.js';
import { installDesktopPeer } from '../scripts/install-desktop-peer.mjs';
import { startHomeRelay } from '../scripts/start-home-relay.mjs';

const listen = s => new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', () => r(s.address().port)); });
const freePort = async () => { const s = createServer(), port = await listen(s); await new Promise(r => s.close(r)); return port; };
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'dsh-peer-integration-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const credentials = () => { const map = new Map(); return { map, resolve: async ref => map.has(ref) ? { value: map.get(ref) } : undefined, set: async (ref, value) => map.set(ref, value), unset: async ref => map.delete(ref) }; };
test('configuration sync uses current DSH volatile forms and protects revisions', async t => {
  const schemas = {
    'llm-deepseek': Schema.object({ baseURL: Schema.string(), apiKeyEnv: Schema.string(), maxTokens: Schema.number(), models: Schema.array(Schema.object({id: Schema.string().required()})) }).volatile(),
    'llm-pi-ai': Schema.object({ providers: Schema.dict(Schema.object({ baseURL: Schema.string().required(), apiKeyEnv: Schema.string(), models: Schema.array(Schema.object({id: Schema.string().required()})) })) }).volatile(),
  };
  const ctx = new Context();
  const directory = await temp(t);
  const rows = Object.entries(schemas).map(([id, Config]) => {
    const entry = { id, options: {id, config: {}}, fiber: {uid: id, state: 2, runtime: {Config}, config: {}, ctx} };
    return {entry, inherited: {}, override: {}};
  });
  ctx.provide('profileContext'); ctx.set('profileContext', {home: directory, name: 'fixture'});
  ctx.provide('configEditor'); ctx.set('configEditor', {
    entries: () => rows.map(r=>r.entry), configuration: () => rows,
    edit: async (entry, fn) => {
      const row = rows.find(r=>r.entry===entry); const next = fn(row.override, row.inherited);
      schemas[entry.id](next); row.override = next; entry.options.config = next; entry.fiber.config = next;
    },
  });
  ctx.provide('loader'); ctx.set('loader', {await: async () => {}});
  await ctx.plugin(SettingsForms); t.after(() => ctx.fiber.dispose());
  const store = credentials(), sync = new ConfigSync(ctx.settings, store);
  const snapshot = { version: 1, routes: [{ ns: 'llm-deepseek', id: 'deepseek', config: { baseURL: 'https://api.example.invalid', models: [{ id: 'fixture-model' }] }, secret: 'fixture-secret' }, { ns: 'llm-pi-ai', id: 'fixture', config: { baseURL: 'https://api.example.invalid/v1', models: [{ id: 'fixture-model' }] }, secret: 'fixture-second' }] };
  assert.equal((await sync.commit(sync.preview(snapshot).token, 'replace')).imported.length, 2);
  const describe = ns => ctx.settings.describe().find(d=>d.ns===ns).value;
  assert.equal(describe('llm-deepseek').models[0].id, 'fixture-model');
  const ref = describe('llm-pi-ai').providers.fixture.apiKeyEnv; assert.equal(store.map.get(ref), 'fixture-second');
  const preview = sync.preview(snapshot); await ctx.settings.update('llm-deepseek', { maxTokens: 100 });
  await assert.rejects(sync.commit(preview.token), /配置已变化/);
});

function pluginContext(t, llm) {
  const store = credentials(), disposers = [], hooks = new Map(); let rpc;
  const ctx = { llm, credentials: store, settings: { describe: () => [] }, systemPrompt: { variable() {}, context() {} },
    connection: { rpc: { handle(path, handler, guard) { assert.equal(guard.authority, 'loopback'); rpc = handler; } } },
    webServer: { register() { return () => {}; } }, get() { return undefined; },
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); },
    on(name, fn) { hooks.set(name, fn); },
  };
  t.after(async () => { await hooks.get('dispose')?.(); for (const fn of disposers.reverse()) await fn(); });
  return { ctx, store, async manage(action, extra = {}) { const result = await rpc('manage', { action, ...extra }); assert.equal(result.ok, true, result.error?.message); return result.value; } };
}

test('actual phone gateway → encrypted relay → registered desktop DSH adapter handles models, text, tools and limits', async t => {
  const phoneCtx = new Context(), desktopCtx = new Context(); await phoneCtx.plugin(LlmRuntime); await desktopCtx.plugin(LlmRuntime);
  t.after(async () => { await phoneCtx.fiber.dispose(); await desktopCtx.fiber.dispose(); });
  let toolMode = false, failure, lateFailure = false, received;
  class FixtureAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'fixture' }; }
    async listModels(provider) { return [{ provider, id: 'fixture-model', name: 'GPT-5.6-Sol · ChatGPT 会员', contextWindow: 4096, maxTokens: 128, inputModalities: ['text'] }]; }
    async resolveModel(provider, id) { return { ...((await this.listModels(provider))[0]), id, context: { contextWindow: 4096 }, defaultMaxTokens: 128 }; }
    async *stream(options) { received = options;
      if (failure && !lateFailure) { yield { type: 'finish', reason: { kind: 'error', failure } }; return; }
      if (toolMode) { yield { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'inspect', argumentsDelta: '{"path":"fixture"}' }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; }
      else { yield { type: 'reasoning-delta', text: '手机模型推理' }; yield { type: 'text-delta', text: '手机网关完成' };
        yield { type: 'usage', usage: { inputTokens: 120, cacheReadTokens: 900, outputTokens: 8, reasoningTokens: 4 } };
        yield { type: 'finish', reason: failure ? { kind: 'error', failure } : { kind: 'stop' } }; }
    }
  }
  const unregister = phoneCtx.llm.registerAdapter(['fixture'], new FixtureAdapter()); t.after(unregister);
  const unregisterLocal = desktopCtx.llm.registerAdapter(['local-fixture'], new FixtureAdapter()); t.after(unregisterLocal);
  const home = await temp(t), gatewayPort = await freePort();
  const gateway = createOpenAiGateway({ llm: phoneCtx.llm, home, env: { DSH_OPENAI_GATEWAY_PORT: String(gatewayPort), DSH_OPENAI_GATEWAY_API_KEY: 'fixture-gateway-key' }, logger: { info() {}, warn() {}, error() {} } });
  await gateway.start(); t.after(() => gateway.close());
  const previousKey = process.env.DSH_OPENAI_GATEWAY_API_KEY; process.env.DSH_OPENAI_GATEWAY_API_KEY = 'fixture-gateway-key';
  t.after(() => previousKey === undefined ? delete process.env.DSH_OPENAI_GATEWAY_API_KEY : process.env.DSH_OPENAI_GATEWAY_API_KEY = previousKey);
  const relay = createRelay(), relayPort = await listen(relay.server); t.after(() => relay.close());
  const phone = pluginContext(t, phoneCtx.llm), desktop = pluginContext(t, desktopCtx.llm);
  phone.store.map.set('DSH_PEER_PAIR_V1', '{broken old state');
  await apply(phone.ctx, { role: 'phone', proxyPort: await freePort(), gatewayPort });
  await apply(desktop.ctx, { role: 'computer', sharedGatewayPort: await freePort() });
  assert.equal((await phone.manage('status')).error, '设备配置无法读取，请重新配对');
  const { code } = await desktop.manage('create', { relay: `ws://127.0.0.1:${relayPort}/relay` }); await phone.manage('pair', { code });
  const deadline = Date.now() + 5000;
  while (!(await phone.manage('status')).connected) { if (Date.now() > deadline) throw Error('Pairing timeout'); await new Promise(r => setTimeout(r, 10)); }
  assert.ok(!JSON.stringify(await phone.manage('status')).includes('secret'));
  const models = await desktopCtx.llm.listModels('phone-gateway'); assert.equal(models[0].id, 'fixture/fixture-model');
  const localModels = await desktopCtx.llm.listModels('local-fixture');
  assert.equal(localModels[0].name, 'GPT-5.6-Sol · ChatGPT 会员');
  assert.equal(models[0].name, '手机网关 · GPT-5.6-Sol · ChatGPT 会员');
  const info = await desktopCtx.llm.resolveModelInfo('phone-gateway', models[0].id); assert.equal(info.defaultMaxTokens, 128); assert.equal(info.reasoning, undefined);
  assert.equal(info.name, models[0].name);
  const options = { provider: 'phone-gateway', model: models[0].id, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: '请检查电脑代码' }] }] };
  const text = []; for await (const chunk of desktopCtx.llm.stream(options)) text.push(chunk);
  assert.equal(text.find(c => c.type === 'text-delta').text, '手机网关完成'); assert.equal(received.provider, 'fixture'); assert.equal(received.model, 'fixture-model');
  assert.equal(text.find(c => c.type === 'reasoning-delta').text, '手机模型推理');
  assert.deepEqual(text.find(c => c.type === 'usage').usage, { inputTokens: 120, cacheReadTokens: 900, outputTokens: 8, reasoningTokens: 4 });
  toolMode = true; const tools = []; for await (const chunk of desktopCtx.llm.stream({ ...options, tools: [{ name: 'inspect', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] })) tools.push(chunk);
  assert.equal(tools.find(c => c.type === 'tool-call-delta').id, 'fixture-call'); assert.equal(tools.at(-1).reason.kind, 'tool-calls');
  toolMode = false;
  for (const expected of [
    { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: '请重新登录手机上的模型账号' },
    { code: 'QUOTA_EXCEEDED', message: '模型账号额度已用完' },
    { code: 'RESPONSE_INCOMPLETE', message: '模型未完整生成回答' },
  ]) {
    failure = expected;
    const chunks = []; for await (const chunk of desktopCtx.llm.stream(options)) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.at(-1).reason.failure.code, expected.code);
    assert.equal(chunks.at(-1).reason.failure.message, expected.message);
  }
  lateFailure = true;
  const late = []; for await (const chunk of desktopCtx.llm.stream(options)) late.push(chunk);
  assert.equal(late.find(c => c.type === 'text-delta').text, '手机网关完成');
  assert.equal(late.at(-1).reason.failure.code, 'RESPONSE_INCOMPLETE');
  assert.equal(late.some(c => c.type === 'block-end'), false);
  failure = undefined; lateFailure = false;
  await phone.manage('preferences', { allowGateway: false });
  const denied = []; for await (const chunk of desktopCtx.llm.stream(options)) denied.push(chunk);
  assert.equal(denied.at(-1).reason.kind, 'error');
  assert.equal(denied.at(-1).reason.failure.code, 'PEER_UNAVAILABLE');
});

test('desktop installer preserves existing bundles, creates resolvable plugin and is idempotent', async t => {
  const home = await temp(t), profile = join(home, 'profiles/web'); await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'existing'] } } }));
  const modules = resolve('runtime/node_modules'); await installDesktopPeer(profile, modules); await installDesktopPeer(profile, modules);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json')));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'existing', 'dsh-peer']); assert.equal(manifest.dependencies.existing, '1.0.0');
  const imported = await import(join(profile, 'node_modules/dsh-peer/index.mjs')); assert.equal(imported.name, 'dsh-peer');
});

test('home relay helper publishes only local relay and parses split quick-tunnel output', async t => {
  const home = await temp(t), executable = join(home, 'mock-cloudflared');
  await writeFile(executable, '#!/bin/sh\nprintf "https://fixture-" >&2\nsleep 0.05\nprintf "peer.trycloudflare.com\\n" >&2\nsleep 2\n', { mode: 0o700 });
  let publicUrl;
  const service = await startHomeRelay({ cloudflared: executable, port: 0, onUrl: url => publicUrl = url }); t.after(() => service.close());
  const deadline = Date.now() + 2000; while (!publicUrl) { if (Date.now() > deadline) throw Error('No relay URL'); await new Promise(r => setTimeout(r, 10)); }
  assert.equal(publicUrl, 'wss://fixture-peer.trycloudflare.com/relay'); assert.equal(service.relay.server.address().address, '127.0.0.1');
});
