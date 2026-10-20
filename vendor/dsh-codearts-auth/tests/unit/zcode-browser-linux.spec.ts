/**
 * ZCode 浏览器探测在 **Linux** 上的回归测试。
 *
 * ## 守的是什么（从 Gitee issue IKJKNT 分出来的一条）
 *
 * IKJKNT 修的是 macOS（Gandhi 真机实测 `MINT_OK` 闭环）。但那条 issue 的
 * 报障人同时指出：**`linux` 落进了 `windowsBrowserCandidates`**。
 *
 * 复现（编译产物跑运行时探针，非推测）：
 *
 * ```
 * --- darwin (8 条) ---  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 * --- win32  (9 条) ---  \pf\Google\Chrome\Application\chrome.exe
 * --- linux  (9 条) ---  \home\u\scoop\apps\chromium\current\chrome.exe  ← 与 win32 逐条相同
 * ```
 *
 * `linux` 候选里**非 `.exe` 的路径是 0 条** —— 拼的是 `PROGRAMFILES` /
 * `msedge.exe` 那一套，Linux 上全不存在 ⇒ 恒 `undefined` ⇒ 报「找不到浏览器」，
 * **与 IKJKNT 报的现象完全同型**。
 *
 * ⚠️ 文案侧还有一个**症状本身**：`browserNotFoundMessage('linux')` 原先落在
 * 兜底分支，说「已尝试 Chrome / Chromium / Edge 的常见安装位置」——
 * 而它实际试的是 `PROGRAMFILES`。**说了一句假话**，本文件一并锁死。
 *
 * ## 三条来自报障人建议、但被本实现修正的坑
 *
 * 报障人（Gandhi）在 IKJKNT 评论里给了实现建议，方向对，但有三个问题：
 *
 * | # | 他的写法 | 问题 |
 * |---|---|---|
 * | 1 | 函数内 `const env = process.env` | **忽略注入的 `env`** ⇒ linux 分支在 Windows CI 上不可测，会静默通过（darwin 分支当初抽纯函数就是为了躲这个） |
 * | 2 | 函数内自己 `push(ZCODE_CHROME_PATH)` | `browserCandidates()` 已 `unshift` 过一次 ⇒ linux 上出现两次 |
 * | 3 | flatpak 用 `…/flatpak/appstream/org.chromium.Chromium` | 那是 **AppStream 元数据目录，不是可执行文件**。`existsSync` 会过、`spawn` 会 EACCES ⇒「探测得到但起不来」，**比不列更糟** |
 */
import { describe, expect, it } from 'vitest'
import { browserCandidates, browserNotFoundMessage } from '../../src/zcode-captcha.js'

