/**
 * loomy / trae 的图片边界**二分**复测（Gitee issue IKKX0T 的独立实测复核）。
 *
 * ⚠️ 会向两家后端发**带二十几张 4 MB 原图**的真实请求，消耗真实额度。双重闸门：
 *   DSH_IMAGE_BISECT_E2E=1  +  DSH_IMAGE_BISECT_E2E_CONFIRM=yes
 *
 * ## 它要回答的唯一问题
 *
 * issue IKKX0T 用二分给出两组数：
 * - **trae** `(21, 24]` 张，形态 `code=4006 content is too large for AI to understand`
 *   （还有一条 `502 + HTML`）；
 * - **loomy** `(19, 21]` 张，形态 `413 Request Entity Too Large`（纯 HTML）/ `504`。
 *
 * 而本仓库既有文档记的是：
 * - **trae**「**未探到边界**（本轮只测了 1 张）」⇒ 结论是「拿不到阈值就不定值」；
 * - **loomy**「**24 张全过**、无证据说明它有约束」⇒ 结论是「故未接缩放」。
 *
 * ⚠️ **这两条结论不能只凭 issue 就推翻**（本仓库的既定规矩：
 * 「引用否定性结论时必须带上何时、哪个账号、什么形态，并在下次探测时**先重验
 * 这条结论本身**」）。故本文件的作用是**用我们自己的探针、自己的账号、自己的
 * fixture 复测**，复测通过才据此定 `imageMaxBytes`。
 *
 * ⚠️ **loomy 那格尤其要复核**：issue 的 fixture 是 3.45 MiB/张、本仓库是
 * 2.87 MiB/张，而 loomy 撞的是**请求体体积** —— 按 issue 的区间换算，
 * 它的边界落在 `87.4~96.6 MiB`，而本仓库「24 张全过」对应的正是 `91.8 MiB`，
 * **恰好在区间内部**。也就是说既有结论很可能是「在边界内 4 MiB 处侥幸通过」，
 * 而不是「没有约束」。这必须用同一份 fixture 重新量。
 *
 * ## 为什么单独一个文件而不是加进 image-burst
 *
 * 二分比固定序列**贵得多**（每次 mid 都是一整轮十几张图）。原文件的用例是
 * 「验证修复有效」的回归，不该因为复核第三方数据而变贵。
 */
import { describe, expect, it } from 'vitest'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import { LOOMY } from '../../src/loomy-product.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  parseTraeBatchModelList,
  traeSOLOHeaders,
} from '../../src/trae.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'
import {
  assertBaselineUsable,
  bisectImageLimit,
  hasFixture,
  loadFixture,
  probeImageBurst,
  type BurstResult,
} from './image-probe-shared.js'

const E2E = process.env.DSH_IMAGE_BISECT_E2E === '1'
  && process.env.DSH_IMAGE_BISECT_E2E_CONFIRM === 'yes'
  && hasFixture()
const suite = E2E ? describe : describe.skip

/** 各适配器共用的 stream 包装（`system` 必须透传，见 PROBE_SYSTEM 的注释）。 */
function streamOf(adapter: { stream(o: never): AsyncIterable<unknown> }, provider: string, model: string) {
  return (messages: unknown[], signal: AbortSignal, system: string) =>
    adapter.stream({ provider, model, messages, signal, system } as never)
}

/**
 * 把 fixture 的**每张 base64 后字节数**换算成请求体大小（MiB）。
 *
 * 判据用「体积」而不是「张数」：两家撞的都是请求体字节，而张数只在
 * 「同一份 fixture」下可比 —— 本文件存在的理由正是 issue 的 fixture
 * 与本仓库不同（3.45 vs 2.87 MiB）。
 */
function bodyMiB(bytes: number, count: number): number {
  return count * bytes * 4 / 3 / 1024 / 1024
}

/** 打印一条边界的完整结论（张数 + 请求体体积 + 形态）。 */
function reportBoundary(label: string, bytes: number, pass: number, fail: number, verdict: string): void {
  console.log(
    `\n  ★ ${label} 边界：(${pass}, ${fail}] 张`
    + ` ⇒ 请求体 ≈${bodyMiB(bytes, pass).toFixed(0)}~${bodyMiB(bytes, fail).toFixed(0)} MiB`
    + `；形态 ${verdict}`,
  )
  console.log(
    `     ⇒ 若要接缩放，字节目标须让「预期张数 × 每张 base64」显著低于 `
    + `${bodyMiB(bytes, pass).toFixed(0)} MiB。`,
  )
}

