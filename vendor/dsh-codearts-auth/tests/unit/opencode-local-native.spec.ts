import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpencodeLocalService, normalizeOpencodeLocalUrl } from '../../src/opencode-local-native.js'
import { OpencodeLocalAdapter, nativeOpencodeFailure } from '../../src/opencode-local-adapter.js'
import { collectOpenAiCompletion, toOpenAiSse } from '../../src/openai-gateway/stream.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(mode = 'text') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-opencode-'))
  let counter = 0, reply: any, pending: any
  const requests: Array<{ method: string; path: string; body: any }> = []
  const configs: any[] = [], inputs: any[] = []
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost'), chunks: Buffer[] = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      requests.push({ method: req.method!, path: url.pathname, body })
      const send = (value: any, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (url.pathname === '/global/health') {
        if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>SPA'); return }
        send({ healthy: true, version: '1.19.2' }); return
      }
      if (url.pathname === '/provider') { send({ all: ['malformed', null, { id: 'opencode', models: {
        'native-free': { name: '真实目录测试模型', cost: { input: 0, output: 0 }, limit: { context: 10000, output: 4096 }, capabilities: { input: { image: true } }, variants: { high: {} } },
        'paid-model': { cost: { input: 1, output: 2 } }, 'unknown-cost': {},
      } }], default: {}, connected: ['opencode'] }); return }
      if (url.pathname === '/session' && req.method === 'POST') { send({ id: `ses_test_${++counter}` }); return }
      if (/\/session\/[^/]+\/message$/.test(url.pathname)) {
        const dir = url.searchParams.get('directory')!
        const config = JSON.parse(await readFile(join(dir, 'opencode.json'), 'utf8')); configs.push(config); inputs.push(body)
        expect(body.model).toEqual({ providerID: 'opencode', modelID: 'native-free' })
        expect(body.messages).toBeUndefined(); expect(body.format).toBeUndefined(); expect(body.tools).toBeUndefined()
        if (mode === 'tool') {
          const rpc = async (method: string, params = {}) => {
            const r = await fetch(config.mcp.dsh.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: counter, method, params }) }); return r.json() as any
          }
          await rpc('initialize', { protocolVersion: '2024-11-05' })
          const list = await rpc('tools/list')
          expect(list.result.tools[0].inputSchema.properties.value.type).toBe('integer')
          reply = await rpc('tools/call', { name: list.result.tools[0].name, arguments: { value: 43 } })
          pending = res; return
        }
        if (['native-bash', 'native-read', 'retry', 'permission', 'timeout', 'cancel'].includes(mode)) { pending = res; return }
        if (mode === 'error') { send({ info: { error: { name: 'APIError', data: { statusCode: 403, message: 'Only OpenCode clients', responseBody: JSON.stringify({ error: { type: 'FreeTierError' } }) } } }, parts: [] }); return }
        send({ info: { finish: 'stop', tokens: { input: 8, output: 2, cache: { read: 0, write: 0 } } }, parts: [{ type: 'text', text: '43' }] }); return
      }
      if (url.pathname === '/permission') {
        send(mode === 'permission' ? [{ sessionID: 'ses_test_1' }] : mode.startsWith('native-') && pending
          ? [{ sessionID: 'ses_test_1', permission: 'external_directory', tool: { messageID: 'msg_native', callID: 'call_native' } }]
          : [{ sessionID: 'ses_unrelated' }]); return
      }
      if (url.pathname === '/session/status') { send(mode === 'retry' && pending
        ? { ses_test_1: { type: 'retry', attempt: 1, message: 'Rate limit exceeded. Please try again later.', next: Date.now() + 60000 } }
        : {}); return }
      if (url.pathname === '/session/ses_test_1/message/msg_native') {
        send({ parts: [{ type: 'tool', sessionID: 'ses_test_1', messageID: 'msg_native', callID: 'call_native',
          tool: mode === 'native-bash' ? 'bash' : 'read', state: { status: 'running', input: mode === 'native-bash'
            ? { command: 'git status --short', description: '检查仓库', timeout: 15000, workdir: '/workspace' }
            : { filePath: '/workspace/package.json', offset: 0, limit: 20 } } }] }); return
      }
      if (url.pathname.endsWith('/abort')) { if (pending) { pending.writeHead(200, { 'content-type': 'application/json' }); pending.end(JSON.stringify({ info: { error: { name: 'MessageAbortedError' } }, parts: [] })); pending = undefined } send(true); return }
      send(true)
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: String(error) })) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, baseUrl = `http://127.0.0.1:${address.port}`
  await mkdir(join(home, 'opencode-local'))
  await writeFile(join(home, 'opencode-local/settings.json'), JSON.stringify({ baseUrl }))
  const service = new OpencodeLocalService({ home, readAuth: async () => undefined, saveAuth: async () => {} })
  cleanup.push(async () => { await service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }) })
  return { service, home, baseUrl, requests, configs, inputs, reply: () => reply, setMode: (value: string) => { mode = value } }
}

