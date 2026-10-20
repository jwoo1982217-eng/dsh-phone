import { describe, expect, it, vi } from 'vitest'
import {
  CODEARTS_OPS_CHANNEL,
  CODEARTS_PACKAGE_INFO_PATH,
  CODEARTS_SNAP_ENGINE_URL,
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfo,
  fetchCodeArtsAccountInfoDetailed,
  fetchCodeArtsOpsActivities,
  findDailyCheckinActivity,
} from '../../src/codearts-credits.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * `src/codearts-credits.ts` 的单元测试。
 *
 * 全部用桩 fetcher，**不发任何真实网络请求**（与 tests/unit 的既有约定一致）。
 * 重点覆盖三类容易出错的地方：
 *
 * 1. **两种响应信封**：`ops/*` 是 `{code,message,data}`，而 `statistics/plugin`
 *    是**裸对象**。只支持其中一种会让另一端点恒判失败。
 * 2. **账户类型门控**：Token 计费账户必须判为 `inactive` 而不是 `failed`
 *    —— 前者是正常业务状态，后者会让用户去排查并不存在的故障。
 * 3. **幂等预检**：本协议没有幂等键、也没有「今天已签到」业务码，
 *    唯一的保护就是 `claimable` / `status` 预检；漏了会重复发领取请求。
 */

const CREDENTIAL: CodeArtsCredential = {
  access_key_id: 'AKTEST',
  secret_access_key: 'SKTEST',
  security_token: 'STTEST',
  expires_at: '2099-01-01T00:00:00.000Z',
}

