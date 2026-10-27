import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * client 侧接线守卫（buddy 限时补偿积分面板）。
 *
 * ⚠️ 本仓库的教训：**源码级断言必须锚定片段、并列断言必须用计数**
 * （只断言 includes 在「删掉一处、别处还在」时会假绿）。
 *
 * ⚠️ 核心不变式：**一次性动作只能由用户点击触发**，不得出现在任何自动路径里。
 *    那正是 runExotic 那条铁律在客户端的对应物。
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

describe('buddy 补偿积分面板：渲染门控', () => {
  it('卡片只在 provider === buddy 且已查询到状态时渲染', () => {
    expect(source).toContain("provider === 'buddy' && compensation !== null")
  })

  it('卡片挂在 ProviderPanel 内（抽成 compensationCard 变量）', () => {
    expect(source).toContain('const compensationCard =')
    expect(source, '卡片变量必须被 return 引用，否则抽了等于没抽').toContain('compensationCard,')
  })
})

describe('buddy 补偿积分面板：领取只由用户触发', () => {
  it('★ 恰好 1 处调用 claimCompensation()（计数，不是 includes）', () => {
    const calls = (source.match(/void claimCompensation\(\)/g) ?? []).length
    expect(calls, 'claimCompensation 应恰好由 1 个按钮的 onClick 触发').toBe(1)
  })

  it('★ 该调用点必须在 onClick 里', () => {
    const idx = source.indexOf('void claimCompensation()')
    expect(idx).toBeGreaterThan(-1)
    const back = source.slice(Math.max(0, idx - 200), idx)
    expect(back, 'claimCompensation 必须挂在按钮的 onClick 上').toContain('onClick:')
  })

  it('⚠️ 领取不得出现在挂载 effect 的自动路径里', () => {
    const idx = source.indexOf('mounted.current = true;')
    expect(idx).toBeGreaterThan(-1)
    const seg = source.slice(Math.max(0, idx - 120), idx + 600)
    expect(seg.includes('claimCompensation()'), '挂载 effect 不得自动领取').toBe(false)
  })
})

describe('buddy 补偿积分面板：RPC 接线', () => {
  it('两条 RPC 都被客户端使用（计数）', () => {
    const status = (source.match(/buddy\.compensationStatus/g) ?? []).length
    const claim = (source.match(/buddy\.claimCompensation/g) ?? []).length
    expect(status, 'compensationStatus 至少用于查询与领取前复核').toBeGreaterThanOrEqual(2)
    expect(claim).toBe(1)
  })

  it('挂载时只做只读查询（loadCompensation），不做领取', () => {
    expect(source).toContain('void loadCompensation()')
  })

  it('补偿查询失败不打断账号列表（catch 里只 setCompensation + console）', () => {
    expect(source).toContain('compensation status failed')
  })
})

describe('buddy 补偿积分面板：产品隔离', () => {
  it('⚠️ 不用 workbuddy 的 provider id（那是另一个产品面，未验证）', () => {
    expect(source.includes("provider === 'workbuddy' && compensation"), 'workbuddy 不应共用该卡片').toBe(false)
  })
})
