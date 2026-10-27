/**
 * opencode 思考档位（issue IKJJ0V）。
 *
 * ## 问题
 *
 * models.dev 的 opencode 条目里 **88/115** 个模型带 `reasoning_options`，但本插件
 * 此前只采了 `reasoning: boolean`、**完全没声明** `resolveModel().reasoning`
 * ⇒ DSH 的思考强度选择器**永不出现**（与 AGENTS.md §2.2 记录的 Qoder 同型缺陷）。
 *
 * ## 契约依据
 *
 * `dsh-api-session-controller/lib/types/catalog.js` 直接把适配器返回值映射成
 * 客户端目录：
 * ```js
 * reasoning: resolved.reasoning === undefined ? undefined : {
 *   efforts: resolved.reasoning.efforts.map(e => ({ id: e.id, name: e.name, ... })),
 *   ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: … }),
 * }
 * ```
 * 客户端**直接渲染** `efforts[].name`（不本地化）⇒ `name` 必须是中文。
 */
import { describe, expect, it } from 'vitest'
import { buildOpencodePayload } from '../../src/opencode-messages.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const capability = readFileSync(join(here, '../../src/opencode-capability.ts'), 'utf8')
const adapter = readFileSync(join(here, '../../src/opencode-adapter.ts'), 'utf8')
const messages = readFileSync(join(here, '../../src/opencode-messages.ts'), 'utf8')

describe('采集 reasoning_options（issue IKJJ0V）', () => {
  it('⚠️ 采 values 数组并保序（值就是上游认的 id）', () => {
    expect(capability).toMatch(/reasoning_options\?: unknown/)
    expect(capability).toMatch(/option\.type === 'effort' && Array\.isArray\(option\.values\)/)
    expect(capability).toMatch(/out\.push\(v\)/)
  })

  it('⚠️ toggle 形态 → [none, low]（只能开/关）', () => {
    // models.dev 实测有 {"type":"toggle"} 形态（如 ling-3.0-flash-fin-free）
    expect(capability).toMatch(/option\.type === 'toggle'/)
    expect(capability).toMatch(/out\.push\('none', 'low'\)/)
  })

  it('⚠️ budget_tokens 形态不声明（DSH 的 efforts 表达不了预算制）', () => {
    expect(capability).toMatch(/budget_tokens.*刻意不处理/s)
  })

  it('⚠️ reasoning 布尔与 efforts 一致（避免空选择器）', () => {
    // reasoning:true 但 efforts:[] ⇒ UI 出现一个没有任何档位的空选择器
    expect(capability).toMatch(/reasoning: entry\.reasoning === true && efforts\.length > 0/)
  })
})

describe('resolveModel 声明 reasoning', () => {
  it('⚠️ 必须用 ReasoningEffortId 品牌类型（与 Qoder 同款）', () => {
    expect(adapter).toMatch(/id: ReasoningEffortId\(effort\)/)
  })

  it('⚠️ 档位为空时不声明本字段（不是 efforts: []）', () => {
    expect(adapter).toMatch(/capability\.efforts\.length > 0/)
    // 判据要精确：`efforts: []` 作为**类型标注**是合法的（inputModalitiesOf
    // 的返回类型就含它），真正要防的是**运行时**给 resolveModel 下发空数组。
    // 故只看「赋值给 resolved.reasoning 的那一段」，不按行号切片。
    const at = adapter.indexOf('resolved.reasoning = {')
    expect(at, '应能找到 reasoning 赋值处').toBeGreaterThan(-1)
    const body = adapter.slice(at, at + 700)
    expect(body).not.toMatch(/efforts:\s*\[\]/)
    // 且该段必须以 `capability.efforts.map(...)` 产出（长度 > 0 才进来）
    expect(body).toMatch(/capability\.efforts\.map/)
  })

  it('⚠️ name 用官方中文，无中文则回退 id（不猜译名）', () => {
    expect(capability).toMatch(/EFFORT_NAMES\[id\] \?\? id/)
    // models.dev 会下发 Qoder 那份表里没有的 minimal / xhigh
    expect(capability).toMatch(/minimal: '最小'/)
    expect(capability).toMatch(/xhigh: '极高'/)
  })

  it('⚠️ defaultEffort 刻意不下发（models.dev 无 is_default 字段）', () => {
    expect(adapter).toMatch(/defaultEffort.*刻意不下发/s)
    expect(adapter).not.toMatch(/defaultEffort:\s*capability/)
  })
})

describe('档位必须真的发出去（否则只是 UI 装饰）', () => {
  it('⚠️ payload 带 reasoning_effort', () => {
    expect(messages).toMatch(/reasoning_effort: input\.reasoningEffort/)
    expect(messages).toMatch(/reasoningEffort\?: string/)
  })

  it('⚠️ 适配器把 options.reasoningEffort 传进 payload（品牌类型转字符串）', () => {
    // ⚠️ 断言的是**接线意图**（用户选的档位一路到达 payload），不是某一行字面量：
    // issue IKKVDH 之后中间多了一层 `titlePlan`（它会为标题请求挑选关闭档），
    // 故这里必须容忍该层存在 —— 钉死旧表达式会让每次接线重构都假失败。
    // 两段分别对应「源头取 options.reasoningEffort」与「终点写进 payload」。
    expect(adapter).toMatch(/requestedEffort:[^,]*options\.reasoningEffort/)
    expect(adapter).toMatch(/reasoningEffort:\s*titlePlan\.effort/)
  })

  it('⚠️ none（关闭思考）照发 —— toggle 形态就产出这一档', () => {
    expect(buildOpencodePayload({ model: 'big-pickle', messages: [], reasoningEffort: 'none' }).reasoning_effort).toBe('none')
  })
})

describe('磁盘缓存版本', () => {
  it('⚠️ 缓存文件有版本号，且格式变化时必须升版', () => {
    // ⚠️ 2026-10-17：能力表的磁盘缓存已**上移并改名**为共享的
    // `models-dev.json`（`src/models-dev-cache.ts` 是全仓唯一直读点）。
    // 这条不变式**本身没变** —— 旧版本缓存必须被识别出来，否则字段缺失会被
    // 静默当成「没有该字段」，症状是「改了没用，重启才好」（issue IKJJ0V）。
    // ⇒ 判据跟着职责走，打在共享缓存模块上。
    const cache = readFileSync(join(here, '../../src/models-dev-cache.ts'), 'utf8')
    expect(cache, '共享缓存必须带版本号').toMatch(/const CACHE_VERSION = \d+/)
    expect(cache, '读缓存时必须比对版本号（否则旧文件被当成有效数据）').toMatch(/version === CACHE_VERSION/)
    // ⚠️ 旧实现是 `version: 2` 的字面量；新实现不得退回「不带版本」。
    expect(capability).not.toMatch(/version: 2/)
  })
})
