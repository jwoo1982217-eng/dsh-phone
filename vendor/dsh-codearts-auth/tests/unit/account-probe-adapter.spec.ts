/**
 * 遗留缺陷回归测试：`account-probe` 的适配器选择必须按**产品配置**判定。
 *
 * 原始实现只判断 `entry.provider === 'buddy'`，于是 `workbuddy` 账号落入
 * else 分支、被交给 `CodeArtsAdapter`（华为云 HMAC 签名 + 错误端点）去发
 * WorkBuddy 凭据，探测必然失败。本文件用被 mock 的 BuddyAdapter 验证：
 * buddy 与 workbuddy 都走 BuddyAdapter，且各自带上自己的 product 配置。
 *
 * 注意：BuddyAdapter 被替换为桩（不发任何网络请求），CodeArtsAdapter 保持
 * 真实但**在本文件内不会被构造** —— 若缺陷复发，workbuddy 分支会构造真实
 * CodeArtsAdapter 并发起网络请求，测试随即失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ProbePool } from '../../src/account-probe.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * ⚠️ **Task 8 起：适配器的构造改由能力注册表提供**（`src/index.ts` 导出的
 * `probeById`），不再由 `account-probe.ts` 内部 `else if` 链分派。
 *
 * ⇒ 本文件必须在每个用例前把**真实的 `probeById`** 注册进 runtime，
 * 否则 `adapterForProbe` 会（正确地）抛「不支持重测」。
 *
 * ⚠️ 复用生产的那张表而**不是**在测试里重写一份：本文件的价值正是断言
 * 「生产把哪个适配器交给了哪个 provider」—— 重写一份会让它测的是测试自己。
 */
beforeEach(async () => {
  const [{ probeById }, { registerProviderRuntime, clearProviderRuntimes }, { descriptorOf }] =
    await Promise.all([
      import('../../src/index.js'),
      import('../../src/provider-runtime.js'),
      import('../../src/provider-registry.js'),
    ])
  clearProviderRuntimes()
  for (const [id, probe] of Object.entries(probeById)) {
    const descriptor = descriptorOf(id)
    if (descriptor !== undefined) registerProviderRuntime({ descriptor, probe })
  }
})

afterEach(async () => {
  const { clearProviderRuntimes } = await import('../../src/provider-runtime.js')
  clearProviderRuntimes()
})

