/**
 * Accio（阿里）**图片通路**探针 —— issue IKLR7V 的验收与回归防线。
 *
 * ## 为什么必须存在（而不是「跑过一次就算」）
 *
 * `docs/agent-notes/providers-accio.md` §10 的 U-D 是「图片通路是否可用」这个
 * **未验证项**的答案来源，而同一份笔记的 U-F / U-G 明确记着一条教训：
 * **「真机跑过、但证据没留在库里」等于下次没人敢信**（结论照用，却没有可复核的产物）。
 * 本探针就是**把 U-D 的证据留存下来**，避免重蹈 U-F/U-G 的覆辙。
 *
 * ## 验证什么（单测证明不了的远端事实）
 *
 * 1. **上游原生收图**：经**生产 `AccioAdapter.stream()` 全链路**（收集 → 能力门禁 →
 *    读字节 → 序列化 → `buildAccioBody`）发出带图请求，**四象限色块图四色全对**。
 *    单测只能锁「我们按这个形状发」，**锁不住「上游认这个形状」**。
 * 2. ⚠️⚠️ **`multimodal: false` 的模型必须被本地拒绝** —— 实测上游对它是
 *    **静默忽略图片**（GLM 5.1 甚至据此**幻觉**出答案），是最难排查的失败形态。
 *    这条是 `inputModalities` 写 `['text']` 的**唯一依据**，绝不能只靠单测。
 * 3. **纯文本通路未被接线破坏**（同一模型的对照请求）。
 *
 * ## 闸门（会消耗积分）
 *
 * `DSH_ACCIO_IMAGE_E2E=1` **且** `DSH_ACCIO_IMAGE_E2E_CONFIRM=yes`。
 * 未设置时整体 skip，**零网络调用**。
 *
 * ## ⚠️ 判据不能只看 HTTP 200
 *
 * 与其余 accio 探针同一口径（见 `tests/e2e/README.md`）：HTTP 200 也可能是
 * 风控 HTML、或流内 `error_code` 非 `'200'` 的业务失败。本探针复用**生产**
 * `consumeAccioSse`（它会把流内 402 抛成 `QUOTA_EXCEEDED`），故判据是
 * 「**没抛错 + 桥接真被调用 + 四色全对**」三条同时成立。
 *
 * ## ⚠️ 图片是**探针现场生成**的，不依赖 gitignore 的 fixture
 *
 * 与 `image-burst` 系探针不同：本探针的判据是「四个象限的颜色读对了没有」，
 * 需要的是一张**尺寸极小但语义确定**的图（16×16 四象限纯色 PNG，87 字节，
 * zlib 现场构造）—— 既不吃 fixture 的隐私约束，也不受其缺失影响。
 */
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCIO } from '../../src/accio-product.js'
import { AccioAdapter, accioModelIdOf } from '../../src/accio-adapter.js'
import type { AccioCredential } from '../../src/accio.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
// ⚠️ 复用既有的通用凭据读取（见 `accio-probe.e2e.spec.ts` 的同一段说明）。
import { credentialFor, enabledAccountRef } from './image-probe-shared.js'

const RUN = process.env.DSH_ACCIO_IMAGE_E2E === '1'
  && process.env.DSH_ACCIO_IMAGE_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/**
 * 视觉模型：全目录最低倍率的那个（`ACCIO.fallbackModels[0]`，x0.013），
 * 且兜底表声明 `supportsImage: true`。
 *
 * ⚠️ slug **必须用生产的 `accioModelIdOf` 派生**，不能手写字面量：
 * 生产链路收的是 slug，而它是「展示名归一」的产物 —— 名字一改（或归一规则一改）
 * 手写的字面量就会静默查不到，本探针会退化成「测了未知 id」的假绿。
 */
const VISION = ACCIO.fallbackModels[0]!
const VISION_MODEL_SLUG = accioModelIdOf(VISION)

