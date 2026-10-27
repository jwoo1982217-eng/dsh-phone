/**
 * `officeace-adapter-image.spec.ts` —— OfficeAce 图片输入（多模态）守卫。
 *
 * ## 背景（2026-10-13 实测）
 *
 * 用户报「deepseek-v4.1-flash 发不了图片」。排查发现**端点和模型都支持**
 * （1×1 PNG 探针：deepseek-v4.1-flash / kimi-k2.6 HTTP 200 并正确描述图片；
 * qwen3 服务端明说 not a multimodal model）—— 缺的是**适配器**：共享的
 * `serializeMessages` 把 content 压成纯文本，图片块被静默丢弃。
 *
 * ## 守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 多模态模型的带图请求含 `{type:'image_url'}` parts | 图片静默消失（原始缺陷） |
 * | 2 | 纯文本模型收到图片 → **早失败**、文案点名支持的模型 | 上游 400，整轮报废 |
 * | 3 | 字节读取失败 → `[image unavailable]` 占位符 | 静默吞图，用户以为模型看到了 |
 * | 4 | 目录 `inputModalities` 与实测表一致（闸门） | 误报 ⇒ 选错模型发图必 400 |
 *
 * ⚠️ 不发真实网络：`fetchImpl` 捕获请求体后回最小 SSE。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OfficeAceAdapter } from '../../src/officeace-adapter.js'
import { OFFICEACE_MODELS } from '../../src/officeace-product.js'

const CREDENTIAL = {
  modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'https://officeace.example',
  access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'r', dpopPrivateJwk: {},
}

/** 最小 SSE 响应（捕获请求体后立即结束流）。 */
function sseResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"","role":"assistant","reasoning_content":""}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeAdapter(fetchBody: (body: unknown) => void) {
  return new OfficeAceAdapter({
    credentialProvider: async () => CREDENTIAL,
    // ⚠️ 按 URL 分流：`listModels` 的 probe 要求 models 路径回 **JSON**，
    //    chat 路径回 SSE —— 一个桩应付两种 content-type。
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/v2/models')) {
        return new Response(JSON.stringify({ data: OFFICEACE_MODELS.map((m) => ({ id: m.id })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      fetchBody(JSON.parse(String(init?.body ?? '{}')))
      return sseResponse()
    }) as typeof fetch,
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
  })
}

function imageMessage(model: string) {
  return {
    model,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'text', text: '图里是什么？' },
        { type: 'image' as const, attachment: { attachmentId: 'att-1' } },
      ],
    }],
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* 消费到结束 */ }
}

