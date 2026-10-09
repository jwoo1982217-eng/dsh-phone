import { describe, expect, it, vi } from 'vitest'
import {
  applyModelsDevCatalog,
  makeClineModelsDevLoader,
  parseClineModelsDev,
} from '../../src/cline-models-dev.js'

/**
 * models.dev 目录来源的回归：**图片能力** + **补缺的模型** + **可读名**。
 *
 * ⚠️ fixture 的形状是**实测**的（2026-09-30 本机直连 models.dev）：
 * `cline-pass` provider 块下 18 条模型，各自带 `modalities.input` 与 `limit`。
 *
 * 它同时解释两处用户报障：
 * 1.「支持图片的模型发送不了图片」—— 这份数据没被用上；
 * 2.「cline-pass 部分模型列表不全」—— 网关只下发 14 条，这里多出 4 条。
 */
const REAL_SHAPE = {
  'cline-pass': {
    id: 'cline-pass',
    models: {
      'deepseek-v4.1-flash': {
        name: 'DeepSeek V4.1 Flash',
        modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 384_000 },
      },
      'mimo-v2.6-flash': {
        name: 'MiMo-V2.6-Flash',
        modalities: { input: ['text', 'image', 'audio', 'video'] },
        limit: { context: 1_048_576 },
      },
      'glm-5.3': { name: 'GLM-5.3', modalities: { input: ['text'] }, limit: { context: 1_000_000 } },
      // 网关没下发的 4 条（本插件此前**根本不存在**）
      'kimi-k2.6': { name: 'Kimi K2.6', modalities: { input: ['text', 'image', 'video'] } },
      'glm-5.2': { name: 'GLM-5.2', modalities: { input: ['text'] } },
      'kimi-k2.7-code': { name: 'Kimi K2.7 Code', modalities: { input: ['text', 'image'] } },
      'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', modalities: { input: ['text'] } },
      // 没有 modalities 的条目：仍然入表，但 supportsImage 为 false
      'mystery-model': { name: 'Mystery' },
    },
  },
}

describe('parseClineModelsDev', () => {
  it('读出每条模型的名字 / 窗口 / 图片能力（裸 id 补 cline-pass/ 前缀）', () => {
    const map = parseClineModelsDev(REAL_SHAPE)
    expect(map.get('cline-pass/deepseek-v4.1-flash')).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      supportsImage: true,
    })
    expect(map.get('cline-pass/glm-5.3')).toMatchObject({ name: 'GLM-5.3', supportsImage: false })
    expect(map.get('cline-pass/kimi-k2.6')).toMatchObject({ name: 'Kimi K2.6', supportsImage: true })
  })

  it('已带前缀的 id 原样使用（不重复拼前缀）', () => {
    const map = parseClineModelsDev({
      'cline-pass': { models: { 'cline-pass/minimax-m3': { name: 'MiniMax-M3', modalities: { input: ['text', 'image'] } } } },
    })
    expect(map.get('cline-pass/minimax-m3')?.supportsImage).toBe(true)
    expect(map.has('cline-pass/cline-pass/minimax-m3')).toBe(false)
  })

  /** ⚠️ DSH 的模态词表只有 text/image，audio/video/pdf 必须被夹取掉。 */
  it('只认 image：audio/video/pdf 不算图片能力', () => {
    const map = parseClineModelsDev({
      'cline-pass': { models: { 'audio-only': { name: 'A', modalities: { input: ['text', 'audio', 'video', 'pdf'] } } } },
    })
    expect(map.get('cline-pass/audio-only')?.supportsImage).toBe(false)
  })

  /** ⚠️ **不取 `limit.output`**：那是要写进请求体 `max_tokens` 的值，本仓库有过据印象填大值导致 400 的历史。 */
  it('不把 limit.output 当成 maxTokens（避免下发过大的 max_tokens）', () => {
    const entry = parseClineModelsDev(REAL_SHAPE).get('cline-pass/deepseek-v4.1-flash')
    expect(entry).not.toHaveProperty('maxTokens')
  })

  it('缺 modalities 的条目仍入表（名字可用），但不宣称支持图片', () => {
    const entry = parseClineModelsDev(REAL_SHAPE).get('cline-pass/mystery-model')
    expect(entry?.name).toBe('Mystery')
    expect(entry?.supportsImage).toBe(false)
  })

  it('provider 块也能挂在 providers 下（两种实测形态都认）', () => {
    const map = parseClineModelsDev({
      providers: { 'cline-pass': { models: { 'x-1': { name: 'X', modalities: { input: ['text', 'image'] } } } } },
    })
    expect(map.get('cline-pass/x-1')?.supportsImage).toBe(true)
  })

  it('垃圾输入返回空表而不抛错', () => {
    for (const bad of [undefined, null, 'str', 42, [], {}, { 'cline-pass': {} }]) {
      expect(parseClineModelsDev(bad).size, JSON.stringify(bad)).toBe(0)
    }
  })
})