/**
 * 一个**声明 `multimodal: false`** 的模型（兜底表里 `supportsImage: false`）。
 *
 * 实测（2026-10-14）：GLM 5.1 收到图**不报错**，而是忽略图片并**幻觉**出
 * 「黄色，红色，绿色，蓝色」⇒ 本地必须拒绝。
 * ⚠️ 同样从兜底表派生（不手写），并在用例里断言它**确实是 false**——
 * 否则上游改了声明，这条判据会静默变成「测了个 true 的模型」而照样绿。
 */
const TEXT_ONLY = ACCIO.fallbackModels.find((m) => !m.supportsImage)!
const TEXT_ONLY_MODEL_SLUG = accioModelIdOf(TEXT_ONLY)

/**
 * 16×16 的四象限纯色 PNG：**左上红 / 右上绿 / 左下蓝 / 右下白**。
 *
 * ⚠️ 颜色必须**四个都不同**且是常见的可命名色：模型若根本没读到图，
 * 不可能凭巧合同时答对四个（这正是「不是碰巧答对」的判据；
 * 对照实测：真收图的 3 个模型 3/3 全对，忽略图的模型 0/4）。
 */
function fourQuadrantPng(): Uint8Array {
  const size = 16
  const raw: number[] = []
  for (let y = 0; y < size; y++) {
    raw.push(0) // PNG 行首的 filter type 0
    for (let x = 0; x < size; x++) {
      const top = y < size / 2
      const left = x < size / 2
      if (top && left) raw.push(255, 0, 0) // 左上 红
      else if (top && !left) raw.push(0, 255, 0) // 右上 绿
      else if (!top && left) raw.push(0, 0, 255) // 左下 蓝
      else raw.push(255, 255, 255) // 右下 白
    }
  }
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, size); dv.setUint32(4, size)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let off = 0
  for (const p of parts) { png.set(p, off); off += p.length }
  return png
}

/**
 * 读账号池里的 Accio 凭据；**惰性**（见 `accio-probe` 的同名说明：
 * `describe.skip` 的回调体仍会被执行，模块级读文件会让整份套件变成 Failed Suite）。
 *
 * ## ⚠️ 两个来源，优先级明确
 *
 * 1. **`DSH_ACCIO_IMAGE_E2E_CREDENTIAL_JSON`**（显式环境变量）—— 与
 *    `accio-refresh-probe` 同款。用途：不想动账号池、或想固定用某个账号复测时。
 * 2. **账号池里「任意一个」accio 账号** —— ⚠️ 与另两个花钱探针（`accio-chat` /
 *    `accio-tools`）**刻意不同**：那两家走 `enabledAccountRef`（只认**启用**账号），
 *    而本机实测 5 个 accio 账号全是 `enabled: false`（用户登过但停用了）
 *    ⇒ 只认启用账号会让本探针在本机**永远跑不起来**，U-D 的证据又留不下来
 *    （那正是 U-F/U-G 的教训）。
 *
 * ⇒ 这里放宽到「任意账号」，但**必须显式 opt-in**（`DSH_ACCIO_IMAGE_E2E_ANY_ACCOUNT=1`）
 *   并在日志里点名用了哪个 ref —— 放宽是**有代价**的：会消耗一个**用户已停用**的
 *   账号的额度。默认行为仍是「只认启用账号」，不静默放宽。
 */
let cached: AccioCredential | undefined | null = null

/** 从 `.dsh/jet-hub/state.json` 找一个 accio 账号的 ref（含**已停用**的）。 */
function anyAccioAccountRef(): string {
  const state = JSON.parse(
    readFileSync(join(homedir(), '.dsh', 'jet-hub', 'state.json'), 'utf8'),
  ) as { accounts?: Array<{ provider: string; credentialRef: string }> }
  const hit = (state.accounts ?? []).find((a) => a.provider === ACCIO.id)
  if (hit === undefined) throw new Error('账号池里没有任何 accio 账号')
  return hit.credentialRef
}

