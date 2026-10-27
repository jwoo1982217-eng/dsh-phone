import { describe, expect, it } from 'vitest'
import { sanitizeAggregateRejections } from '../../src/jet-hub-store.js'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'
import { buildVirtualModels } from '../../src/aggregate-catalog.js'
import { WIRED_EXPIRY_PROVIDERS } from '../../src/aggregate-expiry.js'
import { AccountPool } from '../../src/account-pool.js'

describe('sanitizeAggregateRejections：只保留显式 true，空层不保留', () => {
  it('保留三层都是 true 的条目', () => {
    const raw = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    expect(sanitizeAggregateRejections(raw)).toEqual(raw)
  })

  it('丢弃非 true 的值（false / 1 / "true" / null 都不算拒绝）', () => {
    // ⚠️ 只有显式 `true` 才算拒绝 —— 与 sanitizeDisabledModels 同一口径。
    //    宽松接受 truthy 会让 `"false"`（非空字符串）被当成拒绝，用户莫名其妙丢一个渠道。
    const raw = {
      m: {
        buddy: { a: false, b: 1, c: 'true', d: null, e: true },
      },
    }
    expect(sanitizeAggregateRejections(raw)).toEqual({ m: { buddy: { e: true } } })
  })

  it('空层不保留（不留 { m: {} } / { m: { buddy: {} } } 这类噪音）', () => {
    expect(sanitizeAggregateRejections({ m: {} })).toEqual({})
    expect(sanitizeAggregateRejections({ m: { buddy: {} } })).toEqual({})
    expect(sanitizeAggregateRejections({ m: { buddy: { a: false } } })).toEqual({})
  })

  it('畸形输入一律退化为空表（数组 / null / 字符串 / 数字）', () => {
    for (const bad of [null, undefined, [], 'x', 42, true]) {
      expect(sanitizeAggregateRejections(bad)).toEqual({})
    }
  })

  it('中间层畸形时跳过该层，不影响其它层', () => {
    const raw = { m: { buddy: 'not-an-object', codearts: { x: true } } }
    expect(sanitizeAggregateRejections(raw)).toEqual({ m: { codearts: { x: true } } })
  })

  it('★ 原型链键不得被当成拒绝条目（与 canonical-models 的 M9 同类）', () => {
    // ⚠️ 普通对象字面量沿原型链可命中 constructor / toString 等键。
    //    本函数用 Object.entries 遍历**自有**键，故原型链键天然不会被遍历到 ——
    //    本用例把该保证显式锁住（防止将来改成 `for (const k in raw)`）。
    //
    // ⚠️ 注意本表是**三层**（虚拟模型 → provider → realId → true），故构造用例时
    //    必须给足三层；`{ constructor: { x: true } }` 只有两层，会被正确地判为
    //    「中间层畸形」而丢弃（我第一次就把期望写成了两层，实测后才订正）。
    const threeLayers = { constructor: { ctor: { 'real-id': true } } }
    expect(sanitizeAggregateRejections(threeLayers)).toEqual(threeLayers)
    // 而**两层**（缺 realId 层）应被丢弃 —— 这正是「层数不足即畸形」的方向。
    expect(sanitizeAggregateRejections({ constructor: { x: true } })).toEqual({})
    // 空对象不该因为原型链而产出条目
    expect(sanitizeAggregateRejections({})).toEqual({})
  })

  it('★ 数组层被拒绝（不能把数组当成 map）', () => {
    // ⚠️ `typeof [] === 'object'`，只判 object 会让数组通过。
    expect(sanitizeAggregateRejections({ m: { buddy: ['a'] } })).toEqual({})
    expect(sanitizeAggregateRejections({ m: [] })).toEqual({})
  })
})

