/**
 * 「思考循环中止后自动续跑」的回归测试。
 *
 * ## 真实报障（用户要求，2026-10-04）
 *
 * > 现在病态重复后要我打个「继续」才继续运行，加个自动中断病态重复和自动继续
 * > 会话的功能吧。
 *
 * ## 本文件锁住什么
 *
 * 1. **判据**：只有 `REASONING_LOOP` 才触发续跑（`LlmError` 实例与「码值相同但
 *    换了模块实例」两种形态都要认 —— 后者在宿主/插件各自解析出两份 dsh-llm 时
 *    真实出现，`instanceof` 会静默失效）；
 * 2. **时机**：只在 `idle` 且收件箱空时投递（错误发生时驱动器还在跑，此时排队
 *    的消息不会被唤醒，会烂在收件箱里）；
 * 3. **上限**：连续 N 次（默认 2）后停手并告警，且**别人**投一条消息就清零 ——
 *    语义与「用户自己补一句『继续』之后我们又有预算」一致；
 * 4. **接线**：`index.ts` 真的调了 `installLoopResume(ctx)`（只在模块里写好函数、
 *    没人调用 = 功能不存在，这是本仓库踩过的同型坑）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { REASONING_LOOP_CODE } from '../../src/sse.js'
import {
  LOOP_RESUME_DEFAULT_MAX,
  LOOP_RESUME_FLAG_ENV,
  LOOP_RESUME_MAX_ENV,
  LOOP_RESUME_MAX_LIMIT,
  LOOP_RESUME_PROMPT,
  createLoopResumeController,
  installLoopResume,
  isReasoningLoopFailure,
  resolveLoopResumeMax,
  resolveLoopResumePolicy,
  type LoopResumeAgent,
  type LoopResumeLog,
} from '../../src/loop-recovery.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/** 造一个只会记录投递的假 Agent。 */
function makeAgent(overrides: { id?: string; status?: string; hasPending?: boolean } = {}) {
  const delivered: UserMessage[] = []
  const agent: LoopResumeAgent = {
    id: overrides.id ?? 'session-1',
    status: overrides.status ?? 'idle',
    inbox: { hasPending: overrides.hasPending ?? false },
    followup(message) { delivered.push(message) },
  }
  return { agent, delivered }
}

/** 收集日志的假出口。 */
function makeLog(): LoopResumeLog & { infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  return {
    infos,
    warns,
    info: (message: string) => { infos.push(message) },
    warn: (message: string) => { warns.push(message) },
  }
}

/** 从 user 消息里取出纯文本（本次实现只发一个 text 块）。 */
function textOf(message: UserMessage): string {
  const block = message.content[0] as { type?: string; text?: string } | undefined
  return block?.type === 'text' ? block.text ?? '' : ''
}

/** 循环中止错误（与适配器抛出的形态一致）。 */
function loopError(): LlmError {
  return new LlmError('模型思考陷入病态重复', REASONING_LOOP_CODE)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveLoopResumeMax', () => {
  it('未设置 / 空串 → 默认值', () => {
    expect(resolveLoopResumeMax(undefined)).toBe(LOOP_RESUME_DEFAULT_MAX)
    expect(resolveLoopResumeMax('')).toBe(LOOP_RESUME_DEFAULT_MAX)
    expect(resolveLoopResumeMax('   ')).toBe(LOOP_RESUME_DEFAULT_MAX)
  })

  it('0 是合法值（表示一次都不自动续跑）', () => {
    // ⚠️ 这条是反向保护：写成 `Number(raw) || 默认` 会把合法的 0 静默吞掉。
    expect(resolveLoopResumeMax('0')).toBe(0)
  })

  it('正常数值按原值，容忍空白', () => {
    expect(resolveLoopResumeMax('5')).toBe(5)
    expect(resolveLoopResumeMax(' 5 ')).toBe(5)
  })

  it('超过硬上限则封顶', () => {
    expect(resolveLoopResumeMax('99')).toBe(LOOP_RESUME_MAX_LIMIT)
  })

  it('非法值回默认值，而不是回 0', () => {
    // 拼错 `=abc` 若静默变成「关闭」，用户会以为功能坏了却查不出原因。
    expect(resolveLoopResumeMax('abc')).toBe(LOOP_RESUME_DEFAULT_MAX)
    expect(resolveLoopResumeMax('-1')).toBe(LOOP_RESUME_DEFAULT_MAX)
    expect(resolveLoopResumeMax('3.5')).toBe(LOOP_RESUME_DEFAULT_MAX)
    expect(resolveLoopResumeMax('Infinity')).toBe(LOOP_RESUME_DEFAULT_MAX)
  })
})

