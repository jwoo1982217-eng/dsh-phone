/**
 * `isCatalogFresh` —— 「这份模型目录够不够新」的**唯一**判据。
 *
 * ⚠️ 本文件判据打在**行为**上（返回值），不锁实现。
 * 理由：它是 9 个适配器共用的判据，若锁死实现细节，会让任何重构都变成假失败。
 */
import { describe, expect, it } from 'vitest'
import {
  CATALOG_REFRESH_INTERVAL_MS,
  isCatalogFresh,
} from '../../src/model-catalog.js'

describe('isCatalogFresh：目录新鲜度判据', () => {
  it('★ 从未成功读过（at=0）⇒ 恒不新鲜', () => {
    expect(isCatalogFresh(0, 1_000_000), '★ at=0 必须判不新鲜（否则兜底表永不更新）').toBe(false)
    expect(isCatalogFresh(undefined, 1_000_000), '★ at=undefined 同义').toBe(false)
  })

  it('★★ 周期内新鲜、超期陈旧（边界严格小于）', () => {
    const at = 1_000_000
    const now = at + CATALOG_REFRESH_INTERVAL_MS
    expect(isCatalogFresh(at, now - 1), '★★ 差 1ms 仍新鲜').toBe(true)
    expect(isCatalogFresh(at, now), '★★ 恰好到期判陈旧（与 TtlCache 的 >= 同口径）').toBe(false)
    expect(isCatalogFresh(at, now + 1), '★★ 超期判陈旧').toBe(false)
  })

  it('★ 周期常量就是 20 分钟（规格 §3.1-1）', () => {
    expect(CATALOG_REFRESH_INTERVAL_MS, '★ 必须是 20 分钟').toBe(1_200_000)
  })

  it('★ ttlMs 可覆盖（供单测与将来分层周期用，本期无生产调用者）', () => {
    expect(isCatalogFresh(0, 5_000, 1_000), '★ 覆盖周期不改变 at=0 的结论').toBe(false)
    expect(isCatalogFresh(1_000, 1_500, 1_000), '★ 覆盖周期生效').toBe(true)
    expect(isCatalogFresh(1_000, 2_000, 1_000), '★ 覆盖周期后到期').toBe(false)
  })

  it('★ at 为未来时刻（时钟回拨）仍判新鲜，不误判成陈旧', () => {
    // ⚠️ 防「NTP 校时把时间往回拨 ⇒ 全部目录被判陈旧 ⇒ 每轮都打上游」。
    expect(isCatalogFresh(2_000_000, 1_000_000), '★ at 在未来不应判陈旧').toBe(true)
  })
})