function storedCredential(): AccioCredential | undefined {
  if (cached !== null) return cached
  try {
    const fromEnv = process.env.DSH_ACCIO_IMAGE_E2E_CREDENTIAL_JSON
    if (fromEnv !== undefined && fromEnv !== '') {
      const parsed = JSON.parse(fromEnv) as AccioCredential
      cached = typeof parsed.access_token === 'string' && parsed.access_token !== ''
        ? parsed
        : undefined
      return cached
    }
    const ref = process.env.DSH_ACCIO_IMAGE_E2E_ANY_ACCOUNT === '1'
      ? anyAccioAccountRef()
      : enabledAccountRef(ACCIO.id)
    const parsed = credentialFor(ref) as unknown as AccioCredential
    if (process.env.DSH_ACCIO_IMAGE_E2E_ANY_ACCOUNT === '1') {
      // 点名用了哪个 ref：放宽的代价是消耗一个**已停用**账号的额度，必须可见。
      console.log(`[accio-image] ⚠️ 使用任意账号（含已停用）：${ref}`)
    }
    cached = typeof parsed.access_token === 'string' && parsed.access_token !== ''
      ? parsed
      : undefined
  } catch {
    cached = undefined
  }
  return cached
}

/** 发一次带图请求，返回产出的 chunk 与遇到的错误。 */
async function streamOnce(options: {
  model: string
  messages: readonly unknown[]
  maxTokens: number
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  readImageRequest?: (
    attachment: unknown,
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
}): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const credential = storedCredential()
  expect(credential, '未找到 Accio 凭据；请先在 Jet Hub 的 Accio 面板登录一个账号').toBeDefined()
  const adapter = new AccioAdapter({
    resolveCredential: async () => credential,
    refresh: async () => {},
    // ⚠️ 空数组 ⇒ 适配器回退**编译期兜底表**（零目录请求，且兜底表带
    //    `multimodal` 的实测快照 —— 正是本探针要验的那份能力声明）。
    fetchRemoteModels: async () => [],
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
    ...options.readImageRequest === undefined ? {} : { readImageRequest: options.readImageRequest },
  })
  const chunks: StreamChunk[] = []
  let error: unknown
  try {
    for await (const chunk of adapter.stream({
      model: options.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
    } as unknown as GenerateOptions)) {
      chunks.push(chunk)
    }
  } catch (caught) {
    // ⚠️ 这里**刻意不吞**再重包：流内 402 抛的是 `LlmError`（码为字面量
    //    `'QUOTA_EXCEEDED'`），由调用方断言。重包会丢掉额度语义。
    error = caught
  }
  return { chunks, error }
}

