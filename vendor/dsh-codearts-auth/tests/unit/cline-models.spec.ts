import { describe, expect, it } from 'vitest'
import {
  clineDisplayName,
  isClineFreeModel,
  mergeClineModels,
  parseClineRecommendedModels,
  parseClineRemoteModelIds,
} from '../../src/cline-models.js'
import { CLINE } from '../../src/cline-product.js'

/** 实测的 `recommended-models` 响应（2026-09-25，缩略但字段完整）。 */
const RECOMMENDED_FIXTURE = {
  recommended: [
    { id: 'spacexai/grok-4.7', name: 'grok-4.7', description: '', tags: ['NEW'] },
    { id: 'anthropic/claude-opus-5', name: 'claude-opus-5', description: '', tags: ['NEW'] },
  ],
  free: [
    { id: 'stealth/space-bunny-alpha', name: 'space-bunny-alpha', description: 'Blazing-fast inference with 1M context', tags: [] },
    { id: 'cline-free/mimo-v2.6-flash', name: 'Mimo V2.6 Flash', description: 'Mixture-of-Experts architecture with 309B total parameters', tags: [] },
    { id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-v4.1-Flash', description: 'Fast and efficient with 1M context window ', tags: [] },
    { id: 'cline-free/gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: "Google's most intelligent Flash model", tags: [] },
    { id: 'cline-free/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor', description: 'Meta multimodal reasoning model', tags: [] },
  ],
  clinePass: [
    { id: 'cline-pass/mimo-v2.6-flash', name: 'cline-pass/mimo-v2.6-flash', description: '', tags: [] },
    { id: 'cline-pass/glm-5.3', name: 'cline-pass/glm-5.3', description: "Z-AI's new top open-weights model", tags: [] },
  ],
}

describe('parseClineRecommendedModels', () => {
  it('取出三个数组', () => {
    const parsed = parseClineRecommendedModels(RECOMMENDED_FIXTURE)
    expect(parsed.free.map((e) => e.id)).toHaveLength(5)
    expect(parsed.recommended.map((e) => e.id)).toEqual(['spacexai/grok-4.7', 'anthropic/claude-opus-5'])
    expect(parsed.clinePass.map((e) => e.id)).toEqual(['cline-pass/mimo-v2.6-flash', 'cline-pass/glm-5.3'])
  })

  it('free 数组逐条解析（2026-09-25 抓到的 5 条，含后来被下线的 gemini-3.8-flash）', () => {
    // ⚠️ 本 fixture 是**历史报文**，只用来锁解析行为；远端 `free` 现为 4 条
    // （2026-10-03 复测），兜底表与 `tests/unit/cline.spec.ts` 已同步。
    const parsed = parseClineRecommendedModels(RECOMMENDED_FIXTURE)
    expect(parsed.free.map((e) => e.id).sort()).toEqual([
      'cline-free/deepseek-v4.1-flash',
      'cline-free/gemini-3.8-flash',
      'cline-free/mimo-v2.6-flash',
      'cline-free/muse-spark-1.3-contributor',
      'stealth/space-bunny-alpha',
    ].sort())
  })

  it('垃圾输入返回三个空数组而不抛错', () => {
    for (const value of [undefined, null, 'str', 42, []]) {
      const parsed = parseClineRecommendedModels(value)
      expect(parsed.free, String(value)).toEqual([])
      expect(parsed.recommended, String(value)).toEqual([])
      expect(parsed.clinePass, String(value)).toEqual([])
    }
  })

  it('丢弃缺 id 的垃圾条目', () => {
    const parsed = parseClineRecommendedModels({
      free: [{ id: 'ok/one' }, { name: 'no-id' }, { id: '' }, null, 'str'],
    })
    expect(parsed.free.map((e) => e.id)).toEqual(['ok/one'])
  })
})

describe('parseClineRemoteModelIds', () => {
  it('从 {data:[{id}]} 取 id 列表', () => {
    expect(parseClineRemoteModelIds({
      object: 'list',
      data: [
        { id: 'fireworks/ember-1', object: 'model', created: 1, owned_by: 'fireworks' },
        { id: 'deepseek/deepseek-v4.1-flash', object: 'model', created: 2, owned_by: 'deepseek' },
      ],
    })).toEqual(['fireworks/ember-1', 'deepseek/deepseek-v4.1-flash'])
  })

  it('垃圾输入返回空数组', () => {
    for (const value of [undefined, null, 'str', {}, { data: 'x' }]) {
      expect(parseClineRemoteModelIds(value), String(value)).toEqual([])
    }
  })
})

describe('免费判定（集合动态判定，不硬编码模型名）', () => {
  const remoteFree = new Set(['cline-free/deepseek-v4.1-flash', 'stealth/space-bunny-alpha'])

  it('远端 free 集合命中即免费', () => {
    expect(isClineFreeModel('cline-free/deepseek-v4.1-flash', remoteFree)).toBe(true)
    expect(isClineFreeModel('stealth/space-bunny-alpha', remoteFree)).toBe(true)
  })

  it('`:free` 后缀命中即免费（内嵌目录里的 21 个条目）', () => {
    expect(isClineFreeModel('z-ai/glm-5.2:free')).toBe(true)
    expect(isClineFreeModel('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(true)
    // `openrouter/free` 不含冒号，靠前缀分支以外的方式**不**判免费
    // （它确实是免费别名，但由远端 free 数组覆盖；这里只锁死后缀判定的精确性）
    expect(isClineFreeModel('foo:freebar')).toBe(false)
  })

  it('`cline-free/` 前缀命中即免费（远端未响应时的兜底）', () => {
    expect(isClineFreeModel('cline-free/anything-new')).toBe(true)
  })

  it('兜底表的 isFree 参与判定', () => {
    expect(isClineFreeModel('cline-free/gemini-3.8-flash')).toBe(true)
    expect(isClineFreeModel('deepseek/deepseek-v4.1-flash')).toBe(false)
  })

  /**
   * ⚠️ **核心不变式**：免费与付费是**两个不同的 id**。
   * `cline-free/deepseek-v4.1-flash` 免费，而
   * `deepseek/deepseek-v4.1-flash` 按量计费 —— 绝不可因名字相似就判免费
   * （那会让用户按免费预期使用却被计费）。
   */
  it('同名但不同命名空间的付费模型**不**被判为免费', () => {
    expect(isClineFreeModel('cline-free/deepseek-v4.1-flash', remoteFree)).toBe(true)
    expect(isClineFreeModel('deepseek/deepseek-v4.1-flash', remoteFree)).toBe(false)
    // 即便不带远端集合，付费 id 也不得命中任何分支
    expect(isClineFreeModel('deepseek/deepseek-v4.1-flash')).toBe(false)
  })

  it('未登记的付费模型默认不免费', () => {
    for (const id of ['openai/gpt-6-luna', 'anthropic/claude-opus-5', 'fireworks/ember-1']) {
      expect(isClineFreeModel(id), id).toBe(false)
    }
  })
})

describe('clineDisplayName', () => {
  it('免费模型拼 「 · 免费」', () => {
    expect(clineDisplayName({ name: 'DeepSeek V4.1 Flash', isFree: true })).toBe('DeepSeek V4.1 Flash · 免费')
  })

  it('付费模型不加后缀', () => {
    expect(clineDisplayName({ name: 'GPT-6 Luna', isFree: false })).toBe('GPT-6 Luna')
  })

  /**
   * ⚠️ 标记必须进 `name`（**不是** `description`）：composer 的模型切换菜单
   * 只渲染 `name`（dsh-client-ui-model-selection 的 ModelSelect 里只有
   * `title: model.name` 与 `children: model.name`，完全不读 `description`）。
   * 这是被用户报障纠正过的结论。
   */
  it('返回的是单一字符串（供写进 name）', () => {
    expect(typeof clineDisplayName({ name: 'X', isFree: true })).toBe('string')
  })
})

describe('mergeClineModels', () => {
  const remote = {
    freeIds: RECOMMENDED_FIXTURE.free.map((e) => e.id),
    remoteIds: [
      'fireworks/ember-1',
      'deepseek/deepseek-v4.1-flash',
      'cline-free/deepseek-v4.1-flash',
      'z-ai/glm-5.2:free',
    ],
    entries: [...RECOMMENDED_FIXTURE.free, ...RECOMMENDED_FIXTURE.recommended, ...RECOMMENDED_FIXTURE.clinePass],
  }

  it('免费模型排在最前（用户最关心）', () => {
    const models = mergeClineModels(CLINE, remote)
    const firstFive = models.slice(0, 5).map((m) => m.id)
    expect(firstFive.sort()).toEqual([...remote.freeIds].sort())
    expect(models.slice(0, 5).every((m) => m.isFree)).toBe(true)
  })

  it('远端 `/models` 里的付费模型也进列表（用户要求「全部列出」）', () => {
    const models = mergeClineModels(CLINE, remote)
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('fireworks/ember-1')?.isFree).toBe(false)
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.isFree).toBe(false)
    // `:free` 后缀的条目免费
    expect(byId.get('z-ai/glm-5.2:free')?.isFree).toBe(true)
  })

  it('id 不重复（同一 id 出现在多个来源时只保留一次）', () => {
    const models = mergeClineModels(CLINE, remote)
    const ids = models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('兜底表里的元数据被保留（上下文窗口 / 输出上限 / 图片能力）', () => {
    const models = mergeClineModels(CLINE, remote)
    // ⚠️ 用**仍在兜底表**的条目断言：`cline-free/deepseek-v4.1-flash` 已于
    // 2026-10-05 被 Cline 下架、随之从兜底表删除（见 cline-product.ts）。
    const entry = models.find((m) => m.id === 'cline-free/mimo-v2.6-flash')
    expect(entry?.contextWindow).toBe(1_048_576)
    expect(entry?.maxTokens).toBe(131_072)
    expect(entry?.supportsImage).toBe(true)
  })

  it('远端只有 id 时派生可读展示名（不显示裸 id）', () => {
    const models = mergeClineModels(CLINE, { freeIds: [], remoteIds: ['openai/gpt-6-luna'], entries: [] })
    const entry = models.find((m) => m.id === 'openai/gpt-6-luna')
    expect(entry?.name).toBe('Gpt 6 Luna')
    expect(entry?.name).not.toBe('openai/gpt-6-luna')
  })

  it('远端 `free` 数组里的模型即使不在兜底表也被标免费', () => {
    // **远端才是权威** —— 这里用一个兜底表完全没有的新免费 id 验证集合判定生效。
    const models = mergeClineModels(CLINE, {
      freeIds: ['brand-new/free-model-x'],
      remoteIds: [],
      entries: [{ id: 'brand-new/free-model-x', name: 'Free Model X' }],
    })
    const entry = models.find((m) => m.id === 'brand-new/free-model-x')
    expect(entry?.isFree).toBe(true)
    expect(clineDisplayName(entry!)).toBe('Free Model X · 免费')
  })

  it('两个来源都为空时仍返回兜底表（离线可用）', () => {
    const models = mergeClineModels(CLINE, { freeIds: [], remoteIds: [], entries: [] })
    expect(models.length).toBe(CLINE.fallbackModels.length)
    // 兜底表当前全是免费模型（2026-10-05 复测：`free` 数组 3 条）。
    // ⚠️ 断言与表联动而非写死数字：上游每次撤免费模型都要同步这张表，
    // 写死会让「同步表」这个动作连带弄红一个无关的用例。
    expect(models.filter((m) => m.isFree)).toHaveLength(CLINE.fallbackModels.length)
  })

  it('`clinePass` 里的订阅制模型**不**被判为免费', () => {
    // ⚠️ cline-pass 是订阅制（按订阅额度计费），不是免费。
    const models = mergeClineModels(CLINE, remote)
    const pass = models.find((m) => m.id === 'cline-pass/glm-5.3')
    expect(pass?.isFree).toBe(false)
  })
})

/**
 * ⚠️ **核心回归**：兜底表里的**已下架**条目不得被「复活」。
 *
 * 真实报障（2026-10-05）：`cline-free/deepseek-v4.1-flash` 被 Cline 从 `free`
 * 数组移除后，模型列表里**仍然**出现、**仍然**标着「免费」，用户选中即回
 * `404 {"error":"model not found"}`。根因是合并时把兜底表**无条件整表并回**
 * （展示需要），且 `isClineFreeModel` 的判定回落到兜底表的 `isFree`。
 *
 * ⚠️ 该缺陷**重启不会消失**：合并发生在每次全新加载时。
 *
 * 覆盖矩阵（含可能误伤的降级态）：
 * | 远端状态 | 期望 |
 * |---|---|
 * | 健康（`entries` 非空） | 丢弃远端不认识的兜底条目 |
 * | 离线（三者全空） | **整表保留**（免费模型的唯一来源） |
 * | `recommended-models` 挂、`/models` 通 | **整表保留**（免费集合权威性未知） |
 * | 免费模型被全部下架 | 丢弃全部兜底免费条目 |
 */
describe('mergeClineModels —— 兜底表不得复活已下架模型', () => {
  /** 2026-10-05 复测的真实 `free` 数组（3 条）。 */
  const LIVE_FREE = [
    'stealth/space-bunny-alpha',
    'cline-free/mimo-v2.6-flash',
    'cline-free/muse-spark-1.3-contributor',
  ]
  const liveRemote = {
    freeIds: LIVE_FREE,
    remoteIds: ['fireworks/ember-1'],
    entries: LIVE_FREE.map((id) => ({ id })),
  }

  it('远端健康时，兜底表里「远端已不认识」的条目不再进列表', () => {
    const models = mergeClineModels(CLINE, liveRemote)
    const removed = 'cline-free/deepseek-v4.1-flash'
    expect(models.some((m) => m.id === removed)).toBe(false)
    // 强调：免费判定**仍**认它（前缀分支），所以它没进列表**只**能是因为被过滤
    // —— 否则这条断言会在「判定被顺带改坏」时假绿。
    expect(isClineFreeModel(removed)).toBe(true)
  })

  it('远端健康时，在册的 3 个免费模型都在且标免费', () => {
    const models = mergeClineModels(CLINE, liveRemote)
    const byId = new Map(models.map((m) => [m.id, m]))
    for (const id of LIVE_FREE) expect(byId.get(id)?.isFree, id).toBe(true)
  })

  it('已下架条目同时从兜底表删除（数据与机制双向锁）', () => {
    expect(CLINE.fallbackModels.some((m) => m.id === 'cline-free/deepseek-v4.1-flash')).toBe(false)
  })

  it('离线（三者全空）时整表保留 —— 此时兜底表是免费模型的唯一来源', () => {
    const models = mergeClineModels(CLINE, { freeIds: [], remoteIds: [], entries: [] })
    expect(models.map((m) => m.id).sort()).toEqual(CLINE.fallbackModels.map((m) => m.id).sort())
  })

  it('`recommended-models` 挂掉但 `/models` 通时，兜底免费模型不得被误删', () => {
    // ⚠️ 最容易误伤的降级态：`/models` 有 460 个 id，若判据写成「远端有数据就
    // 过滤」，会把免费兜底整表删光 —— 用户明明还能用免费模型，列表里却一个都没有。
    const models = mergeClineModels(CLINE, {
      freeIds: [],
      remoteIds: ['fireworks/ember-1'],
      entries: [],
    })
    for (const model of CLINE.fallbackModels) {
      expect(models.some((m) => m.id === model.id), model.id).toBe(true)
    }
  })

  it('免费模型被上游**全部**下架时，兜底免费条目全部丢弃', () => {
    // 判据必须用 `entries` 非空（`recommended-models` 成功下发）而非 `freeIds`
    // 非空：后者在「全撤」时也合法为空，只看它会把这种情况误判成「端点挂掉」，
    // 反而保留整张已经全部失效的兜底表。
    const models = mergeClineModels(CLINE, {
      freeIds: [],
      remoteIds: [],
      entries: [{ id: 'anthropic/claude-sonnet-5.5' }],
    })
    expect(models.filter((m) => m.isFree)).toHaveLength(0)
    expect(models.some((m) => m.id === 'anthropic/claude-sonnet-5.5')).toBe(true)
  })

  it('远端下发兜底表里没有的模型时照常列出（过滤不会误伤新模型）', () => {
    const models = mergeClineModels(CLINE, {
      freeIds: ['brand-new/free-x'],
      remoteIds: [],
      entries: [{ id: 'brand-new/free-x', name: 'Brand New' }],
    })
    const entry = models.find((m) => m.id === 'brand-new/free-x')
    expect(entry?.isFree).toBe(true)
    expect(entry?.name).toBe('Brand New')
  })
})
