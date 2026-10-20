import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodeArtsRemoteModels, isCodeArtsBenefitModel, loadBenefitCache, loadModelsCache,
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
