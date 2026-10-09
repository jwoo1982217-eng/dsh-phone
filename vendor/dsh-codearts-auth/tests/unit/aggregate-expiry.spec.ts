/**
 * `src/aggregate-expiry.ts` 的缺陷回归：**未接入的渠道必须返回 `UNUSABLE`**。
 *
 * ## 为什么要单独守这个
 *
 * `createExpiryProbe` 是聚合层与 auto 层共用的**唯一**临期折算口径（Task 7 把
 * `auto-adapter.ts` 里那四个 `*Expiry` 方法搬了过来，两处不再各写一份）。
 *
 * 它有一个**静默**的失效形态：把「我们对其余额一无所知」的渠道折算成 `NEVER`。
 * `NEVER` 的语义是「可用、只是无临期额度」—— 它**参与排序且可当选**，于是请求
 * 会被发到一个可能早就没额度的渠道。不报错、不崩溃，只是把「没做到」说成
 * 「做到了」（AGENTS.md 首条判据记的正是这类静默失效）。
 *
 * ## 三条约定
 *
 * 1. **未接入的 provider ⇒ `UNUSABLE`**（剔除），绝不 `NEVER`（当选）；
 * 2. **无可用账号 ⇒ `UNUSABLE`**（取不到代表账号即「本次不可用」）；
 * 3. **abort ⇒ 抛 `AbortError`**，绝不折算成 `UNUSABLE` —— 用户取消请求时看到
 *    「请先登录」是误导（PR !69 审计实测过的真实缺陷）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WIRED_EXPIRY_PROVIDERS,
  codeArtsExpiry,
  createExpiryProbe,
  lobsteraiExpiry,
  traeExpiry,
} from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'

describe('真实临期探针：未接入的渠道必须返回 UNUSABLE（否则会被误当选）', () => {
  /** 取号时用的模型 id 桩（真实实现从渠道目录取第一个）。 */
  const anyModel = async (): Promise<string | undefined> => 'deepseek-v4.1-flash'

  it('provider 不在已知清单里时返回 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('opencode')).toBe(UNUSABLE)
  })

  it('无可用账号时返回 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => null,
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    expect(await probe('buddy')).toBe(UNUSABLE)
  })

  it('已中止的 signal 必须抛 AbortError，不得折算成 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    const controller = new AbortController()
    controller.abort()
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ 探测期间中止必须抛 AbortError，不得吞成 UNUSABLE', async () => {
    // ⚠️ 本 `try` 里有两个可能抛错的调用（`firstModelIdOf` 与 `getAvailableAccount`），
    //    任一在探测途中被取消时抛出的 AbortError 若被折算成 UNUSABLE，用户取消后
    //    会看到「没有任何可用候选」而不是中止。
    const controller = new AbortController()
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => {
      controller.abort() // 模拟「探测途中被取消」（signal 被标记）
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ signal 未被标记、但抛出的是 AbortError 时也必须逃逸（隔离 isAbortError 那一行）', async () => {
    // ⚠️ 上一条用例的 stub 里调了 `controller.abort()`，signal **已标记** ⇒
    //    `signal?.throwIfAborted()` 会先抛，`isAbortError(error)` 那一行**从未被判定**
    //    （Task 7 复审 M1 指出）。本用例**不标记 signal**，只让 stub 抛 AbortError
    //    ⇒ 唯一能拦住它的是 `isAbortError` 那一行。
    //
    // 为什么要单独锁：`isAbortError` 是**防御性**的（当前装配下 `listModels` 无 signal
    // 通道，故那条路径不可达），但装配层一旦改成会响应 signal 的取号方式它就会生效；
    // 没有本用例时删掉它不会有任何用例变红。
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => {
      const error = new Error('aborted upstream')
      error.name = 'AbortError'
      throw error // ⚠️ 注意：**不**调用 controller.abort()
    })
    // 传一个**未被标记**的 signal（它永远不会 abort）
    await expect(probe('buddy', new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('★ WIRED_EXPIRY_PROVIDERS 必须与 createExpiryProbe 的 switch 一致', () => {
  // ⚠️ 该清单被聚合层用来决定「哪些虚拟模型可以播报」（未接入的渠道其模型会被
  //    过滤掉，否则用户选中后拿到的是误导性的「没有任何可用候选」）。
  //    ⇒ 清单若与 switch 漂移，会出现两种真实缺陷：
  //    ① 清单**多**了某渠道 ⇒ 它的模型被播报，但折算恒 UNUSABLE ⇒ 误导性报错；
  //    ② 清单**少**了某渠道 ⇒ 它的模型被隐藏，而其实可以正常参与轮换。
  //    故这里用**源码级**断言锁住两者相等（与 auto-adapter 的源码守卫同一手法）。
  it('清单与 switch 分支逐项相等', async () => {
    const { WIRED_EXPIRY_PROVIDERS } = await import('../../src/aggregate-expiry.js')
    const source = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/aggregate-expiry.ts', import.meta.url), 'utf8',
    ))
    // 取 createExpiryProbe 里 `case 'xxx':` 的全部捕获。
    // ⚠️ 字符类必须含 `-` 与 `_`：本仓库的 provider id 可能带连字符（如 `qoder-cn`
    //    这类形态），只写 `[a-z]+` 会让**带连字符的渠道静默漏匹配** —— 那时守卫
    //    两侧都不含它、断言仍绿，正是「守卫静默失效」的形态（第 4 轮审计加固）。
    const cases = [...source.matchAll(/case '([a-z0-9_-]+)':/g)].map((m) => m[1])
    expect(cases.length).toBeGreaterThan(0)
    expect([...cases].sort()).toEqual([...WIRED_EXPIRY_PROVIDERS].sort())
  })

  it('★ 未知渠道必 UNUSABLE（方向对照；清单正确性由上一条的源码级断言守）', async () => {
    // ⚠️ **本条原标题是「清单里的每个渠道都真的能折算（不返回「未接入」的兜底值）」——
    //    那是误导**（独立审计 M4 指出）：函数体只断言 `raccoon` / `not-a-channel`，
    //    而那两个**都不在清单里** ⇒ 它**从未遍历** `WIRED_EXPIRY_PROVIDERS`，
    //    任何实现都能过（本仓库「同义反复用例比没有更危险」的形态）。
    //
    // ⚠️ 「清单里的渠道都真的能折算」这个意图**已由上一条的源码级断言守住**
    //   （「清单与 switch 分支逐项相等」：清单列了但 switch 没有 ⇒ 那条会红）。
    //    本条的**真实价值**只是方向对照：**未知渠道必须被剔除**（不能返回 NEVER）。
    //    ⇒ 如实命名，不再声称它测了清单。
    const { createExpiryProbe } = await import('../../src/aggregate-expiry.js')
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: {} },
      ],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // raccoon：真实渠道但**未接入**折算；not-a-channel：根本不存在的 id
    expect(await probe('raccoon')).toBe(-1)
    expect(await probe('not-a-channel')).toBe(-1)
  })

  it('★ 清单里的每个渠道都**真的走过了折算路径**（逐条遍历，不再同义反复）', async () => {
    // ⚠️ 补上「清单里的每个渠道都能折算」这个意图的**真实覆盖**（原用例只是
    //    标题那么写、实际没遍历）。判据：用一个「有可用账号」的池喂进去，
    //    每个清单渠道都必须**产生一次目录读取**（`firstModelIdOf` 被调用）——
    //    这证明它**没有**在「未接入」的短路处提前返回（那是 `UNUSABLE` 的另一条路径）。
    //    ⚠️ 不要求折算成功（各家凭据形状不同），只要求**真的走进去**。
    const { createExpiryProbe, WIRED_EXPIRY_PROVIDERS: wired } =
      await import('../../src/aggregate-expiry.js')
    expect(wired.length, '清单不能为空（否则本用例恒真）').toBeGreaterThan(0)

    for (const provider of wired) {
      const probed: string[] = []
      const probe = createExpiryProbe({
        disabledModelsFor: () => new Set<string>(),
        // ⚠️ 凭据形状故意不匹配 ⇒ 折算会失败，但**取号与读目录必须发生**。
        listAvailableCredentials: async () => [
          { entry: { id: 'a1' }, credential: { access_token: 'x' } },
        ],
      } as never, async (p: string) => { probed.push(p); return 'm1' })
      await probe(provider).catch(() => undefined)
      expect(probed, `${provider} 必须走过折算路径（读目录），不能在短路处提前返回`)
        .toEqual([provider])
    }
  })
})

