import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autoBadgeName, expiryCountdownText, shortProviderName } from '../../plugin-src/client/badge-model.js'
import { resolveAutoBadgeRewrite } from '../../src/auto-badge.js'

/**
 * 造一个 `AutoBadgeState` 桩（只实现被测路径需要的方法）。
 *
 * ⚠️ 这正是「逻辑与 IO 分离」的收益：宿主判定现在可以**行为断言**
 *（喂不同的状态，断言改写结果），而不是对源码做字符串断言 ——
 * 后者对「短路禁用」免疫（把实现改成 `if (false && …)` 后照样绿）。
 */
function makeState({
  lastDecision = null,
  lastWinnerExpiryAt = undefined,
  onSelect = () => undefined,
  prices = {},
} = {}) {
  return {
    lastDecision,
    lastWinnerExpiryAt,
    selectProvider: async () => onSelect(),
    priceOf: (provider, model) => prices[`${provider}\u0000${model}`],
  };
}

/**
 * 仓库根（源码级断言用）。
 *
 * ⚠️ **必须用 `fileURLToPath`，不能用 `URL.pathname`**（真实缺陷，Gitee issue
 * IKLBSH A3）：`pathname` 对路径里的空格做百分号编码（`%20`），而原先的
 * `replace(/^\/([A-Za-z]:)/, '$1')` 只修盘符、不修 `%20` ⇒ 含空格路径下
 * `readFileSync` 恒 ENOENT，症状是**整份 spec 收集失败**。
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 去掉注释后的源码。
 *
 * ⚠️ 反面断言必须基于它：本仓库的注释里**大量引用**被禁止/被说明的写法，
 * 直接对全文断言会把注释判成违规（既有 `usage-badge-client.spec.ts` 的
 * `codeOf` 同款，那里因这个坑红过两次）。
 */
const codeOf = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/**
 * 旧 auto（`jet-hub-auto`）的用量徽标链路 —— **上游回归的恢复回归测试**。
 *
 * ## 背景（真实报障 2026-10-08）
 *
 * 用户：「没倍率显示？也没胶囊了？」
 *
 * 上游 `ba10f4f` 把 auto 重写成 aggregate 体系时，把**旧 auto 的整套徽标支持
 * 删干净了**：
 * - `src/auto-adapter.ts`：删掉 `lastDecision` / `lastWinnerExpiryAt`；
 * - `src/jet-hub-rpc.ts`：删掉 `usage.badge` 的 auto 改写块与 `autoAdapter` 参数；
 * - `src/types.ts`：删掉 `autoActual` / `autoExpiryAt`；
 *   ⚠️ 原注释此处还列了 `readError`，但复审用 `git log -S readError` 核实：该字段
 *   **从未在响应类型里存在过**（master 与 PR base 全仓都没有），是本次一并新造的
 *   幽灵字段、且两端都不使用 ⇒ 已删除，并加了反向断言禁止再加回来。
 * - `plugin-src/client/usage-badge.js`：删掉 auto 专用门控分支与折叠胶囊的三要素。
 *
 * ⇒ 用户实际在用的是旧 auto（选择器里叫「Auto（临期优先 · 整池）」，而新的叫
 * 「Auto（聚合 · 跨渠道）」），于是**两样都没了**。
 *
 * 用户 2026-10-08 选定「两条都修」⇒ 本文件锁住恢复后的链路，防止再次被
 * 「重写别的 provider」顺手删掉。
 */
