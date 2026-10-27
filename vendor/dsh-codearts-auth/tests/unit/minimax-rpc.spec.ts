import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MINIMAX } from '../../src/minimax-product.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'
import { accountEntry, refreshHarness } from '../helpers/rpc-refresh.js'

/**
 * Task 6（接线）的回归防线。
 *
 * ⚠️ 本任务是**接线**：真正的行为验证靠 `pnpm typecheck`（接线漏一处即
 * 类型错或实参数量不符）与全量单测。完整 RPC 行为测试要构造 cordis Context
 * 与账号池替身，成本高且**既有九个 provider 也未对 RPC 层做单测** ——
 * 遵循既有惯例，不为本 provider 单独引入。
 *
 * 但接线类改动有一个**类型检查抓不到**的失效模式：接线点**漏接**或**串接**
 * （改错 provider 常量、忘了在某个分派表加一行）。故这里用源码断言锁住
 * 「每个分派点都真的有 minimax」—— 这类断言在既有仓库里已有先例
 *（见 `tests/unit/raccoon-client-independence.spec.ts` 等同型防线）。
 */
/**
 * 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。
 *
 * ⚠️ **必须剥**：本仓库的注释里经常**逐字写出反模式**（例如
 * 「不是 `available.id` / `available.credentialRef`」），若不剥离，
 * 针对反模式的 `not.toMatch` 会命中注释本身而**恒假失败**；
 * 反过来，注释里**逐字写出正模式**（例如 `wiredRefreshTargets()`）会让
 * `toMatch` 在真实调用被删掉后**仍然通过**。
 *（写这条用例时实测踩到前半段；Task 10 复审实测到后半段。）
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('RPC 分派常量', () => {
  it('⚠️ provider id 是 minimax（分派靠它匹配）', () => {
    expect(MINIMAX.id).toBe('minimax')
  })

  it('⚠️ 默认凭据 ref 是 POSIX 标识符（credentialRef 会做正则校验）', () => {
    expect(MINIMAX.defaultCredentialRef).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })
})

describe('接线点完整性（源码断言）', () => {
  const indexSource = stripComments(readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'))
  const rpcSource = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8')

  it('⚠️ index.ts 六处接线点齐全', () => {
    // 1. import MinimaxAuth
    expect(indexSource).toContain("from './minimax-auth.js'")
    // 2. settings namespace：⚠️ 2026-10-08 改。原先扫 index.ts 文本找 `'llm-minimax'`，
    //    本次重构把 13 个字面量收敛成从 `PROVIDER_REGISTRY` 派生 ⇒ 文本断言变红。
    //    改为断言声明值；「真的按它注册了」由 `provider-registry-consumers.spec.ts`
    //    的 `apply()` 行为用例守。
    expect(descriptorOf('minimax')?.settingsNamespace).toBe('llm-minimax')
    // 3. 服务实例 + 适配器注册
    expect(indexSource).toContain('new MinimaxAuth(ctx)')
    expect(indexSource).toContain('registerMinimaxLlm(ctx, {')
    // 4. refreshTargets 表
    // ⚠️ **2026-10-08 改（Task 10）**：原先断言 `src/index.ts` 的源码文本含手抄清单
    //    字面量（`['x', (p) => x.refreshAll(p)]`）—— 那张清单已被
    //    `wiredRefreshTargets()` 从**能力注册表**派生取代 ⇒ 该文本形态**不存在了**，
    //    而它守的意图（该 provider 在续期调度里）**与文本无关**。
    // ⇒ 改为**结构断言**（注册循环挂了 refreshAll + 派生表被使用）。
    // ⚠️ 行为断言（真跑 `apply()` 逐个驱动 `auth.refreshAll` 并断言打到**自己那个**
    //    实例）在 `provider-runtime-wiring.spec.ts` 的「★ 13 家都挂上了
    //    `auth.refreshAll`」一条里，**比本条更强**。
    expect(indexSource, '注册循环没有挂 refreshAll（派生表会恒为空）')
      .toMatch(/refreshAll:\s*\(pool\)\s*=>\s*auth\.refreshAll\(pool\)/)
    expect(indexSource, 'refreshTargets 又回到手抄清单了')
      .toMatch(/wiredRefreshTargets\(\)/)
    // 5. modelAdapters 登记
    expect(indexSource).toMatch(/minimax: pruned\([^)]*,\s*minimaxAdapter\)/)
    // 6. registerJetHubRpc 实参
    // ⚠️ 2026-10-08 改：原先这里断言**位置参数**的尾部顺序
    //    `/loomy, raccoon, minimax, zcode, gemini, modelAdapters/`。
    //    13 个形参改成**命名对象**后必然变红，而它守的意图（minimax 接上了）
    //    **与位置无关**。⇒ 改为断言**键存在**（键是 provider id）；
    //    「端到端分派真的落到 minimax 实例上」由行为用例守：
    //    `tests/unit/jet-hub-rpc-auth-wiring.spec.ts` 的
    //    「★★ 每个 provider id 的续期都分派到自己的 auth 实例」。
    //
    // ⚠️⚠️ **2026-10-08 复审 Finding 2：这里曾写成相邻性正则**
    //    `/\bminimax,\s*zcode,\s*gemini,/` —— 命名对象下**键的相邻关系零语义**：
    //    把这三个键重排成 `… zcode, gemini, minimax,`（逐字节等价的语义）会让它
    //    **假失败**，在中间插入任何新键同样假失败。⇒ 改为按 **AST** 取调用点
    //    第三个实参的属性名（见 `tests/helpers/jet-hub-auths.ts`）后断言键存在：
    //    重排 / 插键 / 换行 / 注释都不可能影响它，而**键真的漏了必然变红**。
    const authKeys = jetHubAuthsCallKeys(indexSource)
    expect(
      Object.keys(authKeys),
      'minimax 必须出现在 registerJetHubRpc 的 auths 命名对象里（键 = provider id）',
    ).toContain('minimax')
  })

  it('⚠️ index.ts 的 refresh 回调必须用两层结构（available.entry.*）', () => {
    // 这是「续期静默写不回账号池」的真实缺陷形态：写成 available.id /
    // available.credentialRef 会得到 undefined，UI 永远显示「已过期」。
    const code = stripComments(indexSource)
    const block = code.slice(code.indexOf('const minimax = new MinimaxAuth(ctx)'))
    const refreshPart = block.slice(0, block.indexOf('fetchRemoteModels'))
    expect(refreshPart).toContain('available.entry.credentialRef')
    expect(refreshPart).toContain('available.entry.id')
    // 反向：不得出现裸字段取法（注释已剥离，故命中即真问题）
    expect(refreshPart).not.toMatch(/available\.credentialRef\b/)
    expect(refreshPart).not.toMatch(/available\.id\b/)
  })

  it('⚠️ jet-hub-rpc.ts 的 minimax 真协议分支齐全（account.create）', () => {
    // account.create / credits.status / credits.claimAll / credits.balances
    //
    // ⚠️ 2026-10-08 改（Task 2）：原清单里的 `account.refresh` 已**不再**有
    //    `case MINIMAX.id:` —— 13 个同构 case 收敛成一处查表
    //    （`authOf(auths, entry.provider)`）。**实测确认**：Task 2 之前全仓库
    //    唯一的 `case MINIMAX.id:` 就在那个 switch 里，故该断言现在恒假。
    //    该端点的 minimax 续期由 `lobsterai-rpc-dispatch.spec.ts` 的行为用例守
    //    （从 `REFRESH_PROVIDERS` 派生，含 minimax）+ 下面那条串接用例。
    //
    // ⚠️⚠️ 2026-10-08 改（Task 3）：原先这里数 `provider === MINIMAX.id` 出现
    //    **四次**（account.create + 三个 credits 端点），并断言源码里含
    //    `fetchMinimaxSigninStatus(credential)` / `fetchMinimaxCreditBalance(credential)`。
    //    Task 3 把三个 credits 端点的分派收敛成查表 ⇒ 只剩 account.create 一处
    //    （实测 2 处：还有一处是注释锚点），那三条文本断言也**不存在了**。
    //    它们守的意图（minimax 的余额与签到状态接上了、且各走自己的原语）
    //    **与文本无关** ⇒ 行为断言搬到了唯一一处：
    //    `credits-runtime-parity.spec.ts` 的
    //    「★★ 逐家余额都走自己的上游端点」（minimax 的 credit/details）+
    //    「fetchStatus 只登记在真有同构状态端点的渠道上」（含 minimax）+
    //    「credits.status 走注入的 credits 表」。
    //    本文件只保留**本端点独有的**那处真协议分支。
    // ⚠️ 2026-10-15 改：加国际站后该分支收成「两个 id 合用一条」
    //    （`provider === MINIMAX.id || provider === MINIMAX_INTL.id`）——
    //    照 `qoderFamily` 的做法，**不复制**第二份分支体（复制会让
    //    「登录成功后回填哪些字段」修一处漏一处）。故这里的判据跟着换成
    //    「两个 id 都在这个条件里」：任何一个被删掉都红。
    expect(rpcSource, 'minimax 的 account.create 分支不见了')
      .toMatch(/\} else if \(provider === MINIMAX\.id \|\| provider === MINIMAX_INTL\.id\) \{/)
    expect(rpcSource, '分支内必须按同族表取 product/auth（不得写死 MINIMAX）')
      .toContain('requireMinimaxFamily(provider)')
    // ⚠️ 2026-10-08 改（Task 4）：原先断言 `jet-hub-rpc.ts` 的源码文本里含
    //    `claimMinimaxDailyCheckin(credential)`。Task 4 把领取调用搬进
    //    `src/provider-credits.ts` 的能力表 ⇒ 该文本**搬了家**，而它守的意图
    //    （minimax 的签到接上了、且走它自己的原语）**与文本无关**。
    //    ⇒ 改为读**表里的声明值**（真实现已由 `credits-runtime-parity.spec.ts` 的
    //    「fetchStatus 只登记在真有同构状态端点的渠道上」与
    //    `claim-runtime-parity.spec.ts` 的端点级行为用例覆盖）。
    expect(createProviderCredits().minimax?.claim, 'minimax 的签到没有接上').toBeTypeOf('function')
    // ⚠️ 它的预检走**自己**的状态端点（`fetchStatus`），而不是另立一份 claimStatus
    //    —— 两处声明同一实现必然漂移。
    expect(createProviderCredits().minimax?.fetchStatus, 'minimax 的状态端点没有接上').toBeTypeOf('function')
    expect(createProviderCredits().minimax?.claimStatus, 'minimax 不该另立一份 claimStatus').toBeUndefined()
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条切出 `case MINIMAX.id:` 后 400 字符，
   * 断言里面是 `minimax.refreshAccountCredential`、且**不是**
   * `raccoon.refreshAccountCredential` —— 一条**源码文本**断言。
   *
   * 它守的缺陷形态（「CN 那次中国版账号的刷新去续了国际版凭据」）是**真实**的，
   * 故**不能**只是删掉：改为**行为**断言 —— 用 `refreshHarness` 给 13 个 provider
   * 各装一个桩，驱动 minimax 账号的续期，断言**恰好 minimax 的桩**被调用。
   * 这比文本强：文本只能证明源码里有那串字符，行为能证明实参真的落到了 minimax 上。
   */
  it('⚠️ minimax 账号的续期**恰好**落到 minimax 桩上（不得串到 raccoon 等）', async () => {
    const target = accountEntry('minimax', 'MINIMAX_ACCOUNT_ISO')
    const harness = refreshHarness([target])
    const result = await harness.call(target.id)
    expect(result.ok, `minimax 续期应成功，实际 error=${result.error?.message}`).toBe(true)
    // 判据是「恰好一个调用，且 provider === 'minimax'」——串到任何别家都会红。
    expect(harness.calls.map((c) => c.provider)).toEqual(['minimax'])
    expect(harness.calls[0]?.ref).toBe('MINIMAX_ACCOUNT_ISO')
  })
})
