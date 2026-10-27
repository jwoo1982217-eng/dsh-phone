/**
 * `officeace-incognito-window-args.spec.ts` —— `incognitoWindowArgs` 的纯函数守卫
 * （Gitee issue IKM741，2026-10-16 真机实测）。
 *
 * ## 为什么单独一个文件（而不是塞进 `officeace-incognito-login.spec.ts`）
 *
 * 那个文件有一条**很重要的纪律用例 ⑪**：**它自己不得 import `src/login.js`**
 *（因为那是会真开窗的模块，单测 import 它就有污染用户桌面的风险 —— 2026-10-13
 * 的真实事故）。而本文件要断言的东西**恰好就在那个模块里**（纯函数
 * `incognitoWindowArgs`）。
 *
 * ⇒ 两条纪律的**正确解法是分开**，而不是把 ⑪ 放宽：
 * - 本文件**只 import 纯函数** `incognitoWindowArgs`，**绝不 import / 绝不调用**
 *   `openIncognitoWindow` / `openBrowser`（下面 ② 用源码断言钉死这一点）；
 * - 纯函数零副作用（只拼数组、不 spawn），故 import 它**不构成开窗风险**。
 *
 * ## 它守什么
 *
 * ⚠️⚠️ **单靠 `--incognito` 不够**：它的 cookie jar 是**按浏览器进程**共享的，
 * 不是每窗口一个 ⇒ 第一个窗口还开着时，第二个 `--incognito` 只是**加入同一个
 * jar** ⇒ 「连续新建两个账号」会复用第一个号的会话。真机三次对照实测
 *（详表见 `tests/e2e/officeace-jar-isolation.e2e.spec.ts`）。
 *
 * 修法 = 每次开窗给**独立 `--user-data-dir`**。而 `openIncognitoWindow` 本身在
 * 单测里被 `NODE_ENV === 'test'` 断路器挡住 ⇒ 「参数到底传对了没有」**只有**
 * 这个纯函数能被确定性地断言。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { incognitoWindowArgs } from '../../src/login.js'

const here = dirname(fileURLToPath(import.meta.url))
const loginSource = readFileSync(resolve(here, '../../src/login.ts'), 'utf8')

describe('incognitoWindowArgs（换账号登录的浏览器参数，IKM741 修法）', () => {
  it('① Chromium 系必须含**独立** --user-data-dir（否则复用上一个窗口的会话）', () => {
    const args = incognitoWindowArgs(
      'C:\\x\\360ChromeX.exe', 'https://a.example/', 'C:\\tmp\\prof1',
    )
    expect(
      args,
      '缺少 --user-data-dir ⇒ 第二个窗口加入第一个窗口的 cookie jar ⇒ 换账号登录失效',
    ).toEqual(['--user-data-dir=C:\\tmp\\prof1', '--incognito', '--new-window', 'https://a.example/'])
  })

  it('② profile 目录必须是**入参**（每次调用方给新目录），不得在纯函数里写死', () => {
    const a = incognitoWindowArgs('C:\\x\\chrome.exe', 'https://a.example/', 'C:\\tmp\\profA')
    const b = incognitoWindowArgs('C:\\x\\chrome.exe', 'https://a.example/', 'C:\\tmp\\profB')
    expect(a[0]).toBe('--user-data-dir=C:\\tmp\\profA')
    expect(b[0]).toBe('--user-data-dir=C:\\tmp\\profB')
    // ⚠️ 两次不同入参必须产出**不同**的参数（写死会让每次开窗共用同一个 jar）。
    expect(a[0], 'profile 写死 ⇒ 每次开窗共用同一个 jar ⇒ 修法失效').not.toBe(b[0])
  })

  it('③ Chromium 系的三个开关**都要在**（各自删掉都会坏）', () => {
    const args = incognitoWindowArgs('C:\\x\\msedge.exe', 'https://a.example/', 'C:\\tmp\\p')
    expect(args, '--incognito 是隔离的核心（删掉 ⇒ 复用日常会话）').toContain('--incognito')
    expect(args, '--new-window 缺了会复用已有窗口').toContain('--new-window')
    expect(args.some((a) => a.startsWith('--user-data-dir=')), '--user-data-dir 缺了 ⇒ 复用上一个窗口的 jar')
      .toBe(true)
    expect(args[args.length - 1], 'URL 必须在最后（否则浏览器可能不认后面参数）').toBe('https://a.example/')
  })

  it('④ Firefox 分支不得塞 --user-data-dir（它不认该参数，用 -profile）', () => {
    const args = incognitoWindowArgs(
      'C:\\x\\firefox.exe', 'https://a.example/', 'C:\\tmp\\prof3',
    )
    expect(args, 'Firefox 用 -private-window 且不认 --user-data-dir').toEqual(
      ['-private-window', 'https://a.example/'],
    )
  })

  /**
   * ⚠️ **登记一处刻意未修的缺口**（本用例是它的登记 + 回归锚点）。
   *
   * Firefox 的 `-private-window` 之间**同样共享**私有浏览会话 ⇒ Firefox 上
   * 「连续新建两个账号」仍会复用同一个号。修它要传 `-profile <新目录>`，但
   * **本机没有 Firefox**、无法实测它能否真正隔离 ⇒ 按仓库铁律
   * 「拿不到阈值就不定值」，**不凭猜测改**。
   */
  it('⑤ Firefox 的换号缺口如实登记（出现隔离参数即提示更新登记）', () => {
    const args = incognitoWindowArgs('C:\\x\\firefox.exe', 'https://a.example/', 'C:\\tmp\\prof4')
    expect(
      args.some((a) => a.startsWith('--user-data-dir') || a === '-profile'),
      'Firefox 分支出现隔离参数 ⇒ 若已实测可用，请把本用例与源码注释里的缺口登记一起更新，'
      + '别让「登记的缺口」与实现脱节',
    ).toBe(false)
  })

  /**
   * ⚠️⚠️ **纪律：本文件只许 import 纯函数，不得引入会开窗的函数**
   *（与 `officeace-incognito-login.spec.ts` 的 ⑪ 同源，只是解法不同 ——
   * 那条禁止**整个模块**，本文件允许纯函数、但必须钉死「没引入开窗函数」）。
   *
   * 判据锚在 **import 语句的具体名字**上：`openIncognitoWindow` / `openBrowser`
   * 一旦被 import 进本文件，单测就可能出现真开窗路径（2026-10-13 真实污染过
   * 用户桌面两次）。⚠️ 不锚「文件里有没有这个词」—— 上面几条用例的**失败文案里**
   * 就含这些词，那样会恒红（本仓库记过同型假失败）。
   */
  it('⑥ 本文件不得 import 任何会真开窗的函数（只许纯函数）', () => {
    const self = readFileSync(resolve(here, 'officeace-incognito-window-args.spec.ts'), 'utf8')
    const importLine = /^import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/login\.js['"]/m.exec(self)?.[1] ?? ''
    expect(importLine, '本文件应当从 src/login.js import（纯函数）').toContain('incognitoWindowArgs')
    expect(
      importLine,
      'import 了会真开窗的函数 ⇒ 单测里出现开窗路径会污染用户桌面（2026-10-13 真实事故）',
    ).not.toContain('openIncognitoWindow')
    expect(importLine, 'import 了 openBrowser 同理').not.toContain('openBrowser')
  })

  /**
   * ⑦ **源码级交叉确认**：生产装配处必须**真的把 profile 传进去**
   *（纯函数对了但调用点没传，等于没修 —— 本仓库「位置/键错位」事故族）。
   */
  it('⑦ 装配点必须把 profile 目录传给纯函数（不得退回自己拼参数）', () => {
    expect(
      loginSource,
      '装配点未调用 incognitoWindowArgs ⇒ 纯函数形同虚设（参数没真的生效）',
    ).toContain('incognitoWindowArgs(exe, url, profileDir)')
    expect(
      loginSource,
      '装配点未准备 profile 目录 ⇒ --user-data-dir 拿不到值',
    ).toContain('prepareIncognitoProfileDir()')
  })
})
