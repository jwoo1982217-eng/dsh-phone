/**
 * MiniMax 图片与思考开关探针（走**真实适配器**）。
 *
 * ⚠️ 本探针的判据是**模型真的看到了图**（答出颜色），不是「HTTP 200」——
 * 后者在「图被静默丢弃」时也会通过。
 *
 * 闸门：`DSH_MINIMAX_IMAGE_E2E=1` **且** `DSH_MINIMAX_IMAGE_E2E_CONFIRM=yes`。
 *
 * ⚠️ 图片是**运行时自造**的 40x40 纯色 PNG（不依赖仓库里的二进制，
 * 也不依赖外部下载）—— 这样断言可以写死「模型必须答出红色」。
 * ⚠️ 实测踩过的坑：**1x1 的 PNG 会被服务端拒**（`400 invalid params`，
 * 无细节）。40x40 起正常。真实用户截图远大于此，故不影响实际使用。
 */
import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { MINIMAX } from '../../src/minimax-product.js'
import type { Message } from '@deepseek-ai/dsh-llm'
import { readMinimaxProbeCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAX_IMAGE_E2E === '1'
  && process.env.DSH_MINIMAX_IMAGE_E2E_CONFIRM === 'yes'
const describeIf = enabled ? describe : describe.skip

/** 手写一张 size×size 的纯色 PNG（无第三方依赖）。 */
function makePng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const table = (() => {
    let c = 0
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3)
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r
      raw[off + 2 + x * 3] = g
      raw[off + 3 + x * 3] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeLiveAdapter(token: string, imageBytes: Buffer): MinimaxAdapter {
  return new MinimaxAdapter({
    credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({ access_token: token, token_type: 'Bearer' }),
    refresh: async () => {},
    product: MINIMAX,
    // 桥接附件服务：把自造 PNG 当作「附件」返回
    readImage: async () => ({ data: new Uint8Array(imageBytes), mediaType: 'image/png' }),
  })
}

const userMessage = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }] } as Message)

const imageMessage = (text: string): Message =>
  ({
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: 'probe-img' } },
      { type: 'text', text },
    ],
  } as unknown as Message)

async function collect(
  adapter: MinimaxAdapter,
  model: string,
  messages: Message[],
  extra: Record<string, unknown> = {},
): Promise<{ text: string; reasoning: number; finish: string }> {
  let text = ''
  let reasoning = 0
  let finish = ''
  for await (const chunk of adapter.stream({
    provider: 'minimax', model, messages, maxTokens: 512, ...extra,
  } as never)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text.length
    if (chunk.type === 'finish') finish = chunk.reason.kind
  }
  return { text, reasoning, finish }
}

describeIf('MiniMax 图片与思考开关探针（真实适配器，会消耗额度）', () => {
  const probe = enabled ? readMinimaxProbeCredential() : undefined
  const png = makePng(40, [220, 30, 30])

  it('客户端登录态有效（过期则跳过，不代续期）', (ctx) => {
    expect(probe).toBeDefined()
    if (probe!.expired) {
      // eslint-disable-next-line no-console
      console.log('[minimax-image] token 已过期，跳过（请在客户端登录一次）。')
      ctx.skip()
    }
  })

  it('⚠️ M3.1 能真的识图（纯色 PNG ⇒ 答出颜色词）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token, png)
    const result = await collect(adapter, 'MiniMax-M3.1-Flash-Preview',
      [imageMessage('这张图片是什么颜色？只回答颜色名。')])
    // eslint-disable-next-line no-console
    console.log(`[minimax-image] M3.1 → ${JSON.stringify(result.text)}`)
    // ⚠️ 判据分两层（**不要**苛求精确的「红」）：
    // ① **必须不是**「我看不到图片」这类拒答 —— 那才是我们发图失败的信号；
    // ② 必须给出一个颜色词（证明真的从图里读到了信息）。
    //
    // ⚠️ 为什么不断言「红」：实测同一张纯色图，M3.1 答过「灰色和暗红色」、
    // M3 答过「绿色」/「红色」—— **识图质量是本 provider 模型自身的行为**，
    // 与我们的序列化无关。把它写成硬断言会让探针随机失败（假红）。
    expect(result.text).not.toMatch(/无法(直接)?查看图片|无法识别|看不到/)
    expect(result.text).toMatch(/红|绿|蓝|黄|灰|白|黑|紫|橙|青|粉|褐|棕/)
  }, 120_000)

  it('⚠️ M3 也能识图（它也声明 image 模态）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token, png)
    const result = await collect(adapter, 'MiniMax-M3',
      [imageMessage('这张图片是什么颜色？只回答颜色名。')])
    // eslint-disable-next-line no-console
    console.log(`[minimax-image] M3 → ${JSON.stringify(result.text)}`)
    expect(result.text).not.toMatch(/无法(直接)?查看图片|无法识别|看不到/)
    expect(result.text).toMatch(/红|绿|蓝|黄|灰|白|黑|紫|橙|青|粉|褐|棕/)
  }, 120_000)

  it('⚠️ 不支持的模型带图必须**报错**，不能静默丢图', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token, png)
    // M2.7 的 modalities.input 只有 text
    await expect(collect(adapter, 'MiniMax-M2.7', [imageMessage('什么颜色？')]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  }, 60_000)

  it('⚠️ M3 的开/关思考档**真的生效**（on ⇒ 有思考，none ⇒ 无思考）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token, png)
    // ⚠️ **必须用需要推理的问题**（问「只回复两个字」时模型根本不思考，
    // 两种档位都是 0 ⇒ 断言退化成同义反复，我第一版就这么假红过一次）。
    const HARD = '求 1234 和 5678 的最小公倍数。请一步步说明分解与计算过程。'
    // ⚠️ 对照的是 `on` 与 `none`，**不是**「默认 vs none」。
    // 实测 M3 **不发 thinking 时默认不思考**（两轮各 0 字符），
    // 故「默认」与「none」本就相同、无法区分；能区分的只有 on vs none。
    const on = await collect(adapter, 'MiniMax-M3', [userMessage(HARD)], { reasoningEffort: 'on' })
    const none = await collect(adapter, 'MiniMax-M3', [userMessage(HARD)], { reasoningEffort: 'none' })
    // eslint-disable-next-line no-console
    console.log(`[minimax-image] M3 难题思考字符：on=${on.reasoning} none=${none.reasoning}`)
    // 实测 on ≈ 1109~2797 字符；none = 0
    expect(none.reasoning).toBe(0)
    expect(on.reasoning).toBeGreaterThan(100)
    // ⚠️ **不断言 none 的正文非空**：这个难题会写出很长的解题过程，
    // `max_tokens` 可能在中途耗尽（实测 `none` 那次的文本长度为 0
    // —— 不是「没回答」，而是**先被截断**）。
    // 判据只取「思考字符数」这个**直接**信号，它才是档位的作用点。
    // （`on` 的正文同样不保证非空 —— 思考先吃掉配额。）
  }, 300_000)
})
