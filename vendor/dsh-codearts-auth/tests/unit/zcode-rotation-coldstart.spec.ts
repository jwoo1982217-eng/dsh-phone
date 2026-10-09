/**
 * ZCode **冷启动首轮切号空转**的回归测试（真实缺陷，2026-10-06）。
 *
 * ## 用户报障
 *
 * > 用完余额一个号就自动卡死了，不会切下一个号。
 *
 * ## 根因（在役代码实测）
 *
 * `zcode-adapter.ts` 的 `streamScoped()` 里，**账号 id 的读取排在凭据解析之前**：
 *
 * ```ts
 * let activeAccountId = this.options.currentAccountId?.()   // ← 先读
 * let credential = await this.resolveCredentialOrThrow(options)  // ← 后解析
 * ```
 *
 * 而 `currentAccountId()` 读的是 `index.ts` 里 `activeZcodeAccountId` 那个 Map ——
 * 它**只在 `resolveCredential` 内部被写入**。进程刚启动（或该 provider 首次被调用）时
 * Map 是空的 ⇒ `activeAccountId === undefined`。
 *
 * 于是 `switchAccountOnQuota()` 里那个守卫：
 *
 * ```ts
 * if (activeAccountId !== undefined && activeAccountId.length > 0) {
 *   await pool.updateModelRateLimit(activeAccountId, ...)
 *   tried.add(activeAccountId)          // ← 只有进了这里才排除刚失败的账号
 * }
 * const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
 * ```
 *
 * **既不标记、也不把刚失败的账号放进 `tried`** ⇒ 池按「用户手动顺序」返回的
 * **第一个候选正是刚刚失败的那个**（它的冷却标记从未被写下）⇒ 这次「切号」
 * 切到的是**同一个账号、同一份凭据**，白发一次请求。
 *
 * ## ⚠ 代价是「硬失败」，不是「慢一发」（2026-10-06 复审实测）
 *
 * 受 `ZCODE.quotaSwitchMax === 2` 限制，一次用户请求最多发 3 发。
 * 空转的那一发把切号预算吃掉一格 ⇒ **池里最后一个账号永远够不着**：
 *
 * | 池 | 修复前 | 修复后 |
 * |---|---|---|
 * | 2 账号（A 用尽、B 可用） | `[A, A, B]` 成功 | `[A, B]` 成功 |
 * | **3 账号（A、B 用尽、C 可用）** | **`[A, A, B]` ⇒ 抛 `QUOTA_EXCEEDED`，C 从未被尝试** | `[A, B, C]` 成功 |
 *
 * ⇒ 用户看到的是「所有号都用完了」，而那个号其实还有额度 —— 这正是
 * 「卡死、不切下一个号」的完整解释。**「卡死」这个措辞是准确的。**
 *
 * ## 本文件锁住什么
 *
 * 1. **池里最后一个账号必须被尝试到**（第 1 条，3 账号池）—— 这是**唯一**
 *    能复现用户症状的规模。⚠ 只用 2 账号池复现不出来：那种规模下缺陷版
 *    也能成功（`[A,A,B]`），只是多发一发。**别把这条删成 2 账号池。**
 * 2. **首次切号必须落到不同账号**（第 2 条，2 账号池）。
 * 3. **单账号池如实报错、不空转**（第 3 条）。
 * 4. **`tried` 与限流标记的接线契约**（第 4 条）—— 见下。
 * 5. **兜底路径的正确行为**（第 5 条）—— 见下。
 *
 * ## ⚠ 第 4 条存在的原因：行为断言锁不住「谁负责排除」
 *
 * 排除刚失败的账号其实有**三重冗余**机制：① `streamScoped` 顶部的
 * `tried.add(activeAccountId)`；② `switchAccountOnQuota` 内部的同一个 add；
 * ③ 写进池的 `modelRateLimits` 标记（`getAvailableAccount` 会自己过滤掉）。
 *
 * 后果：**单点删除任一处，上面第 1~3 条行为断言仍然全绿**（2026-10-06 复审
 * 实测）—— 它们锁的是行为，而行为被另外两道防线兜住了。这不是缺陷，是
 * defense-in-depth；但它意味着**行为测试对「接线是否还在」零区分能力**。
 *
 * ⇒ 第 4 条改为断言**接线契约本身**：首次切号时传给池的 `tried` 必须含
 * 刚失败的账号，且必须为该账号写下限流标记。删除全部 `tried.add` ⇒
 * `triedSeen[0]` 变空、本断言变红；删除标记写入 ⇒ `marks` 变空、变红。
 *
 * ## ⚠ 第 5 条存在的原因：兜底路径**不是**缺陷，但要防止「顺手修坏」
 *
 * 池被筛空时会落到 `index.ts` 的 `zcode.current()` 兜底（它不看 `enabled`
 * 也不看 `modelRateLimits`，照样返回凭据）。此时 `activeAccountId` 是
 * `undefined` ⇒ 守卫跳过 ⇒ **不标记任何账号**。
 *
 * ⚠ 这**不是**缺陷（2026-10-06 复审实测，5 条独立探针）：
 * `getAvailableAccount` 本身就按 `enabled` + `modelRateLimits` 过滤，
 * **能走到兜底就意味着已经没有「enabled 且未限流」的账号可切** ——
 * 此时标记谁都不会让它被选中，标记只会写一条永远不起作用的记录。
 * 正确行为是「只发 1 发、如实报 `QUOTA_EXCEEDED`」，第 5 条把它钉住。
 *
 * ⚠ 反向验证（每条都必须独立变红，别当同义反复删掉）：
 * - 把 `activeAccountId` 的读取挪回 `resolveCredential` **之前** ⇒ 第 1~3 条变红
 *   （3 账号池由成功变 `QUOTA_EXCEEDED`）；
 * - 删掉**两处** `tried.add(activeAccountId)` ⇒ 第 4 条变红（`triedSeen[0]` 为空）；
 * - 删掉 `switchAccountOnQuota` 里的 `updateModelRateLimit` ⇒ 第 4 条变红
 *   （`marks` 为空）。
 */
