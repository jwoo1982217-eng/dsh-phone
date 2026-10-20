import { describe, expect, it } from 'vitest'
import { AggregateAdapter, AGGREGATE_PROVIDER, maxAttemptsFor, registerAggregateLlm } from '../../src/aggregate-adapter.js'

/** 造一个最小 ctx：llm.listModels 播报给定目录。 */
function makeCtx(catalogs: Record<string, Array<{ id: string; name?: string }>>) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      // ⚠️ `refreshCatalog` 先问 `listProviders()` 拿渠道全集，再逐个 listModels
      //    ⇒ 这个桩**必须**存在，且要返回目录里出现过的渠道（否则推导结果为空）。
      listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: id })),
      listModels: async (provider: string) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => { throw new Error('本用例不应调用 stream') },
    },
  } as never
}

/** 造一个最小账号池：所有渠道都有账号、永久积分（NEVER）。 */
function makePool() {
  return {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never
}

describe('AggregateAdapter：目录播报', () => {
  it('providerInfo 的 id 必须等于注册路由（DSH 校验）', () => {
    const adapter = new AggregateAdapter(makeCtx({}), { accountPool: makePool() })
    expect(adapter.providerInfo(AGGREGATE_PROVIDER).id).toBe(AGGREGATE_PROVIDER)
  })

  it('listModels 播报虚拟模型（含 auto），每条 provider 都是 aggregate', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['auto', 'deepseek-v4-1-flash'])
    for (const model of models) expect(model.provider).toBe(AGGREGATE_PROVIDER)
  })

  it('每条 id 不重复（DSH 会因重复抛 INVALID_CATALOG）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'kimi-k3-1', name: 'Kimi-K3-1' }],
    }), { accountPool: makePool() })
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length)
  })

  it('被用户关闭的虚拟模型不播报（套 disabledModelsFor 黑名单）', async () => {
    const pool = {
      disabledModelsFor: () => new Set(['deepseek-v4-1-flash']),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: pool })
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['auto'])
  })

  it('listAllModels 不套黑名单（设置页要能看到被关的模型）', async () => {
    const disabled = new Set(['deepseek-v4-1-flash'])
    const pool = { disabledModelsFor: () => disabled, getAvailableAccount: async () => null } as never
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: pool })
    // ⚠️ 必须先热缓存：`listAllModels` 是**同步**方法，契约上只读上一次推导结果
    //（`ModelCatalogSource`；`model.list` 的真实调用序也是先 listModels 再 listAllModels）。
    await adapter.listModels(AGGREGATE_PROVIDER)
    const all = adapter.listAllModels()
    // 对照：同一个模型在 listModels 里被黑名单挡掉…
    const listed = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(listed.map((m) => m.id)).not.toContain('deepseek-v4-1-flash')
    // …但在全量目录里必须仍在（否则用户在设置页连开关都摸不着）。
    expect(all.map((m) => m.id)).toContain('deepseek-v4-1-flash')
  })
})

describe('AggregateAdapter：resolveModel 必须按入参回填', () => {
  it('返回的 provider/id 与请求逐字相符（否则 DSH 抛 INVALID_MODEL_INFO）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.provider).toBe(AGGREGATE_PROVIDER)
    expect(info.id).toBe('deepseek-v4-1-flash')
    expect(info.name).toBe('DeepSeek V4.1 Flash')
  })

  it('auto 也能解析（不因多模型改造而丢失）', async () => {
    const adapter = new AggregateAdapter(makeCtx({}), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    expect(info.id).toBe('auto')
    expect(info.name.length).toBeGreaterThan(0)
  })

  it('未知规范 id 抛 INVALID_REQUEST 且文案里带可用 id 提示', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'no-such-model'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('inputModalities 恒含 image（整池诚实声明；真正能不能收图由分发保证）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.inputModalities).toContain('image')
  })

  it('必须声明 reasoning 档位（否则客户端的档位选择器永不出现）', async () => {
    // ⚠️ 本仓库有同型真实缺陷记录（`opencode-adapter.ts:323`：「思考档位（issue
    // IKJJ0V 修复，此前完全没声明 ⇒ 选择器永不出现）」）。DSH 的判定是
    // `resolved.reasoning === undefined ? undefined : {…}` ⇒ **不声明**等于
    // 「这个模型没有档位可选」，选择器根本不渲染。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning!.efforts.length).toBeGreaterThan(0)
    // ⚠️ 锁**具体值**（不是只 `toBeDefined()`）：默认档定为 `high`，与各渠道自己的
    // `defaultReasoningEffort` 一致（buddy / trae / lobsterai 实测清一色是 `high`）。
    // 只断言「有默认值」的话，把它改成 `medium` / `max` 都不会变红 —— 而那两种改法
    // 各有真实后果（前者「聚合比直连想得少」，后者最费 token/积分，与本功能
    // 「省钱烧临期」的目标相反）。
    expect(String(info.reasoning!.defaultEffort)).toBe('high')
  })

  it('档位是**并集**（规范化名）而非候选集交集，且不含渠道私有档', async () => {
    // ⚠️ 各渠道档位命名空间几乎不相交（codearts 只有 on/off、buddy 是 low/high/max、
    // trae 是 light/extra_high）⇒ 取交集必为空 ⇒ 空选择器。故必须声明并集。
    const adapter = new AggregateAdapter(makeCtx({
      // 只给一个 codearts 候选（它的档位只有 on/off）—— 若实现成「交集」，
      // 这里就会得到 on/off 两个渠道私有档，而不是规范化并集。
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const ids = info.reasoning!.efforts.map((effort) => String(effort.id))
    // 规范化并集应含 medium / high 这类规范名，且**不含** on/off 这类渠道私有档。
    expect(ids).toContain('medium')
    expect(ids).toContain('high')
    expect(ids).not.toContain('on')
    expect(ids).not.toContain('off')
  })

  it('档位展示名必须是官方中文（客户端直接渲染 name、不本地化）', async () => {
    // ⚠️ 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）。
    const adapter = new AggregateAdapter(makeCtx({
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const efforts = info.reasoning!.efforts
    const nameOf = (id: string): string | undefined =>
      efforts.find((effort) => String(effort.id) === id)?.name
    expect(nameOf('none')).toBe('关闭思考')
    expect(nameOf('minimal')).toBe('最小')
    expect(nameOf('low')).toBe('低')
    expect(nameOf('medium')).toBe('中')
    expect(nameOf('high')).toBe('高')
    expect(nameOf('xhigh')).toBe('极高')
    expect(nameOf('max')).toBe('最大')
  })

  it('`auto` 也声明档位（不能因走了特殊分支而漏掉）', async () => {
    const adapter = new AggregateAdapter(makeCtx({}), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning!.efforts.length).toBeGreaterThan(0)
  })
})

describe('registerAggregateLlm：注册后预热目录', () => {
  /**
   * ⚠️ 为什么这条必须存在（真实缺陷）：`listAllModels()` 被契约要求是**同步**的，
   * 只能读上一次推导结果；而 `provider.status`（`jet-hub-rpc.ts:3883`）会在
   * **冷缓存**下直接调它并据条数算 `models.total`，判据是
   * `closed = total > 0 && disabled === total`（同文件 `:3903`）。
   * 冷缓存时 `total` 只有 1（`auto`）⇒ 用户一关掉 `auto`，`disabled === total`
   * 成立 ⇒ `aggregate` 被**误显示为「已关闭」**。
   */
  it('注册即预热目录：不必先调 listModels，listAllModels 也已含虚拟模型', async () => {
    const ctx = makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }) as { llm: { registerAdapter?: unknown } }
    // `registerAdapterIdempotent` 需要它（本用例只关心预热，不做路由断言）。
    const registered: string[][] = []
    ctx.llm.registerAdapter = (providers: string[]) => { registered.push([...providers]) }

    const adapter = registerAggregateLlm(ctx as never, { accountPool: makePool() })
    expect(registered).toEqual([[AGGREGATE_PROVIDER]])

    // 预热是 fire-and-forget：刷一轮宏任务让它落地。
    await new Promise(resolve => setTimeout(resolve, 0))

    // 关键断言：**没有**手动调过 listModels，全量目录也必须已经非空。
    expect(adapter.listAllModels().map((m) => m.id)).toContain('deepseek-v4-1-flash')
  })
})

describe('maxAttemptsFor：不得写死，必须 ≥ 最长候选表', () => {
  it('取所有虚拟模型里最长的候选数', () => {
    const models = [
      { key: 'a', name: 'A', candidates: [{ provider: 'p1', realId: 'm', realName: 'm', price: 0, via: 'id' as const }] },
      {
        key: 'b',
        name: 'B',
        candidates: ['p1', 'p2', 'p3'].map((provider) => ({
          provider, realId: 'm', realName: 'm', price: 0, via: 'id' as const,
        })),
      },
    ]
    expect(maxAttemptsFor(models)).toBe(3)
  })

  it('auto 的候选池是所有渠道的所有模型，故至少为 1', () => {
    expect(maxAttemptsFor([])).toBeGreaterThanOrEqual(1)
  })

  it('★ 上限真的生效：`auto` 的巨池必须被截断（不许写成 Math.max(ranked.length, …)）', async () => {
    // ⚠️ 这条锁的是 Task 6 复审实测到的真实缺陷：初版写
    // `Math.max(ranked.length, maxAttemptsFor(...))` ⇒ `limit ≥ ranked.length`
    // 恒成立 ⇒ `slice` 永不截断 ⇒ 上限形同虚设（把 maxAttemptsFor 改成 `return 1`
    // 都不影响行为）。后果：auto 全候选失败时会依次尝试 100+ 次。
    //
    // 构造：一个虚拟模型的候选表长度 = 2（⇒ limit = 2），而 auto 池远大于 2。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          // buddy 有 2 个模型 ⇒ 最长候选表 = 2 ⇒ limit 应为 2
          ? [
              { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
              { id: 'glm-5.3', name: 'GLM-5.3' },
            ]
          // codearts 有 4 个模型 ⇒ auto 池 = 2 + 4 = 6 条
          : [
              { id: 'glm-5.3', name: 'glm-5.3' },
              { id: 'kimi-k2.6', name: 'kimi-k2.6' },
              { id: 'minimax-m3', name: 'minimax-m3' },
              { id: 'hy3', name: 'hy3' },
            ]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        // 全部候选都失败 ⇒ 会走遍所有入选候选，sent 的长度就是实际尝试次数。
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            throw new Error('全挂')
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'auto')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
        // drain
      }
    })()).rejects.toThrow()

    // auto 池有 6 条候选，但 limit = 最长候选表 = 2 ⇒ **只应尝试 2 次**。
    // ⚠️ 若实现写成 `Math.max(ranked.length, …)`，这里会变成 6（缺陷复现）。
    expect(sent).toHaveLength(2)
  })
})

