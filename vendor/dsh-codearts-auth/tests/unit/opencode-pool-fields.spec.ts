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
    expect(pool).toMatch(/opencodeProxy \?\? ''/)
    expect(pool).toMatch(/typeof value === 'number' && Number\.isFinite\(value\) && value > 0 \? value : 0/)
  })
})
