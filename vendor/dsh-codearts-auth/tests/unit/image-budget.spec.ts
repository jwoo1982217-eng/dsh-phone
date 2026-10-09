import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import {
  DEFAULT_IMAGE_PIXEL_BUDGET,
  REQUEST_IMAGE_MAX_BYTES,
  fitImageToPixelBudget,
  projectRequestImage,
  requestImageTargetFor,
  RACCOON_REQUEST_IMAGE_MAX_BYTES,
  type ImageRequestTarget,
} from '../../src/image-budget.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { RACCOON } from '../../src/raccoon-product.js'
import { CODEBUDDY, type BuddyProduct } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

/**
 * 图片像素预算的回归用例（Gitee issue !IKITT9）。
 *
 * 用户症状：带截图的会话积累到 36 张后**每一轮都失败且不可恢复**，
 * 报 `prompt is too long: 100001 tokens > 100000 maximum`，自动压缩试 3 次全灭。
 *
 * 这里锁三件事：
 *
 * 1. **缩放几何**（纯函数）—— 每张图按固定像素预算派生目标尺寸，
 *    小图绝不放大、非法尺寸绝不瞎猜。
 * 2. **回退方向**（适配器行为）—— 拿不到请求版本时必须**发原图**；
 *    缩放是优化，不能变成新的故障源（issue 特别标注的边界）。
 * 3. **错误分类** —— 「请求过大」在报文**没有 `extError`** 时会被 harness 的
 *    通用分类器漏判成 `INVALID_REQUEST`，而那个码既不重试也不触发压缩。
 */

const CREDENTIAL = {
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: String(Date.now() + 7_200_000),
} as unknown as BuddyCredential

/** 一张 1721×997 的截图（issue 里失败会话的真实尺寸）。 */
const SCREENSHOT = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 1_715_837,
  width: 1721,
  height: 997,
}

interface Target {
  width: number
  height: number
  maxBytes: number
}

interface DriveOptions {
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  readImageRequest?: (
    attachment: unknown,
    target: Target,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 让请求以该状态码 + 报文失败（用于错误分类用例）。 */
  failWith?: { status: number; body: string }
  product?: BuddyProduct
  /** 附件引用（默认一张 1721×997 的截图）。 */
  attachment?: unknown
}

interface DriveResult {
  /** 实际发出的请求体；请求没发出去时为 undefined。 */
  body?: Record<string, unknown>
  /** 适配器为每张图请求的派生目标。 */
  targets: Target[]
  /** stream 抛出的错误（成功时为 undefined）。 */
  error?: unknown
}

/** 跑一轮对话，把请求体、派生目标与错误一次取回。 */
async function drive(options: DriveOptions = {}): Promise<DriveResult> {
  const targets: Target[] = []
  let body: Record<string, unknown> | undefined
  const adapter = new BuddyAdapter({
    credentialRef: 'BUDDY_ACCOUNT_TEST' as never,
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (options.failWith !== undefined) {
        return new Response(options.failWith.body, { status: options.failWith.status })
      }
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch,
    ...(options.readImage ? { readImage: options.readImage } : {}),
    ...(options.product ? { product: options.product } : {}),
    ...(options.readImageRequest
      ? {
        readImageRequest: (attachment: unknown, target: Target) => {
          targets.push(target)
          return options.readImageRequest!(attachment, target)
        },
      }
      : {}),
  })

  const result: DriveResult = { targets }
  try {
    for await (const _chunk of adapter.stream({
      provider: 'buddy',
      model: 'deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: options.attachment ?? SCREENSHOT }],
      }] as never,
      signal: new AbortController().signal,
    } as never)) {
      /* 抽干即可 */
    }
    result.body = body
  } catch (error) {
    result.error = error
    result.body = body
  }
  return result
}

/** 取请求体里那条 user 消息的多模态 parts。 */
function userParts(body?: Record<string, unknown>): Array<{ type: string; image_url?: { url: string } }> {
  const messages = (body?.messages ?? []) as Array<Record<string, unknown>>
  const user = messages.find((m) => m.role === 'user')
  return (user?.content ?? []) as Array<{ type: string; image_url?: { url: string } }>
}

