import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ACCOUNT_TEST_CAPABILITIES,
  CREDITS_CAPABILITIES,
  PERMANENT_LOCK_EXPIRING_WINDOW_DAYS,
  RATE_LIMIT_CAPABILITIES,
  checkinProviders,
  permanentLockCopy,
  supportsAccountTest,
  supportsCreditBalance,
  supportsDailyCheckin,
  supportsOnboardingTasks,
  supportsPermanentLock,
  supportsRateLimit,
  supportsSubscriptionQuota,
} from '../../plugin-src/client/credits-capabilities.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { BUDDY_EXPIRING_WINDOW_DAYS } from '../../src/buddy-balance-rank.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { LOOMY } from '../../src/loomy-product.js'
import { TRAE } from '../../src/trae-product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Jet Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [jet-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而当时该端点以 `productById()` 判能力，CodeArts 根本
 * 不是 BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（尤其 WorkBuddy 余额真/签到假、未登记项默认关闭）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 *
 * 注：CodeArts 后来已接入真实实现（`src/codearts-credits.ts`，华为云签名），
 * 故其能力由全假变为全真；**门控机制本身不变**，仍是防止「对不支持的
 * provider 发必然失败的请求」的那道闸。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 余额与签到都支持（华为云 SDK-HMAC-SHA256 签名协议）', () => {
    // 华为云走 `snap-access` 的签名端点，与腾讯系协议完全不同源，
    // 但**能力上两项都具备**（见 src/codearts-credits.ts）。
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('codearts')).toBe(true)
    expect(supportsDailyCheckin('codearts')).toBe(true)
  })

  it('CodeBuddy 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(true)
  })

  it('WorkBuddy 国际版支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('workbuddy')).toBe(true)
    expect(supportsDailyCheckin('workbuddy')).toBe(false)
  })

  /**
   * ⚠️ **能力表与宿主端守卫必须成对**（真实缺陷，2026-10-02 补）。
   *
   * 客户端因为能力表写着 `dailyCheckin: false` 而从不调用 `credits.claimAll
   * ({ provider: 'workbuddy' })`，所以宿主那条分支**一直没有守卫也没人发现**：
   * 它原本会落到 `productById('workbuddy')` 拿到的 buddy 产品上，用**国际版**
   * 凭据去发国内版的签到请求 —— 必然失败，而且是一次**真实的上游请求**。
   *
   * 触发它的是新增的「每日首次启动自动签到」（`src/auto-checkin.ts`）：那个执行体
   * **刻意不维护第二份能力名单**，只按 `claimAll` 返回的信封判「跳过」，所以
   * 宿主漏一个守卫，它就会真去发一轮必然失败的请求。⇒ 两处必须成对存在。
   *
   * ⚠️ 为什么用源码扫描：`registerJetHubRpc` 是 12 个**位置参数**，在测试里逐个
   * 填替身既脆弱又与 `jet-hub-rpc.spec.ts` 的桩重复 —— 与本仓库
   * `raccoon-rpc-dispatch.spec.ts` 对同类守卫的做法一致。
   */
  it('宿主端 credits.claimAll 对 workbuddy 有显式守卫（与能力表成对）', () => {
    // ⚠️ 本文件里的 `here` 是**块内局部**变量（另有几处各写各的），这里自解析一次。
    const specDir = dirname(fileURLToPath(import.meta.url))
    const rpcSource = readFileSync(resolve(specDir, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpcSource).toContain("if (req.provider === 'workbuddy') {")
    expect(rpcSource).toContain('WorkBuddy 国际版不支持每日签到')
    // 守卫必须**早于** `productById` 兜底：否则会走到 buddy 产品分支真发请求
    const guardAt = rpcSource.indexOf("if (req.provider === 'workbuddy') {")
    const claimAllAt = rpcSource.indexOf("case 'credits.claimAll'")
    expect(claimAllAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(claimAllAt)
    // 该守卫的返回块里不能出现真实调用（只能是 ok:false 的信封）
    const guardBlock = rpcSource.slice(guardAt, guardAt + 700)
    expect(guardBlock).toContain('ok: false')
    expect(guardBlock).not.toMatch(/collectClaimResults|await /)
  })

  it('Qoder 两项能力都有（余额 + 每日领取）', () => {
    // ⚠️ 早期把 qoder 误判为「两项皆无」，随后又误判为「有余额、无签到」，
    // 两次都值得记录：
    //
    // ① 余额：只按 `/api/` 前缀搜端点，而它挂在 `/sash/api/v2/me/usage`，
    //    且**只需 Bearer + Cosy-ClientType**（不需要模型列表那样的 WASM 签名）。
    // ② 签到：曾依据 `/sash/api/v1/me/campaigns` 返回 `claimable:false,
    //    campaigns:[]` 判定「没有签到端点」。真相是**那天已领** ——
    //    活动每日 10:00（UTC+8）刷新。2026-09-21 用 keylog 解密抓包拿到了
    //    领取端点（`POST …/{campaignId}/claim`）与幂等证据（`replayed:true`）。
    //
    // 教训：「某次实测没看到」不能推广成「不存在」。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('Qoder 中国版：余额与签到都支持，与国际版同形', () => {
    // 依据（设计文档 E7/E10）：CN 的 `/sash/api/v2/me/usage` 与
    // `/sash/api/v1/me/campaigns` 零凭据实测返回 `401 {"code":"TOKEN_INVALID",
    // "message":"missing authorization token"}`，与国际版**逐字节同形**；
    // CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`。
    //
    // ⚠️ 「端点存在」不等于「活动一定下发」—— 真实领取由
    // `pnpm test:e2e:qodercn-credits` 验证。若将来确认 CN 无签到，改这里时
    // 必须换成强证据（扫 CN asar 无 claim 端点），**不要**写「某次没看到」
    // —— 上面那条 qoder 用例的教训正是这样来的。
    expect(CREDITS_CAPABILITIES.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qodercn')).toBe(true)
    expect(supportsDailyCheckin('qodercn')).toBe(true)
  })

  it('中国版出现在一键签到的遍历渠道里（由能力表推导，非硬编码）', () => {
    // 页头「一键签到」遍历 `checkinProviders()`；漏登记的表现是
    // 「新渠道永远不被签到」，而不是报错 —— 故必须显式断言在里面。
    expect(checkinProviders()).toContain('qodercn')
    // 顺序紧跟国际版（本表声明顺序即请求顺序）。
    expect(checkinProviders().indexOf('qodercn')).toBe(checkinProviders().indexOf('qoder') + 1)
  })

  it('Loomy 三项能力：余额 + 每日签到 + 新手任务', () => {
    expect(CREDITS_CAPABILITIES.loomy)
      .toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
    expect(supportsCreditBalance('loomy')).toBe(true)
    expect(supportsDailyCheckin('loomy')).toBe(true)
    expect(supportsOnboardingTasks('loomy')).toBe(true)
  })

  /**
   * ⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立**，不能互相推断：
   * - `dailyCheckin` = 每日额度刷新（每天有收益）
   * - `onboardingTasks` = 新手任务 10000 分（**一次性**，每号只能领一次）
   * 故只有 Loomy 同时具备两者，其余 provider 的 onboardingTasks 必须为 false。
   */
  it('onboardingTasks 只对 Loomy 为 true（新手任务是一次性的）', () => {
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'trae', 'cline']) {
      expect(supportsOnboardingTasks(id), `${id} 不应支持新手任务`).toBe(false)
    }
  })

  it('未登记的 provider 的 onboardingTasks 默认关闭', () => {
    for (const unknown of ['', 'newprovider', '__proto__']) {
      expect(supportsOnboardingTasks(unknown), unknown).toBe(false)
    }
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
      expect(supportsSubscriptionQuota(unknown), unknown).toBe(false)
    }
  })

  /**
   * ⚠️ **订阅额度目前只登记给 Cline**，这是与后端的硬约定：
   * `src/jet-hub-rpc.ts` 的 `cline.quota` / `cline.requestLog` 对非 Cline
   * 一律回 `bad-request`。前端若多登记一家，用户就会看到一个点了必然报错的
   * 按钮（与 CodeArts 早期 `credits.balances` 那次是同一类缺陷）。
   *
   * 「只给 cline」用**全表推导**而不是逐个列举：将来新增渠道时，
   * 若有人顺手也登记了 `subscriptionQuota`，这条会立刻变红，
   * 迫使他同时改后端分派（否则就是死按钮）。
   */
  it('订阅额度只登记给 cline（其余渠道不得渲染该按钮）', () => {
    const withQuota = Object.keys(CREDITS_CAPABILITIES).filter(supportsSubscriptionQuota)
    expect(withQuota).toEqual(['cline'])
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'raccoon']) {
      expect(supportsSubscriptionQuota(id), `${id} 不应支持订阅额度`).toBe(false)
    }
  })

  /**
   * ⚠️ 三个能力**语义独立，不能互相推断**：
   * Cline 是「有余额、有订阅额度、**无**签到」；Loomy 是「有余额、有签到、
   * 无订阅额度」。任一为 true 都不蕴含另一个 —— 把它们合并成一个标志
   * 会让「Cline 面板冒出签到按钮」或「Loomy 面板冒出额度按钮」。
   */
  it('订阅额度与余额/签到彼此独立（不能互相推断）', () => {
    expect(supportsCreditBalance('cline')).toBe(true)
    expect(supportsSubscriptionQuota('cline')).toBe(true)
    expect(supportsDailyCheckin('cline')).toBe(false)
    // 反向：Loomy 有签到、无订阅额度。
    expect(supportsDailyCheckin('loomy')).toBe(true)
    expect(supportsSubscriptionQuota('loomy')).toBe(false)
  })

  it('能力矩阵覆盖 PROVIDERS 中的每一个 provider', () => {
    // 客户端 PROVIDERS 列表与能力表必须同步：漏登记的 provider 会静默失去
    // 积分能力（默认关闭），而多登记的条目则是死配置。
    const source = readClientSource()
    const providerIds = [...source.matchAll(/\{\s*id:\s*'([a-z]+)',\s*label:/g)].map((m) => m[1]!)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })
})

