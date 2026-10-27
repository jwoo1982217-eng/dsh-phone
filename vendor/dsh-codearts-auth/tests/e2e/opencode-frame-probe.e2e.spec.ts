/**
 * OpenCode 真实逐帧探针：默认跳过，仅使用匿名通道，不执行模型生成的工具调用。
 * 闸门：DSH_OPENCODE_E2E=1 + DSH_OPENCODE_CHAT_E2E_CONFIRM=yes。
 * 同时记录原始 SSE 和 DSH chunk；输出仅保存在已忽略的 .e2e-logs/。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { listIdentitySlots } from '../../src/opencode-auth.js'
import { OPENCODE } from '../../src/opencode-product.js'

const enabled = process.env.DSH_OPENCODE_E2E === '1'
  && process.env.DSH_OPENCODE_CHAT_E2E_CONFIRM === 'yes'
const suite = enabled ? describe : describe.skip

afterEach(() => vi.unstubAllGlobals())

suite('OpenCode 原始 SSE 逐帧打印', () => {
  it('打印一条真实客户端工具请求的所有上游帧及解析结果', async () => {
    const logPath = fileURLToPath(new URL('../../.e2e-logs/opencode-frame-probe.log', import.meta.url))
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, '', 'utf8')
    const started = performance.now()
    const print = (label: string, value: string): void => {
      const line = `[${label} +${Math.round(performance.now() - started)}ms]\n${value}\n\n`
      appendFileSync(logPath, line, 'utf8')
      console.log(line)
    }
    let frameCount = 0
    let requestCount = 0
    let status: number | undefined
    const nativeFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1
      const headers = new Headers(init?.headers)
      headers.delete('authorization')
      print('REQUEST', JSON.stringify({ url: String(input), headers: Object.fromEntries(headers), body: JSON.parse(String(init?.body)) }, null, 2))
      const response = await nativeFetch(input, init)
      status = response.status
      print('HTTP', JSON.stringify({ status, contentType: response.headers.get('content-type'), requestId: response.headers.get('x-request-id') }, null, 2))
      if (!response.ok || response.body === null) return response
      const decoder = new TextDecoder()
      let buffer = ''
      const flushEvents = (): void => {
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const event = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          if (event.trim()) print(`UPSTREAM FRAME ${String(++frameCount).padStart(3, '0')}`, event)
        }
      }
      // 只观察原始字节，不修改、不归一任何字段；协议转换仍走真实 OpencodeAdapter。
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true })
          flushEvents()
          controller.enqueue(chunk)
        },
        flush() {
          buffer += decoder.decode()
          flushEvents()
          if (buffer.trim()) print(`UPSTREAM FRAME ${String(++frameCount).padStart(3, '0')} EOF`, buffer)
        },
      }))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    })
    const tools = ['read', 'shell', 'edit', 'write', 'glob', 'grep'].map((name) => ({
      name,
      description: `客户端 ${name} 工具；read 用 file_path 读取模拟文件`,
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    }))
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([{ id: 'opencode-anon-frame-probe', enabled: true, apiKey: 'public' }], OPENCODE.defaultUserAgent),
    })
    const options = {
      provider: 'opencode',
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: '请调用客户端 read 工具读取文件 /virtual/probe.txt，只调用工具，不直接回答。不要调用保留工具。' }] }],
      tools,
      maxTokens: 1024,
      signal: AbortSignal.timeout(60_000),
    } as unknown as GenerateOptions
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of adapter.stream(options)) {
        chunks.push(chunk)
        print(`DSH CHUNK ${String(chunks.length).padStart(3, '0')}`, JSON.stringify(chunk))
      }
    } catch (error) {
      print('ERROR', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      throw error
    }
    const calls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)
    print('SUMMARY', JSON.stringify({ status, requestCount, frameCount, chunkCount: chunks.length, toolCalls: calls, finish: chunks.filter((chunk) => chunk.type === 'finish') }, null, 2))
    expect(status).toBe(200)
    expect(requestCount).toBe(1)
    expect(frameCount).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'read' })
    expect(JSON.parse((calls[0] as { arguments: string }).arguments)).toEqual({ file_path: '/virtual/probe.txt' })
  }, 90_000)
})
