/**
 * AStudio **用户可见诊断文案**的两条判据（2026-10-20 用户报障，真机截图取证）。
 *
 * ## 报障症状
 *
 * - **图 1**：扫码后载体页底部**红色**状态条显示「成功」—— 用户以为登好了，
 *   其实**没拿到账号标识**（那次登录实际失败）。
 * - **图 2**：账号池第 2 条的「积分」行显示 `Cannot read properties of unde…`
 *   —— 一段 **JS 异常消息**被当成余额文案展示。
 *
 * ## 两条根因（各自独立）
 *
 * 1. `pollAstudioWechatScan` 在「`code === 0`（成功信封）+ 账号表为空」时，
 *    用**上游 `desc`** 当失败原因，而该字段在成功信封里的值**就是 `"成功"`**
 *    （实测 fact：`{flag:true,code:0,desc:"成功",…}`，见 `astudio-auth.ts`）
 *    ⇒ 失败原因的位置上放了一句「成功」。前端把 `message` 渲染进**红色**条。
 * 2. `fetchAstudioBalanceDetailed` 的 `astudioCookieHeader(credential)` 在 **try 之外**，
 *    而调用方用 `as AstudioCredential` 硬转 ⇒ 凭据读不到时 `credential` 是 `undefined`
 *    ⇒ 解引用抛 `TypeError`，其消息被上层当作**余额文案**。
 *
 * ⚠️ 两条判据都打在**行为**上（真调函数、看返回值），不是源码文本断言。
 */
import { describe, expect, it } from 'vitest'
import { pollAstudioWechatScan } from '../../src/astudio-oauth.js'
import { fetchAstudioBalanceDetailed } from '../../src/astudio-credits.js'

/** 造一个只回一份 JSON 的 fetcher。 */
function jsonFetcher(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('★ 扫码轮询：失败原因**不得**取上游 `desc`（成功信封里它是「成功」）', () => {
  it('★★ `code: 0` + 账号表为空 ⇒ unbound，且 message 不得含「成功」', async () => {
    // 真机取证的信封形状：`{flag:true, code:0, desc:"成功", data:[]}`
    const result = await pollAstudioWechatScan('fd-test', {
      fetcher: jsonFetcher({ flag: true, code: 0, desc: '成功', count: null, data: [] }),
    })
    expect(result.status, 'code=0 但解析不出账号 ⇒ 必须判 unbound（这是真实失败）').toBe('unbound')
    const message = (result as { message?: string }).message ?? ''
    expect(
      message,
      '⚠️ 不得把上游的**状态描述**「成功」放到失败原因的位置上（图 1 的红色「成功」）',
    ).not.toContain('成功')
    // ⚠️⚠️ 文案必须指向**有效**动作（2026-10-20 探针实测结论）：`infoList` 为空 =
    //    **该微信号在讯飞侧没有绑定账号**（探针对照：成功的号 `infoList: array(1)`、
    //    失败的号 `array(0)`，而两次的**信封逐字相同**都是 `flag=true code=0 desc="成功"`）
    //    ⇒ 叫用户「重新扫码」是**假出路**（同一个号再扫还是空）。
    expect(message, '必须给出有效动作：换登录方式 / 先在该微信侧登录一次')
      .toMatch(/手机验证码|账号密码|AStudio 客户端/)
    expect(message, '⚠️ 不得再出现「重新扫码」这个无效指引').not.toContain('重新扫码')
  })

  it('★ 反向：`code !== 0` 时 `desc` **是**错误描述 ⇒ 必须如实透出（别一律丢弃）', async () => {
    // ⚠️ 没有这一条，把 desc 一律丢掉也能全绿 —— 那会丢掉上游真正的错误原因。
    const result = await pollAstudioWechatScan('fd-test', {
      fetcher: jsonFetcher({ flag: false, code: 99909001, desc: '系统异常', data: null }),
    })
    expect(result.status).toBe('error')
    expect(
      String((result as { message?: string }).message ?? ''),
      '上游真正的错误描述必须透出（判据是结构化的 code，不是匹配文本）',
    ).toContain('系统异常')
  })
})

describe('★ 余额查询：凭据缺失必须归成**可读失败**，不得让 TypeError 当文案', () => {
  it('★★ 传 `undefined` ⇒ 回可读原因，且不得出现 JS 异常消息', async () => {
    // ⚠️ 调用方（`provider-credits.ts` 的 astudio 分支）用 `as AstudioCredential` 硬转，
    //    运行时不拦 ⇒ 这里必须自己防（图 2 的 `Cannot read properties of unde…`）。
    const detail = await fetchAstudioBalanceDetailed(undefined as never)
    expect(detail.balance, '凭据缺失时**不得**编造余额').toBeNull()
    const error = String(detail.error ?? '')
    expect(error, '不得把 JS 异常消息当用户文案').not.toMatch(/Cannot read|is not a function|undefined is not/)
    expect(error, '必须告诉用户怎么办').toContain('重新登录')
  })

  it('★ 反向：凭据是**对象**但缺 Cookie 字段 ⇒ 仍走原有的「未登录」文案（顺序不颠倒）', async () => {
    const detail = await fetchAstudioBalanceDetailed({ access_token: 'a' } as never)
    expect(detail.balance).toBeNull()
    expect(String(detail.error ?? ''), '缺 Cookie 那条腿必须仍然生效').toContain('缺少登录会话 Cookie')
  })
})

describe('★ 扫码解析的口径**必须与短信/密码登录一致**（三入口不得三套判据）', () => {
  const scanned = (payload: unknown) => pollAstudioWechatScan('fd-test', { fetcher: jsonFetcher(payload) })

  it('★★ 只给 `token`（无 ssoSessionId）⇒ 仍须解析出账号（另两条入口都接受 token）', async () => {
    // ⚠️ 修前扫码要求 `uid` **且** `ssoSessionId`、且**不认 token** ⇒ 上游只下发 token 时
    //    **只有扫码会失败**（界面报「已扫码，但上游未下发账号标识」），而短信/密码登录能过。
    const result = await scanned({ code: 0, desc: '成功', data: [{ uid: 'u1', token: 'tok-1' }] })
    expect(result.status, '只给 token 不得判 unbound').toBe('scanned')
    expect((result as { account?: { ssoSessionId?: string } }).account?.ssoSessionId).toBe('tok-1')
  })

  it('★ 只给 `uid`（无任何 session/token）⇒ 兜底成 uid（同 `ssoSessionId || uid`）', async () => {
    const result = await scanned({ code: 0, desc: '成功', data: [{ uid: 'u9' }] })
    expect(result.status).toBe('scanned')
    expect((result as { account?: { ssoSessionId?: string } }).account?.ssoSessionId).toBe('u9')
  })

  it('★ `data.infoList` 那条分支必须与 `data` 数组**同款**（两处不得各写一套）', async () => {
    const result = await scanned({ code: 0, desc: '成功', data: { infoList: [{ uid: 'u2', token: 't2' }] } })
    expect(result.status, 'infoList 分支也必须接受 token').toBe('scanned')
    expect((result as { account?: { uid?: string } }).account?.uid).toBe('u2')
  })

  it('⚠️ 反向：三项全空 ⇒ 仍必须判 unbound（**不得**把空凭据放进号池）', async () => {
    // ⚠️ 放宽容错**不能**放到「什么都认」：空会话进号池会让后续每个请求以 80000 失败
    //    （与 `astudio-auth.ts` 那条「半截凭据也算未开通」同因）。
    const result = await scanned({ code: 0, desc: '成功', data: [{ foo: 'bar' }] })
    expect(result.status).toBe('unbound')
  })
})