/**
 * ⚠️ **模型限流按钮门控**（Gemini 报障，2026-10-03）。
 *
 * 用户原话：「重测按钮你确认过会发请求吗，为什么响应这么快？可以移除吗」。
 * 取证结论：当时该账号条目**没有 `modelRateLimits` 标记**，
 * `retestAccount` 在 `modelIds.length === 0` 处提前返回 ⇒ 一次请求都没发，
 * 所以「响应快」。但这不代表按钮无害：Gemini 的限流是**服务端配额窗口制**
 * （5 小时窗口 + 周窗口），本地标记清掉、重测通过，配额一点没恢复 ——
 * 「重测」只会白烧本就紧张的窗口配额，「重置」只会把受限账号放回池里再撞 429。
 * 故与 Loomy 同处登记 `false`（**理由不同**，见
 * {@link RATE_LIMIT_CAPABILITIES} 的注释）。
 */
describe('模型限流按钮门控（重测 / 重置）', () => {
  it('gemini 显式登记为「限流不由这组按钮管辖」', () => {
    expect(RATE_LIMIT_CAPABILITIES.gemini?.rateLimit).toBe(false)
    expect(supportsRateLimit('gemini')).toBe(false)
  })

  it('未登记的 provider 仍默认视为有限流（不得因新增登记而收紧默认值）', () => {
    // 反例：任何未登记的 id 都必须保持 true，否则将来新增 provider 漏登记时
    // 老用户会凭空失去「重测 / 重置」按钮 —— 那是可见的功能回退。
    expect(supportsRateLimit('codearts')).toBe(true)
    expect(supportsRateLimit('zcode')).toBe(true)
    expect(supportsRateLimit('不存在的 provider')).toBe(true)
  })

  it('登记 false 的都是「按钮语义管辖不到」的渠道（当前恰好两个）', () => {
    const disabled = Object.entries(RATE_LIMIT_CAPABILITIES)
      .filter(([, caps]) => caps.rateLimit === false)
      .map(([id]) => id)
      .sort()
    // loomy：根本不返回限流错误；gemini：限流是服务端配额窗口制。
    expect(disabled).toEqual(['gemini', 'loomy'])
  })

  it('客户端源码里按钮仍走 supportsRateLimit 门控（不是在本文件另写白名单）', () => {
    // 与 loomy-client.spec.ts 同源断言，这里补上「不得复辟硬编码 provider 判断」。
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('showRateLimitActions: supportsRateLimit(provider)')
    expect(codeLines).not.toMatch(/showRateLimitActions:\s*provider\s*!==/)
  })
})