describe('prepareCall：真实链路 prepareCall → call.stream', () => {
  it('按临期升序把请求发给第一个候选，成功即返回', async () => {
    // 造两个渠道：buddy 临期更早（100ms 后），codearts 更晚（900ms 后）。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    // 临期折算在本任务里先用「注入的探针」代替真实余额查询（见 Step 3 的实现）。
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
      // 必须真正 drain，否则 stream 从未被调用、sent 会是空的
    }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('第一个候选抛错时自动换下一个候选，并把实际发往的序列记下来', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: unknown[] = []
    for await (const chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
      chunks.push(chunk)
    }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    expect(chunks).toHaveLength(1)
  })

  it('全部候选失败时如实抛最后一个错误（不静默成功）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          throw new Error('全挂了')
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) { /* drain */ }
    })()).rejects.toThrow('全挂了')
  })

  it('候选已产出 chunk 后失败：不再切换（否则两段回答会被拼接）', async () => {
    // ⚠️ 这是本任务**最关键**的那条约束（见 `dispatch` 的长注释）：已 `yield` 出去的
    // 内容收不回来，切换会让用户看到「A 的半截 + B 的完整答案」这种畸形拼接。
    // 断言必须能区分两条路径：若实现真的切换了，`sent` 会有第二条、用户也会看到
    // 两段文字；这里锁的是「sent 只有一条」+「异常如实抛出」+「半截内容仍在」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') {
              yield { type: 'text', text: '半截' }
              throw new Error('吐了半截之后挂了')
            }
            yield { type: 'text', text: '完整答案' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: Array<{ type: string; text?: string }> = []
    await expect((async () => {
      for await (const chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
        chunks.push(chunk as { type: string; text?: string })
      }
    })()).rejects.toThrow('吐了半截之后挂了')

    // ① 半截内容已交给调用方（收不回来，故不能假装没发生）；
    expect(chunks.map((chunk) => chunk.text)).toEqual(['半截'])
    // ② 没有尝试第二个候选 —— 这是「不拼接」的判据。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('档位逐候选翻译：exact 原样、mapped 就近、不可表达时不下发该字段', async () => {
    // ⚠️ 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
    // ⇒ 原样转发会被 DSH 按 id 严格校验拦下 `UNSUPPORTED_REASONING_EFFORT`。
    // 这条用例锁的是**三种翻译结果各自对应哪条下发路径**（断言能区分路径）。
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          // buddy 用私有档位名 `low`（请求值 `medium` 应就近落到它）
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          // codearts 只有 on/off 开关，没有强度阶梯（`medium` 不可表达）
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string) => (provider === 'buddy'
          ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
          : { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }),
        stream: (options: { provider: string; reasoningEffort?: string }) => {
          seen.push({ provider: options.provider, effort: options.reasoningEffort })
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    // ① mapped：`minimal`(rank 1) 不在 buddy 的 [low(3), high(5)] 里 → 就近落到 `low`。
    const mapped = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'minimal',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'low' }])

    // ①b 同距取更强（仓库既有的 `translateReasoningEffort` 口径）：`medium`(4) 距
    //     low(3) 与 high(5) **都是 1** ⇒ 必须落到**更强**的 `high`。这条断言锁的是
    //     那个方向 —— 反过来（取弱）会把用户主动选的强度悄悄降一档。
    seen.length = 0
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'medium',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'high' }])

    // ② exact：`high` 就在 buddy 声明里 → 原样下发（**不**被翻译动到）。
    seen.length = 0
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'high' }])

    // ③ unexpressible：请求 `none`（关闭思考，自成「族」，见 REASONING_EFFORT_RANK
    //    的注释），而 buddy 只声明 [low, high]（**没有关闭档**）⇒ 同族一个候选都没有
    //    ⇒ **不下发该字段**，让上游走自己的默认；紧接着 buddy 挂掉换到 codearts，
    //    它的 `off` 正是关闭族 ⇒ 这一条**能表达**（mapped）。
    //    ⚠️ 两条路径的下发值必须不同（undefined vs 'off'），否则断言分不清是哪条生效。
    const failing = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string) => (provider === 'buddy'
          ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
          : { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }),
        stream: (options: { provider: string; reasoningEffort?: string }) => {
          seen.push({ provider: options.provider, effort: options.reasoningEffort })
          return (async function* () {
            if (options.provider === 'buddy') throw new Error('buddy 挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const fallback = new AggregateAdapter(failing, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    seen.length = 0
    const call = await fallback.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'none',
    } as never)) { /* drain */ }
    expect(seen).toEqual([
      // buddy 无关闭族 ⇒ 字段被摘掉（说明「不可表达时不下发」这条路径真的生效）。
      { provider: 'buddy', effort: undefined },
      // codearts 的 `off` 是关闭族 ⇒ 就近落到它（说明翻译是**逐候选**做的）。
      { provider: 'codearts', effort: 'off' },
    ])
  })

  it('带图请求只用声明支持图片的候选（不支持的那个被改道掉）', async () => {
    // ⚠️ 第一交付物：带图时**不能**把图发给没声明 image 的渠道 —— 失败现象会是
    // 上游报错（用户看不出真因）。判据是「发往序列里没有 codearts」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        // buddy（临期最早）**不支持图片**，codearts（更晚）支持。
        resolveModelInfo: async (provider: string) => ({
          inputModalities: provider === 'codearts' ? ['text', 'image'] : ['text'],
        }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')

    // ① 带图：改道到 codearts（尽管 buddy 临期更早）。
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
    } as never)) { /* drain */ }
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])

    // ② 对照：**不带图**时仍按临期胜者发给 buddy —— 这条对照证明改道只由图片触发，
    //    而不是「候选序被永久改掉了」。
    sent.length = 0
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('全池都不支持图片时如实报错（不把图降级成文字占位）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id, inputModalities: ['text'] }),
        stream: () => { throw new Error('带图请求不该被发出去') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(() => call.stream({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
    } as never)).toThrow(/不支持图片/)
  })
})

