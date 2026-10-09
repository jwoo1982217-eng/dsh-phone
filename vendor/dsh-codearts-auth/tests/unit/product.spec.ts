import { describe, expect, it } from 'vitest'
import { CODEBUDDY, WORKBUDDY, productById } from '../../src/product.js'
import { isKnownReasoningEffort } from '../../src/reasoning-ladder.js'

describe('产品配置', () => {
  it('CodeBuddy 使用 ide platform、codebuddy 产品码与中国区端点', () => {
    expect(CODEBUDDY).toMatchObject({
      id: 'buddy',
      platform: 'ide',
      endpoint: 'https://copilot.tencent.com',
      apiDomain: 'copilot.tencent.com',
      productCode: 'codebuddy',
      defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
      appendSessionParams: false,
    })
  })

  it('WorkBuddy 使用 workbuddy-ai platform 与 workbuddy 产品码', () => {
    expect(WORKBUDDY).toMatchObject({
      id: 'workbuddy',
      platform: 'workbuddy-ai',
      productCode: 'workbuddy',
      defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
      appendSessionParams: true,
    })
  })

  it('两个产品的 id 互不相同', () => {
    expect(CODEBUDDY.id).not.toBe(WORKBUDDY.id)
  })

  it('两个产品使用不同的 endpoint（模型池随区域不同，不能共用）', () => {
    // 这是国际版改造的核心：路径与解析逻辑相同，但域名不同，
    // 不同区域后端返回不同模型池（中国版 glm/hy/deepseek，国际版 claude/gpt/gemini）。
    expect(WORKBUDDY.endpoint).toBe('https://www.workbuddy.ai')
    expect(WORKBUDDY.endpoint).not.toBe(CODEBUDDY.endpoint)
  })

  it('apiDomain 与 endpoint 的主机名一致', () => {
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      expect(new URL(product.endpoint).hostname).toBe(product.apiDomain)
    }
  })

  it('WorkBuddy 携带 pluginVersion 且 appendSessionParams 为 true', () => {
    // 逆向自 WorkBuddyAI 5.5.2 的 cli/product.json
    expect(WORKBUDDY.pluginVersion).toBe('5.5.2')
    expect(WORKBUDDY.appendSessionParams).toBe(true)
  })

  it('CodeBuddy 不需要追加会话参数', () => {
    expect(CODEBUDDY.appendSessionParams).toBe(false)
    expect(CODEBUDDY.pluginVersion).toBeUndefined()
  })

  it('两个产品的 endpoint 都是 HTTPS', () => {
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      expect(product.endpoint.startsWith('https://')).toBe(true)
    }
  })

  it('两个产品都带兜底模型目录，且条目字段完整', () => {
    // 兜底目录的用途：服务端按认证上下文下发的模型集合可能残缺，
    // 用产品自带的权威清单校正（见 BuddyAdapter.reconcileWithFallback）。
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      expect(product.fallbackModels, product.id).toBeDefined()
      expect(product.fallbackModels!.length).toBeGreaterThan(0)
      for (const model of product.fallbackModels!) {
        expect(typeof model.id).toBe('string')
        expect(model.id.length).toBeGreaterThan(0)
        expect(typeof model.name).toBe('string')
        expect(model.name.length).toBeGreaterThan(0)
        expect(model.contextWindow).toBeGreaterThan(0)
      }
    }
  })

  it('WorkBuddy 兜底目录含 IDE 实际展示的 GPT 系列', () => {
    // 这 6 个模型是 CLI token 从 /v3/config 拿不到的（实测只返回 13 个内部别名），
    // 必须由兜底目录提供。
    const ids = new Set(WORKBUDDY.fallbackModels!.map((m) => m.id))
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('凡声明了 reasoningEfforts 的 deepseek 系模型都必须声明 defaultReasoningEffort', () => {
    // 真实缺陷回归（会话 session-03b4d1f2 "测试思考过程显示"）：WorkBuddy 的
    // deepseek-v4.1-flash 只声明了 reasoningEfforts:['high'] 而漏了默认档，
    // 导致 resolveModel() 不下发 reasoning.defaultEffort → composer 不预选档位
    // → 请求体缺 reasoning_effort → 上游对 deepseek 系按不思考应答 → UI 无思考块。
    //
    // 只对 deepseek 系设限：实测只有它们把 reasoning_effort 当开关（不带就不思考）；
    // glm/kimi 等走默认开的 thinkingFormat，缺默认档不影响思考返回。
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      for (const model of product.fallbackModels!) {
        if (!/^deepseek/i.test(model.id)) continue
        expect(model.reasoningEfforts, `${product.id}/${model.id}`).toBeDefined()
        expect(model.defaultReasoningEffort, `${product.id}/${model.id}`).toBeDefined()
        // 默认档必须在支持档之内，否则 resolveModel() 会静默丢弃该字段。
        expect(model.reasoningEfforts, `${product.id}/${model.id}`).toContain(model.defaultReasoningEffort)
      }
    }
  })

  it('WorkBuddy 与 CodeBuddy 对 deepseek-v4.1-flash 声明一致的默认思考档', () => {
    // 两个产品共用同一后端协议，deepseek 系开思考依赖 reasoning_effort。
    // 同一模型在两边的思考元数据不应分叉——任一缺失都会让该产品静默不思考。
    const find = (models: readonly { id: string }[], id: string) => models.find((m) => m.id === id) as
      { reasoningEfforts?: readonly string[]; defaultReasoningEffort?: string } | undefined
    const cb = find(CODEBUDDY.fallbackModels!, 'deepseek-v4.1-flash')
    const wb = find(WORKBUDDY.fallbackModels!, 'deepseek-v4.1-flash')
    expect(cb?.defaultReasoningEffort).toBeDefined()
    expect(wb?.defaultReasoningEffort).toBe(cb?.defaultReasoningEffort)
    expect(wb?.reasoningEfforts).toContain(wb?.defaultReasoningEffort)
  })

  it('兜底目录不含非对话模型与实测不可用的内部别名', () => {
    const banned = ['o4-mini', 'nes-1.1', 'nes-1.2', 'completion-1.0', 'codewise-jump', 'hunyuan-image-alpha']
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      for (const id of banned) {
        expect(product.fallbackModels!.some((m) => m.id === id), `${product.id}:${id}`).toBe(false)
      }
    }
  })

  it('思考等级非空的条目带默认等级', () => {
    for (const product of [CODEBUDDY, WORKBUDDY]) {
      for (const model of product.fallbackModels!) {
        if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0) {
          for (const effort of model.reasoningEfforts) {
            expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(effort)
          }
        }
      }
    }
  })

  // ── issue IKJQSH：兜底表是这两个模型的唯一档位来源 ──
  //
  // 实测（2026-10-06，真实登录态直打）：国际版 `/v3/config` 对这两个模型
  // **不下发 supportedEfforts**，只给单值 `reasoning: {effort:"high"}`；
  // 而 `parseModelMeta`（src/buddy.ts:905）不认 `effort`，故远端表态被静默忽略，
  // 最终落到本表 ⇒ 表里写什么，用户就有什么可用。
  //
  // ⚠️ 为什么 CodeBuddy 那条不改：实测中国版远端**确实下发**
  // `supportedEfforts: ["low","high","max"]`，兜底表与之一致，无需改动。
  // 两条路径不可混为一谈 —— 远端表达与否，因端点而异。
  it('workbuddy 的 deepseek-v4.1-flash 系列声明实测可用的五档（远端不下发列表，本表是唯一来源）', () => {
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg']) {
      const entry = WORKBUDDY.fallbackModels!.find((m) => m.id === id)
      expect(entry, `workbuddy 应收录 ${id}`).toBeDefined()
      expect(entry!.reasoningEfforts, id).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      // 默认档必须落在声明档内，否则 resolveModel 静默丢弃、UI 无预选。
      expect(entry!.reasoningEfforts).toContain(entry!.defaultReasoningEffort)
    }
  })

  it('⚠️ 兜底表里凡声明了 5 档的条目，其档位集合必须是同表 GPT 系的子集（不得臆造）', () => {
    // 防「凭空加档位」：本仓库多处教训是「不要臆造模型未声明的档位」。
    // 5 档的合法来源只有实测记录（见 src/product.ts 对应条目的注释），
    // 且必须能被 reasoning-ladder 的强度序识别（否则网关翻译会失准）。
    const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
    const five = WORKBUDDY.fallbackModels!.filter(
      (m) => m.reasoningEfforts?.length === FIVE.length,
    )
    expect(five.length, '应至少有 workbuddy 的两个 deepseek-v4.1-flash 系列').toBeGreaterThan(0)
    for (const model of five) {
      expect([...FIVE].sort(), model.id).toEqual([...model.reasoningEfforts!].sort())
      for (const effort of model.reasoningEfforts!) {
        expect(isKnownReasoningEffort(effort), `${model.id}/${effort} 必须已登记强度序`).toBe(true)
      }
    }
  })

  it('CodeBuddy 的 deepseek-v4.1-flash 维持三档（实测中国版远端下发 ["low","high","max"]）', () => {
    // 与 workbuddy 刻意不同：两站远端表达不同，不能互相套用。
    const entry = CODEBUDDY.fallbackModels!.find((m) => m.id === 'deepseek-v4.1-flash')!
    expect(entry.reasoningEfforts).toEqual(['low', 'high', 'max'])
    // 中国版端点不存在 -sg 变体（实测 code:11102 service info not found），
    // 故兜底表不该收录它 —— 收录会让选择器出现一个必然报错的模型。
    expect(CODEBUDDY.fallbackModels!.some((m) => m.id === 'deepseek-v4.1-flash-sg')).toBe(false)
  })

  it('productById 能按 id 查到配置', () => {
    expect(productById('buddy')).toBe(CODEBUDDY)
    expect(productById('workbuddy')).toBe(WORKBUDDY)
  })

  it('productById 对未知 id 返回 undefined', () => {
    expect(productById('codearts')).toBeUndefined()
    expect(productById('')).toBeUndefined()
  })
})
