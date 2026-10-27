/**
 * `officeace-jar-isolation.e2e.spec.ts` —— **「换账号登录」是否真的换出另一个号**
 * 的机制守卫（Gitee issue IKM741，2026-10-16 真机实测）。
 *
 * ## 为什么这条必须放 e2e，且必须独立成一个文件
 *
 * 单测（`officeace-incognito-login.spec.ts`）能锁**参数形态**（纯函数
 * `incognitoWindowArgs`），但锁不住**参数的实际效果** ——「第二个窗口到底拿到的是
 * 新 cookie jar 还是复用第一个的」。那需要真开两个浏览器窗口。
 *
 * ## 判据：cookie jar 是否共享（而不是「窗口里有没有登录框」）
 *
 * 「有没有显示登录框」依赖人工观察、且受华为侧会话状态影响；而 **cookie jar 是否
 * 共享是机器可测的，且正是「会话复用」的机制本身** —— 共享 jar ⇒ 必然复用登录态
 * ⇒ 第二个号登不进另一个号。
 *
 * 做法：本地 HTTP 服务器 `/w?tag=X` **仅在浏览器没带 `jar` cookie 时**种下
 * `jar=X`，并返回自动回报的页面（页面 `fetch('/report?tag=X')`，服务器据此看到
 * 浏览器**实际发出的** Cookie 头）。⇒ 共享 jar 时窗口 B 带着 A 的 cookie 过来
 * ⇒ 服务器不重种 ⇒ B 的回报里仍是 `jar=A`。
 *
 * ## 本文件测两组东西（缺一不可）
 *
 * | 组 | 内容 | 为什么必须 |
 * |---|---|---|
 * | **① 生产路径** | 直接调 `openIncognitoWindow` 两次（窗口 1 仍开着） | 这是**修法本身**的验收：证明生产实现真的隔离 |
 * | **② 对照矩阵 A/B/C** | 自己拼参数，三格对照 | ⚠️ 它是**修法方向的正当性来源**：只测生产路径只能证明「现在这样做是隔离的」，证明不了「为什么必须带 `--user-data-dir`」。缺了 ②，将来有人删掉 `--user-data-dir` 时 ① 会红但**没人知道该加回什么** |
 *
 * ⚠️ ② 的 A/B/C 三格是**刻意的**（本仓库纪律：对照矩阵必须检查每个变量是否
 * 真的独立）：只测 B（独立 profile、无 incognito）会让 `--incognito` 这个变量
 * 没被验证，而修法恰恰要带上它。
 *
 * ## 三次真机测量结果（本文件写就时的实测值）
 *
 * | 场景 | 组合 | 窗口 1 / 窗口 2 的 jar | 结论 |
 * |---|---|---|---|
 * | A | `--incognito` ×2（同一默认 profile） | `A43993` / **`A43993`** | ❌ **共享** ⇒ 换号失效 |
 * | B | 独立 profile ×2（**无** incognito） | `C85845` / `D85845` | ✅ 隔离 |
 * | C | 独立 profile + `--incognito` ×2 | `E88407` / `F88407` | ✅ 隔离 |
 * | 生产 | 两次 `openIncognitoWindow` | `P30099` / `Q30099` | ✅ 隔离（修法生效） |
 *
 * ## 闸门与副作用
 *
 * `DSH_OFFICEACE_JARPROBE_E2E=1`（`pnpm test:e2e:officeace-jar`）。默认跳过。
 * ⚠️ **会真的开若干浏览器窗口**（含普通窗口，用于 A/B 对照）。
 * ⚠️ A 与普通窗口**刻意不杀进程**：它们可能挂在用户**已在运行的**浏览器进程上，
 * 杀进程会连用户日常窗口一起关掉（那是真实污染）。只杀场景 B/C 里我们自己起的、
 * 带独立 profile 的进程。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultBrowserExecutable, openIncognitoWindow } from '../../src/login.js'

const E2E = process.env.DSH_OFFICEACE_JARPROBE_E2E === '1'

interface Report { tag: string; cookie: string }

const reports: Report[] = []

const server = createServer((req, resp) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const cookieHeader = String(req.headers.cookie ?? '')
  const existing = /(?:^|;\s*)jar=([^;]+)/.exec(cookieHeader)?.[1]
  if (url.pathname === '/w') {
    const tag = url.searchParams.get('tag') ?? '?'
    // ⚠️ **只在没有 jar cookie 时才种** —— 这正是判据：共享 jar 时 B 带着 A 的
    //    cookie 过来 ⇒ 不重种 ⇒ B 的回报里仍是 A。
    if (existing === undefined) resp.setHeader('Set-Cookie', `jar=${tag}; Path=/`)
    resp.setHeader('Content-Type', 'text/html; charset=utf-8')
    resp.end(`<html><body>ok</body><script>fetch('/report?tag=${tag}')</script></html>`)
    return
  }
  if (url.pathname === '/report') {
    reports.push({ tag: url.searchParams.get('tag') ?? '?', cookie: cookieHeader })
    resp.writeHead(204).end()
    return
  }
  resp.writeHead(404).end()
})

let port = 0
/** 我们自己起的、带独立 profile 的浏览器进程（只杀这些）。 */
const ownedPids: number[] = []
const tempDirs: string[] = []

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  for (const pid of ownedPids) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 进程可能已退出 */ }
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  server.close()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(tag: string, timeoutMs = 30_000): Promise<Report | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = reports.find((r) => r.tag === tag)
    if (hit !== undefined) return hit
    await sleep(400)
  }
  return undefined
}

