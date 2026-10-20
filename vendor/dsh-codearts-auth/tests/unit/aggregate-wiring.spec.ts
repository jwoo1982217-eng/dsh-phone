/**
 * `src/index.ts` 的聚合 provider 接线守卫。
 *
 * ## 为什么需要（两处都出过真实缺陷）
 *
 * 1. **漏登记 `modelAdapters`**：`jet-hub-rpc.ts` 的 `fullCatalogIds` **优先**用
 *    `modelAdapters[provider].listAllModels()`（不套黑名单的全量目录），缺失时才退化到
 *    `llm.listModels(provider)` —— 后者已被各适配器按黑名单过滤。于是「关闭整个聚合
 *    provider」时只拿到**未被关闭的** id ⇒ 已关闭的模型漏写黑名单，而 `provider.status`
 *    的判据是 `closed = total > 0 && disabled === total` ⇒ 出现「provider 显示已关闭、
 *    模型却仍可选用」的矛盾态（设计文档 §5.2 的必改点）。本仓库为此已复发过多次
 *    （`loomy-wiring.spec.ts` / `raccoon-wiring.spec.ts` / `opencode-wiring.spec.ts`
 *    的模块头都记着「加了 provider 但忘了登记」）。
 * 2. **漏传 `expiryProbe`**：聚合适配器省略该注入时保守返回 `UNUSABLE`
 *    ⇒ 所有渠道都被折算成不可用 ⇒ 聚合目录虽在，但任何请求都报「没有任何可用候选」。
 *
 * ## 顺序约束（不是笔误）
 *
 * 聚合的 `registerAggregateLlm` 必须**早于** `modelAdapters` 定义（那张表要引用它的
 * 返回值），而 `modelAdapters` 又必须早于 `registerJetHubRpc`。故聚合的注册位置比
 * `registerAutoLlm` **更靠前** —— 本文件把这条约束也锁住。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AggregateAdapter } from '../../src/aggregate-adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const index = readFileSync(join(here, '../../src/index.ts'), 'utf8')

/** 去掉注释，避免「注释里提到」被当成「代码里用了」。 */
const code = index
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

