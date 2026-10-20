/**
 * 跨 provider 的图片 token 上限探测（issue !IKITT9 的普遍性）。
 *
 * ⚠️ 会向多家后端发**带十几张大图**的真实请求。双重闸门：
 *   DSH_IMAGE_BURST_E2E=1  +  DSH_IMAGE_BURST_E2E_CONFIRM=yes
 *
 * ## 它要回答的唯一问题
 *
 * 「单次请求图片视觉 token ≈100,000」是**腾讯网关特有**，还是各家普遍如此？
 *
 * 这个问题必须回答，因为它决定要不要把像素预算接到其余七个适配器上 ——
 * 而预算值**不能拿 buddy 的 640,000 当全局常量**（各家上限不同、
 * 计价比例也不同，猜错就是把用户的截图糊掉或照样撞墙）。
 * 所以本探针**只发原图**：拿到的是各家真实的撞墙张数，不掺任何缩放。
 *
 * ## 为什么只挑免费模型
 *
 * 一次探测要发 15–32 张 4.1M px 的图 ≈ 10 万输入 token。用付费模型跑这个
 * 属于拿真实余额买一个「大概能猜到」的答案。因此本文件只覆盖
 * **免费额度**的模型；付费的（trae / lobsterai / loomy / codearts）
 * 需要单独确认后再加，见 tests/e2e/README.md。
 *
 * ## 三条构造上的坑（都由只读调查确认）
 *
 * - **cline**：`stream()` 不会自己暖模型目录，而图片能力只读 `remoteModels`
 *   → 不先 `resolveModel()` 一次，带图请求必然被误判成「模型不支持图片」。
 * - **qoder**：走 WASM 加密端点，凭据缺 `uid` 直接 `MISSING_CREDENTIAL`。
 * - **raccoon**：用户候选里的三个模型（deepseek-v4.1-flash / glm-5.3-flash /
 *   qwen3.8-flash）在它家**要么声明不支持图片、要么目录里根本没有**，
 *   因此这里用它家唯一「免费 + 声明 supportsImage」的 `sn-sensenova-6-8-flash`。
 *   探测上限要的是网关行为，换模型不影响结论。
 */
import { describe, expect, it } from 'vitest'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import {
  QODER_REFRESH_PATH,
  applyQoderRefresh,
  isQoderExpired,
  parseQoderTokenPayload,
  qoderRefreshBody,
  type QoderCredential,
} from '../../src/qoder.js'
import { ClineAdapter } from '../../src/cline-adapter.js'
import { CLINE } from '../../src/cline-product.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { RACCOON } from '../../src/raccoon-product.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'
import { readClineCredentialsFromDshStore } from './cline-credential.js'
import { readRaccoonCredentialsFromDshStore } from './raccoon-credential.js'
import { hasFixture, loadFixture, makeScaleBridge, probeImageBurst } from './image-probe-shared.js'
import {
  LobsteraiAdapter,
  buildLobsteraiModelsUrl,
  parseLobsteraiModels,
} from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { lobsteraiModelsHeaders } from '../../src/lobsterai.js'
import { readLobsteraiCredentialsFromDshStore } from './lobsterai-credential.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  parseTraeBatchModelList,
  traeSOLOHeaders,
} from '../../src/trae.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import { LOOMY } from '../../src/loomy-product.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'
import {
  assertBaselineUsable,
  credentialFor,
  enabledAccountRef,
  hasFixture,
  loadFixture,
  makeScaleBridge,
  probeImageBurst,
} from './image-probe-shared.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

// fixture 不入库（真人截图含隐私），缺文件时整体跳过而不是报错。
const E2E = process.env.DSH_IMAGE_BURST_E2E === '1'
  && process.env.DSH_IMAGE_BURST_E2E_CONFIRM === 'yes'
  && hasFixture()
const suite = E2E ? describe : describe.skip

/**
 * 各适配器共用的 stream 包装（provider 名不同，其余一致）。
 *
 * ⚠️ `system` 必须透传：WorkBuddy 网关要求 `messages[0]` 是 system，
 * 否则回 400 + 11128 且伪装成「安全策略拦截」（见 PROBE_SYSTEM 的注释）。
 */
