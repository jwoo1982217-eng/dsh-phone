import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  allModelsDisabled,
  disablingLeavesNoEnabledAccount,
} from '../../plugin-src/client/account-model-link.js'

/**
 * 「停用账号」与「关闭该 Provider 模型」之间的联动判定。
 *
 * ## 这组用例锁的是什么
 *
 * 门控判据刻意**不看 `enabled`**（「停用只应影响自动选号，与是否已登录无关」），
 * 这是既有整体设计。该设计导致：停用某 provider 的最后一个启用账号后，它的模型
 * **仍留在模型选择器里**。用户明确要求把这件事变成**一次显式选择**，而不是改门控
 * 语义 —— 本模块就是那个选择的判定。
 *
 * 因此两条边界必须锁死：
 * 1. **只在「停用后不再有任何启用账号」时才提示** —— 否则该 provider 还有别的
 *    启用账号时也会弹窗，关掉全部模型纯属误伤；
 * 2. **对已停用账号再点停用不提示**（空操作），否则用户会收到一个无从理解的确认框。
 */
describe('disablingLeavesNoEnabledAccount（停用后是否已无启用账号）', () => {
  const acct = (id, provider, enabled) => ({ id, provider, enabled })

  it('唯一启用账号被停用 → true', () => {
    expect(disablingLeavesNoEnabledAccount([acct('a', 'qoder', true)], 'a', 'qoder')).toBe(true)
  })

  it('还有别的启用账号 → false（不该误伤该 provider 的模型）', () => {
    const list = [acct('a', 'qoder', true), acct('b', 'qoder', true)]
    expect(disablingLeavesNoEnabledAccount(list, 'a', 'qoder')).toBe(false)
  })

  /** 已停用的同 provider 账号不算「启用账号」。 */
  it('其余账号都已停用 → true', () => {
    const list = [acct('a', 'qoder', true), acct('b', 'qoder', false)]
    expect(disablingLeavesNoEnabledAccount(list, 'a', 'qoder')).toBe(true)
  })

  /** 未声明 enabled 的条目按已启用处理（与 sanitizeAccounts 的默认值一致）。 */
  it('其余账号未声明 enabled 时按已启用处理 → false', () => {
    const list = [{ id: 'a', provider: 'qoder', enabled: true }, { id: 'b', provider: 'qoder' }]
    expect(disablingLeavesNoEnabledAccount(list, 'a', 'qoder')).toBe(false)
  })

  /**
   * **只看同一 provider**。
   *
   * 别的 provider 有启用账号与本 provider 的模型是否可用毫无关系 —— 若实现成
   * 「全表还有启用账号就不提示」，多 provider 用户永远不会收到该提示。
   */
  it('其他 provider 的启用账号不影响判定', () => {
    const list = [acct('a', 'qoder', true), acct('b', 'trae', true)]
    expect(disablingLeavesNoEnabledAccount(list, 'a', 'qoder')).toBe(true)
  })

  /** 对已停用账号再点停用是空操作，不提示。 */
  it('目标账号本就已停用 → false', () => {
    expect(disablingLeavesNoEnabledAccount([acct('a', 'qoder', false)], 'a', 'qoder')).toBe(false)
  })

  /** 列表过期（找不到该账号）时不提示：状态未知就不该弹确认框。 */
  it('账号不在列表里 → false', () => {
    expect(disablingLeavesNoEnabledAccount([acct('b', 'qoder', true)], 'a', 'qoder')).toBe(false)
  })

  it('null / 非数组输入不抛错', () => {
    expect(disablingLeavesNoEnabledAccount(null, 'a', 'qoder')).toBe(false)
    expect(disablingLeavesNoEnabledAccount(undefined, 'a', 'qoder')).toBe(false)
    expect(disablingLeavesNoEnabledAccount('nope', 'a', 'qoder')).toBe(false)
  })
})

