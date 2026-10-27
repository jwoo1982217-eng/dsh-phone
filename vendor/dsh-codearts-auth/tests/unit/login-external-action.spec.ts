/**
 * 「登录失败的**出路在外部**」这条标记契约的守卫（2026-10-20 用户报障）。
 *
 * ## 背景
 *
 * `jet-hub-rpc.ts` 的 `loginFailureMessage()` 原先**无条件**给所有登录失败拼上
 * 「请重新点击「+ 新建账号」」。但有一类失败的出路**在外部**：
 * - OfficeAce「尚未开通 ModelArts MaaS」⇒ 去**果办客户端**点开通并同意授权；
 * - AStudio 会话失效 ⇒ 去 **AStudio 桌面端**重新微信扫码。
 *
 * 那些情形重新点「+ 新建账号」只会重走一遍授权、**然后再失败一次** ⇒ 那半句是
 * **假出路**（把用户锚在一个永远不会成功的动作上，还冲淡了内层唯一有用的指路）。
 *
 * 修法：**抛错方**打标记，收尾处按标记分支。
 *
 * ## 本文件守什么
 *
 * ① 标记契约本身的真值表（含 fail-closed 边界与「不可枚举」）；
 * ② `astudio` 终态类的**每个**实例都被标记（构造函数一处覆盖全部抛错点）。
 *
 * ⚠️ 「文案分支」那一格**不在这里**：它需要完整的 RPC 夹具，见
 *    `login-poll-terminal-failure.spec.ts` 的「带标记不得加通用后缀 / 未标记必须加」两条。
 */
import { describe, expect, it } from 'vitest'
import {
  loginNeedsExternalAction,
  markLoginNeedsExternalAction,
} from '../../src/login-failure.js'
import { AstudioRefreshTokenExpiredError } from '../../src/astudio-auth.js'

describe('标记契约：markLoginNeedsExternalAction / loginNeedsExternalAction', () => {
  it('标记后判据为 true', () => {
    const e = markLoginNeedsExternalAction(new Error('尚未开通'))
    expect(loginNeedsExternalAction(e)).toBe(true)
  })

  it('返回**同一个** Error 实例（支持 `throw mark…(new Error(…))` 的内联写法）', () => {
    const e = new Error('x')
    expect(markLoginNeedsExternalAction(e)).toBe(e)
  })

  it('未标记 ⇒ false', () => {
    expect(loginNeedsExternalAction(new Error('普通失败'))).toBe(false)
  })

  it('⚠️ fail-closed：非对象 / null / undefined / 字符串 / 数字一律 false', () => {
    // ⚠️ 方向很要紧：判 false ⇒ **照旧**加「请重新点击」后缀。
    //    误留后缀只是不精确；误判 true 会把用户唯一有用的指路删掉。
    for (const v of [undefined, null, '字符串', 42, true, Symbol('s')]) {
      expect(loginNeedsExternalAction(v), `${String(v)} 不得判 true`).toBe(false)
    }
  })

  it('⚠️ 值**不是严格 `true`** 时判 false（防「共用同一个 Symbol 却赋了 truthy」）', () => {
    const e = new Error('x')
    Object.defineProperty(e, Symbol.for('dsh-providers-hub/loginNeedsExternalAction'), {
      value: 1,
      enumerable: false,
      configurable: true,
    })
    expect(loginNeedsExternalAction(e)).toBe(false)
  })

  it('⚠️ 标记必须**不可枚举**（不污染 Error 的序列化与日志展开）', () => {
    const e = markLoginNeedsExternalAction(new Error('x'))
    const symbols = Object.getOwnPropertySymbols(e)
    expect(symbols.length, '标记应当以 Symbol 键挂在实例上').toBeGreaterThan(0)
    expect(
      symbols.every((s) => Object.getOwnPropertyDescriptor(e, s)?.enumerable === false),
      '所有 Symbol 键都必须不可枚举',
    ).toBe(true)
    expect(JSON.stringify({ ...e }), '展开后不该多出自定义键').toBe('{}')
  })
})

describe('astudio 终态类：每个实例都必须被标记（构造函数一处覆盖全部抛错点）', () => {
  it('new AstudioRefreshTokenExpiredError(...) ⇒ 已标记', () => {
    // ⚠️ 该类的语义就是「只能人工重新登录，静默重试无意义」（见
    //    `astudio-auth.ts` 的 `isAstudioTerminalRefreshError` 与
    //    `astudio.ts` 的 `ASTUDIO_SESSION_DEAD_CODES`）⇒ 出路在桌面端，
    //    重新点「+ 新建账号」无用 ⇒ 收尾处**不得**加那句假出路。
    const e = new AstudioRefreshTokenExpiredError('未找到本机会话 ⇒ 请在 AStudio 客户端重新登录')
    expect(loginNeedsExternalAction(e)).toBe(true)
  })

  it('⚠️ 反向：普通 Error **不得**被误判（防「标记整个 Error 原型」式误改）', () => {
    expect(loginNeedsExternalAction(new Error('网络抖动，请重试'))).toBe(false)
    expect(loginNeedsExternalAction(new TypeError('x'))).toBe(false)
  })
})