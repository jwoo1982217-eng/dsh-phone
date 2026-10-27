/**
 * `account-probe` 的**适配器构造**走能力注册表（Task 8）。
 *
 * ## 本文件守什么
 *
 * 旧实现是一条 `else if (provider === …)` 链，**末尾的 `else` 兜底**会把
 * **未登记的 provider** 交给「**华为云 HMAC 签名**的 `CodeArtsAdapter`」去发
 * 别家凭据 —— 探测必然失败，而该 provider 的限流标记（UTC+8 当日 24:00）
 * **永远清不掉**。
 *
 * ⚠️ `src/account-probe.ts` 的注释记录该缺陷**同型复发 4 次**
 * （workbuddy → trae → qoder/qodercn/cline → zcode），根因是「清单靠记忆维护」。
 * ⇒ 本 Task 把它改成**查注册表**：未登记 ⇒ **抛可读错误**，绝不落回 CodeArts。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adapterForProbe } from '../../src/account-probe.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'

afterEach(() => { clearProviderRuntimes() })

describe('account-probe：适配器构造走能力注册表', () => {
  it('① 已注册 probe 的 provider 走它自己的工厂（拿到的是**实例本身**）', () => {
    const sentinel = { marker: 'zcode-probe' }
    const createProbeAdapter = vi.fn(() => sentinel as never)
    registerProviderRuntime({ descriptor: descriptorOf('zcode')!, probe: { createProbeAdapter } })

    const credential = { zcode_jwt: 'j' }
    const got = adapterForProbe('zcode', 'ZCODE_ACCOUNT_X', credential)

    // ⚠️ **2026-10-08 独立复审加强**：原版只断言 `toBe(sentinel)` +
    //    `toHaveBeenCalledWith(<字面量>)`，那证明的是「工厂被调了一次」，
    //    但**证不了透传是原样**（`toHaveBeenCalledWith` 是深比较，
    //    工厂若收到一个内容相同的**副本**也会通过，而生产上凭据必须是同一个对象 ——
    //    适配器会原地改写它）。
    expect(got).toBe(sentinel)
    expect(createProbeAdapter).toHaveBeenCalledTimes(1)
    const [passedRef, passedCredential] = createProbeAdapter.mock.calls[0] as [string, unknown]
    expect(passedRef).toBe('ZCODE_ACCOUNT_X')
    // 引用同一性：不是「长得一样」，是**同一个对象**。
    expect(passedCredential).toBe(credential)
    // ⚠️ 且它**不得**是 CodeArtsAdapter —— 这正是旧 `else` 兜底的缺陷形态。
    expect(got).not.toHaveProperty('signHmacSha256')
  })

  it('② ⚠️ 未注册 probe 的 provider **抛可读错误**，不得落回 CodeArtsAdapter', () => {
    // ⚠️ 这是本 Task 的核心：旧实现落 else 会交给华为云 HMAC 签名的
    //    CodeArtsAdapter 去发别家凭据 —— 探测必然失败、限流标记永远清不掉，
    //    而症状只是「重测按钮点了没用」，极难定位。
    //
    // ⚠️ **样本只能用「生产里也没有登记」的 id**：本用例在
    //    `clearProviderRuntimes()` 之后的**干净注册表**里跑，用任何**生产里已登记**
    //    的家都会让读者以为它不支持重测。这条注释批评过原版用 `cline`
    //   （2026-10-08），随后又用 `minimax` **重犯了一次** —— 而 minimax 在
    //    2026-10-11（issue IKJW32 接上请求级换号 + 冷却）之后也进了 `probeById`，
    //    于是这段「实测它不写 modelRateLimits ⇒ 不需要 probe」成了**错误事实**，
    //    且本文件不 import `probeById` ⇒ 对它零反应。
    //    ⇒ 别再拿真实 provider 当「合法缺项」的例子 —— 现在这种例子**已经不存在**。
    expect(() => adapterForProbe('not-a-registered-provider', 'X_ACCOUNT_X', {}))
      .toThrow(/不支持重测|没有探测适配器/)
  })

  it('③ 完全未知的 provider 同样抛可读错误（不是 TypeError 之类）', () => {
    expect(() => adapterForProbe('never-heard-of-it', 'X', {}))
      .toThrow(/不支持重测|没有探测适配器/)
  })

  it('④ 错误信息**带 provider 名**（否则用户与排查者都不知道是哪个渠道）', () => {
    expect(() => adapterForProbe('open-not-registered', 'X_ACCOUNT_X', {}))
      .toThrow(/open-not-registered/)
  })

  it('⑤ 注册了别的域（但没有 probe）⇒ 仍抛错，不得因「有 runtime」就放行', () => {
    // ⚠️ 真实陷阱：`runtimeOf(provider)` 有值 ≠ 它支持探测。
    //    只注册 `expiry` 而不注册 `probe` 时，必须仍然抛错。
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => 1 },
    })
    expect(() => adapterForProbe('zcode', 'ZCODE_ACCOUNT_X', {})).toThrow(/不支持重测|没有探测适配器/)
  })

  it('⑥ 抛出的错误**不是**来自适配器构造（即它没被构造过）', () => {
    // ⚠️ 上一条只断言「抛了可读错误」——若实现是「先 new CodeArtsAdapter 再抛」，
    //    那条照样绿，而副作用（构造一个真适配器、可能触发它的初始化）已经发生。
    //    这里断言抛错**发生在**构造之前：用一个会在构造时炸的桩来反证。
    const boom = vi.fn(() => { throw new Error('构造器被调用了') })
    registerProviderRuntime({ descriptor: descriptorOf('zcode')!, probe: { createProbeAdapter: boom as never } })
    // 已注册的能正常构造（证明桩本身是可用的）……
    expect(() => adapterForProbe('zcode', 'R', {})).toThrow('构造器被调用了')
    // ……而未注册的必须在**达到构造之前**就抛可读错误（不是上面的构造错误）。
    clearProviderRuntimes()
    expect(() => adapterForProbe('zcode', 'R', {})).toThrow(/不支持重测|没有探测适配器/)
  })
})
