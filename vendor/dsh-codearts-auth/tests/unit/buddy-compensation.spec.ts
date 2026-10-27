import { describe, expect, it, vi } from 'vitest'
import {
  COMPENSATION_CLAIM_PATH,
  COMPENSATION_STATUS_PATH,
  claimCompensation,
  describeCompensationFailure,
  fetchCompensationStatus,
} from '../../src/buddy-compensation.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

/**
 * ⚠️ fixture 的形状取自 **2026-10-16 的真实报文**（本机 buddy 账号实发，
 * 未经浏览器、纯 Node fetch）：
 *
 * POST {webBase}/billing/meter/compensation-status   body {}
 * → 200 {"code":0,"msg":"OK","requestId":"…","data":{
 *        "claimed":false,"active":true,"credit_num":500,
 *        "validity_period":1,"end_time":"2026-10-22 23:59:59"}}
 *
 * 端点原文取自 www.codebuddy.cn 的前端 bundle：
 *   bp=async()=>await cn.post("/billing/meter/compensation-status")、
 *   vp=async()=>await cn.post("/billing/meter/claim-compensation")。
 *
 * 若将来实测发现字段变了，**改解析层 + 本 fixture 一起改**，不要只改一边。
 */
const STATUS_ACTIVE = {
  code: 0,
  msg: 'OK',
  requestId: '5d0d907e-949e-4392-bd8e-5326181b2c7a',
  data: {
    claimed: false,
    active: true,
    credit_num: 500,
    validity_period: 1,
    end_time: '2026-10-22 23:59:59',
  },
}

const CREDENTIAL = {
  access_token: 'test-access-token',
  domain: 'copilot.tencent.com',
  user_id: 'u-1',
  enterprise_id: 'e-1',
} as unknown as BuddyCredential

/** 造一个只回一种响应的 fetcher，并记录收到的请求。 */
function fakeFetcher(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('buddy-compensation：端点常量', () => {
  it('两条路径**都没有 /v2 前缀**（与 WorkBuddy 的 /v2/billing/meter/… 不同产品面）', () => {
    expect(COMPENSATION_STATUS_PATH).toBe('/billing/meter/compensation-status')
    expect(COMPENSATION_CLAIM_PATH).toBe('/billing/meter/claim-compensation')
    expect(COMPENSATION_STATUS_PATH.startsWith('/v2/')).toBe(false)
    expect(COMPENSATION_CLAIM_PATH.startsWith('/v2/')).toBe(false)
  })
})

describe('buddy-compensation：状态查询', () => {
  it('打的是 webBase 而不是推理站 endpoint', async () => {
    // ⚠️ 断言**不写死主机名**：`webBase` 是产品配置，改了配置不该让用例假红。
    //    这里锁的是「用的是 webBase 那一格」这个**取舍**（见模块头）。
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CODEBUDDY.webBase + COMPENSATION_STATUS_PATH)
    expect(calls[0]!.url.startsWith(CODEBUDDY.endpoint)).toBe(false)
  })

  it('POST + 空 JSON body + Bearer 鉴权（无需浏览器 cookie）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe('{}')
    const headers = calls[0]!.init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('真实报文逐字段映射（含 credit_num / end_time 原文）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.claimed).toBe(false)
    expect(result.status.active).toBe(true)
    expect(result.status.creditNum).toBe(500)
    expect(result.status.validityPeriod).toBe(1)
    expect(result.status.endTime).toBe('2026-10-22 23:59:59')
  })

  it('已领取 / 活动已结束的形态如实反映', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({
      code: 0, msg: 'OK',
      data: { claimed: true, active: false, credit_num: 500, end_time: '2026-10-22 23:59:59' },
    }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.claimed).toBe(true)
    expect(result.status.active).toBe(false)
    expect(result.status.creditNum).toBe(500)
  })

  it('可选字段缺失时不报错（validity_period / end_time 省略）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({
      code: 0, msg: 'OK', data: { claimed: false, active: true, credit_num: 0 },
    }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status.creditNum).toBe(0)
    expect(result.status.validityPeriod).toBeUndefined()
    expect(result.status.endTime).toBeUndefined()
  })
})