describe('★ 拒绝必须真的生效：被拒候选不得出现在候选序里', () => {
  type RejectionTable = Record<string, Record<string, Record<string, boolean>>>

  const makeAdapter = (rejections: () => RejectionTable) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'codearts' }],
        listModels: async (p: string) => (p === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    // buddy 更临期 ⇒ 正常情况下它排第一
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (p: string) => (p === 'buddy' ? 100 : 900),
      rejections,
    })
    return { adapter, sent }
  }

  const run = async (adapter: AggregateAdapter, model: string) => {
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
  }

  it('拒绝临期更早的那个渠道 ⇒ 请求发给下一个候选', async () => {
    const { adapter, sent } = makeAdapter(() => ({
      'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } },
    }))
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['codearts'])
  })

  it('对照：不拒绝时临期更早的 buddy 排第一（证明差异来自拒绝，不是别的）', async () => {
    const { adapter, sent } = makeAdapter(() => ({}))
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['buddy'])
  })

  it('拒绝只影响**指定的那个虚拟模型**（别的模型不受影响）', async () => {
    // ⚠️ 粒度是「虚拟模型 + 渠道 + realId」。若实现成「按渠道全局拒绝」，
    //    buddy 在别的模型上也会被跳掉 —— 那是过度拒绝。
    const { adapter, sent } = makeAdapter(() => ({
      'some-other-model': { buddy: { 'deepseek-v4.1-flash': true } },
    }))
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['buddy'])
  })

  it('★ 拒绝只影响**指定的那个 realId**（同渠道的别的候选不受影响）', async () => {
    // ⚠️⚠️ **本条在实现 D4（id 漂移降级）时重写过两次，两处前提都被实测推翻**：
    //
    // ① 原版拒绝 `'a-different-real-id'`（一个**不存在于任何候选**的 id）并断言
    //    「该渠道仍参与」。而 D4 规定「无精确匹配 + 该渠道有 `true` 记录 ⇒
    //    **降级为渠道级拒绝**」（规格 §5.1 判据表，理由见 §1.9：lobsterai 的候选 id
    //    会在 `deepseek-flash` ↔ `deepseek-v4-flash` 间切换，只锁 realId 会
    //    「一翻转就匹配不上、静默失效」）⇒ **两者直接冲突**，且旧断言依赖的正是
    //    D4 要消除的那个静默失效。
    // ② 我第二版改用「workbuddy 的 `deepseek-v4.1-flash` 与 `-sg` 同键」——
    //    **那个前提是错的**（探针实测：`-sg` 归到**独立**虚拟键
    //    `deepseek-v4-1-flash-sg`，`normalizeModelKey` 不剥 `-sg`）；
    //    原注释里那句「同渠道多个 realId 归一到同一虚拟模型」因此是**误述**。
    //    现实里（真实目录形态）**没有**同渠道同键的多候选。
    //
    // ⇒ 改为断言**现实可验**的 realId 精度：**同一虚拟模型下、不同渠道**各有候选，
    //    拒绝其中一个渠道的那一条 ⇒ 另一个渠道不受影响（且被拒的那个确实不进池）。
    const { adapter, sent } = makeAdapter(
      () => ({ 'deepseek-v4-1-flash': { codearts: { 'deepseek-v4.1-flash': true } } }),
    )
    await run(adapter, 'deepseek-v4-1-flash')
    // buddy 更临期（桩里 buddy=100 < codearts=900），而 codearts 被精确拒绝
    // ⇒ 只发往 buddy。若「拒绝」没有精确到 realId/渠道，会发往 codearts 或两条都发。
    expect(sent).toEqual(['buddy'])
  })

  it('全部候选被拒 ⇒ 如实报零候选（不是静默成功）', async () => {
    const { adapter } = makeAdapter(() => ({
      'deepseek-v4-1-flash': {
        buddy: { 'deepseek-v4.1-flash': true },
        codearts: { 'deepseek-v4.1-flash': true },
      },
    }))
    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  /**
   * ★★ 候选必须按**自己的 `realId`** 复核账号可用性（真实缺陷，2026-10-07）。
   *
   * ## 缺陷机制
   *
   * 「额度耗尽」在账号池里是**按 modelId 记账**的
   * （`entry.modelRateLimits[modelId]`，codearts 的 benefit 耗尽就写在那里，
   * `llm-adapter.ts:1290`）。而临期折算取号时用的模型键是**渠道目录的第一个模型**
   * （`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），**不是**候选要派发的
   * `realId` ⇒ 那个按 modelId 的过滤对聚合路径**整体失效**：
   *
   * | 路径 | 探测键 | 实际派发 | 过滤 |
   * |---|---|---|---|
   * | auto | `firstModelOf`（= 派发） | 同一个 | ✓ |
   * | **aggregate** | `models[0]` | **候选 `realId`** | ✗ **失效** |
   *
   * ⇒ 账号在「要派发的那个模型」上额度已尽，聚合仍把它当可用候选发出去，
   * 请求以 `InferHub.4291.200 insufficient quota`（benefit 额度）失败。
   */
  describe('★★ 候选可用性必须按 realId 复核（额度耗尽按模型记账）', () => {
    /** 建一个「按 provider+modelId 判可用性」的池 + 两个渠道（buddy 更临期）。 */
    const makeGated = (blockedProvider: string, blockedModel: string, failing?: string) => {
      const sent: string[] = []
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy' }, { id: 'codearts' }],
          listModels: async (p: string) => (p === 'buddy'
            ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
            : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
          stream: (o: { provider: string }) => {
            sent.push(o.provider)
            // `failing` 指定的渠道返回**终止 error chunk**（与 dsh-llm 的归一化一致）
            // ⇒ 触发聚合层的「失败切换」逻辑，从而暴露「候选序里还有谁」。
            if (failing !== undefined && o.provider === failing) {
              return (async function* () {
                yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } }
              })()
            }
            return (async function* () { yield { type: 'text', text: 'ok' } })()
          },
        },
      } as never
      const pool = {
        disabledModelsFor: () => new Set<string>(),
        // 复刻真实判据：只在该 provider 的该模型被标记时返回 null。
        getAvailableAccount: async (p: string, modelId: string) =>
          (p === blockedProvider && modelId === blockedModel
            ? null
            : { entry: { id: 'a1' }, credential: {} }),
      } as never
      const adapter = new AggregateAdapter(ctx, {
        accountPool: pool,
        expiryProbe: async (p: string) => (p === 'buddy' ? 100 : 900),
        rejections: () => ({}),
      })
      return { adapter, sent }
    }

    it('★★ 更临期的渠道在**目标模型**上额度已尽 ⇒ 必须让位给下一个候选', async () => {
      // buddy 临期更早（100 < 900），但它在 `deepseek-v4.1-flash` 上被标记额度耗尽
      // ⇒ 必须跳过它、发往 codearts。修复前：`expiryProbe` 只报临期值（100），
      //    按 modelId 的可用性过滤对聚合路径失效 ⇒ 请求发往 buddy 必然失败
      //    （codearts 的 benefit 额度耗尽就是这种形态，`InferHub.4291.200`）。
      const { adapter, sent } = makeGated('buddy', 'deepseek-v4.1-flash')
      await run(adapter, 'deepseek-v4-1-flash')
      expect(sent, '额度已尽的渠道必须让位').toEqual(['codearts'])
    })

    it('★★★ 被剔除的候选**不得**作为失败回落的兜底（真实缺陷，对抗审计实测证伪）', async () => {
      // ⚠️⚠️ **本条锁的是一个比「排序」更深的缺陷**（我上一版修复只改了一半）：
      //
      // 建池时每个候选的 `expiry` 初值是 `NEVER`，而 `rankCandidates`
      // （`aggregate-core.ts:145`）**只剔除 `UNUSABLE`** —— `NEVER` 是合法排序值
      // （「可用、只是不临期」）。故「只把候选从折算循环里拿掉」时，它的 `expiry`
      // 仍是 `NEVER` ⇒ **照样进入候选序**、只是排最后；而 `targets` 是**逐个尝试**
      // 的 ⇒ 前面的候选一失败，就**回落到那个额度已尽的候选**。
      //
      // 实测（对抗审计探针）：buddy 可用 + codearts 额度已尽 ⇒ 候选序
      // `[buddy, codearts]`；buddy 失败后请求**发往 codearts** —— 缺陷只是被
      // **推迟**而非消除。修法：被剔除的候选必须显式 `expiry = UNUSABLE`。
      //
      // ⚠️ 我上一版的两条用例（让位 + 对照）都**抓不到**它 —— 因为那里第一个
      //    候选就成功了，从不触发回落。**必须让前面的候选失败**才能暴露。
      const { adapter, sent } = makeGated('codearts', 'deepseek-v4.1-flash', 'buddy')
      // ⚠️ 全部候选都失败时聚合会**如实抛出**最后一个错误 —— 这是正确行为
      //    （不是静默成功），故这里吞掉它、只断言「发往了谁」。
      try {
        await run(adapter, 'deepseek-v4-1-flash')
      } catch { /* 预期：buddy 是唯一候选且它失败了 */ }
      expect(sent, 'buddy 失败后不得回落到额度已尽的 codearts').toEqual(['buddy'])
    })

    it('★ 对照：不设额度标记时，临期更早的 buddy 正常当选', async () => {
      const { adapter, sent } = makeGated('__none__', '__none__')
      await run(adapter, 'deepseek-v4-1-flash')
      expect(sent).toEqual(['buddy'])
    })

    it('★ 只标记**别的**模型 ⇒ 不影响本模型（过滤按 realId 精确匹配）', async () => {
      const { adapter, sent } = makeGated('buddy', 'some-other-model')
      await run(adapter, 'deepseek-v4-1-flash')
      expect(sent).toEqual(['buddy'])
    })

    it('★ 池未实现 `getAvailableAccount` ⇒ 跳过过滤（宁可少筛，不可误剔除整池）', async () => {
      // ⚠️ 大量既有单测桩只实现 `disabledModelsFor`。缺失该方法时必须**跳过过滤**，
      //    而不是把候选判成不可用 —— 否则所有桩用例都会「零候选」。
      const sent: string[] = []
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
          stream: (o: { provider: string }) => {
            sent.push(o.provider)
            return (async function* () { yield { type: 'text', text: 'ok' } })()
          },
        },
      } as never
      const adapter = new AggregateAdapter(ctx, {
        accountPool: { disabledModelsFor: () => new Set<string>() } as never,
        expiryProbe: async () => 100,
        rejections: () => ({}),
      })
      await run(adapter, 'deepseek-v4-1-flash')
      expect(sent).toEqual(['buddy'])
    })

    it('★ 池查询抛错 ⇒ 保留候选（一次查询异常不得让渠道整体消失）', async () => {
      const sent: string[] = []
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
          stream: (o: { provider: string }) => {
            sent.push(o.provider)
            return (async function* () { yield { type: 'text', text: 'ok' } })()
          },
        },
      } as never
      const adapter = new AggregateAdapter(ctx, {
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          getAvailableAccount: async () => { throw new Error('池异常') },
        } as never,
        expiryProbe: async () => 100,
        rejections: () => ({}),
      })
      await run(adapter, 'deepseek-v4-1-flash')
      expect(sent, '查询异常 ⇒ 保留候选').toEqual(['buddy'])
    })
  })

  it('★ 拒绝表是**函数**：改过之后下一次请求立刻生效（不能读快照）', async () => {
    // ⚠️ 若传的是**快照对象**，用户在面板上关掉一个候选后必须等插件重启才生效 ——
    //    那是真实缺陷（用户会以为开关坏了）。
    let table: RejectionTable = {}
    const { adapter, sent } = makeAdapter(() => table)
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['buddy'])
    // 面板上关掉 buddy
    table = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    sent.length = 0
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['codearts'])
  })

  it('★ 拒绝表变化后**选型缓存必须失效**（否则 60 秒内仍用旧候选序）', async () => {
    // ⚠️ choiceCache 的 TTL 是 60 秒。若面板改了拒绝表但缓存没清，
    //    用户在面板上关掉的候选在 60 秒内仍会被尝试 —— 用户会以为开关坏了。
    let table: RejectionTable = {}
    const { adapter, sent } = makeAdapter(() => table)
    await run(adapter, 'deepseek-v4-1-flash')   // 填缓存
    expect(sent).toEqual(['buddy'])
    // 模拟 RPC 改完拒绝表后清缓存（Task 3 的端点会调它）
    table = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    adapter.clearChoiceCache()
    sent.length = 0
    await run(adapter, 'deepseek-v4-1-flash')
    expect(sent).toEqual(['codearts'])
  })

  it('★ 被拒候选**不进池** ⇒ 不为它做余额探测（省一次上游 GET）', async () => {
    // ⚠️ 在**折算后**过滤（而不是建池时排除）会白白为被拒候选做一次余额探测。
    //    本用例断言探测次数 —— 两个渠道但只有一个未被拒 ⇒ 只应探测 1 次。
    const probed: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'codearts' }],
        listModels: async (p: string) => [{ id: p === 'buddy' ? 'deepseek-v4.1-flash' : 'deepseek-v4.1-flash', name: 'M' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (p: string) => { probed.push(p); return 100 },
      rejections: () => ({ 'deepseek-v4-1-flash': { codearts: { 'deepseek-v4.1-flash': true } } }),
    })
    await run(adapter, 'deepseek-v4-1-flash')
    expect(probed).toEqual(['buddy'])
  })
})