/**
 * ⚠️ **「测试」按钮的能力门控**（用户 m03338：「增加测试按钮，真实的发一次请求」）。
 *
 * 与「重测」的硬性区别是**触发条件**：重测只测已有 `modelRateLimits` 标记的
 * 模型，没有标记时零请求；测试不看标记、无条件真发一次。因此两者必须用
 * **独立**的能力位与 props 开关 —— 当前 Gemini 恰好只登记测试、没登记重测，
 * 若绑在同一个开关上就会二选一地消失一个按钮。
 */
describe('账号「测试」按钮门控', () => {
  it('gemini 登记为支持测试', () => {
    expect(ACCOUNT_TEST_CAPABILITIES.gemini?.test).toBe(true)
    expect(supportsAccountTest('gemini')).toBe(true)
  })

  it('未登记的 provider 一律不渲染（默认关闭，与限流表相反）', () => {
    // ⚠️ 默认必须是 false：这是**全新**按钮，没有存量用户，未验证的渠道不该出现。
    expect(supportsAccountTest('codearts')).toBe(false)
    expect(supportsAccountTest('zcode')).toBe(false)
    expect(supportsAccountTest('loomy')).toBe(false)
    expect(supportsAccountTest('不存在的 provider')).toBe(false)
  })

  it('客户端源码里「测试」走独立开关，不挂在 showRateLimitActions 上', () => {
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('onTest: supportsAccountTest(provider)')
    // 反例：把测试绑到限流开关上会让 Gemini 拿不到按钮（它登记的是 false）。
    expect(codeLines).not.toMatch(/onTest:\s*showRateLimitActions/)
    expect(codeLines).not.toMatch(/onTest:\s*supportsRateLimit/)
  })

  it('「测试」的结果汇总与「重测」分开写（响应结构不同）', () => {
    // account.test 返回扁平 { modelId, ok, message }，没有 accounts/clearedCount。
    // 若拿它去喂 summarizeProbe，会得到「没有可重测的限流标记」——
    // 把「测试失败」误报成「没什么可测的」。
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('function summarizeTest(res)')
    expect(codeLines).toContain('summarizeTest(res)')
  })
})

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    // ⚠️ 窗口不能太窄：函数头部现在依次有「能力守卫 → 重入闸门（claimInFlightRef）
    // → 提示文案」三段（复审 !62 加的重入闸门），把 claimAll 调用推到了 700 字符
    // 之外。原窗口 600 因此假失败 —— 判据本身（守卫在调用之前）仍成立，
    // 只是插入的守卫把距离撑大了（与下方 AccountCard 那条「窗口不能只取 4000」
    // 是同款维护问题）。
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {
    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    expect(normalized).toMatch(/canLoadCredits\s*\n\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用
    // ⚠️ 窗口不能只取 4000：账号名 hover（packageTooltip / accountTitle）的
    // 计算代码插在函数头部与 CreditBalanceRow 渲染之间，把间距撑大了。
    const cardStart = normalized.indexOf('function AccountCard(')
    const cardBody = normalized.slice(cardStart, cardStart + 8000)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })

  /**
   * 领取结果必须逐账号显示**原因**，不能只给计数。
   *
   * 真实教训：CodeArts 的领取曾因「数字 campaignId 被当成字符串解析」而
   * 全部失败，但 UI 只显示「1 个失败」，用户与排查者都无从判断是凭据问题、
   * 活动未开、还是解析 bug —— 只能靠翻代码 + 抓包定位。
   * 后端一直返回 `results[].outcome.message`，前端不该把它丢掉。
   */
  it('claimCredits 汇总逐账号原因并在面板渲染', () => {
    const normalized = source.replace(/\r\n/g, '\n')
    const start = normalized.indexOf('const claimCredits = async () => {')
    expect(start).toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 3000)
    // 必须读取 results（而不只是 summary）
    expect(body, 'claimCredits 未消费 results').toContain('results')
    // 必须为失败条目带上 outcome.message
    expect(body).toContain('outcome.message')
    // 必须把 details 交给 notice
    expect(body).toContain('details')
    // 渲染层必须真的消费 claimNotice.details
    const renderStart = normalized.indexOf('claimNotice\n')
    expect(renderStart).toBeGreaterThan(-1)
    const renderBody = normalized.slice(renderStart, renderStart + 900)
    expect(renderBody, 'claimNotice 的 details 未被渲染').toContain('claimNotice.details')
    expect(renderBody).toContain('dim-jh-probeDetails')
  })
})

