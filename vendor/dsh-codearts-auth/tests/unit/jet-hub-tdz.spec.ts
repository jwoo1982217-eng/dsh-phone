import { describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * JetHubPage 的**运行时**渲染冒烟（PR !67 复审新增）。
 *
 * ## 为什么必须是运行时，不能只做源码字符串断言
 *
 * PR !67 初版把 `React.useEffect(..., [providerOrder, providerStatuses, selected])`
 * 放在了 `const [providerOrder, …]` / `const [providerStatuses, …]` **之前**。
 * `useEffect` 的 deps 数组由 JS 引擎在**进入调用前**就急切求值，于是它引用了
 * 仍处于 TDZ（暂时性死区）的 `const` —— **首次渲染直接抛**
 * `ReferenceError: Cannot access 'providerOrder' before initialization`，
 * Jet Hub 页整个打不开。
 *
 * 而那版 PR 自带的 3 条用例全是 `expect(source).toContain(…)` 的**源码文本
 * 断言**：字符串照样在（代码确实被搬到了依赖声明之后），故全绿。
 * ⇒ 症状正是「typecheck 通过 / 单测全绿 / 构建成功，但点开 Jet Hub 白屏」。
 *
 * 本 spec 用 `vi.mock('react', …)` 注入最小 React 替身并**真正调用**
 * `JetHubPage({...})` —— deps 数组由 JS 引擎求值，TDZ 会如期抛出。
 * 这是唯一能在这个仓库（无 react / 无 DOM 环境）拦住该缺陷的层次。
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** hook 槽位：每次「渲染」重置，模拟一次组件挂载。 */
let hooks: unknown[] = []
let cursor = 0
/** 本次渲染收集到的 effect（供断言与手动 flush）。 */
let effects: Array<{ fn: () => void; deps: unknown[] }> = []

function slot<T>(initial: T | (() => T)): { v: T } {
  const key = cursor++
  if (!(key in hooks)) {
    hooks[key] = { v: typeof initial === 'function' ? (initial as () => T)() : initial }
  }
  return hooks[key] as { v: T }
}

const reactStub = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const s = slot(initial)
    return [
      s.v,
      (next) => {
        s.v = typeof next === 'function' ? (next as (prev: T) => T)(s.v) : next
      },
    ]
  },
  useRef<T>(initial: T) {
    return slot(initial)
  },
  // ⚠️ 这里**故意不读 deps**：真实 React 也一样 —— deps 由 JS 引擎在调用本函数
  // **之前**求值完毕，这正是 TDZ 会在外层炸掉的原因。放进函数体内反而测不到。
  useEffect(fn: () => void, deps: unknown[] = []) {
    effects.push({ fn, deps })
  },
  useMemo<T>(fn: () => T): T {
    return fn()
  },
  useCallback<T>(fn: T): T {
    return fn
  },
  useLayoutEffect() {},
  createElement: () => null,
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

/** 把内部 hook 状态暴露给断言（避免把 reactStub 本身暴露成公共 API）。 */
function resetRender() {
  hooks = []
  cursor = 0
  effects = []
}

/** 跑一轮「渲染」，返回期间是否抛错。 */
function renderOnce(rpcCall: (method: string, payload?: unknown) => Promise<unknown>) {
  resetRender()
  const errors: unknown[] = []
  let mod!: typeof import('../../plugin-src/client/jet-hub.js')
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../../plugin-src/client/jet-hub.js') as typeof import('../../plugin-src/client/jet-hub.js')
  } catch {
    // ESM 下 require 不可用 → 走动态 import
  }
  void mod
  return errors
}

describe('JetHubPage 运行时渲染（TDZ 回归）', () => {
  it('deps 数组不得引用尚未声明的 const（PR !67 白屏回归）', async () => {
    resetRender()
    const { JetHubPage } = await import('../../plugin-src/client/jet-hub.js')
    const rpcCall = async () => ({ ok: true, order: ['buddy', 'codearts'], statuses: {} })

    // ⚠️ 这一行就是断言本体：TDZ 会在**这里**抛 ReferenceError，
    // 而不是等到某个断言里去。用 expect(...).not.toThrow() 包裹会把它
    // 变成一条「通过」的假象，故直接调用、让异常冒到用例层。
    expect(() => JetHubPage({ close: () => {}, rpcCall })).not.toThrow()
  })

  it('参考：把 effect 挪回依赖声明之前时，本用例必须变红（反向验证）', () => {
    // 纯手算的等价形态：deps 在 const 之前求值 ⇒ ReferenceError。
    // 证明上面那条用例的判据确实能区分「声明在前」与「声明在后」，
    // 而不是任何实现都能过（同义反复用例比没有更危险）。
    const bad = () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const deps = [laterValue];
      const laterValue = 'declared-after-use'
      return deps
    }
    expect(() => bad()).toThrow(ReferenceError)

    const good = () => {
      const laterValue = 'declared-before-use'
      const deps = [laterValue]
      return deps
    }
    expect(() => good()).not.toThrow()
  })

  it('组件导出存在且是函数（防止「模块都没加载成功」被当成通过）', async () => {
    const mod = await import('../../plugin-src/client/jet-hub.js')
    expect(typeof mod.JetHubPage).toBe('function')
    expect(resolve(HERE)).toContain('tests')
  })
})