describe('★ 第 3 轮审计：未接入渠道必须短路（不取号、不读目录）', () => {
  it('未接入渠道：不得调用 firstModelIdOf，也不得取号', async () => {
    // ⚠️ 实测缺陷：初版对未接入渠道**先取号、后**才走 switch 的 default 返回 UNUSABLE
    //    ⇒ 每次 auto 请求都为每个未接入渠道白做一次目录读取 + 账号池查询
    //    （探针：getAvailableAccount 被以 `cline/m1` 调用）。
    //    两者都**不是网络请求**（账号池是纯本地内存过滤），故属性能浪费而非功能缺陷，
    //    但短路零成本且语义更准 ——「未接入」≠「有账号但折算不了」。
    let modelIdCalls = 0
    let accountCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { accountCalls += 1; return { entry: { id: 'a1' }, credential: {} } },
    } as never
    const probe = createExpiryProbe(pool, async () => { modelIdCalls += 1; return 'm1' })

    // 未接入的渠道（不在 WIRED_EXPIRY_PROVIDERS 里）
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('not-a-channel')).toBe(UNUSABLE)
    expect(modelIdCalls).toBe(0)
    expect(accountCalls).toBe(0)
  })

  it('已接入渠道：仍然照常取号（短路不能把正常的也跳掉）', async () => {
    let accountCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      // ⚠️ 判据已从 `getAvailableAccount`（返回**一个**代表账号）改为
      //    `listAvailableCredentials`（返回**全部**启用账号，用户 2026-10-07 选定）——
      //    因为「渠道整体的临期额度」必须看全部账号，只看第一个会漏掉
      //    「排后面的号快作废」这种情况。
      listAvailableCredentials: async () => {
        accountCalls += 1
        return [{ entry: { id: 'a1' }, credential: {} }]
      },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // buddy 已接入 ⇒ 必须真的去取号（凭据形状不对会让它抛错/返回 UNUSABLE，
    // 但**取号这件事必须发生**）
    await probe('buddy').catch(() => undefined)
    expect(accountCalls).toBe(1)
  })

  it('未接入渠道在**已中止**时仍必须抛 AbortError（短路不能吞掉中止）', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    const controller = new AbortController()
    controller.abort()
    await expect(probe('cline', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * `codeArtsExpiry` 的折算口径（真实缺陷回归，用户报障 2026-10-07）。
 *
 * ⚠️ **本文件此前完全没有覆盖折算值** —— 只测了控制流（短路 / 中止 / 清单一致性）。
 * 于是「codearts 被算成今天 24:00 作废」这个错误口径**一直没有测试发现**。
 * 本段补上这个缺口。
 */
describe('★ codeArtsExpiry：读不到到期时间就不猜（一律 NEVER）', () => {
  /** 造一个返回固定 `statistics/plugin` 响应的桩 fetcher。 */
  function stubFetch(payload: unknown) {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch)
  }

  const cred = {
    access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expires_at: '',
  } as never

  afterEach(() => { vi.unstubAllGlobals() })

  it('★ 积分账户有余额 ⇒ NEVER（**不是**今天 24:00 —— 接口不给到期时间）', async () => {
    // 实测的真实响应形状（本机账号 82AD9D6E）：有积分、但三个时间字段全空。
    stubFetch({
      package: { is_credit_package: true, is_token_package: false, spec_code: 'x', package_name: '体验版', status: 'normal' },
      metrics: [
        { name: 'usageTotalPackageCredit', package_credit_amount: 24000, package_credit_used: 1911.84, package_credit_remain: 22088.16 },
      ],
    })
    const value = await codeArtsExpiry(cred)
    // ⚠️ 旧实现返回 `nextUtc8DayStartMs()`（今天 24:00）⇒ 会让 codearts 在
    //    「临期优先」排序里**永远排最前**，抢走真正临期额度。
    expect(value).toBe(NEVER)
    expect(Number.isFinite(value)).toBe(false)
  })

  it('★ Token 计费账户（无积分口径）⇒ NEVER（账号可用，只是没有积分可烧）', async () => {
    stubFetch({
      package: { is_credit_package: false, is_token_package: true, spec_code: 'x', package_name: '体验版', status: 'normal' },
    })
    expect(await codeArtsExpiry(cred)).toBe(NEVER)
  })

  it('★ 查询失败 ⇒ UNUSABLE（剔除），与「没有到期概念」严格区分', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await codeArtsExpiry(cred)).toBe(UNUSABLE)
  })

  it('★ 网络抛错 ⇒ UNUSABLE（不把异常当成 NEVER）', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(await codeArtsExpiry(cred)).toBe(UNUSABLE)
  })
})