describe('applyModelsDevCatalog', () => {
  const base = [
    { id: 'cline-free/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash · 免费', isFree: true, supportsImage: true },
    { id: 'cline-pass/mimo-v2.6-flash', name: 'cline-pass/mimo-v2.6-flash', isFree: false },
    { id: 'cline-pass/deepseek-v4.1-flash', name: 'cline-pass/deepseek-v4.1-flash', isFree: false },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'Deepseek v4.1 flash', isFree: false },
  ]

  it('把缺的模型补在该前缀的条目之后（沉到 460 条远端 id 之后就没人看得到了）', () => {
    const dev = parseClineModelsDev(REAL_SHAPE)
    const merged = applyModelsDevCatalog(base, dev)
    const ids = merged.map((m) => m.id)
    // 新补的 4 条都在
    for (const id of ['cline-pass/kimi-k2.6', 'cline-pass/glm-5.2', 'cline-pass/kimi-k2.7-code', 'cline-pass/deepseek-v4-flash']) {
      expect(ids, id).toContain(id)
    }
    // 紧跟在最后一条 cline-pass 之后（而不是整个列表末尾）
    const lastPass = ids.lastIndexOf('cline-pass/deepseek-v4.1-flash')
    expect(ids[lastPass + 1]?.startsWith('cline-pass/')).toBe(true)
  })

  it('网关把 id 当名字下发时，用可读名替换', () => {
    const merged = applyModelsDevCatalog(base, parseClineModelsDev(REAL_SHAPE))
    const pass = merged.find((m) => m.id === 'cline-pass/deepseek-v4.1-flash')!
    expect(pass.name).toBe('DeepSeek V4.1 Flash')
    // ⚠️ 已有可读名的**不覆盖**（策展/其它来源优先）
    const other = merged.find((m) => m.id === 'deepseek/deepseek-v4.1-flash')!
    expect(other.name).toBe('Deepseek v4.1 flash')
  })

  it('补图片能力，但不覆盖已有的显式 false / true', () => {
    const models = [
      { id: 'cline-pass/a', name: 'A', isFree: false, supportsImage: false },
      { id: 'cline-pass/b', name: 'cline-pass/b', isFree: false },
    ]
    const dev = new Map([
      ['cline-pass/a', { id: 'cline-pass/a', supportsImage: true }],
      ['cline-pass/b', { id: 'cline-pass/b', supportsImage: true }],
    ])
    const merged = applyModelsDevCatalog(models, dev)
    expect(merged.find((m) => m.id === 'cline-pass/a')?.supportsImage).toBe(false)
    expect(merged.find((m) => m.id === 'cline-pass/b')?.supportsImage).toBe(true)
  })

  it('补上下文窗口，但不覆盖已有值', () => {
    const models = [
      { id: 'cline-pass/a', name: 'A', isFree: false, contextWindow: 200_000 },
      { id: 'cline-pass/b', name: 'cline-pass/b', isFree: false },
    ]
    const dev = new Map([
      ['cline-pass/a', { id: 'cline-pass/a', supportsImage: false, contextWindow: 1_000_000 }],
      ['cline-pass/b', { id: 'cline-pass/b', supportsImage: false, contextWindow: 1_000_000 }],
    ])
    const merged = applyModelsDevCatalog(models, dev)
    expect(merged.find((m) => m.id === 'cline-pass/a')?.contextWindow).toBe(200_000)
    expect(merged.find((m) => m.id === 'cline-pass/b')?.contextWindow).toBe(1_000_000)
  })

  it('空表时原样返回（不改变目录）', () => {
    expect(applyModelsDevCatalog(base, new Map())).toEqual(base)
  })
})

describe('makeClineModelsDevLoader', () => {
  it('命中 TTL 缓存：多次调用只发一次请求', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(REAL_SHAPE), { status: 200 }))
    const load = makeClineModelsDevLoader({ fetcher: fetcher as never })
    await load()
    await load()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ 失败**必须抛**（而不是返回空表）：调用方据此区分「没读到」与
   * 「读到了且不支持」。把失败记成空表会让图片能力永久打回纯文本 ——
   * 那正是本次要修的缺陷形态。
   */
  it('HTTP 失败向上抛（不缓存失败，下次可重试）', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const load = makeClineModelsDevLoader({ fetcher: fetcher as never })
    await expect(load()).rejects.toThrow(/HTTP 500/)
    await expect(load()).rejects.toThrow(/HTTP 500/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