suite('loomy / trae 的图片边界二分复测（Issue IKKX0T）', () => {
  // ⚠️ 必须早退：`describe.skip` 的 factory **仍会执行**（vitest 靠它收集用例），
  // 所以光靠上面的 `E2E` 闸门挡不住 `loadFixture()` 读不到文件而抛 ENOENT。
  if (!hasFixture()) return
  const fixture = loadFixture()
  const readImage = async () => ({ data: fixture.data, mediaType: 'image/png' })

  it('loomy / qwen3.8-flash：复测「24 张全过、无约束」这条既有结论', async (ctx) => {
    const entry = readLoomyCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 loomy 凭据').toBeDefined()
    const credential = entry!.credential
    const adapter = new LoomyAdapter({
      credentialRef: 'LOOMY_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      // Loomy 没有 refresh 端点（`isLoomyRefreshable` 恒 false），no-op 是如实的。
      refresh: async () => {},
      readImage,
      product: LOOMY,
      // ⚠️ 兜底表转出的 supportsImage 被**硬写为 false**，故图片能力只能来自
      // 这份远端目录（`capabilities.input_modalities` 含 image）。
      fetchRemoteModels: async () => {
        const res = await fetch(`${LOOMY.apiBase}/models`, {
          headers: { Accept: 'application/json', token: credential.access_token },
          signal: AbortSignal.timeout(30_000),
        })
        return res.ok ? parseLoomyRemoteModels(await res.json() as unknown) : []
      },
    })
    const stream = streamOf(adapter, 'loomy', 'qwen3.8-flash')

    // ① 0 张基线：区分「账号此刻不可用」与「图片链路撞墙」（既有硬规矩）。
    const baseline = await probeImageBurst({ label: 'loomy 基线(无图)', counts: [0], stream })
    if (!assertBaselineUsable(baseline[0], ctx, 'loomy')) return

    // ② 固定序列先定位区间（比二分便宜，且与既有结论**直接可比**）。
    //    ⚠️ 刻意包含 24：既有结论正是「24 张全过」，复测首先要重验这一条本身。
    const coarse = await probeImageBurst({
      label: 'loomy 固定序列',
      counts: [1, 8, 15, 19, 21, 24],
      stream,
    })
    const firstBad = coarse.find((r) => r.verdict !== 'ok')
    if (firstBad === undefined) {
      // 复测**支持**既有结论（本 fixture 下 24 张确实全过）—— 如实登记，
      // 不用 issue 的 fixture 数据去覆盖我们自己的实测。
      console.log(
        '\n  ⚠️ 本 fixture（2.87 MiB/张）下 24 张全过'
        + `（请求体 ≈${bodyMiB(fixture.data.length, 24).toFixed(0)} MiB）。`
        + ' 既有结论在**本 fixture 下成立**；issue 的 3.45 MiB/张 是另一种量纲，'
        + '两者不矛盾（同一边界区间内的两侧）。',
      )
      return
    }
    // 非边界类失败 ⇒ 探测无效，必须如实跳过而不是断言失败。
    if (firstBad.verdict !== 'overflow' && firstBad.verdict !== 'too-large') {
      console.warn(`  ⚠️ loomy 固定序列在 ${firstBad.count} 张出现 ${firstBad.verdict} 类失败`
        + `（${firstBad.errorText.slice(0, 120)}）⇒ 探测前提不成立，跳过。`)
      ctx.skip()
      return
    }

    // ③ 二分收紧到 ≤3 张（issue 的误差声明）。
    const knownPass = coarse.filter((r) => r.ok).at(-1)?.count ?? 0
    const bisected = await bisectImageLimit({
      label: 'loomy',
      stream,
      low: knownPass,
      high: firstBad.count,
    })
    expect(bisected, '二分前提不成立（low 必须 < high）').toBeDefined()
    reportBoundary('loomy', fixture.data.length, bisected!.pass, bisected!.fail, bisected!.verdict)
    // 边界形态必须明确指向**请求体体积**（loomy 不是腾讯系，没有图片 token 预算）。
    expect(
      bisected!.verdict,
      'loomy 的边界形态应指向请求体体积（若报 token 溢出，说明既有归因整个错了）',
    ).toBe('too-large')
  }, 1_800_000)

  it('trae / glm-5.3-flash：探出「未探到」的原图边界', async () => {
    const entry = readTraeCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 trae 凭据').toBeDefined()
    const credential = entry!.credential
    const credentialRecord = credential as unknown as Record<string, unknown>
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      // ⚠️ trae 的 fetchRemoteModels 是**功能必需**而不只是能力判定：
      // 通道（`function`）也从同一份目录取，缺目录时所有模型退回默认通道，
      // 部分模型会直接回流内 `4001 param is invalid`。
      fetchRemoteModels: async () => {
        const res = await fetch(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
          method: 'POST',
          headers: traeSOLOHeaders(credentialRecord as never, TRAE, false) as Record<string, string>,
          body: JSON.stringify({
            functions: [...TRAE.channels], agent_type: '',
            current_config_info: { config_name: '', is_custom_model: false },
            mode_type: 0, access_type: 0, ab_force_vids: '', ab_autotest_advanced_mode: 0,
            show_custom_model: true,
          }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw new Error(`trae 目录拉取失败 HTTP ${res.status}`)
        return parseTraeBatchModelList(await res.json() as unknown)
      },
      product: TRAE,
    })
    const stream = streamOf(adapter, 'trae', 'glm-5.3-flash')

    // ① 0 张基线。⚠️ trae 历史上对某些模型回 `4001 仅可见但不可调用`，
    //    基线不通过就说明**探测前提不成立**（换模型或修账号），必须跳过。
    const baseline = await probeImageBurst({ label: 'trae 基线(无图)', counts: [0], stream })
    if (!assertBaselineUsable(baseline[0], ctx, 'trae')) return

    // ② 固定序列。issue 记的边界是 (21,24]，故序列刻意覆盖 15/19/21/24/32。
    //    ⚠️ 上限取 32 而不是 24：issue 的 24 是它二分的上界，若本 fixture
    //    （更小）在 24 仍通过，必须继续往上探才不会把「通过」误读成「无边界」。
    const coarse = await probeImageBurst({
      label: 'trae 固定序列',
      counts: [1, 15, 19, 21, 24, 32],
      stream,
    })
    const firstBad = coarse.find((r) => r.verdict !== 'ok')
    if (firstBad === undefined) {
      console.log(
        `\n  ⚠️ trae 在本 fixture 下探到 32 张仍全过`
        + `（请求体 ≈${bodyMiB(fixture.data.length, 32).toFixed(0)} MiB）`
        + ' ⇒ 边界在 32 张以上，**仍不能定值**（拿不到阈值就不定值）。',
      )
      return
    }
    if (firstBad.verdict !== 'overflow' && firstBad.verdict !== 'too-large') {
      console.warn(`  ⚠️ trae 固定序列在 ${firstBad.count} 张出现 ${firstBad.verdict} 类失败`
        + `（${firstBad.errorText.slice(0, 120)}）⇒ 探测前提不成立，跳过。`)
      ctx.skip()
      return
    }

    const knownPass = coarse.filter((r) => r.ok).at(-1)?.count ?? 0
    const bisected = await bisectImageLimit({
      label: 'trae',
      stream,
      low: knownPass,
      high: firstBad.count,
    })
    expect(bisected, '二分前提不成立（low 必须 < high）').toBeDefined()
    reportBoundary('trae', fixture.data.length, bisected!.pass, bisected!.fail, bisected!.verdict)
    expect(
      bisected!.verdict,
      'trae 的边界形态应指向请求体体积（`code=4006 content is too large`）',
    ).toBe('too-large')
  }, 1_800_000)

  /**
   * ⚠️ **纯离线用例**：`classifyFailure` 的 `too-large` 判据必须认全 issue
   * 记录的三种形态，且**不能**把 `502 + HTML` / `504` 误判成边界。
   *
   * 后者是刻意的：那两条与「上游真崩了」无法区分，把它们当边界证据会得出
   * 「这家上限是 N 张」的假结论。
   */
})