function jarOf(r: Report | undefined): string {
  if (r === undefined) return '(无回报)'
  return /(?:^|;\s*)jar=([^;]+)/.exec(r.cookie)?.[1] ?? '(未带 cookie)'
}

/**
 * 用**给定的**参数组开一个窗口并等它的回报；带 profile 时记下 pid 供收尾清理。
 *
 * ⚠️ 对照组需要**自己拼参数**（那正是「变量必须独立」的要求），故这里不能只走
 *    `openIncognitoWindow`。
 */
async function openWith(
  exe: string,
  tag: string,
  extraArgs: string[],
  profile?: string,
): Promise<Report | undefined> {
  const child = spawn(exe, [...extraArgs, `http://127.0.0.1:${port}/w?tag=${tag}`], {
    detached: true, stdio: 'ignore',
  })
  child.on('error', (error) => { console.error('[jar-e2e] spawn error:', error) })
  child.unref()
  if (profile !== undefined && child.pid !== undefined) ownedPids.push(child.pid)
  return waitFor(tag)
}

describe.runIf(E2E)('officeace e2e：换账号登录的 cookie jar 隔离性（IKM741）', () => {
  /**
   * ① **生产路径**：直接调 `openIncognitoWindow` 两次（窗口 1 仍开着）。
   *
   * ⚠️ 「窗口 1 仍开着」是**刻意的**：生产源码从不关闭宿主开的无痕窗
   *（`loginWindow` 在 `incognitoOpened === true` 时保持 `null`），故真实用户
   * 连续点两次「+ 新建账号」时，第一个窗口**确实还开着**。少了这个条件，
   * 测的就不是真实场景。
   */
  it('① 生产实现：两次 openIncognitoWindow ⇒ 两个窗口各持独立 jar', async () => {
    const stamp = Date.now() % 100000
    const tag1 = `P${stamp}`
    const tag2 = `Q${stamp}`

    const ok1 = openIncognitoWindow(`http://127.0.0.1:${port}/w?tag=${tag1}`)
    expect(ok1, '第一次开窗失败（读不到默认浏览器 / spawn 失败）').toBe(true)
    const r1 = await waitFor(tag1)

    console.log('[jar-e2e] 第二次开窗（窗口 1 仍开着，复现生产形态）…')
    const ok2 = openIncognitoWindow(`http://127.0.0.1:${port}/w?tag=${tag2}`)
    expect(ok2, '第二次开窗失败').toBe(true)
    const r2 = await waitFor(tag2)

    const jar1 = jarOf(r1)
    const jar2 = jarOf(r2)
    console.log(
      `[jar-e2e] ① 生产路径结果：窗口 1 = ${jar1}，窗口 2 = ${jar2}\n`
      + `[jar-e2e]   ⇒ ${jar1 !== jar2 ? '✅ 隔离（修法生效）' : '❌ 共享（换号会失效）'}\n`,
    )

    expect(jar1, '窗口 1 没能回报（页面没加载？）').not.toBe('(未带 cookie)')
    expect(
      jar2,
      '两次生产调用共享同一个 cookie jar ⇒ 「连续新建两个账号」会复用第一个号的'
      + '会话，第二个号登不进去（IKM741 的核心症状）。'
      + '修法：每次开窗给独立的 --user-data-dir（见 src/login.ts 的 '
      + 'prepareIncognitoProfileDir / incognitoWindowArgs）',
    ).not.toBe(jar1)
  }, 180_000)

  /**
   * ② 对照矩阵 A/B/C —— **修法方向的正当性来源**。
   *
   * ⚠️ 三格各自只改一个变量（见本文件头）。A 是**缺陷原状的复现**
   *（`--incognito` 但同一 profile），故它**必须表现为共享** —— 否则说明
   * 本判据不成立（判据自检）。
   */
  it('②A 缺陷原状：--incognito ×2（同一默认 profile）⇒ 必须**共享**（判据自检）', async () => {
    const exe = defaultBrowserExecutable()
    expect(exe, '读不到默认浏览器可执行文件').toBeDefined()
    const stamp = Date.now() % 100000
    const tagA = `A${stamp}`
    const tagB = `B${stamp}`

    const rA = await openWith(exe!, tagA, ['--incognito', '--new-window'])
    // ⚠️ 窗口 A 刻意不关（见文件头）。
    const rB = await openWith(exe!, tagB, ['--incognito', '--new-window'])

    const jarA = jarOf(rA)
    const jarB = jarOf(rB)
    console.log(`[jar-e2e] ②A 结果：A = ${jarA}，B = ${jarB} ⇒ ${jarA === jarB ? '共享（缺陷原状，符合预期）' : '隔离'}\n`)
    expect(jarA, '窗口 A 没能回报').not.toBe('(未带 cookie)')
    expect(jarB, '窗口 B 没能回报').not.toBe('(未带 cookie)')
    // ⚠️ 若这一格变成「隔离」，说明本判据（cookie 值暴露 jar 共享）**不再成立**
    //    —— 那要么是浏览器换了行为（好事，但要据此重评修法是否仍必要），
    //    要么是判据本身坏了。两种都必须让人看到，故这里断言成红。
    expect(
      jarB,
      '同一 profile 的两个 --incognito 窗口居然隔离了 ⇒ 浏览器的无痕语义已变，'
      + '请重新评估 --user-data-dir 是否仍必要（本条是判据自检，不是产品断言）',
    ).toBe(jarA)
  }, 150_000)

  /**
   * ②B/②C 独立 profile 的两格（**含 `--incognito`** 那格才是修法实际组合）。
   */
  it('②B/C 独立 --user-data-dir ⇒ 必须**隔离**（B 无 incognito、C 带 incognito）', async () => {
    const exe = defaultBrowserExecutable()
    expect(exe).toBeDefined()
    const stamp = Date.now() % 100000

    // ②B：独立 profile、**不带** incognito
    const dirC = mkdtempSync(join(tmpdir(), 'jar-e2e-c-'))
    const dirD = mkdtempSync(join(tmpdir(), 'jar-e2e-d-'))
    tempDirs.push(dirC, dirD)
    const tagC = `C${stamp}`
    const tagD = `D${stamp}`
    const rC = await openWith(exe!, tagC, [`--user-data-dir=${dirC}`, '--new-window'], dirC)
    const rD = await openWith(exe!, tagD, [`--user-data-dir=${dirD}`, '--new-window'], dirD)
    const jarC = jarOf(rC)
    const jarD = jarOf(rD)
    console.log(`[jar-e2e] ②B（独立 profile，无 incognito）：C = ${jarC}，D = ${jarD}\n`)

    // ②C：**独立 profile + incognito** —— 修法实际要用的组合
    const dirE = mkdtempSync(join(tmpdir(), 'jar-e2e-e-'))
    const dirF = mkdtempSync(join(tmpdir(), 'jar-e2e-f-'))
    tempDirs.push(dirE, dirF)
    const tagE = `E${stamp}`
    const tagF = `F${stamp}`
    const rE = await openWith(
      exe!, tagE, [`--user-data-dir=${dirE}`, '--incognito', '--new-window'], dirE,
    )
    const rF = await openWith(
      exe!, tagF, [`--user-data-dir=${dirF}`, '--incognito', '--new-window'], dirF,
    )
    const jarE = jarOf(rE)
    const jarF = jarOf(rF)
    console.log(
      `[jar-e2e] ②C（独立 profile + incognito，修法实际组合）：E = ${jarE}，F = ${jarF}\n`
      + `[jar-e2e]   ⇒ ${jarE !== jarF ? '✅ 隔离' : '❌ 仍然共享 ⇒ 修法不能用这个组合'}\n`,
    )

    expect(jarC, '②B 窗口 C 没种下自己的 jar').not.toBe('(未带 cookie)')
    expect(
      jarD,
      '②B：两个独立 profile 的窗口仍共享 jar ⇒ 「独立 profile」这条修法方向本身无效',
    ).not.toBe(jarC)
    expect(jarE, '②C 窗口 E 没种下自己的 jar').not.toBe('(未带 cookie)')
    expect(
      jarF,
      '②C：「独立 profile + --incognito」仍共享 jar ⇒ 修法必须去掉 --incognito 或换方案 '
      + '（这一格是刻意与 ②B 分开测的：只测 B 会让 --incognito 这个变量没被验证）',
    ).not.toBe(jarE)
  }, 240_000)
})
