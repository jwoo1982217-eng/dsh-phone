import { describe, expect, it } from 'vitest'
import {
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  displayNameForModel,
  formatCreditsRate,
  isExpired,
  isRefreshable,
  normalizeCreditsRate,
  parseAccountData,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData,
} from '../../src/buddy.js'

const futureMs = Date.now() + 7_200_000
const pastMs = Date.now() - 60_000

/** 构造一个仅用于解析测试的未签名 JWT（payload 可自定义）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('buddy credential parsing', () => {
  it('parseTokenData accepts string fields and defaults tokenType to Bearer', () => {
    const token = parseTokenData({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: '2026-08-30T00:00:00Z',
      refreshExpiresAt: '2026-09-29T00:00:00Z',
      scope: '',
      domain: 'copilot.tencent.com',
    })
    // ISO 绝对时间被归一化为毫秒时间戳字符串（credentialExpiresAtMs 统一解析）。
    expect(token).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: String(Date.parse('2026-08-30T00:00:00Z')),
      refreshExpiresAt: String(Date.parse('2026-09-29T00:00:00Z')),
      tokenType: 'Bearer',
      scope: '',
      domain: 'copilot.tencent.com',
    })
  })

  it('parseTokenData 用 expiresIn 相对秒数换算绝对过期时间（e2e 实证格式）', () => {
    // 真实响应不含 expiresAt/refreshExpiresAt，只有 expiresIn/refreshExpiresIn。
    // JWT 的 iat=1789132433 / exp=1794316433 作为换算基准。
    const accessToken = makeJwt({ iat: 1789132433, exp: 1794316433, nickname: 'Jet' })
    const token = parseTokenData({
      accessToken,
      refreshToken: 'RT',
      expiresIn: 5184000,
      refreshExpiresIn: 7776000,
      tokenType: 'Bearer',
      scope: 'profile offline_access email',
      domain: 'copilot.tencent.com',
    })
    // 基准用 iat：1789132433000 + 5184000 * 1000
    expect(token.expiresAt).toBe(String(1789132433000 + 5184000 * 1000))
    expect(token.refreshExpiresAt).toBe(String(1789132433000 + 7776000 * 1000))
    // 与 JWT exp 一致（5184000s = 60 天）
    expect(Number(token.expiresAt)).toBe(1794316433 * 1000)
  })

  it('parseTokenData 在无 expiresIn 时保持空串，由 credentialExpiresAtMs 从 JWT exp 兜底', () => {
    const accessToken = makeJwt({ exp: 1794316433 })
    const token = parseTokenData({ accessToken, refreshToken: 'RT' })
    expect(token.expiresAt).toBe('')
    const ms = credentialExpiresAtMs({
      access_token: accessToken, refresh_token: 'RT', expires_at: token.expiresAt,
    })
    expect(ms).toBe(1794316433 * 1000)
  })

  it('buildCredential 从 JWT 回填 nickname 与 user_id（login/account 常为空）', () => {
    const accessToken = makeJwt({ sub: 'uid-from-jwt', nickname: 'Jet', preferred_username: '186' })
    const credential = buildCredential(
      parseTokenData({ accessToken, refreshToken: 'RT', expiresIn: 3600 }),
      parseAccountData({ uid: '', nickname: '', type: 'personal' }),
    )
    expect(credential.nickname).toBe('Jet')
    expect(credential.user_id).toBe('uid-from-jwt')
    // 落盘安全性：JSON 必须是单行（多行会被 YAML 当块标量破坏结构）
    expect(/[\r\n]/.test(JSON.stringify(credential))).toBe(false)
  })

  it('parseTokenData 清洗 scope 中的换行（否则破坏 YAML 中的凭据 JSON）', () => {
    const token = parseTokenData({
      accessToken: 'AT', refreshToken: 'RT', scope: 'profile\n    offline_access\n    email',
    })
    expect(token.scope).toBe('profile offline_access email')
    expect(/[\r\n]/.test(JSON.stringify(token))).toBe(false)
  })

  it('parseTokenData stringifies numeric timestamps', () => {
    const token = parseTokenData({ accessToken: 'AT', refreshToken: 'RT', expiresAt: futureMs })
    expect(token.expiresAt).toBe(String(futureMs))
  })

  it('parseTokenData tolerates null/non-object payloads', () => {
    expect(parseTokenData(null).accessToken).toBe('')
    expect(parseTokenData(undefined).tokenType).toBe('Bearer')
  })

  it('parseAccountData defaults type to personal', () => {
    const account = parseAccountData({ uid: 'u1', nickname: 'n1', enterpriseId: '' })
    expect(account).toEqual({ uid: 'u1', nickname: 'n1', enterpriseId: '', accountType: 'personal' })
  })

  it('buildCredential merges token and account', () => {
    const credential = buildCredential(
      parseTokenData({ accessToken: 'AT', refreshToken: 'RT', domain: 'copilot.tencent.com' }),
      parseAccountData({ uid: 'u1', nickname: 'n1', type: 'enterprise', enterpriseId: 'ent-1' }),
    )
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT',
      domain: 'copilot.tencent.com',
      user_id: 'u1',
      nickname: 'n1',
      account_type: 'enterprise',
      enterprise_id: 'ent-1',
    })
  })
})

describe('buddy expiry helpers', () => {
  it('credentialExpiresAtMs reads millisecond timestamps', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(futureMs)
  })

  it('credentialExpiresAtMs converts second timestamps to milliseconds', () => {
    const seconds = Math.floor(futureMs / 1000)
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(seconds) })).toBe(seconds * 1000)
  })

  it('credentialExpiresAtMs parses ISO 8601 strings', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: '2026-08-30T00:00:00Z' }))
      .toBe(Date.parse('2026-08-30T00:00:00Z'))
  })

  it('credentialExpiresAtMs returns undefined when absent or unparseable', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT' })).toBeUndefined()
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: 'not-a-date' })).toBeUndefined()
  })

  it('isExpired is false when the expiry is unknown (aligns with Rust is_expired)', () => {
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT' })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(pastMs) })).toBe(true)
  })

  it('isRefreshable requires a non-empty refresh_token', () => {
    expect(isRefreshable({ access_token: 'AT', refresh_token: 'RT' })).toBe(true)
    expect(isRefreshable({ access_token: 'AT', refresh_token: '' })).toBe(false)
  })
})

describe('buddy request headers', () => {
  it('requestHeaders sends X-Domain and the IDE User-Agent', () => {
    const headers = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
  })

  it('requestHeaders falls back to the default domain', () => {
    expect(credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT' })['X-Domain']).toBe('copilot.tencent.com')
  })

  /**
   * 回归：**空串** domain 也必须回退（`??` 对空串不生效）。
   *
   * 这不是构造出来的边界 —— `parseTokenData` 用 `readStringField` 读 domain，
   * 后端未下发该字段时返回的是**空串**（不是 undefined），故该凭据形态在真实
   * 登录后即可出现。修复前此处发出的是 `X-Domain: ''`（已实测复现）。
   *
   * ⚠️ 上一条用例传的是「字段缺失」（`domain === undefined`），而按类型声明
   * `domain` 是必填 string，那种形态在真实凭据里并不存在，恰好绕过了本缺陷 ——
   * 故本用例必须显式传空串才能锁住它。
   */
  it('requestHeaders 对空串 domain 同样回退（?? 的陷阱）', () => {
    expect(credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', domain: '' })['X-Domain'])
      .toBe('copilot.tencent.com')
  })

  it('requestHeaders adds enterprise headers only for enterprise accounts', () => {
    const personal = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: '' })
    expect(personal['X-Enterprise-Id']).toBeUndefined()

    const enterprise = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: 'ent-123' })
    expect(enterprise['X-Enterprise-Id']).toBe('ent-123')
    expect(enterprise['X-Tenant-Id']).toBe('ent-123')
  })

  it('authHeaders adds the Bearer token', () => {
    const headers = credentialAuthHeaders({ access_token: 'tok', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
  })
})

