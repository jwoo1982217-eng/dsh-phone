/**
 * ★★ 「中止不得被折算成 UNUSABLE」守卫（用户报障 2026-10-19）。
 *
 * ## 报错形态（实测取证，真实会话日志）
 *
 * `aggregate: 「space-bunny」当前没有任何可用候选…`，且
 * `step/start 1792418663502` → `turn/end 1792418663505` ⇒ **3 毫秒、零网络事件**
 * ⇒ 是**本地算出的候选序为空**，不是上游拒绝。
 * 该虚拟模型**只有 buddy 一家候选** ⇒ 无备胎，候选一空直接撞
 * `candidatesFor() === []`（`src/aggregate-adapter.ts:1315`）。
 *
 * 并行会话 `session-b61f453f` turn30/31 复发两次，报错前 step2 是一次
 * **604 秒的 subagent 调用**（长任务被取消/超时），报错发生在紧随其后的 step3。
 *
 * ## 本文件锁的接缝
 *
 * `sharedPackageExpiry`（`src/aggregate-expiry.ts:815`）的裸 `catch` 把**一切**错误
 * 折算成 `UNUSABLE`。而 `UNUSABLE` 会被 `cacheAndReturn` **缓存 60 秒**
 * ⇒ **取消一次 = 该渠道对路由消失 60 秒**。对单候选模型，这就是用户看到的
 * 「没有任何可用候选」，60 秒后自愈 ⇒ 表现为「发继续就能工作」。
 *
 * ## ⚠️ 可达性：已实测，如实登记（别把它读成「已在生产触发」）
 *
 * | 探针 | 结果 |
 * |---|---|
 * | A.`buddyExpiry` 的 `cached()` 抛 `AbortError` | **被吞成 `-1`（UNUSABLE）** ← 本文件要锁的缺陷 |
 * | B.`balanceCache.readOne` 上游抛中止 | **原样上抛**（`src/balance-cache.ts:402`） |
 * | C.真实 buddy 腿 `fetchCreditBalance` | `postJson` 把中止压成 `{ok:false}` ⇒ **该腿不抛中止** |
 *
 * ⇒ 结论：这条腿**当前对 buddy 不可达**（与 `src/aggregate-expiry.ts:828` 的
 * 注释一致），但**接缝在 B 那一侧已经开口**（共享缓存那条腿会抛中止），
 * 而该文件自己的注释也承认「若将来某家改用 `fetchBalanceDetailed`、或
 * `postJson` 改为抛出 ⇒ 这里会立刻把中止吃掉」。
 * ⇒ 本文件锁的是**接缝的安全性**，不是「已复现的生产故障」。
 */

import { describe, expect, it } from 'vitest'
import { buddyExpiry } from '../../src/aggregate-expiry.js'
import { CODEBUDDY } from '../../src/product.js'
import { UNUSABLE, NEVER } from '../../src/aggregate-core.js'
import { createExpiryProbe } from '../../src/aggregate-expiry.js'

/** 造一个 `name === 'AbortError'` 的错误（与 `isAbortError` 的判据同形）。 */
function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * ⚠️ 判据必须打在**真实接缝**上：`index.ts` 的装配把
 * `cachedBalance: () => cachedBalanceOf(provider, accountId, credential)`
 * 传给折算（`src/index.ts:3273` → `:585`），而它读的 `balanceCache.readOne`
 * **会原样上抛中止**（B 实测）。⇒ 这里直接以「`cached()` 抛中止」驱动那个接缝。
 */
describe('★ 中止不得被折算成 UNUSABLE（sharedPackageExpiry 的裸 catch）', () => {
  it('★ cached() 抛 AbortError ⇒ 必须原样逃逸，不得折算成 UNUSABLE', async () => {
    // ⚠️ 修复前：`sharedPackageExpiry` 的裸 catch 把中止吞成 `-1`（UNUSABLE）
    //    ⇒ 实测报错 `promise resolved "-1" instead of rejecting`。
    //    修复后（`src/aggregate-expiry.ts:861` 的 `isAbortError` 判定）本用例转绿。
    await expect(
      buddyExpiry(CODEBUDDY, { access_token: 't' } as never, async () => { throw abortError() }),
      '中止被折算成 UNUSABLE ⇒ 取消一次就让该渠道消失 60 秒（单候选模型直接报「没有候选」）',
    ).rejects.toThrow(/abort/i)
  })

  it('★ 反向对照：普通网络故障**仍**折算成 UNUSABLE（本次只改中止，不改故障语义）', async () => {
    // ⚠️ 没有这条，「凡错误都上抛」的实现也会全绿 —— 而它会推翻
    //    `aggregate-expiry.spec.ts` 已登记的有意取舍（「不能把『不知道』当『可用』」）。
    const value = await buddyExpiry(
      CODEBUDDY,
      { access_token: 't' } as never,
      async () => { throw new Error('network down') },
    )
    expect(value, '普通故障必须仍剔除（不得因本次修法被放行）').toBe(UNUSABLE)
    expect(value).not.toBe(NEVER)
  })

  it('★ 入口 signal 已中止 ⇒ 直接抛（不经折算）', async () => {
    const controller = new AbortController()
    controller.abort()
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{
        entry: { id: 'a1' }, credential: { access_token: 't' },
      }],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    await expect(probe('buddy', controller.signal)).rejects.toThrow()
  })
})