describe('buddy-compensation：失败分类（三层不合并）', () => {
  it('业务码非 0 ⇒ upstream，且带上游 msg 原文', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 40301, msg: '活动已结束' }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('upstream')
    expect(describeCompensationFailure(result.failure)).toContain('活动已结束')
    expect(describeCompensationFailure(result.failure)).toContain('40301')
  })

  it('缺 data ⇒ shape（不是 upstream，也不当成成功）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK' }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('shape')
  })

  it('非 JSON（HTML 错误页）⇒ network，且带 HTTP 状态码', async () => {
    const { fetcher } = fakeFetcher('<html><body>502 Bad Gateway</body></html>', 502)
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('network')
    expect(describeCompensationFailure(result.failure)).toContain('502')
  })

  it('fetch 抛错（超时/断连）⇒ network，不冒泡', async () => {
    const fetcher = (async () => { throw new Error('The operation was aborted') }) as unknown as typeof fetch
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('network')
    expect(describeCompensationFailure(result.failure)).toContain('aborted')
  })

  it('缺 webBase/claimBase 配置 ⇒ 可读错误，不拼出 undefined/…', async () => {
    const broken = { ...CODEBUDDY, webBase: undefined, claimBase: undefined } as unknown as typeof CODEBUDDY
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    const result = await fetchCompensationStatus(CREDENTIAL, broken, fetcher)
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    if (result.ok) return
    expect(describeCompensationFailure(result.failure)).toContain('webBase')
  })
})

describe('buddy-compensation：领取（写操作）', () => {
  it('POST 到 claim 路径，成功即 ok', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK', data: {} }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe(CODEBUDDY.webBase + COMPENSATION_CLAIM_PATH)
    expect(calls[0]!.init.method).toBe('POST')
  })

  it('⚠️ 最多发一次请求：不做重试（一次性写操作，超时可能已成功）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify({ code: 500, msg: 'boom' }), 500)
    await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(calls).toHaveLength(1)
  })

  it('业务码非 0 ⇒ 失败且带原文（"已领取"不能被误报成成功）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 40901, msg: '已领取过' }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(describeCompensationFailure(result.failure)).toContain('已领取过')
  })

  /**
   * ⚠️⚠️ 这条锁的是**真实报障**（2026-10-17）：领取成功响应**没有 `data`**。
   *
   * 当时的实现要求 `data` 是对象，于是把「已经领到 500 分」判成
   * 「响应格式不认识：响应缺 data 对象」，面板显示「5 个账号领取失败」，
   * 而复查 status 时 5/5 都是 `claimed:true`。
   *
   * ⇒ 写操作的成败只由 `code` 决定，**不许**再对 `data` 做形状要求。
   */
  it('★ 成功信封没有 data（真实形态）⇒ 必须判成功，不能报「响应格式不认识」', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK', requestId: '858fa602-b002' }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
  })

  it('★ data 为 null + code 0 ⇒ 同样是成功（不因 null 翻成 shape）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK', data: null }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(true)
  })

  it('⚠️ 没有业务码又缺 data ⇒ 仍判 shape（无法区分网关 JSON 错误体，不许猜成功）', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ msg: 'OK' }))
    const result = await claimCompensation(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('shape')
    // 排障线索要带上：旧文案只有六个字，看不出信封里到底有什么
    expect(describeCompensationFailure(result.failure)).toContain('code=缺失')
    expect(describeCompensationFailure(result.failure)).toContain('顶层字段=')
  })
})