vi.mock('../../src/buddy-adapter.js', () => {
  /** 记录被构造的选项与每次 `stream()` 的入参；流式请求一律以限流错误结束（不发网络请求）。 */
  class MockBuddyAdapter {
    static readonly instances: Array<{ product?: { id: string; productCode: string } }> = []
    /** 每次 `stream()` 收到的 GenerateOptions（用于断言探测请求的形状）。 */
    static readonly streamOptions: Array<{ system?: string; messages?: unknown }> = []
    constructor(options: { product?: { id: string; productCode: string } }) {
      MockBuddyAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(options: { system?: string; messages?: unknown }): AsyncGenerator<never> {
      MockBuddyAdapter.streamOptions.push(options)
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { BuddyAdapter: MockBuddyAdapter }
})

vi.mock('../../src/trae-adapter.js', () => {
  /** 同款桩：只记录构造与 `stream()` 入参，不发网络请求。 */
  class MockTraeAdapter {
    static readonly instances: Array<{ product?: { id: string } }> = []
    static readonly streamOptions: Array<{ system?: string; messages?: unknown }> = []
    constructor(options: { product?: { id: string } }) {
      MockTraeAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(options: { system?: string; messages?: unknown }): AsyncGenerator<never> {
      MockTraeAdapter.streamOptions.push(options)
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { TraeAdapter: MockTraeAdapter }
})

vi.mock('../../src/qoder-adapter.js', () => {
  /**
   * Qoder 的桩：记录构造与 `stream()` 入参。
   *
   * ⚠️ 这里**不用真实适配器**（与下面 Cline 那条用例的取舍不同）：Qoder 的推理
   * 请求必须由内嵌 WASM 生成加密体与签名头（`src/qoder-wasm.ts`），单测里跑不通
   * 真实链路，故只能以「构造了哪个适配器、带了哪份产品配置」作为判据。
   */
  class MockQoderAdapter {
    static readonly instances: Array<{ product?: { id: string; encryptedInferBase: string } }> = []
    static readonly streamOptions: Array<{ system?: string; messages?: unknown }> = []
    constructor(options: { product?: { id: string; encryptedInferBase: string } }) {
      MockQoderAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(options: { system?: string; messages?: unknown }): AsyncGenerator<never> {
      MockQoderAdapter.streamOptions.push(options)
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { QoderAdapter: MockQoderAdapter }
})

vi.mock('../../src/zcode-adapter.js', () => {
  /**
   * ZCode 的桩。
   *
   * 与 Qoder 同理：真实推理链路要跑内嵌的 captcha 与（首次请求时的）浏览器，
   * 单测里跑不通，故判据取「构造了哪个适配器 + 带了哪份产品配置」。
   */
  class MockZcodeAdapter {
    static readonly instances: Array<{ product?: { id: string } }> = []
    constructor(options: { product?: { id: string } }) {
      MockZcodeAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { ZcodeAdapter: MockZcodeAdapter }
})

vi.mock('../../src/gemini-adapter.js', () => {
  /**
   * Gemini 的桩。
   *
   * 与 Qoder / ZCode 同理：真实推理链路要带 Google OAuth 凭据打 Cloud Code
   * 上游，单测里跑不通，故判据取「构造了哪个适配器 + 带了哪份产品配置」。
   *
   * ⚠️ 这也是**唯一**能在单测里守住「gemini 没落进 else 分支」的地方：落进
   * else 意味着拿 Google 的 Bearer 令牌去让 `CodeArtsAdapter` 做华为云
   * SDK-HMAC-SHA256 签名，请求必然失败，且用户看到的是无法归因的报错。
   */
  class MockGeminiAdapter {
    static readonly instances: Array<{ product?: { id: string } }> = []
    constructor(options: { product?: { id: string } }) {
      MockGeminiAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { GeminiAdapter: MockGeminiAdapter }
})

/**
 * `CodeArtsAdapter` 换成桩，但保留 `isRateLimited` 等**真实导出**。
 *
 * 理由：本文件要验证「非 codearts 的 provider **不会**落入 CodeArtsAdapter 分支」。
 * 若保持真实实现，缺陷复发时它会真的向华为云端点发请求（慢且不稳定），
 * 而桩可让「走错分支」这一事实以**构造记录**直接暴露。
 */
vi.mock('../../src/llm-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm-adapter.js')>()
  class MockCodeArtsAdapter {
    static readonly instances: unknown[] = []
    constructor(options: unknown) {
      MockCodeArtsAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { ...actual, CodeArtsAdapter: MockCodeArtsAdapter }
})

/**
 * Loomy / Raccoon 的桩（2026-10-08 复审补齐 —— 此前本文件对这两家**零覆盖**）。
 *
 * ⚠️ **它们是第 5 次同型缺陷的事主**：旧 `else if` 链里**没有** loomy / raccoon
 * 的分支 ⇒ 两者落入 `else`，被交给「华为云 HMAC 签名」的 `CodeArtsAdapter`
 * 去发讯飞 / 商汤的凭据 —— 探测必然失败，而它们的限流标记（UTC+8 当日 24:00）
 * **永远清不掉**（症状只是「重测按钮点了没用」）。
 *
 * ⚠️ 桩的形状必须带 `credentialRef` / `product`：生产里 `createProbeAdapter`
 * 就是传这四个字段（见 `index.ts` 的 `probeById`），本文件的价值正在于断言
 * 「生产把哪个适配器交给了哪个 provider」。
 */
vi.mock('../../src/loomy-adapter.js', () => {
  class MockLoomyAdapter {
    static readonly instances: Array<{ product?: { id: string }; credentialRef?: string }> = []
    constructor(options: { product?: { id: string }; credentialRef?: string }) {
      MockLoomyAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { LoomyAdapter: MockLoomyAdapter, registerLoomyLlm: () => {}, parseLoomyRemoteModels: () => [] }
})

vi.mock('../../src/raccoon-adapter.js', () => {
  class MockRaccoonAdapter {
    static readonly instances: Array<{ product?: { id: string }; credentialRef?: string }> = []
    constructor(options: { product?: { id: string }; credentialRef?: string }) {
      MockRaccoonAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { RaccoonAdapter: MockRaccoonAdapter, registerRaccoonLlm: () => {} }
})

/**
 * minimax 的桩（2026-10-11 补齐 —— 它此前**不在** `probeById` 里，
 * 因为适配器零写点 ⇒ 没有可清的标记；issue IKJW32 接上请求级换号 + 冷却后
 * 它会写 `modelRateLimits`，于是必须登记）。
 *
 * ⚠️ 与 loomy / raccoon 的桩同一条理由：**刚补的那一家最容易成为新的零覆盖**
 *（「覆盖了当时**所有**登记的家、恰恰漏了出事的那 1 家」是 false coverage 的典型形状）。
 * ⚠️ 桩的形状必须带 `credentialRef` / `product` —— 生产里 `createProbeAdapter`
 * 就是传这几个字段（见 `index.ts` 的 `probeById`）。
 */
vi.mock('../../src/minimax-adapter.js', () => {
  class MockMinimaxAdapter {
    static readonly instances: Array<{ product?: { id: string }; credentialRef?: string }> = []
    constructor(options: { product?: { id: string }; credentialRef?: string }) {
      MockMinimaxAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { MinimaxAdapter: MockMinimaxAdapter, registerMinimaxLlm: () => {} }
})

/** 取 mock 的构造记录。 */
async function adapterInstances(): Promise<Array<{ product?: { id: string; productCode: string } }>> {
  const mod = await import('../../src/buddy-adapter.js') as unknown as {
    BuddyAdapter: { instances: Array<{ product?: { id: string; productCode: string } }> }
  }
  return mod.BuddyAdapter.instances
}

/** 取 mock 收到的 `stream()` 入参记录。 */
async function streamOptions(): Promise<Array<{ system?: string; messages?: unknown }>> {
  const mod = await import('../../src/buddy-adapter.js') as unknown as {
    BuddyAdapter: { streamOptions: Array<{ system?: string; messages?: unknown }> }
  }
  return mod.BuddyAdapter.streamOptions
}

/** 取 TRAE 桩的构造记录。 */
async function traeInstances(): Promise<Array<{ product?: { id: string } }>> {
  const mod = await import('../../src/trae-adapter.js') as unknown as {
    TraeAdapter: { instances: Array<{ product?: { id: string } }> }
  }
  return mod.TraeAdapter.instances
}

/** 取 TRAE 桩收到的 `stream()` 入参记录。 */
async function traeStreamOptions(): Promise<Array<{ system?: string; messages?: unknown }>> {
  const mod = await import('../../src/trae-adapter.js') as unknown as {
    TraeAdapter: { streamOptions: Array<{ system?: string; messages?: unknown }> }
  }
  return mod.TraeAdapter.streamOptions
}

/** 取 CodeArts 桩的构造记录（用于断言「没有走错分支」）。 */
async function codeartsInstances(): Promise<unknown[]> {
  const mod = await import('../../src/llm-adapter.js') as unknown as {
    CodeArtsAdapter: { instances: unknown[] }
  }
  return mod.CodeArtsAdapter.instances
}

/** 取 Qoder 桩的构造记录。 */
async function qoderInstances(): Promise<Array<{ product?: { id: string; encryptedInferBase: string } }>> {
  const mod = await import('../../src/qoder-adapter.js') as unknown as {
    QoderAdapter: { instances: Array<{ product?: { id: string; encryptedInferBase: string } }> }
  }
  return mod.QoderAdapter.instances
}

/** 取 ZCode 桩的构造记录。 */
async function zcodeInstances(): Promise<Array<{ product?: { id: string } }>> {
  const mod = await import('../../src/zcode-adapter.js') as unknown as {
    ZcodeAdapter: { instances: Array<{ product?: { id: string } }> }
  }
  return mod.ZcodeAdapter.instances
}

/** 取 Gemini 桩的构造记录。 */
async function geminiInstances(): Promise<Array<{ product?: { id: string } }>> {
  const mod = await import('../../src/gemini-adapter.js') as unknown as {
    GeminiAdapter: { instances: Array<{ product?: { id: string } }> }
  }
  return mod.GeminiAdapter.instances
}

/** 取 Loomy 桩的构造记录。 */
async function loomyInstances(): Promise<Array<{ product?: { id: string }; credentialRef?: string }>> {
  const mod = await import('../../src/loomy-adapter.js') as unknown as {
    LoomyAdapter: { instances: Array<{ product?: { id: string }; credentialRef?: string }> }
  }
  return mod.LoomyAdapter.instances
}

/** 取 Raccoon 桩的构造记录。 */
async function raccoonInstances(): Promise<Array<{ product?: { id: string }; credentialRef?: string }>> {
  const mod = await import('../../src/raccoon-adapter.js') as unknown as {
    RaccoonAdapter: { instances: Array<{ product?: { id: string }; credentialRef?: string }> }
  }
  return mod.RaccoonAdapter.instances
}

/** 取 minimax 桩的构造记录。 */
async function minimaxInstances(): Promise<Array<{ product?: { id: string }; credentialRef?: string }>> {
  const mod = await import('../../src/minimax-adapter.js') as unknown as {
    MinimaxAdapter: { instances: Array<{ product?: { id: string }; credentialRef?: string }> }
  }
  return mod.MinimaxAdapter.instances
}

/**
 * 桩掉全局 `fetch` 并记录每次调用的 URL 与 init。
 *
 * 用途：**Cline 那条用例用真实 `ClineAdapter`**（它只需一次普通 HTTPS 请求，
 * 单测里能跑通），从而可以断言「请求实际发往哪个 host、带的是哪一族请求头」——
 * 这比「构造了哪个类」更贴近缺陷本身（用华为云 HMAC 签名去发 Cline 凭据）。
 *
 * ⚠️ 探测路径构造适配器时**不注入** `fetchImpl`，故适配器取的是全局 `fetch`，
 * 必须在 `retestAccount` 之前把它替换掉，否则用例会真的发网络请求。
 */
function stubFetch(): Array<{ url: string; headers: Record<string, string> }> {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    // 一律回 429：探测的结论是「仍受限」，但关键在于是**谁**把请求发到了**哪里**。
    return new Response('{"error":"rate limit exceeded"}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

function makeEntry(overrides: Partial<ProviderAccountEntry>): ProviderAccountEntry {
  return {
    id: 'wb-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_TEST',
    createdAt: 1,
    refreshable: true,
    modelRateLimits: { 'deepseek-v4.1-flash': Date.now() + 3_600_000 },
    ...overrides,
  }
}

/** 只实现探测路径用到的方法。 */
function makePool(entries: ProviderAccountEntry[]): ProbePool {
  const accounts = new Map(entries.map(e => [e.id, e]))
  return {
    findAccount: (id) => accounts.get(id),
    listAccountsByProvider: (provider) => [...accounts.values()].filter(a => a.provider === provider),
    async resolveCredentialForAccount() {
      return { access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z' }
    },
    async clearModelRateLimits() { return 0 },
  }
}

describe('account-probe 适配器选择按产品判定', () => {
  beforeEach(async () => {
    ;(await adapterInstances()).length = 0
    ;(await streamOptions()).length = 0
    ;(await traeInstances()).length = 0
    ;(await traeStreamOptions()).length = 0
    ;(await codeartsInstances()).length = 0
  })

  it('workbuddy 账号走 BuddyAdapter 并携带 WorkBuddy 产品配置', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    const result = await retestAccount(makePool([makeEntry({})]), 'wb-1')

    // 仍受限（桩抛限流错误），但关键在于是**由 BuddyAdapter** 发起的
    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const instances = await adapterInstances()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.product?.id).toBe('workbuddy')
    expect(instances[0]?.product?.productCode).toBe('workbuddy')
  })

  it('buddy 账号仍走 BuddyAdapter 且携带 CodeBuddy 产品配置', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'buddy-1',
      provider: 'buddy',
      credentialRef: 'BUDDY_ACCOUNT_TEST',
    })]), 'buddy-1')

    const instances = await adapterInstances()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.product?.id).toBe('buddy')
    expect(instances[0]?.product?.productCode).toBe('codebuddy')
  })
})

/**
 * 回归：**TRAE 账号的探测必须走 `TraeAdapter`**，不能落入 CodeArts 分支。
 *
 * ## 真实缺陷（与 workbuddy 的历史缺陷同型，2026-09-25 排查时发现）
 *
 * `probeWithAdapter` 的适配器分派依次判定 `productById`（CodeBuddy 系）与
 * `lobsteraiProductById`（LobsterAI），**两者都不含 trae**，于是 TRAE 账号
 * 落入 `else` → 构造 `CodeArtsAdapter`，用**华为云 SDK-HMAC-SHA256 签名**
 * 去发 TRAE 凭据到华为云端点。
 *
 * 实测（`productById('trae')` / `lobsteraiProductById('trae')` 均为 `undefined`）：
 * 请求必然失败，用户在 TRAE 面板点「重测」只会得到与真实限流无关的报错，
 * 重测功能对 TRAE **恒不可用** —— 正是本文件开头记录的 workbuddy 缺陷
 * （`provider === 'buddy'` 判据漏掉 workbuddy）的翻版：**分派表没跟上新增 provider**。
 *
 * ⚠️ 教训：新增 provider 时必须同步 `probeWithAdapter` 的分派分支。判据是
 * 「该 provider 会不会写 `modelRateLimits`」（写了才会有重测按钮）。
 */
describe('account-probe 适配器选择 · TRAE 不得落入 CodeArts 分支', () => {
  beforeEach(async () => {
    ;(await adapterInstances()).length = 0
    ;(await streamOptions()).length = 0
    ;(await traeInstances()).length = 0
    ;(await traeStreamOptions()).length = 0
    ;(await codeartsInstances()).length = 0
  })

  it('trae 账号走 TraeAdapter，而不是 CodeArtsAdapter', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    const result = await retestAccount(makePool([makeEntry({
      id: 'trae-1',
      provider: 'trae',
      credentialRef: 'TRAE_ACCOUNT_TEST',
    })]), 'trae-1')

    // 仍受限（桩抛限流错误），但关键在于是**由 TraeAdapter** 发起的
    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const trae = await traeInstances()
    expect(trae).toHaveLength(1)
    // 刻意**不传** product：TRAE 只有一个产品，TraeAdapter 内部默认用 `TRAE`
    // 常量（与 buddy/lobsterai 需要按 provider 查表不同）。故这里断言
    // 「未显式指定 product」这一既定契约，而不是断言它等于 'trae'。
    expect(trae[0]?.product).toBeUndefined()
    // 核心断言：**没有**构造 CodeArtsAdapter（否则就是用华为云签名发 TRAE 请求）。
    expect(await codeartsInstances()).toHaveLength(0)
  })

  it('trae 探测请求同样带 system（与其它 provider 判据一致）', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'trae-2',
      provider: 'trae',
      credentialRef: 'TRAE_ACCOUNT_TEST',
    })]), 'trae-2')

    const calls = await traeStreamOptions()
    expect(calls).toHaveLength(1)
    expect(typeof calls[0]?.system).toBe('string')
    expect((calls[0]!.system as string).length).toBeGreaterThan(0)
  })

  it('codearts 账号仍然走 CodeArtsAdapter（分派没有被改坏）', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'ca-1',
      provider: 'codearts',
      credentialRef: 'CODEARTS_ACCOUNT_TEST',
    })]), 'ca-1')

    expect(await codeartsInstances()).toHaveLength(1)
    expect(await traeInstances()).toHaveLength(0)
    expect(await adapterInstances()).toHaveLength(0)
  })
})