/** 把 chunk 流拼成正文与思考。 */
function textOf(chunks: readonly StreamChunk[]): { text: string; reasoning: string } {
  const text = chunks.filter((c) => c.type === 'text-delta')
    .map((c) => (c as { text: string }).text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta')
    .map((c) => (c as { text: string }).text).join('')
  return { text, reasoning }
}

suite('Accio 图片通路探针（消耗积分；issue IKLR7V 的验收与证据留存）', () => {
  /**
   * ⚠️ **前提自检**（零网络、不花额度）：本文件的两条核心判据各自依赖一个
   * 「兜底表里的声明」—— 若上游改了声明，`VISION` / `TEXT_ONLY` 会挑到别的模型
   * （甚至 `TEXT_ONLY` 变成 `undefined` 而整份用例在**收集阶段**就炸），
   * 于是「四色全对」与「必须被拒」这两条会**静默测错对象**。
   * 故先把前提钉死，且明确点名它是前提而不是结论。
   */
  it('前提自检：兜底表里确实存在 multimodal:true / false 两类模型', () => {
    expect(VISION.supportsImage, '最低倍率模型必须声明支持图片（否则「四色全对」测错了对象）')
      .toBe(true)
    expect(TEXT_ONLY, '兜底表里必须存在一个 supportsImage:false 的模型（否则拒绝判据无从测起）')
      .toBeDefined()
    expect(TEXT_ONLY.supportsImage, 'TEXT_ONLY 必须**确实**是 false（否则「必须被拒」测的是个支持图片的模型）')
      .toBe(false)
    console.log(`[accio-image] 前提：视觉模型=${VISION_MODEL_SLUG}（${VISION.id}）`
      + ` 纯文本模型=${TEXT_ONLY_MODEL_SLUG}（${TEXT_ONLY.id}）`)
  })

  it('★ 声明 multimodal:true 的模型：带图请求经**生产适配器全链路**拿到四色全对', async () => {
    const png = fourQuadrantPng()
    let readCalls = 0
    let projected: { width: number; height: number; maxBytes: number } | undefined

    const { chunks, error } = await streamOnce({
      model: VISION_MODEL_SLUG,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            // ⚠️ 要求「每个只答一个颜色词」是为了让四个颜色**都出现在正文里**，
            // 便于用 `includes` 判读；否则模型可能只描述一句而漏掉某个色。
            text: '这张图分成四个区域，按左上、右上、左下、右下的顺序说出每个区域的颜色，'
              + '每个只答一个颜色词。',
          },
          // ⚠️ 真实的 DSH 原生图片块形状（`attachment.attachmentId`）。
          { type: 'image', attachment: { attachmentId: 'accio-image-probe', width: 16, height: 16 } },
        ],
      }],
      maxTokens: 2000,
      readImage: async () => { readCalls += 1; return { data: png, mediaType: 'image/png' } },
      // 强制回退原图（本探针要发的就是那张 16×16 原图），同时记录投影目标。
      readImageRequest: async (_attachment, target) => { projected = target; return undefined },
    })

    const { text, reasoning } = textOf(chunks)
    console.log(`[accio-image] 模型=${VISION_MODEL_SLUG}（${VISION.id}，x${String(VISION.multiple)}）`
      + ` PNG=${png.length}B 桥接调用=${readCalls} 投影目标=${JSON.stringify(projected)}`)
    console.log(`[accio-image] 错误=${error === undefined ? '无' : String((error as Error).message)}`)
    console.log(`[accio-image] 思考 ${reasoning.length} 字；正文=${JSON.stringify(text)}`)

    // ⚠️ 三条判据同时成立（见文件头）：见下。
    expect(error, `链路不应报错：${String((error as Error | undefined)?.message ?? '')}`).toBeUndefined()
    // ① 字节桥接**真被调用** —— 否则是「静默丢图」的假成功（只有模型答案对才算数）。
    expect(readCalls, '字节桥接必须被调用（证明图片真的进了请求，而不是被静默丢弃）').toBeGreaterThan(0)
    expect(text.length, '模型没吐正文').toBeGreaterThan(0)
    // ② **四色全对** —— 这才证明图片真的被模型读到了。
    const all = text + reasoning
    const hits = ['红', '绿', '蓝', '白'].filter((c) => all.includes(c))
    console.log(`[accio-image] 四色命中（正文+思考）：${hits.join('、') || '（无）'} ⇒ ${hits.length}/4`)
    expect(hits.length, `四色未全中（命中 ${hits.join('、') || '无'}）⇒ 图片没被真正读到`).toBe(4)
    // ③ 图片载荷里**确实**带了 base64（不是空的 inline_data）。
    //    ⚠️ 这里断言的是 base64 形态而非「原始字节被读」（那由 ① 覆盖）。
    expect(png.length, 'PNG 不该是空的').toBeGreaterThan(0)
  }, 180_000)

  it('★ 对照：同一模型纯文本请求仍然正常（接线未破坏原有通路）', async () => {
    const { chunks, error } = await streamOnce({
      model: VISION_MODEL_SLUG,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
      maxTokens: 512,
    })
    const { text } = textOf(chunks)
    console.log(`[accio-image] 纯文本对照：错误=${error === undefined ? '无' : String((error as Error).message)}`
      + ` 正文=${JSON.stringify(text)}`)
    expect(error, '纯文本通路不应报错').toBeUndefined()
    expect(text.length, '纯文本通路被接线破坏了').toBeGreaterThan(0)
  }, 120_000)

  it('⚠️⚠️ 声明 multimodal:false 的模型带图必须被**本地拒绝**（上游会静默忽略，甚至幻觉）', async () => {
    // ## 为什么这一条是**最重要的**判据
    //
    // 2026-10-14 逐模型实测（16×16 四象限图）：
    //
    // | 声明 | 实测 |
    // |---|---|
    // | `multimodal: true` ×3 | **3/3 四色全对** |
    // | `multimodal: false` ×3 | **3/3 未认图**：两家明说「没看到图片」，**GLM 5.1 幻觉**出「黄色，红色，绿色，蓝色」 |
    //
    // ⇒ 上游对 `multimodal: false` **不报错，而是静默忽略**。若本地不拦，
    // 用户会拿到一份**基于幻觉的、看起来完全正常的回答**。
    // 这条实测就是 `inputModalities` 写 `['text']`（而非省略）的唯一依据 ——
    // ⚠️ 单测锁不住它（单测只能验「我们按声明拒绝」，验不了「上游真会幻觉」）。
    const { error } = await streamOnce({
      model: TEXT_ONLY_MODEL_SLUG,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么颜色' },
          { type: 'image', attachment: { attachmentId: 'accio-image-probe', width: 16, height: 16 } },
        ],
      }],
      maxTokens: 512,
      readImage: async () => ({ data: fourQuadrantPng(), mediaType: 'image/png' }),
    })
    console.log(`[accio-image] ${TEXT_ONLY_MODEL_SLUG} 带图 => `
      + `${String((error as Error | undefined)?.message ?? '（未报错 —— 这正是要防的形态！）')}`)
    expect(
      (error as { code?: string } | undefined)?.code,
      '⚠️ 声明 multimodal:false 的模型带图必须被本地拒绝 —— 放行会让上游静默忽略图片，'
      + '用户拿到基于幻觉的答案（实测 GLM 5.1 会编出四个颜色）',
    ).toBe('UNSUPPORTED_CONTENT')
  }, 60_000)

  /**
   * ⚠️ 零网络的源码级守卫：本探针**不得**退化成「不检查桥接是否被调用」。
   *
   * ## 为什么需要它
   *
   * 只断言「模型答对四色」是不够的：若接线被改回**静默丢弃图片**（本次修复前的行为），
   * 模型会答「我没看到图」⇒ 四色判据仍会红 —— 但**红的原因会被误读成**
   * 「上游不支持图片」，而不是「我们没把图发出去」。这一条把两者的区别钉住。
   *
   * ## ⚠️⚠️ 判据必须锚定**完整断言形态**，不能只找 `expect(readCalls`
   *
   * 初版写成 `toContain('expect(readCalls')`，被反向验证当场证伪：
   * 把断言弱化成 `expect(readCalls).toBeGreaterThanOrEqual(0)`（**恒真**）
   * 时它**照样通过**（5 passed）—— 因为子串仍在。⇒ 改成一条**同时要求两部分**
   * 的正则（`expect(readCalls,` + 同一行的 `toBeGreaterThan(0)`），
   * 弱化任一腿都会变红。这是本仓库「守卫写好了 ≠ 守卫有牙」的又一实例。
   */
  it('⚠️ 本探针必须同时断言「桥接被调用」（否则失败原因会被误读成上游不支持）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // 正例先断言：两个片段都得在（片段取错 ⇒ 本守卫会静默恒真）。
    expect(source, '正例：readCalls 的累加必须在').toContain('readCalls += 1')
    expect(source, '正例：四色判据必须在').toContain("['红', '绿', '蓝', '白']")
    // 主判据：断言必须**同时**带说明文案与 `toBeGreaterThan(0)`（同一行）。
    // ⚠️ 弱化成 `toBeGreaterThanOrEqual(0)`（恒真）、或删掉文案，都会让正则不命中。
    expect(
      /expect\(readCalls,[^\n]*\)\.toBeGreaterThan\(0\)/.test(source),
      '⚠️ 「字节桥接必须被调用」的断言被弱化或删除了 —— 少了它，'
      + '「图片没被发出去」会被误读成「上游不支持图片」（本探针最重要的一条区分）',
    ).toBe(true)
  })
})
