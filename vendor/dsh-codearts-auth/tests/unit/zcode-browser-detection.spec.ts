/**
 * ZCode **浏览器探测**的回归测试。
 *
 * ## 守的是什么（两个实测踩过的真缺陷）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', 'Application', 'chrome.exe')` 返回
 * `Google\Chrome\Application\chrome.exe` —— 一个**相对路径**。
 * `existsSync` 相对**当前工作目录**解析，于是：
 *   - 「当前目录下恰好有同名文件」会被误判成浏览器；
 *   - 真正的浏览器却可能找不到。
 *
 * ⇒ 只接受**绝对路径**候选。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 默认装在 `~/scoop`，而 `~` 应当用 `os.homedir()` 求。
 * 用 `process.env.USERPROFILE` 拼路径时，**一旦该变量被改写**
 * （沙箱、CI、异常环境），原本可用的 scoop chromium 就找不到了 ——
 * 实测：把 `USERPROFILE` 指到临时目录后，`findBrowserExecutable()`
 * 返回 undefined，而 `ZCODE_CHROME_PATH` 一设就好。
 *
 * ⚠⚠ 这条**只靠行为判据守不住**（本机实测，Windows）：`os.homedir()` 在
 * Windows 上本身就取自 `USERPROFILE`，把实现改成读死 env 后新旧行为**逐字相同**。
 * ⇒ 末尾的「默认家目录不回落到 `process.env.USERPROFILE`」用**源码结构判据**守。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserCandidates, findBrowserExecutable } from '../../src/zcode-captcha.js'

/** 被扫描的源码文件（本文件针对的正是它）。 */
const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'zcode-captcha.ts',
)

/**
 * 剥掉注释，只留可执行代码。
 *
 * ⚠ 必须剥：本文件多处注释正是在解释「**为什么不用** `USERPROFILE`」，
 * 不剥会把这些说明当成违规（反之，实现里新加的中文注释也一样）。
 * 范式取自 `raccoon-client-independence.spec.ts`。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取某个具名函数的**函数体**（按配对大括号切，不靠正则猜边界）。 */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  expect(start, `源码里应能找到 ${name}`).toBeGreaterThan(-1)
  const open = code.indexOf('{', start)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  throw new Error(`${name} 的函数体括号不配对`)
}

/** 临时环境变量的设置/还原。 */
const saved: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(saved)) delete saved[k]
})