/**
 * ⚠️ **「锁定永久积分」能力面**。
 *
 * 这里最重要的是**前后端一致**：前端决定按钮是否出现、请求是否发出，
 * 后端决定写入是否被接受。两边不一致就是「按钮出现了但点了报 bad-request」
 * 或「功能存在却点不出来」—— 两种都比"没这个功能"更难解释。
 */
describe('永久积分锁定能力', () => {
  /**
   * 支持锁定永久积分的 provider（与后端白名单同一份事实）。
   *
   * ⚠️ 2026-10-06 新增 TRAE（字节）与 LobsterAI（有道）：它们的余额响应带逐包
   * 到期时间（TRAE 的条目级 `expire_time`、LobsterAI 的 `expiresAt`），
   * 归一化到 `deductionEndTime` 后即可用同一个 `splitBuddyCreditsByExpiry` 分桶。
   */
  const SUPPORTED = [LOOMY.id, CODEBUDDY.id, WORKBUDDY.id, TRAE.id, LOBSTERAI.id]
  const UNSUPPORTED = [
    'codearts', 'qoder', 'qodercn', 'cline', 'raccoon',
  ]

  it('前后端的支持面完全一致（逐个 provider 对账）', () => {
    for (const id of SUPPORTED) {
      expect(supportsPermanentLock(id), `${id} 应支持`).toBe(true)
      expect(PERMANENT_LOCK_PROVIDERS.has(id), `${id} 后端应放行`).toBe(true)
    }
    for (const id of UNSUPPORTED) {
      expect(supportsPermanentLock(id), `${id} 不应支持`).toBe(false)
      expect(PERMANENT_LOCK_PROVIDERS.has(id), `${id} 后端应拒绝`).toBe(false)
    }
    // 白名单不得有多余项：前端不渲染却后端放行 = 死接口
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual([...SUPPORTED].sort())
  })

  /**
   * ⚠️ 窗口天数必须**前后端同一个值**。前端只做展示，判据在后端；
   * 数字写岔会让用户看到「提示说只烧 8 天内的，实际按 15 天筛号」。
   */
  it('前端窗口常量与后端 BUDDY_EXPIRING_WINDOW_DAYS 相同', () => {
    expect(PERMANENT_LOCK_EXPIRING_WINDOW_DAYS).toBe(BUDDY_EXPIRING_WINDOW_DAYS)
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
  })

  /**
   * ⚠️ 文案必须用**后端回传的窗口天数**渲染，而不是前端那个常量。
   *
   * 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖（实测 CodeBuddy 中国版的
   * 积分包剩余密集落在 17～30 天，默认 15 天会让整池判成永久）。前端写死数字
   * 就会出现「提示说只烧 15 天内的，实际按 31 天筛号」这种无法解释的偏差。
   */
  it('permanentLockCopy 采纳后端回传的窗口天数', () => {
    expect(permanentLockCopy(CODEBUDDY.id, 31).lockTitle).toContain('31 天内到期')
    expect(permanentLockCopy(WORKBUDDY.id, 31).unlockedNotice).toContain('31 天内到期')
    expect(permanentLockCopy(CODEBUDDY.id, 31).days).toBe(31)
    // 缺省时回落到默认常量（面板初次渲染、后端未回传时不能说谎说没窗口）
    expect(permanentLockCopy(CODEBUDDY.id).days).toBe(PERMANENT_LOCK_EXPIRING_WINDOW_DAYS)
    expect(permanentLockCopy(CODEBUDDY.id, undefined).days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, null).days).toBe(15)
    // ⚠️ 0 是合法值（「没有临时积分」），不能被 `||` 吞成默认值
    expect(permanentLockCopy(CODEBUDDY.id, 0).days).toBe(0)
    expect(permanentLockCopy(CODEBUDDY.id, 0).lockedNotice).toContain('0 天内到期')
    // 非法值回落默认，不渲染出 NaN
    expect(permanentLockCopy(CODEBUDDY.id, -1).days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, 'abc').days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, 15.6).days).toBe(16)
    // Loomy 没有窗口概念：不受该参数影响
    expect(permanentLockCopy(LOOMY.id, 31).days).toBeNull()
    expect(permanentLockCopy(LOOMY.id, 31).lockedNotice).toContain('每日赠送额度')
  })

  it('未登记的 provider 一律不支持（默认关闭）', () => {
    expect(supportsPermanentLock(undefined)).toBe(false)
    expect(supportsPermanentLock('')).toBe(false)
    expect(supportsPermanentLock('loomy-old')).toBe(false)
  })

  describe('permanentLockCopy 的按 provider 文案', () => {
    /**
     * 把 Loomy 的「每日赠送额度」套到两个 buddy 上是**实质性误导**：
     * 它们没有每天刷新的额度池，签到得来的也是 14/30 天后到期的包。
     */
    it('buddy / workbuddy 说「N 天内到期」，不说「每日赠送」', () => {
      for (const id of [CODEBUDDY.id, WORKBUDDY.id]) {
        const copy = permanentLockCopy(id)
        expect(copy.lockTitle).toContain('15 天内到期')
        expect(copy.lockedTitle).toContain('15 天内到期')
        expect(copy.lockedNotice).toContain('15 天内到期')
        expect(copy.unlockedNotice).toContain('15 天内到期')
        expect(copy.lockTitle).not.toContain('每日赠送')
        expect(copy.lockedNotice).not.toContain('今日额度')
      }
    })

    it('loomy 仍说「每日赠送额度」（它是当日到期的池，与 buddy 不同）', () => {
      const copy = permanentLockCopy(LOOMY.id)
      expect(copy.lockedNotice).toContain('每日赠送额度')
      expect(copy.unlockedNotice).toContain('永久积分')
      expect(copy.lockTitle).not.toContain('天内到期')
    })

    it('四个文案位都齐（面板直接取用，缺一个就渲染出 undefined）', () => {
      for (const id of [...SUPPORTED, 'codearts']) {
        const copy = permanentLockCopy(id)
        for (const key of ['lockTitle', 'lockedTitle', 'lockedNotice', 'unlockedNotice']) {
          expect(typeof copy[key], `${id}.${key}`).toBe('string')
          expect(copy[key].length, `${id}.${key} 不能为空`).toBeGreaterThan(0)
        }
      }
    })

    it('未登记的 provider 回落到 Loomy 口径而不是崩（面板共用同一段代码）', () => {
      expect(permanentLockCopy('codearts').lockedNotice).toContain('每日赠送额度')
    })
  })
})

