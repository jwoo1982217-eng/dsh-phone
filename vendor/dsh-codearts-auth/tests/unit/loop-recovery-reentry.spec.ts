/**
 * 自动续跑的**真实组合**回归（Issue IKLEOW）。
 *
 * ## 为什么单测不够（这是本文件存在的唯一理由）
 *
 * `loop-recovery.spec.ts` 的假 ctx 是**手写的同步 `emit`**：它既不模拟相位切换，
 * 也不模拟重入，故它**结构上无法**发现本缺陷 —— 原始实现「在 `agent/status`
 * 派发栈内同步 `followup()`」在那套假对象上完全正常。
 * issue IKLEOW 正是据此指出单测没抓到，而 `packages/AGENTS.md` 也写明
 * 「Product-visible plugins require a non-unit REAL-composition test」。
 *
 * 本文件因此用**真实的 `@deepseek-ai/dsh-agent-loop`**（连同 session /
 * system-prompt / tools / agent 等真实服务）跑一整轮：
 *
 * 1. 真实驱动器发出 `REASONING_LOOP` 中止 → 真的走到 idle；
 * 2. 本插件的 `installLoopResume(ctx)` 按真实接线挂上监听；
 * 3. 断言**修复后的不变式**：自动续跑唤醒新一轮之后，客户端看到的 running 位
 *    必须与 agent 的真实相位**一致**（否则 Stop 与插话同时失效）。
 *
 * ## 缺陷机制（实测，本机 `0.2.0-rc.2`）
 *
 * `agent.ts` 的 `setPhase()` 是**同步派发**：
 *
 * ```ts
 * private setPhase(next: Phase): void {
 *   const previousStatus = this.status
 *   this.phase = next
 *   const status = this.status
 *   if (status !== previousStatus) this.dispatch.emit('agent/status', { status })
 * }
 * ```
 *
 * `kick()` 的 `finally` 里 `setPhase({kind:'idle'})` 派发 `idle`；若监听器**在该
 * 派发栈内**同步 `agent.followup()`，`wakeDriver()`（相位已 idle）会立刻
 * `setPhase({kind:'running'})` 并**再次同步派发** `running`。一次 idle 转换于是
 * 产生两个方向相反的信号，**最终生效的那个取决于监听器注册顺序**。
 *
 * 实测（两种顺序对照，`agent/status` 记录客户端 running 位）：
 *
 * | 顺序 | running 位序列 | 第 2 次请求开始时 |
 * |---|---|---|
 * | 插件先注册 | `[true,true,false,false]` | `agent=running` 但 `clientRunning=**false**` ← 缺陷 |
 * | session-controller 先注册 | `[true,false,true,false]` | 一致 |
 *
 * ⇒ 因为「哪个信号赢」取决于注册顺序，**两种顺序都必须成立**才叫修好。故本文件
 * 两种顺序各跑一遍（`ORDER_CASES`）。
 *
 * ## 数据来源与跳过条件
 *
 * 真实运行时（`@deepseek-ai/dsh-agent-loop` 等）不在本仓库的 devDependencies 里
 * —— 它们只随 DSH 安装。故按 `jet-hub-styles-ownership.spec.ts` 的既有先例，
 * 从「已安装的 DSH」（全局安装 / 用户 profile）**动态定位并 import**；找不到时
 * **干净 skip**（干净克隆 / CI 属预期）。⚠️ **必须惰性 import** —— 在文件顶层
 * 静态 import 会让缺依赖时的整份套件变成 Failed Suite 而不是 skip。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOP_RESUME_SOURCE_KIND } from '../../src/loop-recovery.js'

const require = createRequire(import.meta.url)

/** 真实组合需要的宿主包（缺任一个就不跑）。 */
const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
] as const

/**
 * 定位一份**同时含有全部宿主包**的 `node_modules` 目录。
 *
 * 搜索顺序（命中即返回）：① 本仓库依赖树；② 全局安装（`npm i -g @deepseek-ai/dsh`）；
 * ③ 用户 profile。
 *
 * ⚠️ 判据是「**全部**包都在」而不是「找到一个」：只按 `dsh-agent-loop` 定位，
 * 可能命中一份缺 `dsh-session` 的残树，于是 import 抛错、用例变 Failed Suite。
 * ⚠️ 本仓库的 `.pnpm` 布局下**每个包各自一个目录**（`@deepseek-ai+dsh-llm@…`），
 * 故「本仓库」那一支永远凑不齐 —— 真正能命中的是**已安装的 DSH**。
 * ⚠️ profile 的宿主包在**共享的 `profiles/node_modules`**（实测本机布局），
 * 不是 `profiles/<名字>/node_modules`；两者都要试，别只写后者。
 *
 * @returns 可用的 node_modules 绝对路径；没有则 `null`。
 */