describe('buddy model config parsing', () => {
  it('parses cli agent models from the enterprise models endpoint', () => {
    // 企业模型端点（/console/enterprises/personal/models）用 `cli` agent
    // 承载可选模型清单，且 data.models 带完整元数据（含 /v3/config 没有的 GPT 系列）。
    const models = parseModelsFromConfig({
      data: {
        agents: [
          { name: 'cli', models: ['default-model', 'gpt-5.6-sol', 'glm-5.2'] },
          { name: 'general-purpose' },
          { name: 'contentAnalyzer', models: ['lite'] },
        ],
        models: [
          { id: 'default-model', name: 'Auto', maxInputTokens: 176000 },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', maxInputTokens: 1000000 },
          { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000 },
        ],
      },
    })
    expect(models).toEqual([
      // ⚠️ `agentReferenced: true` 标记「服务端声明该模型可在对话里选择」。
      // 适配器的 `reconcileWithFallback` 是白名单式重建，用它把「不在产品兜底表
      // 但服务端说可选」的模型保留下来（实测 `hy4-preview-f` 只在 /v3/config
      // 下发且被 agent 引用，否则会被丢弃、用户看不到那个免费变体）。
      { id: 'default-model', name: 'Auto', contextWindow: 176_000, agentReferenced: true },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, agentReferenced: true },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, agentReferenced: true },
    ])
  })

  it('prefers the remote name over the static display table', () => {
    // 服务端下发的 name 是权威来源：新模型不在静态表里，
    // 且静态表对老模型的叫法可能已过时（如 kimi-k2.6 旧名 Kimi K2.6）。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'cli', models: ['gpt-5.6-sol', 'kimi-k2.6', 'unknown-model'] }],
        models: [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
          { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
          { id: 'unknown-model' },
        ],
      },
    })
    expect(models.map((m) => m.name)).toEqual(['GPT-5.6-Sol', 'Kimi-K2.6', 'unknown-model'])
  })

  it('parses remote reasoning efforts from the enterprise endpoint', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'cli', models: ['gpt-5.6-terra'] }],
        models: [{
          id: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          reasoning: { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        }],
      },
    })
    expect(models[0]!.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(models[0]!.defaultReasoningEffort).toBe('high')
  })

  it('parses craft agent models and excludes auto', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [
          { name: 'other', models: ['should-be-ignored'] },
          { name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'hy4-preview', name: 'Hy4 Preview', agentReferenced: true },
      { id: 'glm-5.3', name: 'GLM-5.3', agentReferenced: true },
    ])
  })

  it('attaches maxInputTokens from data.models as contextWindow', () => {
    // /v3/config data.models[].maxInputTokens 是模型上下文窗口的权威来源
    // （对齐 deveco-code-rust parse_models_from_config）。
    // data.models 中未被 craft 引用但可对话的条目也会被补进列表（如 unknown-model）。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['auto', 'glm-5.3-flash', 'kimi-k2.6'] }],
        models: [
          { id: 'glm-5.3-flash', maxInputTokens: 1048576 },
          { id: 'kimi-k2.6', maxInputTokens: 262144 },
          { id: 'unknown-model', maxInputTokens: 8192 },
          { id: 'bad-entry', maxInputTokens: 0 },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576, agentReferenced: true },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, agentReferenced: true },
      // data.models 里的其余可对话模型也会被补进列表，但它们**不在 agent 清单**里
      // → 不带 `agentReferenced`（reconcile 时不会被特殊保留）。
      { id: 'unknown-model', name: 'unknown-model', contextWindow: 8192 },
      { id: 'bad-entry', name: 'bad-entry' },
    ])
  })

  it('appends models from data.models that craft does not reference', () => {
    // 国际版的 craft 只引用 5 个抽象别名，其余可用模型只出现在 data.models 里；
    // 若只取 craft，这些模型会在选择器中消失。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['default-model'] }],
        models: [
          { id: 'default-model' },
          { id: 'o4-mini', maxInputTokens: 128000 },
          { id: 'hunyuan-image-alpha', tags: ['text-to-image'] },
          { id: 'nes-1.2' },
          { id: 'completion-1.0' },
          { id: 'codewise-jump', maxOutputTokens: 256 },
          { id: 'codewise-completions', supportsExtra: true },
          { id: 'codewise-default-model-v2', maxOutputTokens: 32000 },
          { id: 'compact-helper', maxOutputTokens: 256 },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['default-model', 'o4-mini'])
  })

  it('appends trial models from productFeaturesConfig.ModelTrialBanner', () => {
    // 国际版的 hy4-preview 既不在 craft 列表也不在 data.models，
    // 仅由试用横幅下发，但实测可正常调用，故一并加入。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['default-model'] }],
        models: [{ id: 'default-model' }],
        productFeaturesConfig: {
          ModelTrialBanner: {
            banners: [{ modelId: 'hy4-preview-f', targetModelId: 'hy4-preview', trialDays: 14 }],
          },
        },
      },
    })
    expect(models.map((m) => m.id)).toEqual(['default-model', 'hy4-preview'])
    expect(models[1]!.name).toBe('Hy4 Preview')
  })

  it('does not duplicate a trial model already present', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['hy4-preview'] }],
        models: [{ id: 'hy4-preview' }],
        productFeaturesConfig: {
          ModelTrialBanner: { banners: [{ targetModelId: 'hy4-preview' }] },
        },
      },
    })
    expect(models.map((m) => m.id)).toEqual(['hy4-preview'])
  })

  it('keeps craft models first when data.models has extra entries', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['glm-5.3', 'hy4-preview'] }],
        models: [{ id: 'aaa-extra' }, { id: 'glm-5.3' }, { id: 'hy4-preview' }],
      },
    })
    // craft 的顺序必须保留在最前，data.models 的其余条目追加在后
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'hy4-preview', 'aaa-extra'])
  })

  it('parses the capability fields the adapter declares models from', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['deepseek-v4.1-flash', 'glm-5.1'] }],
        models: [
          {
            id: 'deepseek-v4.1-flash',
            maxInputTokens: 1_000_000,
            supportsImages: true,
            reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] },
          },
          // 只有固定 effort 的模型没有 supportedEfforts → 不暴露等级选择器
          { id: 'glm-5.1', maxInputTokens: 200_000, supportsImages: true, reasoning: { effort: 'medium' } },
        ],
      },
    })
    expect(models).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        name: 'deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        agentReferenced: true,
      },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, agentReferenced: true },
    ])
  })

  it('preserves an explicit supportsImages=false and omits undisclosed fields', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['plain', 'bare'] }],
        models: [{ id: 'plain', supportsImages: false }, { id: 'bare' }],
      },
    })
    expect(models[0]?.supportsImages).toBe(false)
    expect(models[1]).toEqual({ id: 'bare', name: 'bare', agentReferenced: true })
  })

  it('returns an empty list for malformed payloads', () => {
    expect(parseModelsFromConfig(null)).toEqual([])
    expect(parseModelsFromConfig({})).toEqual([])
    expect(parseModelsFromConfig({ data: {} })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'craft' }] } })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'nope', models: ['a'] }] } })).toEqual([])
  })

  it('displayNameForModel falls back to the raw id', () => {
    expect(displayNameForModel('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(displayNameForModel('some-unknown-model')).toBe('some-unknown-model')
  })

  // ── 计费倍率（credits）解析 ──
  //
  // 真实形态（2026-09-19 实测 /v3/config）：`data.models[].credits` 是
  // **字符串** `"x0.29"`，早期 scoped 端点会带 ` credits` 后缀，无倍率信息时
  // 是空串或字段缺失。归一化必须宽容这些退化形态，但**绝不编造**倍率。
  describe('计费倍率解析', () => {
    it('normalizeCreditsRate 提取 x<数字> 前缀并容忍后缀', () => {
      expect(normalizeCreditsRate('x0.29')).toBe('x0.29')
      expect(normalizeCreditsRate('x1.62')).toBe('x1.62')
      // 早期 scoped 端点真实形态。
      expect(normalizeCreditsRate('x0.03 credits')).toBe('x0.03')
      expect(normalizeCreditsRate('  x0.5  ')).toBe('x0.5')
    })

    it('normalizeCreditsRate 对无倍率信息返回 undefined 而非编造', () => {
      expect(normalizeCreditsRate('')).toBeUndefined()
      expect(normalizeCreditsRate(undefined)).toBeUndefined()
      expect(normalizeCreditsRate(null)).toBeUndefined()
      expect(normalizeCreditsRate(0.29)).toBeUndefined()
      // 非法形态不得被强行解析成 "x0"。
      expect(normalizeCreditsRate('free')).toBeUndefined()
      expect(normalizeCreditsRate('0.29')).toBeUndefined()
    })

    it('credits 字段写入 creditsRate（字符串，非数字）', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['deepseek-v4.1-flash', 'bare'] }],
          models: [
            { id: 'deepseek-v4.1-flash', credits: 'x0.03 credits' },
            { id: 'bare' },
          ],
        },
      })
      expect(models[0]?.creditsRate).toBe('x0.03')
      // 无 credits 的模型不带该字段（而非 undefined 占位）。
      expect(models[1]).not.toHaveProperty('creditsRate')
    })

    it('parsePromotions 按 modelIds 关联并跳过已结束的 0x 活动', () => {
      const promotions = parsePromotions({
        modelPromotions: [
          {
            kind: 'discount', enabled: true, priority: 100,
            discount: { discountedCredits: '0.50x' },
            modelIds: ['deepseek-v4-flash'],
          },
          {
            // 活动已结束的占位形态：必须被当成「无促销」，
            // 否则用户会误以为免费。
            kind: 'discount', enabled: true, priority: 100,
            discount: { discountedCredits: '0x' },
            modelIds: ['kimi-k3-1'],
          },
          {
            kind: 'discount', enabled: false, priority: 100,
            discount: { discountedCredits: '0.10x' },
            modelIds: ['glm-5.3'],
          },
        ],
      })
      expect(promotions.get('deepseek-v4-flash')).toBe('x0.50')
      expect(promotions.has('kimi-k3-1')).toBe(false)
      expect(promotions.has('glm-5.3')).toBe(false)
    })

    it('parsePromotions 同模型多活动时取 priority 最高者', () => {
      const promotions = parsePromotions({
        modelPromotions: [
          { enabled: true, priority: 10, discount: { discountedCredits: '0.10x' }, modelIds: ['m'] },
          { enabled: true, priority: 999, discount: { discountedCredits: '0.90x' }, modelIds: ['m'] },
          { enabled: true, priority: 100, discount: { discountedCredits: '0.50x' }, modelIds: ['m'] },
        ],
      })
      expect(promotions.get('m')).toBe('x0.90')
    })

    it('促销价随模型一起下发', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['deepseek-v4-flash'] }],
          models: [{ id: 'deepseek-v4-flash', credits: 'x0.17' }],
          modelPromotions: [
            { enabled: true, priority: 100, discount: { discountedCredits: '0.50x' }, modelIds: ['deepseek-v4-flash'] },
          ],
        },
      })
      expect(models[0]?.creditsRate).toBe('x0.17')
      expect(models[0]?.discountedCreditsRate).toBe('x0.50')
    })

    it('formatCreditsRate 在有促销时用箭头标出促销价', () => {
      expect(formatCreditsRate('x0.03', undefined)).toBe('x0.03')
      expect(formatCreditsRate('x0.17', 'x0.50')).toBe('x0.17→x0.50')
      expect(formatCreditsRate(undefined, 'x0.50')).toBe('x0.50')
      expect(formatCreditsRate(undefined, undefined)).toBeUndefined()
    })

    /**
     * ⚠️ 真实缺陷（用户报障）：「codebuddy 的倍率显示也是没折扣的，
     * GLM-5.2 是 0.5，现在好像显示 0.79；hy4 preview 夜间 0，现在显示 0.29」。
     *
     * 三个独立根因：
     * ① scoped 端点**不下发** `modelPromotions`，而它被优先返回 →
     *    促销永远不显示（见 buddy-oauth.ts 的合并逻辑）；
     * ② `discountedCredits: "0x"` 被当成「活动已结束」丢弃 ——
     *    实际它是**夜间免费**（`factor: 0`）；
     * ③ 完全没读 `schedule`，同一模型有夜间/白天两条互补活动时
     *    按 priority 恒定取夜间那条 → 白天也显示折扣价。
     */
    it('促销必须按 schedule 判定此刻是否生效（真实缺陷回归）', () => {
      // 真实 /v3/config 的 glm-5.2 两条活动（互补时段，夜间带折扣、白天只带角标）
      const record = {
        modelPromotions: [
          {
            id: 'glm-52-night', enabled: true, priority: 100, modelIds: ['glm-5.2'],
            discount: { discountedCredits: '0.50x', factor: 0.5 },
            schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' },
          },
          {
            id: 'glm-52-day', enabled: true, priority: 50, modelIds: ['glm-5.2'],
            schedule: { daily: [{ start: '7:50', end: '23:00' }], timezone: 'Asia/Shanghai' },
          },
        ],
      }
      // 夜间（跨零点窗口内）→ 有折扣
      expect(parsePromotions(record, new Date('2026-09-21T00:43:00+08:00')).get('glm-5.2')).toBe('x0.50')
      expect(parsePromotions(record, new Date('2026-09-21T07:49:00+08:00')).get('glm-5.2')).toBe('x0.50')
      expect(parsePromotions(record, new Date('2026-09-21T23:30:00+08:00')).get('glm-5.2')).toBe('x0.50')
      // 白天 → **不应**显示夜间折扣价（否则用户按折扣价预期却被按原价计费）
      expect(parsePromotions(record, new Date('2026-09-21T08:00:00+08:00')).has('glm-5.2')).toBe(false)
      expect(parsePromotions(record, new Date('2026-09-21T12:00:00+08:00')).has('glm-5.2')).toBe(false)
    })

    it('factor: 0 且有窗口 = 免费（不是「已结束」，真实缺陷回归）', () => {
      // 真实 hy4-preview：夜间免费（用户报障「夜间 0，现在显示 0.29」）
      const record = {
        modelPromotions: [{
          enabled: true, priority: 100, modelIds: ['hy4-preview'],
          discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
          schedule: { daily: [{ start: '23:00', end: '08:00' }], timezone: 'Asia/Shanghai' },
        }],
      }
      expect(parsePromotions(record, new Date('2026-09-21T00:43:00+08:00')).get('hy4-preview')).toBe('免费')
      expect(parsePromotions(record, new Date('2026-09-21T12:00:00+08:00')).has('hy4-preview')).toBe(false)
    })

    it('无时间窗口的 0x 仍视为「已结束」占位', () => {
      // 免费额度必然限时；没有窗口的 0x 更可能是遗留占位，照显会让用户误以为免费。
      const promotions = parsePromotions({
        modelPromotions: [{
          enabled: true, priority: 100, modelIds: ['m'],
          discount: { discountedCredits: '0x', factor: 0 },
        }],
      })
      expect(promotions.has('m')).toBe(false)
    })

    it('有效期已过的活动不展示（hy3 限时免费）', () => {
      const record = {
        modelPromotions: [{
          enabled: true, priority: 200, modelIds: ['hy3'],
          discount: { discountedCredits: '0x', factor: 0 },
          schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-08-06T00:00:00+08:00' },
        }],
      }
      // 活动期内
      expect(parsePromotions(record, new Date('2026-07-20T12:00:00+08:00')).get('hy3')).toBe('免费')
      // 已过期 → 必须不展示，否则用户按免费预期却被计费
      expect(parsePromotions(record, new Date('2026-09-21T12:00:00+08:00')).has('hy3')).toBe(false)
    })

    it('时区不可解析时不误杀活动（宁可多显示一次）', () => {
      const record = {
        modelPromotions: [{
          enabled: true, priority: 100, modelIds: ['m'],
          discount: { discountedCredits: '0.50x', factor: 0.5 },
          schedule: { daily: [{ start: '23:00', end: '08:00' }], timezone: 'Not/AZone' },
        }],
      }
      // 时区非法 → 回退「视为生效」，而不是让活动凭空消失
      expect(parsePromotions(record, new Date('2026-09-21T12:00:00+08:00')).get('m')).toBe('x0.50')
    })
  })
})