describe('★ aggregate.catalog 的组装（只读、零余额查询）', () => {
  const makeAdapter = (rejections: () => Record<string, Record<string, Record<string, boolean>>>, probe: () => void) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    return new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => { probe(); return 100 },
      rejections,
    })
  }

  it('每个候选都带 provider / realId / realName / 倍率 / 是否补丁 / 三态 / 是否接入折算', async () => {
    const adapter = makeAdapter(
      () => ({ 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }),
      () => {},
    )
    const catalog = await adapter.describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    expect(entry).toBeDefined()
    expect(entry!.name).toBe('DeepSeek V4.1 Flash')
    expect(entry!.candidates).toEqual([
      {
        provider: 'buddy',
        realId: 'deepseek-v4.1-flash',
        realName: 'Deepseek-V4.1-Flash · x0.15',
        price: 0.15,
        viaPatch: false,
        // ⚠️ 2026-10-15 起 `rejected` 的语义**收窄**为「当前不参与轮换」，且新增
        //    `state`（三态权威）与 `expiryWired`（客户端据此决定「关掉时写哪张表」）。
        rejected: true,
        state: 'rejected',
        expiryWired: true,
      },
    ])
  })

  it('★ 零余额查询：不得调用 expiryProbe（否则面板一打开就打十几次上游请求）', async () => {
    // ⚠️ 规格 §8.3 明确要求本端点只列候选与拒绝状态，与余额无关。
    //    实时余额仍由各渠道自己的面板负责。
    let probeCalls = 0
    const adapter = makeAdapter(() => ({}), () => { probeCalls += 1 })
    await adapter.describeCatalog()
    expect(probeCalls).toBe(0)
  })

  it('未被拒的候选 rejected 为 false、state 为 allowed', async () => {
    const adapter = makeAdapter(() => ({}), () => {})
    const catalog = await adapter.describeCatalog()
    expect(catalog.models[0]!.candidates[0]!.rejected).toBe(false)
    expect(catalog.models[0]!.candidates[0]!.state).toBe('allowed')
    // ⚠️ 缺省排序模式 = 临期序（升级前行为）。
    expect(catalog.orderMode).toBe('expiry')
  })

  it('补丁来源的候选 viaPatch 为 true', async () => {
    // ⚠️ 规格 §7.1 要求面板对补丁条目标 `⚠️补丁` 供人工核查 —— 数据必须来自这里。
    //
    // ⚠️⚠️ **本用例在「面板过滤未接入候选」修复后必须换测法**（2026-10-07）：
    //    补丁表 `CANONICAL_OVERRIDES` 目前**只有 lobsterai 一条**，而 lobsterai
    //    **未接入临期折算** ⇒ 面板现在会把它过滤掉 ⇒ 从 `describeCatalog` 里
    //    再也拿不到补丁候选。
    //
    //    ⇒ 但 `viaPatch` 这条**数据通路**仍然要验证（面板将来接入更多渠道时会用到）。
    //      改为直接测**归一化层** `buildVirtualModels` —— 那才是补丁生效的地方，
    //      与「面板显示哪些渠道」是两件独立的事。
    //
    //    ⚠️ 顺带记录一个**待决事实**：补丁表唯一的目标渠道（lobsterai）未接入临期折算，
    //      故这张表**目前在轮换里不起任何作用**，面板上的 `⚠️补丁` 标记也看不到。
    //      是否给 lobsterai 接入折算由用户决定（见规格 §9.1 的接入清单）。
    const virtual = buildVirtualModels({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
      // lobsterai 的 deepseek-flash 靠**显式补丁**归一（id/name 两通道都命中不了）
      lobsterai: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    })
    const target = virtual.find((m) => m.key === 'deepseek-v4-1-flash')
    expect(target, '补丁应把 lobsterai 的条目归入同一虚拟键').toBeDefined()
    const patched = target!.candidates.find((c) => c.via === 'patch')
    expect(patched, '补丁来源的候选必须被标记（面板据此标 ⚠️补丁）').toBeDefined()
    expect(patched!.provider).toBe('lobsterai')
    expect(patched!.realId).toBe('deepseek-flash')
  })

  it('★ 只读：describeCatalog 不得改动拒绝表', async () => {
    const table = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    const before = JSON.stringify(table)
    const adapter = makeAdapter(() => table, () => {})
    await adapter.describeCatalog()
    expect(JSON.stringify(table)).toBe(before)
  })

  it('★ force=true 必须绕过目录 TTL 缓存（面板「刷新」按钮的语义）', async () => {
    // ⚠️ 真实缺陷（对抗审计实测证伪）：`describeCatalog` 初版**恒不传 force**
    //    ⇒ 面板的「刷新」按钮实际是「读 60 秒缓存」，用户在渠道侧新增/关闭模型后
    //    点刷新**看不到任何变化**，会以为聚合坏了。
    //    同时 `refreshCatalog` 的 `force` 参数在**全仓零调用点**（死参数）。
    let phase = 1
    let listModelsCalls = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async () => {
          listModelsCalls += 1
          return phase === 1
            ? [{ id: 'm1', name: 'M1' }]
            : [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })

    // 首次：推导目录并填充 TTL 缓存
    await adapter.describeCatalog()
    const afterFirst = listModelsCalls
    expect(afterFirst).toBeGreaterThan(0)

    // 上游新增了 m2；**不带 force** 的第二次调用应命中缓存（读不到 m2）
    phase = 2
    const cached = await adapter.describeCatalog()
    expect(listModelsCalls).toBe(afterFirst)
    expect(cached.models.some((m) => m.canonicalId === 'm2')).toBe(false)

    // ★ 带 force 的调用（= 用户点「刷新」）必须**重推目录**并看到 m2
    const forced = await adapter.describeCatalog(true)
    expect(listModelsCalls).toBeGreaterThan(afterFirst)
    expect(forced.models.some((m) => m.canonicalId === 'm2')).toBe(true)
  })
})

