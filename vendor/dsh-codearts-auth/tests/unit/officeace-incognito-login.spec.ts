/**
 * `officeace-incognito-login.spec.ts` —— OfficeAce **换账号登录**（无痕窗口）守卫。
 *
 * ## 这个文件为什么存在（2026-10-13 用户报障）
 *
 * > 「新建账号那个链接就自动用之前登录的账号授权了」
 *
 * 根因**不在我们的授权链接参数**（`state` / `code_challenge` 每次都是新随机值，
 * PKCE 完整），而在**华为 authui 会静默复用浏览器已有登录会话**。实测三条：
 *
 * | 试验 | 结果 |
 * |---|---|
 * | `authui/login.html?service=<authorize>` | 200 直接放行（复用会话）|
 * | authorize 追加 `&prompt=login` | **仍 200、无重定向** ⇒ authui 忽略该参数 |
 * | `authui/logout?service=<authorize>` | 302 先清会话再跳 authorize |
 *
 * ⇒ 只能「先 logout」或「换 cookie jar」。**选后者**：`logout` 的作用域是整个
 * `auth.huaweicloud.com` 域（实测 `Set-Cookie` 含 `cloud_verify_ticket` 清除、
 * `IAMIdentity` 重写），会**连带登出用户日常浏览器里的华为云控制台**；
 * 无痕窗口是全新 cookie jar，天然无会话，且不碰用户既有会话。
 *
 * ⚠️ 客户端做不到这一点（`window.open` 无法请求无痕 —— 那是进程级启动参数），
 * 必须由宿主 `spawn` 浏览器可执行文件，故本文件锁的是**接线**。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const loginSource = readFileSync(resolve(here, '../../src/login.ts'), 'utf8')
const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

describe('openIncognitoWindow（宿主侧拉起无痕窗口）', () => {
  /**
   * ⚠️⚠️ **本文件是「只做源码级断言」的**（2026-10-13，用户明确要求）。
   *
   * > 「打开浏览器窗口的测试只能放在 e2e 测试里」
   *
   * 我最初在这里调用了真实的 `openIncognitoWindow`（想验「不抛错、返回 boolean」），
   * 而该函数**会真的 `spawn` 浏览器** ⇒ 每跑一次 `pnpm test` 就在用户桌面上弹窗。
   * 真开窗的行为验证已移到 `tests/e2e/officeace-incognito-login.e2e.spec.ts`
   * （带 `DSH_OFFICEACE_E2E=1` 闸门，默认跳过）。
   *
   * ⇒ 本文件**只读源码文本**。失败路径的契约（`return false` 兜底、不抛错）
   * 用源码级断言锁住 —— 它对重构中立，且零副作用。
   */
  it('① 失败路径必须 return false 兜底（绝不抛错，保证上层能回退）', () => {
    const fn = loginSource.slice(loginSource.indexOf('export function openIncognitoWindow'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // 读不到浏览器 ⇒ 回退（而不是抛错让「新建账号」直接失败）
    expect(body, '缺少 exe === undefined 时的 return false')
      .toMatch(/if \(exe === undefined\) return false/)
    // spawn 同步抛错 ⇒ 也必须兜成 false
    expect(body, 'spawn 同步抛错时未 return false').toMatch(/catch[\s\S]{0,200}return false/)
    // 全程不得出现 throw（抛错会让上层无法回退）
    expect(body, 'openIncognitoWindow 不得抛错').not.toContain('throw')
  })

  it('② 用 --incognito 达成「换 cookie jar」（这是本功能的核心，不是可选优化）', () => {
    // ⚠️ 删掉 `--incognito` 会让本功能**完全失效**（退回复用会话），
    //    而症状与修复前逐字相同 ⇒ 必须有守卫钉住它。
    expect(loginSource, '缺少 --incognito：无痕隔离失效，换账号登录会退回复用旧会话')
      .toContain("'--incognito'")
  })

  it('③ Firefox 走 -private-window（它不认 --incognito，传错等于普通窗口）', () => {
    expect(loginSource, 'Firefox 分支缺失 ⇒ 在 Firefox 上又变回复用会话')
      .toContain('-private-window')
    expect(loginSource).toContain('firefox')
  })

  it('④ spawn 失败必须挂 error 监听器（否则未捕获异常带走宿主进程）', () => {
    // 与 `openBrowser` 同款教训（`src/login.ts` 的长注释）：spawn 的失败是
    // **异步 'error' 事件**，外层 try/catch 接不住，无监听器时会被 throw 成
    // 未捕获异常。POSIX 上「浏览器不存在」是常态。
    const fn = loginSource.slice(loginSource.indexOf('export function openIncognitoWindow'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body, "spawn 后未挂 'error' 监听器").toContain("child.on('error'")
    expect(body, '缺少 unref ⇒ 父进程可能被这个子进程拖住').toContain('child.unref()')
  })

  /**
   * ⚠️⚠️ **不得使用 `--app=`**（2026-10-13 真机实测证伪，阻断级）。
   *
   * 初版用 `--app=${url}` 想做成无地址栏的纯净小窗。在 360 极速浏览器 X
   * （本机默认浏览器）上实测：窗口开了，但页面显示
   * 「**域名解析错误**」—— 它把 `--app=` 的值当域名去解析。
   *
   * 隔离探针（本地 HTTP 服务器 + 独立 `--user-data-dir`）证明 `--app=` 参数
   * 本身能被正确解析并发出请求 ⇒ 是**该浏览器对 `--app=` 的改写**，
   * 不是 URL 编码问题（实测 28 个 `%` 序列逐字送达）。
   *
   * ⇒ 换取账号的核心目的**不依赖** `--app=`，而它带来的失败是阻断级的
   *（用户看到错误页、根本无法登录）。故本用例把它钉死为「不得出现」。
   */
  it('⑤ 不得使用 --app=（国产浏览器会把它当域名解析 ⇒ 「域名解析错误」阻断登录）', () => {
    const fn = loginSource.slice(loginSource.indexOf('export function openIncognitoWindow'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body, "重新引入 --app= 会在 360 等浏览器上显示「域名解析错误」，用户无法登录")
      .not.toContain('--app=')
  })
})

describe('RPC 接线：宿主开窗结果必须回传，客户端据此决定是否自己开', () => {
  it('⑥ account.create 的 OfficeAce 分支调用 openIncognitoWindow 并回传 incognitoOpened', () => {
    expect(rpcSource, 'officeace 分支未调用 openIncognitoWindow ⇒ 无痕窗口永不出现')
      .toContain('openIncognitoWindow(started.authorizeUrl)')
    expect(rpcSource, '未回传 incognitoOpened ⇒ 客户端无从判断，会重复开一个普通窗口')
      .toContain('incognitoOpened')
  })

  /**
   * ⚠️⚠️ **判据必须精确匹配 `=== true`**（升级期安全阀）。
   *
   * 老宿主不返回 `incognitoOpened`（`undefined`）。若客户端写成 `!== false`
   * 或真值判断，升级期会出现「宿主没开、客户端也不开」= **窗口根本不出来** ——
   * 比修复前更糟（修复前至少能开窗，只是复用账号）。
   */
  it('⑦ 客户端判据是 `=== true`（不得写成真值或 !== false，否则升级期无窗可开）', () => {
    expect(clientSource, "缺少 `res.incognitoOpened === true` 精确判据")
      .toContain('res.incognitoOpened === true')
    expect(clientSource, '把判据写成 !== false 会让 undefined 走进「已开」分支 ⇒ 窗口不出来')
      .not.toContain('res.incognitoOpened !== false')
  })

  it('⑧ 非 OfficeAce 走回退分支，仍然是普通 window.open（其余 provider 行为不变）', () => {
    // ⚠️ 本改动只该影响 officeace。若把 `window.open` 整个删掉，
    //    另外 14 家的登录会**全部**失效。
    expect(clientSource, '普通 window.open 回退被删除 ⇒ 其余 provider 无法登录')
      .toContain('openAccountLoginWindow({ provider, loginUrl')
  })

  it('⑨ 无痕窗口打开后登录轮询照常进行（轮询不依赖浏览器 cookie）', () => {
    // 实测：`GET /v1/claw/auth/code?state=` 是**匿名服务端轮询**，
    // 与浏览器 cookie 无关 ⇒ 无痕窗口完成授权后宿主照样拿得到 code。
    // 若哪天有人把轮询改成依赖浏览器回跳，这条会红。
    expect(clientSource, '无痕分支也必须进入轮询（否则登录永远不会完成）')
      .toContain("rpcCall('login.poll'")
  })

  /**
   * ⚠️⚠️ **元守卫：测试环境必须切断真开窗**（2026-10-13，真实污染事件）。
   *
   * `officeace-rpc-multi-account.spec.ts` 走的是**真实的 `account.create` RPC**，
   * 其桩数据里带着 `authorizeUrl: 'https://auth.huaweicloud.com/stub'`。
   * 接线后每跑一次 `pnpm test`，宿主就真去 `spawn` 浏览器打开那个桩 URL ⇒
   * **用户桌面上弹出一堆 `auth.huaweicloud.com/stub` 窗口**（用户原话：
   * 「打开一堆空白窗口没用，挡我视线」）。
   *
   * ⇒ 修法是按**运行环境**一刀切断（`NODE_ENV === 'test'` 恒返回 `false`），
   * **不是**按 URL 特征打补丁（换个用例换个 URL 就会复发）。
   * 本用例锁死该断路器与它的判据方向。
   */
  it('⑩ 测试环境必须短路返回 false（否则跑测试会弹一堆浏览器窗口）', () => {
    const fn = loginSource.slice(loginSource.indexOf('export function openIncognitoWindow'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body, '缺少测试环境断路器 ⇒ `pnpm test` 会在用户桌面弹出真实浏览器窗口')
      .toMatch(/NODE_ENV\s*===\s*['"]test['"][\s\S]{0,40}return false/)
  })

  /**
   * ⚠️⚠️ **架构约束：真开窗的测试只能放 e2e**（2026-10-13 用户明确要求）。
   *
   * > 「打开浏览器窗口的测试只能放在 e2e 测试里」
   *
   * 本用例锁住这条纪律：单测目录里**不得**出现真正的打开窗口调用。
   * 判据用「单测文件里是否 import 了会开窗的模块」—— 精确且对重构中立。
   */
  it('⑪ 单测不得真开窗：开窗的行为测试必须放在 tests/e2e/ 下', () => {
    const self = readFileSync(resolve(here, 'officeace-incognito-login.spec.ts'), 'utf8')
    // ⚠️ 本文件作为「单测」的样板，必须自身不 import 会开窗的模块。
    expect(self, '单测 import 了 src/login.js ⇒ 有真开窗风险（应移到 e2e）')
      .not.toMatch(/from\s+['"][^'"]*\/login\.js['"]/)
    // 且 e2e 版本必须存在（否则真开窗的验证就没人做了）。
    expect(
      existsSync(resolve(here, '../e2e/officeace-incognito-login.e2e.spec.ts')),
      '缺少 e2e 版本 —— 真开窗行为应验证在 tests/e2e/ 下',
    ).toBe(true)
  })

  /**
   * ⚠️⚠️ **元守卫：e2e 必须能与单测区分开**（Gitee issue IKM741 期间实测查出的
   * **既有结构性缺陷**，2026-10-16）。
   *
   * ⑩ 的断路器是「`NODE_ENV === 'test'` ⇒ 返回 `false`」，而 Vitest **默认**
   * 把 `NODE_ENV` 设成 `'test'` —— **对 `vitest.e2e.config.ts` 也一样**
   * （已实测打印确认）。两个各自正确的东西叠在一起，产生一个**静默失效**：
   *
   * ```
   * officeace-incognito-login.e2e.spec.ts 断言 openIncognitoWindow(...) === true
   *   ⇒ 在 NODE_ENV=test 下恒拿到 false
   *   ⇒ 那条 e2e 从写下的那天起就不可能通过（2026-10-16 实测确认；
   *      同文件的对照用例走 openBrowser（无断路器）⇒ 恒绿，对比极不明显）
   * ```
   *
   * ⇒ 修法在**配置层**：`vitest.e2e.config.ts` 用 `test.env` 把 e2e 标成 `'e2e'`。
   * 断路器的**判据方向逐字不变**（仍按运行环境一刀切断、仍不按 URL 特征打补丁），
   * 只是给「e2e 是另一种运行环境」这个既有事实一个名字。
   *
   * 本用例锁三件事，缺一即红：
   * 1. e2e config 真的设了 `NODE_ENV`（且**不是** `'test'`）；
   * 2. 单测 config **不得**设它（否则单测也会真开窗 —— 那正是 ⑩ 要防的污染）；
   * 3. 断路器仍在（⑩ 已锁，这里只交叉确认它认的仍是 `'test'`）。
   */
  it('⑫ e2e 必须与单测区分运行环境，否则真开窗的 e2e 永远不可能通过', () => {
    const e2eConfig = readFileSync(resolve(here, '../../vitest.e2e.config.ts'), 'utf8')
    const unitConfig = readFileSync(resolve(here, '../../vitest.config.ts'), 'utf8')

    // 1. e2e 必须显式声明自己的运行环境，且不是 `'test'`。
    const e2eEnv = /NODE_ENV\s*:\s*['"]([^'"]+)['"]/.exec(e2eConfig)
    expect(
      e2eEnv?.[1],
      'vitest.e2e.config.ts 未设 NODE_ENV ⇒ 它默认是 `test` ⇒ `openIncognitoWindow` '
      + '的断路器恒返回 false ⇒ 无痕窗口的 e2e **永远不可能通过**（静默失效）',
    ).toBeDefined()
    expect(
      e2eEnv?.[1],
      'e2e 的 NODE_ENV 不得是 `test` —— 那正是断路器的判据，会让 e2e 恒短路由 false',
    ).not.toBe('test')

    // 2. 单测 config 不得设它：单测必须留在 `test`（Vitest 默认），
    //    否则「跑单测弹用户桌面窗口」那次真实污染会复发。
    expect(
      unitConfig,
      'vitest.config.ts 设了 NODE_ENV ⇒ 单测可能不再落在断路器的 `test` 分支，'
      + '真开窗污染（2026-10-13 事故）就会复发',
    ).not.toMatch(/NODE_ENV\s*:/)

    // 3. 交叉确认断路器仍在（⑩ 锁的是它，这里确认它认的字面量没被改成 e2e 的值）。
    expect(loginSource, '断路器不得被改成认 e2e 的值（那会让 e2e 的断言失去意义）')
      .toMatch(/NODE_ENV\s*===\s*['"]test['"]/)
  })
})
