/**
 * 原生搜索接入（`src/web-native.ts`）的行为守卫。
 *
 * ## 被锁死的契约
 *
 * 1. **渠道判断**：只有 `buddy` / `workbuddy` 走原生；其余一律 `next()` 放行。
 * 2. **短路形状**：命中时必须返回 `{ value }`（返回 `undefined` 会让模型拿到
 *    空结果 —— 实测确认）。
 * 3. **结果投影**：search 的 `results[]` → 官方 `sources[]`。
 * 4. **多 query 合并**：复刻官方「按 rank 轮转 + url 去重 + cap」。
 * 5. **选号一致性**：调适配器的 `resolveCredentialFor(model)`，且 `model`
 *    取自当前会话路由（吞掉会让搜索选到聊天链路不会选的号）。
 * 6. **错误语义**：直接抛，不自己包装（宿主 `toolErrorResult` 统一转 `isError`）。
 * 7. ⚠️ **`web_fetch` 一律放行**：官方 fetch 走 `web-fetch-http`（`fetchProvider: http`），
 *    **不发送凭据**、零配置、自带 SSRF 防护与明确响应上限。本模块早期接管过它，
 *    2026-10-14 已整体剔除（实测是净损失，理由见 `web-native.ts` 模块头）。
 *
 * ## 测试策略
 *
 * 三层：
 *
 * ① **结构化替身**（`mount`）驱动 `installWebNative`，配 stub fetch 抓真正发往
 *    上游的请求 —— 覆盖渠道判断、请求形状、结果投影、错误语义。
 *
 * ② **真实 cordis**（`describe('真实 cordis 集成')`）—— `mount` 替身**故意忽略
 *    事件名与服务名**（`on(_name, …)` / `inject(_names, …)` 都直接回调），
 *    于是「事件名拼错」这类缺陷在替身层**永远测不出来**。而本模块为避开与宿主
 *    `dsh-tools` 的接口合并冲突，把 `tools/execute` 的类型改成了局部断言
 *    （见 `web-native.ts` 的 `ToolExecuteScope`）⇒ **事件名与服务名都没有编译期
 *    检查**。故必须用真 cordis 把这两个名字纳入红区 —— 对抗性审查第二轮
 *    Major-1 的实测结论：把 `'tools/execute'` 改成 `'tools/execut'`，替身层
 *    45 个用例**全绿**，而真实运行时整功能静默失效、零报错。
 *
 * ③ **真实上游**（不在本文件，见验证记录）：端到端跑通映射链。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installWebNative, type WebNativeToolExecution } from '../../src/web-native.js'
// ⚠️ 契约（错误类型 / 错误码 / 适配器面 / 结果形状）住在 `native-search-contract.ts`，
//    **不从 `web-native.ts` 取** —— 那个模块现在只留工具层逻辑（2026-10-14 架构改造）。
import {
  NativeSearchCodes,
  WebNativeError,
  type NativeSearchAdapter,
  type NativeSource,
} from '../../src/native-search-contract.js'
// ⚠️ 替身的 `searchOnce` 委托给**真实的腾讯实现**（理由见 `makeAdapter` 注释）。
import { performBuddySearch } from '../../src/buddy-adapter.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'

// ───────────────────────── 替身 ─────────────────────────

/** 造一个最小 exec：只有本模块读到的字段。 */
function makeExec(overrides: {
  name?: string
  args?: unknown
  provider?: string | undefined
  model?: string | undefined
  withAgent?: boolean
  signal?: AbortSignal
} = {}): WebNativeToolExecution {
  const withAgent = overrides.withAgent ?? true
  return {
    name: overrides.name ?? 'web_search',
    arguments: overrides.args ?? { queries: ['hello'] },
    signal: overrides.signal ?? new AbortController().signal,
    ...withAgent
      ? {
          agent: {
            session: {
              requestHeader: () => ({
                config: { provider: overrides.provider ?? 'workbuddy', model: overrides.model ?? 'deepseek-v4.1-flash' },
              }),
            },
          },
        }
      : {},
  }
}