describe('OfficeAce 图片输入', () => {
  it('① 多模态模型的带图请求升级为 image_url parts（原始缺陷：图片被压成纯文本）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream(imageMessage('deepseek-v4.1-flash') as never))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const user = messages.find((m) => m.role === 'user')
    expect(Array.isArray(user?.content), '带图 user 消息仍是字符串 ⇒ 图片被丢弃（原始缺陷复现）').toBe(true)
    const parts = user?.content as Array<Record<string, unknown>>
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === '图里是什么？')).toBe(true)
    // data URL 形态（MaaS 实测接受的形态）
    const img = parts.find((p) => p.type === 'image_url') as { image_url?: { url?: string } }
    expect(img.image_url?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('② 纯文本模型收到图片 → 早失败且文案点名支持的模型（不让上游 400 报废整轮）', async () => {
    let called = 0
    const adapter = makeAdapter(() => { called += 1 })
    await expect(drain(adapter.stream(imageMessage('qwen3-32b') as never)))
      .rejects.toThrow(/不支持图片输入.*DeepSeek-V4\.1-Flash/)
    expect(called, '闸门拦截后仍发了请求 ⇒ 上游会 400').toBe(0)
  })

  it('③ 字节读取失败 → 占位符而不是静默吞图', async () => {
    const adapter = new OfficeAceAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        void JSON.parse(String(init?.body ?? '{}'))
        return sseResponse()
      }) as typeof fetch,
      readImage: async () => undefined,
    })
    let captured: Record<string, unknown> | undefined
    // 重新包一层捕获（上面的 makeAdapter 已绑定 readImage）
    const adapter2 = new OfficeAceAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return sseResponse()
      }) as typeof fetch,
      readImage: async () => undefined,
    })
    void adapter
    await drain(adapter2.stream(imageMessage('deepseek-v4.1-flash') as never))
    const messages = captured?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const user = messages.find((m) => m.role === 'user')!
    expect(
      user.content.some((p) => p.type === 'text' && p.text === '[image unavailable]'),
      '读取失败时既没有 image_url 也没有占位符 ⇒ 图片被静默吞掉',
    ).toBe(true)
  })

  it('④ 目录 inputModalities 与实测表一致（闸门）', async () => {
    const adapter = makeAdapter(() => {})
    const models = await adapter.listModels('officeace')
    const multimodal = models.filter((m) => m.inputModalities?.includes('image')).map((m) => m.id)
    const expected = OFFICEACE_MODELS.filter((m) => (m as { multimodal?: boolean }).multimodal === true).map((m) => m.id)
    expect(multimodal, '目录声明与实测表不一致 ⇒ 闸门误报/漏报').toEqual(expected)
    // 实测过支持的模型必须在列
    expect(multimodal).toContain('deepseek-v4.1-flash')
    expect(multimodal).toContain('kimi-k2.6')
    // 实测过不支持的必须在门外
    expect(multimodal).not.toContain('qwen3-32b')
    expect(multimodal).not.toContain('glm-5.3')
  })

  it('⑤ 无图请求保持纯字符串 content（不给纯文本请求强加 parts 形状）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: '你好' }],
    } as never))
    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const user = messages.find((m) => m.role === 'user')
    expect(user?.content).toBe('你好')
  })
})

/**
 * Issue IKLSB8（2026-10-14 真机报障）：**`tool-result` 内层图片被静默丢弃，
 * 且工具结果降级为字面量 `(no output)`**。
 *
 * ## 缺陷成因（两道后果同时发生）
 *
 * `serializeMessages(options.messages)` **只传了 1 个实参**，而第二参是图片字节
 * 映射。缺了它：① 共享实现里 `imageUrls === undefined` 那一段整节跳过 ⇒ 内层图
 * 根本没有腿去读；② 图片型工具结果被 `contentToText` 压成空串 ⇒ 落到
 * `'(no output)'` 兜底 ⇒ 模型收到「工具没有任何输出」。
 *
 * ⚠️ 喂给模型的是**字面量**「没有输出」这一点尤其有害：界面表现为模型说
 * 「Read 没有返回内容 / gave no output」，用户据此以为模型没有视觉能力，
 * 而真实原因是「有输出，输出是图」。
 *
 * ## 为什么这些用例是**判别性**的（不是同义反复）
 *
 * | 用例 | 变异后变红的方式 |
 * |---|---|
 * | A | `serializeMessages(msg)` 退回单参 ⇒ 内层图消失 |
 * | B | 注图循环若改回「按 user 顺序一一对应」⇒ 图被注到**前一条**文本消息上 |
 * | C | 共享实现的 `joined.length > 0 ? joined : TEXT` 退回 `if (joined.length>0)` ⇒ 回到 `(no output)` |
 *
 * ⚠️ B 的输入**刻意**含一条「只含工具结果」的 user 消息（真实 Claude Code
 * 形状）：`wireMessages` 与 `options.messages` 的 user **数量并不相等**
 * （工具结果展开成 `role:'tool'`），旧补偿循环正是在这里错位。
 */
