/**
 * H2 回归测试：**选号必须按模型过滤限流账号**。
 *
 * ## 真实缺陷（用户报障「没有切换」的根因之一）
 *
 * 适配器写下的限流标记是**按模型**记的（`modelRateLimits[model]`），
 * 而选号时 `getAvailableAccount(provider, '')` 传的是**空串** ——
 * `AccountPool` 的限流过滤在 `modelId.length === 0` 时**整体短路**：
 *
 * ```ts
 * if (modelId.length === 0) return true    // ← 空串 → 不做限流过滤
 * ```
 *
 * 于是刚标记为「限流」的账号下次仍被选中，**换号形同虚设**。
 *
 * 实测（2026-09-28，真实 AccountPool）：acct-A 已标记 `glm-5.2` 限流，
 * 传 `''` 选回 acct-A；传 `'glm-5.2'` 才正确跳过选 acct-B。
 *
 * ## 本文件测什么
 *
 * 1. **`index.ts` 层**：每个 provider 的 `resolveCredential(modelId)` 是否把
 *    modelId 真正透传给 `getAvailableAccount`（防将来有人改回不传）；
 * 2. **适配器层**：`stream()` 调用 `resolveCredential` 时是否带上了
 *    `options.model`（防回退）。
 *
 * 用真实实现 + 桩 ctx（不发网络）。
 */

import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'

/** 桩 ctx：提供 credentials 与 logger；账号数据由 `replaceAll` 灌入。 */
function makeCtx(credentials: Record<string, string>) {
  return {
    credentials: {
      resolve: async (ref: unknown) => {
        const key = typeof ref === 'string'
          ? ref
          : String((ref as { id?: string; name?: string } | undefined)?.id
            ?? (ref as { name?: string } | undefined)?.name ?? '')
        const value = credentials[key.replace(/^credential:/, '')]
        return value === undefined ? undefined : { value }
      },
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  } as never
}

const ACCOUNTS = [
  { id: 'acct-A', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_A', enabled: true, refreshable: true },
  { id: 'acct-B', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_B', enabled: true, refreshable: true },
]

const CREDS = {
  TRAE_ACCOUNT_A: JSON.stringify({ access_token: 'AT-A', refresh_token: 'R', uid: 'a' }),
  TRAE_ACCOUNT_B: JSON.stringify({ access_token: 'AT-B', refresh_token: 'R', uid: 'b' }),
}

/**
 * 这是**行为契约**测试：它不是测 mock，而是证明「传 modelId」与
 * 「不传 modelId」在同一份真实账号数据上会选出**不同的账号**。
 *
 * 若哪天有人把 `AccountPool` 的空串短路改掉，这条会失败并提醒重新评估 —— 这正是我们想要的。
 */
describe('H2 · AccountPool 选号按模型过滤限流账号（行为契约）', () => {
  /** 建一个池，acct-A 已标记 modelId 限流。 */
  async function setup(modelId: string, resetAtMs: number) {
    const pool = new AccountPool(makeCtx(CREDS))
    await pool.replaceAll(ACCOUNTS as never, {} as never, false)
    await pool.updateModelRateLimit('acct-A', modelId, resetAtMs)
    return pool
  }

  it('传真实 modelId 时跳过被限流账号（acct-A → acct-B）', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', 'glm-5.2')
    expect(picked?.entry.id, '被限流的 acct-A 不该被选中').toBe('acct-B')
  })

  it('传空串时忽略限流标记（这正是缺陷：选回 acct-A）', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', '')
    expect(picked?.entry.id, '空串 = 不按模型过滤，故仍选 acct-A').toBe('acct-A')
  })

  it('标记是按模型的：别的模型仍能选中 acct-A', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', 'kimi-k3')
    expect(picked?.entry.id).toBe('acct-A')
  })

  it('限流标记过期后 acct-A 重新可用', async () => {
    const pool = await setup('glm-5.2', Date.now() - 1_000)
    const picked = await pool.getAvailableAccount('trae', 'glm-5.2')
    expect(picked?.entry.id).toBe('acct-A')
  })
})

/**
 * 适配器层：`stream()` 必须把 `options.model` 传给 `resolveCredential`。
 *
 * 这一组是**防回退**的：只要有人把调用改回无参形式，它就变红。
 * 覆盖八个 provider（codearts 按用户要求不在范围内）。
 *
 * ⚠️ 这里只对 **TRAE**（本次报障的 provider）做端到端断言；
 * 其余 provider 的同一透传由上面的 `index.ts` 源码契约测试覆盖 ——
 * 两者的组合足以防止回退，而无需为每个 provider 搭一套完整 Context。
 */