/**
 * 造一个记录调用的适配器替身。
 *
 * ## ⚠️ `searchOnce` 委托给**真实的腾讯实现**（`performBuddySearch`）
 *
 * 本文件测的是**工具层**（`web-native.ts`：渠道判断 / 合并 / 入参校验），按
 * 「结构化替身」原则，`searchOnce` 本该用一个手写假实现。
 *
 * **但 2026-10-14 的架构改造**把腾讯取数搬到了 `buddy-adapter.ts`，而本文件
 * 原有的 20+ 条用例（请求形状 / `results[]` 投影 / 边界防御）**测的正是那段逻辑**。
 * 若这里换成假实现，那些用例会全部失去意义（变成自测自）。
 *
 * 故此处**故意委托真实实现**：`fetch` 仍被 `vi.stubGlobal` 拦截，故全程无网络。
 * 这是「借真实实现驱动工具层」的取舍 —— 代价是本文件对 `buddy-adapter.ts` 有
 * 隐性耦合；好处是那 20+ 条用例**逐字保持有效**，不用改一行断言。
 *
 * ⚠️ Qoder 渠道的工具层行为**不在这里测**（Qoder 的取数在 `qoder-adapter.ts`，
 * 由 `qoder-web-search.spec.ts` 覆盖）。本文件的渠道用例全部走腾讯。
 *
 * @param credential - 凭据替身；`'default'` 表示「有效凭据」。
 */
function makeAdapter(credential: { access_token: string } | undefined | 'default' = 'default') {
  const calls: Array<string | undefined> = []
  const resolved = credential === 'default' ? { access_token: 'AT' } : credential
  const adapter: NativeSearchAdapter = {
    resolveCredentialFor: async (modelId) => {
      calls.push(modelId)
      return resolved as never
    },
    searchOnce: async (query, cred, signal) =>
      await performBuddySearch(query, cred, signal, WORKBUDDY),
  }
  return { adapter, calls }
}

/**
 * 造一个**恒无凭据**的适配器替身。
 *
 * ⚠️ 不能写成 `makeAdapter(undefined)`：JS 的默认参数在实参为 `undefined` 时
 * **会触发默认值**，于是替身照样返回有效凭据，用例变成假绿（首版就踩了这个坑）。
 *
 * ⚠️ 这里也委托真实实现：无凭据时它会抛 `noAccount` 错误 —— 正是我们要断言的。
 */
function makeNoCredentialAdapter() {
  const calls: Array<string | undefined> = []
  const adapter: NativeSearchAdapter = {
    resolveCredentialFor: async (modelId) => {
      calls.push(modelId)
      return undefined as never
    },
    searchOnce: async (query, cred, signal) =>
      await performBuddySearch(query, cred, signal, WORKBUDDY),
  }
  return { adapter, calls }
}

/** 造一个绑定到指定产品（决定端点前缀）的适配器替身。 */
function makeProductAdapter(product: typeof CODEBUDDY | typeof WORKBUDDY) {
  const adapter: NativeSearchAdapter = {
    resolveCredentialFor: async () => ({ access_token: 'AT' }) as never,
    searchOnce: async (query, cred, signal) => await performBuddySearch(query, cred, signal, product),
  }
  return adapter
}

/**
 * 挂载并返回「执行一次工具调用」的驱动。
 *
 * ⚠️ 只实现本模块用到的事件面：`ctx.inject(['tools'], cb)` 直接同步回调，
 * `scope.on('tools/execute', listener)` 收下监听器。
 *
 * @param adapters - 渠道 → 适配器替身。
 * @param isEnabled - 总开关求值函数；缺省为**恒开**（绝大多数用例的前提）。
 */
function mount(
  adapters: Record<string, NativeSearchAdapter>,
  isEnabled: () => boolean = () => true,
) {
  const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => unknown> = []
  const ctx = {
    inject: (_names: string[], cb: (scope: unknown) => void) => {
      cb({
        on: (_name: string, listener: (exec: unknown, next: () => Promise<unknown>) => unknown) => {
          listeners.push(listener)
        },
      })
    },
  } as unknown as Context
  installWebNative(ctx, adapters, isEnabled)
  return async (exec: WebNativeToolExecution, next = async () => ({ value: 'official' })) => {
    expect(listeners).toHaveLength(1)
    return await listeners[0]!(exec, next)
  }
}

