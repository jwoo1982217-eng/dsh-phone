import { describe, expect, it } from 'vitest'
import {
  NEVER,
  UNUSABLE,
  pickSoonestProvider,
  priceFactorFromName,
  rankCandidates,
} from '../../src/aggregate-core.js'

describe('pickSoonestProvider（从 auto-adapter 抽出，行为必须不变）', () => {
  it('剔除 UNUSABLE，其余按失效时刻升序', () => {
    expect(pickSoonestProvider([['a', 300], ['b', UNUSABLE], ['c', 100]])).toBe('c')
  })

  it('全部 NEVER 时仍选出一个（NEVER 不是「没选中」的哨兵）', () => {
    expect(pickSoonestProvider([['a', NEVER], ['b', NEVER]])).toBe('a')
  })

  it('全部 UNUSABLE 时返回 undefined', () => {
    expect(pickSoonestProvider([['a', UNUSABLE], ['b', UNUSABLE]])).toBeUndefined()
  })

  it('并列时保留先出现的', () => {
    expect(pickSoonestProvider([['a', 100], ['b', 100]])).toBe('a')
  })
})

describe('priceFactorFromName（必须要求分隔符，否则模型名里的 x 会被当倍率）', () => {
  it('无倍率标注的名字返回 Infinity', () => {
    expect(priceFactorFromName('Spark X2.5')).toBe(Number.POSITIVE_INFINITY)
    expect(priceFactorFromName('GPT-X5')).toBe(Number.POSITIVE_INFINITY)
    expect(priceFactorFromName('Grok x4')).toBe(Number.POSITIVE_INFINITY)
  })

  it('真实倍率标注能解析（含促销箭头，取右侧）', () => {
    expect(priceFactorFromName('DeepSeek V4 Flash 0731 · x3.0')).toBe(3)
    expect(priceFactorFromName('GLM-5-3-Flash · x0.2→x0.1')).toBe(0.1)
  })

  it('「免费」按 0 算', () => {
    expect(priceFactorFromName('SenseNova-6.8-Flash · 免费')).toBe(0)
  })
})

describe('rankCandidates：临期升序 → 同档倍率升序 → 声明顺序兜底', () => {
  it('先按 expires 升序（临期优先）', () => {
    const ranked = rankCandidates([
      { provider: 'a', realId: 'm', expiry: 900, price: 1 },
      { provider: 'b', realId: 'm', expiry: 100, price: 99 },
    ])
    expect(ranked.map((c) => c.provider)).toEqual(['b', 'a'])
  })

  it('expiry 相同时按 price 升序（倍率低的先）', () => {
    const ranked = rankCandidates([
      { provider: 'a', realId: 'm', expiry: 100, price: 0.5 },
      { provider: 'b', realId: 'm', expiry: 100, price: 0.1 },
    ])
    expect(ranked.map((c) => c.provider)).toEqual(['b', 'a'])
  })

  it('完全并列时保持传入顺序（稳定排序）', () => {
    const ranked = rankCandidates([
      { provider: 'a', realId: 'm', expiry: 100, price: 1 },
      { provider: 'b', realId: 'm', expiry: 100, price: 1 },
    ])
    expect(ranked.map((c) => c.provider)).toEqual(['a', 'b'])
  })

  it('UNUSABLE 的候选被剔除', () => {
    const ranked = rankCandidates([
      { provider: 'a', realId: 'm', expiry: UNUSABLE, price: 0 },
      { provider: 'b', realId: 'm', expiry: 200, price: 5 },
    ])
    expect(ranked.map((c) => c.provider)).toEqual(['b'])
  })

  it('不修改传入数组（纯函数）', () => {
    const input = [
      { provider: 'a', realId: 'm', expiry: 900, price: 1 },
      { provider: 'b', realId: 'm', expiry: 100, price: 1 },
    ]
    rankCandidates(input)
    expect(input.map((c) => c.provider)).toEqual(['a', 'b'])
  })
})