/**
 * ★ lobsterai / trae 的临期折算（真实缺陷回归，用户报障 2026-10-07）。
 *
 * ⚠️ **用户报障原文**：「如果没有临时积分也能进轮换列表的话，有 4.1 flash 的模型
 * 不止 3 个，为什么别的没进？」
 *
 * 核实结论：`auto-adapter.ts` 曾写「其余 provider（qoder / trae / cline / …）
 * 结构上留好接口但不接入：**它们没有跨账号的到期余额探测端点**」——
 * **该理由对 lobsterai 与 trae 是错的**：
 *
 * | 渠道 | 到期时间来源 |
 * |---|---|
 * | `lobsterai` | `lobsterai-credits.ts` 把 ISO `expiresAt` 归一化成 **`deductionEndTime`** |
 * | `trae` | `trae-credits.ts` 从条目级 `expire_time`（秒）算 **`deductionEndTime`** |
 *
 * 两者与 `buddy` **完全同形**（都是「有效包 `deductionEndTime` 的最小值」），
 * 故折算逻辑可共享、接入几乎免费。
 *
 * ⚠️ `raccoon` **确实没有**到期时间（`raccoon-credits.ts` 的 `makePackage` 把
 * `cycleStartTime`/`cycleEndTime`/`expiredTime` 全部置空）⇒ 它**保持未接入**，
 * 上面第一条用例继续断言它返回 UNUSABLE。
 */