/** 构造一个返回固定 JSON 的桩 fetcher，并记录请求。 */
function jsonFetcher(
  handler: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown },
): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const { status = 200, body } = handler(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 一个 `statistics/plugin` 的裸对象响应（积分账户）。 */
function packageInfoBody(options: {
  isCredit?: boolean
  isToken?: boolean
  metrics?: unknown[]
} = {}): Record<string, unknown> {
  return {
    package: {
      package_name_cn: '码道个人专业版',
      package_name_en: 'CodeArts Agent Pro',
      spec_code: 'codearts.agent.professional',
      status: 'normal',
      is_credit_package: options.isCredit ?? true,
      is_token_package: options.isToken ?? false,
    },
    metrics: options.metrics ?? [
      { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 1200, package_credit_remain: 3800 },
      { name: 'usageBasicPackageCredit', package_credit_amount: 3000, package_credit_used: 1200, package_credit_remain: 1800 },
      { name: 'usageBonusPackageCredit', package_credit_amount: 2000, package_credit_used: 0, package_credit_remain: 2000 },
      { name: 'usageTokenChatMessages', usage_token_num: 10, package_token_amount: 100 },
    ],
  }
}

/** 一个 `ops/delivery` 的带信封响应。 */
function deliveryBody(items: unknown[]): Record<string, unknown> {
  return { code: 0, message: 'success', data: { items } }
}

describe('fetchCodeArtsAccountInfo（账户类型检测）', () => {
  it('识别积分计费账户（is_credit_package = true）', async () => {
    const { fetcher } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info).not.toBeNull()
    expect(info?.isCreditPackage).toBe(true)
    expect(info?.isTokenPackage).toBe(false)
    expect(info?.packageName).toBe('码道个人专业版')
  })

  it('识别 Token 计费账户（活动范围外）', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({ isCredit: false, isToken: true }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.isCreditPackage).toBe(false)
    expect(info?.isTokenPackage).toBe(true)
  })

  it('解析裸对象信封（statistics/plugin 没有 data 包装）', async () => {
    // 这条守住「两种信封都要支持」：若误按 ops/* 的 {code,data} 解析，
    // package 会取不到，isCreditPackage 恒为 false —— 表现为「所有账号都
    // 不是积分账户」，静默且极难发现。
    const { fetcher } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.specCode).toBe('codearts.agent.professional')
    expect(info?.credit?.total).toBe(3800)
  })

  it('余额取总额 metric，不累加分类明细', async () => {
    // 分类（基础 1800 + 赠送 2000 = 3800）恰好等于总额，但那是巧合；
    // 若实现累加分类，一旦服务端下发「已用/冻结」类分类就会翻倍。
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 1200, package_credit_remain: 3800 },
          { name: 'usageBasicPackageCredit', package_credit_amount: 3000, package_credit_used: 1200, package_credit_remain: 1800 },
          { name: 'usageBonusPackageCredit', package_credit_amount: 2000, package_credit_used: 0, package_credit_remain: 2000 },
        ],
      }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.credit?.total).toBe(3800)
  })

  it('无任何 credit metric 时 credit 为 undefined（≠ 余额为 0）', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({ metrics: [{ name: 'usageTokenChatMessages', usage_token_num: 1 }] }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.credit).toBeUndefined()
  })

  it('查询失败返回 null（与「非积分账户」严格区分）', async () => {
    const { fetcher } = jsonFetcher(() => ({ status: 500, body: { message: 'boom' } }))
    expect(await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)).toBeNull()
  })

  it('凭据缺少 AK/SK 时不发请求', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const broken = { ...CREDENTIAL, access_key_id: '' }
    expect(await fetchCodeArtsAccountInfo(broken, fetcher)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('请求带签名头与 Agent-Type（服务端路由所需）', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('authorization')).toContain('SDK-HMAC-SHA256')
    expect(headers.get('x-security-token')).toBe('STTEST')
    expect(headers.get('agent-type')).toBe('PromptCenter')
    expect(calls[0]?.url).toBe(`${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`)
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：界面显示「积分：账户信息查询失败」。
   *
   * 根因是 `Agent-Type` / `X-Language` 被当作 `signRequestHuawei` 的
   * `extraHeaders` 传入了 —— 于是它们进入 canonical request 与 SignedHeaders，
   * 服务端回
   * `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`。
   * 把这两个头改为**签名后追加**即恢复正常（实测同一端点 200 并返回真实积分）。
   *
   * 正确做法与 `src/models.ts` 的 `fetchSignedGet` 一致，其参数注释明确写着
   * 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。
   *
   * 本用例直接解析 Authorization 头里的 `SignedHeaders=`，锁死这一点：
   * 只断言「头存在」是不够的（那正是原测试的漏洞 —— 头存在但位置错了）。
   */
  it('Agent-Type / X-Language 不得出现在 SignedHeaders 中（签名后追加）', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    const auth = new Headers(calls[0]?.init?.headers).get('authorization') ?? ''
    const match = /SignedHeaders=([^,]+)/.exec(auth)
    expect(match, 'Authorization 缺少 SignedHeaders').not.toBeNull()
    const signed = match![1]!.toLowerCase()
    expect(
      signed,
      'Agent-Type 出现在 SignedHeaders 里：它必须在签名之后追加，'
      + '否则服务端验签失败（APIG.0301），积分查询恒报「账户信息查询失败」。',
    ).not.toContain('agent-type')
    expect(signed, 'X-Language 不得参与签名').not.toContain('x-language')
    // 但这两个头**必须**仍然随请求发出（服务端路由依赖它们）。
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('agent-type')).toBe('PromptCenter')
    expect(headers.get('x-language')).toBe('zh-cn')
  })

  it('非 2xx 响应带出服务端错误码与原因（不能只报 HTTP 状态）', async () => {
    // 真实 401 响应体形如：
    // {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}
    // 只回「HTTP 401」会让「签名头位置错」「AK 限流」「凭据过期」这些
    // 处置方式完全不同的问题看起来一模一样。
    const { fetcher } = jsonFetcher(() => ({
      status: 401,
      body: { error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' },
    }))
    const result = await fetchCodeArtsAccountInfoDetailed(CREDENTIAL, fetcher)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('401')
      expect(result.message).toContain('APIG.0301')
      expect(result.message).toContain('verify ak sk signature fail')
    }
  })
})

