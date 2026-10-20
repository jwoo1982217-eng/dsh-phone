/**
 * `account.refresh` RPC 分派的回归测试。
 *
 * 覆盖两个**既有缺陷**（T7 修复）：
 *
 * 1. **workbuddy 分支缺失**：原实现只判 `codearts` / `buddy`，workbuddy 落入
 *    else 抛 `Unknown provider` —— 即 `account.refresh` 端点对 WorkBuddy 完全不可用。
 * 2. **刷错凭据**：原实现调 `service.refresh()`，而该方法读写的是该 provider 的
 *    **默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），要刷的却是池内条目的
 *    `BUDDY_ACCOUNT_XXX` —— 于是「刷这个账号」实际刷的是另一个凭据。
 *
 * ⚠ **本端点没有面板入口**（issue IKJOZA 取证）：账号卡片上并没有「刷新」按钮，
 * 调用方是仓库外的脚本/手工 RPC。这段说明原先写的是「账号卡片的『刷新』按钮」，
 * 那是失实的 —— 本文件末尾的「issue IKJOZA」段有完整取证。
 *
 * 这两个缺陷都无法靠 `collect*` 那类纯函数测试发现（它们不在那条代码路径上），
 * 因此这里直接驱动 `registerJetHubRpc` 注册的 HTTP 处理器，断言真实分派行为。
 */

import { describe, expect, it, vi } from 'vitest'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 采集到的「某服务被要求刷新的 credentialRef」。 */
interface RefreshCall {
  service: string
  credentialRef: string
}

/**
 * 构造一个 fake `ctx`，捕获 `connection.fetch.register` 的处理器。
 *
 * ⚠️ **按 path 取处理器**：本模块注册的不止 RPC 的 POST 端点（还有载体页的 GET 路由），
 * 「谁最后注册就记谁」会让加一条路由变成「成片 RPC 用例莫名其妙地红」。
 */
function makeCtx(accounts: ProviderAccountEntry[]) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx = {
    connection: {
      fetch: {
        register: (options: { path: string; fetch: (request: Request) => Promise<Response> }) => {
          if (options.path === JET_HUB_API_PATH) handler = options.fetch
        },
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ configured: false }),
    },
    get: () => undefined,
    // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
    // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
    // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerJetHubRpc
    // 会以 `ctx.inject is not a function` 直接抛错。
    //
    // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用（本替身里 connection
    // 始终可用），使端点注册行为与 Web profile 下完全一致。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
  }
  return { ctx, getHandler: () => handler! }
}

/** 构造一个只记录调用、不做真实网络的服务替身。 */
function makeServiceStub(name: string, calls: RefreshCall[]) {
  return {
    refreshAccountCredential: vi.fn(async (ref: string) => { calls.push({ service: name, credentialRef: ref }) }),
    refresh: vi.fn(async () => { calls.push({ service: `${name}.refresh(default)`, credentialRef: '' }) }),
  }
}

/** 构造账号池替身。 */
function makePool(accounts: ProviderAccountEntry[]) {
  return {
    listAllAccounts: async () => accounts,
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    updateAccount: async () => {},
  }
}

/**
 * 调用 `account.refresh` 并返回 RPC 结果载荷。
 *
 * ⚠️ 返回**整个 `result`** 而不是 `result.value`：issue IKJOZA 修复后，失败走
 * `ok:false + error`，`value` 不存在 —— 此前只把 `value` 交出去，用例便永远
 * 看不到失败形态（`value.success === false`），这正是缺陷本身。
 */
async function callRefresh(
  accounts: ProviderAccountEntry[],
  accountId: string,
): Promise<{
  calls: RefreshCall[]
  result: { ok: boolean; value?: { success: boolean }; error?: { code?: string; message?: string } }
}> {
  const calls: RefreshCall[] = []
  const { ctx, getHandler } = makeCtx(accounts)
  registerJetHubRpc(
    ctx as never,
    makePool(accounts) as never,
    makeServiceStub('codearts', calls) as never,
    makeServiceStub('buddy', calls) as never,
    makeServiceStub('workbuddy', calls) as never,
    makeServiceStub('lobsterai', calls) as never,
    makeServiceStub('qoder', calls) as never,
    makeServiceStub('qodercn', calls) as never,
    makeServiceStub('trae', calls) as never,
  )
  const response = await getHandler()(new Request('http://127.0.0.1/api/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'jet-hub',
      payload: { method: 'account.refresh', payload: { accountId } },
    }),
  }))
  const body = await response.json() as {
    result: { ok: boolean; value?: { success: boolean }; error?: { code?: string; message?: string } }
  }
  return { calls, result: body.result }
}