import { describe, expect, it } from 'vitest'

import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'

/* ────────────────────────── 桩 ────────────────────────── */

/** 上游业务错误（HTTP 状态 + 业务码正文）。 */
function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一个能正常结束的 Anthropic SSE 响应。 */
function okSse(): Response {
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 一条池内账号（凭据里的 `jwt-<X>` / `mid-<X>` 便于断言「实际用了谁」）。 */
function account(id: string): { id: string; credential: Record<string, unknown> } {
  const suffix = id.slice(-1).toUpperCase()
  return { id, credential: { zcode_jwt: `jwt-${suffix}`, device_mid: `mid-${suffix}` } }
}

/**
 * **忠实复刻真实 `AccountPool` 语义**的桩：
 *
 * - 候选顺序 = 数组顺序（用户手动顺序，见 `account-pool.ts` 的 `getAvailableAccount`）
 * - `tried` 里的账号**必须被排除**
 * - **`modelRateLimits` 标记过的账号也要被排除**（真实池的第三重过滤）
 *
 * ⚠ 不能用 `zcode-throttle.spec.ts` 里那个 `stubPool` —— 它忽略 `tried`、
 * 恒返回 `options.next`，会把本缺陷**掩盖**成「切号成功」。
 */
function makePool(accounts: Array<{ id: string; credential: Record<string, unknown> }>) {
  const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  const triedSeen: Array<ReadonlySet<string>> = []
  const limited = new Map<string, Set<string>>()
  return {
    marks,
    triedSeen,
    pool: {
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marks.push({ accountId, modelId, resetAtMs })
        const set = limited.get(accountId) ?? new Set<string>()
        set.add(modelId)
        limited.set(accountId, set)
      },
      getAvailableAccount: async (
        _provider: string,
        modelId: string,
        tried?: ReadonlySet<string>,
      ) => {
        if (tried !== undefined) triedSeen.push(new Set(tried))
        const hit = accounts.find(
          (a) =>
            !(tried?.has(a.id) ?? false)
            && !(limited.get(a.id)?.has(modelId) ?? false),
        )
        if (hit === undefined) return null
        return { entry: { id: hit.id }, credential: hit.credential }
      },
    },
  }
}