const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'opencode', model: 'native-free', messages: [{ role: 'user', content: [{ type: 'text', text: '计算17加26' }] }], ...extra })
const collect = async (adapter: OpencodeLocalAdapter, input = options()) => { const chunks = []; for await (const chunk of adapter.stream(input)) chunks.push(chunk); return chunks }

describe('OpenCode 原生本地链路', () => {
  it('仅接受本机 serve 根地址，拒绝远端、OpenAI路径及URL中的密码', () => {
    expect(normalizeOpencodeLocalUrl('http://127.0.0.1:4096/')).toBe('http://127.0.0.1:4096')
    for (const url of ['http://example.com:4096', 'http://127.0.0.1:4096/v1', 'http://a:b@localhost:4096', 'https://localhost:4096', 'http://127.0.0.1:4096/?token=secret']) expect(() => normalizeOpencodeLocalUrl(url)).toThrow()
  })
  it('HTTP 200网页不是健康服务，错误地址不会被接管或报作已连接', async () => {
    const f = await fixture('html'); await expect(f.service.ensure()).rejects.toThrow('非 JSON')
    expect(await f.service.status()).toMatchObject({ healthy: false, managed: false })
  })
  it('解析/provider.all动态免费目录、图片和窗口，不猜静态清单', async () => {
    const f = await fixture(); expect(await f.service.catalog()).toEqual([{ id: 'native-free', name: '真实目录测试模型', inputModalities: ['text', 'image'], contextWindow: 10000, outputLimit: 4096, variants: ['high'] }])
  })
  it('原生会话/消息请求返回SDK正文、usage和finish，清理限本次会话', async () => {
    const f = await fixture(), adapter = new OpencodeLocalAdapter(f.service)
    const chunks = await collect(adapter, options({ maxTokens: 256, temperature: 0.2 }))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '43' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(f.configs[0].provider.opencode.models['native-free'].limit.output).toBe(256)
    expect(f.configs[0].agent.dsh.temperature).toBe(0.2)
    expect(f.requests.filter(r => r.method === 'DELETE').map(r => r.path)).toEqual(['/session/ses_test_1'])
    expect(await readdir(join(f.service.root, 'requests'))).toEqual([])
  })
  it('MCP真实schema生成工具调用，原生端不执行、不伪造成功；先取消后交回DSH', async () => {
    const f = await fixture('tool'), adapter = new OpencodeLocalAdapter(f.service)
    const chunks = await collect(adapter, options({ tools: [{ name: 'qa_echo', description: '验收工具', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }] }))
    expect(chunks.find(c => c.type === 'block-end')).toMatchObject({ block: { type: 'tool-call', name: 'qa_echo', arguments: '{"value":43}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    // 正文块可直接组装，但 Chat 网关依赖 delta；真实网关必须保留调用名与参数。
    const replay = async function* () { yield* chunks }
    const completion = await collectOpenAiCompletion(replay(), 'qa', 'opencode/native-free') as any
    expect(completion.choices[0].message.tool_calls).toMatchObject([{ function: { name: 'qa_echo', arguments: '{"value":43}' } }])
    let sse = ''; for await (const frame of toOpenAiSse(replay(), 'qa', 'opencode/native-free')) sse += frame
    expect(sse).toContain('qa_echo')
    expect(sse).toContain('arguments')
    expect(f.reply().result.isError).toBe(true)
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
    expect(f.configs[0].agent.dsh.permission).toEqual({ '*': 'deny', bash: 'ask', read: 'ask', external_directory: 'ask', 'dsh_*': 'allow' })
    expect(f.requests.find(r => r.path === '/session' && r.method === 'POST')!.body.permission).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
      { permission: 'dsh_*', pattern: '*', action: 'allow' },
    ])
  })
  it.each(['native-bash', 'native-read'])('挂起的%s转交实际DSH工具，先取消、不批准原生执行', async mode => {
    const f = await fixture(mode), adapter = new OpencodeLocalAdapter(f.service)
    const tools = [
      { name: 'bash', description: '命令', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' } }, required: ['command', 'description'] } },
      { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
    ]
    const chunks = await collect(adapter, options({ tools }))
    const call = chunks.find(c => c.type === 'block-end') as any
    expect(call.block.name).toBe(mode === 'native-bash' ? 'bash' : 'read')
    expect(JSON.parse(call.block.arguments)).toEqual(mode === 'native-bash'
      ? { command: 'git status --short', description: '检查仓库', timeoutMs: 15000, workdir: '/workspace' }
      : { file_path: '/workspace/package.json', offset: 1, limit: 20 })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', id: call.block.id, name: call.block.name }))
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
    expect(f.requests.some(r => r.path.includes('/permission/') && r.method !== 'GET')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
  it('图片以原字节data URL进native file part，历史不塞base64字符串', async () => {
    const f = await fixture(), adapter = new OpencodeLocalAdapter(f.service, { readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }) })
    await collect(adapter, options({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'qa-image' } } as any] }] }))
    expect(f.inputs[0].parts[1]).toMatchObject({ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AQID' })
    expect(f.inputs[0].parts[0].text).not.toContain('base64')
  })
  it('图片丢失在发起原生会话前明确失败', async () => {
    const f = await fixture(), adapter = new OpencodeLocalAdapter(f.service)
    await expect(collect(adapter, options({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } } as any] }] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(f.requests.some(r => r.path === '/session')).toBe(false)
  })
  it('原生内置工具索权被阻止，不自动放行，不操作别的会话', async () => {
    const f = await fixture('permission'), adapter = new OpencodeLocalAdapter(f.service)
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
    expect(f.requests.some(r => r.path.includes('ses_unrelated') && r.method !== 'GET')).toBe(false)
  })
  it('超时真正中断native会话，恢复后可以重试，不留busy状态', async () => {
    const f = await fixture('timeout'), adapter = new OpencodeLocalAdapter(f.service, { timeoutMs: 500 })
    await f.service.catalog()
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
    expect(await f.service.status()).toMatchObject({ activeRequests: 0 })
    f.setMode('text')
    expect((await collect(adapter)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('上游限流重试立即保留真实原因并中止，不等到超时，也不改作密钥无效', async () => {
    const f = await fixture('retry'), adapter = new OpencodeLocalAdapter(f.service)
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringContaining('Rate limit exceeded') })
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
    expect(await f.service.status()).toMatchObject({ activeRequests: 0 })
    f.setMode('text')
    expect((await collect(adapter)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('用户取消不继续后台推理，保留取消原因', async () => {
    const f = await fixture('cancel'), adapter = new OpencodeLocalAdapter(f.service), controller = new AbortController()
    const running = collect(adapter, options({ signal: controller.signal })); const t = setTimeout(() => controller.abort(Error('用户取消验收')), 100)
    await expect(running).rejects.toThrow('用户取消验收'); clearTimeout(t)
    expect(f.requests.some(r => r.path === '/session/ses_test_1/abort')).toBe(true)
  })
  it('免费客户端资格403保留原因，不改写成API key无效', async () => {
    const f = await fixture('error'), adapter = new OpencodeLocalAdapter(f.service)
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'OPENCODE_CLIENT_REQUIRED', failure: { status: 403 } })
    expect(nativeOpencodeFailure({ name: 'APIError', data: { statusCode: 403, message: 'forbidden' } })).toMatchObject({ code: 'FORBIDDEN', failure: { status: 403 } })
  })
  it('活跃请求期间不能改连接，密码写入失败恢复旧配置', async () => {
    const f = await fixture(), done = f.service.beginCall()
    await expect(f.service.handleRpc('opencode.local.configure', { baseUrl: 'http://localhost:4096' })).rejects.toThrow('任务仍在调用'); done()
    await f.service.ensure()
    const old = await readFile(join(f.service.root, 'settings.json'), 'utf8')
    f.service.options.saveAuth = async () => { throw Error('凭据写入失败') }
    await expect(f.service.handleRpc('opencode.local.configure', { baseUrl: 'http://localhost:4096', password: 'synthetic-test' })).rejects.toThrow('凭据写入失败')
    expect(await readFile(join(f.service.root, 'settings.json'), 'utf8')).toBe(old)
  })
})
