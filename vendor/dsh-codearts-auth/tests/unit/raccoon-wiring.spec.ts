import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { descriptorOf } from '../../src/provider-registry.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = stripComments(readFileSync(resolve(here, '../../src/index.ts'), 'utf8'))

/**
 * 取某 provider 的**工厂配置块**（`createCredentialResolver(...)` 那一段）。
 *
 * ⚠️ **归属判据是「块内第一个 `product: <CONST>,`」**，不能写成「块内是否出现
 * `product: X,`」：选择器的**定义**恰好夹在相邻两个工厂调用之间，于是会被算进
 * **上一个** provider 的块里（写 loomy 那条时实测到：CLINE 的块里含 `product: LOOMY,`）。
 * 工厂配置项里 `product` 永远是首字段，取第一个即无歧义。
 *
 * ⚠️ 与 `loomy-wiring.spec.ts` 的同名助手**刻意各留一份**：本仓库的源码契约测试
 * 一律自带切片助手（`source-scope.ts` 那种公共件只用于 AST 取函数体）。抽公共件
 * 会让「改一处影响多个 spec」—— 正是这些测试要防的形态。
 */
function factoryBlockOf(source: string, product: string): string {
  const calls = [...source.matchAll(/createCredentialResolver(?:<[^>]*>)?\(/g)].map(m => m.index!)
  for (let i = 0; i < calls.length; i++) {
    const block = source.slice(calls[i]!, calls[i + 1] ?? source.length)
    const first = /product: (\w+),/.exec(block)
    if (first?.[1] === product) return block
  }
  throw new Error(`index.ts 里找不到 ${product} 的 createCredentialResolver 配置块`)
}

/**
 * 源码级回归：新增 provider 的接线点一处都不能漏。
 * 历史缺陷正是「加了 provider 但忘了在 modelAdapters 里登记」→
 * 设置页里被关闭的模型显示成裸 id（丢倍率）。
 */
/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('Raccoon 在 index.ts 的接线', () => {
  it('导入并实例化 RaccoonAuth', () => {
    expect(indexSource).toContain("from './raccoon-auth.js'")
    expect(indexSource).toContain('new RaccoonAuth(ctx)')
  })

  it('注册 Raccoon 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './raccoon-adapter.js'")
    expect(indexSource).toContain('registerRaccoonLlm(ctx,')
    expect(indexSource).toMatch(/const raccoonAdapter = registerRaccoonLlm/)
  })

  /**
   * ## ⚠️ 这条用例的锚点曾经**错标**（2026-10-08 复审修正，**不是**本次重构引入的）
   *
   * 原标题是「provider 解析用 RACCOON.id」，断言的是「池取号时第二实参传**空串**」
   * 那个文本形。但**在基线上**该文本形就只出现在 **`refresh:` 块**里（续期定位账号），
   * 而 provider 解析那一处传的是 **`modelId`**（故不含该文本形）。
   *
   * ⚠️ 本注释**刻意不复写那个旧锚点原文**：它是验收命令会 grep 的字符串，
   * 写进注释会让「该锚点已消失」的核对**假命中**（本仓库的既定约定）。
   *
   * ⇒ 标题说「解析」，实际守的是「续期」：**名不副实**，且它守的那件事
   * （续期传空串）已由 `trae-model-id-selection.spec.ts` 的「续期路径刻意不按模型
   * 过滤」一组逐 provider 覆盖（含 raccoon）。Task 6 之后 provider 解析已下沉进
   * `createCredentialResolver`，那句文本更不可能回来了。
   *
   * 修法：重新指向**真正**验证 raccoon provider 解析的东西 —— 工厂配置项里的
   * `product: RACCOON,`（工厂正是拿 `config.product.id` 去查池）。这仍然守住原意图
   * （「不写死字面量 `'raccoon'`」），且与 `loomy-wiring.spec.ts` 的同款改法一致。
   */
  it('provider 解析用 RACCOON 常量（不写死字面量）', () => {
    // 工厂配置块必须把 RACCOON 交给工厂 —— 工厂拿 `config.product.id` 查池。
    expect(factoryBlockOf(indexSource, 'RACCOON'), '必须把 RACCOON 常量交给工厂')
      .toContain('product: RACCOON,')
    // 且整个文件里不得出现写死字面量的查池调用。
    expect(indexSource).not.toMatch(/getAvailableAccount\('raccoon'/)
    expect(indexSource).not.toMatch(/listAccountsByProvider\('raccoon'/)
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    expect(indexSource).toMatch(/raccoon\.refreshAccountCredential\(/)
    expect(indexSource).toMatch(/available\.entry\.credentialRef/)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：「凭据过期后显示过期，但是似乎是续期
   * 成功了还是没有真正的过期，我发送会话成功从 6300 扣分了。」
   *
   * 根因：续期成功后没把新的 `expiresAt` 写回账号池，而 Jet Hub UI 读的
   * 正是账号池。实测该账号 JWT `exp` 已是 15:09（有效）、账号池却是
   * 12:02（已过期），**相差 3.1 小时**。
   *
   * 判据：`index.ts` 的续期路径必须把 `pool` 与 `entry.id` 传下去，
   * 否则 `syncAccountExpiry` 无从回写。
   */
  it('⚠️ 续期调用必须传 pool 与 accountId（否则 UI 假过期）', () => {
    // 适配器的 refresh 回调 = 「发消息时按需续期」，最常触发的路径
    expect(
      indexSource,
      '适配器 refresh 回调必须传 pool + entry.id，否则账号池的 expiresAt 不会更新',
    ).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id,?\s*\)/,
    )
  })

  it('settings namespace 已声明（行为断言，2026-10-08 改）', () => {
    // ⚠️ 2026-10-08 改：原先是扫 `src/index.ts` 源码文本找 `'llm-raccoon'`。本次重构把
    //    13 个字面量收敛成从 `PROVIDER_REGISTRY` 派生，字面量搬家 ⇒ 文本断言变红。
    //    改为断言声明值；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('raccoon')?.settingsNamespace).toBe('llm-raccoon')
  })

  it('加入批量续期调度', () => {
    // ⚠️ **2026-10-08 改（Task 10）**：原先断言 `src/index.ts` 的源码文本含
    //    `raccoon.refreshAll(pool|p)` —— 那张手抄清单已被 `wiredRefreshTargets()`
    //    从**能力注册表**派生取代 ⇒ 该文本形态**不存在了**，而它守的意图
    //    （raccoon 在续期调度里）**与文本无关**。
    //
    // ⇒ 改为**结构断言**：注册循环必须为**每个** provider 挂 `refreshAll`。
    // ⚠️ 行为断言（真跑 `apply()`、逐个驱动 `auth.refreshAll` 并断言打到
    //    **自己那个**实例）在 `provider-runtime-wiring.spec.ts` 的
    //    「★ 13 家都挂上了 `auth.refreshAll`」一条里，**比本条更强**。
    expect(indexSource, '注册循环没有挂 refreshAll（派生表会恒为空）')
      .toMatch(/refreshAll:\s*\(pool\)\s*=>\s*auth\.refreshAll\(pool\)/)
    expect(indexSource, 'refreshTargets 又回到手抄清单了')
      .toMatch(/wiredRefreshTargets\(\)/)
  })

  it('modelAdapters 里登记了 raccoon', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（否则 Jet Hub 拿到原始
    // 实例、「已失效模型」剔除对设置页不生效）。
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?raccoon: pruned\([^)]*,\s*raccoonAdapter\)/)
  })

  it('registerJetHubRpc 传入了 raccoon', () => {
    // ⚠️ 2026-10-08 改（Task 3）：原先这条是**相邻性正则**
    //    `/registerJetHubRpc\([\s\S]*?raccoon,[\s\S]*?modelAdapters\)/` ——
    //    它把「raccoon 键存在」与「该字面量在 modelAdapters 之前」用**书写顺序**
    //    Task 3 一度给 `registerJetHubRpc` 加了**第 5 个位置形参** `credits`，
    //    调用点变成 `… }, modelAdapters, creditsTable)` ⇒ 正则必然假失败。
    //    该形参随后在设计复审 C1 中被删除，但**本条的改法保留** —— 它守的意图
    //    （raccoon 的 auth 实例接上了）**与形参个数无关**。
    //    ⇒ 改为按 **AST** 取调用点第三个实参（auths 对象字面量）的键 ——
    //    重排 / 插键 / 加形参都不可能让它假失败，而**键真的漏了必然变红**。
    //    「端到端分派真的落到 raccoon 实例上」由行为用例守：
    //    `lobsterai-rpc-dispatch.spec.ts` 的「13 个 provider 逐个覆盖」。
    const authKeys = jetHubAuthsCallKeys(indexSource)
    expect(Object.keys(authKeys), 'raccoon 必须在 auths 命名对象里（键 = provider id）')
      .toContain('raccoon')
    expect(authKeys.raccoon, '`raccoon` 键的值必须是 raccoon 实例').toBe('raccoon')
  })

  it('fetchRemoteModels 委托给 RaccoonAuth.fetchModels', () => {
    const start = indexSource.indexOf('fetchRemoteModels: () => raccoon.fetchModels')
    expect(start).toBeGreaterThan(-1)
  })

  it('凭据类型标注为 RaccoonCredential（不是 any）', () => {
    expect(indexSource).toContain("from './raccoon.js'")
    expect(indexSource).toMatch(/RaccoonCredential/)
  })
})