describe('OfficeAce 工具结果内嵌图片（Issue IKLSB8）', () => {
  /** 真实 Claude Code 形态：图在 `tool-result.content` 内层，提问在同一条 user 消息里。 */
  function nestedToolResultImage(model: string) {
    return {
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看图' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我看看' },
            { type: 'tool-call', id: 'c1', name: 'Read', arguments: '{}' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result', toolCallId: 'c1', isError: false,
              content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
            },
            { type: 'text', text: '图里是什么？' },
          ],
        },
      ],
    }
  }

  it('A（判别）tool-result 内层图片必须进请求（原始缺陷：图片字节根本没上 wire）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream(nestedToolResultImage('deepseek-v4.1-flash') as never))

    const wire = JSON.stringify(captured?.messages)
    expect(wire, '内层图片没有上 wire ⇒ 模型完全看不到图（原始缺陷复现）').toContain('"image_url"')
    expect(wire).toContain('data:image/png;base64,')
  })

  it('B（判别）图必须与提问同一条 user 消息，且**不得**错注到前一条文本上', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream(nestedToolResultImage('deepseek-v4.1-flash') as never))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    // 带图的那条 user 必须同时带提问正文（`0dd27ca` 的阶段结论：图与问同条才可见）。
    const withImage = messages.filter((m) => m.role === 'user'
      && JSON.stringify(m.content).includes('image_url'))
    expect(withImage, '带图 user 消息条数不为 1 ⇒ 图被注到了别处').toHaveLength(1)
    expect(
      JSON.stringify(withImage[0]!.content),
      '图与提问不在同一条 user 消息 ⇒ 上游会让模型看不见图（issue IKLIFH 同型）',
    ).toContain('图里是什么？')
    // 第一条 user（"看图"）**必须**保持纯文本：旧实现把图注到这里，带图那条反而没图。
    const first = messages.find((m) => m.role === 'user')!
    expect(
      JSON.stringify(first.content),
      '图被错注到**前一条**纯文本 user 上（旧的按顺序配对实现即此症状）',
    ).not.toContain('image_url')
  })

  it('C（判别）纯图片工具结果不得被压成字面量 `(no output)`', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream(nestedToolResultImage('deepseek-v4.1-flash') as never))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool, '工具结果没有下发 ⇒ 工具调用与结果脱节').toBeDefined()
    // 判据是**内容说清了「输出在这里、只是它是图」**，而不是「没有输出」。
    expect(
      String(tool.content),
      '工具结果退化成 `(no output)` ⇒ 模型会说「Read 没有返回内容」，用户误判成模型没有视觉能力',
    ).not.toBe('(no output)')
    expect(String(tool.content), '至少要让模型知道「这是工具结果附带的图片」').toMatch(/image/i)
  })

  it('D（对照）内层图 + 正文时，正文照旧保留（有图不得吞掉同一结果里的文字）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看图' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'Read', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result', toolCallId: 'c1', isError: false,
              content: [
                { type: 'text', text: '截图如下' },
                { type: 'image', attachment: { attachmentId: 'att-1' } },
              ],
            },
            { type: 'text', text: '图里是什么？' },
          ],
        },
      ],
    } as never))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const tool = messages.find((m) => m.role === 'tool')!
    expect(String(tool.content), '工具结果自带的正文被吞掉').toContain('截图如下')
    expect(JSON.stringify(captured?.messages)).toContain('image_url')
  })

  it('E（接线）适配器必须把 imageUrls 交给共享序列化（源码级判据）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '../../src/officeace-adapter.ts'), 'utf8')
    expect(
      src,
      '`serializeMessages(options.messages)` 单参调用 = 图片通路整体关闭（本 issue 的根因）',
    ).toMatch(/serializeMessages\(options\.messages, imageUrls\)/)
    // ⚠️ 反向：不得再自己维护第二套注图实现（它够不到 tool-result 内层、且索引会错位）。
    expect(
      src,
      '不得再出现第二套「按 user 顺序一一对应」的注图循环（收集与注入必须同源同深度）',
    ).not.toMatch(/originalUsers/)
  })
})