describe('★ 失败切换在真实归一化路径上必须生效（Task 6 复审缺陷）', () => {
  /**
   * ⚠️ 关键：真实 `ctx.llm.stream` **不抛错**，而是把适配器失败归一化成
   * `{ type: 'finish', reason: { kind: 'error', failure } }` 的终止 chunk
   * （`dsh-llm/lib/index.js` 两处 `catch (error) { yield adapterFailureChunk(...); return }`）。
   * 故只靠 `catch` 的实现在生产路径上**永远不会切换候选**。
   *
   * 本用例的桩**如实复刻这个形状** —— 现有 24 条用例全部 stub 成「直接 throw」，
   * 因此结构性地看不见该缺陷（这正是它需要单独一条的原因）。
   */
  it('第一个候选返回 finish/error 帧时必须切换下一个候选，且不透出该失败帧', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') {
              // ⚠️ 失败被归一化成终止 chunk，而**不是**抛出。
              yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游挂了', code: 'SERVER' } } }
              return
            }
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: Array<{ type: string }> = []
    for await (const chunk of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) {
      chunks.push(chunk as { type: string })
    }

    // ① 必须真的换到了第二个候选（缺陷实现下 sent 只有 buddy 一条）
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    // ② 第一个候选的失败帧**不得透出**（否则消费者以为整轮已结束）
    expect(chunks.some((c) => c.type === 'finish' && (c as { reason?: { kind?: string } }).reason?.kind === 'error'))
      .toBe(false)
    // ③ 第二个候选的正文照常透出
    expect(chunks.some((c) => c.type === 'text')).toBe(true)
  })

  it('`aborted` 帧不切换候选（中止是调用方意愿，不是候选坏了）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) {
        // drain
      }
    })()).rejects.toMatchObject({ name: 'AbortError' })
    // ⚠️ 只试了第一个候选 —— 中止绝不换候选。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('★ 中止错误必须**同时**带 name 与 code:ABORTED（外层靠 code 归类）', async () => {
    // ⚠️ 对抗审计实测订正：我们抛的错误会被**外层** DSH 的 adapterStream 捕获，
    //    再经 `adapterFailureChunk(error, signal)` 归类，判据是
    //    `signal?.aborted || failure.code === 'ABORTED' ? {kind:'aborted'} : {kind:'error'}`。
    //    若只设 name（初版就是如此），当 **signal 未被标记**时（上游适配器自行判定取消、
    //    抛了 code='ABORTED' 的错误 → 归一化成 finish/aborted 帧 → 我们重抛），
    //    外层会把它归成 `kind:'error'` ⇒ 消费者看到「错误」而非「已中止」，
    //    与「中止是调用方意愿」的语义相反。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          // signal **未标记**，但上游自行判定取消（这是可达路径）
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    // 不传 signal ⇒ signal 未标记
    const error = await (async () => {
      try {
        for await (const _ of call.stream({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        } as never)) { /* drain */ }
        return undefined
      } catch (caught) { return caught as { name?: string, code?: string } }
    })()

    expect(error?.name).toBe('AbortError')
    // ⚠️ 关键断言：外层 adapterFailureChunk 靠这个 code 才能归成 `aborted`
    expect(error?.code).toBe('ABORTED')
  })

  it('已产出正文后再收到 finish/error 帧：不再切换（否则两段回答被拼接）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'text', text: '半截回答…' }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: '中途挂了', code: 'SERVER' } } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) {
        // drain
      }
    })()).rejects.toThrow()
    // ⚠️ 已产出正文 ⇒ 不许再试第二个候选（拼接比报错更糟）。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })
})

describe('★ 探针抛 AbortError 时不得被吞成「没有可用候选」（Task 7 复审 M4）', () => {
  it('探测途中被取消：抛 AbortError，而不是把每个渠道都折算成 UNUSABLE 后报无候选', async () => {
    // ⚠️ 真实缺陷（Task 7 复审 M4）：`candidatesFor` 的逐渠道探针 catch 原先是
    //    `catch { expiry = UNUSABLE }` ⇒ 探针刻意重抛的 AbortError 被吞 ⇒ **每个**
    //    渠道都变 UNUSABLE ⇒ 整池候选被剔除 ⇒ 用户取消请求后看到的是
    //    「没有任何可用候选」（与「真的没登录」无法区分），而不是中止。
    //    `aggregate-expiry.ts` 修了同一缺陷，这里是它的**第二实例**。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* 不应走到这里 */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      // 探针模拟「探测途中被取消」：抛 AbortError（signal **未**标记）
      expiryProbe: async () => {
        const error = new Error('aborted upstream')
        error.name = 'AbortError'
        throw error
      },
    })

    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('★ 终审修正：错误码保真 / 渠道白名单 / 第三处 abort（C1 + I1 + I3）', () => {
  it('C1：上游 finish/error 的 code 必须保真，不得拍平成 SERVER（否则确定性错误被重试）', async () => {
    // ⚠️ `SERVER` 在 DSH 的 DEFAULT_RETRYABLE_CODES 里，而 QUOTA_EXCEEDED / AUTH
    //    不在。拍平会让「今日额度已用尽」被白重试 5 次（每次还重跑整个候选循环），
    //    并绕过 dead-model-store 的 IGNORED_CODES 豁免。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '额度用尽', code: 'QUOTA_EXCEEDED' } } }
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('C1 兜底：上游没给 code 时才退回 SERVER', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '说不清' } } }
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('I1：别的插件的 provider 不得进入聚合目录（否则广告出永远不可路由的模型）', async () => {
    // ⚠️ `listProviders()` 返回**宿主全部**存活路由。初版据此推导目录，会把
    //    `deepseek-account` / `pi-ai` 等别的插件的渠道也算成候选，而那些渠道的临期
    //    折算没接入 ⇒ 它们的虚拟模型永远没有可用候选 ⇒ 用户选中后被告知
    //    「没有任何可用候选」（把「未接入」谎报成「你没登录」）。
    const adapter = new AggregateAdapter({
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        // 宿主同时装载了本插件渠道与**外部** provider
        listProviders: () => [
          { id: 'buddy', name: 'b' },
          { id: 'deepseek-account', name: 'DeepSeek 官方' },
          { id: 'pi-ai-something', name: '外部' },
        ],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          // 外部 provider 播报一个**同源**模型：若白名单失效，它会与 buddy 合并
          : [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never, { accountPool: makePool() })

    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    // 虚拟模型的候选里**不得**出现外部 provider
    for (const model of models) {
      const real = await adapter.resolveModel(AGGREGATE_PROVIDER, model.id)
      expect(real.id).toBe(model.id)
    }
    const catalog = adapter.listAllModels()
    expect(catalog.length).toBeGreaterThan(0)
    // 直接查目录里那个虚拟模型的候选渠道（通过内部 catalog）
    const virtual = (adapter as unknown as { catalog: Array<{ key: string, candidates: Array<{ provider: string }> }> }).catalog
    const providers = new Set(virtual.flatMap((v) => v.candidates.map((c) => c.provider)))
    expect(providers.has('deepseek-account')).toBe(false)
    expect(providers.has('pi-ai-something')).toBe(false)
    expect(providers.has('buddy')).toBe(true)
  })

  it('I3：capabilityOf 期间中止必须抛 AbortError，不得折算成「无档位/不支持图片」', async () => {
    // ⚠️ 这是同一 abort 缺陷的**第三处**：`resolveModelInfo` 接收 signal，
    //    中止时它会抛 AbortError，而裸 catch 会把它折算成 imageCapable:false
    //    ⇒ 用户看到的是「候选渠道都不支持图片输入」而不是中止。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        },
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('★ I2：选型缓存（规格 §9 要求，初版漏实现 ⇒ AGGREGATE_TTL_MS 是死配置）', () => {
  it('TTL 内的第二次 prepareCall 不得重跑上游余额探测', async () => {
    // ⚠️ 没有缓存时，每次 prepareCall 都会对每个候选渠道 await probe(...) ——
    //    那是一次上游余额 GET，而 prepareCall 是每请求一次 ⇒ auto 最坏每轮十几次
    //    余额查询，**比旧的 auto（有 60 秒缓存）还差**。
    let probeCalls = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
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
      expiryProbe: async () => { probeCalls += 1; return 100 },
    })

    // 第一次：会探测
    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const afterFirst = probeCalls
    expect(afterFirst).toBeGreaterThan(0)

    // 第二次（TTL 内）：不得再探测
    const second = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of second.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(probeCalls).toBe(afterFirst)
  })

  it('TTL 过期后必须重新探测（缓存不能永久钉住旧候选序）', async () => {
    let probeCalls = 0
    let fakeNow = 1_000
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
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
      now: () => fakeNow,
      expiryProbe: async () => { probeCalls += 1; return 100 },
    })

    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const afterFirst = probeCalls

    // 把时钟推过 TTL（60 秒）
    fakeNow += 61_000
    const second = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of second.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(probeCalls).toBeGreaterThan(afterFirst)
  })

  it('缓存按虚拟模型分别存（A 的候选序不得覆盖 B 的）', async () => {
    const probes: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
          { id: 'glm-5.3', name: 'GLM-5.3' },
        ],
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
      expiryProbe: async (provider) => { probes.push(provider); return 100 },
    })

    // 先请求 A，再请求 B，再回到 A —— 回到 A 时应命中 A 自己的缓存
    for (const model of ['deepseek-v4-1-flash', 'glm-5-3', 'deepseek-v4-1-flash']) {
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    }
    // 三次请求、同一渠道 ⇒ 只探测两次（A 一次、B 一次；第二次 A 命中缓存）
    expect(probes).toHaveLength(2)
  })
})

describe('★ M23：只产出元数据帧（block-start / usage）时仍可切换', () => {
  /** 造一个 ctx：`stream` 按 provider 分派到给定生成器。 */
  function makeCtx(sent: string[], buddyGen: () => AsyncGenerator<unknown>) {
    return {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          return (options.provider === 'buddy'
            ? buddyGen()
            : (async function* () {
                yield { type: 'text', text: 'ok' }
                yield { type: 'finish', reason: { kind: 'stop' } }
              })()) as AsyncGenerator<unknown>
        },
      },
    } as never
  }
  const makePool = () => ({
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never)
  const drain = async (call: { stream: (o: unknown) => AsyncIterable<unknown> }) => {
    const chunks: Array<{ type: string }> = []
    for await (const chunk of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk as { type: string })
    return chunks
  }

  it('第一个候选只吐了 usage 就失败 ⇒ **应切换**到第二个候选', async () => {
    // ⚠️ 初版判据是「产出过任何 chunk」，于是这种情形会放弃切换 —— 过度保守，
    //    白白丢掉一次本可成功的切换。实测 `BlockAssembler` 的语义：`usage`
    //    是**覆盖**（`this._usage = …`）且**不建块**（`ensure()` 只在 delta 时建）
    //    ⇒ 它可安全重放，故不算「可见内容」。
    //
    // ⚠️⚠️ **本条原先还带一个 `block-start`（并断言它会切换）—— 那已被实测推翻**：
    //    `block-start` 的幂等判据**只看 `index`、不更新 `blockType`** ⇒
    //    若 A 开 `text`、B 开 `tool-call`，B 的类型被忽略、**工具调用丢失**
    //   （探针实测：`blocks = [{"type":"text","text":""}]`）。
    //    适配器**无法预知**下一个候选会开什么类型 ⇒ 按类型豁免必然有缺口
    //    ⇒ 现在的判据是「**开过任何块就不切换**」。故本条去掉 `block-start`，
    //      只保留 `usage`（那才是真正可安全重放的那一种）。
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks = await drain(call as never)

    // ① 真的切换了
    expect(sent).toEqual(['buddy', 'codearts'])
    // ② 拿到了第二个候选的正文
    expect(chunks.some((c) => c.type === 'text')).toBe(true)
    // ③ 第一个候选的失败帧**不透出**
    expect(chunks.some((c) => c.type === 'finish' && (c as { reason?: { kind?: string } }).reason?.kind === 'error')).toBe(false)
  })

  it('★ 对照：只吐 block-start（未吐 delta）后失败 ⇒ **不切换**（类型不可预知）', async () => {
    // ⚠️ 见上一条的注释：`block-start` 不能按类型豁免。
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    expect(sent, '开过块 ⇒ 不切换').toEqual(['buddy'])
  })

  it('对照：第一个候选吐了**正文增量**后失败 ⇒ **不切换**（否则拼接两段回答）', async () => {
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '半截回答' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    // ⚠️ 只试了第一个 —— 产出过正文后绝不切换。
    expect(sent).toEqual(['buddy'])
  })

  it('对照：block-end（含完整块）算可见内容 ⇒ 不切换', async () => {
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完整块' } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    expect(sent).toEqual(['buddy'])
  })
})