/**
 * ★★ 未接入临期折算的渠道：候选**可见**、默认不参与、可手工打开（用户 2026-10-15，issue IKL7F9）。
 *
 * ⚠️⚠️ **本节的方向与 2026-10-07 那版相反**。当时用户报障「面板里出现了永远不会被用的
 * 渠道」，于是加了「只列已接入候选」的过滤。现在用户要的是「让它们进聚合、默认拒绝、
 * 手工打开则允许」⇒ 那条过滤**必须删掉**，否则用户在面板里**根本看不到**要打开的候选
 *（「手工打开」这个功能无从操作）。
 *
 * ⚠️ 那条「面板在撒谎」的顾虑改由**三态**承担：未接入且未打开的候选显示为
 * 「无临期积分 · 默认不参与」 ⇒ 面板依然说真话，只是把选择权交给用户。
 */
describe('★★ 未接入渠道的候选：可见、默认不参与、可手工打开（2026-10-15）', () => {
  const makeMixed = () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'lobsterai' }, { id: 'raccoon' }],
        listModels: async (provider: string) => [
          { id: 'deepseek-v4.1-flash', name: `Deepseek-V4.1-Flash · ${provider}` },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    return new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
  }

  it('★ 候选**全部**列出（含未接入的 raccoon），并逐条带三态', async () => {
    const catalog = await makeMixed().describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    expect(entry, '该模型应存在（buddy 已接入）').toBeDefined()
    const providers = entry!.candidates.map((c) => c.provider)
    expect(providers).toContain('buddy')
    expect(providers, '★ raccoon 未接入折算，但**仍要列出来**（用户要手工打开它）').toContain('raccoon')
    expect(providers).toContain('lobsterai')
    // 逐条三态：已接入 ⇒ allowed；未接入 ⇒ default-rejected（**默认不参与**）
    // ⚠️ `lobsterai` **已接入**折算（`aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`，
    //    2026-10-07 用户质疑后核实加入）⇒ 它是 `allowed`，别按「未接入」写期望值。
    //    本节真正要举的「未接入」例子是 `raccoon`（无到期字段）。
    expect(WIRED_EXPIRY_PROVIDERS, '前置事实：lobsterai 已接入').toContain('lobsterai')
    expect(WIRED_EXPIRY_PROVIDERS, '前置事实：raccoon 未接入').not.toContain('raccoon')
    const byProvider = Object.fromEntries(entry!.candidates.map((c) => [c.provider, c.state]))
    expect(byProvider.buddy).toBe('allowed')
    expect(byProvider.lobsterai).toBe('allowed')
    expect(byProvider.raccoon).toBe('default-rejected')
  })

  it('★ 未接入且未打开 ⇒ `rejected` 为 true（语义 = 当前不参与），`expiryWired` 为 false', async () => {
    const catalog = await makeMixed().describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    const raccoon = entry!.candidates.find((c) => c.provider === 'raccoon')!
    expect(raccoon.rejected).toBe(true)
    expect(raccoon.expiryWired).toBe(false)
    // 已接入的候选相反：参与、且标为已接入。
    const buddy = entry!.candidates.find((c) => c.provider === 'buddy')!
    expect(buddy.rejected).toBe(false)
    expect(buddy.expiryWired).toBe(true)
  })

  it('★ 手工打开某条未接入候选 ⇒ 它变成 allowed（白名单真的被读）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async (provider: string) => [
          { id: 'deepseek-v4.1-flash', name: `Deepseek-V4.1-Flash · ${provider}` },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
      allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
    })
    const catalog = await adapter.describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    const raccoon = entry!.candidates.find((c) => c.provider === 'raccoon')!
    expect(raccoon.state, '白名单命中 ⇒ 参与轮换').toBe('allowed')
    expect(raccoon.rejected).toBe(false)
  })

  it('★ 只有未接入候选的模型**也在**目录里（`:636` 的过滤已删）', async () => {
    // ⚠️ 方向反转：升级前它「整条不该出现」，现在它**必须**出现 —— 否则用户在面板里
    //    打开候选之后，选择器里仍然看不到这个模型（手工打开白做）。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'lobsterai' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'glm-5.3', name: 'GLM-5.3' }]
          : [{ id: 'sn-only-model', name: 'SN Only' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const catalog = await adapter.describeCatalog()
    const ids = catalog.models.map((m) => m.canonicalId)
    expect(ids).toContain('glm-5-3')
    // ⚠️ 规范键由 `canonicalKeyFor` 归一（`SN Only` → 连字符化），故这里**按前缀**断言
    //    而不是写死我猜的那个字符串 —— 写死会变成一条看起来像「功能没做」的假失败。
    expect(ids.some((id) => id.includes('only')), '★ 只有未接入候选的模型现在**也**要出现')
      .toBe(true)
  })

  it('★ 面板与真实轮换的候选集必须一致（不能一个说会用一个说不用）', async () => {
    // ⚠️ 这条仍是**不变式**，但判据换了：面板列出的候选现在 = **目录里的全部候选**
    //   （不再按「已接入」过滤）。「哪一个真的会参与」由每条候选自己的 `state` 表达 ——
    //    故本用例同时锁住「候选集一致」与「参与集 = state === allowed」这两件事。
    const adapter = makeMixed()
    const catalog = await adapter.describeCatalog()
    const listed = new Set(catalog.models.flatMap((m) => m.candidates.map((c) => c.provider)))
    expect([...listed].sort()).toEqual(['buddy', 'lobsterai', 'raccoon'])
    // 参与集必须恰好是已接入的那些（未接入的默认不参与）。
    const participating = new Set(
      catalog.models.flatMap((m) => m.candidates.filter((c) => c.state === 'allowed').map((c) => c.provider)),
    )
    const expected = ['buddy', 'lobsterai', 'raccoon'].filter((p) => WIRED_EXPIRY_PROVIDERS.includes(p))
    expect([...participating].sort()).toEqual(expected.sort())
    // 防「白名单把三个都收了」让这条变成恒真：raccoon 必须**不在**白名单里。
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('raccoon')
  })
})