/**
 * 回归：**Qoder 系（qoder / qodercn）与 Cline 不得落入 CodeArts 分支**。
 *
 * ## 真实缺陷（本分派表第三次复发）
 *
 * 前两次是 `workbuddy` 与 `trae`（见上文两节）。补上 trae 之后，分支里仍缺
 * `qoder` / `qodercn` / `cline` —— 三者一路落到 `else`，被交给
 * `CodeArtsAdapter`（华为云 `SDK-HMAC-SHA256` 签名 + 华为云端点）去发
 * Qoder / Cline 的凭据，探测**必然失败**。
 *
 * 与 workbuddy / trae 那两次不同的是，这三个 provider 的失败是**用户可见
 * 且必然触发**的：
 *
 * - `RATE_LIMIT_CAPABILITIES` 对未登记的 provider **默认视为有限流**（刻意的，
 *   避免新增 provider 时凭空丢掉按钮），故它们的「重测 / 重置」按钮**确实会渲染**；
 * - 且 Qoder 的额度受限**每次都会**写 `modelRateLimits`（按 UTC+8 当日 24:00
 *   标记该模型），于是「点了重测 → 报签名错误 → 标记还在」成为稳定可复现的死循环。
 *
 * ⚠️ 这三个 provider 的查表函数**本来就存在**（`qoderProductById` 一份覆盖
 * 国际版与 CN、`clineProductById`），只是没被接上 —— 与 trae「压根没有查表
 * 函数、只能按 provider id 特判」不同，所以修复只需接线，不需要新增数据。
 *
 * ## ⚠️ 同型第 4 次：**zcode**（本次一并补上）
 *
 * 补 qoder / qodercn / cline 时**又漏了 zcode**，而它与 Qoder 完全同款：
 * `src/zcode-adapter.ts` 的 `switchAccountOnQuota()` 也调
 * `pool.updateModelRateLimit(..., nextUtc8DayStartMs())`（UTC+8 当日 24:00 标记）。
 *
 * 当时没被发现的原因值得记住：**那个写入点是在本分支建立之后才进 master 的**，
 * 而本节此前没有 zcode 的对应用例 ⇒ 这个漏项在 CI 上是**静默通过**的
 * （合并到 master 后全量单测仍然全绿）。
 *
 * ⇒ 故本节覆盖到 zcode；`src/account-probe.ts` 里同时写下了机械核对方式
 * （`grep -n 'updateModelRateLimit(' src/*.ts`），避免第五次。
 */