describe('★ 审计轮次二：未接入临期折算的渠道，其虚拟模型不得被播报', () => {
  /** 造一个 ctx：listProviders 与 listModels 都按给定渠道表。 */
  const makeCtx = (catalogByProvider: Record<string, Array<{ id: string, name: string }>>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => Object.keys(catalogByProvider).map((id) => ({ id, name: id })),
      listModels: async (provider: string) => catalogByProvider[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () { /* noop */ })(),
    },
  } as never)
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('候选**全部**来自未接入渠道 ⇒ 该虚拟模型不出现在目录里', async () => {
    // ⚠️ 真实缺陷（审计轮次二实测证伪）：初版会把 cline（未接入临期折算）的模型
    //    也播报出来，用户选中后拿到的是
    //    `MISSING_CREDENTIAL | 没有任何可用候选（渠道被关闭、模型被关、或所有渠道
    //     都无可用账号）` —— 把「未接入」谎报成「你没登录」。
    const adapter = new AggregateAdapter(
      makeCtx({ cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    // 只剩 auto（它不参与该过滤）
    expect(models.map((m) => m.id)).toEqual(['auto'])
  })

  it('候选里**有任一**已接入渠道 ⇒ 该虚拟模型仍被播报', async () => {
    const adapter = new AggregateAdapter(
      makeCtx({
        buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
      }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.some((m) => m.id === 'deepseek-v4-1-flash')).toBe(true)
    // 该虚拟模型的候选仍包含两个渠道（播报与否只看「有没有已接入的」，
    // 不影响候选表本身 —— 未接入的候选会在折算阶段被剔除）
    const virtual = (adapter as unknown as { catalog: Array<{ key: string, candidates: Array<{ provider: string }> }> })
      .catalog.find((v) => v.key === 'deepseek-v4-1-flash')
    expect(virtual?.candidates.map((c) => c.provider).sort()).toEqual(['buddy', 'cline'])
  })

  it('`auto` 始终在目录里（它不参与该过滤，池跨全部渠道）', async () => {
    const adapter = new AggregateAdapter(
      makeCtx({ raccoon: [{ id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75' }] }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(adapter.listAllModels().some((m) => m.id === 'auto')).toBe(true)
  })
})

describe('★ 第 3 轮审计：报错文案不得把用户指向**不存在**的 UI', () => {
  const makeCtx = (models: Array<{ id: string, name: string }>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy' }],
      listModels: async () => models,
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () { /* noop */ })(),
    },
  } as never)
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('未知模型的报错不得提到「设置页的『聚合』面板」（该面板不存在）', async () => {
    // ⚠️ 实测缺陷：客户端 PROVIDERS 里没有 `aggregate`（逐候选拒绝的子列表属 P2）
    //    ⇒ 设置页**没有**聚合面板。初版文案却让用户去那里看完整清单，
    //    用户按提示去找会找不到 —— 误导性指引。
    const adapter = new AggregateAdapter(makeCtx([{ id: 'glm-5.3', name: 'GLM-5.3' }]), {
      accountPool: pool, expiryProbe: async () => 100,
    })
    await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'nope'))
      .rejects.toThrow(/模型选择器/)
    await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'nope'))
      .rejects.not.toThrow(/设置页/)
  })

  it('无可用候选的报错不得提到「设置页的『聚合』面板」，且要给出可操作指引', async () => {
    // ⚠️ 同一处缺陷的第二实例（`prepareCall` 的零候选分支）。
    const adapter = new AggregateAdapter(makeCtx([{ id: 'glm-5.3', name: 'GLM-5.3' }]), {
      accountPool: pool,
      // 全部候选都 UNUSABLE ⇒ 零候选
      expiryProbe: async () => -1,
    })
    const err = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/设置页/)
    // 必须给出**真实可操作**的指引
    expect((err as Error).message).toMatch(/模型选择器|直连/)
  })

  it('源码级：报错文案里不得再出现「设置页的『聚合』面板」这一指引', async () => {
    // 源码守卫：防止将来有人把这条不存在的指引写回来。
    // ⚠️ 必须**剥离注释**再断言（与 `auto-adapter.spec.ts` 的源码守卫同一手法）：
    //    本文件的注释里**故意**引用了旧文案来说明它是错的，不剥离会误报。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/aggregate-adapter.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/设置页的「聚合」面板/)
  })
})