/** 取成功路径的 `value`（供既有用例断言 `success === true`）。 */
function okValue(result: { ok: boolean; value?: { success: boolean } }): { success: boolean } {
  expect(result.ok, `期望成功，实际 error=${JSON.stringify((result as { error?: unknown }).error)}`).toBe(true)
  return result.value!
}

function entry(provider: string, credentialRef: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    nickname: '测试号',
    enabled: true,
    credentialRef,
    createdAt: 1,
    refreshable: true,
  }
}

describe('account.refresh 分派（T7 回归）', () => {
  it('buddy 账号刷新**自己的** credentialRef，而不是默认单凭据 ref', async () => {
    // 缺陷 2 的回归：原实现调 buddy.refresh()（读 BUDDY_ACCESS_TOKEN），
    // 刷的是另一个凭据。
    const { calls, result } = await callRefresh(
      [entry('buddy', 'BUDDY_ACCOUNT_AAAA1111')], 'buddy-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'buddy', credentialRef: 'BUDDY_ACCOUNT_AAAA1111' }])
    // 绝不能退化成「刷默认凭据」。
    expect(calls.some((c) => c.service.includes('refresh(default)'))).toBe(false)
  })

  it('workbuddy 账号可刷新且不再抛 Unknown provider（缺陷 1 的回归）', async () => {
    // 原实现只判 codearts / buddy，workbuddy 落到 else 抛
    // `Unknown provider: workbuddy`。
    const { calls, result } = await callRefresh(
      [entry('workbuddy', 'WORKBUDDY_ACCOUNT_BBBB2222')], 'workbuddy-1',
    )
    expect(okValue(result).success).toBe(true)
    // 成功路径不得带 `error`（issue IKJOZA 后失败走 `ok:false`，成功必须干净）。
    expect((result as { error?: unknown }).error).toBeUndefined()
    expect(calls).toEqual([{ service: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_BBBB2222' }])
  })

  it('lobsterai 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('lobsterai', 'LOBSTERAI_ACCOUNT_CCCC3333')], 'lobsterai-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_CCCC3333' }])
  })

  it('trae 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('trae', 'TRAE_ACCOUNT_EEEE5555')], 'trae-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'trae', credentialRef: 'TRAE_ACCOUNT_EEEE5555' }])
  })

  it('qoder 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('qoder', 'QODER_ACCOUNT_FFFF6666')], 'qoder-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'qoder', credentialRef: 'QODER_ACCOUNT_FFFF6666' }])
  })

  it('qodercn 账号刷新分派到**中国版实例**，不串到国际版（同族注册表的核心风险）', async () => {
    // 国际版与中国版共用一个 switch case（`case QODER.id: case QODER_CN.id:`），
    // 靠 `requireQoderFamily(entry.provider)` 查注册表取实例。
    // 若哪天有人把它写死成 `qoder.refreshAccountCredential(...)`，
    // 症状是「中国版账号点刷新，实际续期了国际版的凭据」—— 两站 token
    // 不通用，于是 CN 续期永远失败而国际版被无谓地刷了一次。
    // 这条用例用**行为**（哪个 stub 被调用）而非字符串锁住这件事。
    const { calls, result } = await callRefresh(
      [entry('qodercn', 'QODERCN_ACCOUNT_GGGG7777')], 'qodercn-1',
    )
    expect(okValue(result).success).toBe(true)
    expect((result as { error?: unknown }).error).toBeUndefined()
    expect(calls).toEqual([{ service: 'qodercn', credentialRef: 'QODERCN_ACCOUNT_GGGG7777' }])
    // 关键：国际版实例必须**没有**被碰过。
    expect(calls.some((c) => c.service === 'qoder'), '中国版账号串到了国际版实例').toBe(false)
  })

  it('两站账号同时在池时各刷各的（互不串用）', async () => {
    const accounts = [
      entry('qoder', 'QODER_ACCOUNT_H1'),
      entry('qodercn', 'QODERCN_ACCOUNT_H2'),
    ]
    const intl = await callRefresh(accounts, 'qoder-1')
    expect(intl.calls).toEqual([{ service: 'qoder', credentialRef: 'QODER_ACCOUNT_H1' }])
    const cn = await callRefresh(accounts, 'qodercn-1')
    expect(cn.calls).toEqual([{ service: 'qodercn', credentialRef: 'QODERCN_ACCOUNT_H2' }])
  })

  it('codearts 账号刷新自己的 credentialRef', async () => {
    const { calls, result } = await callRefresh(
      [entry('codearts', 'CODEARTS_ACCOUNT_DDDD4444')], 'codearts-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_DDDD4444' }])
  })

  it('七个 provider 各自分派到对应服务（互不串用）', async () => {
    const accounts = [
      entry('codearts', 'CODEARTS_ACCOUNT_1'),
      entry('buddy', 'BUDDY_ACCOUNT_1'),
      entry('workbuddy', 'WORKBUDDY_ACCOUNT_1'),
      entry('lobsterai', 'LOBSTERAI_ACCOUNT_1'),
      entry('qoder', 'QODER_ACCOUNT_1'),
      entry('qodercn', 'QODERCN_ACCOUNT_1'),
      entry('trae', 'TRAE_ACCOUNT_1'),
    ]
    for (const target of accounts) {
      const { calls, result } = await callRefresh(accounts, target.id)
      expect(okValue(result).success, target.provider).toBe(true)
      expect(calls, target.provider).toEqual([
        { service: target.provider, credentialRef: target.credentialRef },
      ])
    }
  })

  it('未知 provider 报错（不静默成功）', async () => {
    const { result } = await callRefresh([entry('mystery', 'MYSTERY_ACCOUNT_1')], 'mystery-1')
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/Unknown provider/)
  })

  it('账号不存在时报错', async () => {
    const { result } = await callRefresh([], 'nope-1')
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/not found/)
  })
})