/** 一轮最小可用的 `stream()` 参数。 */
function streamOptions(): never {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
  } as never
}

/**
 * 按**真实接线**构造适配器（逐字复刻 `index.ts:1612-1658`）：
 *
 * - `resolveCredential` **每次都调池取号**，并把「实际给了哪个账号」写进 `active`
 *   （对应 `index.ts` 的 `activeZcodeAccountId.set(...)`）
 * - `currentAccountId` 只**读**那个记录（对应 `() => activeZcodeAccountId.get(ZCODE.id)`）
 * - 池里没有可用条目时落 `zcode.current()` 兜底（不看 `enabled` / 限流）
 *
 * ⇒ 冷启动时 `active` 还是 `undefined`，缺陷才复现得出来。
 */
async function runScenario(options: {
  accounts: Array<{ id: string; credential: Record<string, unknown> }>
  /** 这些账号**真的**额度用尽（上游回 429 + 1005）。 */
  exhausted: ReadonlySet<string>
  /** 兜底凭据（池里取不到号时用到），对应 `zcode.current()`。 */
  fallbackCredential?: Record<string, unknown> | undefined
}): Promise<{
  calls: number
  auths: string[]
  marks: Array<{ accountId: string; modelId: string; resetAtMs: number }>
  triedSeen: Array<ReadonlySet<string>>
  chunks: number
  errorCode: string | undefined
}> {
  const { pool, marks, triedSeen } = makePool(options.accounts)
  let active: string | undefined
  let call = 0
  const auths: string[] = []
  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async (modelId?: string) => {
      const available = await (pool as unknown as {
        getAvailableAccount: (
          p: string,
          m: string,
        ) => Promise<{ entry: { id: string }; credential: Record<string, unknown> } | null>
      }).getAvailableAccount(ZCODE.id, modelId ?? '')
      if (available !== null) {
        // ★ 与 `index.ts:1626` 同形：记下**实际返回的**账号。
        active = available.entry.id
        return available.credential
      }
      // ★ 与 `index.ts:1638/1657` 同形：清空记录，落 `zcode.current()` 兜底。
      active = undefined
      return options.fallbackCredential
    },
    refresh: async () => {},
    mintCaptcha: async () => 'param',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      call += 1
      const headers = (init.headers ?? {}) as Record<string, string>
      const auth = headers['Authorization'] ?? ''
      auths.push(auth)
      const suffix = /jwt-([A-Z])/.exec(auth)?.[1]
      const id = options.accounts.find(a => a.id.endsWith(suffix ?? ''))?.id
      if (id !== undefined && options.exhausted.has(id)) {
        return errorResponse(429, { code: 1005, msg: 'exceed quota limit' })
      }
      return okSse()
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    product: ZCODE,
    accountPool: pool as never,
    // ★ 只读，与 `index.ts:1767` 的接线逐字同形。
    currentAccountId: () => active,
  })

  let chunks = 0
  let errorCode: string | undefined
  try {
    for await (const _chunk of adapter.stream(streamOptions())) chunks += 1
  } catch (error) {
    errorCode = (error as { code?: string }).code
  }
  return { calls: call, auths, marks, triedSeen, chunks, errorCode }
}

/* ────────────── 一、冷启动首轮必须切到「下一个」账号 ────────────── */