describe('★ 第 5 轮审计：目录刷新后不得服务已下架的模型（choiceCache 的 TTL 内也不例外）', () => {
  it('上游下架模型后，TTL 内请求它必须抛 INVALID_REQUEST（不得发到已下架的 realId）', async () => {
    // ⚠️ 本用例锁的是**行为**（下架后即使 choiceCache 仍在 TTL 内也必须拒绝），
    //    **不是**「`resolveModel` 必须先于 `candidatesFor`」—— 那条假设是**错的**：
    //    `candidatesFor` 自己也调 `ensureCatalog()`，故交换两者顺序**行为不变**
    //    （实测：交换后本用例仍通过）。我最初据此写了「顺序保证」的注释，
    //    反向验证没变红才发现是同义反复 —— 注释与标题已订正，用例保留（断言有价值）。
    // 真正的保证：`ensureCatalog` 刷新后 `this.catalog` 即当前目录 ⇒ 已下架的模型
    // 既过不了 `resolveModel`、也进不了候选序。
    let phase = 1
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async () => (phase === 1
          ? [{ id: 'glm-5.3', name: 'GLM-5.3' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })

    // 阶段 1：填 choiceCache
    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }

    // 阶段 2：上游下架 glm-5.3 并强制刷新目录（choiceCache 仍在 TTL 内）
    phase = 2
    await adapter.refreshCatalog(true)

    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('★ P3：activeProvider —— 「上次实际转发成功的渠道」', () => {
  /** 造一个「首个候选失败、其余成功」的 ctx，并记录实际发往的序列。 */
  function makeFailoverCtx(sent: string[], failing: string) {
    return {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === failing) throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
  }

  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 无历史时返回 null（尚未发过任何请求 / 插件重启后内存清空）', () => {
    // ⚠️ 规格 §6.3 的 P4：无历史 ⇒ 徽标**不渲染**。**不做预测** ——
    //    预测胜者可能因失败切换而实际未被使用，显示错的渠道比不显示更误导。
    const adapter = new AggregateAdapter(makeCtx({ buddy: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }), {
      accountPool: makePool(),
    })
    expect(adapter.activeProvider()).toBe(null)
    expect(adapter.activeProvider('glm-5-3')).toBe(null)
  })

  it('★ 转发成功后记录**实际发往**的渠道（不是候选序第一个）', async () => {
    // ⚠️ 这是本机制的核心：候选序按「临期优先」排，但失败会切换 ——
    //    记录的必须是**真的用了**的那个渠道，否则徽标会指向一个已失败的渠道。
    const sent: string[] = []
    const adapter = new AggregateAdapter(makeFailoverCtx(sent, 'buddy'), {
      accountPool: pool,
      // buddy 更临期（100 < 900）⇒ 它排第一，但会失败 ⇒ 实际发往 codearts
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }

    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    // ★ 记录的是**成功**的 codearts，不是排第一但失败的 buddy
    expect(adapter.activeProvider()).toBe('codearts')
    expect(adapter.activeProvider('deepseek-v4-1-flash')).toBe('codearts')
  })

  it('★ 首个候选就成功 ⇒ 记录它（不因「后面还有候选」而变）', async () => {
    const sent: string[] = []
    const adapter = new AggregateAdapter(makeFailoverCtx(sent, 'codearts'), {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(adapter.activeProvider()).toBe('buddy')
  })

  it('★ 只在**成功**时写：全部候选都失败 ⇒ 不记录任何渠道', async () => {
    // ⚠️ 规格 §6.3 的 P3 原文：「只在成功时写 —— 写失败候选会让徽标指向一个
    //    刚刚失败、甚至已无额度的渠道」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () { throw new Error('上游挂了') })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()

    expect(sent.length).toBeGreaterThan(0)          // 确实尝试过
    expect(adapter.activeProvider()).toBe(null)     // 但一次都没成功 ⇒ 不记录
  })

  it('★ 按虚拟模型分别记录；省略参数时取「最近一次」', async () => {
    // ⚠️ `makeCtx` 的 `stream` 是**抛错的桩**（它用于不需要真实转发的用例）
    //    ⇒ 本用例必须用能产出 chunk 的 ctx，否则会看到「本用例不应调用 stream」。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
          { id: 'glm-5.3', name: 'GLM-5.3' },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    for (const model of ['deepseek-v4-1-flash', 'glm-5-3']) {
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    }
    expect(adapter.activeProvider('deepseek-v4-1-flash')).toBe('buddy')
    expect(adapter.activeProvider('glm-5-3')).toBe('buddy')
    expect(adapter.activeProvider()).toBe('buddy')
  })

  it('★ 「最近一次」不靠 Map 迭代顺序（覆盖已存在的键不改变其位置）', async () => {
    // ⚠️ `Map` 的迭代顺序是**插入顺序**，覆盖已存在的键**不改变**其位置
    //    ⇒ 若靠 `[...map.values()].at(-1)` 取「最近」，在「切回一个**先前用过**的
    //    模型/渠道」时会取到**旧**值（徽标显示错的）。
    //    ⚠️ 必须用**两个模型**才能暴露这个陷阱：只有一个键时 `.at(-1)` 恰好也正确
    //    （我第一版就是单模型，那条用例区分不出实现，等于同义反复）。
    //
    // 序列：模型 A 成功→buddy（Map: [A]）→ 模型 B 成功→codearts（Map: [A,B]）
    //       → 模型 A 再次成功→buddy（**覆盖** A 的值，Map 位置仍是第一）
    //    ⇒ 「最近」= buddy；而 `[...values()].at(-1)` = codearts（错）。
    let phase = 1
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => [
          { id: 'm-alpha', name: 'M-Alpha' },
          { id: 'm-beta', name: 'M-Beta' },
        ].map((m) => (provider === 'buddy' ? m : { ...m, name: m.name.toLowerCase() })),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          // 让指定渠道失败，从而把成功的渠道逼到另一边。
          const failThis = phase === 1 ? 'codearts' : (phase === 2 ? 'buddy' : 'codearts')
          return (async function* () {
            if (options.provider === failThis) throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const run = async (model: string) => {
      adapter.clearChoiceCache()
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    }

    // ① 模型 A 成功 → buddy（buddy 更临期且不失败）
    await run('m-alpha')
    expect(adapter.activeProvider('m-alpha')).toBe('buddy')
    expect(adapter.activeProvider()).toBe('buddy')

    // ② 模型 B 成功 → codearts（这一轮 buddy 失败）
    phase = 2
    await run('m-beta')
    expect(adapter.activeProvider('m-beta')).toBe('codearts')
    expect(adapter.activeProvider()).toBe('codearts')

    // ③ 模型 A **再次**成功 → buddy（覆盖已存在的键，Map 位置不变）
    phase = 3
    await run('m-alpha')
    expect(adapter.activeProvider('m-alpha')).toBe('buddy')
    // ★ 关键断言：最近一次是 buddy；靠 Map 迭代顺序会得到 codearts（错）
    expect(adapter.activeProvider()).toBe('buddy')
  })
})

/**
 * ★★ 已开过块 ⇒ **绝不能切换**（真实缺陷，对抗审计用真实 `BlockAssembler` 实测证伪）。
 *
 * ## 机制（用真实 `BlockAssembler` 实证）
 *
 * `BlockAssembler.push` 对 `block-start` 的判据是**按 `index` 幂等**：
 *
 * ```js
 * case 'block-start': {
 *   if (!this.partials.has(chunk.index)) {   // ← 已存在就**直接 return**
 *     this.order.push(chunk.index)
 *     this.partials.set(chunk.index, { blockType: chunk.blockType, … })
 *   }
 *   return
 * }
 * ```
 * ⇒ 第二个候选重发**同 index** 的 `block-start` 会被**忽略**，`blockType` **不更新**。
 *
 * 而本适配器把 `block-start` 判为「不算可见内容」(`isVisibleContent`) ⇒ **允许切换**
 * ⇒ 候选 A 开了 `block-start(0, 'tool-call')` 后失败、候选 B 重发
 * `block-start(0, 'text')` + 正文时，**B 的正文被灌进 A 的 tool-call 块**。
 *
 * 探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * blocks = [{"type":"tool-call","id":"call-0","name":"","arguments":""}]
 * partials = [[0,{"blockType":"tool-call","text":"B 的正文","toolCallArguments":""}]]
 * finish = {"kind":"stop"}
 * ```
 * ⇒ 下游只看到一个**空的 tool-call**、**用户可见答案丢失**，且 `finish=stop`
 * 看起来是干净结束（无任何报错）。
 *
 * ⚠️ 原注释断言「仅 `block-start` / `usage` 这类元数据帧是**可安全重放**的」——
 * **它可重放，但不更新 blockType**。那个前提是错的。
 *
 * ⚠️ 既有用例为什么没抓到：它们让 A 吐 `{type:'text'}`（**不带 block-start**），
 * 于是从未走过「先开块、后失败」这条路径。
 */
describe('★★ 已开过块就不能切换（block-start 不可跨候选重放）', () => {
  const makeTwoChannelCtx = (
    firstChunks: unknown[],
    secondChunks: unknown[],
  ) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★ 候选 A 开了 tool-call 块后失败 ⇒ **不得切换**（否则 B 的正文灌进 tool-call）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      // A：开一个 tool-call 块，然后失败（不吐任何 delta）
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'call-0', name: '' }],
      // B：开 text 块 + 正文（若切换，正文会被灌进 A 的 tool-call 块）
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'B 的正文' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const yielded: unknown[] = []
    await expect((async () => {
      for await (const chunk of call.stream({ messages: [] } as never)) yielded.push(chunk)
    })()).rejects.toThrow()
    // ★ 不能切换：B 从未被调用
    expect(sent, '已开过块 ⇒ 不得切换').toEqual(['buddy'])
    // 且 A 的 block-start 必须如实透出（不能吞掉）
    expect(yielded.some((c) => c.type === 'block-start')).toBe(true)
  })

  it('★ 对照：A 只吐 usage（元数据，不产生块）后失败 ⇒ **允许切换**', async () => {
    // ⚠️ `usage` 不建块（`BlockAssembler` 只覆盖同名字段）⇒ 重放是安全的。
    const { adapter, sent } = makeTwoChannelCtx(
      [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'B 的正文' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const yielded: unknown[] = []
    for await (const chunk of call.stream({ messages: [] } as never)) yielded.push(chunk)
    expect(sent, 'usage 未建块 ⇒ 可以安全切换').toEqual(['buddy', 'codearts'])
    expect(yielded.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('★ 对照：A 什么都没吐就失败 ⇒ 允许切换（既有行为不能破）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      [],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'ok' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(sent).toEqual(['buddy', 'codearts'])
  })
})

/**
 * ★ `refreshCatalog` 不得吞掉 `AbortError`（真实缺陷，对抗审计实测证伪）。
 *
 * ## 为什么这是**同型缺陷的第四处**
 *
 * 模块头与提交信息都声称「中止必须抛 `AbortError`，绝不折算成 `UNUSABLE`
 *（**三处**独立修复）」。而 `refreshCatalog` 是**第四处**：
 *
 * - 它**没有 `signal` 形参**；
 * - 逐渠道 `catch` 吞掉**一切**错误（含 `AbortError`），只记 warn；
 * - 随后**仍然** `this.catalogAt = now` ⇒ **截断的目录被缓存 60 秒**。
 *
 * ⇒ 用户取消一次请求后，被取消的那个渠道会**从聚合目录里消失 60 秒**
 *（`listModels` 返回空 ⇒ 该渠道的候选全没了），而用户看到的理由是
 *「读取 xxx 目录失败」——与「用户主动取消」完全无关，且与「该渠道真的没登录」
 * 无法区分。这正是本仓库反复修的形态。
 */
describe('★ refreshCatalog 必须让 AbortError 逃逸（第四处同型点）', () => {
  const makeCtxWithAbort = () => {
    let catalogReads = 0
    const controller = new AbortController()
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          catalogReads += 1
          if (provider === 'codearts') {
            // 模拟「读目录途中被取消」：抛 AbortError
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            throw error
          }
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    return { ctx, pool, controller, reads: () => catalogReads }
  }

  it('★ 中止已标记时 refreshCatalog 必须抛 AbortError（不得吞成 warn）', async () => {
    const { ctx, pool, controller } = makeCtxWithAbort()
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    controller.abort()
    // ⚠️ 传入已中止的 signal ⇒ 必须抛，而不是「跳过 codearts 后正常返回」
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('★ 中止时**不得**缓存截断的目录（否则被取消的渠道消失 60 秒）', async () => {
    // ⚠️ `LlmRuntime.listModels(provider)` **只接受一个参数、没有 signal 通道**
    //   （`dsh-llm/lib/index.js:1471` 的 `async listModels(provider)`）⇒ 无法把
    //    signal 透传给目录读取。故判据只能是：
    //    ① 收到已标记的 signal ⇒ 立刻抛 `AbortError`（不开始读）；
    //    ② 读取途中若拿到 `AbortError` ⇒ 逃逸，**且不写 `catalogAt`**。
    const { ctx, pool, controller } = makeCtxWithAbort()
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    controller.abort()
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    // ② 中止后不得留下「已缓存」的时间戳 ⇒ 下次调用必须重新读目录
    const catalogAt = (adapter as unknown as { catalogAt: number }).catalogAt
    expect(catalogAt, '中止后不得写 catalogAt（否则截断目录被缓存 60 秒）').toBe(0)
  })

  it('★ 暂停：非中止错误仍只 warn 并跳过（既有行为不能破）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          if (provider === 'codearts') throw new Error('网络抖动')
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
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
    const models = await adapter.refreshCatalog(true)
    expect(models.some((m) => m.key === 'glm-5-3'), 'buddy 的目录仍要读进来').toBe(true)
  })
})

/**
 * ★ 覆盖缺口补全：**signal 未标记、但 `listModels` 抛 `AbortError`** ⇒ 必须逃逸。
 *
 * ⚠️ 上面那条用例走的是「signal **已被标记**」⇒ 循环开头的 `throwIfAborted()` 就抛了，
 * `catch` 里的逃逸分支**根本没被执行**。故它是**假覆盖**（我的第一版就是这样，
 * 反向验证时「吞掉中止」竟仍全绿，才发现）。
 *
 * ⚠️ 真实场景：取消可能发生在**读取某个渠道目录的过程中**（而非循环开始前）——
 * 此时 `listModels` 会抛 `AbortError`，而 signal 未必已被标记
 *（与 `aggregate-expiry.ts` 的 M2 情形同源：`LlmRuntime.listModels` 无 signal 通道，
 *  中止只能靠抛出的错误类型识别）。
 */
describe('★ refreshCatalog：signal 未标记但抛 AbortError ⇒ 仍必须逃逸', () => {
  it('★ 逐渠道读取途中抛 AbortError ⇒ 逃逸且不缓存', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          if (provider === 'codearts') {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            throw error
          }
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
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
    // ⚠️ signal **未标记**，但读取抛 AbortError
    const controller = new AbortController()
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect((adapter as unknown as { catalogAt: number }).catalogAt).toBe(0)
  })
})

/**
 * ★ 徽标只记**整轮成功**的渠道（真实缺陷，对抗审计实测证伪）。
 *
 * 规格 §6.3 P3 原文：「由适配器在**转发成功时**记录……⚠️ **只在成功时写** ——
 * 写失败候选会让徽标指向一个刚刚失败、甚至已无额度的渠道」。
 *
 * 旧实现写在「**首个可见 chunk**」时：若该候选吐了一个 `text-delta` 之后
 * **整轮失败**（如上游 `socket hang up`），用户**什么也没拿到**，徽标却记下了
 * 这个**失败**的渠道。
 */
describe('★ activeProvider 只记整轮成功的渠道', () => {
  const makeCtx = (buddyGen: () => AsyncGenerator<unknown>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
      listModels: async (provider: string) => (provider === 'buddy'
        ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (options: { provider: string }) => (options.provider === 'buddy'
        ? buddyGen()
        : (async function* () { yield { type: 'text', text: 'ok' } })()) as AsyncGenerator<unknown>,
    },
  }) as never

  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 吐了内容但整轮失败 ⇒ **不得**记录该渠道（用户什么也没拿到）', async () => {
    const ctx = makeCtx(() => (async function* () {
      yield { type: 'text-delta', index: 0, text: '半截' }
      throw new Error('socket hang up')
    })() as AsyncGenerator<unknown>)
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    // ★ 整轮失败 ⇒ 徽标不得指向这个失败的渠道
    expect(adapter.activeProvider()).toBe(null)
  })

  it('★ 对照：整轮成功 ⇒ 记录该渠道', async () => {
    const ctx = makeCtx(() => (async function* () {
      yield { type: 'text-delta', index: 0, text: '完整答案' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() as AsyncGenerator<unknown>)
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(adapter.activeProvider()).toBe('buddy')
  })
})

/**
 * ★ 上游 failure 的**其余事实**必须一并带上（真实缺陷，对抗审计实测证伪）。
 *
 * `LlmError` 的第三参接受并校验 `status` / `providerRetryAfterMs` / `requestId`
 *（`dsh-llm/lib/index.js:1026-1048`），而旧实现只传 message + code ⇒ 三者全丢。
 *
 * ⚠️ `providerRetryAfterMs` 是**服务端指定延迟**的机器通道 —— 丢了它退避只能靠
 * 固定策略（AGENTS.md 第 8 条记录的 qoder 排队问题同源：服务端要等 30 秒，
 * 而固定退避最多 8 秒 ⇒ 永远等不到）。
 */
describe('★ 上游 failure 的 status / providerRetryAfterMs / requestId 必须保真', () => {
  const makeCtx = () => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: '上游限流',
              code: 'RATE_LIMIT',
              status: 429,
              providerRetryAfterMs: 30_000,
              requestId: 'req-abc',
            },
          },
        }
      })(),
    },
  }) as never
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 三个字段都要保真（尤其 providerRetryAfterMs）', async () => {
    const adapter = new AggregateAdapter(makeCtx(), { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    let caught: { code?: string; failure?: Record<string, unknown> } | undefined
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    } catch (error) {
      caught = error as { code?: string; failure?: Record<string, unknown> }
    }
    expect(caught, '必须抛出').toBeDefined()
    expect(caught!.code).toBe('RATE_LIMIT')
    const failure = caught!.failure ?? {}
    expect(failure.status, 'status 必须保真（排障线索）').toBe(429)
    expect(failure.providerRetryAfterMs, '★ 服务端指定延迟的机器通道必须保真').toBe(30_000)
    expect(failure.requestId, 'requestId 必须保真（定位上游故障）').toBe('req-abc')
  })

  it('★ 畸形字段不得让 LlmError 抛校验错（按需传）', async () => {
    // ⚠️ `LlmError` 校验 status 是 ≥100 的整数、providerRetryAfterMs 有限、
    //    requestId 非空 ⇒ 传 `undefined` 会让它抛「must be …」。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              // status 畸形（<100）、requestId 空串 ⇒ 应被省略而不是传给 LlmError
              failure: { message: 'x', code: 'SERVER', status: 5, requestId: '' },
            },
          }
        })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    let caught: { code?: string; failure?: Record<string, unknown> } | undefined
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    } catch (error) {
      caught = error as { code?: string; failure?: Record<string, unknown> }
    }
    expect(caught!.code, '仍要如实抛，且不得因畸形字段变成校验错').toBe('SERVER')
    expect(caught!.failure?.status, '畸形 status 应被省略').toBeUndefined()
    expect(caught!.failure?.requestId, '空 requestId 应被省略').toBeUndefined()
  })
})

