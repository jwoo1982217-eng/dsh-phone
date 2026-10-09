import { describe, expect, it } from 'vitest'
import { buildVirtualModels } from '../../src/aggregate-catalog.js'

/** 造一份最小目录。 */
function catalog(entries: Record<string, Array<[string, string]>>) {
  const out: Record<string, Array<{ id: string; name: string }>> = {}
  for (const [provider, list] of Object.entries(entries)) {
    out[provider] = list.map(([id, name]) => ({ id, name }))
  }
  return out
}

describe('buildVirtualModels：同一模型跨渠道合并', () => {
  it('buddy 与 codearts 的 deepseek-v4.1-flash 合并成一个虚拟模型', () => {
    const models = buildVirtualModels(catalog({
      buddy: [['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash']],
      codearts: [['deepseek-v4.1-flash', 'deepseek-v4.1-flash']],
    }))
    expect(models).toHaveLength(1)
    expect(models[0]!.key).toBe('deepseek-v4-1-flash')
    expect(models[0]!.name).toBe('DeepSeek V4.1 Flash')
    expect(models[0]!.candidates.map((c) => c.provider).sort()).toEqual(['buddy', 'codearts'])
  })

  it('保留每条候选的真实 id 与展示名（子列表要能逐行核查）', () => {
    const models = buildVirtualModels(catalog({
      cline: [['cline-free/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash · 免费']],
    }))
    const candidate = models[0]!.candidates[0]!
    expect(candidate.realId).toBe('cline-free/deepseek-v4.1-flash')
    expect(candidate.realName).toBe('DeepSeek V4.1 Flash · 免费')
    expect(candidate.price).toBe(0)
    expect(candidate.via).toBe('id')
  })

  it('qoder 靠展示名通道归组（id 是代号）', () => {
    const models = buildVirtualModels(catalog({
      qoder: [['gfmodel', 'GLM-5.3-Flash']],
      zcode: [['GLM-5.3-Flash', 'GLM-5.3-Flash']],
    }))
    const target = models.find((m) => m.key === 'glm-5-3-flash')
    expect(target).toBeDefined()
    expect(target!.candidates.map((c) => c.provider).sort()).toEqual(['qoder', 'zcode'])
    expect(target!.candidates.find((c) => c.provider === 'qoder')!.via).toBe('name')
  })
})