describe('ZCode 浏览器探测', () => {
  it('★ ZCODE_CHROME_PATH 显式指定时优先（且必须是绝对路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-'))
    try {
      const exe = join(dir, 'chrome.exe')
      writeFileSync(exe, '')
      setEnv('ZCODE_CHROME_PATH', exe)
      expect(findBrowserExecutable()).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ ZCODE_CHROME_PATH 是**相对路径**时被忽略（防 CWD 误匹配）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-rel-'))
    const cwdSaved = process.cwd()
    try {
      /**
       * ⚠ 诱饵文件放在**专属临时目录**并 `chdir` 进去，**不写 `process.cwd()`**
       * （Gitee issue IKJMQ5，本机实测复现）。
       *
       * 相对路径是**相对 CWD** 解析的，所以「CWD 里有同名文件」这个前提不能省 ——
       * 但把它实现成「往仓库根写一个**固定名**文件」会引入两个真问题：
       *
       * ① **并行跑必炸，且是假失败**：另一个 vitest 进程正持有同名文件的句柄时，
       *    Windows 的删除直接 `EPERM`，而 `rmSync(..., { force: true })` 的
       *    `force` **只吞 ENOENT、不吞 EPERM** ⇒ 异常从 `finally` 抛出，
       *    用例变红。**被测代码行为完全正确**，红的是脚手架。
       *    实测（本机，8 个 vitest 进程并发）：8 轮 80 次 → 2 次红；
       *    4 并发 100 次 → 2 次红；2 并发 80 次 → 0 次红。
       *    ⚠ 单次 `vitest run` **不会**触发（同一文件在一个进程里只跑一次），
       *    所以这是「多进程共享同一工作区」才暴露 —— CI 并行 job、
       *    本地同时跑两条测试、IDE 里 watch 与手动跑重叠都会撞上。
       * ② **会往仓库根留垃圾**：进程被 kill / 超时时 `finally` 不执行，
       *    `chrome-rel-test.exe` 就留在仓库根进 `git status`。
       *
       * ⇒ 修法：诱饵文件随 `mkdtempSync` **每个进程独占**，CWD 由 `chdir`
       * 临时切进该目录，测完在 `finally` 里切回。
       * ⚠ `process.chdir` 需要 worker 是**真进程**（vitest 默认 pool `forks`；
       * 若哪天改成 `threads` 会抛 `ERR_WORKER_UNSUPPORTED_OPERATION`，
       * 那时这条会**响亮地**失败，而不是静默失去覆盖）。
       */
      const relative = 'chrome-rel-test.exe'
      writeFileSync(join(dir, relative), '')
      process.chdir(dir)
      setEnv('ZCODE_CHROME_PATH', relative)
      // ⚠ 相对路径不该被接受（否则会误把它当浏览器）。
      const found = findBrowserExecutable()
      expect(found).not.toBe(relative)
      if (found !== undefined) expect(isAbsolute(found)).toBe(true)
    } finally {
      process.chdir(cwdSaved)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 环境变量为空时不产生相对路径候选（只能返回绝对路径或 undefined）', () => {
    // 清掉所有可能来源，只留一个不存在的 override。
    for (const k of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'SCOOP', 'SCOOP_GLOBAL']) {
      setEnv(k, undefined)
    }
    setEnv('ZCODE_CHROME_PATH', join(tmpdir(), 'definitely-no-such-browser.exe'))
    const found = findBrowserExecutable()
    // 要么 undefined，要么绝对路径；**绝不能**是相对路径。
    if (found !== undefined) expect(isAbsolute(found)).toBe(true)
  })

  it('★ 探测跟随 os.homedir()：home 注入口优先于进程真实家目录', () => {
    /**
     * ★ 这条断言的方向改过三次，记下来免得后人又写错。
     *
     * 1. 最初断言「改 `USERPROFILE` 后仍能找到 `~/scoop` 的浏览器」——
     *    要求 `homedir()` 不变，而独立 node 进程里它首次调用后就缓存（121）。
     * 2. 改成「探测结论与 `homedir()` 一致」——方向对了，但仍**测不到目标**：
     *    它靠 `setEnv('USERPROFILE', dir)` 让家目录变化，而 `USERPROFILE` 是
     *    **Windows 专属变量**。darwin / linux 上它是空操作，实测：
     *        homedir() 改前 = /Users/gandhi
     *        homedir() 改后 = /Users/gandhi   ← 完全没变
     *        临时目录含 AppData\Local\Temp = false（POSIX 形态）
     *    于是走 `else` 分支，而该分支唯一的判据断言检查的是 **Windows 形态
     *    子串** `AppData\Local\Temp\zcode-browser-home-`，在本机永远不可能出现
     *    ⇒ **恒真断言等于没有断言**。
     *
     * 反向验证（决定性）：把实现改成读死 env，该用例在 macOS 上**照样全绿**：
     *        - const home = input.home ?? homedir()
     *        + const home = input.home ?? process.env.USERPROFILE ?? homedir()
     *        → ✓ 探测跟随 os.homedir()  0ms
     *
     * ⇒ 现在照 `SCOOP 优先于默认 ~/scoop` 的范式：走纯函数
     * {@link browserCandidates}、把平台钉死、让 `home` 注入口与「进程真实家目录」
     * 取**不同的值**，于是「实现是否真的采用注入口」成为可失败判据。
     */
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-home-'))
    try {
      const appsDir = join(dir, 'scoop', 'apps', 'chromium', 'current')
      mkdirSync(appsDir, { recursive: true })
      const exe = join(appsDir, 'chrome.exe')
      writeFileSync(exe, '')

      const candidates = browserCandidates({
        platform: 'win32',
        env: { ZCODE_CHROME_PATH: undefined },
        // ⚠ 刻意给一个**不同于真实家目录**的值：判据成立的唯一前提就是这个差异。
        home: dir,
      })

      // 判据 1：注入的家目录被采用 —— 默认 `~/scoop` 路径的第一条即命中它。
      expect(candidates[0]).toBe(exe)
      // 判据 2：若实现忽略注入口、改读 `homedir()`，首条就**不会**是它 ⇒ 变红。
      expect(candidates[0]).not.toContain(realHomeScoop())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * 真实家目录下的默认 scoop 路径（用于「实现是否读了真实 `homedir()`」的反向判据）。
   *
   * ⚠ 单独抽成函数而不是内联 `homedir()`：内联的话，`home: dir` 与判据 2 用的是
   * 同一个值，判据 2 会退化成「`exe` 不含它自己」的恒真断言 —— 与它要防的
   * 恒真问题同型。这里刻意让两者取不同的来源。
   */
  function realHomeScoop(): string {
    return join(homedir(), 'scoop', 'apps', 'chromium', 'current', 'chrome.exe')
  }

  it('★ SCOOP 显式声明的根目录**优先于**默认 ~/scoop', () => {
    /**
     * ⚠⚠ **必须显式传 `platform: 'win32'`** —— 判据是**候选顺序**，不是
     * 「本机能不能找到那个 exe」。
     *
     * ## 这条用例踩过的坑（2026-10-06，Gitee issue IKJPBJ 评论里由 @Ghandi 暴露）
     *
     * 它原先调 `findBrowserExecutable()`，而那个函数内部读**宿主** `process.platform`：
     *
     * - 在 macOS 补 darwin 分支**之前**，macOS 落进 win32 分支 ⇒ `SCOOP` 生效 ⇒
     *   临时造的 exe 排第一 ⇒ 用例通过（**靠巧合**）；
     * - 补了 darwin 分支**之后**，macOS 走 `/Applications/…` 那条链，`SCOOP`
     *   **被完全忽略** ⇒ 返回真实 Chrome（或 `undefined`）⇒ **必然失败**。
     *
     * 实测证据（`browserCandidates` 注入同一个 `SCOOP`）：
     * ```
     * win32  → 首条 C:\tmp\fake-scoop\apps\chromium\current\chrome.exe
     * darwin → 含任何 scoop 路径: false；首条 /Applications/Google Chrome.app/...
     * ```
     *
     * ⇒ 这不是「macOS 环境没配好」，是**用例本身只在 Windows 成立**。
     * 改调纯函数 {@link browserCandidates} 并把平台钉死，任意宿主上都跑同一份。
     *
     * ⚠ `SCOOP` 只在 win32 分支被读：它是 scoop（Windows 包管理器）的概念，
     * darwin / linux 分支里**根本没有**这一档 —— 下面第 2 条断言把这条契约锁死。
     */
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-scoop-'))
    try {
      // 造一个符合 scoop 布局的路径：<root>/apps/chromium/current/chrome.exe
      const appsDir = join(dir, 'apps', 'chromium', 'current')
      mkdirSync(appsDir, { recursive: true })
      const exe = join(appsDir, 'chrome.exe')
      writeFileSync(exe, '')

      const candidates = browserCandidates({
        platform: 'win32',
        env: { ZCODE_CHROME_PATH: undefined, SCOOP: dir },
        home: homedir(),
      })
      /**
       * ⚠ 断言「第一条就是自定义那个」而不是「包含它」—— `SCOOP` 是 scoop 自己
       * 的权威声明，用户设了就说明默认路径不对。若实现把它排在 `~/scoop`
       * 之后，会先命中真实的 `~/scoop/.../chrome.exe`（实测第一版就是这么错的）。
       *
       * ⚠ 判据落在**候选链**而不是 `findBrowserExecutable()`：后者要过
       * `existsSync`，在本机会被真实安装的 Chrome 抢走第一名。
       */
      expect(candidates[0]).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * 上面那条的**配套契约锁**：`SCOOP` 是 Windows 概念，darwin 分支里不得出现。
   * ⚠ 这条同时是上面那条的**反向验证**——若有人把 darwin 分支去掉、或让 SCOOP
   * 跨平台生效，它会立刻变红。
   */
  it('★ SCOOP / SCOOP_GLOBAL 只在 win32 分支被读（darwin · linux 一律忽略）', () => {
    const injected = { SCOOP: 'D:\\scoop', SCOOP_GLOBAL: 'E:\\gscoop' }
    expect(browserCandidates({ platform: 'win32', env: injected, home: 'C:\\u' })
      .some((c) => c.includes('scoop'))).toBe(true)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(browserCandidates({ platform, env: injected, home: '/home/u' })
        .some((c) => c.includes('scoop'))).toBe(false)
    }
  })

  /**
   * ★★ 默认家目录**只**来自 `homedir()`，不得读 `USERPROFILE`（PR #75 补齐）。
   *
   * ## 为什么必须另立一条，而不是靠上面那条
   *
   * 上面那条（`home` 注入口优先）只证明「**注入口**被尊重」，
   * 证明不了「**没给注入口时**回落到 `homedir()`」——而后者才是本文件
   * 文件头「### 2. `USERPROFILE` 不等于家目录」那条**真正要守**的性质。
   *
   * ## ⚠⚠ 判据为什么不能靠「改 `USERPROFILE` 再看结论」
   *
   * 本机（Windows）实测复刻了旧用例并对读死 env 的变异做过对照：
   * ```
   * 未变异：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-KGiOeH
   *         found = undefined（临时目录里本就没有 scoop）
   * 变异后：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-RP5R3e
   *         found = undefined            ← 与未变异**逐字相同** ⇒ 用例照样全绿
   * ```
   * 根因：**Windows 上 `os.homedir()` 本身就取自 `USERPROFILE`** ——
   * 两种实现算出的家目录是**同一个值**，任何基于「结论是否变化」的判据
   * 都不可能区分它们。旧用例正是栽在这里。
   * ⇒ 唯一可失败的做法是**结构判据**：直接扫源码，看默认表达式里有没有 `USERPROFILE`。
   * 范式取自 `raccoon-client-independence.spec.ts` 的「不读取任何环境变量」。
   */
  it('★ 默认家目录不回落到 process.env.USERPROFILE（源码结构判据）', () => {
    const source = readFileSync(sourcePath, 'utf8')
    // 剥掉注释：文档里大量解释「为什么**不**用 USERPROFILE」，不能算成违规。
    const code = stripComments(source)

    // ⚠ 必须扫**整个**候选链构造路径，而不只是 browserCandidates 那一个赋值点：
    // windows / mac / linux 三个分支函数都吃 `home` 参数，若某分支改成自己读
    // `process.env.USERPROFILE`，上面那条注入口用例**照样全绿**。
    for (const fn of ['windowsBrowserCandidates', 'macBrowserCandidates', 'linuxBrowserCandidates']) {
      const body = fnBody(code, fn)
      expect(body, `${fn} 不得自行读取 process.env.USERPROFILE`).not.toContain('USERPROFILE')
      expect(body, `${fn} 不得自行读取 process.env.HOME`).not.toContain('process.env.HOME')
    }

    // 默认回落必须仍是 homedir()：注入口缺省时用它。
    expect(code).toMatch(/const\s+home\s*=\s*input\.home\s*\?\?\s*homedir\(\)/)
    // ⚠ 兜住「有人把 USERPROFILE 又加回 ?? 链」这种改法
    //   （上面那条正则锚定的是完整表达式，加在后面就匹配不上而变红）。
    expect(code, 'home 默认值不得混入 USERPROFILE').not.toMatch(
      /const\s+home\s*=[^\n]*USERPROFILE/,
    )
  })

  /**
   * 上面那条的**扫描健壮性护栏**：判据依赖「扫到的是真源码」。
   *
   * ⚠ 同 `raccoon-client-independence.spec.ts` 的做法 —— 扫描类断言必须先证明
   * 扫到了东西，否则「一个文件都没扫到」会让整条判据静默恒真。
   */
  it('★ 结构判据确实扫到了候选链实现（防止扫描失效而恒真）', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'))
    // 三条分支函数 + 出口函数，缺一即说明扫描路径变了。
    for (const fn of [
      'windowsBrowserCandidates',
      'macBrowserCandidates',
      'linuxBrowserCandidates',
      'browserCandidates',
    ]) {
      expect(code).toContain(`function ${fn}(`)
    }
    // 确认剥注释后正文仍在（否则说明 stripComments 过度，把代码也吃掉了）。
    expect(code).toContain('join(')
  })
})
