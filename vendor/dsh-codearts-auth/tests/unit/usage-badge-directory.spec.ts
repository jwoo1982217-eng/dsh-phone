/**
 * 用量徽标的目录解析必须**惰性 + 容错**（真实事故，同源已发生两次）。
 *
 * ## 事故史（务必读完再改）
 *
 * 1. 2026-10-02 首次：宿主 inject 传 `directory: directoryFor(sessionId).store`，
 *    桌面版在 inject 求值期抛 `cannot get property "remote.session"
 *    without inject`。当时判断为「只是徽标不显示」。
 * 2. 同日用户报障：**模型选择器点不动** —— 因为该异常发生在会话输入区的
 *    **同步渲染路径**上，整个输入区渲染中断，远不止徽标。
 *
 * ⇒ 硬约定：目录解析只能在**组件自己的 effect**里做，且全程 try/catch。
 * 任何在宿主 inject 期求值、或把异常抛回宿主渲染树的做法都是回归。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const indexJs = readFileSync(join(here, '../../plugin-src/client/index.js'), 'utf8')
const badge = readFileSync(join(here, '../../plugin-src/client/usage-badge.js'), 'utf8')

describe('宿主 inject 侧：不得求值目录', () => {
  /** 只取**代码行**（注释里刻意保留了这些禁用写法作为后人提醒）。 */
  function injectCode(): string {
    const at = indexJs.indexOf("'conversation.input.right'")
    return indexJs.slice(at, at + 1200).split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')
  }

  it('⚠️ inject 传的是 resolveDirectory() 函数，不是已求值的 directory', () => {
    const at = indexJs.indexOf("'conversation.input.right'")
    // 窗口要够大：inject 上方的根因注释很长（写断言时踩过「断言在窗口外」的假失败）
    const body = indexJs.slice(at, at + 3000)
    // 形态：`() => { const directory = ...; return { store, load } }`
    expect(body).toMatch(/resolveDirectory:\s*\(\)\s*=>\s*\{/)
    expect(body).toMatch(/ctx\.modelDirectories\.directoryFor\(sessionId\)/)
  })

  it('⚠️ 禁止在 inject 里出现 directoryFor(...).store（惰性 getter 在此求值）', () => {
    expect(injectCode(), 'inject 期求值 = 桌面版必炸 = 模型选择器点不动')
      .not.toMatch(/directoryFor\(sessionId\)\.store/)
    expect(injectCode()).not.toMatch(/directory:\s*ctx\.modelDirectories/)
  })

  it('⚠️ 不用 getter 属性（useSyncExternalStore 会反复读它，一次异常即炸订阅）', () => {
    expect(injectCode()).not.toMatch(/get directory\(\)/)
  })
})