describe('fetchCodeArtsOpsActivities（活动列表）', () => {
  /**
   * ⚠️ 真实缺陷（用户报障）：点「一键领取积分」后显示「1 个活动未开启，
   * 1 个失败」——积分实际**没有**领到。
   *
   * 两个解析错误叠加，都源于**用了臆想的字段类型/名字**而非真实响应：
   *
   * 1. `campaignId` 服务端下发的是**数字**（实测 `1`），而实现用只接受
   *    字符串的 `readString` 解析 → 恒为空串 → 领取被判
   *    `failed`「活动缺少 campaignId，无法领取」。
   * 2. 可领积分的字段名是 **`benefitAmount`**（实测 `1000`），实现读的是
   *    `amount`（服务端不返回）→ 恒为 0。
   *
   * 早期用例之所以没抓到，正是因为它喂的是**编造的** `campaignId: 'c-1'`
   * 与 `amount: 1000`。下面这条用真实响应形状（见 2026-09-18 实测抓包），
   * 并附完整字段以便日后核对。
   */
  it('解析真实响应形状：数字 campaignId 与 benefitAmount', async () => {
    // 真实 item 的字段集合（实测，仅截去 displayConfig/extra 的长内容）。
    const realItem = {
      campaignId: 1,
      title: '每日签到领1000 积分',
      type: 'USER_LOGIN',
      benefitAmount: 1000,
      benefitUnit: 'CREDIT',
      pageUrl: '/v1/ops/pages/1',
      claimable: true,
      status: 'ELIGIBLE',
      description: '每日签到领取1000积分',
      pendingCount: 1,
      pendingTotalAmount: 1000,
    }
    const { fetcher } = jsonFetcher(() => ({ body: deliveryBody([realItem]) }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)

    expect(activities?.[0]?.campaignId, '数字 campaignId 必须转成字符串').toBe('1')
    expect(activities?.[0]?.amount, 'benefitAmount 才是可领积分数').toBe(1000)
    expect(activities?.[0]?.type).toBe('USER_LOGIN')
    expect(activities?.[0]?.claimable).toBe(true)
  })

  it('不可领取的活动 status 为 null 时不抛错', async () => {
    // 实测：STUDENT_CERTIFIED 项的 status 是 null（不是字符串）。
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([
        { campaignId: 2, type: 'STUDENT_CERTIFIED', title: '学生认证', benefitAmount: 4000, claimable: false, status: null },
      ]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities?.[0]?.status).toBe('')
    expect(activities?.[0]?.campaignId).toBe('2')
  })

  it('campaignId 为对象等非标量时不产出 [object Object]', async () => {
    // 防御：非标量 ID 应当留空（进而被判 failed），而不是把
    // `[object Object]` 当作 campaignId 发给服务端。
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([{ campaignId: { nested: true }, type: 'USER_LOGIN', claimable: true, status: 'ELIGIBLE' }]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities?.[0]?.campaignId).toBe('')
  })

  it('解析 items 并读取 claimable / campaignId', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([
        { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到得积分', claimable: true, status: 'ENTRY', amount: 1000 },
        { campaignId: 'c-2', type: 'INVITE_USER', title: '邀请好友', claimable: false, status: 'ENTRY' },
      ]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities).toHaveLength(2)
    expect(activities?.[0]?.campaignId).toBe('c-1')
    expect(activities?.[0]?.claimable).toBe(true)
    expect(activities?.[0]?.amount).toBe(1000)
  })

  it('channel=IDE 是必需 query 参数', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: deliveryBody([]) }))
    await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(calls[0]?.url).toContain(`channel=${CODEARTS_OPS_CHANNEL}`)
  })

  it('业务码非 0 视为失败（不能把失败当空列表）', async () => {
    // 若把 code!==0 当成功，会把「活动服务异常」显示成「今天没有活动」。
    const { fetcher } = jsonFetcher(() => ({ body: { code: 500, message: '服务异常' } }))
    expect(await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)).toBeNull()
  })

  it('items 缺失返回 null（与空活动列表区分）', async () => {
    const { fetcher } = jsonFetcher(() => ({ body: { code: 0, data: {} } }))
    expect(await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)).toBeNull()
  })

  it('findDailyCheckinActivity 只挑 USER_LOGIN，不误领邀请/新人活动', () => {
    const activities = [
      { campaignId: 'a', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY', amount: 0 },
      { campaignId: 'b', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
    ]
    expect(findDailyCheckinActivity(activities)?.campaignId).toBe('b')
    expect(findDailyCheckinActivity([])).toBeUndefined()
  })
})