describe('account-probe 适配器选择 · qoder / qodercn / cline / zcode 不得落入 CodeArts 分支', () => {
  beforeEach(async () => {
    ;(await adapterInstances()).length = 0
    ;(await streamOptions()).length = 0
    ;(await traeInstances()).length = 0
    ;(await traeStreamOptions()).length = 0
    ;(await codeartsInstances()).length = 0
    ;(await qoderInstances()).length = 0
    ;(await zcodeInstances()).length = 0
    ;(await geminiInstances()).length = 0
    ;(await loomyInstances()).length = 0
    ;(await raccoonInstances()).length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * 断言里带上「产品配置指向哪个 host」：Qoder 国际版与 CN **共用同一个适配器类**，
   * 只断言「构造了 QoderAdapter」无法发现「两站配置接反」——那会让请求打到错的
   * 区域端点（`api2.qoder.sh` ↔ `gateway.qoder.com.cn`）。
   */
  it.each([
    { provider: 'qoder', credentialRef: 'QODER_ACCOUNT_TEST', expectedHost: 'api2.qoder.sh' },
    { provider: 'qodercn', credentialRef: 'QODERCN_ACCOUNT_TEST', expectedHost: 'gateway.qoder.com.cn' },
  ])('$provider 账号走 QoderAdapter 而非 CodeArtsAdapter，且产品指向 $expectedHost', async ({ provider, credentialRef, expectedHost }) => {
    // 即便缺陷复发（错误地走了真实 CodeArts 链路）也不该发出真实网络请求 ——
    // CodeArtsAdapter 已被上面的 vi.mock 换成桩，这里再兜一层。
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const id = `${provider}-1`
    const result = await retestAccount(makePool([makeEntry({ id, provider, credentialRef })]), id)

    // 仍受限（桩抛限流错误），但关键在于是**由 QoderAdapter** 发起的
    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const qoder = await qoderInstances()
    expect(qoder).toHaveLength(1)
    expect(qoder[0]?.product?.id).toBe(provider)
    expect(new URL(qoder[0]!.product!.encryptedInferBase).host).toBe(expectedHost)
    // 核心断言：**没有**构造 CodeArtsAdapter（否则就是用华为云签名发 Qoder 请求）。
    expect(await codeartsInstances()).toHaveLength(0)
    // 桩适配器在构造后立刻抛错，故不该有任何真实请求发出。
    expect(calls).toHaveLength(0)
  })

  /**
   * Cline 这条用**真实 `ClineAdapter`**（只把全局 `fetch` 换掉），直接断言
   * 「请求发往哪里、带哪一族头」—— 这正是缺陷的判据：
   * 缺陷下请求会带着 `Authorization: SDK-HMAC-SHA256 …` 去华为云
   * `snap-access.cn-north-4.myhuaweicloud.com`。
   */
  it('cline 账号走 ClineAdapter：请求发往 api.cline.bot 且绝无华为云 HMAC 签名头', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const result = await retestAccount(makePool([makeEntry({
      id: 'cline-1',
      provider: 'cline',
      credentialRef: 'CLINE_ACCOUNT_TEST',
    })]), 'cline-1')

    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.host).toBe('api.cline.bot')
    expect(url.pathname).toBe('/api/v1/chat/completions')

    const headers = calls[0]!.headers
    // Cline 的头族：`Bearer workos:` 前缀令牌 + 产品的客户端标识头。
    expect(headers.Authorization).toBe('Bearer workos:AT')
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
    // 核心断言：**没有**华为云 SDK-HMAC-SHA256 签名头族。
    const flat = Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n')
    expect(flat).not.toContain('SDK-HMAC-SHA256')
    expect(flat).not.toContain('SignedHeaders')

    expect(await codeartsInstances()).toHaveLength(0)
    expect(await qoderInstances()).toHaveLength(0)
  })

  /**
   * zcode 这条与 qoder 同款（都写 `modelRateLimits`、都落过 else）。
   *
   * 断言面比 qoder 窄：zcode 只有一个产品（`ZCODE` 常量），不存在「两站配置
   * 接反」的风险，故只需断言「构造的是 ZcodeAdapter、带的是 zcode 产品配置」，
   * 以及**没有**构造 CodeArtsAdapter（否则就是用华为云签名发 zcode 凭据）。
   */
  it('zcode 账号走 ZcodeAdapter 而非 CodeArtsAdapter', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const id = 'zcode-1'
    const result = await retestAccount(makePool([makeEntry({
      id,
      provider: 'zcode',
      credentialRef: 'ZCODE_ACCOUNT_TEST',
      /**
       * ⚠️ 必须带上限流标记：`retestAccount` 的探测目标是
       * `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不会构造适配器**
       * —— 那样这条用例会变成**假绿**（既抓不到缺陷，也守不住修复）。
       */
      modelRateLimits: { 'GLM-5.3-Flash': Date.now() + 3_600_000 },
    })]), id)

    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const zcode = await zcodeInstances()
    expect(zcode).toHaveLength(1)
    expect(zcode[0]?.product?.id).toBe('zcode')
    // 核心断言：**没有**构造 CodeArtsAdapter（否则就是用华为云签名发 zcode 请求）。
    expect(await codeartsInstances()).toHaveLength(0)
    // 桩适配器在构造后立刻抛错，故不该有任何真实请求发出。
    expect(calls).toHaveLength(0)
  })

  /**
   * gemini 这条与 zcode 同款：写 `modelRateLimits`、落过 else 分支的风险最高
   * （它是本仓库最新加入的 provider，且**不在** `updateModelRateLimit` 的老名单里，
   * 新增 provider 漏接 `probeWithAdapter` 的分派表在本仓库已复发四次）。
   */
  it('gemini 账号走 GeminiAdapter 而非 CodeArtsAdapter', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const id = 'gemini-1'
    const result = await retestAccount(makePool([makeEntry({
      id,
      provider: 'gemini',
      credentialRef: 'GEMINI_ACCOUNT_TEST',
      /**
       * ⚠️ 必须带上限流标记：`retestAccount` 的探测目标是
       * `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不会构造适配器**
       * —— 那样这条用例会变成**假绿**（既抓不到缺陷，也守不住修复）。
       */
      modelRateLimits: { 'gemini-3.8-flash': Date.now() + 3_600_000 },
    })]), id)

    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const gemini = await geminiInstances()
    expect(gemini).toHaveLength(1)
    // ⚠️ 断言的是 `product.id`（不是「构造了哪个类」）：分派按产品判定，
    // 带错产品配置会让适配器把请求发到错的端点。
    expect(gemini[0]?.product?.id).toBe('gemini')
    // 核心断言：**没有**构造 CodeArtsAdapter（否则就是拿 Google 令牌去做华为云 HMAC 签名）。
    expect(await codeartsInstances()).toHaveLength(0)
    // 桩适配器在构造后立刻抛错，故不该有任何真实请求发出。
    expect(calls).toHaveLength(0)
  })

  it('codearts 账号仍然走 CodeArtsAdapter（else 分支没有被改坏）', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'ca-1',
      provider: 'codearts',
      credentialRef: 'CODEARTS_ACCOUNT_TEST',
    })]), 'ca-1')

    expect(await codeartsInstances()).toHaveLength(1)
    // 反向对照：codearts 不该被分派给 Qoder / Cline 的链路。
    expect(await qoderInstances()).toHaveLength(0)
    expect(await geminiInstances()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  /**
   * ★★ **Loomy / Raccoon：第 5 次同型缺陷的事主**（本节由 2026-10-08 独立复审补齐）。
   *
   * ## 为什么之前没有这两条（这是本文件最大的覆盖缺口）
   *
   * 实测：改前本文件里 `loomy` 出现 **0 次**、`raccoon` 出现 **0 次** ——
   * 而这两家**都在** `probeById` 里注册了。旧 `else if` 链对它们**没有分支**，
   * 落入 `else` 后被交给华为云 HMAC 签名的 `CodeArtsAdapter`。
   * ⇒ 缺陷只在这两家上存在，而回归测试恰恰没有覆盖它们 ——
   * 「覆盖了当时**所有**有分支的家、却漏了出事的那两家」是 false coverage 的典型形状。
   *
   * ⚠️ 必须带 `modelRateLimits`：`retestAccount` 的探测目标是
   * `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不构造适配器**
   * ⇒ 用例会变成假绿（见 zcode 那条的同款注释）。
   */
  it.each([
    { provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_TEST', label: '讯飞' },
    { provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_TEST', label: '商汤小浣熊' },
  ])('$provider（$label）账号走自己的适配器，而非 CodeArtsAdapter', async ({ provider, credentialRef }) => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const id = `${provider}-1`
    const result = await retestAccount(makePool([makeEntry({
      id,
      provider,
      credentialRef,
      // ⚠️ 没标记 ⇒ 不构造适配器 ⇒ 用例假绿。日期按 UTC+8 当日 24:00。
      modelRateLimits: { 'some-model': Date.now() + 3_600_000 },
    })]), id)

    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const instances = provider === 'loomy' ? await loomyInstances() : await raccoonInstances()
    expect(instances, `${provider} 没有构造自己的适配器`).toHaveLength(1)
    // ⚠️ 断言 `product.id` 而不仅是「构造了一个适配器」：分派按产品判定，
    //    带错产品配置会让请求打到错的端点。
    expect(instances[0]?.product?.id).toBe(provider)
    // ⚠️ 且凭据 ref 必须被**原样透传**（生产里 `credentialRef(ref)` 会做校验，
    //    取错 ref 会让适配器去读别家凭据）。
    expect(instances[0]?.credentialRef).toBe(credentialRef)
    // 核心断言：**没有**构造 CodeArtsAdapter（否则就是用华为云签名发别家凭据）。
    expect(await codeartsInstances()).toHaveLength(0)
    // 桩适配器在构造后立刻抛错，故不该有任何真实请求发出。
    expect(calls).toHaveLength(0)
  })

  /**
   * ★★ **minimax：第 7 次同型缺陷的事主**（2026-10-11，issue IKJW32 补齐）。
   *
   * 它此前**不必**在这里（适配器零写点 ⇒ 没有可清的标记），而接上请求级换号 +
   * 冷却后它会写 `modelRateLimits`（额度 24h / 限流 1h）⇒ 必须登记进
   * `probeById`，否则标记写进去却**永远清不掉**（用户点「重测」会拿到
   * 「没有探测适配器」）—— 与 `opencode` 那条完全同型。
   *
   * ⚠️ 这条用例的意义与 loomy / raccoon 那两条相同：**别让刚补的那一家变成
   * 新的零覆盖**（「覆盖了当时所有登记的家、恰恰漏了出事的那 1 家」是 false coverage
   * 的典型形状）。
   *
   * ⚠️ 必须带 `modelRateLimits`：`retestAccount` 的探测目标是
   * `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不构造适配器**
   * ⇒ 用例会变成假绿。
   */
  /**
   * ★★ **MiniMax 两站：各自都要走自己的产品配置**（2026-10-16 合并审计补齐）。
   *
   * ⚠️ 本用例原先**只覆盖 `minimax`**，而两站共用同一个 `MinimaxAdapter` 类 ——
   * `probeById` 里的两个条目只差 `product`。合并审计**实测**：把
   * `probeById.minimaxintl` 的 `product: MINIMAX_INTL` 改成 `MINIMAX`，
   * **全量 8416 条测试仍然全绿** ⇒ 「用错主机发探测请求」这个失效形态**零守卫**。
   * 后果与 issue IKJW32 同型且**完全静默**：国际站账号点「重测」会把凭据发到
   * `agent.minimax.cn` ⇒ 必然 401 ⇒ 该账号的限流/额度标记**永远清不掉**，
   * 用户只看到「重测」没反应。
   *
   * ⚠️ 判据必须是 `product.id`，不能只断言「构造了一个适配器」——
   * 两个条目差的就是这个字段，只断言「构造了」会让 `it.each` 的两格**都绿**。
   */
  it.each([
    { provider: 'minimax', credentialRef: 'MINIMAX_ACCOUNT_TEST', label: '中国版' },
    { provider: 'minimaxintl', credentialRef: 'MINIMAXINTL_ACCOUNT_TEST', label: '国际版' },
  ])('$provider（MiniMax Code $label）账号走自己的适配器**与自己的产品配置**，而非 CodeArtsAdapter',
    async ({ provider, credentialRef }) => {
      const calls = stubFetch()
      const { retestAccount } = await import('../../src/account-probe.js')
      const id = `${provider}-1`
      // ⚠️ 桩的 `instances` 是**跨用例累积**的静态数组（本文件不在用例间清空它）
      //    ⇒ 只统计本格**新增**的那条。否则 `it.each` 的第二格会看到第一格留下的
      //    实例，`toHaveLength(1)` 变成假红。
      const seenBefore = (await minimaxInstances()).length

      const result = await retestAccount(makePool([makeEntry({
        id,
        provider,
        credentialRef,
        // ⚠️ 没标记 ⇒ 不构造适配器 ⇒ 用例假绿。
        modelRateLimits: { 'some-model': Date.now() + 3_600_000 },
      })]), id)

      expect(result.tested).toBe(1)
      expect(result.stillLimited).toHaveLength(1)

      const instances = (await minimaxInstances()).slice(seenBefore)
      expect(instances, `${provider} 没有构造自己的适配器`).toHaveLength(1)
      // ⚠️⚠️ **本用例的核心断言**：产品配置必须是它**自己那一站**。
      //    写成另一站 ⇒ 探测请求打错主机 ⇒ 必然 401 ⇒ 标记永不清除（静默失效）。
      expect(instances[0]?.product?.id).toBe(provider)
      // ⚠️ 凭据 ref 必须被**原样透传**（取错 ref 会让适配器去读别家凭据）。
      expect(instances[0]?.credentialRef).toBe(credentialRef)
      // 核心断言：**没有**构造 CodeArtsAdapter（否则就是用华为云签名发 minimax 凭据）。
      expect(await codeartsInstances()).toHaveLength(0)
      // 桩适配器在构造后立刻抛错，故不该有任何真实请求发出。
      expect(calls).toHaveLength(0)
    })

  /**
   * ★★ **opencode：第 6 次同型缺陷的事主**（2026-10-08 第二轮补齐）。
   *
   * ## 为什么这条必须存在
   *
   * 它**不是**「分派表漏了它」——`probeById` 里此前根本没有它的条目，
   * 而 `tests/helpers/provider-sets.ts` 的 `PROBE_EXEMPT` 把它记为**豁免**，
   * 理由写的是「探测入参只有一个账号的凭据，而它的适配器需要整个
   * `identitySlots` 序列 + 池条目 id；补它要给 `ProbeDeps` 加池透传，
   * 属接口扩张」。
   *
   * ⚠️ **该理由已被实测证伪**（逐条反驳见 `PROBE_EXEMPT` 的文档）。
   * 于是这里出现了一个**用例挡不住的缺口**：豁免表让守卫满意、而用户点
   * 「重测」会真的报错 —— `opencode` 没有 `rateLimit: false`，
   * 客户端按钮由 `supportsRateLimit`（缺省 true）门控 ⇒ **按钮会渲染**。
   *
   * ## 这条用例锁三件事（缺一条就守不住修复）
   *
   * 1. **能造出适配器**：不再抛「没有探测适配器」（`result.tested === 1`）；
   * 2. **发往 Zen 而不是华为云**：断言真实请求的 host 与头族，
   *    比「构造了哪个类」更贴近缺陷本身；
   * 3. **池字段真被用上**：`x-opencode-project` 必须等于
   *    `deriveProjectId(apiKey, entry.opencodeFingerprintGeneration)` ——
   *    少了 `entry` 透传，代次会恒为 0 ⇒ project id 不同 ⇒ 这条立刻变红。
   */
  it('opencode 账号走 OpencodeAdapter（Zen 端点 + 池字段权威指纹），而非 CodeArtsAdapter', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const { deriveProjectId } = await import('../../src/opencode.js')
    const apiKey = 'sk-opencode-test-key-0123456789'
    const id = 'opencode-1'
    /**
     * ⚠️ 三条都不能少（少任何一条本用例都会**假绿**）：
     * - 带 `modelRateLimits`：`retestAccount` 的探测目标是
     *   `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不构造适配器**
     *   （见 zcode 那条的同款注释）；
     * - 凭据必须是 `{ api_key }`（不是默认桩里的 `access_token`）：
     *   否则工厂退回匿名 key ⇒ 槽变成匿名槽 ⇒ 收费模型被 `pickSlot` 跳过，
     *   报的是「缺账号」而不是我们要验的限流；
     * - `opencodeFingerprintGeneration` 非 0：这是**池权威**字段，
     *   断言它进了 project id 才能证明 `entry` 被真的透传了。
     */
    const generation = 3
    const result = await retestAccount(makeOpencodePool([makeEntry({
      id,
      provider: 'opencode',
      credentialRef: 'OPENCODE_ACCOUNT_TEST',
      modelRateLimits: { 'big-pickle': Date.now() + 3_600_000 },
      opencodeFingerprintGeneration: generation,
    })], apiKey), id)

    // ① 造得出适配器：不再抛「没有探测适配器」。
    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    // ② 请求真的发往 Zen（而不是华为云端点）。
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.host).toBe('opencode.ai')
    expect(url.pathname).toBe('/inference/v1/chat/completions')
    const flat = Object.entries(calls[0]!.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
    expect(flat).not.toContain('SDK-HMAC-SHA256')
    expect(flat).not.toContain('SignedHeaders')
    expect(calls[0]!.headers.Authorization ?? calls[0]!.headers.authorization).toBe(`Bearer ${apiKey}`)

    // ③ 池字段权威：project id 由 (api_key, 池里的代次) 派生 —— 见用例头注释。
    expect(calls[0]!.headers['x-opencode-project']).toBe(deriveProjectId(apiKey, generation))
    // 反证：若代次没被透传（恒 0），project id 会是另一个值。
    expect(calls[0]!.headers['x-opencode-project']).not.toBe(deriveProjectId(apiKey, 0))

    expect(await codeartsInstances()).toHaveLength(0)
  })

  /**
   * ⚠️ **探测不得给适配器注入 `markLimited`**（否则「重测 A 账号」会污染整个池）。
   *
   * ## 为什么断言的是「注入点为空」而不是「没有写回发生」
   *
   * `retestAccount` 自己**也会**调 `pool.updateModelRateLimit`
   *（对上游给了新重置时刻的那个分支）—— 所以「没有写回」这个断言**永远不成立**，
   * 写成那样就是一条恒真的假绿。真正要锁的是：**适配器这一侧**拿不到写回钩子。
   * 拿不到 ⇒ 它内部的 3 处 `markLimited` 全部是 `undefined?.()` 空操作。
   *
   * 同时锁「**停用账号也要能重测**」：`listIdentitySlots` 会跳过
   * `enabled === false` 的条目，而探测的既定语义（见 `account-probe.ts`
   * 模块头第 2 条设计）是停用账号照样能测。造槽时**刻意不继承**池里的
   * `enabled` 就是为此 —— 继承会让重测退化成「没有可用通道」。
   */
  it('opencode 探测不注入 markLimited，且停用账号仍可重测', async () => {
    const calls = stubFetch()
    const { retestAccount } = await import('../../src/account-probe.js')
    const { probeById } = await import('../../src/index.js')
    const apiKey = 'sk-opencode-disabled-key-0123456789'
    const id = 'opencode-disabled'
    const entry = makeEntry({
      id,
      provider: 'opencode',
      credentialRef: 'OPENCODE_ACCOUNT_DISABLED',
      enabled: false,
      modelRateLimits: { 'big-pickle': Date.now() + 3_600_000 },
    })
    const pool = makeOpencodePool([entry], apiKey)

    const result = await retestAccount(pool, id)

    // 停用账号照样进入了探测（未被 `listIdentitySlots` 的 enabled 过滤挡掉）。
    expect(result.tested).toBe(1)
    expect(calls).toHaveLength(1)

    // 核心断言：直接把工厂造的适配器拿出来看它拿到了哪些钩子。
    // ⚠️ 这一步是**实测**而不是推断 —— 少它的话「不写回」只能靠读源码相信。
    const adapter = probeById['opencode']!
      .createProbeAdapter(entry.credentialRef, { api_key: apiKey }, entry) as unknown as {
        options?: { markLimited?: unknown; fetchRemoteCatalog?: unknown; disabledModels?: unknown }
      }
    expect(adapter.options?.markLimited, '探测路径不得给适配器注入 markLimited').toBeUndefined()
    expect(adapter.options?.fetchRemoteCatalog, '探测不该为一次存活检查拉远端目录').toBeUndefined()
    expect(adapter.options?.disabledModels, '探测不该读黑名单（那是选号的事）').toBeUndefined()
  })
})