/**
 * ★★ 守卫的**盲区**：A 开 `text`、B 开 `tool-call`（真实缺陷，我自己用真实
 * `BlockAssembler` 实测发现）。
 *
 * ## 我的第一版修法只挡了一个方向
 *
 * 我按「已开的块类型」判断：开过**非 `text`** 块 ⇒ 拒绝切换；开过 `text` ⇒ 允许。
 * 但适配器**无法预知**下一个候选会开什么类型 ⇒ 若 A 开 `text`（守卫允许切换）
 * 而 B 开 `tool-call`，则 B 的 `blockType` 被 `BlockAssembler` 忽略
 *（它按 `index` 幂等、**不更新 `blockType`**）⇒ **工具调用丢失**。
 *
 * 探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * A 开 text → B 开 tool-call
 * blocks = [{"type":"text","text":""}]      ← tool-call 消失，只剩空 text 块
 * ```
 *
 * ## ⇒ 正确判据：**只要开过任何块就不切换**
 *
 * 因为「下一个候选会开什么」不可预知，按类型豁免**必然有缺口**。
 * 代价是 `text→text`（实测安全）这种情形也会放弃切换 —— 但那只是**少一次重试**，
 * 而盲区的代价是**工具调用/答案丢失**。方向取安全。
 *
 * ⚠️ 这条用例锁的就是那个盲区：A 开 `text`（安全类型！）而 B 开 `tool-call`。
 */