describe('ZCode 浏览器探测 · Linux', () => {
  it('★ linux 不再落进 Windows 候选链（无 .exe / 无 scoop / 无反斜杠）', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    expect(list.filter((p) => p.endsWith('.exe'))).toEqual([])
    expect(list.some((p) => p.includes('scoop'))).toBe(false)
    expect(list.some((p) => p.includes('\\'))).toEqual(false)
  })

  it('★ 覆盖 distro 包的三种主流装法：google-chrome / chromium / microsoft-edge', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    expect(list).toContain('/usr/bin/google-chrome')
    expect(list).toContain('/usr/bin/chromium')
    expect(list).toContain('/usr/bin/microsoft-edge')
  })

  it('★ Chrome 优先于 Chromium 优先于 Edge（同 Windows 链的优先级口径）', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    const at = (p: string): number => list.findIndex((c) => c === p)
    expect(at('/usr/bin/google-chrome')).toBeGreaterThanOrEqual(0)
    expect(at('/usr/bin/google-chrome')).toBeLessThan(at('/usr/bin/chromium'))
    expect(at('/usr/bin/chromium')).toBeLessThan(at('/usr/bin/microsoft-edge'))
  })

  it('★ 补上非 /usr/bin 的常见位置（opt / snap / flatpak exports）', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    expect(list).toContain('/opt/google/chrome/chrome')
    expect(list).toContain('/snap/bin/chromium')
  })

  /**
   * ⚠️ 这是报障人建议里的**第 3 个坑**，用反例锁死。
   *
   * `~/.local/share/flatpak/appstream/<id>` 是 AppStream **元数据**目录；
   * flatpak 导出的**可执行文件**在 `exports/bin/` 下。
   * 探针只做 `existsSync`（`findBrowserExecutable()` 的判据），不做「能不能执行」——
   * 列了元数据路径就会「探测成功 → spawn 时 EACCES」，是**比不列更糟**的失败。
   */
  it('★ 不得出现 flatpak 的 appstream 元数据目录（那是数据不是可执行文件）', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    expect(list.some((p) => p.includes('appstream'))).toBe(false)
    expect(list.some((p) => p.endsWith('flatpak/exports/bin/org.chromium.Chromium'))).toBe(true)
  })

  it('★ 全部候选都是绝对路径（findBrowserExecutable 的 isAbsolute 兜底不能把它们吃掉）', () => {
    const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
    expect(list.filter((p) => !p.startsWith('/'))).toEqual([])
  })

  /**
   * ⚠️ 报障人建议里的**第 1 个坑**：如果实现内部写 `const env = process.env`，
   * 那注入的 `env` 会被忽略，**这条用例会红** —— 而「能在 Windows 上测 linux 分支」
   * 正是整套纯函数设计的全部意义。
   */
  it('★ 注入的 env 真的被用上（不是硬读 process.env）', () => {
    const list = browserCandidates({
      platform: 'linux',
      env: { ZCODE_CHROME_PATH: '/opt/my/chrome' },
      home: '/home/u',
    })
    expect(list[0]).toBe('/opt/my/chrome')
  })

  /**
   * ⚠️ 报障人建议里的**第 1 个坑**的真正反例。
   *
   * 上面那条只锁「注入的 override 生效」—— 它**抓不住**「实现内部硬读
   * `process.env`」：因为 override 无论由谁 push 都会出现在第一条。
   * 这条才抓得住 —— **注入 env 为空时，真实的 `process.env` 不得渗进来**。
   * 平台分支里只要有一行 `process.env.…`，这条立刻变红。
   */
  it('★ 注入 env 为空时不得渗入真实 process.env 的值', () => {
    const real = process.env.ZCODE_CHROME_PATH
    const realScoop = process.env.SCOOP
    process.env.ZCODE_CHROME_PATH = '/real/host/chrome'
    process.env.SCOOP = '/real/host/scoop'
    try {
      const list = browserCandidates({ platform: 'linux', env: {}, home: '/home/u' })
      expect(list).not.toContain('/real/host/chrome')
      expect(list).not.toContain('/real/host/scoop')
    } finally {
      if (real === undefined) delete process.env.ZCODE_CHROME_PATH
      else process.env.ZCODE_CHROME_PATH = real
      if (realScoop === undefined) delete process.env.SCOOP
      else process.env.SCOOP = realScoop
    }
  })

  /**
   * ⚠️ 报障人建议里的**第 2 个坑**：`ZCODE_CHROME_PATH` 只应出现**一次**。
   * `browserCandidates()` 已经统一 `unshift` 过，平台分支再 push 就是重复。
   */
  it('★ ZCODE_CHROME_PATH 只出现一次（不与平台分支重复）', () => {
    const list = browserCandidates({
      platform: 'linux',
      env: { ZCODE_CHROME_PATH: '/opt/my/chrome' },
      home: '/home/u',
    })
    expect(list.filter((p) => p === '/opt/my/chrome')).toHaveLength(1)
  })

  it('★★ win32 候选链逐字不变（补 linux 绝不能动 Windows）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: { LOCALAPPDATA: '/la', PROGRAMFILES: '/pf', 'PROGRAMFILES(X86)': '/pf86' },
      home: '/home/u',
    })
    // 纯断言「没有 POSIX 风格路径混进来」——具体 Windows 顺序由
    // zcode-browser-macos.spec.ts 的「win32 候选链逐字不变」锁死。
    expect(list.some((p) => p.includes('/usr/bin'))).toBe(false)
    expect(list.some((p) => p.endsWith('.app'))).toBe(false)
  })
})

describe('ZCode 浏览器探测 · Linux 找不到浏览器时的文案', () => {
  it('★ 说 /usr/bin 的真实位置，不提 scoop / chrome.exe / .app', () => {
    const msg = browserNotFoundMessage('linux')
    expect(msg).toContain('/usr/bin/')
    expect(msg).not.toContain('scoop')
    expect(msg).not.toContain('chrome.exe')
    expect(msg).not.toContain('.app')
  })

  it('★ 仍提到 ZCODE_CHROME_PATH（唯一的通用出路）', () => {
    expect(browserNotFoundMessage('linux')).toContain('ZCODE_CHROME_PATH')
  })
})
