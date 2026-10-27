/**
 * ★★ ZCode 浏览器候选链的**家目录来源**回归测试（行为判据）。
 *
 * ## 为什么另立一个文件（而不是并进 zcode-browser-detection.spec.ts）
 *
 * 本文件用 `vi.mock('node:os')` 把 `homedir()` 换成**哨兵值** —— 这是
 * **文件级**的 mock，会改变同文件内所有 `homedir()` 的语义。
 * `zcode-browser-detection.spec.ts` 里的反向判据 `realHomeScoop()` 是
 * 「拿真实 `homedir()` 与注入值对比」，mock 会让它退化成弱判据。
 * ⇒ 分开，各守各的。
 *
 * ## 守的性质
 *
 * 默认家目录**只能**来自 `homedir()`，**绝不能**回落到 `process.env.USERPROFILE`。
 *
 * ## ⚠⚠ 为什么必须是**行为判据**，且为什么它此前被认为不可能
 *
 * `zcode-browser-detection.spec.ts` 的注释（及 Gitee issue IKJS58）里有一条
 * 关键论断：**Windows 上 `os.homedir()` 本身就取自 `USERPROFILE`**，
 * 所以「读 `homedir()`」与「读死 `USERPROFILE`」算出**同一个值**，
 * 任何「改 env 看结论」的判据都**不可能**区分二者，只能退回**源码结构判据**。
 *
 * 那个论断对**「改 env」**成立，但**漏了一条出路**：
 * 不改 env，而是**替换 `homedir()` 本身**。mock 之后：
 *
 * ```
 * homedir()  → 哨兵 __SENTINEL_HOME__      （实现若读它，候选里就是它）
 * USERPROFILE → __EVIL_USERPROFILE__       （实现若读它，候选里就是它）
 * ```
 *
 * 两者**不再相等**，「实现到底读了哪一个」直接体现在**输出里**
 * ⇒ 行为判据不仅可行，而且**与实现写法完全无关**（别名/拼接/计算属性名/
 * 括号访问/中间变量，全都在运行时归一为「到底取了哪个值」）。
 *
 * ⚠ 这比源码结构判据**严格更强**：见本文件末尾的对抗用例注释
 * （结构判据被 `env[['USER','PROFILE'].join('')]` 绕过，本判据抓住）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/** `homedir()` 的哨兵返回值：实现若正确读 `homedir()`，候选里就是它。 */
const SENTINEL_HOME = '__SENTINEL_HOME__'
/** `USERPROFILE` 的哨兵值：实现若错误读 env，候选里就是它。 */
const EVIL_USERPROFILE = '__EVIL_USERPROFILE__'

/**
 * ★ 把 `homedir()` 钉成哨兵（`tmpdir` 等其余 API 保持真实）。
 *
 * ⚠ `vi.mock` 的工厂会被**提升**到 import 之前，故工厂里**不能**直接引用
 * 模块级 `const`（会得到 `undefined` 或 TDZ 报错）。用 `vi.hoisted` 把值
 * 一起提升 —— 这样哨兵**只定义一次**，不存在「两处字面量必须一致」的脆弱点。
 *
 * ⚠ 实测确认 `vi.hoisted` 可用于此（2026-10-08，vitest 3.2.7）；
 * 早期版本注释里「`vi.hoisted` 不行」的说法是**错的**，已纠正。
 */
const { MOCKED_HOME } = vi.hoisted(() => ({ MOCKED_HOME: '__SENTINEL_HOME__' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => MOCKED_HOME }
})

/**
 * ⚠⚠ **导入时机是这条判据成立的关键，别挪回顶层。**
 *
 * `vi.mock('node:os')` 需要**先注册、再让被测模块求值**，mock 才能穿透到
 * 被测模块内部的 `import { homedir } from 'node:os'`。
 *
 * 实测（本机 Windows，2026-10-08）：在**模块顶层** `await import()` 会让
 * 被测模块拿到**真实** `node:os` —— 而 Windows 上真实
 * `homedir()` 恰好就读 `USERPROFILE`，于是判据看到的是「坏值」，
 * **正确实现被误判成红的**（`Received: "__EVIL_USERPROFILE__\scoop\…"`）。
 * 改为在 `beforeAll` 内加载即正常。
 *
 * ⚠ 导入路径是 `chromium-session.js`（2026-10-08 抽共享模块）：候选链已搬到
 * 那里，它才是**直接** `import { homedir } from 'node:os'` 的那个模块。
 * 经 `zcode-captcha.js` 的 re-export 间接取也行（mock 是模块级的，会穿透），
 * 但直连被测模块更贴近判据的意图：**家目录只来自 homedir()**。
 */