function locateHostModules(): string | null {
  const candidates: string[] = []
  for (const spec of HOST_PACKAGES) {
    try {
      // `@deepseek-ai/dsh-llm/package.json` → …/node_modules/@deepseek-ai/dsh-llm
      const pkg = require.resolve(`${spec}/package.json`)
      candidates.push(resolve(dirname(pkg), '..', '..'))
    } catch {
      // 未从本仓库解析到，继续看别处
    }
  }
  const globalModules = resolve(dirname(process.execPath), 'node_modules')
  candidates.push(globalModules)
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir()
  const dshHome = process.env['DSH_HOME'] ?? join(home, '.dsh')
  // ⚠️ 共享层在前（本机实测宿主包都在这里），逐 profile 层在后。
  candidates.push(join(dshHome, 'profiles', 'node_modules'))
  for (const profile of ['web', 'desktop', 'tui', 'headless', 'default']) {
    candidates.push(join(dshHome, 'profiles', profile, 'node_modules'))
  }
  for (const root of candidates) {
    if (HOST_PACKAGES.every(pkg => existsSync(join(root, pkg, 'package.json')))) return root
  }
  return null
}

const hostModules = locateHostModules()

/**
 * 从真实安装位置 import 一个宿主包。
 *
 * ⚠️ 用**绝对 file URL + `@vite-ignore`**：这些包在仓库外，Vite 的模块图解析
 * 对它们不适用（`node_modules` 之外的裸标识符解析会失败）。
 *
 * @param pkg - 包名。
 * @returns 该包的模块命名空间。
 */
async function importHost(pkg: string): Promise<Record<string, unknown>> {
  const entry = join(hostModules!, pkg, 'lib', 'index.js')
  return await import(/* @vite-ignore */ pathToFileURL(entry).href) as Record<string, unknown>
}

/** 一次真实组合运行的观测结果。 */
interface RunObservation {
  /** 每次「模型请求真的开始」时，客户端 running 位与 agent 真实相位的对照。 */
  readonly samples: Array<{ call: number; agentStatus: string; clientRunning: boolean }>
  /** `agent/status` 的完整序列（客户端视角的 running 位）。 */
  readonly clientRunningSequence: boolean[]
  /**
   * 每次 `agent/status` 派发时，**是否嵌套在另一次 `agent/status` 派发之内**。
   *
   * ⚠️ **这是本缺陷的机制级判据**（见下）。同步投递会让续跑唤醒的 `running`
   * 派发发生在外层 `idle` 派发**尚未返回**时 ⇒ 该条为 `true`；投递脱离派发栈
   * 之后**全部为 `false`**。
   */
  readonly reentrant: Array<{ status: string; nested: boolean }>
  /** 真实投出并落进会话日志的续跑消息的 source（原样）。 */
  readonly resumeSources: unknown[]
  /** adapter 被调用的次数。 */
  readonly calls: number
  /** 收敛后的 agent 相位。 */
  readonly finalStatus: string
}

/**
 * 用真实 agent-loop 跑一次「循环中止 → 自动续跑 → 收敛」。
 *
 * @param order - 监听器注册顺序：真实 profile 里 `dsh-base`（含 session-controller）
 *   先于本插件，故 `controller-first` 是**线上顺序**；`plugin-first` 是**反向对照**，
 *   用来证明修复与注册顺序无关。
 * @returns 观测结果。
 */
