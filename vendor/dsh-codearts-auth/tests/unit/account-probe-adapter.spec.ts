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
})

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
