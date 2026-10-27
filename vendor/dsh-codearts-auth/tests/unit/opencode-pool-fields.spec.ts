import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const types = readFileSync(join(here, '../../src/types.ts'), 'utf8')
const pool = readFileSync(join(here, '../../src/account-pool.ts'), 'utf8')

describe('账号池条目字段', () => {
  it('ProviderAccountEntry 有 opencodeProxy（代理 URL，空 = 直连）', () => {
    expect(types).toMatch(/opencodeProxy\?:\s*string/)
  })
  it('ProviderAccountEntry 有 opencodeFingerprintGeneration（指纹代次）', () => {
    expect(types).toMatch(/opencodeFingerprintGeneration\?:\s*number/)
  })
  it('两个字段都注明仅 opencode provider 使用', () => {
    // ⚠️ 注释在字段**上方**（JSDoc 块），故朝前看而不是往后找。
    for (const field of ['opencodeProxy?: string', 'opencodeFingerprintGeneration?: number']) {
      const at = types.indexOf(field)
      expect(at, `${field} 应存在`).toBeGreaterThan(-1)
      const doc = types.slice(Math.max(0, at - 900), at)
      expect(doc, `${field} 上方注释应说明仅 opencode 使用`).toContain('opencode')
    }
  })
})

describe('账号池读写方法', () => {
  it('提供 setOpencodeProxy / opencodeProxyFor', () => {
    expect(pool).toMatch(/async setOpencodeProxy\(/)
    expect(pool).toMatch(/opencodeProxyFor\(/)
  })
  it('提供 updateOpencodeFingerprintGeneration / ...GenerationFor', () => {
    expect(pool).toMatch(/async updateOpencodeFingerprintGeneration\(/)
    expect(pool).toMatch(/opencodeFingerprintGenerationFor\(/)
  })
  it('⚠️ 代理可写空串（清除代理 → 回到同 IP 策略），不能用 falsy 判据吞掉', () => {
    const start = pool.indexOf('async setOpencodeProxy(')
    const body = pool.slice(start, start + 900)
    expect(body).not.toMatch(/if \(!proxy\)\s*return/)
    // 清除分支必须是「删键」而不是写空串，避免 UI 再读时把空串当成有效地址
    expect(body).toMatch(/delete entry\.opencodeProxy/)
  })
  it('代次只增不减（防乱序回调让被限流的指纹复活）', () => {
    const start = pool.indexOf('async updateOpencodeFingerprintGeneration(')
    const body = pool.slice(start, start + 900)
    expect(body).toMatch(/if \(generation <= current\)\s*return/)
  })
  it('两个写方法都基于最新快照局部合并（不整体替换，防互相覆盖）', () => {
    for (const name of ['async setOpencodeProxy(', 'async updateOpencodeFingerprintGeneration(']) {
      const start = pool.indexOf(name)
      const body = pool.slice(start, start + 900)
      expect(body).toMatch(/this\.readAccounts\(\)/)
      expect(body).toMatch(/\[\.\.\.accounts\]/)
      expect(body).toMatch(/this\.writeAccounts\(next\)/)
    }
  })
  it('读方法对缺失字段返回安全默认值（空串 / 0）', () => {
    /**
     * ⚠️ 2026-10-18（IKLTZ2 修复期间）：原先断言 `opencodeProxy ?? ''`，
     * 而读方法已改为 `asProxyText(entry?.opencodeProxy)` —— 因为该字段来自
     * **用户可编辑的备份文件**，`sanitizeAccounts` 只做 `{...candidate}`
     * 原样透传、不校验形状 ⇒ 池里可能存在 `"opencodeProxy": 12345`，
     * 而下游 `normalizeProxy` 第一句就是 `input.trim()` ⇒ 非字符串会抛
     * `TypeError`，该账号**永久不可用且无自愈**（实测确认）。
     *
     * ⚠️ 判据相应改为「过 `asProxyText`」—— 它才是**降级为直连**的那一格。
     */
    const proxyAt = pool.indexOf('opencodeProxyFor(')
    expect(proxyAt, 'opencodeProxyFor 应存在').toBeGreaterThan(-1)
    const proxyBody = pool.slice(proxyAt, proxyAt + 300)
    expect(proxyBody, '代理读方法必须过 asProxyText（备份脏值会崩在 input.trim()）')
      .toMatch(/asProxyText\(/)
    expect(proxyBody, "不得退回 ?? ''（那对数字脏值同样会崩）").not.toMatch(/\?\? ''/)
    /**
     * ⚠️ **必须切片到方法体内，不能在整份源码上匹配表达式**。
     *
     * 这条断言原先是在整个 `account-pool.ts` 上找
     * `typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0`
     * —— 当时 opencode 的读方法里确实是这段，能命中。
     * 2026-10-08 把归一化抽进 `normalizeOpencodeGeneration`（唯一实现）后，
     * 这段表达式**仍然存在**，但在 **`traeCheckinDeviceGenerationFor`** 里 ——
     * 于是断言继续变绿，而它本该守的 opencode 读方法**已经无人看守**。
     *
     * 这是「全文匹配的源码断言会被同形的别处满足」的典型形状：
     * 抽取/搬移代码时守卫会**静默失效**，不报错、不变红。
     * ⇒ 凡是「守某个具体实现」的源码断言，一律先 `indexOf` 到符号再切片。
     */
    const at = pool.indexOf('opencodeFingerprintGenerationFor(')
    expect(at, 'opencodeFingerprintGenerationFor 应存在').toBeGreaterThan(-1)
    const body = pool.slice(at, at + 600)
    // 归一化不得在这里再写第二份判据，必须调唯一实现。
    expect(body).toMatch(/normalizeOpencodeGeneration\(/)
    expect(body, '不得再内联一份归一化判据（那会与 opencode-auth.ts 分叉）')
      .not.toMatch(/Number\.isFinite/)
  })
})