describe('徽标组件侧：惰性解析 + 全程容错', () => {
  const fnAt = badge.indexOf('export function UsageBadge(')
  // ⚠️ 窗口要覆盖整个组件体：诊断日志加长后 3000 不够，
  // 会出现「断言在窗口外」这种假失败（写断言时踩过）。
  const body = badge.slice(fnAt, fnAt + 6000)

  it('⚠️ 目录解析放在 useEffect 里（不在渲染体）', () => {
    expect(body).toMatch(/React\.useEffect\(/)
    const effectAt = body.indexOf('React.useEffect(')
    expect(effectAt).toBeGreaterThan(-1)
    // 解析调用必须落在 effect 区间内
    expect(body.indexOf('resolveDirectory()')).toBeGreaterThan(effectAt)
  })

  it('⚠️ 解析失败被 try/catch 收进徽标内部（不影响宿主渲染树）', () => {
    expect(body).toMatch(/try \{[\s\S]{0,400}resolveDirectory\(\)/)
    // 失败不在此处上报（重试会重复触发），重试耗尽时统一 warn 一次
    expect(body).toMatch(/catch \{[\s\S]{0,300}resolved = null/)
  })

  it('⚠️ getSnapshot 也包 try/catch（求值可能推迟到订阅时才抛）', () => {
    expect(body).toMatch(/const safe = \(fn\) => \(\) => \{/)
    expect(body).toMatch(/safe\(\(d\) => d\.getSnapshot\(\)\)/)
  })

  it('⚠️ subscribe 仍转发 onChange（模型切换时徽标要更新），但订阅失败被收住', () => {
    expect(body).toMatch(/return directory\.subscribe\(onChange\)/)
    expect(body).toMatch(/catch \{[\s\S]{0,80}return \(\) => \{\}/)
  })

  it('⚠️ 目录为 null 时三个回调都必须是合法函数（不能是 null）', () => {
    // useSyncExternalStore 收到非函数回调会抛 TypeError，同样炸宿主渲染树
    expect(body).toMatch(/if \(!directory\) return \(\) => \{\}/)
    expect(body).not.toMatch(/useSyncExternalStore\(\s*null/)
  })

  it('回归注释记录了两次事故（防后人「优化」回去）', () => {
    const doc = badge.slice(Math.max(0, fnAt - 1200), fnAt)
    expect(doc).toMatch(/remote\.session/)
    expect(doc).toMatch(/模型选择器|输入区/)
  })
})

describe('⚠️⚠️ 根因二：ModelDirectory 的 store 与 load（真机事故第四次定位）', () => {
  it('⚠️ resolveDirectory 必须同时交出 store 与 load', () => {
    // 读 dsh-client-ui-model-selection 的 ModelDirectory 源码得到两个事实：
    //   ① 公开方法是 load()/syncInputs()，**没有** getSnapshot()/subscribe()
    //      —— 那两个在 this.store 上（我第一版只交实例 ⇒ getSnapshot undefined
    //      ⇒ TypeError 被 safe() 吞掉 ⇒ provider 恒空 ⇒ 徽标永不显示）
    //   ② store 初值 { current: null, status: 'idle' }，只有 await load() 之后
    //      syncInputs() 才填入真实 current
    const at = indexJs.indexOf('resolveDirectory: () => {')
    const body = indexJs.slice(at, at + 500)
    expect(body).toMatch(/store:\s*directory\.store/)
    expect(body).toMatch(/load:\s*\(\)\s*=>\s*directory\.load\(\)/)
  })

  it('⚠️ 组件必须调 load()（否则 current 永远是 null）', () => {
    const fnAt = badge.indexOf('export function UsageBadge(')
    const body = badge.slice(fnAt, fnAt + 6000)
    expect(body).toMatch(/resolved\.load\(\)/)
    expect(body).toMatch(/resolved\.store !== undefined/)
  })

  it('⚠️ 快照读取失败必须记日志（静默吞掉是本次排查最大的阻碍）', () => {
    const fnAt = badge.indexOf('export function UsageBadge(')
    const body = badge.slice(fnAt, fnAt + 6000)
    expect(body).toMatch(/读目录快照失败/)
    expect(body).toMatch(/snapshotErrorRef/)
  })

  it('⚠️ 只保留失败路径的 warn，不留定位用的 console.info', () => {
    // 2026-10-02 清理：那批 info 是为追 desktop 徽标问题临时加的，问题已修好。
    // 教训靠**注释与断言**保存，不靠刷屏。
    const fnAt = badge.indexOf('export function UsageBadge(')
    const body = badge.slice(fnAt, fnAt + 6000)
    // ⚠️ 只看**代码行**：注释里刻意写了「不再有 console.info」这句提醒，
    // 全串匹配会把它自己也判红。
    const code = body.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/console\.info/)
    expect(code).not.toMatch(/console\.log\(/)
    // 但失败必须仍可见（本次排查多绕四轮的直接原因就是静默吞异常）
    expect(code).toMatch(/console\.warn/)
    expect(code).toMatch(/读目录快照失败/)
    expect(code).toMatch(/目录解析最终失败/)
  })
})

describe('⚠️⚠️ 根因：inject 缺少 remote.session（真机事故第三次定位）', () => {
  it('⚠️ 当前 SDK 必须声明 sessions，不依赖已删除服务', () => {
    // 定位依据（从 app.asar 里 @deepseek-ai/dsh-client-ui-model-selection/lib/client.js
    // 读出的真实实现）：
    //   该包自己的 inject = ["sessions", "remote", "remote.session"]
    //   而 directoryFor(sessionId) 内部读 this.ctx.sessions 与
    //   this.ctx.remote.session → 我们没声明 ⇒ 抛
    //   `cannot get property "remote.session" without inject`
    //   症状：desktop 徽标永久不显示且无报错。
    const m = /export const inject = \[([^\]]*)\]/.exec(indexJs)
    expect(m, '应能解析出 export const inject').not.toBeNull()
    const list = m![1]!
    for (const svc of ['modelDirectories', 'sessions']) {
      expect(list, `inject 缺少 ${svc}`).toContain(`'${svc}'`)
    }
    expect(list).not.toContain("'remote.session'")
  })

  it('⚠️ 根因注释要写明「directoryFor 需要 remote.session」，防后人删掉', () => {
    const at = indexJs.indexOf('export const inject')
    const doc = indexJs.slice(Math.max(0, at - 1600), at)
    expect(doc).toMatch(/remote\.session/)
    expect(doc).toMatch(/directoryFor/)
  })

  it('⚠️ 解析失败必须打日志（根因已修后仍失败 = 契约又被改坏）', () => {
    const fnAt = badge.indexOf('export function UsageBadge(')
    const body = badge.slice(fnAt, fnAt + 6000)
    // 解析失败与快照读取失败**两处**都要留日志 —— 本次「静默吞异常」让
    // `directory.getSnapshot is not a function` 完全隐形，排查多绕了两轮。
    expect(body).toMatch(/目录解析最终失败/)
    expect(body).toMatch(/读目录快照失败/)
  })
})

describe('⚠️⚠️ 解析失败必须重试（真机事故第二次：徽章永久消失）', () => {
  const fnAt = badge.indexOf('export function UsageBadge(')
  // 重试逻辑在组件开头附近，取足够长的窗口
  const body = badge.slice(fnAt, fnAt + 4200)

  it('⚠️ 有重试退避序列（不是「失败一次就永久放弃」）', () => {
    // 我的第一版修法是「try/catch 吞掉」—— 结果异常没了、徽章也**永远**
    // 不显示（把崩溃换成了静默失败，比原问题更难发现）。
    expect(badge).toMatch(/RESOLVE_RETRY_DELAYS/)
    expect(body).toMatch(/attempt \+= 1/)
    expect(body).toMatch(/setTimeout\(tryResolve, RESOLVE_RETRY_DELAYS\[/)
  })

  it('⚠️ 已解析出目录就不再重跑（否则重试计时器被无限重启）', () => {
    expect(body).toMatch(/resolvedRef/)
    expect(body).toMatch(/if \(resolvedRef\.current\) return/)
    expect(body).toMatch(/resolvedRef\.current = true/)
  })

  it('⚠️ 卸载时清理所有待触发的定时器（不留下野计时器）', () => {
    expect(body).toMatch(/clearTimeout\(timer\)/)
    expect(body).toMatch(/for \(const timer of timers\)/)
  })

  it('⚠️ 重试全失败时安静放弃（不抛错到宿主渲染树）', () => {
    // 徽标不显示是可接受的降级；把异常抛回宿主渲染树才是不可接受的
    // （那会打崩整个会话输入区）。**但必须留一条日志**（见上一条）。
    const fnAt = badge.indexOf('export function UsageBadge(')
    const body = badge.slice(fnAt, fnAt + 6000)
    expect(body).toMatch(/attempt >= RESOLVE_RETRY_DELAYS\.length/)
  })
})
