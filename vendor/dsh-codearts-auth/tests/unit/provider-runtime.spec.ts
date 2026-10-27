import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearProviderRuntimes,
  expiryOf,
  registerProviderRuntime,
  registeredRuntimeIds,
  runtimeOf,
} from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'

afterEach(() => { clearProviderRuntimes() })

describe('PROVIDER_RUNTIME 注册表', () => {
  it('注册后可按 id 取回', () => {
    const auth = { refreshAccount: vi.fn() }
    registerProviderRuntime({ descriptor: descriptorOf('buddy')!, auth })
    expect(runtimeOf('buddy')?.auth).toBe(auth)
  })

  it('未知 provider 返回 undefined（调用方决定报错措辞）', () => {
    expect(runtimeOf('nope')).toBeUndefined()
  })

  it('⚠️ 重复注册**不抛错**：保留先注册者、跳过本次（fiber 重启竞态）', () => {
    // ⚠️ 初稿这里断言 `toThrow(/already registered/)`，那是**错的**：
    //    宿主重启插件 fiber 时，新 fiber 的同步 apply() 与旧 fiber 的异步
    //    dispose() **交错执行** ⇒ apply() 会在上一轮尚未清理完时再次注册。
    //    那时抛错会让**整个插件加载失败**（本仓库 llm-register-compat.ts 的
    //    模块头记录的实测事故）。⇒ 语义改为「保留现有、跳过本次」。
    const d = descriptorOf('buddy')!
    const first = { refreshAccount: vi.fn() }
    const second = { refreshAccount: vi.fn() }
    expect(registerProviderRuntime({ descriptor: d, auth: first })).toBe(true)
    // 第二次：不抛错，返回 false 表示「跳过了」
    expect(registerProviderRuntime({ descriptor: d, auth: second })).toBe(false)
    // ⚠️ 关键：保留的是**先注册者**（不是后来者）—— 故「先注册者静默失效」不会发生
    expect(runtimeOf('buddy')?.auth).toBe(first)
  })

  it('descriptor 自身被带在 runtime 上（消费方无需二次查 registry）', () => {
    registerProviderRuntime({ descriptor: descriptorOf('cline')! })
    expect(runtimeOf('cline')?.descriptor.id).toBe('cline')
  })

  /**
   * ⚠️ **本用例的证明力只来自反向验证**（本仓库已三次记录该教训）：
   * `registeredRuntimeIds()` 与 Map 的键**当前必然一致**（它就是 `[...keys()]`），
   * 故它从第一次运行起就是绿的。「注册真的进了表」这件事由上面
   * 「注册后可按 id 取回」+「重复注册保留先注册者」两条承担；
   * 本条只锁**顺序与去重**这两个可观察性质，防止有人把它改成排序或 Set 化
   * （诊断输出会因此丢掉「注册顺序」这个排障信息）。
   */
  it('registeredRuntimeIds 按**注册顺序**列出、且不重复（诊断输出用）', () => {
    expect(registeredRuntimeIds()).toEqual([])
    registerProviderRuntime({ descriptor: descriptorOf('zcode')! })
    registerProviderRuntime({ descriptor: descriptorOf('buddy')! })
    registerProviderRuntime({ descriptor: descriptorOf('zcode')! })
    expect(registeredRuntimeIds()).toEqual(['zcode', 'buddy'])
  })

  it('clearProviderRuntimes 清空整表（单测隔离的前提）', () => {
    registerProviderRuntime({ descriptor: descriptorOf('gemini')! })
    expect(runtimeOf('gemini')).toBeDefined()
    clearProviderRuntimes()
    expect(runtimeOf('gemini')).toBeUndefined()
    expect(registeredRuntimeIds()).toEqual([])
  })

  /**
   * ⚠️ **能力域全部可选**：`auth` 缺席即「该 provider 不支持续期」，这是 RPC 层
   * 返回**可读错误文案**（而不是泛化 unsupported）的判据来源。
   *
   * ⚠️ 本用例是**正向形状断言**（「不带 auth 也能注册」应当编译通过且运行成立）
   * —— 它比「写错形状会报错」强：后者在两种签名下都可能被消耗掉。
   */
  it('auth 域可选：不带 auth 也能注册（opencode / aggregate 的形态）', () => {
    expect(registerProviderRuntime({ descriptor: descriptorOf('opencode')! })).toBe(true)
    expect(runtimeOf('opencode')?.auth).toBeUndefined()
  })
})

/**
 * ⚠️ `expiryOf` 是 `expiry` 表的**取值助手**（`src/index.ts` 的注册段用它），
 * 与 `creditsOf` / `onboardingOf` / `authOf` 同款 —— 四处必须同判据。
 *
 * 反向验证：把实现改成下标取值（`table[provider]`）⇒ 下面「原型链键」那条变红。
 */
describe('expiryOf：按 id 取实现，且**不得命中原型链**', () => {
  const table = {
    buddy: { credentialExpiry: async () => 1 },
    trae: { credentialExpiry: async () => 2 },
  }

  it('取到自己的实现（含两个键互不串味）', () => {
    expect(table.buddy).toBe(expiryOf(table, 'buddy'))
    expect(table.trae).toBe(expiryOf(table, 'trae'))
  })

  it('未登记的 id 返回 undefined（调用方据此判「未接入」）', () => {
    expect(expiryOf(table, 'cline')).toBeUndefined()
    expect(expiryOf(table, '')).toBeUndefined()
  })

  it('★ 原型链键不得命中（`constructor` / `toString` / `__proto__` 等）', () => {
    // ⚠️ 用下标或 `in` 时 `table['constructor']` 会取到 `Object` 构造函数 ⇒
    //    调用方以为「这个 provider 有 expiry 域」⇒ 折算时抛不可诊断的 TypeError。
    //    `req.provider` 是外部输入，故这条不是理论风险。
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(expiryOf(table, key), `${key} 不得命中`).toBeUndefined()
    }
  })
})
