/**
 * ZCode 浏览器**进程级护栏**的回归测试（Gitee issue IKJLB1）。
 *
 * ## 为什么这些用例必须**在子进程里跑**
 *
 * 修复前的缺陷是「浏览器**起不来**时，未捕获的 `'error'` 事件直接把
 * **当前进程**带走」。若在 vitest worker 内直接调 `mint()`，**失败的不是
 * 断言而是整个测试进程** —— 那样这条用例根本测不出「崩没崩」。
 *
 * 故统一起一个 node 子进程，让它自己去调真实实现，用**子进程的退出码**
 * 充当判据：
 *
 * | 子进程结局 | 含义 |
 * |---|---|
 * | exit 0 + 打印 `CAUGHT:` | ✅ 异常被接住，进程活着（修复后） |
 * | 非 0 / 打印 `Unhandled` | ❌ 被未捕获异常带走（修复前） |
 *
 * ⚠️ 这也是本仓库的既定做法（`tests/unit/zcode-taskbar-hide.spec.ts`
 * 读源码文本、`tests/unit/zcode-page-prepared.spec.ts` 换私有字段）。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isEdgeExecutable } from '../../src/zcode-captcha.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MODULE_URL = pathToFileURL(join(REPO, 'lib', 'zcode-captcha.js')).href

/**
 * ⚠ 子进程跑的是**编译产物**（node 不能直接 import `.ts`），
 * 故这份 spec 依赖 `pnpm build` 先跑过（`prepare` 会做）。
 * 缺产物时**明确报错**而不是静默跳过 —— 静默跳过会让它在 CI 上失效。
 */
if (!existsSync(join(REPO, 'lib', 'zcode-captcha.js'))) {
  throw new Error('lib/zcode-captcha.js 不存在，请先执行 `pnpm build`（本 spec 的子进程依赖编译产物）')
}

/** 在子进程里跑一段脚本，返回 { status, stdout, stderr }。 */
function runInChild(source: string, timeoutMs = 30_000): {
  status: number | null
  stdout: string
  stderr: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-spawn-guard-'))
  try {
    const file = join(dir, 'case.mjs')
    writeFileSync(
      file,
      `
const { ZcodeCaptchaBrowser } = await import(${JSON.stringify(MODULE_URL)})
/**
 * ⚠ **必须保活**：实现里的 sleep 用的是 unref 的 timer（生产环境由 HTTP server
 * 撑着 event loop），而这里是个「只有这一个待办」的裸子进程 —— 不加保活会在
 * 等待途中 event loop 直接见底，node 以 13（unsettled TLA）退出，
 * 让断言误以为是「崩溃」。真实宿主里不存在这个问题。
 */
const keepAlive = setInterval(() => {}, 250)
${source}
`,
      'utf8',
    )
    const result = spawnSync(process.execPath, [file], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ZCode 浏览器进程护栏（issue IKJLB1）', () => {
  it('★ 浏览器**起不来**（ENOENT）：异常被接住，进程不死', () => {
    const missing = join(tmpdir(), 'zcode-no-such-browser-dir', 'msedge.exe')
    const run = runInChild(`
const browser = new ZcodeCaptchaBrowser({
  executablePath: ${JSON.stringify(missing)},
  readyTimeoutMs: 8_000,
})
try {
  await browser.mint()
  console.log('UNEXPECTED_SUCCESS')
  process.exit(3)
} catch (error) {
  console.log('CAUGHT:' + error.message)
}
// ⚠️ 只有「异常被接住」才会走到这里；否则进程会被未捕获 'error' 直接带走。
process.exit(0)
`)

    // ⚠️ 这是整条用例的命门：修复前这里是 1（进程被带走）。
    expect(run.status, `子进程应正常退出；stderr=\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('CAUGHT:')
    // 错误文案必须**可操作**（issue 的期望行为 1），且指名道姓说出是哪个浏览器。
    expect(run.stdout).toContain('msedge.exe')
    expect(run.stdout).toContain('ZCODE_CHROME_PATH')
    // 反向断言：不得是「等满超时」那种含糊说法。
    expect(run.stdout).not.toContain('调试端口未就绪')
  })

  it('★ 浏览器**起来就退**（exit 事件）：给出含退出码的诊断，进程不死', () => {
    // 用 node 自己当「起不来的浏览器」：它不认 `--remote-debugging-port` 会立刻退出。
    const run = runInChild(`
const browser = new ZcodeCaptchaBrowser({
  executablePath: process.execPath,
  readyTimeoutMs: 8_000,
})
try {
  await browser.mint()
  console.log('UNEXPECTED_SUCCESS')
  process.exit(3)
} catch (error) {
  console.log('CAUGHT:' + error.message)
}
process.exit(0)
`, 40_000)

    expect(run.status, `子进程应正常退出；stderr=\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('CAUGHT:')
    // 期望行为 3：日志/错误里要**写明真正退出的是谁、以什么码退的**。
    expect(run.stdout).toMatch(/异常退出|无法启动/)
  })

  it('★ 落到系统 Edge 兜底时会告警（不再静默）', () => {
    // ⚠ 用一个**确实叫 msedge.exe 但不存在**的路径：`isEdgeExecutable` 只看文件名，
    // 故告警会照常发出，而 spawn 随即以 ENOENT 失败 —— 正好把「告警」与「失败」都验到。
    const edge = join(tmpdir(), 'zcode-no-such-browser-dir', 'msedge.exe')
    const run = runInChild(`
const browser = new ZcodeCaptchaBrowser({
  executablePath: ${JSON.stringify(edge)},
  readyTimeoutMs: 2_000,
  log: (message) => console.log('LOG:' + message),
})
try { await browser.mint() } catch { /* 只关心有没有告警 */ }
process.exit(0)
`)

    expect(run.status, `子进程应正常退出；stderr=\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('LOG:')
    expect(run.stdout).toContain('Edge')
    expect(run.stdout).toContain('ZCODE_CHROME_PATH')
  })

  it('★ 用了 Chrome/Chromium 时**不**告警（不打扰绝大多数用户）', () => {
    const chrome = join(tmpdir(), 'zcode-no-such-browser-dir', 'chrome.exe')
    const run = runInChild(`
const browser = new ZcodeCaptchaBrowser({
  executablePath: ${JSON.stringify(chrome)},
  readyTimeoutMs: 2_000,
  log: (message) => console.log('LOG:' + message),
})
try { await browser.mint() } catch { /* 不关心结果，只关心没有 LOG */ }
process.exit(0)
`)

    expect(run.status, `子进程应正常退出；stderr=\n${run.stderr}`).toBe(0)
    expect(run.stdout).not.toContain('LOG:')
  })

  it('★ isEdgeExecutable 只认 msedge.exe，不误伤其它 chromium', () => {
    expect(isEdgeExecutable(join('C:', 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'))).toBe(true)
    // 大小写不敏感（Windows 文件名不区分大小写）
    expect(isEdgeExecutable(join('C:', 'edge', 'MSEDGE.EXE'))).toBe(true)
    // 装了 Chrome/Chromium 的用户**不该**被这条告警打扰
    expect(isEdgeExecutable(join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'))).toBe(false)
    expect(isEdgeExecutable(join('C:', 'Users', 'me', 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'))).toBe(false)
    // ⚠ 路径里带 "Edge" 字样的第三方 chromium 不该被误报成系统 Edge
    expect(isEdgeExecutable(join('C:', 'tools', 'EdgeProxy', 'chrome.exe'))).toBe(false)
  })
})