describe('★ lobsterai / trae：与 buddy 同形的「有效包最早到期」折算', () => {
  // ⚠️ trae 的 `postJson` **要求 `uid` 非空**（否则早退「缺少 user_id，无法构造设备身份」
  //    ⇒ 返回 null ⇒ UNUSABLE）。lobsterai 只用 access_token。
  //    我第一版给两家共用同一个最小凭据，trae 因此恒返回 -1。
  const cred = { access_token: 't', expires_at: '' } as never
  const traeCred = { access_token: 't', expires_at: '', uid: 'u1' } as never

  afterEach(() => { vi.unstubAllGlobals() })

  /** 把某个时刻的毫秒戳算成「还剩多久」的可读形式。 */
  const future = (ms) => Date.now() + ms

  it('★ lobsterai：取有效包 deductionEndTime 的最小值', async () => {
    // ⚠️ **必须给 ISO 串带时区后缀**（我第一版没带，用例假失败）：
    //    `lobsterai-credits.ts` 用 `Date.parse(expiresAt)` 解析，而无时区后缀的 ISO 串
    //    按**本机时区**解释（本机 UTC+8）⇒ 同一串解析出的时刻比 UTC 早 8 小时
    //    ⇒ 「2 小时后」的包被算成 6 小时前（已过期）⇒ `active:false` ⇒ 被过滤，
    //    函数于是返回了另一个包的值。**不是实现缺陷，是我造的测试数据有歧义。**
    //    ⚠️ 顺带记录一个真实口径：服务端若下发不带时区的串，解析结果**依赖本机时区**
    //   （见下方单独一条用例）。
    const soonMs = Date.now() + 2 * 60 * 60 * 1000
    const laterMs = Date.now() + 30 * 24 * 60 * 60 * 1000
    // 带 `+08:00`：明确按 UTC+8 解释，与「本机时区」无关，用例才稳定。
    const iso = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'
    // ⚠️ 必须带 `code: 0` —— `parseLobsteraiEnvelope` 要求它（缺失 ⇒ code=-1 ⇒ ok:false
    //    ⇒ 函数返回 null ⇒ UNUSABLE）。我第一版漏了，三条用例全返回 -1。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        creditItems: [
          { label: '每日登录奖励', type: 'campaign', creditsRemaining: 100, expiresAt: iso(laterMs) },
          { label: '赠送', type: 'gift', creditsRemaining: 50, expiresAt: iso(soonMs) },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const value = await lobsteraiExpiry(cred, LOBSTERAI)
    // ISO 串只到秒 ⇒ 期望值也截到秒。
    expect(value, '应取最早到期那个包（2 小时后）').toBe(Math.floor(soonMs / 1000) * 1000)
  })

  it('★ lobsterai：无有效包 ⇒ NEVER（不剔除）', async () => {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { creditItems: [{ label: 'x', type: 'gift', creditsRemaining: 0, expiresAt: '' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    expect(await lobsteraiExpiry(cred, LOBSTERAI)).toBe(NEVER)
  })

  it('★ lobsterai：查询失败 ⇒ UNUSABLE（与「无到期概念」严格区分）', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await lobsteraiExpiry(cred, LOBSTERAI)).toBe(UNUSABLE)
  })

  it('★ trae：取条目级 expire_time（秒）换算后的最小值', async () => {
    const soonSec = Math.floor(future(3 * 60 * 60 * 1000) / 1000)
    const laterSec = Math.floor(future(20 * 24 * 60 * 60 * 1000) / 1000)
    // ⚠️ 字段名是 **`user_entitlement_pack_list`**（`trae-credits.ts` 实测），
    //    不是 `pack_list` —— 我第一版写错，函数因「不是数组」返回 null ⇒ UNUSABLE。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      user_entitlement_pack_list: [
        {
          entitlement_base_info: { quota: { credits_limit: 500 }, display_desc: '每月登录赠送' },
          usage: { credits_amount: 0 }, expire_time: laterSec,
        },
        {
          entitlement_base_info: { quota: { credits_limit: 300 }, display_desc: '签到奖励' },
          usage: { credits_amount: 10 }, expire_time: soonSec,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const value = await traeExpiry(traeCred, TRAE)
    // ⚠️ 秒 → 毫秒必须 ×1000（不乘会落到 1970 年）。
    expect(value).toBe(soonSec * 1000)
  })

  it('★ trae：无到期时间（`expire_time` 为 0）⇒ NEVER（不猜）', async () => {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      user_entitlement_pack_list: [
        {
          entitlement_base_info: { quota: { credits_limit: 300 }, display_desc: 'x' },
          usage: { credits_amount: 0 }, expire_time: 0,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    expect(await traeExpiry(traeCred, TRAE)).toBe(NEVER)
  })

  it('★ trae：查询失败 ⇒ UNUSABLE', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await traeExpiry(traeCred, TRAE)).toBe(UNUSABLE)
  })
})

/**
 * ★ 「探全部账号、取最早」（用户报障 2026-10-07 的第二次质疑）。
 *
 * 用户原话：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
 * **只用了第一个账号吗**？」
 *
 * **他猜对了。** 旧实现走 `pool.getAvailableAccount`，那个方法只返回**手动序第一个**
 * 可用账号 ⇒ 用户把「1 天到期」的号拖到后面时，它的临期额度在**排序**里被完全忽略：
 * 这个渠道明明有一个快作废的号，却被按「2000 多天后才作废」排到最后。
 *
 * ⇒ 改为取**全部**启用账号，逐个折算，取**最早**的那个。
 */
describe('★ 临期折算必须看**全部**账号（不能只看手动序第一个）', () => {
  /** 造一个 pool：`listAvailableCredentials` 返回给定的多个凭据。 */
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: `a${Math.random()}` }, credential,
    })),
    // ⚠️ 同时提供旧的单账号方法（回退路径用）—— 但本组用例断言**走的是新方法**。
    getAvailableAccount: async () => {
      throw new Error('不应走单账号回退路径')
    },
  }) as never

  it('★ 取全部账号里**最早**的到期时刻（不是第一个账号的）', async () => {
    // ⚠️ 走**完整真实链路**：`createExpiryProbe` → `buddyExpiry` → `fetchCreditBalance`
    //    → 全局 fetch（桩）。两个账号的响应不同：
    //      A（排第一）：30 天后到期
    //      B（排第二）：**1 天后**到期  ← 用户拖在后面的那个
    //    正确行为：取 B 的 1 天（渠道整体「最早作废」）。
    //    旧实现只看 A ⇒ 返回 30 天，于是这个渠道被排到最后（用户报障的现象）。
    const now = Date.now()
    const soon = now + 1 * 86_400_000
    const later = now + 30 * 86_400_000
    // ⚠️ 响应是**两层嵌套**：`data.Response.Data.Accounts[]`（`credits.ts` 实测），
    //    且余额字段是 `CycleCapacityRemain`（本周期口径）、失效判据是 `Status`。
    //    我第一版写 `data.packages[].Remain` —— 解析不出来 ⇒ 包全被跳过 ⇒ 返回 Infinity。
    const wrap = (pkg) => ({ code: 0, data: { Response: { Data: { Accounts: [pkg] } } } })
    const responses = [
      wrap({ Status: 1, CycleCapacityRemain: 10, DeductionEndTime: later }),
      wrap({ Status: 1, CycleCapacityRemain: 10, DeductionEndTime: soon }),
    ]
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      const body = responses[Math.min(calls, responses.length - 1)]
      calls += 1
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch)

    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: { access_token: 't1' } },
        { entry: { id: 'a2' }, credential: { access_token: 't2' } },
      ],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    const value = await probe('buddy')
    // ★ 必须是**较早**的那个（B 的 1 天），而不是第一个账号的 30 天
    expect(value).toBe(soon)
    expect(calls, '两个账号都要探（不能只探第一个）').toBeGreaterThanOrEqual(2)
  })

  it('★ 必须调用 `listAvailableCredentials`（而不是只取一个代表账号）', async () => {
    let listCalls = 0
    let legacyCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => { listCalls += 1; return [] },
      getAvailableAccount: async () => { legacyCalls += 1; return null },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    await probe('buddy').catch(() => undefined)
    expect(listCalls, '必须走「全部账号」路径').toBe(1)
    expect(legacyCalls, '不得回退到单账号路径（它存在时）').toBe(0)
  })

  it('★ 只有旧方法时回退（既有测试桩的兼容路径，语义是降级不是错误）', async () => {
    let legacyCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { legacyCalls += 1; return null },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // 回退路径被走到 ⇒ 返回 UNUSABLE（没有账号），**不抛错**
    await expect(probe('buddy')).resolves.toBe(UNUSABLE)
    expect(legacyCalls).toBe(1)
  })

  it('★ 一个账号都没有 ⇒ UNUSABLE（与「有账号但读不到到期时间」严格区分）', async () => {
    const probe = createExpiryProbe(poolWith([]), async () => 'm1')
    await expect(probe('buddy')).resolves.toBe(UNUSABLE)
  })
})