describe('buildVirtualModels：五条安全红线', () => {
  it('R1：v4.1 与 v4 不合并', () => {
    const models = buildVirtualModels(catalog({
      buddy: [['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'], ['deepseek-v4-flash', 'Deepseek-V4-Flash']],
    }))
    expect(models.map((m) => m.key).sort()).toEqual(['deepseek-v4-1-flash', 'deepseek-v4-flash'])
  })

  it('R2：日期快照不并入无后缀版本', () => {
    const models = buildVirtualModels(catalog({
      loomy: [['deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731 · x3.0']],
      lobsterai: [['deepseek-v4-flash', 'deepseek-v4-flash']],
    }))
    expect(models.map((m) => m.key).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-0731'])
  })

  it('R3：workbuddy 的同展示名 `-sg` 与普通版不合并', () => {
    const models = buildVirtualModels(catalog({
      workbuddy: [
        ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'],
        ['deepseek-v4.1-flash-sg', 'Deepseek-V4.1-Flash'],
      ],
    }))
    expect(models.map((m) => m.key).sort()).toEqual(['deepseek-v4-1-flash', 'deepseek-v4-1-flash-sg'])
  })

  it('R4：抽象别名不进任何虚拟模型', () => {
    const models = buildVirtualModels(catalog({
      workbuddy: [['default-model', 'Auto'], ['fast-model', 'Fast']],
      qoder: [['auto', 'Auto']],
    }))
    expect(models).toHaveLength(0)
  })

  it('R5：qoder 与 qodercn 的同 key 不同模型不合并（provider 维度保留）', () => {
    const models = buildVirtualModels(catalog({
      qoder: [['mmodel', 'MiniMax-M3']],
      qodercn: [['mmodel', 'MiniMax-M2.7']],
    }))
    const m3 = models.find((m) => m.key === 'minimax-m3')
    const m27 = models.find((m) => m.key === 'minimax-m2-7')
    expect(m3!.candidates.map((c) => c.provider)).toEqual(['qoder'])
    expect(m27!.candidates.map((c) => c.provider)).toEqual(['qodercn'])
  })
})

describe('buildVirtualModels：排序与容错', () => {
  it('候选按渠道名稳定排序（面板展示与日志可比对）', () => {
    const models = buildVirtualModels(catalog({
      zcode: [['GLM-5.3-Flash', 'GLM-5.3-Flash']],
      buddy: [['glm-5.3-flash', 'GLM-5.3-Flash']],
      loomy: [['GLM-5.3-Flash', 'GLM 5.3 Flash · x0.8']],
    }))
    const target = models.find((m) => m.key === 'glm-5-3-flash')!
    expect(target.candidates.map((c) => c.provider)).toEqual(['buddy', 'loomy', 'zcode'])
  })

  it('虚拟模型按候选数降序（冗余度高的在前）', () => {
    const models = buildVirtualModels(catalog({
      buddy: [['glm-5.3', 'GLM-5.3'], ['kimi-k3-1', 'Kimi-K3-1']],
      workbuddy: [['glm-5.3', 'GLM-5.3']],
    }))
    expect(models[0]!.key).toBe('glm-5-3')
  })

  it('空目录返回空数组（不抛错）', () => {
    expect(buildVirtualModels({})).toEqual([])
    expect(buildVirtualModels({ buddy: [] })).toEqual([])
  })

  it('目录条目缺 `name` 时回落到 id 作为展示名（该分支不得无闸门）', () => {
    // `CatalogModel.name` 是可选字段（真实适配器的 listModels 有的会省略）。
    // 若该分支写错（如把 undefined 直接喂给 canonicalKeyFor），name 通道的
    // provider 会算出乱七八糟的键；id 通道的 provider 也拿不到 fallback 展示名。
    const models = buildVirtualModels({ buddy: [{ id: 'deepseek-v4.1-flash' }] })
    expect(models).toHaveLength(1)
    expect(models[0]!.key).toBe('deepseek-v4-1-flash')
    // 展示名回落到 id 本身，而不是出现 'undefined' 字面量。
    expect(models[0]!.candidates[0]!.realName).toBe('deepseek-v4.1-flash')
    expect(models[0]!.candidates[0]!.realName).not.toContain('undefined')
  })

  it('name 通道的 provider 缺 `name` 时用 id 兜底（不会算出空键）', () => {
    // qoder 走 name 通道：name 缺失时必须回落到 id，不能产出空键或 `undefined` 键。
    const models = buildVirtualModels({ qoder: [{ id: 'gfmodel' }] })
    expect(models).toHaveLength(1)
    expect(models[0]!.key).toBe('gfmodel')
    // ⚠️ 锁 `via`，不要只断言 `key.length > 0` —— 后者紧跟 `toBe('gfmodel')`
    // 之后是空转断言（评审指出）。
    expect(models[0]!.candidates[0]!.via).toBe('id')
  })

  it('空白 id 被跳过（否则会产出 key/name 皆空的退化模型 ⇒ INVALID_CATALOG）', () => {
    // ⚠️ 评审实测的失效形态：只判 `length === 0` 时，`{ id: ' ' }` 会产出
    // `{ key: '', name: '' }`，而 DSH 要求 model name 非空 ⇒ **整个聚合目录
    // 不可用**。故必须 `trim()` 判空。
    for (const blank of [' ', '   ', '\t', '\n']) {
      expect(buildVirtualModels({ buddy: [{ id: blank }] })).toEqual([])
    }
    // 对照：正常 id 不被误杀。
    expect(buildVirtualModels({ buddy: [{ id: ' glm-5.3 ' }] })).toHaveLength(1)
  })

  it('`via` 为 `patch` 的候选被透传（三成员联合类型都要覆盖）', () => {
    // lobsterai 的远端专有 id 经显式补丁归入 deepseek-v4-1-flash。
    const models = buildVirtualModels({
      lobsterai: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.key).toBe('deepseek-v4-1-flash')
    expect(models[0]!.candidates[0]!.via).toBe('patch')
  })
})

describe('★ M19：buildVirtualModels 必须是纯函数（不得原地改输入）', () => {
  it('传入被冻结的 catalogs 不抛错（证明没有原地写输入）', () => {
    // ⚠️ 函数内部有两处 `.sort()`（候选按 provider/realId、虚拟模型按候选数降序），
    //    而 `.sort()` 是**原地**的。本用例把输入**深冻结**：若哪天有人把排序改到
    //    输入数组上（例如直接 `models.sort(...)` 而不是排新建的局部数组），
    //    本用例会因「不可写」而抛错。
    const input = catalog({
      buddy: [['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'], ['glm-5.3', 'GLM-5.3']],
      codearts: [['deepseek-v4.1-flash', 'deepseek-v4.1-flash']],
    })
    for (const list of Object.values(input)) {
      for (const model of list) Object.freeze(model)
      Object.freeze(list)
    }
    Object.freeze(input)

    expect(() => buildVirtualModels(input)).not.toThrow()
  })

  it('调用两次结果一致（无隐藏状态；也证明输入未被上次调用改坏）', () => {
    const input = catalog({
      buddy: [['glm-5.3', 'GLM-5.3'], ['hy3', 'hy3']],
      codearts: [['glm-5.3', 'glm-5.3']],
    })
    const first = buildVirtualModels(input)
    const second = buildVirtualModels(input)
    expect(second.map((m) => m.key)).toEqual(first.map((m) => m.key))
    expect(second.map((m) => m.candidates.length)).toEqual(first.map((m) => m.candidates.length))
  })
})