describe('resolveLoopResumePolicy', () => {
  it('默认开启、上限为默认值', () => {
    expect(resolveLoopResumePolicy({})).toEqual({ enabled: true, maxResumes: LOOP_RESUME_DEFAULT_MAX })
  })

  it('总开关沿用循环守卫自己的真假语义（显式假值才关）', () => {
    for (const raw of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(resolveLoopResumePolicy({ [LOOP_RESUME_FLAG_ENV]: raw }).enabled).toBe(false)
    }
    for (const raw of ['1', 'true', 'yes', '']) {
      expect(resolveLoopResumePolicy({ [LOOP_RESUME_FLAG_ENV]: raw }).enabled).toBe(true)
    }
  })

  it('上限随环境变量走', () => {
    expect(resolveLoopResumePolicy({ [LOOP_RESUME_MAX_ENV]: '0' }).maxResumes).toBe(0)
    expect(resolveLoopResumePolicy({ [LOOP_RESUME_MAX_ENV]: '4' }).maxResumes).toBe(4)
  })
})

describe('isReasoningLoopFailure', () => {
  it('认出 LlmError 实例', () => {
    expect(isReasoningLoopFailure(loopError())).toBe(true)
  })

  it('别的错误码不算', () => {
    expect(isReasoningLoopFailure(new LlmError('挂了', 'TRANSPORT'))).toBe(false)
    expect(isReasoningLoopFailure(new Error('挂了'))).toBe(false)
  })

  it('码值相同但换了模块实例（两份 dsh-llm）也要认', () => {
    const alien = Object.assign(new Error('模型思考陷入病态重复'), { code: REASONING_LOOP_CODE })
    expect(isReasoningLoopFailure(alien)).toBe(true)
  })

  it('非对象输入不炸', () => {
    expect(isReasoningLoopFailure(undefined)).toBe(false)
    expect(isReasoningLoopFailure(null)).toBe(false)
    expect(isReasoningLoopFailure('REASONING_LOOP')).toBe(false)
    expect(isReasoningLoopFailure({})).toBe(false)
  })
})