describe('allModelsDisabled（是否全部已关闭）', () => {
  it('全部关闭 → true', () => {
    expect(allModelsDisabled([{ disabled: true }, { disabled: true }])).toBe(true)
  })

  it('存在已打开 → false', () => {
    expect(allModelsDisabled([{ disabled: true }, { disabled: false }])).toBe(false)
  })

  /** 未声明 disabled 的条目算已打开（与适配器黑名单语义一致）。 */
  it('未声明 disabled 的条目算已打开 → false', () => {
    expect(allModelsDisabled([{ disabled: true }, {}])).toBe(false)
  })

  /**
   * 空列表返回 false：没有模型可谈，「打开全部」也无事可做。
   * 若返回 true，启用账号时会弹出一个「是否打开 0 个模型」的荒谬确认框。
   */
  it('空列表 → false（避免弹出「是否打开 0 个模型」）', () => {
    expect(allModelsDisabled([])).toBe(false)
    expect(allModelsDisabled(null)).toBe(false)
    expect(allModelsDisabled(undefined)).toBe(false)
  })
})

/**
 * 客户端接线守卫（源码级）。
 *
 * 锁住「联动确实接在 toggleAccount 上、两个方向都有、且失败不回滚账号状态」。
 */
describe('toggleAccount 联动接线（源码级回归）', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub.js'),
    'utf8',
  )
  const normalized = source.replace(/\r\n/g, '\n')

  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './account-model-link.js'")
    expect(source).toContain('disablingLeavesNoEnabledAccount')
    expect(source).toContain('allModelsDisabled')
  })

  /**
   * 判定必须在 `account.update` **之前**取。
   *
   * 提交后列表已刷新，「是否还有启用账号」的答案就变成变更后的状态了 ——
   * 那时再判定会得到错误的结论（停用成功后再看，当然"已无启用账号"，
   * 但多账号场景下会误判）。
   */
  it('联动判定在提交 account.update 之前完成', () => {
    const start = normalized.indexOf('const toggleAccount = async')
    expect(start).toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 2600)
    const judgeIndex = body.indexOf('disablingLeavesNoEnabledAccount')
    const callIndex = body.indexOf("rpcCall('account.update'")
    expect(judgeIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(judgeIndex).toBeLessThan(callIndex)
  })

  /** 两个方向都要问用户，而不是静默联动。 */
  it('停用方向与启用方向都有确认，不做静默联动', () => {
    const start = normalized.indexOf('const toggleAccount = async')
    const body = normalized.slice(start, start + 2600)
    expect(body).toContain('是否同时关闭它的全部模型')
    expect(body).toContain('是否同时打开它们')
    // 两个方向各一次 confirm（加上 closeModels / openModels 的条件分支）
    expect(body).toContain('const closeModels = confirm(')
    expect(body).toContain('const openModels = confirm(')
  })

  /** 联动走批量端点，不循环单条端点。 */
  it('联动走 model.setAllDisabled 批量端点', () => {
    const start = normalized.indexOf('const toggleAccount = async')
    const body = normalized.slice(start, start + 2600)
    expect(body).toContain("rpcCall('model.setAllDisabled', { provider, disabled: true })")
    expect(body).toContain("rpcCall('model.setAllDisabled', { provider, disabled: false })")
    expect(body).not.toContain("rpcCall('model.setDisabled'")
  })

  /**
   * 联动失败**不能反噬已经成功的账号变更**。
   *
   * 账号停用/启用已经落盘，此时把整次操作报成失败会让用户以为账号状态没变，
   * 再点一次又因幂等而看似「无效」。故只提示、不回滚。
   */
  it('联动失败只提示、不回滚账号状态', () => {
    const start = normalized.indexOf('const toggleAccount = async')
    const body = normalized.slice(start, start + 2600)
    expect(body).toContain('账号已停用，但关闭模型失败')
    expect(body).toContain('账号已启用，但打开模型失败')
    // 失败分支里不得再次调用 account.update 回滚
    const catchSections = body.split('catch (caught)').slice(1)
    for (const section of catchSections) {
      expect(section.slice(0, 400)).not.toContain("rpcCall('account.update'")
    }
  })

  /**
   * 启用方向只在「此前一个启用账号都没有」时才读模型目录。
   *
   * 否则每次启用账号都会多发一次 `model.list`（Cline 那次的目录有近 500 条），
   * 而绝大多数情况下根本不会触发提示。
   */
  it('启用方向只在首个启用账号时才读模型目录', () => {
    const start = normalized.indexOf('const toggleAccount = async')
    const body = normalized.slice(start, start + 2600)
    expect(body).toContain('const isFirstEnabled =')
    expect(body).toMatch(/if\s*\(isFirstEnabled\)/)
  })
})