/**
 * ★ 临期折算必须**带 TTL 缓存**（用户要求 2026-10-07）。
 *
 * 用户原话：「我们每次计算排序用的数据应该是调已有缓存而不是从服务器请求最新积分数据，
 * 缓存定期更新各个 provider 的积分」。
 *
 * ## 为什么必须缓存（实测的调用频率）
 *
 * `auto-adapter.ts` 的 `expiryOf` **每次调用都新建一个 probe**
 *（`createExpiryProbe(this.options.accountPool, …)`），而聚合层也用同一个工厂
 * ⇒ 没有缓存时**每次请求**都会对每个候选渠道重打上游余额接口。
 * 一个 `auto` 请求的候选池跨全部渠道 ⇒ 一次请求就是 N 次上游 GET。
 *
 * ## TTL 取 60 秒（用户给的选项：60 / 90 / 120）
 *
 * 选 60 的理由：
 * - 与既有的 `BUDDY_BALANCE_CACHE_TTL_MS = 60_000`（余额选号器）**同值** ——
 *   两处缓存节奏一致，不会出现「选号用的是 30 秒前的数据、排序用的是 90 秒前的」；
 * - 临期判据的最小粒度是**天**（资源包到期时间以天计），60 秒的滞后在语义上
 *   完全无害；
 * - 最短 ⇒ 用户改完渠道侧配置后，最坏情况下等待最短。
 *   ⚠️ 90/120 只省下极少量请求（面板与排序都不是高频路径），却让「刚登录的账号
 *   不出现在排序里」的窗口更长。
 */