function streamOf(adapter: { stream(o: never): AsyncIterable<unknown> }, provider: string, model: string) {
  return (messages: unknown[], signal: AbortSignal, system: string) =>
    adapter.stream({ provider, model, messages, signal, system } as never)
}

/**
 * 取一个「此刻真能发请求」的 qoder 凭据。
 *
 * ⚠️ **先看是否过期，别一上来就续期** —— 这是我第一版探针的真实 bug：
 * 它强制 `renewQoder()` 成功才肯用该账号，于是**刚登录的新号反被跳过**
 * （新凭据的 refresh_token 可能因一次性轮换/设备绑定而回 401），
 * 最终落到一个 access_token 还能签请求、但**当日额度已耗尽**的旧号上，
 * 把「探测做不了」误报成「网关没有图片上限」。
 *
 * ⚠️ 还必须**用一次真实请求验号**：`Billing daily count exceeded` 只有
 * 发出去才知道，而池里多个账号的额度状态各不相同。跳过受限的号才能
 * 拿到有意义的上限数据（`resolveCredential` 是可变的，验中哪个就用哪个）。
 *
 * @param verify 发一次**无图**请求；返回 true 表示该账号此刻可用。
 */
async function freshQoderCredential(
  verify: (credential: QoderCredential) => Promise<boolean>,
): Promise<QoderCredential | undefined> {
  for (const entry of readQoderCredentialsFromDshStore()) {
    const label = (entry as { credentialRef?: string }).credentialRef ?? '?'
    let credential = entry.credential
    // 加密推理依赖 uid（缺了适配器直接抛 MISSING_CREDENTIAL），先挡掉。
    if (!credential.uid) { console.log(`  账号 ${label} 缺 uid，跳过`); continue }
    if (isQoderExpired(credential)) {
      try {
        credential = await renewQoder(credential)
      } catch (error) {
        console.log(`  账号 ${label} 已过期且续期失败：${String(error).slice(0, 120)}`)
        continue
      }
    }
    let usable = false
    try {
      usable = await verify(credential)
    } catch (error) {
      console.log(`  账号 ${label} 验证异常：${String(error).slice(0, 120)}`)
      continue
    }
    if (!usable) { console.log(`  账号 ${label} 此刻不可用（额度/风控），换下一个`); continue }
    console.log(`  采用账号 ${label}`)
    return credential
  }
  return undefined
}

