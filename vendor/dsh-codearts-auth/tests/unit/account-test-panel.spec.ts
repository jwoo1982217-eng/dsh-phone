/**
 * 「测试」按钮的客户端侧（Jet Hub 账号卡片）回归测试。
 *
 * ## 为什么要有这个文件
 *
 * `credits-capabilities.spec.ts` 已锁住**能力门控**（`supportsAccountTest`）与
 * 「`summarizeTest` 与 `summarizeProbe` 是两个函数」这件事，但那是**文本断言**：
 * 它只能证明「有个叫 summarizeTest 的东西」，证明不了它**算对了**。
 *
 * 而这条链路里每一处都踩过真实的坑：
 *
 * - 汇总文案：`account.test` 的响应是扁平的 `{ modelId, ok, message }`，
 *   没有 `accounts` / `clearedCount`。拿它去喂 `summarizeProbe` 会得到
 *   「没有可重测的限流标记」—— 把「测试失败」误报成「没什么可测的」。
 * - 按钮禁用条件：`onTest` 必须只受 `busy` 约束。若照抄「重测」的
 *   `busy || !hasAnyLimit`，没有限流标记的账号就点不动按钮 —— 而那正是
 *   「测试」存在的全部理由（用户 m03338：「增加测试按钮，真实的发一次请求」）。
 *
 * `jet-hub.js` 顶部 `import * as React from 'react'`，react 是宿主注入的
 * external，测试无法直接 import 该文件（见 `credits-format.js` 顶部注释里
 * 记录的同一个约束）。故这里对源码做**定点抽取**：花括号配对切出目标函数，
 * 交给 `new Function` 编译执行 —— 只有编译不执行，不碰 react / DOM。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const HUB_SOURCE = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 从源码里切出一个具名函数声明。
 *
 * ⚠️ 用花括号配对而不是「找下一个 `}`」：`summarizeTest` 体内有模板字符串，
 * 里面就带 `}`（`${model}`）—— 找第一个 `}` 会切出半截函数，`new Function`
 * 报语法错，而错误信息完全指不到真因。
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `源码里找不到 function ${name}(`).toBeGreaterThan(-1)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的花括号不配对（源码被改坏了？）`)
}

/** 把抽取出来的函数体编译成一个可调用的实例。 */
function loadFunction<T>(name: string): T {
  const body = extractFunction(HUB_SOURCE, name)
  // eslint-disable-next-line no-new-func -- 见文件头：只编译不执行，不碰 react。
  return new Function(`${body}\nreturn ${name}`)() as T
}

/** 去掉注释行，避免注释里的字面量被当成代码命中。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

describe('summarizeTest 的行为', () => {
  const summarizeTest = loadFunction<(res: unknown) => string>('summarizeTest')

  it('成功时报告通过，并带上被测模型名', () => {
    expect(summarizeTest({ modelId: 'gemini-3.8-flash', ok: true })).toBe(
      '测试通过：gemini-3.8-flash 正常返回',
    )
  })

  it('失败时报告未通过，并带上上游给的原始原因', () => {
    expect(summarizeTest({ modelId: 'gemini-3.8-flash', ok: false, message: '仍受限：频率限制' })).toBe(
      '测试未通过：gemini-3.8-flash — 仍受限：频率限制',
    )
  })

  it('失败但没给原因时给一个兜底措辞，不留空', () => {
    // 空字符串会渲染成「测试未通过：xxx — 」，用户以为界面坏了。
    expect(summarizeTest({ modelId: 'm', ok: false })).toBe('测试未通过：m — 仍受限')
    expect(summarizeTest({ modelId: 'm', ok: false, message: '' })).toBe('测试未通过：m — 仍受限')
  })

  it('响应缺字段（undefined / null）也不抛异常', () => {
    // ⚠️ 这是 `summarizeTest` 与 `summarizeProbe` 的**根本分野**：
    // `account.test` 返回扁平对象，没有 `accounts` / `clearedCount`；
    // 拿它喂 `summarizeProbe` 会得到「没有可重测的限流标记」—— 把
    // 「测试失败」误报成「没什么可测的」。
    expect(summarizeTest(undefined)).toBe('测试未通过：未知模型 — 仍受限')
    expect(summarizeTest(null)).toBe('测试未通过：未知模型 — 仍受限')
    expect(summarizeTest({})).toBe('测试未通过：未知模型 — 仍受限')
  })
})

describe('「测试」按钮的接线', () => {
  const code = codeOnly(HUB_SOURCE)

  it('按钮的禁用条件只受 busy 约束，**不**依赖 hasAnyLimit', () => {
    // ⚠️ 核心回归点：照抄「重测」的 `busy || !hasAnyLimit` 会让没有限流标记的
    // 账号点不动按钮 —— 而那正是「测试」存在的全部理由。
    const block = code.slice(code.indexOf('title: TEST_HELP'))
    const head = block.slice(0, block.indexOf('}, \'测试\')'))
    expect(head).toContain('disabled: busy')
    expect(head).not.toContain('hasAnyLimit')
  })

  it('点击走 account.test，而不是 account.retest', () => {
    const start = code.indexOf('const runTestAction')
    expect(start).toBeGreaterThan(-1)
    const body = code.slice(start, code.indexOf('return React.createElement', start))
    expect(body).toContain("rpcCall('account.test'")
    expect(body).not.toContain('account.retest')
  })

  it('结果汇总用 summarizeTest，而不是 summarizeProbe', () => {
    const start = code.indexOf('const runTestAction')
    const body = code.slice(start, code.indexOf('return React.createElement', start))
    expect(body).toContain('summarizeTest(res)')
    expect(body).not.toContain('summarizeProbe(')
  })

  it('测试不改任何限流标记：客户端侧不调清除/写回端点', () => {
    const start = code.indexOf('const runTestAction')
    const body = code.slice(start, code.indexOf('return React.createElement', start))
    expect(body).not.toContain('account.reset')
    expect(body).not.toContain('account.retestAll')
  })

  it('TEST_HELP 点明与「重测」的区别，并交代会消耗额度', () => {
    const start = code.indexOf('const TEST_HELP')
    const decl = code.slice(start, code.indexOf('\n\n', start))
    // 必须说清「不看标记」，否则用户会以为它和「重测」是一回事。
    expect(decl).toContain('不依赖是否存在')
    // 必须交代副作用：真发请求 = 消耗额度，用户有权事先知道。
    expect(decl).toContain('会消耗少量模型额度')
    // 必须交代不写存储，否则用户会担心点了就把标记清了。
    expect(decl).toContain('不修改任何限流标记')
  })
})
