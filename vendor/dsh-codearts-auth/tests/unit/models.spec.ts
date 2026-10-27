import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodeArtsRemoteModels, isCodeArtsBenefitModel, isRemoteCatalogComplete,
  loadBenefitCache, loadModelsCache,
  OPENGW_GATEWAY_CONFIG_URL, saveBenefitCache, saveModelsCache, setBenefitMemoryCache,
  SNAP_MODEL_BUILTIN_URL,
} from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

/** 构造一份最小可用凭据。 */
function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

/** 按 URL 路由返回不同响应的 mock fetch；记录每次请求的 URL 与头。 */
function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchCodeArtsRemoteModels', () => {
  it('requests the /v1/model/builtin endpoint (not the old statistics/plugin)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'openpangu-2.0-flash', model_name: 'openpangu-2.0-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall).toBeDefined()
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    expect(models).toContainEqual({ id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' })
  })

  it('sends Agent-Type: PromptCenter and X-Language: zh-cn on the builtin request (unsigned headers)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall?.headers.get('Agent-Type')).toBe('PromptCenter')
    expect(snapCall?.headers.get('X-Language')).toBe('zh-cn')
    expect(snapCall?.headers.get('Content-Type')).toBe('application/json')
  })

  it('parses builtinModels[] (not the old model_metrics field)', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          // 旧字段已废弃，不应被解析
          model_metrics: [{ model_id: 'OLD-SHOULD-NOT-APPEAR', model_name: 'old' }],
          builtinModels: [
            { model_id: 'GLM-5.2-ArkTS-SPARK', model_name: 'GLM-5.2 ArkTS SPARK' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2 ArkTS SPARK' })
    expect(models.find((m) => m.id === 'OLD-SHOULD-NOT-APPEAR')).toBeUndefined()
  })

  it('filters out VL (vision) multimodal models from the builtin list', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'something-VL', model_name: 'something-VL' },
            { model_id: 'glm-5.2-sft-harmony', model_name: 'glm-5.2-sft-harmony' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('something-VL')
  })

  it('merges opengw gateway/config benefit models with builtin models, deduped', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
            ],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // benefit 模型
    expect(ids).toContain('glm-5.3-flash')
    // 日期后缀被 normalizeModelId 去掉
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).not.toContain('deepseek-v4-flash-0731')
    // 常规模型
    expect(ids).toContain('GLM-5.2')
    // 去重：glm-5.3-flash 只出现一次
    expect(ids.filter((id) => id === 'glm-5.3-flash')).toHaveLength(1)
  })

  it('returns empty array when credential lacks AK/SK', async () => {
    const { fetcher, calls } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const models = await fetchCodeArtsRemoteModels(cred, fetcher)
    expect(models).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

/**
 * ★ **各来源成败上报**（issue IKJVTF 复审，审计 I3）。
 *
 * CodeArts 的目录来自**两个**独立端点，失败路径都是 `fetchSignedGet`
 * **静默返回 undefined**。故「一个成功、一个失败」时 `models.length > 0`，
 * 旧判据（适配器只看长度）会判成「已拿到目录」⇒ **永久缓存** ⇒ 残缺目录固化，
 * 只有重启 DSH 才能恢复。
 *
 * ⚠️ 完整性判据必须是「**请求成功且形状可识别**」，不是「解析出非空列表」：
 * 上游把某个来源的模型**全部下架**时，`result.models: []` / `builtinModels: []`
 * 是**合法**状态 —— 把它当失败会让冷却永不清理。
 */
describe('fetchCodeArtsRemoteModels 的各来源成败（★ IKJVTF I3）', () => {
  const GATEWAY_BODY = JSON.stringify({
    result: { models: [{ model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' }] },
  })
  const BUILTIN_BODY = JSON.stringify({
    builtinModels: [{ model_id: 'GLM-5.2', model_name: 'GLM-5.2' }],
  })

  it('★ 两个端点都成功 ⇒ gatewayOk + builtinOk 皆为 true（完整）', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models.length).toBeGreaterThan(0)
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: true })
    expect(isRemoteCatalogComplete(outcome)).toBe(true)
  })

  it('★ gateway 成功 + builtin 失败（404）⇒ **不算完整**', async () => {
    // `makeFetcher` 对未登记路由回 404 ⇒ builtin 走 `!response.ok` 分支。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    // 目录**非空**（gateway 那一份拿到了）—— 旧判据据此判成「完整」。
    expect(models.length).toBeGreaterThan(0)
    // ★ 但完整性必须是 false，否则残缺目录被永久缓存。
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: false })
    expect(isRemoteCatalogComplete(outcome)).toBe(false)
  })

  it('★ builtin 成功 + gateway 失败 ⇒ **不算完整**（镜像格）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models.length).toBeGreaterThan(0)
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: true })
    expect(isRemoteCatalogComplete(outcome)).toBe(false)
  })

  it('★ 两个端点都失败 ⇒ 两者皆 false', async () => {
    const { fetcher } = makeFetcher({})
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models).toEqual([])
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: false })
  })

  it('★ 形状可识别但**合法为空**（两边都是空数组）⇒ 仍算**取到了**（完整）', async () => {
    // 「上游把模型全撤」与「端点挂掉」在**是否有内容**上都表现为空，
    // 但在**形状**上可区分。本层的取舍：形状可识别即算取到，
    // 由**适配器**的 `models.length === 0` 决定「不落缓存」。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: JSON.stringify({ result: { models: [] } }) },
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: true })
  })

  it('★ 形状不可识别（HTTP 200 + 错误 JSON）⇒ **不算取到**', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: JSON.stringify({ unexpected: true }) },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    // gateway 的 `extractJsonArray(['result','models'])` 拿不到数组 ⇒ 不算取到
    expect(outcome.gatewayOk).toBe(false)
    expect(outcome.builtinOk).toBe(true)
  })

  it('★ 无 AK/SK（早退）⇒ 两者皆 false（不能默认成 true）', async () => {
    const { fetcher } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const outcome = { gatewayOk: true, builtinOk: true }
    await fetchCodeArtsRemoteModels(cred, fetcher, outcome)
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: false })
  })

  it('不传 outcome ⇒ 行为与既有完全一致（返回数组）', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models.map((m) => m.id)).toContain('glm-5.3-flash')
    expect(models.map((m) => m.id)).toContain('GLM-5.2')
  })
})