/**
 * Gitee issue IKJOZA：续期失败**不得**回 `ok:true`。
 *
 * ## 缺陷
 * 本 RPC 的 catch 曾把异常包进成功响应（`{ok:true, value:{success:false}}`）。
 * 客户端 `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`
 * 就返回 `value` ⇒ **只判 `ok` 的调用方会把失败读成成功**。报告方一个工具首版
 * 因此把 18 次里的 17 次失败显示成「✅」。
 *
 * ## 这组用例守的正是「失败形态」本身
 * ⚠️ 上面那条「账号不存在时报错」**曾经**断言的是 `value.success === false` ——
 * 也就是说**修复前的行为照样绿**。这正是本缺陷能长期存在的原因：既有断言锁的是
 * 「value 里能看到失败」，而缺陷的实质是「失败被包装成了成功」。
 * 故这里必须额外锁死顶层 `ok`，并断言**失败时 value 根本不存在**。
 */
describe('account.refresh 失败语义（issue IKJOZA）', () => {
  /**
   * 让指定 provider 的续期**抛错**，其余照常。
   *
   * ⚠ **必须覆盖 `registerJetHubRpc` 的全部 15 个 provider 形参**（位置传参，
   * 少传即错位 —— 该函数历史上已因此错位复发 6 次）。缺一个形参时该 provider
   * 拿到 `undefined`，一旦换成它**根本走不到它自己的失败分支**：
   * 初版只造了 7 个桩，于是 issue 里真实出现过的 `raccoon` / `minimax` 两条失败
   * 路径**零覆盖**，还把 raccoon 的报错挂到了 `trae` 上凑数。
   */
  function makeThrowingStub(throwing: string, message: string) {
    const stub = (name: string) => ({
      refreshAccountCredential: async () => {
        if (name === throwing) throw new Error(message)
      },
      refresh: async () => {},
    })
    return {
      codearts: stub('codearts'),
      buddy: stub('buddy'),
      workbuddy: stub('workbuddy'),
      lobsterai: stub('lobsterai'),
      qoder: stub('qoder'),
      qodercn: stub('qodercn'),
      trae: stub('trae'),
      cline: stub('cline'),
      loomy: stub('loomy'),
      raccoon: stub('raccoon'),
      minimax: stub('minimax'),
      zcode: stub('zcode'),
      gemini: stub('gemini'),
    }
  }

  async function callRefreshFailing(accounts: ProviderAccountEntry[], accountId: string, throwing: string, message: string) {
    const { ctx, getHandler } = makeCtx(accounts)
    const services = makeThrowingStub(throwing, message)
    registerJetHubRpc(
      ctx as never,
      makePool(accounts) as never,
      services.codearts as never,
      services.buddy as never,
      services.workbuddy as never,
      services.lobsterai as never,
      services.qoder as never,
      services.qodercn as never,
      services.trae as never,
      services.cline as never,
      services.loomy as never,
      services.raccoon as never,
      services.minimax as never,
      services.zcode as never,
      services.gemini as never,
    )
    const response = await getHandler()(new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method: 'jet-hub',
        payload: { method: 'account.refresh', payload: { accountId } },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: { success: boolean }; error?: { code?: string; message?: string } }
    }
    return body.result
  }

  /**
   * issue 报告里出现过的真实错误，逐条锁定「失败仍回 ok:true 就得红」。
   *
   * ⚠ **provider 与文案必须对位**（初版把 raccoon 的报错挂在 `trae` 上，因为
   * `makeThrowingStub` 当时没有 raccoon/minimax 的桩）：挂错 provider 时，
   * 该 provider 自己的失败分支**根本没被走到**，等于零覆盖 —— 后来谁在那个
   * 分支里加个 early return，也不会有任何用例会红。
   */
  const REPORTED = [
    { provider: 'codearts', message: "CodeArts token request failed: 400 {errorCode: 'STS5.1806', errorMsg: \"invalid refresh token: 'the refresh token has been used'\"}" },
    { provider: 'minimax', message: 'minimax refresh_token 已失效' },
    { provider: 'raccoon', message: 'raccoon 登录态已过期' },
  ] as const

  for (const { provider, message } of REPORTED) {
    it(`★ ${provider} 续期失败必须回 ok:false，而不是 ok:true + value.success:false`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, message)

      // 核心断言：顶层 ok 必须为 false。修复前这里是 true ⇒ 本用例变红。
      expect(result.ok, `${provider} 续期失败却回 ok:true，调用方会把它读成成功`).toBe(false)
      // 失败时**不得**再出现 value —— 那正是被包装成成功的形态。
      expect(result.value, `${provider} 失败时仍带 value（success:false）`).toBeUndefined()
    })

    it(`${provider} 失败必须把服务端原文带进 error.message（否则用户看到「未知故障」）`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, message)
      expect(result.error?.message).toBe(message)
    })
  }

  /**
   * 全部 13 个 provider 逐个覆盖。
   *
   * ⚠ `switch` 新增 case 时这条会**静默失效**（新 provider 既不在本表里、
   * 又仍被 `makeThrowingStub` 造了桩），故另有一条 case 数量断言兜底。
   */
  for (const provider of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
    'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'] as const) {
    it(`${provider} 分支的失败也走同一条 ok:false 通道`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, `${provider} boom`)
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBe(`${provider} boom`)
    })
  }

  it('失败也带 error.code，与本文件其它分支（bad-request）保持同一约定', async () => {
    const accounts = [entry('codearts', 'CODEARTS_ACCOUNT_F')]
    const result = await callRefreshFailing(accounts, 'codearts-1', 'codearts', 'boom')
    expect(result.error?.code).toBe('bad-request')
  })

  it('成功路径不受影响：仍是 ok:true + value.success:true', async () => {
    // 防止「为了让失败变红」把成功也一起改成 ok:false。
    const { result } = await callRefresh([entry('buddy', 'BUDDY_ACCOUNT_1')], 'buddy-1')
    expect(result.ok).toBe(true)
    expect(result.value?.success).toBe(true)
  })
})