describe('buddy-compensation：状态查询与领取的判据刻意不同', () => {
  /**
   * 状态查询的返回值**就是** `data` 里的字段 ⇒ 缺 `data` 说明接口形态变了，
   * 必须让用户看见（不能像写操作那样放行）。这条防止有人「顺手统一」两处判据。
   */
  it('状态查询缺 data ⇒ 仍是 shape，且文案带 requestId/msg 便于排障', async () => {
    const { fetcher } = fakeFetcher(JSON.stringify({ code: 0, msg: 'OK', requestId: 'b01d5abe' }))
    const result = await fetchCompensationStatus(CREDENTIAL, CODEBUDDY, fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('shape')
    const text = describeCompensationFailure(result.failure)
    expect(text).toContain('requestId=b01d5abe')
    expect(text).toContain('msg=OK')
  })
})

describe('buddy-compensation：产品隔离', () => {
  it('workbuddy 走自己的 webBase（函数层产品无关；宿主侧另有 provider 硬门控）', async () => {
    const { fetcher, calls } = fakeFetcher(JSON.stringify(STATUS_ACTIVE))
    await fetchCompensationStatus(CREDENTIAL, WORKBUDDY, fetcher)
    expect(calls[0]!.url.startsWith(WORKBUDDY.webBase)).toBe(true)
  })
})

describe('buddy-compensation：接线守卫（源码级）', () => {
  /**
   * ⚠️ 本仓库的既有铁律：一次性/有代价动作**默认不自动执行**
   * （buddy-growth.ts 的 runExotic 是同一约定的先例）。
   *
   * 故这里必须有守卫锁住「补偿没有被偷偷接进自动签到」——
   * 否则将来有人顺手加进去，用户的一次性机会会在无人察觉时被用掉。
   */
  it('⚠️ 补偿不得出现在 auto-checkin / credits 里', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')

    for (const rel of ['../../src/auto-checkin.ts', '../../src/credits.ts']) {
      const source = readFileSync(resolve(here, rel), 'utf8')
      expect(source.includes('buddy-compensation'), rel + ' 引入了 buddy-compensation').toBe(false)
      expect(/claimCompensation/.test(source), rel + ' 调用了 claimCompensation').toBe(false)
    }
  })

  it('宿主 RPC 用 provider 硬门控（非 buddy 请求被拒）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')
    const source = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(source).toContain("case 'buddy.compensationStatus'")
    expect(source).toContain("case 'buddy.claimCompensation'")
    const guardCount = (source.match(/req\.provider !== CODEBUDDY\.id/g) ?? []).length
    expect(guardCount, '两条补偿 RPC 都应有 provider 硬门控').toBeGreaterThanOrEqual(2)
  })

  /**
   * ⚠️ 领取成功后必须让**折算缓存失效**（2026-10-16 审计 P2-3）。
   *
   * 补偿领取改变的是账号积分余额，而聚合折算吃的是带 TTL 的折算缓存 ⇒
   * 不清的话用户点完「立即领取」看到的是「领了但积分没涨」。
   *
   * ⚠️ 与 `credits.claimAll` 的那条清理（`aggregate-wiring.spec.ts` 已守）是
   * **同一条铁律的两个入口**，故这里必须单独守一次 —— 只守 claimAll 那条会漏。
   *
   * ⚠️⚠️ **判据必须剥注释**（2026-10-16 审计实测）：初版这条守卫写成
   *   `case 'buddy.claimCompensation'[\s\S]{0,3000}clearExpiryCache`，
   *   变异验证时**实测无牙** —— 撤掉真正的调用后用例仍全绿，因为
   *   **注释里也写着 `clearExpiryCache` 这个词**，正则匹配到了注释。
   *   ⇒ 这正是 AGENTS.md 登记的「一行注释诱饵」形态。
   * ⇒ 修法：先把块注释整段剥掉，再在**裸代码**里找调用。
   */
  it('⚠️ 领取成功后清折算缓存（否则「领了但积分没涨」）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')
    const raw = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    // ⚠️ 先剥注释（块注释 + 行注释），再判 —— 否则注释里的同名函数会喂饱正则。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const start = code.indexOf("case 'buddy.claimCompensation'")
    expect(start, 'buddy.claimCompensation 分支必须存在').toBeGreaterThan(-1)
    const segment = code.slice(start, start + 3000)
    expect(
      segment,
      'buddy.claimCompensation 成功后必须调 clearExpiryCache（与 credits.claimAll 同款铁律）',
    ).toMatch(/clearExpiryCache\?\.\(\)|clearExpiryCache\(\)/)
  })
})

describe('buddy-compensation：客户端接线守卫', () => {
  /**
   * ⚠️ **重入闸门必须用 ref**（2026-10-16 审计 P2-5）。
   *
   * 这是一次性写操作；`setState` 是异步的，同一 tick 内连点两次会起两轮全量领取，
   * 对同一批账号并发发写操作。本仓库的 `claimInFlightRef`（一键领取积分）已为
   * 同一原因踩过坑并在注释里写明「守卫必须在第一个 await 之前生效」。
   */
  it('⚠️ 领取重入闸门用 ref，不是 useState', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')
    const raw = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    // ⚠️ 同样剥注释：否则注释里写一句「不能用 compensation.busy」就会喂饱反向断言。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).toContain('const compensationClaimRef = React.useRef(false)')
    expect(
      code,
      '闸门必须在第一个 await 之前生效（读 ref，不是读 state）',
    ).toMatch(/compensationClaimRef\.current = true;\s*\n\s*setCompensation/)
    // ⚠️ 反向：不得读 compensation.busy 当守卫（那是 useState，同 tick 连点会漏）
    expect(
      /compensation\.busy === true\) return/.test(code),
      '不得用 compensation.busy 当重入守卫',
    ).toBe(false)
  })

  /**
   * ⚠️⚠️ **判据必须走纯函数模块**（2026-10-16 审计 P0 的结构性修法）。
   *
   * `rpcCall` 成功时返回**解包后的 value**（没有 `ok` 字段）、失败时**抛错**。
   * 本 PR 初版把两处都按 `{ok, value}` 写 ⇒ 功能整体失效而测试全绿。
   *
   * ⇒ 结构性防复发：组件里**不得**再出现对补偿响应的 `.ok` 判据，
   *    判据与文案一律住在 `compensation-panel-logic.js`（那份有行为测试覆盖）。
   */
  it('⚠️⚠️ 组件不得判补偿响应的 `.ok`（解包后无此字段）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = resolve(fileURLToPath(import.meta.url), '..')
    const raw = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const matches = code.match(/buddy\.compensationStatus[\s\S]{0,400}?\.ok\s*[!=]==?/g)
    expect(matches ?? [], '组件里出现对补偿响应的 .ok 判据 ⇒ 与 unwrapRpcResult 契约冲突').toEqual([])
  })
})