describe('fitImageToPixelBudget：按总像素预算求目标尺寸', () => {
  it('⚠️ 1721×997 的截图在默认预算下缩到 1051×608', () => {
    // 面积 1,715,837 → 预算 640,000，线性因子 sqrt(640000/1715837) ≈ 0.6107。
    // 报障者实现的数字是 1050×608 —— 差 1 px 来自取整口径，同档即可。
    expect(fitImageToPixelBudget(1721, 997, DEFAULT_IMAGE_PIXEL_BUDGET)).toEqual({
      width: 1051,
      height: 608,
    })
  })

  it('结果面积不超预算，且宽高比误差小于 1%', () => {
    const fitted = fitImageToPixelBudget(1721, 997, DEFAULT_IMAGE_PIXEL_BUDGET)!
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(DEFAULT_IMAGE_PIXEL_BUDGET)
    const sourceRatio = 1721 / 997
    const targetRatio = fitted.width / fitted.height
    expect(Math.abs(targetRatio - sourceRatio) / sourceRatio).toBeLessThan(0.01)
  })

  it('⚠️ 小图原样返回，绝不放大（放大只会让文字更糊）', () => {
    expect(fitImageToPixelBudget(320, 200, DEFAULT_IMAGE_PIXEL_BUDGET)).toEqual({ width: 320, height: 200 })
    // 恰好等于预算不算超
    expect(fitImageToPixelBudget(800, 800, DEFAULT_IMAGE_PIXEL_BUDGET)).toEqual({ width: 800, height: 800 })
  })

  it('细长图（滚动截图）同样按面积缩，且不出现 0 边', () => {
    const fitted = fitImageToPixelBudget(1200, 9000, DEFAULT_IMAGE_PIXEL_BUDGET)!
    expect(fitted.width).toBeGreaterThanOrEqual(1)
    expect(fitted.height).toBeGreaterThanOrEqual(1)
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(DEFAULT_IMAGE_PIXEL_BUDGET)
  })

  it('非法输入返回 undefined（调用方据此回退原图，绝不瞎猜尺寸）', () => {
    expect(fitImageToPixelBudget(Number.NaN, 997, 640_000)).toBeUndefined()
    expect(fitImageToPixelBudget(1721, 0, 640_000)).toBeUndefined()
    expect(fitImageToPixelBudget(1721, 997, -1)).toBeUndefined()
    expect(fitImageToPixelBudget(1721, 997, Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('requestImageTargetFor：组装附件服务的请求目标', () => {
  it('未配置预算时用默认 640,000 px，并带 2 MiB 字节目标', () => {
    expect(requestImageTargetFor(1721, 997, undefined)).toEqual({
      width: 1051,
      height: 608,
      maxBytes: REQUEST_IMAGE_MAX_BYTES,
    })
    expect(DEFAULT_IMAGE_PIXEL_BUDGET).toBe(640_000)
    expect(REQUEST_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024)
  })

  it('产品给了更小的预算就更狠地缩（预算是产品级旋钮）', () => {
    const target = requestImageTargetFor(1721, 997, 160_000)!
    expect(target.width * target.height).toBeLessThanOrEqual(160_000)
  })
})

describe('BuddyAdapter：发请求版本，拿不到时回退原图', () => {
  it('⚠️ 提供 readImageRequest 时用它发出缩放后的字节，且不再读原图', async () => {
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    const { body, targets } = await drive({
      readImage,
      readImageRequest: async () => ({ data: new Uint8Array([9, 9]), mediaType: 'image/jpeg' }),
    })

    expect(userParts(body)[1]?.image_url?.url).toBe('data:image/jpeg;base64,CQk=')
    expect(targets).toEqual([{ width: 1051, height: 608, maxBytes: REQUEST_IMAGE_MAX_BYTES }])
    expect(readImage, '有请求版本时不该再去读原图').not.toHaveBeenCalled()
  })

  it('⚠️ 桥接返回 undefined（老宿主 / 拒绝投影）时回退原图，请求不得失败', async () => {
    const { body, error, targets } = await drive({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      readImageRequest: async () => undefined,
    })
    expect(error).toBeUndefined()
    expect(targets).toHaveLength(1)
    expect(userParts(body)[1]?.image_url?.url).toBe('data:image/png;base64,AQID')
  })

  it('桥接抛错时也回退原图（缩放失败不该打死一次本来能成功的请求）', async () => {
    const { body, error } = await drive({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      readImageRequest: () => {
        throw new Error('ATTACHMENT_PROJECTION_UNSUPPORTED')
      },
    })
    // 桥接层（`makeReadImageRequest`）本该把异常吞成 undefined；这里模拟
    // **它没吞**的情形。适配器自己兜住并回退 —— 两层各自都要挡住，
    // 否则「加上了缩放」反而成为新的故障源。
    expect(error).toBeUndefined()
    expect(userParts(body)[1]?.image_url?.url).toBe('data:image/png;base64,AQID')
  })

  it('未配置 readImageRequest 时保持既有行为（发原图）', async () => {
    const { body, targets } = await drive({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    })
    expect(targets).toEqual([])
    expect(userParts(body)[1]?.image_url?.url).toBe('data:image/png;base64,AQID')
  })

  it('⚠️ 附件引用没有固有尺寸时不派生（宁可发原图也不瞎猜目标）', async () => {
    const readImageRequest = vi.fn(async () => ({ data: new Uint8Array([7]), mediaType: 'image/jpeg' }))
    const { body, targets } = await drive({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      readImageRequest,
      attachment: { attachmentId: 'att-no-size', mediaType: 'image/png' },
    })
    expect(targets).toEqual([])
    expect(readImageRequest).not.toHaveBeenCalled()
    expect(userParts(body)[1]?.image_url?.url).toBe('data:image/png;base64,AQID')
  })

  it('产品配置更小的预算时，适配器按产品的值派生', async () => {
    const { targets } = await drive({
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      readImageRequest: async () => ({ data: new Uint8Array([2]), mediaType: 'image/jpeg' }),
      product: { ...CODEBUDDY, imagePixelBudget: 160_000 } as BuddyProduct,
    })
    expect(targets[0]!.width * targets[0]!.height).toBeLessThanOrEqual(160_000)
  })
})

describe('五个适配器都真的走了共享投影（不再各自裸发原图）', () => {
  /**
   * 本 issue 的缺陷形态就是「一个适配器接了、其余没接」—— 五个适配器的图片
   * 代码原本是**同一形状重复五遍**，正是最容易漏改的结构。
   *
   * 这里用源码级断言而不是给五家各搭一套适配器桩：qoder 要 uid + WASM、
   * lobsterai 要 remoteMeta、cline 要先暖目录，搭起来的成本远高于它保护的
   * 那一行代码；而共享实现本身已由上面的行为用例锁死。
   * raccoon 是唯一例外（构造最便宜），它有真行为用例验证字节目标。
   */
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')
  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /**
   * 撞**请求体体积**的四家：字节目标是主约束，必须显式传给投影
   * （raccoon 512 KB、其余 1 MiB，见 `src/image-budget.ts`）。
   */
  const BODY_LIMITED = [
    'src/raccoon-adapter.ts',
    'src/qoder-adapter.ts',
    'src/lobsterai-adapter.ts',
    'src/cline-adapter.ts',
  ]

  it.each(BODY_LIMITED)('%s 传像素预算 + 字节目标，且回退顺序正确', (rel) => {
    const source = codeOnly(read(rel))
    expect(source, `${rel}: 未引共享实现`).toContain("from './image-budget.js'")
    const call = /projectRequestImage\(ref, \{([\s\S]{0,260}?)\}\)/.exec(source)
    expect(call, `${rel}: 未走共享投影`).not.toBeNull()
    expect(call![1], `${rel}: 没传像素预算`).toContain('pixelBudget')
    expect(call![1], `${rel}: 没传字节目标`).toContain('maxBytes')
    // ⚠️ 回退方向必须是「投影拿不到才读原图」，反了就等于永远发原图。
    expect(source, `${rel}: 回退顺序不对`).toMatch(/projected \?\? await readImage\(ref\)/)
  })

  /**
   * buddy 是**最早**接的一家，形状与上面四家不同：撞的是图片 token 预算，
   * 字节目标用共享默认的 2 MiB 即可（不传 `maxBytes` 是有意的）；
   * 回退写成 `if (projected !== undefined) { …; continue }` 而非 `??`。
   * 单列一条而不是塞进上面的循环，是为了让这两种形状**都**被显式锁住 ——
   * 否则将来有人"统一形状"时会不知不觉改掉语义。
   */
  it('buddy 走共享投影、传像素预算，并在拿不到时回退原图', () => {
    const source = codeOnly(read('src/buddy-adapter.ts'))
    expect(source).toContain("from './image-budget.js'")
    expect(source).toMatch(/projectRequestImage\(ref, \{[\s\S]{0,200}?pixelBudget[^}]*\}\)/)
    // ⚠️ buddy 的回退写成 `if (projected !== undefined) { …; continue }`
    // （它是最早接的一家，形状与另四家的 `??` 不同）。这里锁**本质**而非字面：
    // 投影必须先于读原图发生，且 readImage 路径必须还在（否则回退就断了）。
    const projectedAt = source.indexOf('await this.projectRequestImage(ref)')
    const readImageAt = source.indexOf('await this.options.readImage(ref)')
    expect(projectedAt, '未调用共享投影').toBeGreaterThan(-1)
    expect(readImageAt, '原图回退路径被删掉了').toBeGreaterThan(-1)
    expect(projectedAt, '投影必须排在读原图之前，反了就等于永远发原图')
      .toBeLessThan(readImageAt)
    expect(source).toContain('if (projected !== undefined)')
  })

  it('宿主侧为这五家都桥接了 readImageRequest', () => {
    const source = codeOnly(read('src/index.ts'))
    // buddy 与 workbuddy 各一处、raccoon / qoder / qodercn / lobsterai / cline 各一处。
    const bridges = source.match(/readImageRequest: makeReadImageRequest\(ctx\)/g) ?? []
    expect(bridges.length, `只桥接了 ${bridges.length} 处`).toBeGreaterThanOrEqual(5)
  })

  it('未接缩放的四家仍走原图路径（lobsterai 之外的 loomy / trae / loomy 不误接）', () => {
    // loomy 与 trae 本轮**没有**接：loomy 实测 24 张全过（无体积问题），
    // trae 的探测被「仅可见但不可调用」挡住、拿不到阈值。
    // 这条断言不是为了锁死它们不接，而是**防止误以为已经全接了**。
    for (const rel of ['src/loomy-adapter.ts', 'src/trae-adapter.ts']) {
      expect(codeOnly(read(rel)), `${rel}: 意外接入了缩放`).not.toContain('projectRequestImage')
    }
  })
})

describe('11115「请求过大」的分类不得依赖 extError 是否存在', () => {
  /** harness 的 `isContextWindowExceededError` 实测只认带 extError 的那一份。 */
  const WITH_EXT_ERROR = JSON.stringify({
    code: 11115,
    msg: 'prompt is too long: 100001 tokens > 100000 maximum',
    extError: { code: 'context_length_exceeded', type: 'invalid_request_error' },
  })
  /** issue 里被漏判的那条：同样的措辞，但没有 extError。 */
  const ONLY_MSG = JSON.stringify({
    code: 11115,
    msg: 'prompt is too long: 100001 tokens > 100000 maximum',
    displayMsg: { zh: '内容过长，请精简或新建任务' },
  })

  it.each([
    ['带 extError 的报文', WITH_EXT_ERROR],
    ['⚠️ 只有 msg + displayMsg（原先漏判的那条）', ONLY_MSG],
  ])('%s → CONTEXT_WINDOW_EXCEEDED', async (_name, bodyText) => {
    const { error } = await drive({
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      failWith: { status: 400, body: bodyText },
    })
    expect(error).toBeInstanceOf(LlmError)
    // 归错的代价不对称：`INVALID_REQUEST` 既不在 harness 的 DEFAULT_RETRYABLE_CODES
    // （[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]），也不触发溢出压缩
    // （`dsh-compaction-basic` 的 listener 第一行就 `if (code !== CONTEXT_WINDOW_EXCEEDED) return`）
    // → 会话每轮直接报废；而归成溢出最多让压缩白试一次。
    expect((error as LlmError).code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('无关的 400 仍归 INVALID_REQUEST（不能把所有 400 都说成溢出）', async () => {
    const { error } = await drive({
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      failWith: { status: 400, body: JSON.stringify({ code: 10001, msg: 'bad reasoning param' }) },
    })
    expect((error as LlmError).code).toBe('INVALID_REQUEST')
  })

  it('「too long」但没有 token 越界数字的文案不升级（判据必须窄）', async () => {
    const { error } = await drive({
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      failWith: { status: 400, body: 'prompt is too long' },
    })
    expect((error as LlmError).code).toBe('INVALID_REQUEST')
  })
})

describe('projectRequestImage：九个适配器共用的请求版本投影', () => {
  it('把像素预算与**字节目标**一起传给桥接（raccoon 靠后者对付 10MB 上限）', async () => {
    const seen: ImageRequestTarget[] = []
    const out = await projectRequestImage(
      { attachmentId: 'att', width: 2560, height: 1600 },
      {
        readImageRequest: async (_a, target) => {
          seen.push(target)
          return { data: new Uint8Array([1]), mediaType: 'image/jpeg' }
        },
        pixelBudget: 640_000,
        maxBytes: RACCOON_REQUEST_IMAGE_MAX_BYTES,
      },
    )
    expect(seen).toEqual([{
      width: 1011, height: 632, maxBytes: RACCOON_REQUEST_IMAGE_MAX_BYTES,
    }])
    expect(out?.mediaType).toBe('image/jpeg')
  })

  it('未桥接 / 缺尺寸 / 桥接抛错 → 一律返回 undefined（即发原图）', async () => {
    const attachment = { attachmentId: 'att', width: 2560, height: 1600 }
    expect(await projectRequestImage(attachment, { readImageRequest: undefined }))
      .toBeUndefined()
    expect(await projectRequestImage({ attachmentId: 'att' }, {
      readImageRequest: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
    })).toBeUndefined()
    expect(await projectRequestImage(attachment, {
      readImageRequest: () => { throw new Error('ATTACHMENT_PROJECTION_UNSUPPORTED') },
    })).toBeUndefined()
  })
})

describe('RaccoonAdapter：请求版本优先（该家按请求体字节设限）', () => {
  /** 跑一轮并抓回请求体；模型侧响应是什么不重要（探针只关心我们发了什么）。 */
  async function captureRaccoonBody(options: {
    readImageRequest?: (a: unknown, t: ImageRequestTarget) => Promise<
      { data: Uint8Array; mediaType: string } | undefined>
  }): Promise<{ body: string; targets: ImageRequestTarget[] }> {
    const targets: ImageRequestTarget[] = []
    let body = ''
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => ({
        access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
      }) as never,
      refresh: async () => {},
      readImage: async () => ({ data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }),
      ...(options.readImageRequest ? { readImageRequest: options.readImageRequest } : {}),
      product: RACCOON,
      fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
        body = String(init?.body ?? '')
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch,
    })
    try {
      for await (const _chunk of adapter.stream({
        provider: 'raccoon',
        // 兜底表里唯一「免费 + supportsImage: true」的一条（e2e 实测该家
        // 三个优先候选的图片能力都是 false 或不存在）。
        model: 'sn-sensenova-6-8-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', attachment: { attachmentId: 'att-1', width: 2560, height: 1600 } },
          ],
        }],
        signal: new AbortController().signal,
      } as never)) { /* noop */ }
    } catch { /* 响应格式不是本用例的关注点 */ }
    return { body, targets }
  }

  it('⚠️ 用**该家自己的** 512 KB 字节目标，而不是 buddy 的 2 MiB', async () => {
    // 实测该网关 `HTTP_413: request body exceeds 10MB`：两张 base64 后
    // ≈3.9 MB 的原图再加别的内容就可能被拒。字节目标是这里的主约束。
    const seen: ImageRequestTarget[] = []
    const { body } = await captureRaccoonBody({
      readImageRequest: async (_a, target) => {
        seen.push(target)
        return { data: new Uint8Array([9]), mediaType: 'image/jpeg' }
      },
    })
    expect(seen).toEqual([{
      width: 1011, height: 632, maxBytes: RACCOON_REQUEST_IMAGE_MAX_BYTES,
    }])
    expect(body).toContain('data:image/jpeg;base64')
    expect(body).not.toContain('data:image/png;base64,AQID')
  })

  it('桥接不可用时回退原图（不得让请求失败）', async () => {
    const { body } = await captureRaccoonBody({ readImageRequest: async () => undefined })
    expect(body).toContain('data:image/png;base64,AQID')
  })

  it('未配置桥接时保持既有行为（发原图）', async () => {
    const { body } = await captureRaccoonBody({})
    expect(body).toContain('data:image/png;base64,AQID')
  })
})
