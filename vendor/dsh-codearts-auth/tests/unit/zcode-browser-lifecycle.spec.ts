/**
 * ZCode 浏览器**生命周期**的回归测试（进程泄漏与端口选择）。
 *
 * ## 守的是三层隐蔽缺陷（一条链）
 *
 * ```
 * ① kill() 只杀主进程   → chromium 是多进程（实测 13 个），子进程变孤儿
 * ② taskkill 是异步的   → 调用方以为清理完了，旧实例还活着占着端口
 * ③ 端口纯随机不检查    → 新一轮撞上旧端口时 /json/version 应答的是旧实例
 *                         → 连上旧浏览器、child 指向已退出的新进程
 *                         → dispose() 打空 → 旧实例整棵树泄漏（10~14 个进程）
 * ```
 *
 * 实测证据：`dispose()` 后**立即**开下一轮会偶发泄漏；每轮间隔 2.5 秒则
 * 5/5 干净 —— 正是「没等它退完」的特征（我第一版诊断脚本因每轮 sleep
 * 而误判成「瞬态」）。
 *
 * ⚠ 本文件**不启动真实浏览器**（那会很慢且依赖环境）：只锁**可测的行为契约** ——
 *   - `killProcessTree` 必须**同步**（用 spawnSync，不用 spawn）
 *   - 端口选择必须**探测占用**，不能纯随机
 *   - 启动后必须**校验应答端口**（防连到旧实例）
 *
 * ⚠ 真实进程行为由 `.tmp-zcode/verify-no-leak-strict.mjs` 端到端验证
 * （零间隔 10 轮，实测全干净）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceScope } from '../helpers/source-scope.js'

/**
 * ⚠ **扫描目标必须是「代码真正所在」的那个文件**（2026-10-08 抽共享模块时改）。
 *
 * 原来读 `src/zcode-captcha.ts`。进程树清理、空闲端口探测、端口应答校验
 * 这些**浏览器会话**的职责已整体搬到 `src/chromium-session.ts`（由 zcode
 * captcha 与库库AI 登录**共用一份实现**）。
 *
 * 若这里仍指着旧文件，`sourceScope().fn('killProcessTree')` 会直接抛
 * 「找不到 function/method」；而 `SRC.toContain(...)` 这类**整文件**断言
 * 会在一个已不含该代码的文件上求值 —— 那正是本仓库反复出现的**假绿**形态
 * （断言看起来在守，其实守的是空气）。**改了实现文件就必须同时改这里。**
 */
const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/chromium-session.ts'),
  'utf8',
)

/**
 * ⚠ 取方法体**必须**走 `sourceScope().fn()`，不能用 `indexOf('\n  }\n')` 切片 ——
 * 那样在 CRLF 检出（本机 `core.autocrlf=true`）下返回 -1，于是 `slice` 切到
 * **文件尾部**：断言看似通过，实际检查的是整个文件，分不清命中的是不是这个方法。
 * 缘由见 `tests/helpers/source-scope.ts` 的文件头（Gitee issue IKJMG1）。
 */
const scope = sourceScope(SRC, 'chromium-session.ts')