async function runRealComposition(order: 'plugin-first' | 'controller-first'): Promise<RunObservation> {
  const { Context } = await importHost('@deepseek-ai/cordis')
  const llm = await importHost('@deepseek-ai/dsh-llm')
  const session = await importHost('@deepseek-ai/dsh-session')
  const projection = await importHost('@deepseek-ai/dsh-session-projection')
  const systemPrompt = await importHost('@deepseek-ai/dsh-system-prompt')
  const tools = await importHost('@deepseek-ai/dsh-tools')
  const agentReg = await importHost('@deepseek-ai/dsh-agent')
  const agentLoop = await importHost('@deepseek-ai/dsh-agent-loop')
  // 被测的**真实接线**（源码，经 tsx 转译）。
  const { installLoopResume } = await import('../../src/loop-recovery.js')

  /** 第一次请求抛 `REASONING_LOOP`（与适配器的中止形态一致），第二次正常收尾。 */
  const LlmError = llm['LlmError'] as new (message: string, code: string) => Error
  const LlmAdapter = llm['LlmAdapter'] as new () => { stream: (o: unknown) => AsyncIterable<unknown> }
  class LoopAdapter extends LlmAdapter {
    calls = 0
    onCall: (n: number) => void = () => {}
    override async * stream(): AsyncIterable<unknown> {
      this.calls += 1
      this.onCall(this.calls)
      if (this.calls === 1) throw new LlmError('模型思考陷入病态重复，已中止本轮', 'REASONING_LOOP')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'resumed' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'resumed' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const ctx = new Context() as { plugin: (p: unknown, c?: unknown) => Promise<void>; llm: never; agentLoop: never; on: never; fiber: { dispose: () => Promise<void> } }
  await ctx.plugin(llm['default'])
  await ctx.plugin(session['default'])
  await ctx.plugin(projection['default'])
  await ctx.plugin(systemPrompt['default'])
  await ctx.plugin(tools['default'])
  await ctx.plugin(agentReg['default'])
  await ctx.plugin(agentLoop['default'], { agents: [] })

  const adapter = new LoopAdapter()
  ;(ctx as unknown as { llm: { registerAdapter: (r: string[], a: unknown) => void } }).llm
    .registerAdapter(['mock'], adapter)

  const SessionId = session['SessionId'] as (id: string) => unknown
  const agent = await (ctx as unknown as {
    agentLoop: { create: (id: unknown, o: unknown) => Promise<{ id: string; status: string; followup: (m: unknown) => void; whenIdle: () => Promise<void> }> }
  }).agentLoop.create(SessionId(`ikleow-real-${order}`), { provider: 'mock', model: 'mock' })

  const clientRunningSequence: boolean[] = []
  const samples: RunObservation['samples'] = []
  const reentrant: RunObservation['reentrant'] = []
  let clientRunning = false
  /**
   * ⚠️ **重入探测器**：记录「本次 `agent/status` 回调执行期间，是否又有一次
   * `agent/status` 回调进来」。这是区分「派发栈内同步投递（缺陷）」与
   * 「脱离派发栈投递（修复）」的**唯一可靠判据**。
   *
   * 为什么不用「最终 running 位」当判据（第一版就错在这里）：真实运行时里
   * `session-controller` 与插件都只是**普通监听器**，而实测发现外层那条陈旧的
   * `idle` 未必真能覆盖内层 `running`（`setPhase` 只在**状态变化**时才派发，
   * 且嵌套派发结束后相位已是 running，外层再派发 idle 只是把相位改回去）。
   * 我实测过：把调度器换成同步后，「最终 running 位」与「请求开始时的采样」
   * **都不变**（两者都是 `TFTF` / 全 `true`）—— 即那两个断言**恒真**，
   * 是一组同义反复（AGENTS.md 明确警告过这种假守卫）。
   * 而「嵌套」这条判据同步/微任务**明确不同**：
   * 同步 = `[F,F,`**`T`**`,F]`，微任务 = `[F,F,F,F]`。
   */
  let inStatusCallback = false
  /** 模拟 `session-controller`：把 `agent/status` 折成客户端 running 位。 */
  const listen = (payload: { agent: unknown; status: string }): void => {
    if (payload.agent !== agent) return
    reentrant.push({ status: payload.status, nested: inStatusCallback })
    inStatusCallback = true
    clientRunning = payload.status === 'running'
    clientRunningSequence.push(clientRunning)
    // 让出微任务再复位：这样「同步嵌套」与「之后另一次独立派发」被区分开。
    void Promise.resolve().then(() => { inStatusCallback = false })
  }

  // ⚠️ 关键：按被测顺序注册。`plugin-first` 是原始报障里「外层陈旧 idle 覆盖
  // 嵌套 running」的那一支（见文件头表格）。
  if (order === 'plugin-first') {
    installLoopResume(ctx as never)
    ;(ctx as unknown as { on: (n: string, l: (p: never) => void) => void }).on('agent/status', listen as never)
  } else {
    ;(ctx as unknown as { on: (n: string, l: (p: never) => void) => void }).on('agent/status', listen as never)
    installLoopResume(ctx as never)
  }

  adapter.onCall = (n: number) => {
    // 「请求真的开始了」⇔ 新一轮确实在跑。此刻两个信号**必须**一致。
    samples.push({ call: n, agentStatus: agent.status, clientRunning })
  }

  const createUserMessage = llm['createUserMessage'] as (i: unknown) => unknown
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  // 让排定的微任务（自动续跑投递）与随后的一轮跑完。
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await agent.whenIdle()

  const resumeSources = (agent as unknown as {
    session: { snapshotEvents: () => Array<{ type: string; data: { source?: unknown; content?: Array<{ type?: string; text?: string }> } }> }
  }).session.snapshotEvents()
    .filter(e => e.type === 'user/message'
      && (e.data.content ?? []).some(b => b.type === 'text' && (b.text ?? '').includes('继续未完成的任务')))
    .map(e => e.data.source)

  const finalStatus = agent.status
  await ctx.fiber.dispose()
  return { samples, clientRunningSequence, reentrant, resumeSources, calls: adapter.calls, finalStatus }
}

describe.skipIf(hostModules === null)('真实组合：自动续跑不得破坏 running 位（Issue IKLEOW）', () => {
  // ⚠️ 这条用例防止「宿主包其实没定位到 → 整个 describe 静默 skip」被误读成
  // 「验证通过」。找不到时它自己也会 skip（与上面同一条件），故不假装找过。
  it('宿主真实运行时已定位（否则本文件整体 skip，不是通过）', () => {
    expect(hostModules).not.toBeNull()
    for (const pkg of HOST_PACKAGES) {
      expect(existsSync(join(hostModules!, pkg, 'package.json')), `${pkg} 必须存在`).toBe(true)
    }
  })

  // 两种注册顺序都必须成立：缺陷的**表现形式**取决于顺序，故只验一种等于没验。
  for (const order of ['plugin-first', 'controller-first'] as const) {
    describe(`监听器顺序：${order}`, () => {
      it('循环中止后确实续跑了（否则下面的断言是同义反复）', async () => {
        const result = await runRealComposition(order)
        expect(result.calls, '必须有第 2 次真实请求（= 真的续跑了）').toBeGreaterThanOrEqual(2)
        expect(result.resumeSources.length, '必须真的投出一条续跑消息').toBe(1)
      })

      it('★ 投递脱离 `agent/status` 派发栈：续跑唤醒的 running **不得嵌套**在 idle 派发内', async () => {
        const result = await runRealComposition(order)
        // ⚠️⚠️ **本文件的核心判据**（Issue IKLEOW 根因 1）。
        //
        // 缺陷形态：在 `agent/status(idle)` 的监听器里**同步** `followup()` ⇒
        // `wakeDriver()` 立刻 `setPhase(running)` 并在**同一栈内**再次派发
        // `agent/status` ⇒ 那条 `running` 的 `nested === true`。
        // 实测（本机 `0.2.0-rc.2`）：
        //   同步投递 → `[{running,false},{idle,false},{running,`**`true`**`},{idle,false}]`
        //   微任务投递 → 全部 `false`
        //
        // 反向验证：把 `defaultSchedule` 改回 `task => task()`，本断言**变红**。
        const nested = result.reentrant.filter(r => r.nested)
        expect(
          nested,
          `存在嵌套的 agent/status 派发：${JSON.stringify(result.reentrant)}`
          + '（= 在派发栈内同步唤醒驱动器，一次 idle 转换会产生方向相反的两个信号）',
        ).toEqual([])
      })

      it('★ 续跑期间客户端 running 位与 agent 真实相位一致（Stop / 插话不再失效）', async () => {
        const result = await runRealComposition(order)
        // 判据：**任何**「agent 正在跑」的时刻，客户端都必须认为 running=true。
        const inconsistent = result.samples.filter(s => s.agentStatus === 'running' && !s.clientRunning)
        expect(
          inconsistent,
          `agent 正在运行而客户端 running=false：${JSON.stringify(inconsistent)}`
          + `（完整序列 ${JSON.stringify(result.clientRunningSequence)}）`,
        ).toEqual([])
        // ⚠️ 同时防止「没跑起来也算过」：必须真的观测到新一轮在跑。
        expect(result.samples.filter(s => s.agentStatus === 'running').length).toBeGreaterThanOrEqual(2)
      })

      it('★ 投出的续跑消息带自有 source kind，不冒用人类授权', async () => {
        const result = await runRealComposition(order)
        expect(result.resumeSources).toHaveLength(1)
        expect(result.resumeSources[0]).toEqual({ kind: LOOP_RESUME_SOURCE_KIND })
        // 反向保护：绝不能是 `'user'`（那会让 tool-goal 的授权判据放行）。
        expect((result.resumeSources[0] as { kind?: unknown }).kind).not.toBe('user')
      })

      it('会话能收敛到 idle（不会无界续跑）', async () => {
        const result = await runRealComposition(order)
        expect(result.finalStatus).toBe('idle')
        // 只有 1 次循环中止 ⇒ 只该有 1 次续跑（2 次请求）；上限（默认 2）不该触发。
        expect(result.calls).toBe(2)
      })
    })
  }
})
