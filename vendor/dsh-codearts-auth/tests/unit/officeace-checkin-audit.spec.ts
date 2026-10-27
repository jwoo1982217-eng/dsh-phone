/**
 * `officeace-checkin-audit.spec.ts` —— PR !116 审计（2026-10-18）的三条追加守卫。
 *
 * 背景：PR !116「每日签到失败不再静默」经独立审计 + 对抗性探针，查出三处
 * 真实缺陷（前两条在 PR 合入后由本文件锁死，第三条见下）：
 *
 * | # | 缺陷 | 症状（实测） |
 * |---|---|---|
 * | **P1** | `signAndRequest` 非 2xx 时返回空串，报文被丢 | 401 + `{"error":"IAM_TOKEN_EXPIRED_XYZ"}` ⇒ `reason: "HTTP 401："`，**报文全丢** |
 * | **P0** | `maybeClaimBonus` 用 `.then()` 却无 `.catch()`；且凭据前置判据在 `try` 之外 | 凭据缺 `access` 字段 ⇒ reject ⇒ 被空 `catch` 吞掉 ⇒ **零留痕 + 余额查询一并被跳过** |
 * | **P2** | 守卫只测 `access` 为**空串**，漏「字段缺失」形态 | 见 P0 |
 * | **P3** | 占坑无条件 `delete` | 跨整点时会删掉新一轮的占坑（节流失效） |
 *
 * ⚠️ 判据必须打在**行为**上：`claimDailyBonus` 走真实签名路径，
 * `maybeClaimBonus`（模块私有）经 `fetchSubscriptionSummary` 的**真实路径**驱动。
 * ⚠️ 不发真实网络：桩掉全局 `fetch`。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

const CRED: OfficeAceCredential = {
  modelAppKey: 'k',
  modelAppSecret: 's',
  maasBaseUrl: 'https://officeace.example',
  access: 'HSTAEXAMPLE',
  secret: 'secret',
  securityToken: 'token',
  projectId: 'cn-southwest-2',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'r',
  dpopPrivateJwk: { kty: 'EC', x: 'x', y: 'y', crv: 'P-256', d: 'd' },
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 记录两类请求：签到与余额查询。
 *
 * ⚠️ 两个计数必须**分开**：P0 的判据正是「失败时余额查询也一并被跳过」，
 * 只数签到无法区分「没签到」与「签到了但没查余额」。
 */
function stubFetch(respond: (url: string) => Response) {
  const seen: string[] = []
  const spy = vi.fn((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/v1/subscription/bonus/claim')) seen.push('claim')
    else if (u.includes('/v1/subscription')) seen.push('balance')
    return Promise.resolve(respond(u))
  })
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return {
    seen,
    get claims() { return seen.filter((x) => x === 'claim').length },
    get balances() { return seen.filter((x) => x === 'balance').length },
  }
}

describe('P1：失败原因必须带出服务端报文（否则用户无从处置）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('★ 401 的 reason 必须含服务端真实报文', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    const SENTINEL = 'IAM_TOKEN_EXPIRED_XYZ'
    stubFetch(() => jsonResponse(JSON.stringify({ error: SENTINEL }), 401))

    const result = await claimDailyBonus(CRED)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // 修前实测是 `"HTTP 401："` —— 报文被丢尽
      expect(result.reason, '失败原因必须带出服务端报文').toContain(SENTINEL)
      expect(result.reason, '状态码也必须保留').toContain('401')
    }
  })

  it('★ 402 的报文同样不得丢（余额不足与凭据失效处置完全不同）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    const SENTINEL = 'SIGNATURE_MISMATCH_ABC'
    stubFetch(() => jsonResponse(JSON.stringify({ error: SENTINEL }), 402))
    const result = await claimDailyBonus(CRED)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(SENTINEL)
  })

  it('⚠️ 报文为空时不得留下悬空的「HTTP 401：」（不得编造、也不得留裸冒号）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse('', 500))
    const result = await claimDailyBonus(CRED)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('500')
      expect(result.reason.trim().endsWith('：'), '空报文时不得留一个悬空冒号').toBe(false)
    }
  })

  it('⚠️ 超长报文被截断（它要进 UI 文案/日志，不能整段堆上去）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    const long = 'y'.repeat(2000)
    stubFetch(() => jsonResponse(JSON.stringify({ error: long }), 400))
    const result = await claimDailyBonus(CRED)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.length, '超长报文必须截断').toBeLessThan(400)
    }
  })
})