let browserCandidates: typeof import('../../src/chromium-session.js')['browserCandidates']
let findBrowserExecutable: typeof import('../../src/chromium-session.js')['findBrowserExecutable']
let homedirProbe: () => string

beforeAll(async () => {
  homedirProbe = (await import('node:os')).homedir
  const mod = await import('../../src/chromium-session.js')
  browserCandidates = mod.browserCandidates
  findBrowserExecutable = mod.findBrowserExecutable
})

/** 还原被本文件改写的环境变量。 */
const savedUserProfile = process.env.USERPROFILE
afterEach(() => {
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
})

describe('ZCode 家目录来源（行为判据）', () => {
  /**
   * ⚠ **扫描/mock 健壮性护栏**：判据依赖「`homedir()` 真的被替换了」。
   * 少了这条，若 mock 因重构（如工厂返回值形状变化）失效，
   * 下面那条会退化成「拿真实 `homedir()` 与哨兵比」的**弱判据**而无人察觉。
   */
  it('护栏：homedir() 确实被替换为哨兵（否则整条判据失效）', () => {
    expect(homedirProbe()).toBe(SENTINEL_HOME)
    // 且哨兵与「坏值」必须不同 —— 否则判据无法区分二者。
    expect(SENTINEL_HOME).not.toBe(EVIL_USERPROFILE)
  })

  /**
   * ★★ 核心判据：`USERPROFILE` 被改写时，候选链**必须仍用 `homedir()`**。
   *
   * 这条同时是 issue IKJS58 里那个「非 Windows 上恒真」用例的**正确形态**：
   * 它不再依赖 `USERPROFILE` 是 Windows 专属变量、也不依赖宿主平台。
   */
  it('★ USERPROFILE 被改写时，默认家目录仍取自 homedir()（不读 env）', () => {
    process.env.USERPROFILE = EVIL_USERPROFILE
    /**
     * ⚠ 必须把**真实的 `process.env`** 传进去 —— 这正是
     * `findBrowserExecutable()` 的调用形态（`browserCandidates()` 默认吃 `process.env`）。
     * 若只传一个干净 env，就测不到「实现会不会从 env 里偷家目录」。
     */
    const list = browserCandidates({ platform: 'win32', env: process.env })

    // ① 默认 `~/scoop` 候选必须建立在**哨兵**（= `homedir()`）之上。
    const scoopCandidate = list.find((c) => c.includes('scoop'))
    expect(scoopCandidate, '候选链里应有默认 ~/scoop 那一档').toBeDefined()
    expect(scoopCandidate, '默认家目录必须来自 homedir()').toContain(SENTINEL_HOME)

    // ② 整个候选链里**绝不能**出现来自 USERPROFILE 的路径。
    expect(
      list.join('\n'),
      '默认家目录不得来自 process.env.USERPROFILE（沙箱/CI 会改写它）',
    ).not.toContain(EVIL_USERPROFILE)
  })

  /**
   * ★ 配套：macOS / Linux 分支同样不得从 env 取家目录。
   *
   * ⚠ 这两条是**独立的**（不共享 `windowsBrowserCandidates` 的实现）——
   * 只测 win32 会漏掉「某个分支自己读 env」的改法。
   */
  it('★ darwin / linux 分支同样不读 USERPROFILE', () => {
    process.env.USERPROFILE = EVIL_USERPROFILE
    for (const platform of ['darwin', 'linux'] as const) {
      const list = browserCandidates({ platform, env: process.env })
      expect(list.join('\n'), `${platform} 分支不得读 USERPROFILE`).not.toContain(
        EVIL_USERPROFILE,
      )
      // 且确实用到了 homedir()（macOS 的 ~/Applications / linux 的 flatpak 档）。
      expect(list.join('\n'), `${platform} 分支应使用 homedir()`).toContain(SENTINEL_HOME)
    }
  })

  /**
   * ★★ **对抗用例**：`env` 是**合法**参数，故「用计算属性名从 `env` 取
   * `USERPROFILE`」能绕过**源码结构判据**（实测：9/9 全绿），
   * 但**绕不过本行为判据**。
   *
   * ```ts
   * // windowsBrowserCandidates 内（结构判据抓不到：不含 process.env / USERPROFILE 字面量）
   * const evilKey = ['USER', 'PROFILE'].join('')
   * const evilHome = env[evilKey] ?? home
   * // 然后用 evilHome 拼 ~/scoop
   * ```
   *
   * 本用例不注入该变异（那要改生产代码），而是把**它等价的行为**直接喂进
   * 公开 API：`env` 里带着 `USERPROFILE` 时，输出中不得出现该值。
   * ⚠ 与上面那条的区别：这条**不带 `platform: 'win32'` 之外的白名单**，
   * 且额外覆盖「实现从 `env` 里读取而非从 `process.env` 全局读」这条路径。
   */
  it('★ 即使 USERPROFILE 只出现在注入的 env 里（不经 process.env），也不得被采用', () => {
    // 刻意不碰 process.env，只放在注入的 env 字典里。
    const list = browserCandidates({
      platform: 'win32',
      env: { USERPROFILE: EVIL_USERPROFILE, ZCODE_CHROME_PATH: undefined },
    })
    expect(
      list.join('\n'),
      '注入的 env 里带 USERPROFILE 时同样不得采用（实现可能从 env 取值）',
    ).not.toContain(EVIL_USERPROFILE)
    expect(list.find((c) => c.includes('scoop'))).toContain(SENTINEL_HOME)
  })

  /**
   * ★★★ **最关键的一条：走「无参生产入口」** —— 封死「条件门」绕过。
   *
   * ## 为什么前面三条不够（两轮独立审计各自实测出的洞，2026-10-08）
   *
   * 上面三条用例**全都显式传了 `platform`**。于是这个坏实现能骗过**全部**判据
   * （本文件 4/4 全绿 + 结构判据 9/9 全绿 + 其它 browser 套件 37/37 全绿），
   * 而**生产已经坏了**：
   *
   * ```ts
   * // browserCandidates 的 else 分支
   * const winHome = input.platform === undefined
   *   ? (env['USER' + 'PROFILE'] ?? home)      // ← 只在「无参调用」时才偷 env
   *   : home                                    // ← 显式传 platform 时规矩如常
   * candidates = windowsBrowserCandidates(env, winHome)
   * ```
   *
   * 而生产的真实调用形态**恰恰是无参**：`findBrowserExecutable()` 里是
   * `for (const candidate of browserCandidates())`。
   *
   * 关键判据（判据而非感觉）：`input.platform === undefined` ⟺ 生产形态。
   * ⇒ **只要有一条用例以无参形态调用，这类门就无处可藏。**
   *
   * ## 做法
   *
   * 1. `process.platform` **钉成 win32** —— 否则判据又会退化成「只在 Windows 成立」，
   *    那正是 Gitee issue IKJS58 的病根。实测 `Object.defineProperty` 可行。
   * 2. `homedir()` 已被 mock 成 `__SENTINEL_HOME__`（不存在）；
   *    `USERPROFILE` 指向**真实存在**且种好 exe 的临时目录。
   *    ⇒ 「实现读了哪一个」在输出里**直接可见**，且 `findBrowserExecutable()` 的
   *    `existsSync` 判据会把结论**放大**成「找到 / 找不到」。
   * 3. 无参调用 `browserCandidates()` 与 `findBrowserExecutable()`。
   */
  it('★★★ 无参调用（生产入口）时也不得从 USERPROFILE 取家目录', () => {
    // 造出「USERPROFILE 指向的目录里真的有一个 scoop chromium」。
    const evilRoot = mkdtempSync(join(tmpdir(), 'zcode-evil-home-'))
    const evilApps = join(evilRoot, 'scoop', 'apps', 'chromium', 'current')
    mkdirSync(evilApps, { recursive: true })
    writeFileSync(join(evilApps, 'chrome.exe'), '')

    const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const savedProfile = process.env.USERPROFILE
    try {
      // 钉住宿主平台：判据不能依赖「跑在 Windows 上」。
      Object.defineProperty(process, 'platform', {
        configurable: true, writable: true, value: 'win32',
      })
      process.env.USERPROFILE = evilRoot

      // ① 无参调用 —— 与生产 `findBrowserExecutable()` 内部逐字同形。
      const list = browserCandidates()
      expect(
        list.join('\n'),
        '无参调用时不得从 process.env.USERPROFILE 取家目录（条件门绕过）',
      ).not.toContain(evilRoot)
      expect(
        list.find((c) => c.includes('scoop')),
        '无参调用时默认家目录仍须来自 homedir()',
      ).toContain(SENTINEL_HOME)

      // ② 真正的生产出口：它内部就是无参 `browserCandidates()`。
      //    `USERPROFILE` 下那个 exe **真实存在** ⇒ 若实现读了 env，这里必然返回它。
      const found = findBrowserExecutable()
      expect(
        found ?? '',
        'findBrowserExecutable() 不得返回 USERPROFILE 下探测到的浏览器',
      ).not.toContain(evilRoot)
    } finally {
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      if (savedPlatform !== undefined) {
        Object.defineProperty(process, 'platform', savedPlatform)
      }
      rmSync(evilRoot, { recursive: true, force: true })
    }
  })
})