describe('★ 临期折算的 TTL 缓存（默认 60 秒，与余额选号器同值）', () => {
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  }) as never

  /** 造一个计数上游调用的 buddy 桩响应。 */
  function stubCountingFetch(deductionEndTime: number) {
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: deductionEndTime },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    return () => calls
  }

  it('★ TTL 内重复探测只打一次上游（命中缓存）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls()
    expect(afterFirst).toBeGreaterThan(0)
    // 同一时刻再探 3 次 ⇒ 上游调用数**不得增加**
    await probe('buddy')
    await probe('buddy')
    await probe('buddy')
    expect(calls(), 'TTL 内必须命中缓存，不得重复打上游').toBe(afterFirst)
  })

  it('★ 超过 TTL 后重新探测（缓存会过期）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls()
    // 推进到 TTL 之后
    nowMs += 60_001
    await probe('buddy')
    expect(calls(), 'TTL 过后必须重新探测').toBeGreaterThan(afterFirst)
  })

  it('★ 不同渠道各自缓存（一个渠道的缓存不得顶替另一个）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    await probe('buddy')
    const afterBuddy = calls()
    await probe('workbuddy')
    expect(calls(), 'workbuddy 是另一个渠道，必须自己探一次').toBeGreaterThan(afterBuddy)
  })

  it('★ 中止**不得**被缓存（否则一次取消会让后续请求误命中）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    const controller = new AbortController()
    controller.abort()
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls(), '中止不该产生缓存条目').toBe(0)
    // 未中止的调用仍要正常工作（说明缓存没被中止污染）
    await probe('buddy')
    expect(calls()).toBeGreaterThan(0)
  })
})