describe('createLoopResumeController', () => {
  const policy = { enabled: true, maxResumes: 2 }

  it('循环中止 + idle → 投递一条 kind=user 的继续指令', () => {
    const { agent, delivered } = makeAgent()
    const log = makeLog()
    const controller = createLoopResumeController({ policy, log })

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(true)

    expect(delivered).toHaveLength(1)
    expect(textOf(delivered[0])).toBe(LOOP_RESUME_PROMPT)
    expect(delivered[0].source.kind).toBe('user')
    expect(delivered[0].id).toBeTruthy()
    expect(log.infos.join()).toContain('已自动续跑')
    expect(log.warns).toHaveLength(0)
  })

  it('投递的正文是给模型看的指令：不含 harness 内部词汇，且足够短', () => {
    expect(LOOP_RESUME_PROMPT).toContain('继续未完成的任务')
    for (const internal of ['循环守卫', '去重率', 'REASONING_LOOP', 'token']) {
      expect(LOOP_RESUME_PROMPT).not.toContain(internal)
    }
    // 它每轮都进请求体，长度是成本也是需求（与 cline 报错文案那次同一口径）。
    expect(LOOP_RESUME_PROMPT.length).toBeLessThan(80)
  })

  it('非循环错误不续跑，并清零连续计数', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    controller.observeFailure(agent, new LlmError('网络挂了', 'TRANSPORT'))
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(0)
    expect(controller.attemptsOf(agent.id)).toBe(0)
  })

  it('驱动器还在跑（status=running）时不投递', () => {
    const { agent, delivered } = makeAgent({ status: 'running' })
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(0)
  })

  it('收件箱里已经有人排了活（用户手打了）就不抢', () => {
    const { agent, delivered } = makeAgent({ hasPending: true })
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(0)
  })

  it.each(['nextTurn', 'nextStep'] as const)('现代 SDK 的 %s 队列非空不抢用户消息，清空后恢复', queue => {
    const { agent, delivered } = makeAgent()
    const modern = { ...agent, inbox: { nextTurn: [], nextStep: [], [queue]: [{ id: 'user-pending' }] } }
    const controller = createLoopResumeController({ policy, log: makeLog() })
    controller.observeFailure(modern, loopError())
    expect(controller.observeIdle(modern)).toBe(false)
    expect(delivered).toHaveLength(0)
    modern.inbox[queue] = []
    controller.observeFailure(modern, loopError())
    expect(controller.observeIdle(modern)).toBe(true)
    expect(delivered).toHaveLength(1)
  })

  it('同一次失败只处理一次（幂等）', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(true)
    expect(controller.observeIdle(agent)).toBe(false)
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(1)
  })

  it('连续到达上限后停手并告警（默认 2：投 2 次，第 3 次不投）', () => {
    const { agent, delivered } = makeAgent()
    const log = makeLog()
    const controller = createLoopResumeController({ policy, log })

    for (let round = 1; round <= 3; round += 1) {
      controller.observeFailure(agent, loopError())
      controller.observeIdle(agent)
    }

    expect(delivered).toHaveLength(2)
    expect(controller.attemptsOf(agent.id)).toBe(3)
    expect(log.warns.join()).toContain('已达到自动续跑上限（2 次）')
  })

  it('上限可由策略调成 1 / 0', () => {
    const one = makeAgent()
    const oneController = createLoopResumeController({ policy: { enabled: true, maxResumes: 1 }, log: makeLog() })
    for (let round = 1; round <= 2; round += 1) {
      oneController.observeFailure(one.agent, loopError())
      oneController.observeIdle(one.agent)
    }
    expect(one.delivered).toHaveLength(1)

    const none = makeAgent()
    const noneController = createLoopResumeController({ policy: { enabled: true, maxResumes: 0 }, log: makeLog() })
    noneController.observeFailure(none.agent, loopError())
    expect(noneController.observeIdle(none.agent)).toBe(false)
    expect(none.delivered).toHaveLength(0)
  })

  it('别人投一条消息就清零预算（= 用户自己补了「继续」之后我们重新有额度）', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    controller.observeIdle(agent)
    controller.observeFailure(agent, loopError())
    controller.observeIdle(agent)
    expect(delivered).toHaveLength(2)
    expect(controller.attemptsOf(agent.id)).toBe(2)

    controller.observeInput(agent, { id: 'human-message' })
    expect(controller.attemptsOf(agent.id)).toBe(0)

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(true)
    expect(delivered).toHaveLength(3)
  })

  it('我们自己投的那条不算「别人介入」，不清零', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    controller.observeIdle(agent)
    controller.observeInput(agent, { id: delivered[0].id })
    expect(controller.attemptsOf(agent.id)).toBe(1)
  })

  it('别人介入会取消还没投出的待续跑（用户手打了就不用我们再插一脚）', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    controller.observeInput(agent, { id: 'human-message' })
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(0)
  })

  it('投递抛错时降级为告警，不冒泡、不消耗注入标记', () => {
    const { agent } = makeAgent()
    const log = makeLog()
    const boom = new Error('收件箱关了')
    const controller = createLoopResumeController({
      policy,
      log,
      deliver: () => { throw boom },
    })

    controller.observeFailure(agent, loopError())
    expect(controller.observeIdle(agent)).toBe(false)
    expect(log.warns.join()).toContain('自动续跑投递失败')
    // 没投出去 ⇒ 也不该留下「这条是我投的」标记（否则后续别人的消息会被误判）。
    controller.observeInput(agent, { id: 'human-message' })
    expect(controller.attemptsOf(agent.id)).toBe(0)
  })

  it('forget 清掉该 agent 的状态', () => {
    const { agent, delivered } = makeAgent()
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(agent, loopError())
    controller.forget(agent)
    expect(controller.attemptsOf(agent.id)).toBe(0)
    expect(controller.observeIdle(agent)).toBe(false)
    expect(delivered).toHaveLength(0)
  })

  it('不同 agent 的预算互不干扰', () => {
    const first = makeAgent({ id: 'session-a' })
    const second = makeAgent({ id: 'session-b' })
    const controller = createLoopResumeController({ policy, log: makeLog() })

    controller.observeFailure(first.agent, loopError())
    controller.observeIdle(first.agent)
    controller.observeFailure(first.agent, loopError())
    controller.observeIdle(first.agent)
    controller.observeFailure(first.agent, loopError())
    expect(controller.observeIdle(first.agent)).toBe(false)

    controller.observeFailure(second.agent, loopError())
    expect(controller.observeIdle(second.agent)).toBe(true)
    expect(second.delivered).toHaveLength(1)
  })
})

