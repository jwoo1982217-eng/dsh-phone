import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptAdapter } from './chatgpt-adapter.js';
import { RESOURCE } from './chatgpt-protocol.js';
import { connected, callback, collect, frames } from './chatgpt-fixtures.js';

const request = { model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };
async function accounts(t, fetcher) {
  const f = await connected({ fetcher }); t.after(() => f.account.dispose());
  for (const letter of ['B', 'C']) { await f.account.login({ newProfile: true }); await f.account.callback(callback(f.account, 'oaiapp_fixture_' + letter)); }
  const ids = f.account.state.profiles.map(p => p.id);
  await f.account.mutate(async () => {
    f.account.state.profiles.forEach((p, i) => { p.tokens.accessToken = ['fixture-A', 'fixture-B', 'fixture-C'][i]; });
    f.account.state.active = ids[0]; await f.account.save();
  });
  return { ...f, ids, adapter: new ChatGptAdapter(f.account) };
}
const tokens = f => f.calls.filter(c => c.url === `${RESOURCE}/responses`).map(c => new Headers(c.init.headers).get('authorization'));

test('真实会员适配器正常请求 A B C A，目录读取不占顺位，当前查看账号不改变', async t => {
  const f = await accounts(t);
  const before = await f.account.status();
  for (let i = 0; i < 4; i++) { await f.adapter.listModels(); await collect(f.adapter.stream(request)); }
  assert.deepEqual(tokens(f), ['Bearer fixture-A', 'Bearer fixture-B', 'Bearer fixture-C', 'Bearer fixture-A']);
  assert.equal((await f.account.status()).active, before.active);
});

test('并发会员请求独立分配连接，注销与不支持的模型自动跳过', async t => {
  const f = await accounts(t);
  await Promise.all(Array.from({ length: 6 }, () => collect(f.adapter.stream(request))));
  assert.deepEqual(tokens(f), ['Bearer fixture-A', 'Bearer fixture-B', 'Bearer fixture-C', 'Bearer fixture-A', 'Bearer fixture-B', 'Bearer fixture-C']);
  f.account.state.profiles[1].tokens = null;
  f.account.cache.set(f.ids[2], { token: 'fixture-C', models: [], expiresAt: Date.now() + 60000 });
  await collect(f.adapter.stream(request));
  assert.equal(tokens(f).at(-1), 'Bearer fixture-A');
  await collect(f.adapter.stream(request));
  assert.equal(tokens(f).at(-1), 'Bearer fixture-A');
});

test('初始 429 换号并冷却，下一请求继续；所有连接失败返回原始错误', async t => {
  let failed = false;
  const f = await accounts(t, async (url, init) => {
    if (url === `${RESOURCE}/responses` && new Headers(init.headers).get('authorization') === 'Bearer fixture-A' && !failed) {
      failed = true; return new Response('{"error":{"code":"rate_limit"}}', { status: 429 });
    }
  });
  await collect(f.adapter.stream(request)); await collect(f.adapter.stream(request)); await collect(f.adapter.stream(request));
  assert.deepEqual(tokens(f), ['Bearer fixture-A', 'Bearer fixture-B', 'Bearer fixture-C', 'Bearer fixture-B']);
  f.account.coolDown(f.ids[1], request.model); f.account.coolDown(f.ids[2], request.model);
  await assert.rejects(collect(f.adapter.stream(request)), { code: 'MODEL_NOT_AVAILABLE' });
  f.account.cooldowns.clear();
  await collect(f.adapter.stream(request));
  assert.equal(tokens(f).at(-1), 'Bearer fixture-C');
});

test('交付内容后再限流不重放，用户取消不换号，后续请求可继续', async t => {
  let late = true;
  const f = await accounts(t, async url => {
    if (url === `${RESOURCE}/responses` && late) {
      return new Response(frames([
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '已交付' },
        { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
      ]), { headers: { 'content-type': 'text/event-stream' } });
    }
  });
  await assert.rejects(collect(f.adapter.stream(request)), { code: 'QUOTA_EXCEEDED' });
  assert.equal(tokens(f).length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(f.adapter.stream({ ...request, signal: controller.signal })));
  assert.equal(tokens(f).length, 1);
  late = false;
  await collect(f.adapter.stream(request));
  assert.equal(tokens(f).at(-1), 'Bearer fixture-B');
});