describe('★ describeExpiryOrder：「按临期排序」的探测（唯一会打上游的面板方法）', () => {
  const makeAdapter = (probe: (p: string) => Promise<number>, calls: string[]) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'codearts' }, { id: 'raccoon' }],
        listModels: async (provider: string) => [
          { id: 'deepseek-v4.1-flash', name: `m-${provider}` },
          { id: 'glm-5.3', name: `g-${provider}` },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    return new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider: string) => { calls.push(provider); return probe(provider) },
    })
  }

  it('★ 按渠道去重：同一渠道只探一次（不重复打上游）', async () => {
    const calls: string[] = []
    const adapter = makeAdapter(async (p) => (p === 'buddy' ? 1_000 : 9_000), calls)
    const order = await adapter.describeExpiryOrder()
    // 三个渠道各探一次 —— 尽管 buddy 在**两个**虚拟模型下都出现
    expect(calls.sort()).toEqual(['buddy', 'codearts'])
    expect(order).toEqual({ buddy: 1_000, codearts: 9_000 })
  })

  it('★ 只探「已接入临期折算」的渠道（raccoon 不探）', async () => {
    const calls: string[] = []
    const adapter = makeAdapter(async () => 1_000, calls)
    const order = await adapter.describeExpiryOrder()
    expect(Object.keys(order).sort()).toEqual(['buddy', 'codearts'])
    expect(calls).not.toContain('raccoon')
  })

  it('★ 探测失败如实返回该值（不假装成功）', async () => {
    const calls: string[] = []
    const adapter = makeAdapter(async (p) => {
      if (p === 'buddy') throw new Error('boom')
      return 5_000
    }, calls)
    const order = await adapter.describeExpiryOrder()
    // buddy 抛错 ⇒ 记 UNUSABLE（-1），其余正常
    expect(order.buddy).toBe(-1)
    expect(order.codearts).toBe(5_000)
  })

  it('★ 中止必须抛出（不得被吞成默认值）', async () => {
    const calls: string[] = []
    const adapter = makeAdapter(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }, calls)
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.describeExpiryOrder(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('★★ 探测**途中**抛 AbortError（signal 未标记）⇒ 仍必须逃逸（补真实覆盖）', async () => {
    // ⚠️⚠️ 上一条是**假覆盖**（对抗审计用变异测试实测指出：删掉 `catch` 里的
    //    `isAbortLike` 逃逸后 35 条仍全绿）。原因与我在 `refreshCatalog` 踩过的
    //    坑**同型**：`controller.abort()` 在**调用之前** ⇒ 只触发入口的前置检查
    //    （`signal?.throwIfAborted()`），`catch` 里的逃逸分支**从未执行**。
    //
    //    ⇒ 本条让**探测函数自己抛 `AbortError`**（signal **未标记**）——
    //      这才是「读取途中被取消」的真实形态（`listModels` 没有 signal 通道，
    //      中止只能靠抛出的错误类型识别）。
    const calls: string[] = []
    const adapter = makeAdapter(async () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }, calls)
    // ⚠️ signal **未标记**
    const controller = new AbortController()
    await expect(adapter.describeExpiryOrder(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('★ 只读：不得改动拒绝表', async () => {
    const calls: string[] = []
    const table = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    const before = JSON.stringify(table)
    const adapter = makeAdapter(async () => 1_000, calls)
    await adapter.describeExpiryOrder()
    expect(JSON.stringify(table)).toBe(before)
  })
})

/**
 * ★ D4：拒绝记录的 id 漂移必须**降级为渠道级**（规格 §0.3 D4 + §1.9 + §5.1）。
 *
 * ## 规格原文（§5.1 的判据表）
 * ```
 * 查 (虚拟模型, provider, realId) 是否有拒绝记录
 * ├─ 有精确匹配 → 拒绝该候选
 * ├─ 无精确匹配，但该 (虚拟模型, provider) 下有**任何**拒绝记录
 * │     且该记录对应的 realId **已不在当前候选中**（id 漂移）
 * │     → 降级为渠道级拒绝（该虚拟模型下该渠道全部候选都被拒），并记一条 warn
 * └─ 无记录 → 参与轮换
 * ```
 *
 * ## ⚠️ 不实现的**真实后果**（§1.9 记录的静默失效）
 * `lobsterai` 的候选 id 会随「远端可用 / 兜底」切换：远端是 `deepseek-flash`
 *（真 V4.1 Flash），兜底表是 `deepseek-v4-flash`。若只锁 realId，
 * **状态一翻转就匹配不上、静默失效** ⇒ 用户明确拒绝过的候选**悄悄复活**。
 */
describe('★ D4：拒绝记录的 realId 漂移 ⇒ 降级为渠道级', () => {
  /** 造一个只有指定目录、指定拒绝表的适配器。 */
  const makeAdapter = (
    catalogs: Record<string, Array<{ id: string; name?: string }>>,
    rejections: Record<string, Record<string, Record<string, boolean>>>,
  ) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: id })),
        listModels: async (provider: string) => catalogs[provider] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: { access_token: 't' } },
      ],
    } as never
    return new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
      rejections: () => rejections,
    })
  }

  it('★ 精确命中 ⇒ 只拒那一条（不降级）', async () => {
    const adapter = makeAdapter(
      { buddy: [{ id: 'm1', name: 'M1' }] },
      { m1: { buddy: { m1: true } } },
    )
    const virtual = { key: 'm1', candidates: [{ provider: 'buddy', realId: 'm1' }] }
    expect([...adapter.rejectedFor(virtual)]).toEqual(['buddy\u0000m1'])
  })

  it('★ 记录里的 realId 已漂移走 ⇒ 降级为**渠道级**（该渠道全部候选都被拒）', async () => {
    // 记录锁的是旧 id `deepseek-v4-flash`，而当前候选是 `deepseek-flash`
    const adapter = makeAdapter(
      { lobsterai: [{ id: 'deepseek-flash', name: 'Deepseek-Flash' }] },
      { 'deepseek-v4-1-flash': { lobsterai: { 'deepseek-v4-flash': true } } },
    )
    const virtual = {
      key: 'deepseek-v4-1-flash',
      candidates: [{ provider: 'lobsterai', realId: 'deepseek-flash' }],
    }
    // ★ 降级：当前候选（deepseek-flash）也被拒
    expect([...adapter.rejectedFor(virtual)]).toEqual(['lobsterai\u0000deepseek-flash'])
  })

  it('★ 但「无精确命中 + 无漂移」不得降级（记录里的 id 就是当前候选之一 ⇒ 那是精确命中）', async () => {
    const adapter = makeAdapter(
      { buddy: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
      { m1: { buddy: { m2: true } } },
    )
    const virtual = {
      key: 'm1',
      candidates: [{ provider: 'buddy', realId: 'm1' }, { provider: 'buddy', realId: 'm2' }],
    }
    // 只拒 m2（精确），m1 仍参与
    expect([...adapter.rejectedFor(virtual)].sort()).toEqual(['buddy\u0000m2'])
  })

  it('★ 另一渠道有记录、本渠道无记录 ⇒ 不得把本渠道也拒掉', async () => {
    const adapter = makeAdapter(
      { buddy: [{ id: 'm1', name: 'M1' }], zcode: [{ id: 'm1', name: 'M1' }] },
      // ⚠️ 键必须**带引号**：`{ gone-id: true }` 会被 JS 解析成减法表达式
      //（对象字面量的键不能含连字符）—— 我第一版就这么写，导致整份文件语法错误
      //（`no tests` + esbuild 报 `Expected "}" but found "-"`）。
      { m1: { buddy: { 'gone-id': true } } },
    )
    const virtual = {
      key: 'm1',
      candidates: [{ provider: 'buddy', realId: 'm1' }, { provider: 'zcode', realId: 'm1' }],
    }
    const rejected = [...adapter.rejectedFor(virtual)]
    // buddy 降级（被拒）、zcode **不受影响**
    expect(rejected).toEqual(['buddy\u0000m1'])
  })

  it('★ 降级必须产生一条 warn（可排查：用户不知道自己的拒绝为何"还在生效"）', async () => {
    const warns: string[] = []
    const ctx = {
      logger: { warn: (m: string) => { warns.push(m) }, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'lobsterai', name: 'l' }],
        listModels: async () => [{ id: 'deepseek-flash', name: 'X' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
      rejections: () => ({ 'deepseek-v4-1-flash': { lobsterai: { 'deepseek-v4-flash': true } } }),
    })
    adapter.rejectedFor({
      key: 'deepseek-v4-1-flash',
      candidates: [{ provider: 'lobsterai', realId: 'deepseek-flash' }],
    })
    expect(warns.some((m) => m.includes('漂移') && m.includes('降级为渠道级拒绝'))).toBe(true)
  })
})