/**
 * benefit 模型判定与缓存。
 *
 * 真实缺陷（用户报障，对齐 deveco-code-rust fb1b4a2）：`deepseek-v4.1-flash`
 * 是 benefit（免费额度）模型，调用必须带 `maas_type: benefit`，而早期实现把该
 * 集合**硬编码**为只有 `glm-5.3-flash` → 发消息后调用失败。
 */
describe('isCodeArtsBenefitModel', () => {
  let cacheDir: string
  const originalDir = process.env.DSH_CODEARTS_CACHE_DIR

  beforeEach(() => {
    // 隔离磁盘缓存：否则会读到真实用户缓存（~/.cache/deveco），断言不稳定
    cacheDir = mkdtempSync(join(tmpdir(), 'codearts-benefit-'))
    process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
    setBenefitMemoryCache(undefined)
  })

  afterEach(() => {
    setBenefitMemoryCache(undefined)
    if (originalDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
    else process.env.DSH_CODEARTS_CACHE_DIR = originalDir
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('兜底集合覆盖 gateway/config 的 benefit 模型', () => {
    // 必须判定为 benefit（否则 404 not registered）
    expect(isCodeArtsBenefitModel('glm-5.3-flash')).toBe(true)
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('不把非 benefit 模型误判为 benefit（带 maas_type 会被拒）', () => {
    // deepseek-v4-flash / -pro 尤其关键：gateway 返回的是其带日期后缀形态
    // （-0731 / -0813），归一化后落到这两个 id，绝不能连带标成 benefit。
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'GLM-5.2', 'GLM-5.1', 'glm-5.3-flash-0101']) {
      expect(isCodeArtsBenefitModel(model), `${model} 不是 benefit 模型`).toBe(false)
    }
  })

  it('远端拉取所得集合是超集：新增 benefit 模型无需改代码', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'brand-new-benefit-model', model_name: 'brand-new-benefit-model' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(isCodeArtsBenefitModel('brand-new-benefit-model')).toBe(true)
    // 兜底集合在远端集合存在时依然生效（两者取并集语义）
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('落盘的 benefit 集合不含归一化改写过的 id', async () => {
    // deepseek-v4-flash-0731 在 gateway 中是 benefit，但 normalizeModelId 会把
    // 它改写成 deepseek-v4-flash 后再发出，而两者在后端是不同模型、benefit
    // 属性相反 —— 记录改写后的 id 会让无后缀模型多带 maas_type 而失败。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const saved: unknown = JSON.parse(readFileSync(join(cacheDir, 'codearts_benefit_models.json'), 'utf-8'))
    expect(saved).toEqual(['deepseek-v4.1-flash'])
    expect(isCodeArtsBenefitModel('deepseek-v4-flash')).toBe(false)
  })

  it('缓存读写往返：ESM 下 require 不可用的回归', () => {
    // 真实缺陷（2026-09-23）：本包是 ESM（package.json "type": "module"），
    // 而缓存读写曾用 `require('node:fs')` —— 在 ESM 下它未定义、抛
    // ReferenceError 并被 catch 吞掉，于是「写不进、也读不回」，
    // benefit 判定恒回退静态兜底、模型列表磁盘缓存恒失效。
    saveBenefitCache(['glm-5.3-flash', 'brand-new-benefit-model'])
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache()).toEqual(['glm-5.3-flash', 'brand-new-benefit-model'])
    // 远端新增的 benefit 模型经磁盘缓存生效（无需改代码）
    expect(isCodeArtsBenefitModel('brand-new-benefit-model')).toBe(true)
    // 兜底集合仍生效（并集语义）
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('模型列表缓存读写往返（同一 require 缺陷）', () => {
    saveModelsCache([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    expect(loadModelsCache()).toEqual([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
  })
})
