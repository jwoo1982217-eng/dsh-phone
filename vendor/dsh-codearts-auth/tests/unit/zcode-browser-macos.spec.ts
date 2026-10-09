/**
 * ZCode 浏览器探测在 **macOS** 上的回归测试。
 *
 * ## 守的是什么（Gitee issue IKJKNT，用户报障）
 *
 * 报障原文：
 * > 根因: zcode-captcha.js:199 `findBrowserExecutable()` 纯 Windows 候选，无 Mac 分支；
 * > Mac 上有 Google Chrome 但探测不到。
 * > 修复: 纯增量追加 4 条 Mac 候选（`/Applications/{Google Chrome,Chromium,Microsoft Edge}
 * > .app/Contents/MacOS/*` + `~/Applications/...`），未删任何 Windows 候选，
 * > `ZCODE_CHROME_PATH` 仍最高优先。
 *
 * 报障人只验了 `findBrowserExecutable()` 的**返回值**，本文件把整个 macOS 分支
 * 锁死 —— 关键在于**能在 Windows 上跑**：候选构造被抽成**纯函数**
 * `browserCandidates({platform, env, home})`，不碰文件系统，于是 darwin 分支
 * 就是纯字符串断言。
 *
 * ## 为什么必须抽成纯函数（否则本仓库的 CI 永远测不到这条路径）
 * 直接在 `findBrowserExecutable()` 里写 Mac 候选，本机（Windows）跑出来的
 * 永远是 win32 分支，darwin 分支**一行都执行不到**，静默通过。
 *
 * ## 三条必须同时成立的不变式
 *
 * 1. **darwin 候选里不能出现反斜杠**：macOS 分支必须用 `posix.join` 而不是
 *    `join` —— 后者在 Windows 宿主上会拼出 `/Applications\Google Chrome.app\…`，
 *    在 Mac 上则完全正常。这是个**只在 Windows 测试机上暴露**的错。
 * 2. **Windows 候选链必须逐字不变**：本仓库 Windows 用户远多于 Mac，
 *    改 Mac 不能以动 Windows 为代价。
 * 3. **`ZCODE_CHROME_PATH` 在两个平台都最高优先**：用户显式指定时一切让路。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { browserCandidates, isEdgeExecutable, browserNotFoundMessage } from '../../src/zcode-captcha.js'

/** macOS app bundle → 内部可执行文件名（`Contents/MacOS/<exe>`）。 */
const MAC_APPS: ReadonlyArray<readonly [bundle: string, exe: string]> = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
  ['Brave Browser.app', 'Brave Browser'],
]

/** 受控的 win32 环境（`join` 在本机拼出的是 Windows 风格，故用 `join` 构造期望值）。 */
const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
} as const

