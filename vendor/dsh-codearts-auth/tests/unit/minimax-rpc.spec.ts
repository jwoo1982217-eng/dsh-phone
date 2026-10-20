import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MINIMAX } from '../../src/minimax-product.js'

/**
 * Task 6（接线）的回归防线。
 *
 * ⚠️ 本任务是**接线**：真正的行为验证靠 `pnpm typecheck`（接线漏一处即
 * 类型错或实参数量不符）与全量单测。完整 RPC 行为测试要构造 cordis Context
 * 与账号池替身，成本高且**既有九个 provider 也未对 RPC 层做单测** ——
 * 遵循既有惯例，不为本 provider 单独引入。
 *
 * 但接线类改动有一个**类型检查抓不到**的失效模式：接线点**漏接**或**串接**
 * （改错 provider 常量、忘了在某个分派表加一行）。故这里用源码断言锁住
 * 「每个分派点都真的有 minimax」—— 这类断言在既有仓库里已有先例
 *（见 `tests/unit/raccoon-client-independence.spec.ts` 等同型防线）。
 */
describe('RPC 分派常量', () => {
  it('⚠️ provider id 是 minimax（分派靠它匹配）', () => {
    expect(MINIMAX.id).toBe('minimax')
  })

  it('⚠️ 默认凭据 ref 是 POSIX 标识符（credentialRef 会做正则校验）', () => {
    expect(MINIMAX.defaultCredentialRef).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })
})

describe('接线点完整性（源码断言）', () => {
  const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  const rpcSource = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8')

  /**
   * 剥掉行注释与块注释后再断言。
   *
   * ⚠️ **必须剥**：本仓库的注释里经常**逐字写出反模式**（例如
   * 「不是 `available.id` / `available.credentialRef`」），若不剥离，
   * 针对反模式的 `not.toMatch` 会命中注释本身而**恒假失败**。
   *（写这条用例时实测踩到。）
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('⚠️ index.ts 六处接线点齐全', () => {
    // 1. import MinimaxAuth
    expect(indexSource).toContain("from './minimax-auth.js'")
    // 2. registerProviderSettings 的 namespace
    expect(indexSource).toContain("'llm-minimax'")
    // 3. 服务实例 + 适配器注册
    expect(indexSource).toContain('new MinimaxAuth(ctx)')
    expect(indexSource).toContain('registerMinimaxLlm(ctx, {')
    // 4. refreshTargets 表
    expect(indexSource).toContain("['minimax', (p) => minimax.refreshAll(p)]")
    // 5. modelAdapters 登记
    expect(indexSource).toMatch(/minimax: pruned\([^)]*,\s*minimaxAdapter\)/)
    // 6. registerJetHubRpc 实参（⚠️ 2026-09-30 合并后 zcode 排在 minimax 之后；
    //    2026-10-03 加 gemini 时按「新 provider 追加在末尾」的惯例排在 zcode 之后）
    expect(indexSource).toMatch(/loomy, raccoon, minimax, zcode, gemini, modelAdapters/)
  })

  it('⚠️ index.ts 的 refresh 回调必须用两层结构（available.entry.*）', () => {
    // 这是「续期静默写不回账号池」的真实缺陷形态：写成 available.id /
    // available.credentialRef 会得到 undefined，UI 永远显示「已过期」。
    const code = stripComments(indexSource)
    const block = code.slice(code.indexOf('const minimax = new MinimaxAuth(ctx)'))
    const refreshPart = block.slice(0, block.indexOf('fetchRemoteModels'))
    expect(refreshPart).toContain('available.entry.credentialRef')
    expect(refreshPart).toContain('available.entry.id')
    // 反向：不得出现裸字段取法（注释已剥离，故命中即真问题）
    expect(refreshPart).not.toMatch(/available\.credentialRef\b/)
    expect(refreshPart).not.toMatch(/available\.id\b/)
  })

  it('⚠️ jet-hub-rpc.ts 四处分支齐全，且都用 MINIMAX.id 分派', () => {
    // account.create / account.refresh / credits.status / credits.claimAll / credits.balances
    expect(rpcSource).toContain('provider === MINIMAX.id')
    expect(rpcSource).toContain('case MINIMAX.id:')
    // 三个 credits 分支
    expect(rpcSource).toContain('fetchMinimaxSigninStatus(credential)')
    expect(rpcSource).toContain('claimMinimaxDailyCheckin(credential)')
    expect(rpcSource).toContain('fetchMinimaxCreditBalance(credential)')
  })

  it('⚠️ 不得把 minimax 分支串到 RACCOON 常量上', () => {
    // 真实缺陷形态：CN 那次「中国版账号的刷新去续了国际版凭据」。
    // 断言 minimax 的 refresh 分支用的是 minimax 实例。
    const code = stripComments(rpcSource)
    const idx = code.indexOf('case MINIMAX.id:')
    expect(idx).toBeGreaterThan(-1)
    const caseBody = code.slice(idx, idx + 400)
    expect(caseBody).toContain('minimax.refreshAccountCredential')
    expect(caseBody).not.toContain('raccoon.refreshAccountCredential')
  })
})
