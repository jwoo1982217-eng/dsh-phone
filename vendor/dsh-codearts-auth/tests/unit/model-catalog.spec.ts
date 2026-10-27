/**
 * `createModelCatalog` 骨架的**六条不变式**（设计文档 §3.5.4.3）。
 *
 * ⚠️ 这些不变式**每一条都对应一个真实缺陷**（注释里逐条记了来源），
 * 不是「看起来该这样」—— 故它们是**验收判据**，不得为了改绿而放宽。
 *
 * ⚠️ 本文件的用例**不驱动 `apply()`**，故无需 `fetch` 桩（`accountPool` 是替身）。
 */

import { describe, expect, it, vi } from 'vitest'

import { createModelCatalog, type CatalogEntry } from '../../src/model-catalog.js'

/** 造一个最简 provider（替身 accountPool + 可控目录）。 */
function makeCatalog(
  entries: readonly CatalogEntry[],
  options: {
    visible?: boolean
    disabled?: readonly string[]
    syncEntries?: readonly CatalogEntry[]
  } = {},
) {
  const pool = {
    hasLoggedInAccount: vi.fn(async () => options.visible ?? true),
    disabledModelsFor: vi.fn(() => new Set(options.disabled ?? [])),
  }
  const catalog = createModelCatalog(
    { accountPool: pool as never },
    {
      product: { id: 'demo' },
      loadCatalog: () => entries,
      syncCatalog: () => options.syncEntries ?? entries,
    },
  )
  return { catalog, pool }
}

describe('createModelCatalog：骨架的六条不变式', () => {
  it('① 无已登录账号 ⇒ 返回 []，**不抛错**（抛错会在 catalog 里多一条 provider 报错）', async () => {
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1' }], { visible: false })
    await expect(catalog.listModels('demo')).resolves.toEqual([])
  })

  it('② resolveModel 的 provider/id 必须按入参回填（否则 DSH 抛 INVALID_MODEL_INFO）', async () => {
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1' }])
    const info = await catalog.resolveModel('demo', 'm1')
    expect(info.provider).toBe('demo')
    expect(info.id).toBe('m1')
  })

  it('③ 未知模型：name 回退到**裸 model**（绝不空），且**不编造** context', async () => {
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1' }])
    const info = await catalog.resolveModel('demo', 'never-heard-of-it')
    expect(info.name).toBe('never-heard-of-it')
    expect(info.context).toBeUndefined()
  })

  it('④ ⚠️ inputModalities **三态**：省略（未知）与 [\'text\'] 不同', async () => {
    // 未知：`inputModalities` 整个缺席（buddy 拿不到远端能力表时的形态）。
    const unknown = makeCatalog([{ id: 'm1', name: 'M1' }])
    const listed = await unknown.catalog.listModels('demo')
    // ⚠️ 「未知」必须**省略该字段**，而不是写 ['text'] —— 后者会明确声明
    //    不支持图片，静默把图片能力关掉。
    expect('inputModalities' in listed[0]!).toBe(false)

    // 明确不支持：写 `['text']`（与上面**不同**，不可合并）。
    const textOnly = makeCatalog([{ id: 'm1', name: 'M1', inputModalities: ['text'] }])
    expect((await textOnly.catalog.listModels('demo'))[0]!.inputModalities).toEqual(['text'])

    // resolveModel 侧同样保持三态。
    const unknownResolved = await unknown.catalog.resolveModel('demo', 'm1')
    expect('inputModalities' in unknownResolved).toBe(false)
  })

  it('⑤ reasoning：efforts 非空才声明，且 defaultEffort 必须在 efforts 内', async () => {
    const efforts = [
      { id: 'low' as never, name: 'Low' },
      { id: 'high' as never, name: 'High' },
    ]
    // 非法 defaultEffort ⇒ 整个 reasoning 不下发。
    const bogus = makeCatalog([
      { id: 'm1', name: 'M1', reasoning: { efforts, defaultEffort: 'bogus' as never } },
    ])
    expect((await bogus.catalog.resolveModel('demo', 'm1')).reasoning).toBeUndefined()

    // 合法 defaultEffort ⇒ 下发。
    const legal = makeCatalog([
      { id: 'm1', name: 'M1', reasoning: { efforts, defaultEffort: 'high' as never } },
    ])
    expect((await legal.catalog.resolveModel('demo', 'm1')).reasoning?.defaultEffort).toBe('high')

    // 无 defaultEffort 但 efforts 非空 ⇒ 下发（缺省保留 provider 自己的默认）。
    const noDefault = makeCatalog([{ id: 'm1', name: 'M1', reasoning: { efforts } }])
    expect((await noDefault.catalog.resolveModel('demo', 'm1')).reasoning?.efforts).toHaveLength(2)

    // efforts 为空 ⇒ 不声明（UI 不出现档位选择器）。
    const empty = makeCatalog([{ id: 'm1', name: 'M1', reasoning: { efforts: [] } }])
    expect((await empty.catalog.resolveModel('demo', 'm1')).reasoning).toBeUndefined()
  })

  it('⑥ listAllModels 不套黑名单（设置页要能看到已关闭模型的倍率）', async () => {
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1 · x0.5' }], { disabled: ['m1'] })
    expect((await catalog.listModels('demo')).map((m) => m.id)).toEqual([])
    expect(catalog.listAllModels().map((m) => m.id)).toEqual(['m1'])
    expect(catalog.listAllModels()[0]!.name).toBe('M1 · x0.5')
  })
})