describe('P2/P0：凭据字段缺失（undefined）不得崩、不得静默、不得跳过余额', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** `access` **字段缺失**（不是空串）—— 这正是原守卫漏掉的形态。 */
  const BAD = { ...CRED, access: undefined } as unknown as OfficeAceCredential

  it('★★★ claimDailyBonus 在 access 缺失时**必须 resolve 成 ok:false**（不得 reject）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse('{}', 200))
    // 修前实测：reject TypeError（`.length` 在 try 之外）
    await expect(claimDailyBonus(BAD)).resolves.toMatchObject({ ok: false })
  })

  it('★★★ securityToken 缺失时同样不得 reject', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse('{}', 200))
    const bad = { ...CRED, securityToken: undefined } as unknown as OfficeAceCredential
    await expect(claimDailyBonus(bad)).resolves.toMatchObject({ ok: false })
  })

  it('★★ 凭据缺失 ⇒ 零网络请求（不发无谓请求）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    const stub = stubFetch(() => jsonResponse('{}', 200))
    await claimDailyBonus(BAD)
    expect(stub.seen, '凭据缺失不该发起任何请求').toEqual([])
  })

  /**
   * ⚠️⚠️ **判据只钉「不得抛错 + 必须留痕」，不钉余额请求数**（实测修正）。
   *
   * 初版这里断言「余额端点必须被打」，**实测红**，但红因不是缺陷：
   * `fetchCloudSubscriptionFor` 同样用 `credentialUsable` 判据 ⇒ 坏凭据下
   * **两个端点都不该发请求**（发出去只会得到 401，白花往返）。
   * 「零请求」在这里是**正确行为**，把它写进断言反而把正确实现判成红。
   *
   * ⇒ 真正的回归点是修前那两个症状：**reject 逃出**（被调用方空 `catch` 吞掉）
   * 与**零留痕**。修前实测 `seen=[] warns=0`。
   */
  it('★★★ P0 端到端：签到异常必须 resolve 且**留痕**（不得 escape 成未捕获拒绝）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch((u) =>
      u.includes('/bonus/claim')
        ? jsonResponse('{"error":"unauthorized"}', 401)
        : jsonResponse('{"skus":[]}', 200),
    )
    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((m?: unknown) => { warns.push(String(m)) })

    // 修前这里 reject（TypeError）⇒ 整块被外层空 catch 吞掉 ⇒ warns=0
    const result = await fetchSubscriptionSummary(48, 'REF_P0', BAD)
    expect(warns.length, 'P0：签到异常必须留痕（修前零留痕）').toBeGreaterThan(0)
    // 坏凭据下两个云侧端点都不该被打（那是正确行为，不是缺陷）
    expect(stub.seen, '凭据不可用时不得向云侧发请求').toEqual([])
    // 函数本身必须正常返回（不得 escape）
    expect(result === undefined || typeof result === 'object').toBe(true)
  })

  it('★★ P0：凭据可用但服务端 401 时，余额查询**不得被签到失败阻断**', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch((u) =>
      u.includes('/bonus/claim')
        ? jsonResponse('{"error":"unauthorized"}', 401)
        : jsonResponse('{"skus":[]}', 200),
    )
    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((m?: unknown) => { warns.push(String(m)) })

    await fetchSubscriptionSummary(48, 'REF_P0_BAL', CRED).catch(() => undefined)

    expect(stub.claims, '凭据可用 ⇒ 应真的打过签到').toBeGreaterThan(0)
    expect(warns.length, '签到失败必须留痕').toBeGreaterThan(0)
    // ⚠️ 这一格是「不阻断余额」的**真正**形态：凭据是好的，签到失败不该连累余额
    expect(stub.balances, '签到失败**不得**阻断余额查询').toBeGreaterThan(0)
  })

  it('★★ 失败后同小时仍可重试（占坑必须被撤销，不得钉死）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch((u) =>
      u.includes('/bonus/claim')
        ? jsonResponse('{"error":"unauthorized"}', 401)
        : jsonResponse('{"skus":[]}', 200),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await fetchSubscriptionSummary(48, 'REF_P0_RETRY', CRED).catch(() => undefined)
    const afterFirst = stub.claims
    await fetchSubscriptionSummary(48, 'REF_P0_RETRY', CRED).catch(() => undefined)
    expect(afterFirst, '第一次必须真的打了签到').toBeGreaterThan(0)
    expect(stub.claims, '失败后同小时必须能重试').toBeGreaterThan(afterFirst)
  })

  /**
   * ⚠️⚠️ **`.catch()` 兜底的守卫必须能跨越「reject 源头已堵死」这一格**
   *（实测得到的教训，写在这里防止下一个人重犯）。
   *
   * 实测经过：把 `maybeClaimBonus` 的 `.catch()` 整段摘掉后，
   * **本文件 12 条守卫全绿** —— 因为 `credentialUsable` 已经把
   * `access` 缺失那条 reject 路径堵死了，`claimDailyBonus` 不再 reject，
   * `.catch` 自然永不触发。**「全绿」并不等于「这条兜底有用」**，
   * 只说明「当前没有可达的 reject 」。
   *
   * ⇒ 那要不要留 `.catch`？留。它是**纵深防御**：将来任何人给
   * `claimDailyBonus` 加一条新的 throw 路径（正如当初
   * `credential.access.length` 那样）时，没有 `.catch` 就会**静默复发**
   * ——而这正是本 PR 要消灭的那个形态，且它**静默得毫无痕迹**。
   *
   * ⚠️ 但**不能假装它有行为守卫**：下面的调用点普查只能证明
   * 「`.catch` 挂在那里、且撤销+留痕两句都在」，
   * **证明不了**它在真机上被触发过（那需要一条可达的 reject）。
   * 按仓库纪律，**无牙就如实登记，不为它编恒真用例**。
   */
  it('⚠️ P3 调用点普查：撤销占坑必须**按 hourKey 条件删**（跨整点别删掉别人的）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../src/officeace-auth.ts', import.meta.url),
      'utf8',
    )
    const at = src.indexOf('const releaseSlot')
    expect(at, '未定位到 releaseSlot').toBeGreaterThan(-1)
    const body = src.slice(at, at + 320)
    expect(body, '★ 撤销占坑必须先比对 hourKey 再删（无条件删会误删新一轮的占坑）')
      .toMatch(/lastClaimAt\.get\(ref\)\s*===\s*hourKey/)
    /**
     * ⚠️⚠️ **这条是源码级判据，形态弱，如实标注**（实测得出）：
     * 变异验证（把条件删改回无条件 `lastClaimAt.delete(ref)`）时，
     * 本文件所有**行为**守卫全绿 —— 因为跨整点窗口需要
     * 「请求在途期间真实跨过整点」才能构造，用 fake timer 或改 hourKey
     * 都是在**测桩**而不是测行为（同仓库记过的教训）。
     * ⇒ 本条只保证「条件删这个写法还在」，**不保证跨整点行为被验证过**。
     * 该缺陷形态本身极轻：多打的是**幂等**签到（服务端一天一份），
     * 只是多一次往返 + 一条 warn，**不会丢分**。
     */
  })

  /**
   * ⚠️⚠️ **`.catch()` 兜底的守卫必须能跨越「reject 源头已堵死」这一格**
   *（实测教训，写在这里防止下一个人重犯）。
   *
   * 实测经过：把 `maybeClaimBonus` 的 `.catch()` 整段摘掉后，
   * 本文件所有**行为**守卫全绿 —— 因为 `credentialUsable` 已把
   * `access` 缺失那条 reject 路径堵死，`claimDailyBonus` 不再 reject，
   * `.catch` 自然永不触发。**「全绿」并不等于「这条兜底有用」**，
   * 只说明「当前没有可达的 reject」。
   *
   * ⇒ 留 `.catch`：它是**纵深防御**。将来任何人给 `claimDailyBonus`
   * 加一条新的 throw 路径（正如当初 `credential.access.length` 那样）时，
   * 没有 `.catch` 就会**静默复发** —— 而这正是本 PR 要消灭的形态。
   *
   * ⚠️ 两条过程教训（都实测踩到）：
   *   ① 切片用 `lastIndexOf` —— 长注释里有「空 `catch` 静默吞掉」这句，
   *      `indexOf('.catch(')` 会先命中**注释**；
   *   ② 正则写 `/\)\s*\.catch\(/` 而非 `/\}\s*\.catch\(/` ——
   *      实际形态是 `}).catch(`，`}` 与 `.catch` 之间**没有空白**。
   */
  it('★ P0 调用点普查：拒绝路径必须与失败路径同等对待（撤销占坑 + 留痕两句都在）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../src/officeace-auth.ts', import.meta.url),
      'utf8',
    )
    const at = src.indexOf('function maybeClaimBonus')
    const fn = src.slice(at, src.indexOf('/** Basic 授权头值', at))
    expect(fn, '未定位到 maybeClaimBonus').not.toBe('')
    expect(fn, '★ 拒绝路径必须有 .catch 兜底（否则将来新增 throw 路径会静默复发）')
      .toMatch(/\)\s*\.catch\(/)
    const catchAt = fn.lastIndexOf('}).catch(')
    expect(catchAt, '未定位到真实的 .catch 调用').toBeGreaterThan(-1)
    const catchBody = fn.slice(catchAt)
    expect(catchBody, '★ 拒绝路径必须撤销占坑').toMatch(/releaseSlot\(\)/)
    expect(catchBody, '★ 拒绝路径必须留痕').toMatch(/console\.warn\(/)
  })
})

describe('成功路径的既有语义不得被修坏', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('2xx + 空响应体 ⇒ 判成功且占坑保留（同小时不打第二次）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch(() => jsonResponse('', 200))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    for (let i = 0; i < 4; i += 1) {
      await fetchSubscriptionSummary(48, 'REF_EMPTY', CRED).catch(() => undefined)
    }
    expect(stub.claims, '成功后占坑保留、节流仍有效').toBe(1)
  })

  it('★ 并发刷新不会重复打签到端点（占坑在请求「前」建立）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ bonus_skus: [] }), 200))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await Promise.all([
      fetchSubscriptionSummary(48, 'REF_CONC', CRED).catch(() => undefined),
      fetchSubscriptionSummary(48, 'REF_CONC', CRED).catch(() => undefined),
    ])
    expect(stub.claims, '并发两次刷新只该打一次签到').toBe(1)
  })
})