describe('installLoopResume', () => {
  /** 假 ctx：记录 inject 调用与注册的监听器，便于按事件派发。 */
  function makeCtx() {
    const listeners = new Map<string, Array<(payload: never) => void>>()
    const injected: string[][] = []
    const withoutInitiatorCalls: number[] = []
    let withoutInitiatorDepth = 0
    const log = makeLog()
    const ctx = {
      logger: log,
      inject(services: string[], register: (scope: unknown) => void) {
        injected.push(services)
        register({
          agents: {
            withoutInitiator<T>(operation: () => T): T {
              withoutInitiatorDepth += 1
              withoutInitiatorCalls.push(withoutInitiatorDepth)
              try {
                return operation()
              } finally {
                withoutInitiatorDepth -= 1
              }
            },
          },
          on(name: string, listener: (payload: never) => void) {
            const bucket = listeners.get(name) ?? []
            bucket.push(listener)
            listeners.set(name, bucket)
          },
        })
      },
    }
    function emit(name: string, payload: unknown): void {
      for (const listener of listeners.get(name) ?? []) (listener as (value: unknown) => void)(payload)
    }
    return { ctx, injected, listeners, log, emit, withoutInitiatorCalls }
  }

  it('默认开启时注入 agents 并挂上四个监听', () => {
    const fake = makeCtx()
    installLoopResume(fake.ctx as never)

    expect(fake.injected).toEqual([['agents']])
    expect([...fake.listeners.keys()].sort()).toEqual([
      'agent/disposed', 'agent/error', 'agent/inbox/inserted', 'agent/status',
    ])
  })

  it('端到端派发：agent/error → agent/status(idle) → 投递，且走 withoutInitiator', () => {
    const fake = makeCtx()
    installLoopResume(fake.ctx as never)
    const { agent, delivered } = makeAgent()

    fake.emit('agent/error', { agent, turn: 1, step: 0, error: loopError() })
    fake.emit('agent/status', { agent, status: 'running' })
    fake.emit('agent/status', { agent, status: 'idle' })

    expect(delivered).toHaveLength(1)
    expect(textOf(delivered[0])).toBe(LOOP_RESUME_PROMPT)
    expect(fake.withoutInitiatorCalls).toEqual([1])
  })

  it('总开关关闭（=0）时完全不注入', () => {
    vi.stubEnv(LOOP_RESUME_FLAG_ENV, '0')
    const fake = makeCtx()
    installLoopResume(fake.ctx as never)

    expect(fake.injected).toHaveLength(0)
    expect(fake.log.infos.join()).toContain('自动续跑未启用')
  })

  it('上限设成 0 时同样不注入', () => {
    vi.stubEnv(LOOP_RESUME_MAX_ENV, '0')
    const fake = makeCtx()
    installLoopResume(fake.ctx as never)

    expect(fake.injected).toHaveLength(0)
  })

  it('agent/disposed 后状态被清掉', () => {
    const fake = makeCtx()
    installLoopResume(fake.ctx as never)
    const { agent } = makeAgent()

    fake.emit('agent/error', { agent, turn: 1, step: 0, error: loopError() })
    fake.emit('agent/disposed', { agent })
    fake.emit('agent/status', { agent, status: 'idle' })
    expect(fake.log.infos.join()).not.toContain('已自动续跑')
  })
})

describe('index.ts 的接线', () => {
  it('导入并调用 installLoopResume', () => {
    expect(indexSource).toContain("from './loop-recovery.js'")
    expect(indexSource).toContain('installLoopResume(ctx)')
  })

  it('不把 agents 写进静态 inject（缺席的 profile 会让插件永久 pending）', () => {
    expect(indexSource).toContain("export const inject = ['credentials', 'commands', 'llm']")
  })
})
