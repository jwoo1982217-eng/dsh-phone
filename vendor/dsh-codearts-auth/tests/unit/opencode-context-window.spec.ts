/**
 * opencode 的 contextWindow 声明（issue IKJJ68）。
 *
 * ## 问题：采了不用
 *
 * `opencode-capability.ts` 一直采着 models.dev 的 `limit.context`，但
 * `resolveModel()` 读的是 **catalog 条目**的 `contextWindow` —— 它来自
 * Zen `/v1/models`，而该端点**实测只返回 4 个字段**（`id`/`object`/
 * `created`/`owned_by`，85 条全如此），**从不带 `context_window`** ⇒ 恒为 0
 * ⇒ `resolved.context` 整个不声明。
 *
 * ## 后果（issue 描述准确）
 *
 * - 上下文占用指示器不渲染（它读 `model.contextWindow`）；
 * - 自动压缩抛 `TargetPressureConfigError: contextWindow (…) must be a positive
 *   integer`（`dsh-compaction-basic`）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const adapter = readFileSync(join(here, '../../src/opencode-adapter.ts'), 'utf8')
const capability = readFileSync(join(here, '../../src/opencode-capability.ts'), 'utf8')

const resolvedBlock = () => {
  const at = adapter.indexOf('async resolveModel(')
  expect(at, '应能找到 resolveModel').toBeGreaterThan(-1)
  return adapter.slice(at, at + 4200)
}

describe('contextWindow 从能力表取（issue IKJJ68）', () => {
  it('⚠️⚠️ 兜底链是「能力表 → catalog → 不声明」', () => {
    // 关键：catalog 的 contextWindow 恒为 0（Zen 不下发），能力表才是真来源
    expect(adapter).toMatch(/capability\?\.contextWindow \?\? entry\?\.contextWindow \?\? 0/)
  })

  it('⚠️ 未知窗口不编造（0 是不声明，不是「0 的窗口」）', () => {
    expect(resolvedBlock()).toMatch(/if \(contextWindow > 0\)/)
    expect(resolvedBlock()).toMatch(/resolved\.context = \{ contextWindow \}/)
  })

  it('⚠️ 不再只读 entry.contextWindow（那正是 issue 的根因）', () => {
    expect(adapter).not.toMatch(/entry !== undefined && entry\.contextWindow > 0/)
  })

  it('⚠️ catalog 仍解析 context_window（Zen 将来补上就自动生效）', () => {
    // 删掉等于把能力又退回「只能靠能力表」；保留是廉价的向前兼容
    expect(adapter).toMatch(/record\.context_window/)
    expect(adapter).toMatch(/limit\?\.context/)
  })
})

describe('defaultMaxTokens 刻意不下发（issue IKJJ68）', () => {
  it('⚠️ 代码里不得出现 defaultMaxTokens 赋值', () => {
    const body = resolvedBlock()
    expect(body).not.toMatch(/defaultMaxTokens\s*[:=]\s*[^=]/)
  })

  it('⚠️ 注释记录了实测结论（含被推翻的旧说法）', () => {
    const body = resolvedBlock()
    expect(body).toMatch(/刻意不声明 `defaultMaxTokens`/)
    // 「免费通道会拒」已被实测推翻，必须留痕，避免后人照着旧结论改回去
    expect(body).toMatch(/不成立/)
    // 真实理由：每轮按上限走 + space-bunny 的 524288 荒谬
    expect(body).toMatch(/524288/)
  })

  it('⚠️ 能力表侧同步说明（maxOutputTokens 采了但不下发）', () => {
    expect(capability).toMatch(/刻意不下发给 DSH 的 `defaultMaxTokens`/)
    expect(capability).toMatch(/不会被服务端拒绝/)
  })
})