describe('index.ts 接线：聚合 provider', () => {
  it('注册聚合适配器，并注入真实 expiryProbe', () => {
    expect(code).toMatch(/registerAggregateLlm\(ctx,\s*\{/)
    // ⚠️ 不传 expiryProbe ⇒ 所有渠道都折算成 UNUSABLE（见模块头第 2 条）。
    // ⚠️ 判据测**意图**（注入了由 `createExpiryProbe` 建的探针），**不是**某个写法：
    //    初版写死 `expiryProbe: createExpiryProbe(`（内联），而为了修
    //    「auto 与 aggregate 各建一份缓存」那个真实缺陷，探针改为**共享变量**
    //   （`const sharedExpiryProbe = createExpiryProbe(...)`）⇒ 写死内联会假失败。
    expect(code).toMatch(/const sharedExpiryProbe\s*=\s*createExpiryProbe\(/)
    expect(code).toMatch(/expiryProbe:\s*sharedExpiryProbe/)
  })

  it('★ auto 与 aggregate 必须**共用同一个**探针（否则两份缓存 ⇒ 刚登录账号 60 秒不可见）', () => {
    // ⚠️ 真实缺陷（对抗审计实测证伪）：`registerAutoLlm(ctx, { accountPool })`
    //    不传 expiryProbe ⇒ `AutoAdapter` 自建一份，而 aggregate 另有自己的一份
    //    ⇒ ① 同一渠道被折算两次（白打两次上游）；② 缓存失效要清两次。
    expect(code).toMatch(/registerAutoLlm\(ctx,\s*\{[^}]*expiryProbe:\s*sharedExpiryProbe/s)
  })

  it('★ 账号入库时必须清空折算缓存（缓存原无任何失效通道）', () => {
    // ⚠️ 真实缺陷：缓存原先**没有任何失效通道** ⇒ 刚登录（或限流刚解禁）的账号
    //    在**最长 60 秒内对路由不可见**，用户拿到误导性的「没有任何可用候选」。
    expect(code).toMatch(/onAccountAdded\(/)
    expect(code).toMatch(/sharedExpiryProbeRef\?\.clear\(\)/)
  })

  it('★★ 账号入库必须**同时**清「候选序缓存」（独立审计实测证伪：只清了一半）', () => {
    // ⚠️⚠️ **真实缺陷**：`onAccountAdded` 原先只调 `sharedExpiryProbeRef?.clear()`
    //    （折算缓存），而 `AggregateAdapter.choiceCache`（**候选序**缓存，60 秒 TTL）
    //    **未清**。两者是**不同**的缓存：
    //
    //    - 折算缓存：`provider → 最早失效时刻`（决定**排序**）；
    //    - 候选序缓存：`${model}\0${拒绝表指纹} → DispatchTarget[]`（决定**用哪几个候选**）。
    //
    //    后果（审计实测）：buddy 未登录时被剔除（只剩 codearts）⇒ 那个**非空**结果
    //    被缓存 ⇒ 用户随后登录 buddy ⇒ 折算缓存被清（排序值对了），但
    //    **候选序仍是只有 codearts 的旧数组** ⇒ 60 秒内 buddy 仍不被使用。
    //    而提交信息与注释都声称该修复解决了「刚登录的账号对路由不可见」——
    //    实际只解决了**一半**（正是本仓库最警惕的「声称已解决、实际一半」形态）。
    //
    //    ⚠️ 候选序缓存的键含**拒绝表**指纹但**不含账号状态**
    //    ⇒ 账号变化必须**显式**清它（正确性不能依赖调用方记得，但这里是唯一收口点）。
    expect(code).toMatch(/onAccountAdded\(/)
    expect(code, '必须清折算缓存').toMatch(/sharedExpiryProbeRef\?\.clear\(\)/)
    expect(code, '必须**也**清候选序缓存（两者是不同的缓存）')
      .toMatch(/sharedChoiceCacheRef\?\.clearChoiceCache\(\)/)
  })

  it('modelAdapters 里登记了 aggregate（否则「关闭 provider」会留下矛盾态）', () => {
    expect(code).toMatch(/aggregate:\s*pruned\(AGGREGATE_PROVIDER,\s*aggregateAdapter/)
  })

  it('★ 聚合的 dead-model 包装必须传 enabled:false（不记录**也不过滤**，否则虚拟模型会被误藏且无法自愈）', () => {
    // ⚠️ 全分支终审 C2 + 审计轮次二补修：外层包装观察到的是 `aggregate` + **虚拟键**
    //    （实测），于是「某一个渠道没有该 realId」会被记成「**整个规范模型**失效」，
    //    而它在其余渠道上完全可用；恢复入口 model.clearDead 的 UI 在设置页 provider
    //    面板里，而客户端 PROVIDERS **没有 aggregate** ⇒ 没有任何 UI 能恢复。
    // ⚠️ 必须是 `enabled:false`（**完全不参与**）而不是「只不记录」：若表里**已有**
    //    旧版本写下的记录，只跳过记录仍会**过滤**掉虚拟模型（实测探针确认），
    //    同样无 UI 可恢复。
    expect(code)
      .toMatch(/aggregate:\s*pruned\(AGGREGATE_PROVIDER,\s*aggregateAdapter,\s*\{\s*enabled:\s*false\s*\}\)/)
  })

  it('AGGREGATE_PROVIDER 从 aggregate-adapter 导入', () => {
    expect(code).toMatch(/import\s*\{[^}]*AGGREGATE_PROVIDER[^}]*\}\s*from\s*'\.\/aggregate-adapter\.js'/)
  })

  it('createExpiryProbe 从底座 aggregate-expiry 导入（不是从 aggregate-adapter）', () => {
    expect(code).toMatch(/import\s*\{[^}]*createExpiryProbe[^}]*\}\s*from\s*'\.\/aggregate-expiry\.js'/)
    // ⚠️ 它**不**定义在 aggregate-adapter.ts；从那里导入会编译失败。
    expect(code).not.toMatch(/createExpiryProbe[^}]*\}\s*from\s*'\.\/aggregate-adapter\.js'/)
  })

  it('聚合注册早于 modelAdapters（表要引用其返回值），且 modelAdapters 早于 registerJetHubRpc', () => {
    const registered = code.indexOf('registerAggregateLlm(ctx')
    const table = code.indexOf('const modelAdapters')
    const rpc = code.indexOf('registerJetHubRpc(ctx')
    expect(registered).toBeGreaterThan(-1)
    expect(table).toBeGreaterThan(registered)
    expect(rpc).toBeGreaterThan(table)
  })
})

/**
 * ★★ 聚合 provider 关闭后**不得**被「动态目录长大」静默重新打开（真实缺陷，实测复现）。
 *
 * ## 机制（两侧判据的真实冲突）
 *
 * - master 的「供应商一键关闭」（`jet-hub-rpc.ts:4017`）把**当时的**全量目录 id 写进
 *   黑名单：`pool.setModelsDisabled(provider, catalog.ids)`；
 * - `provider.status`（`:3952`）的判据是 `closed = total > 0 && disabled === total`，
 *   而 `total` 取自 **`listAllModels()`**（`fullCatalogIds` 优先用它）；
 * - 对**其余 14 家**，目录是**固定**的 ⇒ 「写一次快照」永远成立；
 * - ⚠️ 但聚合的目录是**动态推导**的（`refreshCatalog`：登录新渠道就长出新的虚拟模型）
 *   ⇒ 快照长大之后，旧黑名单**盖不住**新模型 ⇒ `disabled < total` ⇒
 *   **开关自动翻回「已打开」**，且新模型**可被选中**。
 *
 * ## 实测（探针，修前）
 * ```
 * ① 关闭 ⇒ 黑名单 [auto, deepseek-v4-1-flash]，status {total:2,disabled:2,closed:true}，播报 []
 * ② 登录 codearts ⇒ 目录 [auto, deepseek-v4-1-flash, glm-5-3]
 *    status {total:3,disabled:2,closed:false} ⇒ 开关显示「已打开」   ← 缺陷
 * ③ aggregate.listModels() 播报 ["glm-5-3"]                       ← 泄漏
 * ```
 *
 * ## 判据
 * 若该 provider **处于已关闭态**（黑名单非空 **且** 覆盖了上一次的全量目录），
 * 则重推目录后**必须把新增的模型补进黑名单**（维持「整个 provider 关闭」的语义）。
 * ⚠️ 不能无条件写：用户**从未关闭**过它时（黑名单为空）不得凭空写入。
 */
describe('★★ 聚合关闭后不得被动态目录长大重新打开', () => {
  const makeWorld = () => {
    const disabled = {}
    let extraChannel = false
    const pool = {
      disabledModelsFor: (p: string) => new Set(Object.keys(disabled[p] ?? {})),
      listDisabledModels: (p: string) => ({ ...(disabled[p] ?? {}) }),
      async setModelsDisabled(p: string, ids: readonly string[]) {
        for (const id of ids) disabled[p] = { ...(disabled[p] ?? {}), [id]: true }
      },
      async clearDisabledModels(p: string) {
        delete disabled[p]
      },
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: { access_token: 't' } },
      ],
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { access_token: 't' } }),
      listAggregateRejections: () => ({}),
    }
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => (extraChannel
          ? [{ id: 'buddy' }, { id: 'codearts' }]
          : [{ id: 'buddy' }]),
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'glm-5.3', name: 'GLM-5.3' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool as never, expiryProbe: async () => 100, rejections: () => ({}),
    })
    return {
      adapter, pool, disabled,
      loginExtraChannel: () => { extraChannel = true },
    }
  }

  it('★★ 关闭后目录长大 ⇒ 必须把新模型补进黑名单（不得泄漏、开关不得翻回）', async () => {
    const { adapter, pool, loginExtraChannel } = makeWorld()
    // ① 初始目录只含 buddy
    await adapter.listModels('aggregate')
    const firstIds = adapter.listAllModels().map((m) => m.id)
    expect(firstIds).toEqual(['auto', 'deepseek-v4-1-flash'])
    // ② 模拟 master 的「一键关闭」：写入当时的全量快照
    await pool.setModelsDisabled('aggregate', firstIds)
    // ③ 登录新渠道 ⇒ 目录长大（force 重推，模拟 TTL 过期后的下一次推导）
    loginExtraChannel()
    await adapter.describeCatalog(true)
    await adapter.listModels('aggregate')
    // ★ 新增的模型必须**也**被关闭（否则整个 provider 就算「没关」）
    const after = adapter.listAllModels().map((m) => m.id)
    expect(after, '目录确实长大了').toContain('glm-5-3')
    const dmap = pool.listDisabledModels('aggregate')
    expect(dmap['glm-5-3'], '★ 新增模型必须补进黑名单（不得泄漏）').toBe(true)
    // ★ 且 listModels 不得播出它
    const broadcast = (await adapter.listModels('aggregate')).map((m) => m.id)
    expect(broadcast, '关闭态下不得播出任何模型').toEqual([])
  })

  it('★ 对照：**从未关闭**过聚合 ⇒ 不得凭空写黑名单', async () => {
    const { adapter, pool } = makeWorld()
    await adapter.describeCatalog(true)
    await adapter.listModels('aggregate')
    expect(pool.listDisabledModels('aggregate'), '没关闭过就不该有黑名单').toEqual({})
    // 且模型可正常选出
    const broadcast = (await adapter.listModels('aggregate')).map((m) => m.id)
    expect(broadcast.length, '未关闭时应能选出模型').toBeGreaterThan(0)
  })

  it('★ 对照：**用户手动打开**（黑名单清空）后目录再长大 ⇒ 不得再补写', async () => {
    const { adapter, pool, loginExtraChannel } = makeWorld()
    await adapter.listModels('aggregate')
    await pool.setModelsDisabled('aggregate', adapter.listAllModels().map((m) => m.id))
    // 用户重新打开
    await pool.clearDisabledModels('aggregate')
    loginExtraChannel()
    await adapter.describeCatalog(true)
    await adapter.listModels('aggregate')
    expect(pool.listDisabledModels('aggregate'), '已打开 ⇒ 不得再补写').toEqual({})
  })
})