/**
 * ⚠️ **客户端源码不得有未声明变量**（真实事故，2026-09-29）。
 *
 * ## 事故经过
 *
 * 给积分行加「当日池分桶」时在 `AccountCard` 里写了
 * `provider === 'loomy' ? '永久' : '长期'`，但**忘了把 `provider` 加进该组件的
 * props 解构**。后果不是显示错，而是**整个 Jet Hub 设置页崩成白屏**：
 *
 * ```
 * ReferenceError: provider is not defined
 *     at AccountCard (client.js:926:1)
 * slot entry crashed in 'settings.section'
 * ```
 *
 * ## 为什么既有测试全绿却漏掉了
 *
 * 本仓库对 `plugin-src/client/*.js` 的测试几乎都是**源码字符串匹配**
 * （`expect(hubSource).toContain('…')`）—— 它们只能证明"某段文字存在"，
 * 证明不了"这段代码能跑"。而 `plugin-src/client/` 是**纯 JS**，`tsc -p
 * tsconfig.json` 只编译 `src/`（TS），**根本不看它**；esbuild 打包也不做
 * 未声明变量检查（它只做语法解析，`provider` 是合法标识符）。
 *
 * 于是这类错误唯一的发现时机就是**用户打开桌面版**。
 *
 * ## 这道闸的做法
 *
 * 用 `tsc --checkJs` 扫客户端源码，**只筛未声明变量两类诊断**
 * （`TS2304` 找不到名称 / `TS2552` 找不到名称但给出相似建议）。
 * 不筛其它诊断 —— 客户端 JS 没有类型标注，全量 `checkJs` 会产出大量
 * JSDoc 风格与第三方类型噪音（实测 `react` 类型缺失、`@param {object}` 写法等），
 * 那些不是我们要防的东西，混进来只会让人把这道闸关掉。
 *
 * ⚠️ 配置在仓库根的 `tsconfig.client-check.json`。
 * ⚠️ 已做**反向验证**：把 `provider` 从 `AccountCard` 的参数里去掉，
 * 本条会以 `TS2552: Cannot find name 'provider'` 变红。
 */
describe('客户端源码静态检查（防未声明变量崩页面）', () => {
  it('plugin-src/client 下没有未声明变量（TS2304 / TS2552）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = resolve(here, '../..')
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.client-check.json')],
      { cwd: root, encoding: 'utf8' },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // 只保留「找不到名称」两类：其余诊断（JSDoc 风格、第三方类型）不是本闸的目标。
    const undeclared = output
      .split('\n')
      .filter((line) => /error TS(2304|2552):/.test(line))
    expect(
      undeclared,
      `客户端源码有未声明变量，会在桌面版运行时抛 ReferenceError 并崩掉整个设置页：\n${undeclared.join('\n')}`,
    ).toEqual([])
  }, 120_000)
})
