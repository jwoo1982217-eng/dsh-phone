/**
 * 「目标收下请求却零输出」的判据与改道（Gitee issue IKJW31 的 B 方案）。
 *
 * ## 它防的是什么
 *
 * A 方案（`LOOMY_CONTEXT_WINDOW_OVERRIDES`）修的是**已知的那一个**虚报窗口。
 * 「声明的窗口比真实墙大」是上游通病 ⇒ 下一家虚报时症状原样复现：宿主按虚高
 * 窗口打包，越墙后上游**收下请求但 0 输出** + `finish_reason=length`，插件映射
 * 成 `max-tokens`，而 DSH 对它**不自动重试** ⇒ 整轮静默失败。
 *
 * ## 两条必须守住的边界（方向相反，缺一条就会引入新缺陷）
 *
 * | 形态 | 期望 | 守错方向的代价 |
 * |---|---|---|
 * | `max-tokens` + **零输出** | **改道**下一个 provider | 不改 ⇒ 静默失败（本 issue） |
 * | `max-tokens` + **有输出** | **绝不改道**，原地透出 | 改 ⇒ **丢掉已产出的正文** |
 *
 * 第二行是本改动的最大风险点：`max-tokens` 的常见含义恰恰是「正常答到半截撞了
 * 输出上限」，那时换目标是**数据丢失**。故本文件里那条反向用例与正向用例同等重要。
 */
import { describe, expect, it } from 'vitest'
import {
  ZERO_OUTPUT_COOLDOWN_MS,
  emptyZeroOutputProbe,
  isTargetCoolingDown,
  isZeroOutputWallHit,
  noteChunk,
  noteZeroOutputHit,
  producedVisibleOutput,
  zeroOutputKey,
} from '../../src/zero-output-guard.js'

/** 用一串 chunk 喂累加器（复刻 `dispatch` 的消费方式）。 */
function probeOf(chunks: Array<{ type: string; reason?: { kind?: string } }>) {
  return chunks.reduce((acc, chunk) => noteChunk(acc, chunk), emptyZeroOutputProbe())
}