describe('★★ D4 降级必须**可恢复**（独立审计实测证伪：D4 让拒绝不可逆）', () => {
  /**
   * 造一个**真实**的 `AccountPool`（它持有权威拒绝表并可写盘）。
   *
   * ⚠️ 必须用真实池：恢复路径在**写入方法**里（`setAggregateRejected`），
   *    用桩替身测不到（我第一版就是那么写的，且用了不存在的方法 ⇒ **假覆盖**）。
   */
  const makePoolWithRejections = async (
    initial?: Record<string, Record<string, Record<string, boolean>>>,
  ) => {
    let stored: Record<string, unknown> = {}
    const mockSettings = {
      register: () => ({
        get: () => stored,
        replace: async (v: Record<string, unknown>) => { stored = v },
      }),
      describe: () => [],
    }
    const pool = new AccountPool({
      get: (key: string) => (key === 'settings' ? mockSettings : undefined),
      credentials: {
        async resolve() { return null },
        async describe() { return { source: 'mock' } },
        async refName() { return 'MOCK' },
      },
      logger: { info: () => {}, warn: () => {} },
    } as never)
    // ⚠️ 用**真实写入方法**播种（而不是直接改内部字段）—— 这样测的是真链路。
    for (const [canonicalId, byProvider] of Object.entries(initial ?? {})) {
      for (const [provider, byRealId] of Object.entries(byProvider)) {
        for (const [realId, flag] of Object.entries(byRealId)) {
          if (flag === true) {
            await pool.setAggregateRejected(canonicalId, provider, realId, true)
          }
        }
      }
    }
    return pool
  }

  const makeAdapterFromPool = (pool: AccountPool) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'lobsterai', name: 'l' }],
        listModels: async () => [{ id: 'deepseek-flash', name: 'Deepseek-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    return new AggregateAdapter(ctx, {
      accountPool: pool as never,
      expiryProbe: async () => 100,
      rejections: () => pool.listAggregateRejections(),
    })
  }

  it('★★ 用户「重新打开」当前候选后，降级必须**不再生效**（否则那条引导走不通）', async () => {
    // ⚠️⚠️ **真实缺陷**（独立审计实测证伪）：`rejectedFor` 的降级只判
    //    「该渠道有 `true` 记录 + 无精确命中」，**从不清理漂移的旧键**
    //    ⇒ 用户在面板上「重新打开」当前候选（`setAggregateRejected(..., false)`
    //    删的是**当前** realId）之后，**旧键仍在** ⇒ 降级继续生效。
    //
    //    而面板用 `isRejected(表, 当前 realId)` 判断显示 ⇒ 显示「参与轮换」，
    //    宿主实际仍拒绝 ⇒ **显示与行为分叉**。
    //
    //    ⚠️ 最讽刺的是降级 warn 的文案恰恰指引用户
    //    「在设置页「聚合」面板的该模型子列表里重新打开它」—— 而那条路**走不通**。
    //
    //    ⇒ 规格 §5.1 的表只定义了「怎么降级」，没定义「怎么恢复」；但 §5.2 与
    //      `jet-hub-store.ts` 的既有语义（「拒绝 ≠ 关闭，可重新打开」）要求可恢复。
    //      本用例锁的就是「恢复路径必须存在」。
    // 记录旧键（漂移走），当前候选是 deepseek-flash
    const virtual = {
      key: 'deepseek-v4-1-flash',
      candidates: [{ provider: 'lobsterai', realId: 'deepseek-flash' }],
    }
    // ★ **走真实的恢复路径**：`AccountPool.setAggregateRejected(..., false)`。
    //
    // ⚠️ 我第一版这里写的是 `adapter.setRejectedForTest?.(…)` —— 那个方法
    //    **不存在**，可选链 `.?.` 让整行**静默跳过** ⇒ 用例**根本没测到恢复路径**
    //    却仍然绿（**假覆盖**，正是我要求审计去查的那个形态，我自己又犯了一次）。
    //    ⇒ 改写为构造**真实**的 `AccountPool`（它持有权威表）并调用真实写入方法。
    const pool = await makePoolWithRejections({
      'deepseek-v4-1-flash': { lobsterai: { 'deepseek-v4-flash': true } },
    })
    const realAdapter = makeAdapterFromPool(pool)
    // 前置：当前确实被降级拒绝（旧键漂移走）
    expect([...realAdapter.rejectedFor(virtual)], '前提：降级生效').toEqual([
      'lobsterai\u0000deepseek-flash',
    ])
    // ★ 用户「重新打开」当前候选（真实写入路径）
    await pool.setAggregateRejected('deepseek-v4-1-flash', 'lobsterai', 'deepseek-flash', false)
    // ★ 恢复必须生效：表里既无精确命中也无漂移记录 ⇒ 不降级
    expect(
      [...realAdapter.rejectedFor(virtual)],
      '用户按 warn 指引「重新打开」后，降级必须解除（否则那条引导走不通）',
    ).toEqual([])
  })

  it('★ 对照：表里**只有**当前 realId 的精确记录 ⇒ 精确拒绝（无降级）', async () => {
    const pool = await makePoolWithRejections({
      'deepseek-v4-1-flash': { lobsterai: { 'deepseek-flash': true } },
    })
    const adapter = makeAdapterFromPool(pool)
    const virtual = {
      key: 'deepseek-v4-1-flash',
      candidates: [{ provider: 'lobsterai', realId: 'deepseek-flash' }],
    }
    expect([...adapter.rejectedFor(virtual)]).toEqual(['lobsterai\u0000deepseek-flash'])
  })
})