/**
 * opencode 专用的池桩：凭据是 `{ api_key }`（不是其余家那份 `access_token`）。
 *
 * ⚠️ `makePool` 的固定凭据对本用例是**错的**——`opencode` 的凭据形状是
 * `{ api_key, nickname?, fingerprint?, proxy? }`（见 `src/opencode.ts`）。
 * 用错形状会让工厂退回匿名 key，把「账号通道」静默变成「匿名通道」。
 */
function makeOpencodePool(
  entries: ProviderAccountEntry[],
  apiKey: string,
): ProbePool {
  return {
    ...makePool(entries),
    async resolveCredentialForAccount() {
      return { api_key: apiKey } as unknown as Awaited<
        ReturnType<ProbePool['resolveCredentialForAccount']>
      >
    },
  }
}

/**
 * 回归：**探测请求必须带首条 system 消息**（否则 WorkBuddy 网关 400 拦截）。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * 在 Jet Hub 的 WorkBuddy 面板点「重测」/「重测所有」，得到的不是真实结论，
 * 而是一律的错误提示：
 *
 * ```
 * bmwukong · deepseek-v4.1-flash：无法确认：buddy: {"code":11128,
 * "msg":"first message is not system prompt", ... "请求被安全策略拦截，请稍后重试或联系支持。"}
 * ```
 *
 * 该报错**伪装成安全策略拦截**，与真实的限流/可用性完全无关 —— 于是重测
 * 功能在 WorkBuddy 上**恒不可用**：既拿不到「已恢复」，也拿不到「仍受限」。
 *
 * ## 根因（已实发对照实测）
 *
 * `probeWithAdapter` 只传 `messages`、**不传 `options.system`**，而适配器仅在
 * `options.system` 非空时才 `unshift` system 消息（`buddy-adapter.ts`），故 wire
 * 上首条就是 `role:'user'`。
 *
 * 实测（2026-09-25，同一凭据各发一次最小请求）：
 *
 * | 端点 | 无 system | 有 system |
 * |---|---|---|
 * | `www.workbuddy.ai`（WorkBuddy） | **400 + code 11128** | 200 正常 |
 * | `copilot.tencent.com`（CodeBuddy） | 200 正常 | 200 正常 |
 *
 * 即**只有 WorkBuddy 国际版网关**强制要求首条 system。故修复必须让探测请求
 * 无条件带上 system —— 不能依赖「反正 buddy 不要求」而只在 workbuddy 分支加。
 *
 * ⚠️ 本用例断言的是**探测请求的入参形状**（而非适配器产物），因为缺陷在
 * 调用方：适配器行为本来就正确（有 system 就插入），是探测没给它 system。
 * 用 mock 记录 `stream()` 入参，可在**零网络**下锁死该契约。
 */