describe('zero-output-guard：判据（纯函数）', () => {
  it('★ max-tokens + 零输出 ⇒ 判定为撞墙', () => {
    expect(isZeroOutputWallHit(probeOf([
      { type: 'usage' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]))).toBe(true)
  })

  it('★★ max-tokens + **有输出** ⇒ 绝不判成撞墙（否则会丢正文）', () => {
    // 这是 `max-tokens` 最常见的含义：模型答到半截撞了输出上限。
    // 若这里判成 true，dispatch 会换 provider 重发 ⇒ 用户看到的正文凭空消失。
    expect(isZeroOutputWallHit(probeOf([
      { type: 'block-start' },
      { type: 'text-delta' },
      { type: 'usage' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]))).toBe(false)
  })

  it('★ 有输出但只是个 block-end（空块收尾）⇒ 仍算有输出', () => {
    // `block-end` 携带权威内容 ⇒ 保守方向是「算有输出」（宁可漏判改道）。
    expect(producedVisibleOutput({ type: 'block-end' })).toBe(true)
    expect(isZeroOutputWallHit(probeOf([
      { type: 'block-end' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]))).toBe(false)
  })

  it('★ 未知 chunk 类型一律算有输出（保守，不误判成空轮）', () => {
    expect(producedVisibleOutput({ type: '未来某个新类型' })).toBe(true)
  })

  it('只有 usage / block-start 不算输出（二者都是元数据）', () => {
    expect(producedVisibleOutput({ type: 'usage' })).toBe(false)
    expect(producedVisibleOutput({ type: 'block-start' })).toBe(false)
  })

  it('★★ finish 本身不算输出（漏了它会让整个守卫恒不触发）', () => {
    // 这是本模块初版的真实缺陷，被首条用例当场抓出：`noteChunk` 先判可见性、
    // 再读 `reason` ⇒ 若 `finish` 算可见内容，则每个终止帧都把 sawOutput 置真
    // ⇒ `isZeroOutputWallHit` **恒为 false**、B 方案静默失效。
    expect(producedVisibleOutput({ type: 'finish' })).toBe(false)
  })

  it('★ 无 max-tokens（正常 stop）⇒ 不判撞墙', () => {
    expect(isZeroOutputWallHit(probeOf([{ type: 'finish', reason: { kind: 'stop' } }]))).toBe(false)
  })

  it('★ error 帧 ⇒ 不判撞墙（有明确错误码，走既有分类，别抢它的活）', () => {
    expect(isZeroOutputWallHit(probeOf([
      { type: 'finish', reason: { kind: 'max-tokens' } },
      { type: 'finish', reason: { kind: 'error' } },
    ]))).toBe(false)
  })

  it('★ aborted ⇒ 不判撞墙（用户取消绝不改道）', () => {
    expect(isZeroOutputWallHit(probeOf([
      { type: 'finish', reason: { kind: 'max-tokens' } },
      { type: 'finish', reason: { kind: 'aborted' } },
    ]))).toBe(false)
  })

  it('累加器是**纯函数式**的：noteChunk 不得改动入参', () => {
    const before = emptyZeroOutputProbe()
    const after = noteChunk(before, { type: 'text-delta' })
    expect(before.sawOutput).toBe(false) // 入参未被污染
    expect(after.sawOutput).toBe(true)
  })
})

describe('zero-output-guard：目标级冷却表', () => {
  it('★ 记录撞击后，冷却期内判为「冷却中」，到期即解除', () => {
    const now = 1_000_000
    const map = noteZeroOutputHit(new Map(), 'loomy', 'spark-x', now)
    expect(isTargetCoolingDown(map, 'loomy', 'spark-x', now)).toBe(true)
    // 边界：恰好到期 ⇒ 已解除（判据取 `>`，与既有 modelRateLimits 一致）
    expect(isTargetCoolingDown(map, 'loomy', 'spark-x', now + ZERO_OUTPUT_COOLDOWN_MS)).toBe(false)
    expect(isTargetCoolingDown(map, 'loomy', 'spark-x', now + ZERO_OUTPUT_COOLDOWN_MS + 1)).toBe(false)
    // 差一毫秒仍在冷却
    expect(isTargetCoolingDown(map, 'loomy', 'spark-x', now + ZERO_OUTPUT_COOLDOWN_MS - 1)).toBe(true)
  })

  it('★ 冷却只作用于**该目标**，不误伤同 provider 的其他模型 / 其他 provider', () => {
    const map = noteZeroOutputHit(new Map(), 'loomy', 'spark-x', 1_000)
    expect(isTargetCoolingDown(map, 'loomy', 'GLM-5.3-Flash', 1_000)).toBe(false)
    expect(isTargetCoolingDown(map, 'zcode', 'spark-x', 1_000)).toBe(false)
  })

  it('★ 键用 NUL 分隔：不得让 `a/b`+`c` 与 `a`+`b/c` 撞成同一个键', () => {
    // 真实可达：cline 的模型 id 形如 `cline-free/deepseek-v4.1-flash`。
    const map = noteZeroOutputHit(new Map(), 'a/b', 'c', 1_000)
    expect(isTargetCoolingDown(map, 'a/b', 'c', 1_000)).toBe(true)
    expect(isTargetCoolingDown(map, 'a', 'b/c', 1_000)).toBe(false)
    expect(zeroOutputKey('a/b', 'c')).not.toBe(zeroOutputKey('a', 'b/c'))
  })

  it('记录是纯函数式的：返回新表，不改入参', () => {
    const before = new Map<string, number>()
    const after = noteZeroOutputHit(before, 'loomy', 'spark-x', 1_000)
    expect(before.size).toBe(0)
    expect(after.size).toBe(1)
  })

  it('冷却时长默认 10 分钟（必须显著短于会话跨度，避免误判永久生效）', () => {
    expect(ZERO_OUTPUT_COOLDOWN_MS).toBe(10 * 60 * 1000)
  })
})