describe('claimCodeArtsDailyCheckin（领取）', () => {
  /** 组合一个「账户信息 + 活动列表 + 领取」三段的桩 fetcher。 */
  function claimFetcher(options: {
    isCredit?: boolean
    isToken?: boolean
    items?: unknown[]
    claimBody?: unknown
    claimStatus?: number
  }) {
    return jsonFetcher((url) => {
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) {
        return { body: packageInfoBody({ isCredit: options.isCredit, isToken: options.isToken }) }
      }
      if (url.includes('/v1/ops/delivery')) {
        return { body: deliveryBody(options.items ?? [
          { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
        ]) }
      }
      if (url.includes('/v1/ops/claim')) {
        return { status: options.claimStatus ?? 200, body: options.claimBody ?? { code: 0, data: { id: null, credit: 1000 } } }
      }
      if (url.includes('/v1/ops/confirm')) {
        return { body: { code: 0, data: {} } }
      }
      return { status: 404, body: {} }
    })
  }

  it('正常领取成功', async () => {
    const { fetcher } = claimFetcher({})
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(1000)
  })

  /**
   * 真实缺陷回归：用**真实响应形状**走完整领取流程。
   *
   * 早期实现用 `readString` 读数字 `campaignId` → 空串 → 直接判
   * `failed`「活动缺少 campaignId，无法领取」，用户看到「1 个失败」。
   * 本用例断言领取请求**真的发出**且 body 里的 campaignId 正确。
   */
  it('数字 campaignId 也能正常领取（真实响应形状）', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{
        campaignId: 1,
        title: '每日签到领1000 积分',
        type: 'USER_LOGIN',
        benefitAmount: 1000,
        benefitUnit: 'CREDIT',
        claimable: true,
        status: 'ELIGIBLE',
      }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)

    expect(
      outcome.kind,
      '数字 campaignId 未被解析：领取会以「缺少 campaignId」失败',
    ).toBe('claimed')
    const claimCall = calls.find((call) => call.url.includes('/v1/ops/claim'))
    expect(claimCall, '未发出领取请求').toBeDefined()
    expect(JSON.parse(String(claimCall?.init?.body))).toEqual({
      campaignId: '1',
      channel: CODEARTS_OPS_CHANNEL,
    })
  })

  it('领取响应不含积分数时回退到活动的 benefitAmount', async () => {
    // 实测活动条目的 benefitAmount=1000；领取响应若不带金额，
    // 应当用它兜底，而不是显示 +0。
    const { fetcher } = claimFetcher({
      items: [{
        campaignId: 1, type: 'USER_LOGIN', benefitAmount: 1000,
        claimable: true, status: 'ELIGIBLE',
      }],
      claimBody: { code: 0, data: { id: null } },
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(1000)
  })

  it('Token 计费账户判为 inactive（不是 failed）', async () => {
    // 这是账户类型门控的核心断言：非活动范围的账户是**正常业务状态**，
    // 报 failed 会让用户去排查并不存在的故障。
    const { fetcher, calls } = claimFetcher({ isCredit: false, isToken: true })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
    // 且不应发出领取请求
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('非积分非 Token 的账户同样判为 inactive', async () => {
    const { fetcher } = claimFetcher({ isCredit: false, isToken: false })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('已领取状态（CLAIMED）判为 already-claimed，且不发领取请求', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{ campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: false, status: 'CLAIMED' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('不可领取但状态未知判为 inactive', async () => {
    const { fetcher } = claimFetcher({
      items: [{ campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: false, status: 'PENDING' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('无每日签到活动判为 inactive', async () => {
    const { fetcher } = claimFetcher({
      items: [{ campaignId: 'c-9', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('领取响应 id 非 null 时补发 confirm', async () => {
    // 漏掉 confirm 会让积分停在「待确认」而不入账（IDE 的行为即如此）。
    const { fetcher, calls } = claimFetcher({ claimBody: { code: 0, data: { id: 'benefit-1', credit: 1000 } } })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    expect(calls.some((call) => call.url.includes('/v1/ops/confirm'))).toBe(true)
  })

  it('id 为 null 时不发 confirm', async () => {
    const { fetcher, calls } = claimFetcher({ claimBody: { code: 0, data: { id: null, credit: 1000 } } })
    await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(calls.some((call) => call.url.includes('/v1/ops/confirm'))).toBe(false)
  })

  it('confirm 失败不影响 claimed 结论', async () => {
    // 积分已进入待确认态；报 failed 会让用户以为没领到而重复点击。
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) {
        return Response.json(packageInfoBody())
      }
      if (url.includes('/v1/ops/delivery')) {
        return Response.json(deliveryBody([
          { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
        ]))
      }
      if (url.includes('/v1/ops/claim')) {
        return Response.json({ code: 0, data: { id: 'benefit-1', credit: 1000 } })
      }
      return new Response('nope', { status: 500 })
    }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
  })

  it('领取业务失败判为 failed 并带出服务端文案', async () => {
    const { fetcher } = claimFetcher({
      claimBody: { code: 4001, message: '活动已结束' },
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.code).toBe(4001)
      expect(outcome.message).toBe('活动已结束')
    }
  })

  it('账户信息查询失败判为 failed（不是 inactive）', async () => {
    const fetcher = (async () => new Response('bad', { status: 502 })) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('活动列表查询失败判为 failed（不是 inactive）', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) return Response.json(packageInfoBody())
      return new Response('bad', { status: 502 })
    }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('缺少 campaignId 时判为 failed 且不发领取请求', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{ type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('领取请求是 POST 且带 campaignId 与 channel', async () => {
    const { fetcher, calls } = claimFetcher({})
    await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    const claimCall = calls.find((call) => call.url.includes('/v1/ops/claim'))
    expect(claimCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(claimCall?.init?.body))).toEqual({
      campaignId: 'c-1',
      channel: CODEARTS_OPS_CHANNEL,
    })
  })

  it('网络异常不抛出，转为 failed 且保留底层原因（逐账号批量处理要求）', async () => {
    // collectClaimResults 逐个账号调用本函数；抛出会中断整批。
    // 同时底层错误消息必须保留 —— 压成笼统文案会让排查失去线索。
    const fetcher = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('socket hang up')
  })
})

describe('签名请求的查询串参与签名', () => {
  it('带 query 的 delivery 请求签名覆盖 query（否则服务端验签失败）', async () => {
    // sign.ts 的 canonicalRequest 含 query 段；这里只需确认请求确实带了 query
    // 且签名头存在 —— 真实验签由 e2e 覆盖。
    const { fetcher, calls } = jsonFetcher(() => ({ body: deliveryBody([]) }))
    await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(calls[0]?.url).toContain('?channel=IDE')
    expect(headers.get('authorization')).toMatch(/SignedHeaders=.*host/)
    expect(vi.isMockFunction(fetcher)).toBe(false)
  })
})
