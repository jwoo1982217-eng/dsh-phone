import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { bulkButtonState } from '../../plugin-src/client/model-bulk.js'

/**
 * 模型列表「打开全部 / 关闭全部」按钮的可用性判定。
 *
 * 与 `account-order.spec.ts` 同理：组件本身无法在本仓库单测里渲染（react 不在
 * 依赖内），故把最容易写错的判定抽成纯函数。这里要锁的核心是
 * **「已经是目标状态时按钮必须禁用」** —— 否则用户点「打开全部」而全部本来就
 * 开着，会以为按钮失灵（没有任何可见变化）。
 */
describe('bulkButtonState（批量开关按钮可用性）', () => {
  const model = (id: string, disabled: boolean) => ({ id, name: id, disabled })

  it('全部打开时「打开全部」禁用、「关闭全部」可用', () => {
    const state = bulkButtonState([model('a', false), model('b', false)], false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(false)
  })

  it('全部关闭时「关闭全部」禁用、「打开全部」可用', () => {
    const state = bulkButtonState([model('a', true), model('b', true)], false)
    expect(state.openAllDisabled).toBe(false)
    expect(state.closeAllDisabled).toBe(true)
  })

  it('混合状态下两个按钮都可用', () => {
    const state = bulkButtonState([model('a', true), model('b', false)], false)
    expect(state.openAllDisabled).toBe(false)
    expect(state.closeAllDisabled).toBe(false)
  })

  /**
   * 空列表：两个按钮都必须禁用。
   *
   * 「关闭全部」在空列表下尤其危险 —— 若放行，它会写入一个空的黑名单
   * （无副作用但会触发一次广播与落盘），而用户看到的是「点了没反应」。
   */
  it('列表为空时两个按钮都禁用', () => {
    const state = bulkButtonState([], false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })

  /** 批量提交进行中：两个按钮都禁用，避免并发提交互相覆盖。 */
  it('批量提交进行中时两个按钮都禁用', () => {
    const state = bulkButtonState([model('a', true), model('b', false)], true)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })

  /** 列表尚未载入（null）时与空列表同语义，不能抛错。 */
  it('列表尚未载入时两个按钮都禁用', () => {
    const state = bulkButtonState(null, false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })
})

/**
 * 客户端接线守卫（源码级）。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），故与
 * `credits-capabilities.spec.ts` / `jet-hub-rpc.spec.ts` 同法：用源码级断言
 * 锁住「按钮存在、走批量端点、且关闭全部有二次确认」这几件不能退化的事。
 *
 * 这些断言各自对应一个真实会犯的错：
 * - 走单条端点循环 → 30 个模型发 30 次请求 + 30 次目录广播（批量端点白加了）；
 * - 关闭全部没有确认 → 一次误点关掉全部模型，且用户不知道发生了什么；
 * - 批量期间不禁用单条开关 → 并发写入互相覆盖（整体写入语义下必然丢改动）。
 */
describe('ModelListPanel 批量按钮接线（源码级回归）', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub.js'),
    'utf8',
  )
  // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
  const normalized = source.replace(/\r\n/g, '\n')

  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './model-bulk.js'")
    expect(source).toContain('bulkButtonState')
  })

  it('两个按钮都存在且文案正确', () => {
    expect(normalized).toContain('打开全部')
    expect(normalized).toContain('关闭全部')
  })

  /**
   * 必须调用**批量**端点，而不是循环调用单条端点。
   *
   * 这是本功能的核心价值：一次落盘、一次广播。若退化成循环，30 个模型会发
   * 30 次请求并把客户端目录反复刷新 30 次。
   */
  it('走批量端点 model.setAllDisabled，而不是循环调用 model.setDisabled', () => {
    const start = normalized.indexOf('const setAllDisabled')
    expect(start, '缺少 setAllDisabled 处理函数').toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 1600)
    expect(body).toContain("rpcCall('model.setAllDisabled'")
    // 批量路径里不得出现单条端点调用
    expect(body).not.toContain("rpcCall('model.setDisabled'")
  })

  /** 关闭全部必须二次确认：一次误点会关掉全部模型。 */
  it('关闭全部在执行前要求确认', () => {
    const start = normalized.indexOf('const setAllDisabled')
    const body = normalized.slice(start, start + 1600)
    const confirmIndex = body.indexOf('confirm(')
    const callIndex = body.indexOf("rpcCall('model.setAllDisabled'")
    expect(confirmIndex, '关闭全部缺少二次确认').toBeGreaterThan(-1)
    // 确认必须在请求之前，否则等于没确认
    expect(confirmIndex).toBeLessThan(callIndex)
  })

  /** 打开全部**不应**弹确认：它是恢复性操作，弹窗只会碍事。 */
  it('打开全部不要求确认', () => {
    const start = normalized.indexOf('const setAllDisabled')
    const body = normalized.slice(start, start + 1600)
    // 确认分支必须由 disabled 条件包裹（即只有关闭方向才确认）
    expect(body).toMatch(/if\s*\(\s*disabled\s*&&\s*!confirm\(/)
  })

  /** 批量提交期间必须禁用单条开关，避免并发写入互相覆盖。 */
  it('批量进行中禁用单条开关', () => {
    const start = normalized.indexOf('const setAllDisabled')
    const body = normalized.slice(start, start + 1600)
    expect(body).toContain('setBulkBusy(true)')
    expect(body).toContain('setBulkBusy(false)')
    // ModelToggle 的 busy 必须把批量状态也算进去
    expect(normalized).toMatch(/busy:\s*busyIds\.has\(model\.id\)\s*\|\|\s*bulkBusy/)
  })

  /** 失败走顶部提示、保留列表，而不是把整张表替换成错误页。 */
  it('批量失败只提示、不把列表替换成错误页', () => {
    const start = normalized.indexOf('const setAllDisabled')
    const body = normalized.slice(start, start + 1600)
    expect(body).toContain('setToggleError')
    expect(body).not.toContain("setPhase('error')")
  })
})