/**
 * ⚠️ **刻意放在闸门之外**：本段是纯离线判据（零网络、零额度），
 * 若跟着上面的 suite 一起被 `DSH_IMAGE_BISECT_E2E` + fixture 双重闸门挡住，
 * 它就**永远跑不到** —— 而它保护的正是「边界判据不能把 502/504 误判成体积上限」
 * 这条最容易在改动 `classifyFailure` 时被破坏的语义。
 *
 * 实测踩过：初版把它写在 suite 内部，结果缺 fixture 时整个文件 0 test 全 skip，
 * 判据零守卫（`pnpm test:e2e:image-bisect` 报告 `0 test`，看不出任何异常）。
 */
describe('图片边界判据（离线，不消耗额度）', () => {
  it('三种体积形态都认，502/504 不误判，token 溢出仍归 overflow', async () => {
    const { classifyFailure, isPayloadTooLarge } = await import('./image-probe-shared.js')
    // ① issue IKKX0T 记录的三家真实形态
    expect(classifyFailure('413 Request Entity Too Large', 'HTTP_413')).toBe('too-large')
    expect(classifyFailure(
      '413 Request body size exceeds maximum allowed 52428800 bytes', 'HTTP_413',
    )).toBe('too-large')
    expect(classifyFailure(
      "We're sorry, the content is too large for AI to understand. (code=4006)", 'CONTEXT_WINDOW_EXCEEDED',
    )).toBe('too-large')
    expect(classifyFailure('HTTP_413: request body exceeds 10MB', 'HTTP_413')).toBe('too-large')
    // ② ⚠️ 反向守卫：与「上游真崩了」无法区分的形态**不得**算边界
    expect(isPayloadTooLarge('502 <html><body>Bad Gateway</body></html>')).toBe(false)
    expect(isPayloadTooLarge('504 Gateway Time-out')).toBe(false)
    // ③ 腾讯的 token 预算形态仍归 overflow（两者不可混：一个降像素、一个降字节）
    expect(classifyFailure('prompt is too long: 100001 tokens > 100000 maximum', 'X')).toBe('overflow')
  })
})