/**
 * ★ 全部账号折算失败 ⇒ 必须 UNUSABLE，**不是** NEVER（真实缺陷，独立审计实测证伪）。
 *
 * ## 为什么这是**最高价值**的一条判据
 *
 * `NEVER` 的语义是「**可用**、只是不临期」（参与排序、**可当选**），
 * `UNUSABLE` 的语义是「剔除」。而「所有账号都查不到额度」= 我们对这个渠道的
 * **额度一无所知** ⇒ 必须剔除。
 *
 * ⚠️ 模块头自己写着铁律：「未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，
 * 不可把未知当可用。**」而旧实现在「全部账号折算失败」时返回 `NEVER` ——
 * 与这条铁律**直接矛盾**。
 *
 * 后果（审计实测）：buddy 有 2 个已登录账号、上游余额接口 5xx（或 token 全过期）
 * ⇒ 该渠道被判「可用、只是不临期」⇒ 进入排序且**可当选** ⇒ 请求被发到一个
 * 额度未知（可能已用尽）的渠道。而且该错误值还会被缓存 60 秒。
 */
describe('★ 全部账号折算失败 ⇒ UNUSABLE（不能把「不知道」当「可用」）', () => {
  const poolWith = (credentials) => ({
    disabledModelsFor: () => new Set(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  })

  it('★ 两个账号都查失败 ⇒ UNUSABLE（不是 NEVER）', async () => {
    // 上游一律 5xx ⇒ `fetchCreditBalance` 返回 null ⇒ `buddyExpiry` 返回 UNUSABLE
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    const probe = createExpiryProbe(
      poolWith([{ access_token: 't1' }, { access_token: 't2' }]),
      async () => 'm1',
    )
    const value = await probe('buddy')
    expect(value, '全部账号都查不到 ⇒ 必须剔除，不能判成「可用但不临期」').toBe(UNUSABLE)
    // ⚠️ 本断言本意是「**不是** `NEVER`」。
    //    我第一版写成 `expect(Number.isFinite(value)).toBe(false)` —— **写反了**：
    //    `UNUSABLE = -1` 是**有限数**（`Number.isFinite(-1) === true`），
    //    而 `NEVER = Infinity` 才是非有限。故判据应是「值不等于 `NEVER`」。
    expect(value, '绝不能是 NEVER（Infinity）').not.toBe(NEVER)
  })

  it('★ 单个账号查失败（同一条路径的另一形态）⇒ 也是 UNUSABLE', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1')
    expect(await probe('buddy')).toBe(UNUSABLE)
  })

  it('★ 对照：一个账号成功 ⇒ 取它的值（不能因另一个失败就整渠道剔除）', async () => {
    // 第 1 个账号 5xx、第 2 个成功 ⇒ 取成功那个的到期时刻
    const soon = Date.now() + 86_400_000
    let call = 0
    vi.stubGlobal('fetch', (async () => {
      call += 1
      if (call === 1) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: soon },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const probe = createExpiryProbe(
      poolWith([{ access_token: 't1' }, { access_token: 't2' }]),
      async () => 'm1',
    )
    expect(await probe('buddy')).toBe(soon)
  })
})

/**
 * ★ `clear()` 必须真的清空缓存（真实缺陷：缓存原无任何失效通道）。
 *
 * 无失效通道的后果：**刚登录**（或限流刚解禁）的账号在**最长 60 秒内对路由不可见**，
 * 用户拿到误导性的 `MISSING_CREDENTIAL | …没有任何可用候选`（明明刚登录成功）。
 */
describe('★ 临期缓存必须可清空（账号变化时由装配层调用）', () => {
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  }) as never

  it('★ 清空后必须重新探测（不再命中旧值）', async () => {
    let nowMs = 1_000_000
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls
    // TTL 内再探 ⇒ 命中缓存
    await probe('buddy')
    expect(calls).toBe(afterFirst)
    // ★ clear() 之后 ⇒ 必须重新探（这就是「刚登录账号立刻可见」的保证）
    probe.clear()
    await probe('buddy')
    expect(calls, 'clear() 之后必须重新探测').toBeGreaterThan(afterFirst)
  })

  it('★ clear() 后可复用于多个渠道（清全部，不是只清一个）', async () => {
    let nowMs = 1_000_000
    const calls: string[] = []
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async (p: string) => { calls.push(p); return 'm1' }, {
      now: () => nowMs,
    })
    await probe('buddy')
    await probe('workbuddy')
    const after = calls.length
    probe.clear()
    await probe('buddy')
    await probe('workbuddy')
    expect(calls.length, '两个渠道都要重新取号（clear 是清全部）').toBeGreaterThan(after)
  })
})