describe('★★ 已开过任何块都不切换（含 text，因为下一个候选的类型不可预知）', () => {
  const makeTwoChannelCtx = (firstChunks: unknown[], secondChunks: unknown[]) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★★ A 开 text 块后失败、B 开 tool-call ⇒ **不得切换**（否则工具调用丢失）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      // A：开一个 **text** 块（守卫的「安全类型」！）后失败
      [{ type: 'block-start', index: 0, blockType: 'text' }],
      // B：开 tool-call 块（若切换，B 的 blockType 被忽略 ⇒ 工具调用丢失）
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'c1', name: 'read_file' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent, 'A 开过 text 块 ⇒ 不得切换（B 的类型不可预知）').toEqual(['buddy'])
  })

  it('★ 对照：A 只吐 usage（不建块）后失败 ⇒ 允许切换', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'ok' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(sent, 'usage 不建块 ⇒ 可安全切换').toEqual(['buddy', 'codearts'])
  })
})

/**
 * ★★ 边界值不得让 `LlmError` 抛校验错（**我自己修复引入的 Critical**，独立审计实测证伪）。
 *
 * ## 讽刺之处
 * `53817bc` 这个修复的本意是「**保真**上游 failure 的 `status` / `providerRetryAfterMs` /
 * `requestId`」，但我在**按需传**的判据里重写了一遍校验，而它与 `LlmError` 的**真实**
 * 校验不一致（`dsh-llm/lib/index.js:1037-1039`，逐字）：
 *
 * | 字段 | `LlmError` 的真实校验 | 我写的判据 | 缺口 |
 * |---|---|---|---|
 * | `status` | `Number.isInteger(n) && 100 ≤ n ≤ 599` | `Number.isInteger(n) && n ≥ 100` | **缺上界 599** |
 * | `providerRetryAfterMs` | `Number.isFinite(n) && n > 0` | `Number.isFinite(n)` | **缺 `> 0`** |
 * | `requestId` | 非空字符串 | 非空字符串 | 无 |
 *
 * ⇒ `status=700` / `providerRetryAfterMs=0` 这类边界值时，`LlmError` **抛校验错**，
 * 于是**原始上游 message/code 全丢** —— 一个「保真」修复反而**在边界上丢弃**了失败。
 * 这正是本仓库首条红线（「同一语义两套判据，必有一处是错的」）的形态。
 *
 * ## 修法（判据只留一份）
 * **不再重写校验**，而是「先试带全部字段，被拒绝就退回最小集合」——
 * 判据**只有 `LlmError` 一份**，我方永不与之分叉。
 */