describe('ZCode 冷启动首轮切号（activeAccountId 尚未记录）', () => {
  it('★ 三账号池：额度用尽的账号之后，**池里最后一个账号也必须被尝试到**', async () => {
    // ⚠ 这是**唯一**能复现用户报障（「不会切下一个号」）的规模：
    //   2 账号池下缺陷版也能成功（多发一发），只有 ≥3 个才会把
    //   最后一个账号挤出切号预算。**别把它改成 2 账号池。**
    const result = await runScenario({
      accounts: [account('acct-A'), account('acct-B'), account('acct-C')],
      exhausted: new Set(['acct-A', 'acct-B']),
    })

    // 修复前：`[A, A, B]` 三发卡死、抛 QUOTA_EXCEEDED，**C 从未被尝试**。
    expect(result.auths.map(a => /jwt-([A-Z])/.exec(a)?.[1])).toEqual(['A', 'B', 'C'])
    expect(result.calls).toBe(3)
    expect(result.errorCode).toBeUndefined()
    expect(result.chunks).toBeGreaterThan(0)
    // 两个失败账号各自被标记一次（`acct-C` 成功了，不该被标记）。
    expect(result.marks.map(m => m.accountId)).toEqual(['acct-A', 'acct-B'])
  })

  it('★ 首次切号就必须落到**不同**账号（不得原地空转一发）', async () => {
    const result = await runScenario({
      accounts: [account('acct-A'), account('acct-B')],
      exhausted: new Set(['acct-A']),
    })

    // 修复前这里是 3 发：第 1 发失败 → 「切号」切回 acct-A → 第 2 发同样失败
    // → 才真正换到 acct-B → 第 3 发成功。
    expect(result.calls).toBe(2)
    expect(result.auths[0]).toContain('jwt-A')
    expect(result.auths[1]).toContain('jwt-B')
    expect(result.errorCode).toBeUndefined()
    expect(result.chunks).toBeGreaterThan(0)
    expect(result.marks.map(m => m.accountId)).toEqual(['acct-A'])
  })

  it('★ 单账号池：如实报错，不空转', async () => {
    const result = await runScenario({
      accounts: [account('acct-A')],
      exhausted: new Set(['acct-A']),
    })

    expect(result.calls).toBe(1)
    expect(result.errorCode).toBe('QUOTA_EXCEEDED')
    expect(result.marks).toHaveLength(1)
    expect(result.marks[0]?.accountId).toBe('acct-A')
  })

  it('★ 接线契约：首次切号必须把失败账号**传给池做排除**、并写下限流标记', async () => {
    /**
     * ⚠ 这一条锁的是**接线**而非行为（理由见文件头「第 4 条存在的原因」）：
     * 单点删除任一处 `tried.add` 时，上面第 1~3 条行为断言**仍然全绿**
     * —— 排除被「限流标记」那一道防线兜住了。故这里直接断言契约本身。
     */
    const result = await runScenario({
      accounts: [account('acct-A'), account('acct-B')],
      exhausted: new Set(['acct-A']),
    })

    // ① 传给池的 `tried` 必须含刚失败的账号（删掉两处 `tried.add` ⇒ 这里变空）。
    expect(result.triedSeen.length).toBeGreaterThan(0)
    expect(result.triedSeen[0]?.has('acct-A')).toBe(true)
    // ② 必须为该账号写下「该模型」的限流标记（删掉标记写入 ⇒ marks 变空）。
    expect(result.marks).toHaveLength(1)
    expect(result.marks[0]?.modelId).toBe('GLM-5.3-Flash')
    expect(result.marks[0]?.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('★ 兜底路径（池里已无 enabled 可用账号）：只发 1 发、不误标，如实报错', async () => {
    /**
     * 池被筛空 ⇒ 落 `zcode.current()` 兜底。此时**没有**账号条目可标记，
     * 且 `getAvailableAccount` 本就按 `enabled` + 限流过滤 ⇒ 标记谁都不会
     * 让它被选中。⇒ 正确行为是「如实报错、不写无效标记」。
     * ⚠ 别把这条「顺手修」成写标记 —— 那只会留一条永远不起作用的记录。
     */
    const result = await runScenario({
      accounts: [],
      exhausted: new Set(),
      fallbackCredential: { zcode_jwt: 'jwt-FALLBACK', device_mid: 'mid-FALLBACK' },
    })

    expect(result.calls).toBe(1)
    expect(result.auths[0]).toContain('jwt-FALLBACK')
    expect(result.marks).toEqual([])
  })
})
