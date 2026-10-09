import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const caps = readFileSync(join(here, '../../plugin-src/client/credits-capabilities.js'), 'utf8')
const rpc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

describe('opencode 的用量徽标能力登记（用户报障「只有 opencode 没有显示」）', () => {
  it('⚠️ balance 必须为 true —— false 会让徽标组件直接 return null', () => {
    // 徽标组件第一件事就是 supportsCreditBalance(provider)，为 false 就不渲染。
    // 我曾登记 false（认为 Zen 没有可查余额），那等于**把整个徽标挡死**，
    // 用户看到的是「opencode 没有用量」，而 Zen 明明有额度（402 余额不足）。
    const line = /opencode: Object\.freeze\(\{([^}]*)\}\)/.exec(caps)?.[1] ?? ''
    expect(line, '应能解析出 opencode 的能力登记').toContain('balance')
    expect(line).toMatch(/balance:\s*true/)
  })

  it('dailyCheckin 仍为 false（Zen 没有签到概念，不能谎报）', () => {
    const line = /opencode: Object\.freeze\(\{([^}]*)\}\)/.exec(caps)?.[1] ?? ''
    expect(line).toMatch(/dailyCheckin:\s*false/)
  })

  it('⚠️ 注释里记录了「为什么不用 balance:false」（防后人改回去）', () => {
    const at = caps.indexOf('opencode: Object.freeze(')
    const doc = caps.slice(Math.max(0, at - 1200), at)
    expect(doc).toMatch(/只有 opencode 没有显示|挡死/)
  })
})

describe('opencode 的 credits.balances 分支（路 A：限额状态，不查远端余额）', () => {
  it('分支存在（在 credits.balances 内）', () => {
    const at = rpc.indexOf("case 'credits.balances'")
    expect(at).toBeGreaterThan(-1)
    // 分支必须落在 credits.balances 这个 case 内部，否则永远进不去
    const body = rpc.slice(at, at + 9000)
    expect(body).toMatch(/req\.provider === OPENCODE\.id/)
  })

  it('⚠️ 不发任何网络请求（数据全来自本地 modelRateLimits）', () => {
    const at = rpc.indexOf('req.provider === OPENCODE.id')
    const body = rpc.slice(at, at + 2600)
    expect(body).not.toMatch(/\bfetch\(/)
    expect(body).toMatch(/modelRateLimits/)
  })

  it('语义是「可用通道数」而非伪造的余额', () => {
    const at = rpc.indexOf('req.provider === OPENCODE.id')
    const body = rpc.slice(at, at + 2600)
    expect(body).toMatch(/unit:\s*'通道'/)
    expect(body).toMatch(/const available = account\.enabled && limitedUntil <= now \? 1 : 0/)
  })

  it('⚠️ 不伪造余额数字（注释说明 Zen 无公开余额 API）', () => {
    const at = rpc.indexOf('req.provider === OPENCODE.id')
    const body = rpc.slice(at, at + 1600)
    expect(body).toMatch(/没有公开的余额查询端点|15 个候选路径/)
  })

  it('限额中的通道给出可读原因（复用 error 字段约定）', () => {
    const at = rpc.indexOf('req.provider === OPENCODE.id')
    const body = rpc.slice(at, at + 3200)
    expect(body).toMatch(/限额中/)
    expect(body).toMatch(/已停用/)
  })
})