describe('createModelCatalog：两条来自真实缺陷的补充约束', () => {
  it('⑦ ⚠️ listAllModels 在**冷缓存**（从未调过 listModels）下**不得返回空**', async () => {
    // ⚠️ 真实缺陷史（`aggregate-adapter.ts`）：`listAllModels()` 是同步的，
    //    只能读上一次推导结果；而 `provider.status` 会在**冷缓存**下直接调它
    //    并据条数算 `models.total`，判据是 `closed = total > 0 && disabled === total`。
    //    ⇒ 冷缓存若返回空（total 只剩 auto），用户一关掉 auto 就会把该 provider
    //      **误显示为「已关闭」**。故必须回落到 `syncCatalog()` 的兜底表。
    const { catalog } = makeCatalog([{ id: 'remote', name: 'Remote' }], {
      syncEntries: [{ id: 'fallback-1', name: 'F1' }, { id: 'fallback-2', name: 'F2' }],
    })
    // 尚未调用过 listModels / resolveModel ⇒ 冷缓存。
    expect(catalog.listAllModels().map((m) => m.id)).toEqual(['fallback-1', 'fallback-2'])
  })

  it('⑧ 热缓存后 listAllModels 用 loadCatalog 的结果（含远端才有、兜底没有的条目）', async () => {
    const { catalog } = makeCatalog([{ id: 'remote', name: 'Remote' }], {
      syncEntries: [{ id: 'fallback-1', name: 'F1' }],
    })
    await catalog.listModels('demo')
    expect(catalog.listAllModels().map((m) => m.id)).toEqual(['remote'])
  })

  it('⑨ description 必须透传（设计文档的 CatalogEntry 曾漏掉该字段 ⇒ 静默丢字段）', async () => {
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1', description: 'D1' }])
    expect((await catalog.listModels('demo'))[0]!.description).toBe('D1')
    expect((await catalog.resolveModel('demo', 'm1')).description).toBe('D1')
    // 缺席时**不写该字段**（与三态同理：不声明 ≠ 声明为空串）。
    const none = makeCatalog([{ id: 'm1', name: 'M1' }])
    expect('description' in (await none.catalog.listModels('demo'))[0]!).toBe(false)
  })

  it('⑩ isFree 只在声明时透出（listAllModels 供 Jet Hub 分组）', async () => {
    const { catalog } = makeCatalog([
      { id: 'free', name: 'Free', isFree: true },
      { id: 'paid', name: 'Paid' },
    ])
    const all = catalog.listAllModels()
    expect(all.find((m) => m.id === 'free')!.isFree).toBe(true)
    expect('isFree' in all.find((m) => m.id === 'paid')!).toBe(false)
  })

  it('⑪ 非法 maxTokens（0 / 负数 / NaN）不下发（否则 DSH 抛 INVALID_MODEL_MAX_TOKENS）', async () => {
    const { catalog } = makeCatalog([
      { id: 'zero', name: 'Z', maxTokens: 0 },
      { id: 'neg', name: 'N', maxTokens: -5 },
      { id: 'ok', name: 'O', maxTokens: 4096 },
    ])
    expect((await catalog.resolveModel('demo', 'zero')).defaultMaxTokens).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'neg')).defaultMaxTokens).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'ok')).defaultMaxTokens).toBe(4096)
  })

  it('⑫ contextWindow 非法（0 / 负数）不声明（不编造假窗口）', async () => {
    const { catalog } = makeCatalog([
      { id: 'zero', name: 'Z', contextWindow: 0 },
      { id: 'ok', name: 'O', contextWindow: 200_000 },
    ])
    expect((await catalog.resolveModel('demo', 'zero')).context).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'ok')).context).toEqual({ contextWindow: 200_000 })
  })

  it('⑬ ⚠️⚠️ **未知 id** 的模态由各家自己决定（骨架不得统一）', async () => {
    // ⚠️ 这是 Task 7b 实测踩到的**核心三态陷阱**：各家对「目录里没有的 id」处理不同，
    //    且**不能统一** —— 两个方向都会出真缺陷。
    //
    // 形态 A（**12 家**：cline/codearts/gemini/lobsterai/loomy/minimax/qoder/
    //        qodercn/raccoon/trae/zcode/opencode）：**保守报 `['text']`**
    //   ⇒ 若改成「省略」，用户手填的未知模型会从「明确不支持图片」变成「未知」
    //     ⇒ **图片被放行**、发到不支持的服务端（请求失败）。
    // ⚠️ 家数实测为 12（2026-10-08 二次复核修正；原写「5 家」是字段刚引入时的
    //    快照，后改「10 家」是**源码处数**而非家数 —— 两个口径都错过一次）。
    //    ⚠️ 本条用例**只演示骨架的两种形态**（用一个自造 config 代表形态 A）。
    //    **逐家核对**已由 `model-catalog-parity.spec.ts` 的
    //    `OMIT_UNKNOWN_MODALITIES`（真实适配器、双向断言）承担 —— 名单再腐坏
    //    会在那里点名到具体哪一家，不必在这里抄第二份。
    const conservative = createModelCatalog(
      { accountPool: { hasLoggedInAccount: async () => true, disabledModelsFor: () => new Set() } as never },
      {
        product: { id: 'demo' },
        loadCatalog: () => [{ id: 'm1', name: 'M1' }],
        syncCatalog: () => [{ id: 'm1', name: 'M1' }],
        unknownModelInputModalities: () => ['text'],
      },
    )
    expect((await conservative.resolveModel('demo', 'unknown-x')).inputModalities).toEqual(['text'])

    // 形态 B（buddy）：**省略该字段**（真「未知」，交给宿主判断）
    //   ⇒ 若改成 `['text']`，会**静默关掉图片能力**（功能看似正常，图片发不出去）。
    const unknownState = makeCatalog([{ id: 'm1', name: 'M1' }])
    expect('inputModalities' in (await unknownState.catalog.resolveModel('demo', 'unknown-x'))).toBe(false)

    // ⚠️ 两者对**已知** id 的行为一致（都读 entry 自己的值）。
    expect((await conservative.resolveModel('demo', 'm1')).inputModalities).toBeUndefined()
  })

  it('⑭ name 三级回退：bareName → name → 裸 model', async () => {
    // ⚠️⚠️ **`bareName` 优先于 `name`** —— 这一条与设计文档 §3.5.4.3 写的
    //    「entry.name → entry.bareName」**相反**，本用例钉住正确语义。
    //    依据：`bareName` 的存在意义就是「resolveModel 用的裸名」；
    //    且设计文档自己的验收表写「断言 resolveModel().name **不含 ` · x`**」。
    //    ⚠️ 本 Task 实测踩过：按「name 优先」实现会让 loomy 的
    //    `resolveModel().name` 变成 `'Spark X2.5 · x0.1'`（应 `'Spark X2.5'`），
    //    被 `loomy-adapter.spec.ts` 当场抓住。
    const { catalog } = makeCatalog([{ id: 'm1', name: 'M1 · x0.1', bareName: 'M1' }])
    expect((await catalog.resolveModel('demo', 'm1')).name).toBe('M1')

    // 不提供 bareName ⇒ 回退到 name（`minimax` 就是这一形态：它不剥倍率）。
    const noBare = makeCatalog([{ id: 'm1', name: 'M1 · x0.1' }])
    expect((await noBare.catalog.resolveModel('demo', 'm1')).name).toBe('M1 · x0.1')

    // 完全没有 entry ⇒ 回退到**裸 model**（绝不空）。
    const unknown = await noBare.catalog.resolveModel('demo', 'unknown-model')
    expect(unknown.name).toBe('unknown-model')
  })

  it('⑮ 黑名单过滤**不得改变** name（消歧必须基于未过滤集合）', async () => {
    // ⚠️ **本 Task（7c）修正的一处真实缺陷**：buddy 的 `listModels` 原先用
    //    **已过滤**的 `listed` 做同名消歧，而它自己的注释（`displayNameFor` 上方）
    //    明写「必须基于**未过滤**的全量集合 …… 否则名字随开关跳变」。
    //    实测存在同名不同 id（`hy4-preview` / `hy4-preview-f`）⇒ 该矛盾可观测。
    //    用户 2026-10-08 裁定修正为未过滤。
    //
    // 骨架的形态天然满足该语义：**name 在 `loadCatalog()` 里就算好**，
    // 之后的黑名单过滤只**摘掉条目**、不重算 name。本用例钉住这一点。
    const entries: CatalogEntry[] = [
      { id: 'hy4-preview', name: 'Hy4 preview · F' },
      { id: 'hy4-preview-f', name: 'Hy4 preview · F2' },
    ]
    const { catalog } = makeCatalog(entries, { disabled: ['hy4-preview'] })
    const listed = await catalog.listModels('demo')
    // 只剩一个（另一个被黑名单摘掉）……
    expect(listed.map((m) => m.id)).toEqual(['hy4-preview-f'])
    // ……但它的 name 仍是**目录里那一份**，不因另一个被摘掉而变化。
    expect(listed[0]!.name).toBe('Hy4 preview · F2')
    // `listAllModels` 看到两份、名字也不变 ⇒ 两条路径对同一模型给出**同一个 name**
    //（修正前 `listModels` 用 listed、`listAllModels` 用 source，有黑名单时会不同）。
    expect(catalog.listAllModels().map((m) => m.name)).toEqual(['Hy4 preview · F', 'Hy4 preview · F2'])
  })

  it('⑯ ⚠️ **未知 id** 的 reasoning 由各家自己决定（cline/codearts 恒声明）', async () => {
    // ⚠️ **本 Task（7d）修回的一处回归**：`cline` 与 `codearts` 的档位来自
    //    **产品配置 / 网关协议**（与具体模型无关），故它们对**未知 id 也声明**
    //    reasoning。7b 把 reasoning 绑在 `toCatalogEntry`（依赖 entry）后，
    //    未知模型**丢失了档位选择器** —— 由 `cline-adapter.spec.ts` 的
    //    「未知模型同样有 5 档」用例当场抓住。
    const efforts = [
      { id: 'low' as never, name: '低' },
      { id: 'high' as never, name: '高' },
    ]
    const withUnknownReasoning = createModelCatalog(
      { accountPool: { hasLoggedInAccount: async () => true, disabledModelsFor: () => new Set() } as never },
      {
        product: { id: 'demo' },
        loadCatalog: () => [{ id: 'm1', name: 'M1' }],
        syncCatalog: () => [{ id: 'm1', name: 'M1' }],
        unknownModelReasoning: () => ({ efforts, defaultEffort: 'high' as never }),
      },
    )
    const unknown = await withUnknownReasoning.resolveModel('demo', 'unknown-x')
    expect(unknown.reasoning?.efforts).toHaveLength(2)
    expect(unknown.reasoning?.defaultEffort).toBe('high')

    // ⚠️ 不提供该回调 ⇒ 未知模型**不声明** reasoning（多数家的正确行为：
    //    档位是「该模型的能力」，未知模型不该臆造）。
    // ⚠️ 本用例只演示**两种形态**（自造 config）。**逐家核对**谁属于哪一形态
    //    已由 `model-catalog-parity.spec.ts` 的 `DECLARE_UNKNOWN_REASONING`
    //    （真实适配器、双向断言）承担 —— 名单腐坏会在那里点名到具体哪一家，
    //    不必在这里抄第二份会腐的清单。
    const without = makeCatalog([{ id: 'm1', name: 'M1' }])
    expect((await without.catalog.resolveModel('demo', 'unknown-x')).reasoning).toBeUndefined()

    // ⚠️ 已知模型仍读**它自己的** entry（不因提供了回调而串味）。
    const known = await withUnknownReasoning.resolveModel('demo', 'm1')
    expect(known.reasoning).toBeUndefined()

    // ⚠️ `defaultEffort` 越界仍不下发（与已知模型同一条判据）。
    const bogus = createModelCatalog(
      { accountPool: { hasLoggedInAccount: async () => true, disabledModelsFor: () => new Set() } as never },
      {
        product: { id: 'demo' },
        loadCatalog: () => [],
        syncCatalog: () => [],
        unknownModelReasoning: () => ({ efforts, defaultEffort: 'bogus' as never }),
      },
    )
    expect((await bogus.resolveModel('demo', 'unknown-x')).reasoning).toBeUndefined()
  })
})