describe('浏览器进程树清理（防泄漏）', () => {
  it('★ 必须用 spawnSync（同步）而非 spawn —— 异步会让调用方以为已清理', () => {
    // ⚠ 这是本缺陷的**核心**：异步 taskkill 后立即返回，旧实例还活着占端口。
    expect(SRC).toContain("spawnSync('taskkill'")
    // 且不得在 killProcessTree 里用异步 spawn（否则又变成 fire-and-forget）。
    const body = scope.fn('killProcessTree')
    expect(body).not.toMatch(/[^S]spawn\('taskkill'/)
  })

  it('★ Windows 必须用 /T（整棵树），不能只杀主进程', () => {
    // 实测一个 chromium 实例有 13 个进程 —— 只杀主进程会留下 12 个孤儿。
    expect(SRC).toMatch(/spawnSync\('taskkill',\s*\['\/pid',\s*String\(pid\),\s*'\/T',\s*'\/F'\]/)
  })

  it('★ POSIX 必须用进程组（负 pid），且启动时 detached', () => {
    expect(SRC).toContain('process.kill(-pid')
    expect(SRC).toMatch(/detached:\s*process\.platform !== 'win32'/)
  })

  it('taskkill 必须有超时（异常时不无限阻塞清理路径）', () => {
    expect(SRC).toMatch(/spawnSync\('taskkill'[\s\S]{0,200}timeout:\s*10_000/)
  })
})

describe('调试端口选择（防连到旧实例）', () => {
  it('★ 必须探测端口占用，不能纯随机', () => {
    // 早期是 `9300 + Math.floor(Math.random() * 500)` —— 不检查占用。
    expect(SRC).toContain('await pickFreePort()')
    expect(SRC).toContain('function pickFreePort')
    expect(SRC).toContain('function isPortFree')
  })

  it('探测必须真的试绑（而不是查监听表 —— 避开 TIME_WAIT 的端口）', () => {
    expect(SRC).toMatch(/function isPortFree[\s\S]{0,400}createServer\(\)/)
    expect(SRC).toMatch(/server\.listen\(port,\s*'127\.0\.0\.1'\)/)
  })

  it('★ 启动后必须校验应答端口等于自己请求的端口', () => {
    /**
     * ⚠ 断言写法踩过坑：**不能只写宽松正则**匹配 `includes(...)`。
     *
     * 我第一版用 `/debuggerUrl\.includes\(.../`，反向验证时把整个
     * `if (...)` 换成 `if (false)` —— 结果**测试仍然通过**（别处有相似片段
     * 命中了正则），等于没测。
     *
     * ⇒ 必须断言**校验条件真的作为 if 的判断**出现，并且跟着抛错。
     */
    expect(SRC).toContain('if (!debuggerUrl.includes(`:${this.port}/`)) {')
    // 与之配套的报错文案（用户可见的诊断信息）。
    expect(SRC).toContain('疑似端口被其它 chromium 占用')
  })

  it('校验失败必须抛错（不是继续用）', () => {
    const idx = SRC.indexOf('疑似端口被其它 chromium 占用')
    expect(idx).toBeGreaterThan(0)
    // 该分支之前应当有 throw。
    const before = SRC.slice(Math.max(0, idx - 400), idx)
    expect(before).toContain('throw new Error')
  })

  it('pickFreePort 有尝试上限（不能无限循环）', () => {
    expect(SRC).toMatch(/function pickFreePort[\s\S]{0,300}attempt < 40/)
  })
})

describe('临时 profile 清理', () => {
  it('★ 删除必须退避重试（句柄释放有延迟）', () => {
    // 一次性 rmSync 实测留下 28 个残留目录。
    expect(SRC).toMatch(/const attempts = \[0, 100, 500, 1_500\]/)
  })

  it('dispose 会先杀进程树再删目录', () => {
    const body = scope.fn('dispose')
    /**
     * ⚠⚠ 两个下标都必须**先证存在**再比大小。
     *
     * 原实现只写 `expect(body.indexOf('this.kill()')).toBeLessThan(body.indexOf('tryRemove(0)'))`
     * —— 而 `indexOf` 找不到时返回 **-1**，`-1 < 任何非负下标` 恒成立
     * ⇒ **删掉 `this.kill()` 这行，用例照样绿**（变异实测：把 `dispose()` 里的
     * `this.kill()` 整行删掉，本用例仍然通过）。这正是「扫描类断言缺护栏」
     * 的又一实例：断言看起来在守「先杀进程再删目录」，其实守不住「杀进程」
     * 这一步**是否存在**。
     */
    const killAt = body.indexOf('this.kill()')
    const removeAt = body.indexOf('tryRemove(0)')
    expect(killAt, 'dispose 里必须真的调用 this.kill()（找不到时 indexOf 返回 -1）').toBeGreaterThan(-1)
    expect(removeAt, 'dispose 里必须真的调用 tryRemove(0)').toBeGreaterThan(-1)
    expect(killAt, '必须先杀进程树再删目录（句柄未释放时删不掉）').toBeLessThan(removeAt)
  })
})
