/**
 * `ZcodeAuth.mintCaptcha` 的 captcha 护栏**接线**测试（2026-10-01）。
 *
 * ## 为什么单独一个文件
 *
 * `serial-queue.spec.ts` / `captcha-backoff.spec.ts` 测的是**原语本身**；
 * 本文件测的是「**它们真的被接进了产出路径**」—— 这是两类不同的问题，
 * 而本仓库历史上多次栽在「原语写好了但没接上」上（例如
 * `zcode-upstream.ts` 的 `fetchImpl` 曾是**死参数**：签名有、行为没有）。
 *
 * ## 实测依据
 *
 * `session-eced01ed`（provider=`zcode`）里额度耗尽后连续 12 次失败、
 * 每次重试都重新 mint 一个 captcha。而 DSH 会并发发请求
 * （主回复 + 标题生成 + 压缩），此前**每个都独立 mint** ——
 * 叠加阿里云「同设备每小时 150 次」的默认阈值，撞上限是大概率事件。
 *
 * 官方闭源版把产出链在一条全局 promise 上（`jnn`/`wnn`），
 * 日志为 `zcode-plan verification queue slot acquired`。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { CAPTCHA_CONFIG_TTL_MS } from '../../src/captcha-backoff.js'
import type { ZcodeCredential } from '../../src/zcode.js'

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 构造一个**真实的** cordis Context。
 *
 * ⚠ 不能用手写对象桩：`ZcodeAuth extends Service`，而 `Service` 的构造函数会
 * 调 `ctx.provide(...)`（真实实现，不是可选的）—— 手写桩会在构造期就抛
 * `Cannot read properties of undefined (reading 'provide')`。
 * 既有测试（`zcode-credential-resolution.spec.ts`）同样用 `new Context()`。
 */
function makeCtx(): Context {
  const ctx = new Context()
  // 静音 logger（默认的会往 stdout 打测试噪音）；`credentials` 走真实内存实现。
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  return ctx
}

const CREDENTIAL: ZcodeCredential = {
  zcode_jwt: 'a.b.c',
  device_mid: 'mid',
  source: 'plugin',
}

/**
 * 构造一个 `ZcodeAuth`，并把浏览器换成桩。
 *
 * ⚠ 直接换掉 `captchaBrowser` 私有字段（`as never`）—— 比 mock 整个
 * `ZcodeCaptchaBrowser` 模块更稳（后者会牵动 child_process / CDP 一堆无关依赖）。
 */
function makeAuth(options: {
  mintImpl: () => Promise<{ param: string; interactive: boolean }>
}): { auth: ZcodeAuth; mintCalls: () => number } {
  const auth = new ZcodeAuth(makeCtx(), {
    fetchImpl: (async () => { throw new Error('no network in unit test') }) as never,
    readCredential: () => CREDENTIAL,
  })
  let calls = 0
  ;(auth as unknown as { captchaBrowser: unknown }).captchaBrowser = {
    mintWithOutcome: async () => {
      calls += 1
      return await options.mintImpl()
    },
    mint: async () => 'unused',
    dispose: () => {},
  }
  return { auth, mintCalls: () => calls }
}

describe('ZCode captcha 产出的串行队列（接线验证）', () => {
  it('★ 并发 mintCaptcha 时，**底层产出**同一时刻只有一个在跑', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { auth } = makeAuth({
      mintImpl: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await tick(15)
        inFlight -= 1
        return { param: 'p'.repeat(220), interactive: false }
      },
    })

    /**
     * ⚠ 必须先禁用预取池：池命中时**不会**调底层 mint，
     * 那会让这条用例测不到队列（池与队列是两个独立机制）。
     * 默认已关闭（2026-10-01 翻转），故这里天然走现产路径。
     */
    await Promise.all([
      auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }),
      auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }),
      auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }),
    ])

    // ★ 关键断言：没有队列时这里会是 3。
    expect(maxInFlight).toBe(1)
  })

  it('★ 队列等待可被 abort（否则前面的 mint 挂住会拖死后面全部）', async () => {
    let releaseFirst!: () => void
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let first = true
    const { auth } = makeAuth({
      mintImpl: async () => {
        if (first) {
          first = false
          await blocker
        }
        return { param: 'p'.repeat(220), interactive: false }
      },
    })

    const running = auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' })
    await tick()

    const controller = new AbortController()
    const queued = auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }, { signal: controller.signal })
    await tick()
    controller.abort()

    await expect(queued).rejects.toThrow()
    releaseFirst()
    await running
  })
})

describe('ZCode captcha 的观测（对齐官方 traceless/interactive 计数）', () => {
  it('★ 计数「无感通过」与「被要求交互」，并暴露快照', async () => {
    let interactive = false
    const { auth } = makeAuth({
      mintImpl: async () => ({
        param: 'p'.repeat(220),
        interactive,
      }),
    })

    await auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' })
    interactive = true
    await auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' })

    const snap = auth.captchaObservability()
    expect(snap.tracelessPassed).toBe(1)
    expect(snap.interactiveDisplayed).toBe(1)
    expect(snap.failed).toBe(0)
    // 队列已排空；无冷却（因为都成功了）。
    expect(snap.queuePending).toBe(0)
    expect(snap.cooldownRemainingMs).toBe(0)
  })

  it('★ 产出失败会计数、并最终触发退避（连续失败达阈值）', async () => {
    const { auth } = makeAuth({
      mintImpl: async () => {
        throw new Error('F001')
      },
    })

    // 阈值是 3：前两次只计数，第三次起进入冷却。
    for (let i = 0; i < 3; i += 1) {
      await expect(auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' })).rejects.toThrow()
    }
    const snap = auth.captchaObservability()
    expect(snap.failed).toBe(3)
    expect(snap.failureStreak).toBe(3)
    expect(snap.cooldownRemainingMs).toBeGreaterThan(0)

    /**
     * ★ 冷却中必须在**取池之前**就拒绝 —— 否则池的 prefetch 后台路径
     * 仍会发起 mint，冷却形同虚设。
     */
    await expect(auth.mintCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }))
      .rejects.toThrow(/冷却中/)
  })
})

describe('ZCode captcha 配置缓存（60 秒 TTL，对齐官方 f3）', () => {
  it('★ TTL 常量就是官方的 60 秒', () => {
    expect(CAPTCHA_CONFIG_TTL_MS).toBe(60_000)
  })

  it('无凭据时 fetchCaptchaConfig 返回 undefined（不抛错，由调用方回退兜底值）', async () => {
    const auth = new ZcodeAuth(makeCtx(), {
      fetchImpl: (async () => { throw new Error('no network') }) as never,
      // ⚠ 显式给「读不到凭据」的桩 —— 这是纯插件未登录的正常状态。
      readCredential: () => undefined,
      accountPool: undefined,
    })
    await expect(auth.fetchCaptchaConfig()).resolves.toBeUndefined()
  })
})