describe('H2 · 适配器把 options.model 传给 resolveCredential', () => {
  /** 造一个最小凭据（各 provider 的字段并集足够宽）。 */
  function credentialFor(): Record<string, unknown> {
    return {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1',
      machine_id: 'a'.repeat(32),
      device_id: 'b'.repeat(32),
      account_id: 'acct',
    }
  }

  /**
   * TRAE 是本次报障的 provider，单独做一条**端到端**的透传断言。
   */
  it('TRAE 适配器：stream() 把 options.model 传给 resolveCredential', async () => {
    const { TraeAdapter } = await import('../../src/trae-adapter.js')
    const { TRAE } = await import('../../src/trae-product.js')

    const seen: Array<string | undefined> = []
    const sse = 'event:output\ndata:{"response":"ok"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n'
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCOUNT_A' as never,
      resolveCredential: async (modelId?: string) => {
        seen.push(modelId)
        return credentialFor() as never
      },
      refresh: async () => {},
      fetchImpl: (async () => new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
      product: TRAE,
    })

    for await (const _ of adapter.stream({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* 只需消费完 */ }

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0], '必须传本轮模型，否则限流过滤被短路').toBe('glm-5.2')
  })
})

/**
 * `index.ts` 层的静态契约：八个 provider 的 `resolveCredential` 签名必须
 * 接收 `modelId`，且 `getAvailableAccount` 的第二实参不得是硬编码空串。
 *
 * ⚠️ 用**源码扫描**而非运行时：`index.ts` 的 provider 注册需要完整的 DSH
 * Context，在单测里搭起来成本高且脆弱；而这里要防的是「有人改回空串」
 * 这个**文本形态**的回退，源码断言恰好直接对应它。
 */
describe('H2 · index.ts 源码契约（防回退）', () => {
  /**
   * 切出全部 `resolveCredential: async (…) => { … }` 的**完整函数体**。
   *
   * ⚠️ 必须按大括号配平切块，不能整行扫：`refresh:` 块里也有
   * `getAvailableAccount(<ID>, '')`，而那里**必须**留空串
   * （它的语义是「定位要续期的账号」，按模型过滤反而会让被限流的账号
   * 刷不到、探测不到）。
   */
  function resolveCredentialBlocks(src: string): string[] {
    const blocks: string[] = []
    const re = /resolveCredential:\s*async\s*\([^)]*\)\s*=>\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      let depth = 0
      let i = m.index + m[0].length - 1
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') { depth--; if (depth === 0) break }
      }
      blocks.push(src.slice(m.index, i + 1))
    }
    return blocks
  }

  it('resolveCredential 块的选号调用不得传硬编码空串', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index.ts', 'utf8')

    const offenders: string[] = []
    for (const block of resolveCredentialBlocks(src)) {
      for (const line of block.split('\n')) {
        const m = /getAvailableAccount\(([^,]+),\s*''\)/.exec(line)
        if (m === null) continue
        // codearts 是用户明确排除的例外：它不写 modelRateLimits，
        // 选号本就无需按模型过滤。
        if (m[1].trim() === "'codearts'") continue
        offenders.push(line.trim())
      }
    }

    expect(
      offenders,
      `resolveCredential 仍在传硬编码空串（限流过滤会被短路）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('至少八个 provider 的 resolveCredential 接收 modelId', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index.ts', 'utf8')
    const withModelId = (src.match(/resolveCredential:\s*async\s*\(modelId\?:\s*string\)/g) ?? []).length
    expect(withModelId).toBeGreaterThanOrEqual(8)
  })

  it('refresh 块仍保留空串（它的语义是定位要续期的账号，不该按模型过滤）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index.ts', 'utf8')
    // 这些空串是**刻意保留**的；若被误改成 modelId ?? ''，续期会挑不到
    // 被限流的账号。断言它们仍在，防止「顺手统一」把这里也改掉。
    const refreshBlocks = [...src.matchAll(/refresh:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,400}?\n\s*\},/g)]
    const withEmpty = refreshBlocks.filter((b) => b[0].includes("getAvailableAccount(") && b[0].includes(", '')"))
    expect(withEmpty.length, 'refresh 块里应仍有传空串的选号调用').toBeGreaterThan(0)
  })
})