/**
 * ★ `clear()` 必须挡住**在途探测**（真实缺陷，对抗审计实测证伪）。
 *
 * ## 机制
 * `cacheAndReturn` 在探测**结束时**无条件写缓存。若一个探测**早在 `clear()` 之前**
 * 就已开始（正卡在 `await` 上），它的写回发生在 `clear()` **之后** ⇒
 * **陈旧值活过整个 TTL**（用户「清缓存」的努力被一个在途请求作废）。
 *
 * 对抗审计实测：
 * ```
 * clear() 期间在途探测: -1 ｜ clear 后再探: -1 ｜ 取号次数: 1
 * ```
 * ⇒ 登录后清缓存，但那个「登录前开始、登录后才结束」的探测把 `-1`（不可用）
 * 又写了回去，用户仍要再等 60 秒。
 *
 * ## 修法
 * **代际计数**：`clear()` 递增代际，探测在**开始时**记下代际，写回时代际不符
 * 就**丢弃**（不写缓存）。
 */
describe('★ clear() 必须挡住在途探测（陈旧值不得活过 clear）', () => {
  it('★ 在 clear() 之前开始、之后结束的探测，不得写回缓存', async () => {
    let nowMs = 1_000_000
    let releaseSlow
    const slowGate = new Promise((resolve) => { releaseSlow = resolve })
    let calls = 0

    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => {
        calls += 1
        if (calls === 1) {
          // 第一个探测：卡住（模拟「在途」）
          await slowGate
        }
        return [{ entry: { id: 'a1' }, credential: { access_token: 't' } }]
      },
    } as never

    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })

    // ① 启动一个探测（它会卡在 slowGate 上 —— 尚未写缓存）
    const inFlight = probe('buddy')
    // ② 让它推进到 await（微任务队列）
    await Promise.resolve()
    // ③ 此时 clear()（模拟「用户刚登录」）
    probe.clear()
    // ④ 放行那个在途探测
    releaseSlow!(undefined)
    await inFlight

    // ⑤ 现在**重新探测**：必须真的去打上游（不能被在途探测写回的旧值命中）
    const before = calls
    await probe('buddy')
    expect(calls, '★ 在途探测不得写回缓存 ⇒ 此处必须重新取号（= 重新探测）')
      .toBeGreaterThan(before)
  })

  it('★ 对照：clear() 之后的正常探测仍要写缓存（TTL 语义不能被破坏）', async () => {
    let nowMs = 1_000_000
    let calls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => {
        calls += 1
        return [{ entry: { id: 'a1' }, credential: { access_token: 't' } }]
      },
    } as never
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    await probe('buddy')
    const afterFirst = calls
    await probe('buddy')
    expect(calls, 'TTL 内应命中缓存').toBe(afterFirst)
  })
})
