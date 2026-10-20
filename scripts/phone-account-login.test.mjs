import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openAccountLoginWindow } from '../vendor/dsh-codearts-auth/plugin-src/client/account-login-window.js';

test('手机版 WorkBuddy 授权通过原生弹窗，不请求电脑登录组件', async () => {
  const handle = { closed: false, close() { this.closed = true; } };
  const calls = [];
  const result = await openAccountLoginWindow({ provider: 'workbuddy', loginUrl: 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=sample',
    isolatedLoginCall() { throw Error('手机版没有电脑组件'); },
    browserWindow: { open(...args) { calls.push(args); return handle; } } });
  assert.equal(result, handle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '_blank');
  result.close();
  assert.equal(result.closed, true);
});

test('其他渠道保持原弹窗，弹窗被拦截的结果仍供界面提供手动入口', async () => {
  const calls = [];
  const result = await openAccountLoginWindow({ provider: 'zcode', loginUrl: 'https://example.test/login', browserWindow: { open(...args) { calls.push(args); return null; } } });
  assert.equal(result, null);
  assert.deepEqual(calls[0], ['https://example.test/login', '_blank', 'width=800,height=600']);
});

test('手机版发布产物保留额度修复，并移除电脑专用RPC和提示', async () => {
  const bundle = await readFile(new URL('../vendor/dsh-codearts-auth/lib/client/jet-hub.js', import.meta.url), 'utf8');
  assert.equal(bundle.includes('/desktop-isolated-login'), false);
  assert.equal(bundle.includes('请启用桌面独立登录组件'), false);
  assert.equal(bundle.includes('请在手机系统浏览器完成 WorkBuddy 授权'), true);
  assert.equal(bundle.includes('Start Plan Token'), true);
  assert.equal(bundle.includes('sourceQuota'), true);
});