describe('★★ 边界值 failure 不得让 LlmError 抛校验错（否则原始失败全丢）', () => {
  const failureCtx = (failure: Record<string, unknown>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure } }
      })(),
    },
  }) as never
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  const catchError = async (failure: Record<string, unknown>) => {
    const adapter = new AggregateAdapter(failureCtx(failure), {
      accountPool: pool,
      expiryProbe: async () => 100,
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
      return undefined
    } catch (error) {
      return error as { message?: string; code?: string; failure?: Record<string, unknown> }
    }
  }

  // ⚠️ 逐条覆盖 `LlmError` 的三个字段的**两个边界方向**。
  const cases: Array<[string, Record<string, unknown>]> = [
    ['status 超上界（700）', { message: '上游', code: 'RATE_LIMIT', status: 700 }],
    ['status 低于下界（5）', { message: '上游', code: 'RATE_LIMIT', status: 5 }],
    ['status 非整数（200.5）', { message: '上游', code: 'RATE_LIMIT', status: 200.5 }],
    ['providerRetryAfterMs 为 0', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: 0 }],
    ['providerRetryAfterMs 为负（-1）', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: -1 }],
    ['providerRetryAfterMs 为 NaN', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: Number.NaN }],
    ['requestId 空串', { message: '上游', code: 'RATE_LIMIT', requestId: '' }],
    ['三个字段同时畸形', {
      message: '上游', code: 'RATE_LIMIT', status: 700, providerRetryAfterMs: 0, requestId: '',
    }],
  ]

  for (const [label, failure] of cases) {
    it(`★ ${label} ⇒ 仍须如实抛「原始失败」，不得变成 LlmError 校验错`, async () => {
      const caught = await catchError(failure)
      expect(caught, '必须抛出').toBeDefined()
      // ★ 关键：错误码保真（校验错会把 code 变成 undefined / 或 message 变成校验文案）
      expect(caught!.code, 'code 必须保真').toBe('RATE_LIMIT')
      // ★ 关键：message 里必须含上游给的原因，而不是 LlmError 的校验文案
      expect(caught!.message, 'message 不得是 LlmError 的校验文案')
        .not.toMatch(/must be an integer from 100 through 599|must be a positive/)
      expect(caught!.message, 'message 必须含上游原因').toContain('上游')
    })
  }

  it('★ 合法字段仍要保真（修复不能因怕越界就把它们全丢）', async () => {
    const caught = await catchError({
      message: '上游限流', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 30_000, requestId: 'r1',
    })
    expect(caught!.code).toBe('RATE_LIMIT')
    expect(caught!.failure?.status, '合法 status 必须保真').toBe(429)
    expect(caught!.failure?.providerRetryAfterMs, '合法延迟必须保真').toBe(30_000)
    expect(caught!.failure?.requestId, '合法 requestId 必须保真').toBe('r1')
  })

  it('★★ 一个字段畸形**不得**连累合法字段（逐字段独立回退）', async () => {
    // ⚠️ 对抗审计实测证伪的**第二版**缺陷：我曾用「试全字段、失败就退回最小集合」
    //    ⇒ **整袋回退**让合法字段陪葬。实测 `status:429 + providerRetryAfterMs:30000
    //    + requestId:''` 时，**合法的 429 与 30000ms 退避一并被丢** ——
    //    而 30000ms 正是**服务端指定退避**的机器通道（AGENTS.md 第 8 条：
    //    丢了它退避只能靠固定策略，服务端要等 30 秒而固定退避最多 8 秒 ⇒ 永远等不到）。
    const caught = await catchError({
      message: '上游限流', code: 'RATE_LIMIT',
      status: 429, providerRetryAfterMs: 30_000, requestId: '',
    })
    expect(caught!.code).toBe('RATE_LIMIT')
    expect(caught!.failure?.status, '合法 status 必须留下（不得被畸形兄弟连累）').toBe(429)
    expect(caught!.failure?.providerRetryAfterMs, '★ 合法退避必须留下').toBe(30_000)
    expect(caught!.failure?.requestId, '只有空 requestId 被丢').toBeUndefined()
  })
})

describe('★★ ensureCatalog / refreshCatalog 必须接收 signal（真实请求路径的中止）', () => {
  const makeCtx = (listModelsDelayMs = 0) => {
    const reads: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async (provider: string) => {
          reads.push(provider)
          if (listModelsDelayMs > 0) {
            await new Promise((resolve) => { setTimeout(resolve, listModelsDelayMs) })
          }
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    return { ctx, pool, reads }
  }

  it('★★ prepareCall 的 signal 必须串到目录读取（多渠道：第一个渠道读完后立刻中止，不读第二个）', async () => {
    // ⚠️⚠️ **真实缺陷**（独立审计实测证伪）：`ensureCatalog()` 调
    //    `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**（`prepareCall`）
    //    的中止**完全不生效**（只有 `describeCatalog` 那条面板路径串了 signal）。
    //
    // ⚠️ **为什么判据是「第二个渠道有没有被读」而不是「耗时」**：
    //    `LlmRuntime.listModels(provider)` **只接受一个参数、没有 signal 通道**
    //   （`dsh-llm/lib/index.js:1471`），故**正在进行的**那次读取**无法中断** ——
    //    `throwIfAborted` 只能在它**返回之后**生效。
    //    我第一版断言「耗时 < 110ms（小于单次读取的 120ms）」⇒ **那个预期不可实现**，
    //    实测 132ms（读取跑完了）。改为验**循环之间的中止**：取消发生在第一个渠道
    //    读取期间 ⇒ 第二个渠道**不应被读**（这才是 signal 串下去后真正带来的收益）。
    const reads: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          reads.push(provider)
          // ⚠️ 第一个被读的渠道是 `codearts`（`AGGREGATE_CHANNELS` 的**固定顺序**里
          //    它在 `buddy` 之前）—— 我第一版写死「先读 buddy」是错的（隐含假设了
          //    `listProviders()` 的顺序）。这里改成「**第一个被读的**慢、其余的立即返回」，
          //    不依赖具体是哪个渠道。
          await new Promise((resolve) => {
            setTimeout(resolve, reads.length === 1 ? 120 : 1)
          })
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool, expiryProbe: async () => 100,
    })
    const controller = new AbortController()
    const pending = adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash', controller.signal)
    // 在第一个渠道读取期间取消
    setTimeout(() => { controller.abort() }, 20)
    let threw = false
    try {
      await pending
    } catch (error) {
      threw = true
      expect((error as { name?: string }).name, '必须是 AbortError').toBe('AbortError')
    }
    expect(threw, '必须中止（不得静默成功）').toBe(true)
    // ★ 关键：只读了**第一个**渠道 —— 说明 signal 串到了目录循环，
    //   取消在循环之间生效（修复前**所有**渠道都会被读完）。
    //   ⚠️ 不写死渠道名（顺序由 `AGGREGATE_CHANNELS` 决定，不该在用例里复制）。
    expect(reads.length, '取消后不得继续读后续渠道').toBe(1)
  })

  it('★ 中止不得把截断目录写进缓存（下次调用必须重新读）', async () => {
    const { ctx, pool, reads } = makeCtx(120)
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool, expiryProbe: async () => 100,
    })
    const controller = new AbortController()
    const pending = adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash', controller.signal)
    // ⚠️ 在读取**进行中**取消 ⇒ 读取跑完后 `throwIfAborted` 生效、中止逃逸，
    //    且**不得**把截断目录写进缓存。
    setTimeout(() => { controller.abort() }, 20)
    await pending.catch(() => undefined)
    const before = reads.length
    // 再调一次（不取消）⇒ 必须重新读目录（而非用被中止的截断结果）
    await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(reads.length, '中止后必须重新读目录（catalogAt 不得被写）').toBeGreaterThan(before)
  })
})

describe('★★ 收到 block-end 后失败 ⇒ 不得切换（由 `emitted` 拦住，不是 `openedBlocks`）', () => {
  const makeTwoChannelCtx = (firstChunks: unknown[], secondChunks: unknown[]) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★ A 开块并**闭合**后失败 ⇒ 不得切换（但拦它的是 `emitted`，不是 `openedBlocks`）', async () => {
    // ⚠️⚠️ **本条我写错过两次，如实记录**：
    //
    // ① 我原以为「闭合后 index 不再被占用 ⇒ 守卫可以放行」，探针（真实
    //    `BlockAssembler`）证伪了这个**前提**：
    //    ```
    //    A 开 text(0) → A 闭合 text(0) → B 开 tool-call(0)
    //    blocks   = [{"type":"text","text":""}]          ← 工具调用丢失
    //    partials = [[0,{blockType:'text',…,block:{…}}]] ← index 0 **仍在**
    //    ```
    //    `block-end` 只往 partial 上挂 `block` 字段、**不删** `partials` 条目。
    //
    // ② 但**本用例实际拦它的是 `emitted`，不是 `openedBlocks`**：
    //    `isVisibleContent` 只排除 `block-start` / `usage`
    //    ⇒ `block-end` **算可见内容** ⇒ 收到它时 `emitted` 已置真
    //    ⇒ 由「已吐内容不切换」那条守卫拦住。
    //    这是**反向验证发现的**：我故意让 `block-end` 清掉 `openedBlocks`，
    //    79 条**仍全绿** ⇒ 证明 `openedBlocks` 在本场景**不参与判定**。
    //    ⇒ 标题与结论都订正为真实机制（我第三次犯「断言测的不是它声称的那条路径」）。
    //
    // ⚠️ `block-end` 的形状是 `{ index, block: {...} }`（不是只有 index）——
    //    我第一版写 `{type:'block-end', index:0}` 时，真实 `BlockAssembler`
    //    在读 `chunk.block.type` 时**抛 TypeError**（探针实测）。
    const { adapter, sent } = makeTwoChannelCtx(
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      ],
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'c1', name: 'read_file' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent, 'block-end 算可见内容 ⇒ emitted 拦住切换').toEqual(['buddy'])
  })
})
