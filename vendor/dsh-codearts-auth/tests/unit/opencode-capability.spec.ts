/**
 * 能力表来源的契约（用户定调：模型能力应根据远端下发的列表）。
 *
 * ## 为什么这组断言重要
 *
 * 我曾把「没实测到」当成「能力不存在」，给所有 opencode 模型硬编码
 * `inputModalities: ['text']` —— 用户发图被拒（真机报障「space-bunny-free
 * 发图片提示不支持图片」），而实测那个模型**接受**图片。
 *
 * 正确口径：**能力主源是远端元数据（models.dev 的 opencode 条目）**，
 * 本地只保留一张极小的「实测校准表」覆盖已知偏差。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const product = readFileSync(join(here, '../../src/opencode-product.ts'), 'utf8')
const capability = readFileSync(join(here, '../../src/opencode-capability.ts'), 'utf8')
const adapter = readFileSync(join(here, '../../src/opencode-adapter.ts'), 'utf8')
const indexSrc = readFileSync(join(here, '../../src/index.ts'), 'utf8')

describe('能力表的数据源', () => {
  it('✅ 指向 models.dev（官方 CLI 同款源），不是 /zen/v1/models', () => {
    expect(product).toMatch(/modelsDevUrl:\s*'https:\/\/models\.dev\/api\.json'/)
    // ⚠️ /zen/v1/models 只有 4 个字段、没有能力信息 —— 不能当能力源
    expect(capability).toMatch(/models\.dev/)
    expect(capability).toMatch(/只返回 4 个字段|不含任何能力信息/)
  })

  it('⚠️⚠️ 拉取有超时（宿主网络异常时 fetch 永不 settle）', () => {
    // 用户报障「一直卡着」：实测 api.json 5.05MB / 1.4s，但宿主网络下
    // fetch 可能永不返回 —— 没有超时会永久悬挂并占住去重位。
    expect(capability).toMatch(/FETCH_TIMEOUT_MS/)
    expect(capability).toMatch(/AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/)
  })

  it('⚠️⚠️ 卡死的上一次拉取不会永久占住去重位', () => {
    expect(capability).toMatch(/refreshingStartedAt > FETCH_TIMEOUT_MS \* 2/)
  })

  it('能力表带磁盘缓存（冷启动直接命中，不下载 5MB）', () => {
    expect(capability).toMatch(/cache\/opencode-capabilities\.json|opencode-capabilities\.json/)
    expect(capability).toMatch(/readFile\(cacheFilePath\(\)/)
    expect(capability).toMatch(/writeFile\(path, JSON\.stringify\(payload\)/)
  })

  it('⚠️ 拉取失败返回旧缓存而不是清空（能力不倒退为空）', () => {
    expect(capability).toMatch(/保留现有缓存继续用/)
  })

  it('免费判定用远端 cost（不再依赖本地硬编码表）', () => {
    expect(capability).toMatch(/cost\?\.input/)
    expect(capability).toMatch(/isFree:\s*isFiniteNumber/)
  })
})

describe('⚠️⚠️ 渲染路径上不得 await 网络（真机事故：模型选择器一直空白）', () => {
  it('适配器只用同步读取，没有任何 await 能力表', () => {
    expect(adapter, 'listModels/resolveModel 里 await 网络 = 模型选择器卡死').not.toMatch(/await\s+loadOpencodeCapabilities/)
    expect(adapter).toMatch(/getOpencodeCapabilitiesSync\(\)/)
  })

  it('提供「同步读」与「后台刷新」两个分离的入口', () => {
    expect(capability).toMatch(/export function getOpencodeCapabilitiesSync/)
    // 后台刷新**返回 void**（fire-and-forget），不是 Promise
    expect(capability).toMatch(/export function refreshOpencodeCapabilities\([\s\S]{0,120}\): void/)
    expect(capability).toMatch(/export function primeOpencodeCapabilities\(\): void/)
  })

  it('⚠️ 同步读取在无缓存时返回空数组（调用方按纯文本兜底）', () => {
    const at = capability.indexOf('export function getOpencodeCapabilitiesSync')
    const body = capability.slice(at, at + 300)
    expect(body).toMatch(/return memory/)
  })

  it('接线层做了「预热 + 刷新后广播目录变更」', () => {
    // 不广播的话 DSH 会一直按「纯文本」渲染，图片能力补不上
    expect(indexSrc).toMatch(/primeOpencodeCapabilities\(\)/)
    expect(indexSrc).toMatch(/refreshOpencodeCapabilities\(/)
    expect(indexSrc).toMatch(/llm\/adapters-updated/)
  })
})

describe('模态播报（本次报障的正面）', () => {
  it('⚠️ 适配器不再硬编码 inputModalities: ["text"]', () => {
    // 旧写法：.map((m) => ({ ..., inputModalities: ['text'] as const }))
    expect(adapter).not.toMatch(/inputModalities:\s*\['text'\]\s*as\s*const/)
  })

  it('listModels / resolveModel 都走能力表', () => {
    expect(adapter).toMatch(/function inputModalitiesOf/)
    expect(adapter).toMatch(/getOpencodeCapabilitiesSync\(\)/)
  })

  it('⚠️ 能力缺失时保守回退 text（声明支持就必须真支持）', () => {
    const at = adapter.indexOf('function inputModalitiesOf')
    const body = adapter.slice(at, at + 700)
    expect(body).toMatch(/supportsOpencodeImage/)
    expect(body).toMatch(/\['text'\]/)
  })

  it('video/audio/pdf 一律降级为 text（DSH 只认 text/image）', () => {
    expect(capability).toMatch(/video \/ audio \/ pdf 一律降级为 text/)
  })
})

describe('实测校准表（保持极小且可核）', () => {
  it('只覆盖与远端不一致的视觉能力', () => {
    const at = capability.indexOf('const MEASURED_IMAGE_OVERRIDES')
    // 截到该 const 的结束（下一个顶层 `}`），不能用 indexOf('}') ——
// 注释里的 `}` 与后面的文档引用会把它截断。
    const body = capability.slice(at, at + 1400)
    // 两条已知偏差：big-pickle 漏报、longcat 多报
    expect(body).toMatch(/'big-pickle':\s*\{\s*image:\s*true/)
    expect(body).toMatch(/longcat-2\.5-preview-free':\s*\{\s*image:\s*false/)
    // ⚠️ 每条都要附实测日期与结论，便于复核
    expect(body).toMatch(/2026-10-02 实测/)
  })

  it('⚠️ 校准表不得无限膨胀（否则又变成第二份硬编码表）', () => {
    const at = capability.indexOf('const MEASURED_IMAGE_OVERRIDES')
    const end = capability.indexOf('}', capability.indexOf('\n', at))
    const body = capability.slice(at, end)
    const entries = (body.match(/image:\s*(true|false)/g) ?? []).length
    expect(entries, '校准条目超过 6 条说明它已变成第二份能力表').toBeLessThanOrEqual(6)
  })

  it('⚠️ 校准表**只含免费模型**（用户定调：不逐个验证付费模型）', () => {
    // 付费模型走账号通道，能力以远端 models.dev 为准即可；逐个实测需要真实
    // 付费调用，且余额/价格变动时结论易过期。
    const FREE = new Set([
      'big-pickle', 'space-bunny-free', 'longcat-2.5-preview-free',
      'mimo-v2.6-flash-free', 'mimo-v2.5-free',
      'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free',
    ])
    const at = capability.indexOf('const MEASURED_IMAGE_OVERRIDES')
    const body = capability.slice(at, at + 1400)
    const ids = [...body.matchAll(/'([a-z0-9.\-]+)':\s*\{\s*image:/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(FREE.has(id), `校准表里的 ${id} 不是免费模型（不该逐个实测付费模型）`).toBe(true)
    }
  })

  it('注释写明「只验证免费模型」这条范围约定', () => {
    const at = capability.indexOf('const MEASURED_IMAGE_OVERRIDES')
    const doc = capability.slice(Math.max(0, at - 1200), at)
    expect(doc).toMatch(/只验证免费模型|只针对免费模型/)
  })
})

describe('图片字节桥接（声明支持就必须真能用）', () => {
  it('⚠️ 适配器实现了 resolveImageUrls 并传 imageUrls 给序列化', () => {
    expect(adapter).toMatch(/private async resolveImageUrls/)
    expect(adapter).toMatch(/serializeMessages\(options\.messages, imageUrls\)/)
  })

  it('⚠️ 模型不支持图片时抛 UNSUPPORTED_CONTENT 而不是静默丢弃', () => {
    const at = adapter.indexOf('private async resolveImageUrls')
    const body = adapter.slice(at, at + 1600)
    expect(body).toMatch(/UNSUPPORTED_CONTENT/)
    expect(body).toMatch(/不支持图片输入/)
  })

  it('⚠️ 附件读失败时给空 Map（让 openai-compat 产出占位而非凭空少块）', () => {
    const at = adapter.indexOf('private async resolveImageUrls')
    const body = adapter.slice(at, at + 2200)
    expect(body).toMatch(/if \(image === undefined\) continue/)
    // 说明写在函数上方的 JSDoc 里（不在函数体内），故单独取注释块
    const doc = adapter.slice(Math.max(0, at - 900), at)
    expect(doc).toMatch(/空 Map/)
    expect(doc).toMatch(/占位/)
  })

  it('接线层传了 readImage', () => {
    const at = indexSrc.indexOf('registerOpencodeLlm(')
    const body = indexSrc.slice(at, indexSrc.indexOf('  // 保证至少有一条匿名通道', at))
    expect(body).toMatch(/readImage:\s*makeReadImage\(ctx\)/)
  })
})
