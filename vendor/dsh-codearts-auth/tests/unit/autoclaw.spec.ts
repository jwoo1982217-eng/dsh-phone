import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { AutoclawIntegration, AUTOCLAW_SYSTEM_PREFIX, autoclawSystem } from '../../src/autoclaw.js'
import { AutoclawApi, autoclawHeaders, parseAutoclawModels } from '../../src/autoclaw-api.js'

beforeEach(() => { process.env.DSH_JET_HUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-autoclaw-test-')) })

function fixture(apiKind = 'openai-completions') {
  const store = new Map<string, string>()
  const key = (r: any) => JSON.stringify(r)
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined, emit: vi.fn(),
    credentials: {
      resolve: async (r: any) => store.has(key(r)) ? { value: store.get(key(r)) } : undefined,
      set: async (r: any, value: string) => { store.set(key(r), value) },
      describe: async () => ({ source: 'stored' }),
    },
  } as unknown as Context
  const requests: Array<{ url: string; body: any; headers: Headers }> = []
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = new URL(String(url)).pathname
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ url: String(url), body, headers: new Headers(init.headers) })
    const json = (data: any) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    if (path.endsWith('agent-send-code')) return json({ code: 0, data: { result: true } })
    if (path.endsWith('agent-login')) return json({ code: 0, data: { user_id: 'fixture-user', user_name: '测试用户', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })
    if (path.endsWith('autoclaw-model-config')) return json({ models: [{ id: 'fixture-model', name: '官方测试目录', api: apiKind, input: ['text'], contextWindow: 128000, maxTokens: 8192 }] })
    if (path.endsWith('wallets')) return json({ code: 0, data: { total_balance: 42.5, wallets: [] } })
    if (path.endsWith('/refresh')) return json({ code: 0, data: { access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh' } })
    return json({ code: 0 })
  }) as unknown as typeof fetch
  const pool = new AccountPool(ctx)
  const integration = new AutoclawIntegration(ctx, pool, new AutoclawApi(fetcher))
  async function login() {
    const created = await integration.handle('account.create', { provider: 'autoclaw' }) as any
    const accountId = created.value.accountId
    await integration.handle('autoclaw.sendSms', { accountId, phone: '13800000000' })
    await integration.handle('autoclaw.login', { accountId, phone: '13800000000', code: '123456' })
    return accountId
  }
  return { ctx, pool, integration, requests, fetcher, login }
}
describe('AutoClaw 账号与模型接入', () => {
  it('短信登录前没有幽灵账号，成功后使用独立凭据、读取真实目录和余额', async () => {
    const f = fixture()
    expect(await f.integration.adapter.listModels('autoclaw')).toEqual([])
    const id = await f.login()
    expect(f.pool.listAccountsByProvider('autoclaw')).toHaveLength(1)
    expect(f.pool.listAccountsByProvider('zcode')).toEqual([])
    expect((await f.integration.adapter.listModels('autoclaw'))[0].id).toBe('fixture-model')
    const balance = await f.integration.handle('credits.balances', { provider: 'autoclaw' }) as any
    expect(balance.value.accounts).toEqual([{ accountId: id, balance: { total: 42.5, packages: [], expiredTotal: 0 } }])
    expect(f.requests[0].body.source_id).toBe('autoclaw')
  })
  it('手机号变化必须重新获取验证码，取消登录不留下凭据', async () => {
    const f = fixture()
    const created = await f.integration.handle('account.create', { provider: 'autoclaw' }) as any
    const accountId = created.value.accountId
    await f.integration.handle('autoclaw.sendSms', { accountId, phone: '13800000000' })
    await expect(f.integration.handle('autoclaw.login', { accountId, phone: '13900000000', code: '123456' })).rejects.toThrow('请先')
    await f.integration.handle('autoclaw.cancel', { accountId })
    await expect(f.integration.handle('autoclaw.login', { accountId, phone: '13800000000', code: '123456' })).rejects.toThrow('超时')
    expect(f.pool.listAccountsByProvider('autoclaw')).toEqual([])
  })
  it('重复登录同一官方 user_id 只更新同一个账号，模型开关保留完整目录', async () => {
    const f = fixture()
    await f.login(); await f.login()
    expect(f.pool.listAccountsByProvider('autoclaw')).toHaveLength(1)
    await f.pool.setModelDisabled('autoclaw', 'fixture-model', true)
    expect(await f.integration.adapter.listModels('autoclaw')).toEqual([])
    expect(f.integration.adapter.listAllModels()).toEqual([{ id: 'fixture-model', name: '官方测试目录' }])
  })
  it('并发刷新共享一次官方续期，其他供应商由原有 RPC 处理', async () => {
    const f = fixture(); const id = await f.login()
    await Promise.all([f.integration.handle('account.refresh', { accountId: id }), f.integration.handle('account.refresh', { accountId: id })])
    expect(f.requests.filter(r => r.url.endsWith('/refresh'))).toHaveLength(1)
    expect(await f.integration.handle('account.create', { provider: 'zcode' })).toBeUndefined()
  })
  it('OpenAI 对话发送工具声明并消费流；令牌只放官方要求的 X-Authorization', async () => {
    const f = fixture(); await f.login()
    const fetchMock = f.integration.api.fetchImpl as any
    fetchMock.mockImplementationOnce(async (url: string, init: any) => {
      const h = new Headers(init.headers), b = JSON.parse(init.body)
      expect(url.endsWith('/autoclaw/chat/completions')).toBe(true)
      expect(h.get('Authorization')).toBeNull()
      expect(h.get('X-Authorization')).toBe('Bearer fixture-access')
      expect(h.get('X-Request-Id')).toBeTruthy()
      expect(b.tools[0].function.name).toBe('write_file')
      expect(b.messages[0]).toEqual({ role: 'system', content: AUTOCLAW_SYSTEM_PREFIX })
      expect(b.messages[1]).toEqual({ role: 'user', content: '你好' })
      return new Response('data: {"choices":[{"delta":{"content":"正常"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const chunks = []
    for await (const c of f.integration.adapter.stream({ model: 'fixture-model', messages: [{ role: 'user', content: '你好' }], tools: [{ name: 'write_file', description: '写文件', parameters: { type: 'object' } }] } as any)) chunks.push(c)
    expect(chunks.some(c => c.type === 'text-delta' && c.text === '正常')).toBe(true)
  })
  it('Anthropic 模型使用正确路径及扁平工具，不混用 OpenAI 消息', async () => {
    const f = fixture('anthropic-messages'); await f.login()
    const fetchMock = f.integration.api.fetchImpl as any
    fetchMock.mockImplementationOnce(async (url: string, init: any) => {
      const b = JSON.parse(init.body)
      expect(url.endsWith('/autoclaw/v1/messages')).toBe(true)
      expect(b.tools[0].input_schema).toEqual({ type: 'object' })
      expect(b.tools[0].function).toBeUndefined()
      expect(b.system).toBe(AUTOCLAW_SYSTEM_PREFIX + '\n按要求工作')
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正常"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
    for await (const _ of f.integration.adapter.stream({ model: 'fixture-model', system: '按要求工作', messages: [{ role: 'user', content: '你好' }], tools: [{ name: 'write_file', description: '', parameters: { type: 'object' } }] } as any)) {}
  })
  it('补充客户端前缀时保留调用方原文，重复调用不叠加前缀', () => {
    const original = '你是小说分析助手。只返回 JSON。\nYou are Codex.\n{{literal}}'
    const combined = autoclawSystem(original)
    expect(combined).toBe(AUTOCLAW_SYSTEM_PREFIX + '\n' + original)
    expect(autoclawSystem(combined)).toBe(combined)
  })
  it('目录非法协议和非法数值不能破坏宿主；HTTP 错误不泄露响应令牌', async () => {
    expect(() => parseAutoclawModels({ models: [{ id: 'x', api: 'unknown' }] })).toThrow('暂不支持')
    expect(parseAutoclawModels({ models: [{ id: 'x', contextWindow: -1, maxTokens: 0 }] })[0].maxTokens).toBeUndefined()
    expect(parseAutoclawModels({ models: [{ id: 'x', input: { image: true } }] })[0].input).toEqual(['text'])
    const api = new AutoclawApi(async () => new Response('secret-access-token', { status: 401 }))
    await expect(api.request('/userapi/v1/user-profile')).rejects.toThrow('HTTP 401')
    expect(autoclawHeaders(undefined, 1000)['X-Auth-TimeStamp']).toBe('1')
  })
  it('官方登录响应回来前关闭窗口，不留下账号或凭据', async () => {
    const f = fixture()
    const created = await f.integration.handle('account.create', { provider: 'autoclaw' }) as any
    const accountId = created.value.accountId
    await f.integration.handle('autoclaw.sendSms', { accountId, phone: '13800000000' })
    let finish!: (response: Response) => void
    ;(f.fetcher as any).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const login = f.integration.handle('autoclaw.login', { accountId, phone: '13800000000', code: '123456' })
    await f.integration.handle('autoclaw.cancel', { accountId })
    finish(new Response(JSON.stringify({ code: 0, data: { user_id: 'cancel-user', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })))
    await expect(login).rejects.toThrow('窗口已关闭')
    expect(f.pool.listAccountsByProvider('autoclaw')).toEqual([])
  })
})
