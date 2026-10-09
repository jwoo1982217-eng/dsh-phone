import { describe, expect, it } from 'vitest'
import { dropPositionFromPointer, orderAfterDrop } from '../../plugin-src/client/account-order.js'

/**
 * 账号拖拽排序的纯逻辑测试。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），但拖拽最容易出错的部分
 * 正是「落点算在哪」—— 把它抽成纯函数后就能用真实断言覆盖，
 * 而不是靠源码级字符串匹配去间接验证。
 */
describe('orderAfterDrop（拖拽落点计算）', () => {
  const IDS = ['a', 'b', 'c', 'd']

  it('把靠前的元素拖到靠后元素之前（目标下标会前移）', () => {
    // 关键用例：移除 a 后 c 的下标从 2 变成 1。
    // 若实现复用原下标 2 插入，会得到 [b, c, a, d]（插到 c 之后）——
    // 与用户看到的插入位置不符。
    expect(orderAfterDrop(IDS, 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('把靠后的元素拖到靠前元素之前', () => {
    expect(orderAfterDrop(IDS, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('插到目标之后', () => {
    expect(orderAfterDrop(IDS, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('拖到首位', () => {
    expect(orderAfterDrop(IDS, 'c', 'a', 'before')).toEqual(['c', 'a', 'b', 'd'])
  })

  it('拖到末位', () => {
    expect(orderAfterDrop(IDS, 'a', 'd', 'after')).toEqual(['b', 'c', 'd', 'a'])
    expect(orderAfterDrop(IDS, 'a', 'd', 'before')).toEqual(['b', 'c', 'a', 'd'])
  })

  /**
   * 相邻元素的两个方向 —— 这组用例正是「区分 before/after」的理由。
   *
   * 只支持 'before' 时，把 a 往下拖一格落在 b 上是**空操作**，
   * 用户会以为拖拽坏了。区分指针落在目标上半/下半即可修复。
   */
  it('相邻元素：往下拖一格（落在下半部 → after）', () => {
    expect(orderAfterDrop(IDS, 'a', 'b', 'after')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('相邻元素：往上拖一格（落在上半部 → before）', () => {
    expect(orderAfterDrop(IDS, 'b', 'a', 'before')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('相邻元素 + before 是空操作（这是为什么需要 after）', () => {
    // 把 a 拖到 b 之前，而 a 本就在 b 之前 → 无变化。
    // 这不是 bug，而是该语义下的正确结果；调用方据此改用 'after'。
    expect(orderAfterDrop(IDS, 'a', 'b', 'before')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('源与目标相同 → null（无需变更）', () => {
    expect(orderAfterDrop(IDS, 'b', 'b')).toBeNull()
    expect(orderAfterDrop(IDS, 'b', 'b', 'after')).toBeNull()
  })

  it('id 不存在 → null', () => {
    expect(orderAfterDrop(IDS, 'zzz', 'a')).toBeNull()
    expect(orderAfterDrop(IDS, 'a', 'zzz')).toBeNull()
  })

  it('不修改入参（纯函数）', () => {
    const input = [...IDS]
    orderAfterDrop(input, 'd', 'a', 'before')
    orderAfterDrop(input, 'a', 'd', 'after')
    expect(input).toEqual(IDS)
  })

  it('结果始终是原集合的一个排列（元素不增不减）', () => {
    // 遍历所有 (source, target, position) 组合，确保任何落点都不会丢元素或重复。
    for (const source of IDS) {
      for (const target of IDS) {
        for (const position of ['before', 'after']) {
          const result = orderAfterDrop(IDS, source, target, position)
          if (result === null) continue
          expect([...result].sort(), `${source}→${target}(${position})`).toEqual([...IDS].sort())
        }
      }
    }
  })

  it('单元素列表无操作', () => {
    expect(orderAfterDrop(['a'], 'a', 'a')).toBeNull()
  })

  it('两元素列表双向拖拽都生效', () => {
    expect(orderAfterDrop(['a', 'b'], 'b', 'a', 'before')).toEqual(['b', 'a'])
    expect(orderAfterDrop(['a', 'b'], 'a', 'b', 'after')).toEqual(['b', 'a'])
  })
})

describe('dropPositionFromPointer（插入方向判定）', () => {
  const RECT = { top: 100, height: 80, bottom: 180 }

  it('落在上半部 → before', () => {
    expect(dropPositionFromPointer(101, RECT)).toBe('before')
    expect(dropPositionFromPointer(139, RECT)).toBe('before')
  })

  it('落在下半部 → after', () => {
    expect(dropPositionFromPointer(141, RECT)).toBe('after')
    expect(dropPositionFromPointer(179, RECT)).toBe('after')
  })

  it('正中间 → before（分界线归上半部，严格大于才算下半）', () => {
    // 用严格 `>` 而非 `>=`：正中间时归上半，语义简单且可预期。
    expect(dropPositionFromPointer(140, RECT)).toBe('before')
  })

  it('rect 缺失或高度为 0 → before（可预期的回退）', () => {
    expect(dropPositionFromPointer(150, null)).toBe('before')
    expect(dropPositionFromPointer(150, { top: 0, height: 0 })).toBe('before')
  })
})