/** 造一个 JSON Response。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ───────────────────────── ① 渠道判断 ─────────────────────────

describe('渠道判断：只做 buddy 系', () => {
  it('⚠️ web_fetch 必须放行给官方（2026-10-14 决定：本模块不接管它）', async () => {
    // ⚠️ 这是**已被推翻过一次的决策**：本模块早期同时实现了腾讯
    //    `/agenttool/v1/webfetch`，2026-10-14 实测后整体剔除（是净损失，
    //    理由见 web-native.ts 模块头）。这条守卫锁住「不再接管」，防止
    //    将来有人顺手把它加回来 —— 加回来会让表格式页面的结构塌陷。
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'OFFICIAL-FETCH' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await run(
        makeExec({ name: 'web_fetch', provider: 'workbuddy', args: { url: 'https://e.com/' } }),
        next,
      )
      expect(next).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ value: 'OFFICIAL-FETCH' })
      // 关键：一次上游请求都不该发
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ web_fetch 在总开关开着时也必须放行（开关只管 web_search）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter }, () => true)
    const next = vi.fn(async () => ({ value: 'OFFICIAL-FETCH' }))
    const result = await run(
      makeExec({ name: 'web_fetch', provider: 'workbuddy', args: { url: 'https://e.com/' } }),
      next,
    )
    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ value: 'OFFICIAL-FETCH' })
  })

  it('workbuddy 渠道命中，走原生（官方工具体不执行）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' }), next)
      expect(next).not.toHaveBeenCalled()
      expect(result).toEqual({ value: { sources: [], truncated: false } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('buddy 渠道命中', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ buddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    try {
      const result = await run(makeExec({ provider: 'buddy' }), next)
      expect(next).not.toHaveBeenCalled()
      expect(result).toEqual({ value: { sources: [], truncated: false } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 非 buddy 系渠道（codearts）原样放行，官方链路逐字节不变', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter, buddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    const result = await run(makeExec({ provider: 'codearts' }), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ value: 'official' })
  })

  it('⚠️ deepseek-account 渠道也放行（官方账号令牌路径不受影响）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    await run(makeExec({ provider: 'deepseek-account' }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('非 web 工具原样放行', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    await run(makeExec({ name: 'read', provider: 'workbuddy' }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('无 agent（非会话调用）原样放行', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    await run(makeExec({ withAgent: false }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── ② 选号一致性 ─────────────────────────

describe('选号：与聊天链路同一套编排', () => {
  it('用当前会话路由的 model 调 resolveCredentialFor', async () => {
    const { adapter, calls } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    try {
      await run(makeExec({ provider: 'workbuddy', model: 'glm-5.3' }))
      expect(calls).toEqual(['glm-5.3'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('无可用账号时抛 WEB_NATIVE_NO_ACCOUNT，且文案含渠道与指引', async () => {
    const { adapter } = makeNoCredentialAdapter()
    const run = mount({ workbuddy: adapter })
    // ⚠️ 必须 stub fetch：无凭据时本模块**不应发出任何请求**，
    //    若漏 stub，用例会打到真实网络并报 401（首版就踩了这个坑）。
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(run(makeExec({ provider: 'workbuddy' })))
        .rejects.toThrow(/no usable account/)
      await expect(run(makeExec({ provider: 'workbuddy' })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_NO_ACCOUNT' })
      // 无凭据 ⇒ 一次请求都不该发
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('空 access_token 同样按「无可用账号」处理', async () => {
    const { adapter } = makeAdapter({ access_token: '' })
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy' })))
      .rejects.toMatchObject({ code: 'WEB_NATIVE_NO_ACCOUNT' })
  })

  it('⚠️ 凭据形状损坏（缺 access_token）也报「无可用账号」，而不是 TypeError', async () => {
    // 凭据是 JSON.parse 出来的外部数据，形状不可信。只判 `credential === undefined`
    // 会让这里抛 `Cannot read properties of undefined (reading 'length')` ——
    // 模型看到一句无意义的 JS 报错，而不是「去登录」的指引。
    const { adapter } = makeAdapter({} as { access_token: string })
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy' })))
      .rejects.toMatchObject({ code: 'WEB_NATIVE_NO_ACCOUNT' })
  })

  it('⚠️ access_token 类型错误（非字符串）同样按「无可用账号」处理', async () => {
    const { adapter } = makeAdapter({ access_token: 123 as unknown as string })
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy' })))
      .rejects.toMatchObject({ code: 'WEB_NATIVE_NO_ACCOUNT' })
  })
})

// ───────────────────────── ③ 请求形状 ─────────────────────────

describe('请求形状：与客户端原生实现对齐', () => {
  it('search 打 {endpoint}/agenttool/v1/search，body 为官方形态', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await run(makeExec({ provider: 'workbuddy', args: { queries: ['天气'] } }))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
      expect(url).toBe('https://www.workbuddy.ai/agenttool/v1/search')
      expect(JSON.parse(String(init.body))).toEqual({ query: '天气', type: 'text2text', max_results: 8 })
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer AT')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('buddy 渠道用 copilot.tencent.com（与插件 product.ts 一致）', async () => {
    // ⚠️ 端点前缀由**产品配置**决定，故这里必须绑 `CODEBUDDY`（不是默认的 WORKBUDDY）。
    const adapter = makeProductAdapter(CODEBUDDY)
    const run = mount({ buddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await run(makeExec({ provider: 'buddy', args: { queries: ['x'] } }))
      const [url] = fetchMock.mock.calls[0]! as unknown as [string]
      expect(url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    } finally {
      vi.unstubAllGlobals()
    }
  })

})

// ───────────────────────── ④ 结果投影 ─────────────────────────

describe('结果投影：search', () => {
  it('results[] → sources[]，字段一对一', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [
        { title: 'T1', url: 'https://a.com/', snippet: 'S1' },
        { title: 'T2', url: 'https://b.com/', snippet: 'S2' },
      ],
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' })) as { value: { sources: unknown[] } }
      expect(result.value.sources).toEqual([
        { url: 'https://a.com/', title: 'T1', snippet: 'S1' },
        { url: 'https://b.com/', title: 'T2', snippet: 'S2' },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 缺 url 的条目被丢弃（url 是官方 schema 必填，留着会让整个调用失败）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [
        { title: 'no-url', snippet: 'x' },
        { title: 'ok', url: 'https://a.com/' },
      ],
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' })) as { value: { sources: Array<{ url: string }> } }
      expect(result.value.sources).toHaveLength(1)
      expect(result.value.sources[0]!.url).toBe('https://a.com/')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('空 title / snippet 不写入（官方 schema 里它们是可选字段）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [{ url: 'https://a.com/', title: '', snippet: '' }],
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' })) as { value: { sources: unknown[] } }
      expect(result.value.sources).toEqual([{ url: 'https://a.com/' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('results 不是数组 → WEB_NATIVE_BAD_RESPONSE', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: 'nope' })))
    try {
      await expect(run(makeExec({ provider: 'workbuddy' })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_BAD_RESPONSE' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────────────────────── ⑤ 多 query 合并 ─────────────────────────

describe('多 query：复刻官方轮转合并', () => {
  it('按 rank 轮转交错，而非拼接', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const byQuery: Record<string, unknown> = {
      q1: { results: [{ url: 'https://a1.com/' }, { url: 'https://a2.com/' }] },
      q2: { results: [{ url: 'https://b1.com/' }, { url: 'https://b2.com/' }] },
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      return jsonResponse(byQuery[body.query])
    }))
    try {
      const result = await run(makeExec({ provider: 'workbuddy', args: { queries: ['q1', 'q2'] } })) as {
        value: { sources: Array<{ url: string }> }
      }
      // 轮转：a1, b1, a2, b2 —— 不是 a1, a2, b1, b2
      expect(result.value.sources.map((s) => s.url)).toEqual([
        'https://a1.com/', 'https://b1.com/', 'https://a2.com/', 'https://b2.com/',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('url 去重：重复 URL 只保留一次', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [{ url: 'https://same.com/' }, { url: 'https://other.com/' }],
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy', args: { queries: ['q1', 'q2'] } })) as {
        value: { sources: Array<{ url: string }> }
      }
      expect(result.value.sources.map((s) => s.url)).toEqual(['https://same.com/', 'https://other.com/'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超过上限时截断并置 truncated', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    // 单 query 返回 10 条 → 截到 8
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: Array.from({ length: 10 }, (_, i) => ({ url: `https://x${i}.com/` })),
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy', args: { queries: ['q'] } })) as {
        value: { sources: unknown[]; truncated: boolean }
      }
      expect(result.value.sources).toHaveLength(8)
      expect(result.value.truncated).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 含空白项的 queries 抛错（官方 parseSearchArgs 同判据）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(run(makeExec({ provider: 'workbuddy', args: { queries: ['a', '  '] } })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_INVALID_ARGS' })
      // 校验失败 ⇒ 一次请求都不该发
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 超过 4 个 query 抛错（官方 maxQueries 判据；短路跳过了官方校验，必须自己补）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(run(makeExec({ provider: 'workbuddy', args: { queries: ['a', 'b', 'c', 'd', 'e'] } })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_INVALID_ARGS' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('queries 非数组抛错', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy', args: { queries: 'not-array' } })))
      .rejects.toMatchObject({ code: 'WEB_NATIVE_INVALID_ARGS' })
  })

  it('queries 为空数组抛错', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy', args: { queries: [] } })))
      .rejects.toMatchObject({ code: 'WEB_NATIVE_INVALID_ARGS' })
  })

  it('恰好 4 个 query 通过', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await run(makeExec({ provider: 'workbuddy', args: { queries: ['a', 'b', 'c', 'd'] } }))
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('空结果 query 参与轮转（不影响其余 query 的合并）', async () => {
    // ⚠️ **本用例名曾经叫「稀疏 Map 安全」，那是名不副实的**（对抗性审查第二轮 §5.1）：
    //    这里的 q1 是 `{results:[]}` —— 它**成功**返回空数组，`perQuery.set(0, [])`
    //    照常执行，**根本不产生稀疏空洞**，故捕获不到它声称要捕获的缺陷。
    //    （实际也不会有空洞：失败路径必然先被 `firstFailure` 抛掉，见实现注释。）
    //    保留它是因为「空结果不破坏轮转顺序」本身值得守，但不再宣称它守「稀疏安全」。
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const byQuery: Record<string, unknown> = {
      q1: { results: [] },                                          // 空结果
      q2: { results: [{ url: 'https://b1.com/' }, { url: 'https://b2.com/' }] },
      q3: { results: [{ url: 'https://c1.com/' }] },
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      return jsonResponse(byQuery[body.query])
    }))
    try {
      const result = await run(makeExec({ provider: 'workbuddy', args: { queries: ['q1', 'q2', 'q3'] } })) as {
        value: { sources: Array<{ url: string }> }
      }
      // rank 轮转：q2[0], q3[0], q2[1]  （q1 空，跳过）
      expect(result.value.sources.map((s) => s.url)).toEqual([
        'https://b1.com/', 'https://c1.com/', 'https://b2.com/',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ query 顺序决定轮转顺序（并发完成顺序不得影响结果排列）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const byQuery: Record<string, unknown> = {
      slow: { results: [{ url: 'https://slow.com/' }] },
      fast: { results: [{ url: 'https://fast.com/' }] },
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      // 让第一个 query 慢、第二个快 —— 完成顺序与 `queries` 顺序相反
      if (body.query === 'slow') await new Promise((r) => setTimeout(r, 20))
      return jsonResponse(byQuery[body.query])
    }))
    try {
      const result = await run(makeExec({ provider: 'workbuddy', args: { queries: ['slow', 'fast'] } })) as {
        value: { sources: Array<{ url: string }> }
      }
      // rank 0 应先是 `slow`（queries[0]），不是先完成的 `fast`
      expect(result.value.sources.map((s) => s.url)).toEqual(['https://slow.com/', 'https://fast.com/'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('query 去重（完全相同的串只发一次）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await run(makeExec({ provider: 'workbuddy', args: { queries: ['a', 'a', 'b'] } }))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────────────────────── ⑥ 错误语义 ─────────────────────────

describe('错误：直接抛，不自己包装', () => {
  it('上游非 2xx → WEB_NATIVE_UPSTREAM，文案带端点与指引', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    try {
      await expect(run(makeExec({ provider: 'workbuddy' }))).rejects.toMatchObject({
        code: 'WEB_NATIVE_UPSTREAM',
      })
      await expect(run(makeExec({ provider: 'workbuddy' }))).rejects.toThrow(/agenttool\/v1\/search/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('非 JSON 响应 → WEB_NATIVE_BAD_RESPONSE', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    try {
      await expect(run(makeExec({ provider: 'workbuddy' })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_BAD_RESPONSE' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('抛的是 WebNativeError（宿主据此产出 isError 结果）', async () => {
    const { adapter } = makeNoCredentialAdapter()
    const run = mount({ workbuddy: adapter })
    await expect(run(makeExec({ provider: 'workbuddy' }))).rejects.toBeInstanceOf(WebNativeError)
  })

  it('调用方取消 → WEB_NATIVE_ABORTED（与超时区分）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    }))
    try {
      await expect(run(makeExec({ provider: 'workbuddy', signal: controller.signal })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_ABORTED' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 内部 deadline 触发时 → WEB_NATIVE_TIMEOUT（与取消、上游故障区分）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    // 把内部 20s 预算缩成 1ms，从而在毫秒级走到 timeout 分支而不真等 20s。
    // `signal.aborted` 为假（调用方没取消）而 `timeout.aborted` 为真 —— 这正是
    // 实现里区分「取消」与「超时」的判据。
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) =>
      realTimeout(ms === 20_000 ? 1 : ms))
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const reason: unknown = await new Promise((resolve) => {
        const sig = init.signal
        if (sig?.aborted === true) return resolve(sig.reason)
        sig?.addEventListener('abort', () => resolve(sig.reason), { once: true })
      })
      throw reason instanceof Error ? reason : new DOMException('timed out', 'TimeoutError')
    }))
    try {
      const err = await run(makeExec({ provider: 'workbuddy' })).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'WEB_NATIVE_TIMEOUT' })
      // 文案必须点明是**我们自己的** 20s 预算用尽（不是外层工具预算）。
      expect((err as Error).message).toMatch(/timed out after 20000ms/)
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  /**
   * ⚠️⚠️ **本条对应 PR95 审计发现的真实缺陷（D3）**。
   *
   * 本模块在 cordis waterfall 的**内层**（实测：`dsh-base` 的
   * `tool-call-timeout-policy` 先注册 ⇒ 在外层），所以生产环境里传进来的
   * `exec.signal` **就是**外层那条带 deadline 的信号。外层到期时：
   *
   * - `signal.aborted === true`（新旧实现在这里**没有区别**）；
   * - 但 `signal.reason` 是 harness 的 `TimeoutReason`
   *   （`name:'TimeoutReason'`、`code:'TOOL_TIMEOUT'`），
   *   **不是**调用方取消的 `DOMException`/`AbortError`。
   *
   * 旧实现先判 `signal.aborted` 就归 `aborted` ⇒ 把**超时**报成「search aborted」
   * （像是用户按了停止），文案里那串排障指引（端点、重试建议）**全部丢失**。
   *
   * ⚠️ 判据刻意写成「**不是** aborted 且**是** timeout」两条：只写后者的话，
   * 一个把两者都判成 timeout 的实现也能过。
   */
  it('⚠️⚠️ 外层 harness deadline 到期（TimeoutReason）→ TIMEOUT，不得误报 aborted', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const authority = new AbortController()
    const timeoutReason = Object.assign(new Error('TOOL_TIMEOUT after 1ms'), {
      name: 'TimeoutReason', code: 'TOOL_TIMEOUT', timeoutMs: 1,
    })
    // 模拟外层 deadline 到期：它 abort 的是**它自己替换后的** exec.signal，
    // 故这里直接给一个已带该 reason 中止的信号。
    authority.abort(timeoutReason)
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeoutReason }))
    try {
      const err = await run(makeExec({ provider: 'workbuddy', signal: authority.signal }))
        .catch((e: unknown) => e)
      expect((err as { code?: string }).code).not.toBe('WEB_NATIVE_ABORTED')
      expect(err).toMatchObject({ code: 'WEB_NATIVE_TIMEOUT' })
      expect((err as Error).message).toMatch(/agenttool\/v1\/search/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 调用方取消（AbortError）仍归 ABORTED（新判据不得把取消翻成超时）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const controller = new AbortController()
    controller.abort(new DOMException('user stop', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('user stop', 'AbortError') }))
    try {
      const err = await run(makeExec({ provider: 'workbuddy', signal: controller.signal }))
        .catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'WEB_NATIVE_ABORTED' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────── ⑦ 对抗性审查发现的边界（每条都对应一个真实缺陷） ─────────

describe('对抗性审查回归：畸形上游数据不得炸掉整条调用', () => {
  it('⚠️ M2：results 里含 null 项时丢弃该项，而不是整条调用失败', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [null, { url: 'https://ok.com/' }],
    })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' })) as { value: { sources: unknown[] } }
      expect(result.value.sources).toEqual([{ url: 'https://ok.com/' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ M2：响应体本身是 JSON null 时报业务错误，而不是 TypeError', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)))
    try {
      await expect(run(makeExec({ provider: 'workbuddy' })))
        .rejects.toMatchObject({ code: 'WEB_NATIVE_BAD_RESPONSE' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ M3：渠道名取到原型链属性（constructor）时必须放行，不得短路', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const next = vi.fn(async () => ({ value: 'official' }))
    // `CHANNEL_PRODUCTS['constructor']` 在对象字面量上是 truthy 的
    //（`Object.prototype.constructor`），守卫若用裸下标就会失效。
    for (const channel of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const result = await run(makeExec({ provider: channel }), next)
      expect(result).toEqual({ value: 'official' })
    }
    expect(next).toHaveBeenCalledTimes(5)
  })

  it('⚠️ M1：多 query 时一方失败会中止兄弟请求（对齐官方 allSettled + abort）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    const aborted: string[] = []
    const started: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      started.push(body.query)
      if (body.query === 'q1') throw new Error('boom')
      // q2：挂起，并在被 abort 时记录
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted.push(body.query)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }))
    try {
      await expect(run(makeExec({ provider: 'workbuddy', args: { queries: ['q1', 'q2'] } })))
        .rejects.toThrow(/boom/)
      // 两个都发出去了，且 q2 被中止（裸 Promise.all 不会中止兄弟）
      expect(started).toContain('q2')
      expect(aborted).toContain('q2')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────── ⑧ M1 的真实缺口：allSettled 的「等待兄弟结算」语义 ─────────

describe('M1 回归：多 query 必须等兄弟结算后才返回', () => {
  it('⚠️ 兄弟的 abort 结算发生在下一个宏任务时，函数仍要等它', async () => {
    // ⚠️ 这条用例专门对付一个**假守卫**（对抗性审查第二轮 §5.3）：
    //    若兄弟的 abort 回调是**同步** reject，`Promise.all` 与
    //    `Promise.allSettled` 两种实现**不可区分**，用例捕获不到把
    //    allSettled 改回 all 的变异。故这里让兄弟的结算**异步**发生。
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter })
    let siblingSettled = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      if (body.query === 'q1') throw new Error('boom')
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          // 异步结算：模拟真实网络拆除需要时间
          setTimeout(() => {
            siblingSettled = true
            reject(new DOMException('aborted', 'AbortError'))
          }, 20)
        })
      })
    }))
    try {
      await expect(run(makeExec({ provider: 'workbuddy', args: { queries: ['q1', 'q2'] } })))
        .rejects.toThrow(/boom/)
      // `Promise.all` 会在 q1 失败时**立刻**返回，此时 siblingSettled 仍为 false
      expect(siblingSettled).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────── ⑨ 总开关：关掉即所有渠道回官方 ─────────

describe('渠道原生搜索总开关', () => {
  it('⚠️ 开关关闭时，buddy 系渠道也放行到官方（不得短路）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter, buddy: adapter }, () => false)
    const next = vi.fn(async () => ({ value: 'official' }))
    for (const provider of ['workbuddy', 'buddy']) {
      const result = await run(makeExec({ provider }), next)
      expect(result).toEqual({ value: 'official' })
    }
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 开关关闭时一次上游请求都不发（不是拦下结果，而是根本不执行）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter }, () => false)
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await run(makeExec({ provider: 'workbuddy' }), async () => ({ value: 'official' }))
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 开关每次调用都重新求值（切换后立即生效，不依赖重挂载）', async () => {
    const { adapter } = makeAdapter()
    let enabled = true
    const run = mount({ workbuddy: adapter }, () => enabled)
    const next = vi.fn(async () => ({ value: 'official' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://native/' }] })))
    try {
      // 开：走原生
      const on = await run(makeExec({ provider: 'workbuddy' }), next)
      expect(on).toEqual({ value: { sources: [{ url: 'https://native/' }], truncated: false } })
      expect(next).not.toHaveBeenCalled()

      // 切成关：同一份监听器，下一次调用就该放行
      enabled = false
      const off = await run(makeExec({ provider: 'workbuddy' }), next)
      expect(off).toEqual({ value: 'official' })
      expect(next).toHaveBeenCalledTimes(1)

      // 再切回开：仍走原生
      enabled = true
      const back = await run(makeExec({ provider: 'workbuddy' }), next)
      expect(back).toEqual({ value: { sources: [{ url: 'https://native/' }], truncated: false } })
      expect(next).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('开关开启时行为不变（回归：默认路径不受影响）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter }, () => true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://native/' }] })))
    try {
      const result = await run(makeExec({ provider: 'workbuddy' }))
      expect(result).toEqual({ value: { sources: [{ url: 'https://native/' }], truncated: false } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 开关关闭时，非 web 工具与畸形入参都不受影响（开关只作用于 web 工具）', async () => {
    const { adapter } = makeAdapter()
    const run = mount({ workbuddy: adapter }, () => false)
    const next = vi.fn(async () => ({ value: 'official' }))
    // 非 web 工具照常放行
    await run(makeExec({ name: 'read', provider: 'workbuddy' }), next)
    expect(next).toHaveBeenCalledTimes(1)
    // 即使入参畸形也不该由我们抛错（我们根本没接管）
    await run(makeExec({ provider: 'workbuddy', args: { queries: 'not-array' } }), next)
    expect(next).toHaveBeenCalledTimes(2)
  })
})

// ───────── ⑩ 真实 cordis 集成：把事件名/服务名纳入红区 ─────────

describe('真实 cordis 集成', () => {
  /** 用真 Context 挂载，并等 inject 回调（异步触发）完成。 */
  async function mountReal(adapters: Record<string, NativeSearchAdapter>) {
    const ctx = new Context()
    ctx.provide('tools', { marker: 'tools-service' } as never)
    installWebNative(ctx as never, adapters, () => true)
    // ⚠️ cordis 的 inject 回调是**异步**触发的，必须等一个 tick，
    //    否则 waterfall 触发时监听器还没注册（真实踩过的坑）。
    await new Promise((resolve) => setTimeout(resolve, 10))
    return ctx
  }

  const adapter: NativeSearchAdapter = {
    resolveCredentialFor: async () => ({ access_token: 'AT' }) as never,
    // 与 `makeAdapter` 同款：委托真实腾讯实现，`fetch` 由用例 stub。
    searchOnce: async (query, cred, signal) =>
      await performBuddySearch(query, cred, signal, WORKBUDDY),
  }

  function exec(provider: string): WebNativeToolExecution {
    return {
      name: 'web_search',
      arguments: { queries: ['x'] },
      signal: new AbortController().signal,
      agent: { session: { requestHeader: () => ({ config: { provider, model: 'm' } }) } },
    }
  }

  it('⚠️ 真实 waterfall：命中渠道时官方工具体不执行（短路）', async () => {
    const ctx = await mountReal({ workbuddy: adapter })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://native/' }] })))
    let innerRan = 0
    try {
      const out = await (ctx as unknown as { waterfall: (...a: unknown[]) => unknown })
        .waterfall('tools/execute', exec('workbuddy'), async () => { innerRan++; return { value: 'OFFICIAL' } })
      expect(innerRan).toBe(0)
      expect(out).toEqual({ value: { sources: [{ url: 'https://native/' }], truncated: false } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⚠️ 真实 waterfall：非 buddy 渠道放行到官方工具体', async () => {
    const ctx = await mountReal({ workbuddy: adapter })
    let innerRan = 0
    const out = await (ctx as unknown as { waterfall: (...a: unknown[]) => unknown })
      .waterfall('tools/execute', exec('codearts'), async () => { innerRan++; return { value: 'OFFICIAL' } })
    expect(innerRan).toBe(1)
    expect(out).toEqual({ value: 'OFFICIAL' })
  })

  it('⚠️ Major-1 对照：事件名拼错时监听器完全不触发（证明名字必须精确）', async () => {
    // 这条**不是**在测本模块的行为，而是证明「事件名写错」有真实后果 ——
    // 它把 `web-native.ts` 里的字符串常量纳入红区：若有人把
    // `'tools/execute'` 改成别的，这里会因为「监听器压根不触发」而暴露语义，
    // 同时上一条用例会变红。
    const ctx = await mountReal({ workbuddy: adapter })
    let ran = 0
    await (ctx as unknown as { waterfall: (...a: unknown[]) => unknown })
      .waterfall('tools/execut', exec('workbuddy'), async () => { ran++; return { value: 'OFFICIAL' } })
    expect(ran).toBe(1)
  })

  it('⚠️ 缺 tools 服务时 inject 回调不执行（整功能静默不生效，不崩）', async () => {
    // 与 `loop-recovery.ts` 的 `ctx.inject(['agents'], …)` 同一取舍：
    // 服务缺席时功能整体不生效，而不是让 profile 永久 pending。
    // 这里 `provide('tools')` 是**空的** —— cordis 只在服务真正可用时触发回调。
    const ctx = new Context()
    ctx.provide('tools', {} as never)
    installWebNative(ctx as never, { workbuddy: adapter }, () => true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 服务在场 ⇒ 我们的监听器**应该**已注册，命中渠道时应短路。
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://native/' }] })))
    try {
      let innerRan = 0
      const out = await (ctx as unknown as { waterfall: (...a: unknown[]) => unknown })
        .waterfall('tools/execute', exec('workbuddy'), async () => { innerRan++; return { value: 'OFFICIAL' } })
      expect(innerRan).toBe(0)
      expect(out).toEqual({ value: { sources: [{ url: 'https://native/' }], truncated: false } })

      // 关键判据：**未** provide 'tools' 时，回调不该执行、监听器不存在，
      // 于是 waterfall 直接落到内层（官方路径）。
      const bare = new Context()
      installWebNative(bare as never, { workbuddy: adapter }, () => true)
      await new Promise((resolve) => setTimeout(resolve, 10))
      let bareInnerRan = 0
      const bareOut = await (bare as unknown as { waterfall: (...a: unknown[]) => unknown })
        .waterfall('tools/execute', exec('workbuddy'), async () => { bareInnerRan++; return { value: 'OFFICIAL' } })
      expect(bareInnerRan).toBe(1)
      expect(bareOut).toEqual({ value: 'OFFICIAL' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