async function renewQoder(credential: QoderCredential): Promise<QoderCredential> {
  const res = await fetch(`${QODER.openApiBase}${QODER_REFRESH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `${QODER.userAgentPrefix}/1.0.0`,
    },
    body: JSON.stringify(qoderRefreshBody(credential)),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`续期被拒 HTTP ${res.status}`)
  const payload = parseQoderTokenPayload(await res.json() as unknown)
  if (payload === undefined) throw new Error('续期响应无法解析')
  return applyQoderRefresh(credential, payload)
}

suite('跨 provider 图片 token 上限探测（原图直发）', () => {
  // ⚠️ 必须早退：`describe.skip` 的 factory **仍会执行**（vitest 靠它收集用例），
  // 所以光靠上面的 `E2E` 闸门挡不住 `loadFixture()` 读不到文件而抛 ENOENT。
  if (!hasFixture()) return
  const fixture = loadFixture()
  const readImage = async () => ({ data: fixture.data, mediaType: 'image/png' })

  it('qoder / qfmodel（Qwen3.8-Flash，免费额度）', async () => {
    // 用户指定：新加的账号没有付费积分，只能用免费档的 `qfmodel`
    //（`priceFactor: 0`、`supportsImage: true`）。
    // ⚠️ 探针不传 accountPool，所以池里那条 qfmodel 的限流标记不影响这里。
    let credential: QoderCredential | undefined

    /** 用一次**无图**请求验号：能拿到正文才算这个号此刻真可用。 */
    const verify = async (candidate: QoderCredential): Promise<boolean> => {
      credential = candidate
      const result = await probeImageBurst({
        label: 'qoder 验号',
        counts: [0],
        prompt: '只回答 OK。',
        timeoutMs: 120_000,
        stream: streamOf(buildQoderAdapter(), 'qoder', 'qfmodel'),
      })
      return result[0]?.ok === true
    }

    function buildQoderAdapter(): QoderAdapter {
      return new QoderAdapter({
        credentialRef: 'QODER_ACCESS_TOKEN' as never,
        resolveCredential: async () => credential,
        // 探测中途过期时**真续期**（no-op 会让鉴权失败被误读成图片撞墙）。
        refresh: async () => {
          if (credential !== undefined && !isQoderExpired(credential)) return
          const next = credential === undefined ? undefined : await renewQoder(credential)
          if (next !== undefined) credential = next
        },
        readImage,
        // 缩放桥接（生产实现）：本轮要验证的是「接了像素预算之后，
        // 张数能不能越过上一轮实测的原图边界」。
        readImageRequest: makeScaleBridge(fixture).bridge,
        product: QODER,
      })
    }

    const chosen = await freshQoderCredential(verify)
    expect(chosen, '全部 qoder 账号此刻都不可用（过期 / 日额度耗尽），无法探测')
      .toBeDefined()
    credential = chosen

    // 上一轮实测**原图**边界：8 张过、15 张（≈57 MiB）`TRANSPORT`。
    // 这里只测缩放后能否越过它 —— 原图数据已有，重跑只是白耗额度。
    const scaled = await probeImageBurst({
      label: 'qoder 缩放后',
      counts: [1, 15, 24],
      stream: streamOf(buildQoderAdapter(), 'qoder', 'qfmodel'),
    })
    expect(scaled.find((r) => r.verdict !== 'ok'), '缩放后仍被拒').toBeUndefined()
    expect(scaled.at(-1)!.count).toBeGreaterThanOrEqual(24)
  }, 900_000)

  /**
   * ⚠️ 模型原为 `cline-free/deepseek-v4.1-flash`，2026-10-05 被上游下架
   * （移出远端 `free` 数组、直连回 `404 {"error":"model not found"}`），
   * 沿用会让本用例暖目录后拿到「模型不在目录中」而失败。
   * 改用仍在册的 `cline-free/mimo-v2.6-flash`（实测支持图片、HTTP 200）。
   */
  const CLINE_IMAGE_MODEL = 'cline-free/mimo-v2.6-flash'

  it('cline / cline-free/mimo-v2.6-flash（免费）', async (ctx) => {
    const entry = readClineCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 cline 凭据').toBeDefined()
    const credential = entry!.credential
    expect(credential.access_token.startsWith('workos:'), 'Cline 的 token 必须带 workos: 前缀')
      .toBe(true)
    const adapter = new ClineAdapter({
      credentialRef: 'CLINE_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      readImageRequest: makeScaleBridge(fixture).bridge,
      product: CLINE,
    })
    // ⚠️ 必须先暖目录：ClineAdapter.stream() 不调 ensureRemoteModels()，
    // 而图片能力只查 remoteModels —— 不暖就会被误判成「模型不支持图片」。
    await adapter.resolveModel('cline', CLINE_IMAGE_MODEL)
    // 上一轮实测**原图**：24 张（≈159K 图片 token）全过、32 张（≈122 MiB）才
    // `TRANSPORT` —— 该家没有腾讯那道图片 token 预算，卡的是请求体体积。
    // 缩放后测到 32 张仍过即证明修复有效（且顺带确认原图的 32 张失败是体积）。
    //
    // ⚠️ **0 张基线必须留着**：该家是**免费日额度**制，实测会回
    // `429 Daily free limit reached on model … Try again in 20h 2m`。
    // 少了基线，这种「账号今天没额度了」会被记成「缩放后仍被拒」——
    // 白排查一轮产品代码。基线一条请求几乎不花额度，却能把两者彻底分开。
    const baseline = await probeImageBurst({
      label: 'cline 基线(无图)',
      counts: [0],
      stream: streamOf(adapter, 'cline', CLINE_IMAGE_MODEL),
    })
    if (!assertBaselineUsable(baseline[0], ctx, 'cline')) return
    const scaled = await probeImageBurst({
      label: 'cline 缩放后',
      counts: [1, 32],
      stream: streamOf(adapter, 'cline', CLINE_IMAGE_MODEL),
    })
    expect(scaled.find((r) => r.verdict !== 'ok'), '缩放后仍被拒').toBeUndefined()
  }, 900_000)

  it('lobsterai / deepseek-flash（远端 id，展示名即 DeepSeek-V4.1-Flash）', async (ctx) => {
    const entry = readLobsteraiCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 lobsterai 凭据').toBeDefined()
    const credential = entry!.credential
    const version = LOBSTERAI.fallbackClientVersion
    const adapter = new LobsteraiAdapter({
      credentialRef: 'LOBSTERAI_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      readImageRequest: makeScaleBridge(fixture).bridge,
      product: LOBSTERAI,
      // ⚠️ 该家的图片能力**只来自远端 meta**（`inputModalitiesFor` 读
      // remoteMeta.supportsImage）。不给 fetchRemoteModels，带图请求会被
      // 误判成「模型不支持图片」—— 而它的错误码与「没桥接附件服务」
      // 同为 UNSUPPORTED_CONTENT，只能靠 message 区分。
      fetchRemoteModels: async () => {
        const res = await fetch(buildLobsteraiModelsUrl(LOBSTERAI, credential, version), {
          headers: lobsteraiModelsHeaders(credential, LOBSTERAI, version),
          signal: AbortSignal.timeout(30_000),
        })
        return res.ok ? parseLobsteraiModels(await res.json() as unknown) : []
      },
    })
    // 上一轮实测**原图**边界：12 张过、13 张（≈50 MiB）回
    // `SERVER code=500 服务器内部错误`。500 **不是**准入报文（腾讯会明确回
    // `prompt is too long: N tokens > M maximum`），所以它是体积压垮了上游，
    // 不能当成「图片 token 预算」。这里只测缩放后能否越过 13 张。
    // 基线（0 张）留着：它不花图片额度，却能把「账号不可用」与「图片链路坏了」
    // 分开（见 assertBaselineUsable 的注释）。
    const baseline = await probeImageBurst({
      label: 'lobsterai 基线(无图)',
      counts: [0],
      stream: streamOf(adapter, 'lobsterai', 'deepseek-flash'),
    })
    if (!assertBaselineUsable(baseline[0], ctx, 'lobsterai')) return
    const scaled = await probeImageBurst({
      label: 'lobsterai 缩放后',
      counts: [1, 13, 24],
      stream: streamOf(adapter, 'lobsterai', 'deepseek-flash'),
    })
    expect(scaled.find((r) => r.verdict !== 'ok'), '缩放后仍被拒').toBeUndefined()
    expect(scaled.at(-1)!.count).toBeGreaterThanOrEqual(24)
  }, 900_000)

  it('trae / glm-5.3-flash', async () => {
    // 用户指定的三个候选里，`deepseek-v4.1-flash` 实测一发图就回
    // `4001 param is invalid`（无图基线正常）—— 适配器给的诊断是
    // 「仅可见但不可调用」。故换同目录里 `multimodal:true` +
    // `function:solo_agent` 的 `glm-5.3-flash`。
    const entry = readTraeCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 trae 凭据').toBeDefined()
    const credential = entry!.credential
    const credentialRecord = credential as unknown as Record<string, unknown>
    const scale = makeScaleBridge(fixture)
    const build = (withScale: boolean) => new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      ...(withScale ? { readImageRequest: scale.bridge } : {}),
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
    // ⚠️ **上一轮的结论已被本轮推翻，别再照着旧结论判断**：上一轮该账号对
    // `deepseek-v4.1-flash` 与 `glm-5.3-flash` 都回 `4001 param is invalid`
    //（适配器诊断「仅可见但不可调用」），于是登记成「探测无效」。
    // 本轮同一账号、同一模型，原图 1 张直接成功 —— 说明那时是**账号/服务端
    // 的临时状态**，不是模型的固有属性。这正是 AGENTS.md 反复强调的
    //「某次实测没看到不能推广成不存在」（与 Qoder「无签到」那次同型）。
    const raw = await probeImageBurst({
      label: 'trae 原图',
      counts: [1],
      stream: streamOf(build(false), 'trae', 'glm-5.3-flash'),
    })
    scale.stats.length = 0
    const scaled = await probeImageBurst({
      label: 'trae 缩放后',
      stream: streamOf(build(true), 'trae', 'glm-5.3-flash'),
    })
    // ⚠️ trae **未接**缩放（生产代码里没接 `readImageRequest`），所以这里
    // 传入桥接只是**探索性**的：它证明「缩放对 trae 也无害且有用」，
    // 不证明生产链路已生效。要真接还得先探测出它的边界在哪 ——
    // 本轮 24 张原图没测（只测了 1 张），**边界仍未知**，故不能凭这组就定值。
    expect(raw[0]?.ok, `trae 原图 1 张仍失败（可能又回到 4001）：${raw[0]?.errorText.slice(0, 120)}`)
      .toBe(true)
    expect(scaled.find((r) => r.verdict !== 'ok'), 'trae 缩放后出现失败').toBeUndefined()
    console.log(`  trae 缩放桥接被调用 ${scale.stats.length} 次（探索性，生产未接）`)
  }, 900_000)

  it('loomy / qwen3.8-flash', async () => {
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
      // ⚠️ 兜底表转出的 supportsImage 被**硬写为 false**，所以图片能力
      // 只能来自这份远端目录（`capabilities.input_modalities` 含 image）。
      fetchRemoteModels: async () => {
        const res = await fetch(`${LOOMY.apiBase}/models`, {
          headers: { Accept: 'application/json', token: credential.access_token },
          signal: AbortSignal.timeout(30_000),
        })
        return res.ok ? parseLoomyRemoteModels(await res.json() as unknown) : []
      },
    })
    await probeImageBurst({
      label: 'loomy/qwen3.8-flash',
      stream: streamOf(adapter, 'loomy', 'qwen3.8-flash'),
    })
  }, 900_000)

  /**
   * 腾讯系两站的对照验证（issue 报告的就是这两个面板）。
   *
   * ⚠️ 两站共用同一个 `BuddyAdapter` 类，所以「buddy 过了」**推不出**
   * workbuddy 也过 —— 产品配置（endpoint / 倍率 / 模型池）不同，
   * 而本用例要证明的正是「同一套预算在两站都有效」。
   * 这里同时覆盖 `buddy-adapter.ts` 改用共享 `projectRequestImage` 之后的形状
   * （之前那次 e2e 通过是在重构**之前**跑的）。
   *
   * 判据刻意分两层：
   * - 原图组必须报 `overflow`（`prompt is too long: N tokens > M maximum`）——
   *   这是腾讯**独有**的形态，别家撞的是体积（见 README 的实测表）；
   * - 缩放组必须全过，且发出的字节显著变小。
   */
  it.each([
    { name: 'buddy', product: CODEBUDDY, model: 'deepseek-v4.1-flash' },
    { name: 'workbuddy', product: WORKBUDDY, model: 'deepseek-v4.1-flash' },
  ])('$name：原图 15 张报图片 token 上限，缩放后同张数通过', async ({ name, product, model }) => {
    const refName = enabledAccountRef(name)
    const credential = credentialFor(refName) as unknown as BuddyCredential
    // 缩放桥接**只建一次**并复用：`stats` 会跨组累积，每轮探测的产出都记在这里。
    const scale = makeScaleBridge(fixture)
    const build = (withScale: boolean) => new BuddyAdapter({
      credentialRef: refName as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      ...(withScale ? { readImageRequest: scale.bridge } : {}),
      product,
    })

    const raw = await probeImageBurst({
      label: `${name} 原图`,
      counts: [15],
      stream: streamOf(build(false), name, model),
    })
    scale.stats.length = 0
    const scaled = await probeImageBurst({
      label: `${name} 缩放后`,
      counts: [15],
      stream: streamOf(build(true), name, model),
    })
    // ⚠️ buddy 才断言边界数值与错误码：那是**实测**出来的
    //（15 张报 `prompt is too long: 100001 tokens > 100000 maximum`）。
    // 归错成 INVALID_REQUEST 的代价是不对称的 —— 那个码既不在 harness 的
    // 可重试集合、也不触发溢出压缩（`dsh-compaction-basic` 只认
    // CONTEXT_WINDOW_EXCEEDED），会话每轮直接报废。
    if (name === 'buddy') {
      expect(raw[0]?.code, '腾讯的图片 token 溢出被归错码 → 既不重试也不压缩')
        .toBe('CONTEXT_WINDOW_EXCEEDED')
      expect(raw[0]?.errorText).toMatch(/prompt is too long.*tokens.*maximum/i)
    }

    // ⚠️ 这里**不断言** workbuddy 也在 15 张报 `overflow`：buddy 的那个数值是
    // 实测出来的，workbuddy 走的是另一个 endpoint（www.workbuddy.ai），
    // 上限是否同值**未验证** —— 把 buddy 的数字当全局常量推给它，正是
    // AGENTS.md 反复告诫的形状。所以只锁两站都必然成立的那一条：
    // **缩放后同张数必须通过，且每张确实被缩到预算内**（= 修复有效）。
    // 原图组的结果只作观测打印，供人工比对两站边界是否一致。
    console.log(`  ${name} 原图 15 张：${raw[0]?.verdict}`
      + ` ${(raw[0]?.errorText ?? '').slice(0, 100)}`)
    expect(scaled[0]?.ok, `${name} 缩放后仍失败：${scaled[0]?.errorText.slice(0, 160)}`)
      .toBe(true)
    // 字节变小与否看**缩放桥接自己的产出**（`stats`），不去嗅探请求体：
    // 适配器在构造时就捕获了 fetch 引用，事后 patch `globalThis.fetch`
    // 是静默空测（本轮实测到那样做恒得 0，差点被误读成产品缺陷）。
    expect(scale.stats, '缩放桥接一次都没被调用 → 适配器没走请求版本').toHaveLength(15)
    const rawBytes = fixture.data.length
    const scaledBytes = scale.stats[0]!.outBytes
    for (const stat of scale.stats) {
      expect(stat.target.width * stat.target.height, '目标尺寸超出像素预算')
        .toBeLessThanOrEqual(640_000)
    }
    console.log(`  ${name}: 每张 ${rawBytes / 1024 / 1024} → ${(scaledBytes / 1024 / 1024).toFixed(2)} MiB`
      + `（${scale.stats[0]!.size}），15 张合计请求体`
      + ` ≈${(15 * rawBytes * 4 / 3 / 1024 / 1024).toFixed(0)} → `
      + `${(15 * scaledBytes * 4 / 3 / 1024 / 1024).toFixed(1)} MiB`)
    expect(scaledBytes, '缩放后字节没变小 → target 没生效').toBeLessThan(rawBytes / 4)

    // ⚠️ 这条才是 640,000 px 预算的**正当性来源**：不撞墙不能靠把图糊掉换来。
    // fixture 是浏览器截图，地址栏写着 cn.bing.com —— 缩到 1011×632 后
    // 模型若还答得出，说明 UI 小字档位可用。
    const legible = await probeImageBurst({
      label: `${name} 可辨认性`,
      counts: [1],
      prompt: '这张网页截图的浏览器地址栏里是什么域名？只回答域名本身。',
      stream: streamOf(build(true), name, model),
    })
    expect(legible[0]?.ok, `${name} 可辨认性探测失败`).toBe(true)
    expect(legible[0]!.answer.toLowerCase(), '缩到预算尺寸后模型读不出地址栏 → 预算过小')
      .toContain('bing')
  }, 900_000)

  it('raccoon / sn-sensenova-6-8-flash（免费；该家唯一声明图片能力的免费模型）', async () => {
    const entry = readRaccoonCredentialsFromDshStore()[0]
    expect(entry, '账号池里没有 raccoon 凭据').toBeDefined()
    const credential = entry!.credential
    // 诊断：`X-Org-Code` 取 `credential.office_identity`，缺则传空串，
    // 服务端回 `200003 authorization_verify_error`（与 401 同级、属终态）。
    // 实测本机这个账号的基线请求（**不带图**）就是该错误 —— 所以它压根
    // 没走到图片这一步。只打印字段名，不打印值。
    console.log(`  raccoon 凭据字段：${Object.keys(credential).join(', ')}`)
    if (credential.office_identity === undefined) {
      console.log('  ⚠️ 缺 office_identity ⇒ X-Org-Code 为空，服务端必拒（200003）。'
        + '这是**账号身份问题**，需要在 Jet Hub 重新登录该账号，与图片链路无关。')
    }
    // 缩放桥接只建一次并复用（`stats` 跨组累积）。
    const scale = makeScaleBridge(fixture)
    const build = (withScale: boolean) => new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      readImage,
      ...(withScale ? { readImageRequest: scale.bridge } : {}),
      product: RACCOON,
    })

    // 对照两组：同一张图、同一张数序列，只切换「发原图 / 发请求版本」。
    // 这才回答「方案 A 到底有没有把 413 消掉」——只看一组会自证。
    const raw = await probeImageBurst({
      label: 'raccoon 原图',
      stream: streamOf(build(false), 'raccoon', 'sn-sensenova-6-8-flash'),
    })
    scale.stats.length = 0
    const scaled = await probeImageBurst({
      label: 'raccoon 缩放后',
      stream: streamOf(build(true), 'raccoon', 'sn-sensenova-6-8-flash'),
    })

    // ⚠️ **先证明缩放真被调用了**，再断言结果。少了这一步，接线错误
    //（例如误把 `makeScaleBridge(fixture)` 这个包装对象当函数传进去）会被
    // `projectRequestImage` 的 try/catch 兜成「回退原图」，于是症状是
    // **缩放后照样 413** —— 看起来像字节目标定小了，实际是根本没缩放。
    // 本轮真踩到：raccoon 的缩放组报 413，排查后是注入点漏改成 `.bridge`。
    expect(scale.stats.length, '缩放桥接没被调用 → 适配器没走请求版本（接线错了？）')
      .toBeGreaterThan(0)
    const maxTargetBytes = Math.max(...scale.stats.map((s) => s.target.maxBytes))
    console.log(`  缩放桥接被调用 ${scale.stats.length} 次；`
      + `目标 ${scale.stats[0]!.size}，字节上限 ${(maxTargetBytes / 1024).toFixed(0)} KiB，`
      + `实际产出 ${(scale.stats[0]!.outBytes / 1024).toFixed(0)} KiB`)
    // raccoon 的硬限是 10 MB，故它的字节目标必须显著小于别家（512 KB）。
    expect(maxTargetBytes, 'raccoon 必须用自己的 512 KB 字节目标').toBeLessThanOrEqual(600 * 1024)

    const rawBad = raw.find((r) => r.verdict !== 'ok')
    const scaledBad = scaled.find((r) => r.verdict !== 'ok')
    console.log(`\n  原图：最远到 ${raw.at(-1)?.count} 张，首个异常 ${rawBad?.count ?? '无'}`
      + `（${rawBad?.verdict ?? '-'} ${rawBad?.errorText.slice(0, 90) ?? ''}）`)
    console.log(`  缩放后：最远到 ${scaled.at(-1)?.count} 张，首个异常 ${scaledBad?.count ?? '无'}`
      + `（${scaledBad?.verdict ?? '-'} ${scaledBad?.errorText.slice(0, 90) ?? ''}）`)
    // ⚠️ 断言只押在**缩放组**上：原图组的失败形态受网络影响（实测同一份
    // 请求一次报 `HTTP_413 request body exceeds 10MB`、一次报 timeout），
    // 拿它当对照基准会让用例时红时绿。真正的硬证据是「缩放后整条序列全过」
    // —— 上一轮已独立实测原图 4 张必 413，两组合起来才是完整结论。
    expect(scaledBad, `缩放后仍被拒：${scaledBad?.errorText.slice(0, 160)}`).toBeUndefined()
    // 每张都真的被缩到了字节目标内（否则 24 张不可能过 10MB）。
    expect(scaled.at(-1)!.count).toBeGreaterThanOrEqual(24)
  }, 900_000)
})