describe('ZCode 浏览器探测 · macOS（issue IKJKNT）', () => {
  it('★ darwin 候选按「Chrome → Chromium → Edge → Brave」×「/Applications → ~/Applications」排列', () => {
    const list = browserCandidates({ platform: 'darwin', env: {}, home: '/Users/me' })
    expect(list).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ])
  })

  it('★ darwin 候选里一个反斜杠都没有（必须 posix.join，不能用宿主 join）', () => {
    // ⚠️ 这条在 Mac 上恒成立，只有 Windows 测试机能抓住 —— 用 join 拼就会红。
    const list = browserCandidates({ platform: 'darwin', env: {}, home: '/Users/me' })
    expect(list.filter((p) => p.includes('\\'))).toEqual([])
  })

  it('★ darwin 候选里没有 scoop / chrome.exe / msedge.exe（不把 Windows 布局混进来）', () => {
    const list = browserCandidates({ platform: 'darwin', env: WIN_ENV, home: '/Users/me' })
    expect(list).toHaveLength(MAC_APPS.length * 2)
    expect(list.some((p) => p.endsWith('.exe'))).toBe(false)
    expect(list.some((p) => p.includes('scoop'))).toBe(false)
  })

  it('★ darwin 下 ZCODE_CHROME_PATH 仍排第一（显式指定优先于一切候选）', () => {
    const list = browserCandidates({
      platform: 'darwin',
      env: { ZCODE_CHROME_PATH: '/opt/my-browser/chrome' },
      home: '/Users/me',
    })
    expect(list[0]).toBe('/opt/my-browser/chrome')
  })

  it('★ darwin 下空串 / 纯空白的 ZCODE_CHROME_PATH 被忽略（不产生空候选）', () => {
    const list = browserCandidates({ platform: 'darwin', env: { ZCODE_CHROME_PATH: '   ' }, home: '/Users/me' })
    expect(list.some((p) => p.trim().length === 0)).toBe(false)
    expect(list[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('★★ win32 候选链逐字不变（本仓库 Windows 用户远多于 Mac，改 Mac 不能动 Windows）', () => {
    expect(browserCandidates({ platform: 'win32', env: WIN_ENV, home: 'C:\\Users\\me' })).toEqual([
      join('C:\\Users\\me', 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'),
      join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Users\\me\\AppData\\Local', 'Chromium', 'Application', 'chrome.exe'),
      join('C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
      join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join('C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  })

  it('★ win32 下 SCOOP / SCOOP_GLOBAL 显式声明仍排最前（回归：上次重排过一次）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: { ...WIN_ENV, SCOOP: 'D:\\scoop', SCOOP_GLOBAL: 'E:\\gscoop' },
      home: 'C:\\Users\\me',
    })
    expect(list[0]).toBe(join('D:\\scoop', 'apps', 'chromium', 'current', 'chrome.exe'))
    expect(list[1]).toBe(join('E:\\gscoop', 'apps', 'chromium', 'current', 'chrome.exe'))
  })

  it('★ win32 分支里不出现任何 .app 路径（Mac 候选不能污染 Windows）', () => {
    const list = browserCandidates({ platform: 'win32', env: WIN_ENV, home: 'C:\\Users\\me' })
    expect(list.some((p) => p.includes('.app'))).toBe(false)
  })
})

describe('ZCode 浏览器探测 · Edge 兜底告警在 macOS 上也要出声', () => {
  /**
   * ⚠️ 这是 issue 报障人**漏掉的**同型缺陷。
   *
   * IKJLB1 加的 Edge 兜底告警判据是**文件名 `msedge.exe`**，而 macOS 的
   * Edge 包内二进制叫 **`Microsoft Edge`**（没有 `.exe`）⇒ Mac 用户落到
   * Edge 兜底时**一声不吭**，与该 issue 的期望行为 2（「用户不知道系统在拿
   * Edge 兜底」）直接冲突。
   */
  it('★ isEdgeExecutable 认 macOS 的 "Microsoft Edge"', () => {
    expect(isEdgeExecutable('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')).toBe(true)
  })

  it('★ 仍然认 Windows 的 msedge.exe（含大小写）', () => {
    expect(isEdgeExecutable(join('C:', 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'))).toBe(true)
    expect(isEdgeExecutable(join('C:', 'edge', 'MSEDGE.EXE'))).toBe(true)
  })

  it('★ 不误伤其它 chromium（含 macOS 的 Chrome / Chromium / Brave 与 Windows 的 chrome.exe）', () => {
    expect(isEdgeExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(false)
    expect(isEdgeExecutable('/Applications/Chromium.app/Contents/MacOS/Chromium')).toBe(false)
    expect(isEdgeExecutable('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')).toBe(false)
    expect(isEdgeExecutable(join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'))).toBe(false)
  })
})

describe('ZCode 浏览器探测 · 找不到浏览器时的文案要按平台说人话', () => {
  /**
   * ⚠️ 修复前的文案是「已尝试 scoop chromium / Chrome / Chromium / Edge；
   * 可用 ZCODE_CHROME_PATH 显式指定 **chrome.exe** 路径。」
   * —— macOS 上 scoop 不存在、chrome.exe 也不是那个文件名，用户照着做只会更懵。
   */
  it('★ darwin 文案说 .app 路径，不提 chrome.exe / scoop', () => {
    const msg = browserNotFoundMessage('darwin')
    expect(msg).toContain('/Applications')
    expect(msg).toContain('.app/Contents/MacOS/')
    expect(msg).not.toContain('chrome.exe')
    expect(msg).not.toContain('scoop')
  })

  it('★ win32 文案保持原口径（chrome.exe / scoop）', () => {
    const msg = browserNotFoundMessage('win32')
    expect(msg).toContain('chrome.exe')
    expect(msg).toContain('scoop')
    expect(msg).not.toContain('.app')
  })

  it('★ 两个平台的文案都提到 ZCODE_CHROME_PATH（唯一的通用出路）', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(browserNotFoundMessage(platform)).toContain('ZCODE_CHROME_PATH')
    }
  })
})