describe('★ 旧 auto 的徽标链路：宿主侧（上游 ba10f4f 回归的恢复）', () => {
  const ADAPTER = read('src/auto-adapter.ts')
  const RPC = read('src/jet-hub-rpc.ts')
  const TYPES = read('src/types.ts')

  it('★ auto 适配器必须记录**实际发出**的决策（徽标的数据来源）', () => {
    // ⚠️ 上游删掉了 `lastDispatch` / `lastDecision` ⇒ 宿主改写块失去数据来源。
    expect(ADAPTER).toMatch(/private lastDispatch:/)
    expect(ADAPTER).toMatch(/get lastDecision\(\)/)
    // 必须在 dispatch 里写（那是唯一「真的发出去」的地方，带图改道也经它）。
    expect(ADAPTER).toMatch(/this\.lastDispatch = \{/)
  })

  it('★ 记录必须发生在 dispatch 的**所有** return 之前（带图改道也要记）', () => {
    // ⚠️ 若写在某个 return 之后，带图改道那条路径会漏记 —— 而那正是最需要
    //    徽标止损的时刻（用户以为在用 A，实际烧 B）。
    // ⚠️ 不能写死 `private dispatch(`：上游为「零输出改道」把它改成了
    //    **`async *` 生成器**（`private async *dispatch(`）—— 写死会让
    //    `start = -1`，用例以「找不到」的形式失败，看起来像实现坏了、
    //    实际只是签名变了（本轮合并上游 1d8210c 后实测撞到）。
    const start = ADAPTER.search(/private (async \*\s*)?dispatch\(/)
    expect(start, '必须能定位到 dispatch 的定义（签名可能是 async * 生成器）').toBeGreaterThan(-1)
    const end = ADAPTER.indexOf('\n  }', start)
    const body = codeOf(ADAPTER.slice(start, end))
    const writeAt = body.indexOf('this.lastDispatch = {')
    expect(writeAt, 'dispatch 必须写入 lastDispatch').toBeGreaterThan(0)
    // ⚠️ 断言「在第一个 return 之前」这个写法**已过时**：上游为「零输出改道」
    //    把 `dispatch` 改成了 `async *` 生成器，函数体内**根本没有** return 语句
    //    （改道走 `yield*`），于是 `indexOf('return ')` 只会命中注释里那句
    //    「必须在任何 return 之前记」 ⇒ 用例红得莫名其妙（本轮合并 1d8210c 实测）。
    //
    // ⇒ 改成断言真正的不变量：**写入必须是函数体的第一条语句**。
    //    这比「在 return 之前」更强，且不依赖 return 的存在 ——
    //    只要它是第一条，任何提前退出（return / yield / throw）都必然已记过。
    // ⚠️ 找函数体起点不能用 `indexOf(') {')` —— 上游改成生成器后，签名里
    //    `= new Set(),` 之后、函数体之前还夹着 `AsyncIterable<StreamChunk> {`，
    //    而更早的匹配会命中函数体内层的 `if (...) {`（实测 bodyStart 落在
    //    `probe = noteChunk(...)` 之后，断言因此误红）。
    //    ⇒ 从签名开始**按括号配平**扫到第一个深度归零的 `{`，那才是函数体。
    const sigEnd = body.indexOf('AsyncIterable<StreamChunk>')
    expect(sigEnd, '应能定位到 dispatch 的返回类型标注').toBeGreaterThan(-1)
    const bodyStart = body.indexOf('{', sigEnd)
    expect(bodyStart).toBeGreaterThan(-1)
    const after = body.slice(bodyStart + 1).trim()
    expect(after.startsWith('this.lastDispatch = {'), 'lastDispatch 必须是 dispatch 函数体的第一条语句').toBe(true)
  })

  it('★ 记录临期失效时刻（折叠胶囊倒计时的数据来源）', () => {
    expect(ADAPTER).toMatch(/private lastExpiryAt: number \| undefined/)
    expect(ADAPTER).toMatch(/get lastWinnerExpiryAt\(\)/)
    // 由 selectProvider 顺带写入（零额外请求）—— 不能另打一轮余额接口。
    expect(ADAPTER).toMatch(/this\.lastExpiryAt = entries\.find/)
  })

  it('★ usage.badge 收到 jet-hub-auto 时改写成临期胜者的余额', async () => {
    // ⚠️ 行为断言（不是字符串断言）—— 见本文件头部「为什么这些用例用行为断言」。
    const state = makeState({ lastDecision: { provider: 'buddy', model: 'm', viaImageFallback: false } });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.kind).toBe('rewrite');
    expect(rewrite.effectiveProvider).toBe('buddy');
    expect(rewrite.autoActual).toEqual({ provider: 'buddy', model: 'm', viaImageFallback: false });
  })

  it('★ 非 auto 渠道原样透传（其余 15 家的行为逐字不变）', async () => {
    for (const p of ['buddy', 'codearts', 'zcode', 'loomy', 'workbuddy', 'aggregate']) {
      const rewrite = await resolveAutoBadgeRewrite(p, 'jet-hub-auto', makeState({}));
      expect(rewrite.kind, `provider=${p}`).toBe('passthrough');
    }
  })

  it('★ 优先读适配器**实际发出**的决策，而不是另建实例重新预测', async () => {
    // 真实缺陷（用户报障 2026-10-06）：徽标是止损工具 —— 用户看到「现在在烧谁」
    // 还来得及暂停。预测可能因失败切换/带图改道而错，显示错人比不显示更危险。
    let selectCalls = 0;
    const state = makeState({
      lastDecision: { provider: 'codearts', model: 'real', viaImageFallback: false },
      onSelect: () => { selectCalls += 1; return { provider: 'buddy', model: 'predicted' }; },
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    // 必须用真实历史（codearts），且**不得**调用预测（省掉一轮全池余额探测）。
    expect(rewrite.effectiveProvider).toBe('codearts');
    expect(rewrite.autoActual.model).toBe('real');
    expect(selectCalls, '有真实历史时不得再预测').toBe(0);
  })

  it('★ 无历史时回退到预测（否则插件刚重启时徽标是空的）', async () => {
    const state = makeState({
      onSelect: () => ({ provider: 'loomy', model: 'glm' }),
      lastWinnerExpiryAt: 12345,
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.kind).toBe('rewrite');
    expect(rewrite.effectiveProvider).toBe('loomy');
    expect(rewrite.autoActual).toEqual({ provider: 'loomy', model: 'glm', viaImageFallback: false });
    expect(rewrite.autoExpiryAt).toBe(12345);
  })

  it('★ 无可用账号时报可行动错误，而不是拿 auto 去查一个必然失败的余额', async () => {
    const state = makeState({ onSelect: () => undefined });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.kind).toBe('error');
    expect(rewrite.message).toContain('当前没有任何可用账号');
  })

  it('★ 适配器未挂载时报错（不得静默返回 passthrough）', async () => {
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', undefined);
    expect(rewrite.kind).toBe('error');
    expect(rewrite.message).toContain('适配器未挂载');
  })

  it('★ Infinity 不得回传（JSON 会序列化成 null，客户端按 typeof 判空）', async () => {
    const state = makeState({
      lastDecision: { provider: 'buddy', model: 'm', viaImageFallback: false, expiryAt: Number.POSITIVE_INFINITY },
      prices: { 'buddy\u0000m': Number.POSITIVE_INFINITY },
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.autoExpiryAt, 'Infinity 不得回传').toBeUndefined();
    expect(rewrite.autoPrice, 'Infinity 不得回传').toBeUndefined();
  })

  it('★ 倍率 0 是合法值（显示「免费」），不得被 falsy 判据吞掉', async () => {
    // ⚠️ `0` 是 falsy —— 用 `if (price)` 会把「免费」静默吞掉。本仓库在
    //    `buddySaturationDelayMs` 上踩过同型的 `|| 默认值` 坑。
    const state = makeState({
      lastDecision: { provider: 'buddy', model: 'm', viaImageFallback: false },
      prices: { 'buddy\u0000m': 0 },
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.autoPrice).toBe(0);
  })

  it('★ 倍率随实际目标回传（用户报障「没倍率显示？」）', async () => {
    const state = makeState({
      lastDecision: { provider: 'buddy', model: 'glm-5.3-flash', viaImageFallback: false },
      prices: { 'buddy\u0000glm-5.3-flash': 0.06 },
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.autoPrice).toBe(0.06);
  })

  it('★ 带图改道必须原样传出（客户端据此标注「（图）」）', async () => {
    const state = makeState({
      lastDecision: { provider: 'codearts', model: 'm', viaImageFallback: true },
    });
    const rewrite = await resolveAutoBadgeRewrite('jet-hub-auto', 'jet-hub-auto', state);
    expect(rewrite.autoActual.viaImageFallback).toBe(true);
  })

  it('★ 装配层必须把 auto 实例放进 modelAdapters 表（**不占位置参数**）', () => {
    const INDEX = read('src/index.ts')
    // 实例必须来自 registerAutoLlm 的返回值（那才是真正在用的那一个）。
    expect(INDEX).toMatch(/const autoAdapter = registerAutoLlm\(/)
    // ⚠️ 必须经 `modelAdapters` 表按 id 传入，**不能**给 registerJetHubRpc 加位置参数：
    //    `zcode-wiring.spec.ts` 有一条派生式不变量
    //    「客户端 PROVIDERS 条数 + 1 == 形参个数」，加第 17 个参数会立刻打破它
    //    （实测 10 条接线断言同时变红），而那条不变量正是为了防「位置错位」。
    expect(INDEX).toMatch(/'jet-hub-auto': pruned\(AUTO_PROVIDER, autoAdapter/)
    // 反向：不得再给 registerJetHubRpc 追加参数（末尾必须仍是 modelAdapters）。
    /**
     * ⚠️ 本断言随上游架构更新（2026-10-11）：
     * 上游 `feat/provider-capability-abstraction`（Task 9）把 `registerJetHubRpc`
     * 从 13 个位置参数改成**命名对象** `registerJetHubRpc(ctx, pool, { … }, modelAdapters)`
     * —— 「位置错位复发 6 次」的陷阱因此被根治。
     * ⇒ 原断言（位置参数形态）已不成立，改为断言命名对象形态。
     * 本 PR 的核心约定**未变**：auto 始终经 `modelAdapters` 按 id 传入、不占 auth 槽位。
     */
    expect(INDEX).toMatch(/registerJetHubRpc\(ctx, pool, \{[\s\S]*?\}, modelAdapters\)/)
  })

  it('★ autoState 由适配器自己提供（调用方拿不到「new 一个」的机会）', () => {
    expect(ADAPTER).toMatch(/autoState\(\): \{/)
    // `selectProvider` 必须是绑定 this 的闭包，且**不接受参数**
    //（`modelOf` 固定为 firstModelOf，暴露出去只会让它传错）。
    expect(ADAPTER).toMatch(/selectProvider: \(\) => this\.selectProvider\(undefined, p => this\.firstModelOf\(p\)\)/)
  })

  it('★ 响应类型必须含 autoActual / autoExpiryAt / autoPrice（上游删过前两个）', () => {
    const response = /export interface RpcUsageBadgeResponse \{([\s\S]*?)\n\}/.exec(TYPES)?.[1] ?? ''
    expect(response.length).toBeGreaterThan(0)
    expect(response).toMatch(/autoActual\?:/)
    expect(response).toMatch(/autoExpiryAt\?:/)
    // 倍率（用户报障「没倍率显示？」）：auto 自己没有倍率，只能靠响应带回来。
    expect(response).toMatch(/autoPrice\?:/)
    /**
     * ⚠️ 反向断言：**不得**再引入 `readError`（复审实测，2026-10-11）。
     *
     * 该字段是本次提交**新造**的（`git log -S readError` 显示响应字段只出现在本 PR
     * 的提交里；master 与 PR base 全仓都没有它），其注释声称「与 `autoActual` 同时被
     * 上游删除、一并补回」—— 与 git 历史不符。
     *
     * 更关键的是它**两端都不使用**：宿主从不设置它、客户端也从读它
     *（客户端的 `readError` 是**本地** `useState`，与响应字段无关；错误文案实际由
     * `describeBadgeError(error)` 在客户端侧翻译）。
     * ⇒ 留一个永不生效的字段只会让后来者以为「宿主会回传可行动原因」而据此写代码。
     * 「宿主过期」那句文案的真实落点是 `describeBadgeError`（已覆盖 D5 的两种形态）。
     */
    expect(response, '不得引入两端都不使用的幽灵字段 readError').not.toMatch(/readError\?:/)
  })

  it('★ 倍率来自**已算过**的那轮目录循环（不得为它重查一次目录）', () => {
    // `firstModelOf` 为了「挑最便宜的模型」已经读遍目录并算出了倍率；
    // 为显示再查一次等于白打一轮上游目录接口。
    expect(ADAPTER).toMatch(/private rememberPrice\(/)
    expect(ADAPTER).toMatch(/this\.rememberPrice\(provider, best\.id, best\.price\)/)
    // 查询入口必须暴露给 RPC 层（否则拿不到）。
    expect(ADAPTER).toMatch(/priceOf\(provider: string, model: string\)/)
  })

  it('★ 装配层必须把 auto 实例放进 modelAdapters 表（**不占位置参数**）', () => {
    const INDEX = read('src/index.ts')
    // 实例必须来自 registerAutoLlm 的返回值（那才是真正在用的那一个）。
    expect(INDEX).toMatch(/const autoAdapter = registerAutoLlm\(/)
    // ⚠️ 必须经 `modelAdapters` 表按 id 传入，**不能**给 registerJetHubRpc 加位置参数：
    //    `zcode-wiring.spec.ts` 有一条派生式不变量
    //    「客户端 PROVIDERS 条数 + 1 == 形参个数」，加第 17 个参数会立刻打破它
    //    （实测 10 条接线断言同时变红），而那条不变量正是为了防「位置错位」。
    expect(INDEX).toMatch(/'jet-hub-auto': pruned\(AUTO_PROVIDER, autoAdapter/)
    // 反向：不得再给 registerJetHubRpc 追加参数（末尾必须仍是 modelAdapters）。
    /**
     * ⚠️ 本断言随上游架构更新（2026-10-11）：
     * 上游 `feat/provider-capability-abstraction`（Task 9）把 `registerJetHubRpc`
     * 从 13 个位置参数改成**命名对象** `registerJetHubRpc(ctx, pool, { … }, modelAdapters)`
     * —— 「位置错位复发 6 次」的陷阱因此被根治。
     * ⇒ 原断言（位置参数形态）已不成立，改为断言命名对象形态。
     * 本 PR 的核心约定**未变**：auto 始终经 `modelAdapters` 按 id 传入、不占 auth 槽位。
     */
    expect(INDEX).toMatch(/registerJetHubRpc\(ctx, pool, \{[\s\S]*?\}, modelAdapters\)/)
  })

  it('★ autoState 由适配器自己提供（调用方拿不到「new 一个」的机会）', () => {
    expect(ADAPTER).toMatch(/autoState\(\): \{/)
    // `selectProvider` 必须是绑定 this 的闭包，且**不接受参数**
    //（`modelOf` 固定为 firstModelOf，暴露出去只会让它传错）。
    expect(ADAPTER).toMatch(/selectProvider: \(\) => this\.selectProvider\(undefined, p => this\.firstModelOf\(p\)\)/)
  })
})

describe('★ 旧 auto 的徽标链路：客户端侧', () => {
  const BADGE = read('plugin-src/client/usage-badge.js')
  const BADGE_CODE = codeOf(BADGE)
  const MODEL = read('plugin-src/client/badge-model.js')

  it('★ 门控放行 auto，且必须在能力表门控**之前**返回', () => {
    // `supportsCreditBalance('jet-hub-auto')` 为假（auto 自己没有余额）⇒
    // 交给下面那道门控会 return null，徽标永不渲染。
    //
    // ⚠️ 断言必须写成**精确的整行**并基于去注释源码：第一版写成
    //    `/provider === AUTO_PROVIDER_ID/` 后，我把它改成
    //    `if (false && provider === AUTO_PROVIDER_ID)` 做反向验证时**用例照样绿**
    //    —— 那是一条恒真的假用例（正则命中的是子串，而 `false &&` 让分支永不执行）。
    expect(BADGE_CODE).toMatch(/if \(provider === AUTO_PROVIDER_ID\) \{/)
    const autoIdx = BADGE_CODE.indexOf('if (provider === AUTO_PROVIDER_ID) {')
    const capIdx = BADGE_CODE.indexOf('!supportsCreditBalance(provider)')
    expect(autoIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeGreaterThan(-1)
    expect(autoIdx, 'auto 放行必须在能力表门控之前').toBeLessThan(capIdx)
  })

  it('★ provider id 常量与宿主逐字一致（两处写死必然漂移）', () => {
    expect(MODEL).toMatch(/export const AUTO_PROVIDER_ID = 'jet-hub-auto'/)
  })

  it('★ 折叠胶囊显示**实际** provider + 模型（止损工具的核心）', () => {
    // ⚠️ 行为断言（不是字符串断言）：`autoBadgeName` 是纯函数，可直接 import。
    //    字符串断言对「短路禁用」免疫 —— 实测把它改成 `if (false && …)` 后
    //    用例照样全绿（那是一条恒真的假用例）。
    const name = autoBadgeName({
      fallback: 'Jet Hub 自动（临期优先）',
      autoActual: { provider: 'buddy', model: 'GLM-5.3-Flash', viaImageFallback: false },
      providerLabel: (id) => (id === 'buddy' ? 'CodeBuddy (腾讯)' : id),
    });
    expect(name).toContain('自动 →');
    // 渠道名用短名（去括号），模型名必须在。
    expect(name).toContain('CodeBuddy');
    expect(name).not.toContain('(腾讯)');
    expect(name).toContain('GLM-5.3-Flash');
  })

  it('★ 折叠胶囊显示**倍率**（用户报障「没倍率显示？」）', () => {
    const base = {
      fallback: 'auto',
      autoActual: { provider: 'buddy', model: 'GLM-5.3-Flash', viaImageFallback: false },
      providerLabel: (id) => id,
    };
    // 正常倍率
    expect(autoBadgeName({ ...base, price: 0.06 })).toContain('x0.06');
    // ⚠️ 0 显示「免费」（本仓库既有口径，与 candidateRowLabel 一致）
    expect(autoBadgeName({ ...base, price: 0 })).toContain('免费');
    // ⚠️ Infinity（「无标注」哨兵）**不得**显示 —— 拼出来是 xInfinity
    expect(autoBadgeName({ ...base, price: Number.POSITIVE_INFINITY })).not.toContain('x');
    expect(autoBadgeName({ ...base, price: Number.POSITIVE_INFINITY })).not.toContain('Infinity');
    // 缺席同理
    expect(autoBadgeName(base)).not.toContain('Infinity');
    // NaN 也不得显示
    expect(autoBadgeName({ ...base, price: Number.NaN })).not.toContain('NaN');
  })

  it('★ 带图改道必须额外标注（否则用户无法解释「为什么这次是这家」）', () => {
    const name = autoBadgeName({
      fallback: 'auto',
      autoActual: { provider: 'buddy', model: 'm', viaImageFallback: true },
      providerLabel: (id) => id,
    });
    expect(name).toContain('（图）');
  })

  it('★ 非 auto 渠道的文案逐字不变（其余 15 家不得被带跑）', () => {
    // `autoActual` 缺席 ⇒ 原样返回 fallback（普通渠道展示名）。
    expect(autoBadgeName({ fallback: 'CodeBuddy (腾讯)' })).toBe('CodeBuddy (腾讯)');
    // 畸形值也必须退回 fallback，而不是抛错或渲染半个名字。
    for (const bad of [null, undefined, 'not-an-object', 42, {}, { provider: '' }, { provider: 42 }]) {
      expect(autoBadgeName({ fallback: 'X', autoActual: bad }), `畸形 autoActual: ${JSON.stringify(bad)}`).toBe('X');
    }
  })

  it('★ 折叠胶囊显示临期倒计时，且「今日」按本地日历判定', () => {
    // ⚠️ 注入固定时刻，避免用例在午夜前后抖动。
    const now = new Date(2026, 9, 8, 12, 0, 0).getTime(); // 2026-10-08 12:00 本地
    const today = new Date(2026, 9, 8, 24 - 1, 0, 0).getTime();
    // ⚠️ 文案格式**逐字**对齐 master 原版（`expiryCountdownText`）：今日档是
    //    `今日23:59过期`（**无空格**），跨日档是 `10/9 08:30过期`（**有空格**，
    //    因为那个空格是月/日与时刻之间的分隔）。我第一版想当然写成「今日 23:59过期」
    //    并因此红了一条 —— 那是我期望写错，不是实现错。
    expect(expiryCountdownText(new Date(2026, 9, 8, 23, 59, 0).getTime(), now)).toBe('今日23:59过期');
    // 明日 → 前缀是月/日（不是「今日」）
    expect(expiryCountdownText(new Date(2026, 9, 9, 8, 30, 0).getTime(), now)).toBe('10/9 08:30过期');
    // 非有限值 → 空串（不显示）
    expect(expiryCountdownText(Number.POSITIVE_INFINITY, now)).toBe('');
    expect(expiryCountdownText(null, now)).toBe('');
    // 拼进胶囊名
    expect(autoBadgeName({
      fallback: 'auto',
      autoActual: { provider: 'buddy', model: 'm', viaImageFallback: false },
      expiryAt: today,
      providerLabel: (id) => id,
      now,
    })).toContain('今日23:00过期');
  })

  it('★ 短渠道名去掉括号后缀（折叠胶囊宽度有限）', () => {
    expect(shortProviderName('Loomy (讯飞)')).toBe('Loomy');
    expect(shortProviderName('CodeBuddy (腾讯)')).toBe('CodeBuddy');
    // 无括号时原样
    expect(shortProviderName('buddy')).toBe('buddy');
    // 畸形输入不抛错
    expect(shortProviderName(undefined)).toBe('');
    expect(shortProviderName(null)).toBe('');
  })

  /**
   * ★★ 折叠胶囊必须真的**读**宿主回传的三个 auto 字段（接线缺口，PR !84 复审实测）。
   *
   * ## 为什么单独守这一条
   *
   * 上面那些用例断言的是 `autoBadgeName` 这个**纯函数**的行为 —— 而「纯函数正确」
   * **不等于**「它被正确调用」：胶囊的数据来自 `UsageBadgeActive` 里对
   * `value?.autoActual` / `value?.autoPrice` / `value?.autoExpiryAt` 的取数。
   * `usage-badge.js` import 了 `react`，单测环境**无法 import 它**（本仓库
   * node_modules 里没有 react），故只能做源码断言。
   *
   * ## ⚠️ 为什么要写成「精确整行」而不是 `/autoActual/` 这类子串
   *
   * 复审实测：把这三行改成 `autoActual: undefined,`（功能完全失效）之后，
   * `usage-badge-client.spec.ts` / `aggregate-badge.spec.ts` / 本文件其余用例
   * **119 条全绿** —— 一个都没抓到。即：**这条接线此前零守卫**。
   * 子串式断言（`toContain('autoActual')`）对这类「短路成 undefined」免疫，
   * 所以这里断言的是**取数的完整形态**（含 `value?.` 前缀与逗号结尾），
   * 改坏任一处都会失配。
   *
   * ⚠️ 基于**去注释**源码：本文件与 `usage-badge.js` 的注释里大量引用这些字段名
   *（例如「胶囊的数据来自 `value?.autoActual`」），对全文断言会把注释判成违规
   *（`usage-badge-client.spec.ts` 的 `codeOf` 同款，那里因这个坑红过两次）。
   */
  it('★★ 折叠胶囊必须读取宿主的 autoActual / autoPrice / autoExpiryAt（接线缺口）', () => {
    const badgeActive = BADGE_CODE.slice(BADGE_CODE.indexOf('const badgeName = autoBadgeName({'))
    expect(badgeActive.length, '应当能定位到 autoBadgeName 的调用点').toBeGreaterThan(0)
    // ⚠️ 三行都必须**带 `value?.` 取值**。写成 `undefined,` / 硬编码常量都会失配。
    expect(badgeActive, '胶囊必须读 autoActual（渠道+模型）').toMatch(/autoActual: value\?\.autoActual,/)
    expect(badgeActive, '胶囊必须读 autoPrice（倍率）').toMatch(/price: value\?\.autoPrice,/)
    expect(badgeActive, '胶囊必须读 autoExpiryAt（临期倒计时）').toMatch(/expiryAt: value\?\.autoExpiryAt,/)
    // 反向：取值必须来自**宿主读数** `value`，不得改成别的来源（例如局部常量、props）。
    for (const field of ['autoActual', 'autoPrice', 'autoExpiryAt']) {
      expect(BADGE_CODE, `${field} 不得从 props 取`).not.toMatch(new RegExp(`${field}:\\s*props\\.`))
    }
  })
})

describe('★ 旧 auto 的模型选择器名（倍率）', () => {
  const ADAPTER = read('src/auto-adapter.ts')

  it('★ auto 自己是一个固定模型名 —— 倍率必须由「实际选中的渠道」决定', () => {
    // ⚠️ auto 是**跨渠道**的单一模型名，它自己没有倍率：倍率取决于本次选中谁。
    //    ⇒ 不能像 aggregate 那样写进 `listModels` 的静态名（那个名对所有请求都一样，
    //    写死一个倍率就是**编造**）。
    //    正确做法：在 `prepareCall` 的运行期名字里带上实际选中的渠道，让用户
    //    从「自动 → CodeBuddy」再对照渠道自己的倍率判断。
    expect(ADAPTER).toMatch(/name: `Auto（临期优先）· \$\{choice\.provider\}`/)
  })

  it('★ 运行期名字必须带**实际选中**的 provider（选型降级的唯一可见提醒）', () => {
    expect(ADAPTER).toMatch(/本次选中 \$\{choice\.provider\}/)
  })
})