describe('★ hasDrifted 闸门：层存在但无 `true` 记录 ⇒ **不得**降级（否则严重过拒）', () => {
  // ⚠️⚠️ 对抗审计用**变异测试**指出：`if (!hasDrifted) continue`
  //    （`src/aggregate-adapter.ts:247`）删掉后 **101/101 全绿** ⇒ 声称它是死代码。
  //
  //    ⚠️ 但**实测证明它承重**（探针）：
  //    - 层存在但**空对象** `{buddy:{}}`      ⇒ `hasDrifted=false` ⇒ 不降级（`[]`）
  //    - 层存在但**只有 `false`** `{buddy:{m1:false}}` ⇒ 同上
  //    若删掉该行，这两种情形都会**降级并拒掉全部当前候选** —— 而用户
  //    **从未拒绝过任何东西**（`false` 是「未拒绝」的显式写法）⇒ **严重过拒**。
  //
  //    ⇒ 正确处置是**补上缺失的测试**（而不是删代码）—— 这类「变异仍绿」
  //      说明的是**覆盖缺口**，不是死代码。
  const makeAdapter = (
    rejections: Record<string, Record<string, Record<string, boolean>>>,
  ) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'm1', name: 'M1' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    return new AggregateAdapter(ctx, {
      accountPool: pool, expiryProbe: async () => 100, rejections: () => rejections,
    })
  }
  const virtual = { key: 'm1', candidates: [{ provider: 'buddy', realId: 'm1' }] }

  it('★ 层是**空对象** ⇒ 不降级（用户从未拒绝过任何东西）', () => {
    expect([...makeAdapter({ m1: { buddy: {} } }).rejectedFor(virtual)]).toEqual([])
  })

  it('★ 层里**只有 `false`** ⇒ 不降级（`false` 是「未拒绝」的显式写法）', () => {
    expect([...makeAdapter({ m1: { buddy: { m1: false } } }).rejectedFor(virtual)]).toEqual([])
  })

  it('★ 层里有**已漂移的 `true`** ⇒ 才降级（对照：证明闸门不挡真降级）', () => {
    expect([...makeAdapter({ m1: { buddy: { ghost: true } } }).rejectedFor(virtual)])
      .toEqual(['buddy\u0000m1'])
  })

  it('★ 已漂移 `true` + 当前 `false` ⇒ 仍降级（`true` 一旦写入就不会被 `false` 抵消）', () => {
    expect([...makeAdapter({ m1: { buddy: { ghost: true, m1: false } } }).rejectedFor(virtual)])
      .toEqual(['buddy\u0000m1'])
  })
})