describe('account-probe 探测请求必须带首条 system（WorkBuddy 11128 回归）', () => {
  beforeEach(async () => {
    ;(await adapterInstances()).length = 0
    ;(await streamOptions()).length = 0
    ;(await traeInstances()).length = 0
    ;(await traeStreamOptions()).length = 0
    ;(await codeartsInstances()).length = 0
  })

  it('workbuddy 探测请求带非空 system（否则网关 400 安全策略拦截）', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({})]), 'wb-1')

    const calls = await streamOptions()
    expect(calls).toHaveLength(1)
    // 关键断言：system 必须存在且非空 —— 缺失即 wire 首条变成 user → 11128。
    expect(typeof calls[0]?.system).toBe('string')
    expect((calls[0]!.system as string).length).toBeGreaterThan(0)
  })

  it('buddy 探测请求同样带 system（两个 provider 判据一致，不做分支特判）', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'buddy-1',
      provider: 'buddy',
      credentialRef: 'BUDDY_ACCOUNT_TEST',
    })]), 'buddy-1')

    const calls = await streamOptions()
    expect(calls).toHaveLength(1)
    expect(typeof calls[0]?.system).toBe('string')
    expect((calls[0]!.system as string).length).toBeGreaterThan(0)
  })

  it('探测请求仍然只有一条 user 消息（system 走 options.system，不塞进 messages）', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({})]), 'wb-1')

    const calls = await streamOptions()
    const messages = calls[0]?.messages as Array<{ role?: string }> | undefined
    expect(messages).toHaveLength(1)
    // system 若也塞进 messages，适配器会插入两次 system（一次来自 messages、
    // 一次来自 options.system），wire 上出现重复 system 消息。
    expect(messages?.[0]?.role).toBe('user')
  })
})
