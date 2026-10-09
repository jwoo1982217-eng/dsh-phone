/**
 * Buddy (腾讯 CodeBuddy) 缓存命中率探针（e2e）
 *
 * 目的：用**真实凭据**访问真实后端，把 SSE 流中后端返回的 `usage` 对象
 * **原样打印**出来，回答一个具体问题：
 *
 *   web 端 CodeBuddy 模型的缓存命中为什么恒为 0？
 *
 * 被测模型默认 deepseek-v4-flash，可用 DSH_BUDDY_E2E_MODEL 覆盖（如 hy4-preview）。
 *
 * 与 buddy-models.e2e.spec.ts 的区别：那个文件走适配器，适配器只挑选
 * prompt_tokens / completion_tokens 两个字段，缓存相关字段在适配器里就被
 * 丢掉了，看不到后端到底发了什么。本探针**绕过适配器的 usage 映射**，直接
 * 用 fetch 打 /v2/chat/completions 并 dump 完整 JSON 行。
 *
 * 闸门：DSH_BUDDY_E2E=1（与既有 buddy e2e 同款），凭据来源同 buddy-models
 * （DSH_BUDDY_CREDENTIAL_JSON 或本地 ~/.dsh/.credentials.yaml 的
 * BUDDY_ACCESS_TOKEN）。
 *
 * 探针做的对比实验：
 *   请求 A：同一段长前缀，**不带** prompt_cache_key
 *   请求 B：同一段长前缀，**带** prompt_cache_key
 *   请求 C：重复请求 B 的完全相同前缀（真正测量缓存复用）
 *
 * ── 如何正确解读 A 组（重要，勿误读）──
 *
 * A 组**不是**稳定的对照组。实测两轮运行结论相反：
 *   第 1 轮（该前缀首次出现）→ A 命中 0（credit 0.34）
 *   第 2 轮（该前缀已被缓存）→ A 命中 7808（credit 0.02）
 *
 * 原因：后端的前缀缓存**并非严格依赖 prompt_cache_key**，真正决定命中的是
 * "这段前缀内容此前是否已被缓存过"。longPrefix() 是固定文本，一旦跑过一次就
 * 处于**预热状态**，此后 A 也会命中。prompt_cache_key 的作用是跨会话复用与
 * 缓存分区/隔离，而非命中的唯一开关。
 *
 * 若需**稳定复现冷启动（命中 0）**，必须使用内容全新的前缀（见
 * `coldPrefix()`）：用随机 nonce 保证该前缀从未被请求过，实测稳定返回
 * cached_tokens=0。A 组保留在原位仅用于观察缓存分区行为，不要用它断言"不带
 * key 必为 0"。
 *
 * ── 本探针要回答的问题 ──
 *
 * "web 端 CH 恒为 0"的根因**不是**后端不返回缓存，而是修复前的适配器只挑选
 * prompt_tokens/completion_tokens，把缓存字段全部丢弃了——即使后端返回
 * cached_tokens=7808，适配器输出的 usage 里也没有它。这与后端是否命中无关，
 * 因此 A 组预热与否都不影响该结论。第二个用例走真实适配器断言修复生效。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { API_DOMAIN, BUDDY_DEPLOYMENT_TYPE, BUDDY_PRODUCT_CODE, BUDDY_USER_AGENT, HTTP_HEADER_DOMAIN, HTTP_HEADER_PRODUCT, HTTP_HEADER_PRODUCT_CODE } from '../../src/buddy.js'
import type { BuddyCredential } from '../../src/buddy.js'
import { BuddyAdapter, CHAT_API_BASE } from '../../src/buddy-adapter.js'

/**
 * 双重闸门：本探针会发 3 组真实 chat 请求，消耗账号额度。
 * 除 DSH_BUDDY_E2E=1 外还要求 DSH_BUDDY_E2E_CONFIRM=yes 显式确认，
 * 避免该变量被顺手导出后误跑产生真实费用。
 */
const E2E = process.env.DSH_BUDDY_E2E === '1'
  && process.env.DSH_BUDDY_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip
/** 被测模型，可用 DSH_BUDDY_E2E_MODEL 覆盖（如 hy4-preview）。 */
const MODEL = process.env.DSH_BUDDY_E2E_MODEL ?? 'deepseek-v4-flash'

/**
 * 从本地 ~/.dsh/.credentials.yaml 读取 BUDDY_ACCESS_TOKEN。
 *
 * 该文件的 refs 段形如：
 *   BUDDY_ACCESS_TOKEN: '{"access_token":"…",…,"scope":"openid
 *     profile offline_access
 *     email",…}'
 *
 * 注意：值是**单引号包裹的 JSON 字符串**，且因为 JSON 里的 `scope` 字段
 * 本身含换行（"openid\nprofile offline_access\nemail"），这个 YAML 标量
 * 是**跨多行**的——不能按单行正则匹配。这里定位起始引号后，向后寻找
 * 结束引号 `'` 且其后紧跟换行的位置（YAML 单引号标量内 `''` 表示一个 `'`）。
 * 只做针对性解析，不引入 YAML 依赖。
 */
function credentialFromStore(): BuddyCredential | undefined {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, 'utf8')
  const header = /BUDDY_ACCESS_TOKEN:\s*'/.exec(raw)
  if (header === null) return undefined
  const start = header.index + header[0].length
  // 标量结束：一个未被成对转义的 '，且其后（允许空白）是行尾。
  let end = -1
  for (let i = start; i < raw.length; i++) {
    if (raw[i] !== "'") continue
    if (raw[i + 1] === "'") { i++; continue } // '' → 转义的单个引号
    let j = i + 1
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\r')) j++
    if (j >= raw.length || raw[j] === '\n') { end = i; break }
  }
  if (end === -1) return undefined
  // DSH 写盘时把 JSON 里的换行**原样**写进了 YAML 标量（未转义成 \n），
  // 于是 `"scope":"openid\n    profile offline_access"` 在文件里是真实
  // 换行符——JSON.parse 会以 "Bad control character" 拒绝。解析前把裸控制
  // 字符转义回 JSON 合法形式。
  const json = raw
    .slice(start, end)
    .replace(/''/g, "'")
    .replace(/[\u0000-\u001f]/g, char => JSON.stringify(char).slice(1, -1))
  try {
    return JSON.parse(json) as BuddyCredential
  } catch {
    return undefined
  }
}

/** 解析真实凭据：优先环境变量，其次本地凭据存储。 */
function loadCredential(): BuddyCredential {
  const json = process.env.DSH_BUDDY_CREDENTIAL_JSON
  if (json !== undefined && json.length > 0) return JSON.parse(json) as BuddyCredential
  const stored = credentialFromStore()
  if (stored !== undefined && stored.access_token.length > 0) return stored
  throw new Error(
    'e2e 探针需要真实 CodeBuddy 凭据：设置 DSH_BUDDY_CREDENTIAL_JSON，'
      + '或先在 Jet Hub 的 CodeBuddy 面板登录，使 ~/.dsh/.credentials.yaml 中存在 BUDDY_ACCESS_TOKEN。',
  )
}

/** 一次真实请求的观测结果。 */
interface ProbeResult {
  status: number
  /** SSE 中出现的所有 usage 对象（原样 JSON）。 */
  usages: Array<Record<string, unknown>>
  /** usage 之外的顶层字段名，用于发现非标准字段（如 prompt_cache_hit_tokens）。 */
  bodyKeys: string[]
  errorText?: string
}

/**
 * 直接请求 /v2/chat/completions 并原样收集 usage。
 *
 * @param extraBody - 追加到请求体的字段（如 prompt_cache_key）。
 */
async function probe(
  credential: BuddyCredential,
  messages: Array<{ role: string; content: string }>,
  extraBody: Record<string, unknown> = {},
): Promise<ProbeResult> {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'text/event-stream')
  headers.set('Content-Type', 'application/json')
  // ⚠️ `||` 而非 `??`：凭据的 domain 经 `readStringField` 读取，字段缺失时是
  // **空串**（不是 undefined），`??` 会让 X-Domain 以空值发出（PR!19 修的形态）。
  headers.set(HTTP_HEADER_DOMAIN, credential.domain || API_DOMAIN)
  headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE)
  headers.set(HTTP_HEADER_PRODUCT_CODE, BUDDY_PRODUCT_CODE)
  headers.set('User-Agent', BUDDY_USER_AGENT)

  const body = JSON.stringify({ model: MODEL, messages, stream: true, ...extraBody })
  const response = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) {
    return { status: response.status, usages: [], bodyKeys: [], errorText: await response.text().catch(() => '') }
  }

  const usages: Array<Record<string, unknown>> = []
  const bodyKeys = new Set<string>()
  const text = await response.text()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') continue
    let data: Record<string, unknown>
    try {
      data = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }
    for (const key of Object.keys(data)) bodyKeys.add(key)
    if (data.usage !== undefined && data.usage !== null) usages.push(data.usage as Record<string, unknown>)
  }
  return { status: response.status, usages, bodyKeys: [...bodyKeys] }
}

/**
 * 构造一段足够长的**稳定**前缀（缓存通常有最小 token 门槛，太短不会命中）。
 *
 * ⚠️ 同一 tag 第二次运行起该前缀已处于**预热状态**，此后即使不带
 * prompt_cache_key 也会命中——不要用它断言冷启动行为。需要冷启动请用
 * {@link coldPrefix}。
 */
function longPrefix(tag: string): string {
  const filler = Array.from({ length: 400 }, (_, index) =>
    `Line ${index + 1}: the quick brown fox jumps over the lazy dog; padding for prefix cache measurement.`)
    .join('\n')
  return `[${tag}] You are a helpful assistant. Here is a long reference document:\n${filler}\n`
}

/**
 * 构造一段**保证从未被请求过**的长前缀，用于稳定复现冷启动（缓存命中 0）。
 *
 * 每行嵌入随机 nonce，使整段前缀在服务端不可能存在缓存条目。实测稳定返回
 * `cached_tokens=0`（如 prompt=79209 / miss=79209），是验证"后端命中判定
 * 真实有效"的可靠对照。注意前缀本身长（约 8k+ token），会消耗少量额度。
 */
function coldPrefix(): string {
  const nonce = `NONCE-${Math.random().toString(36).slice(2).repeat(20)}`
  const filler = Array.from({ length: 400 }, (_, index) =>
    `Line ${index + 1}: ${nonce} unique cold prefix material for cache measurement number ${index}.`)
    .join('\n')
  return `[cold] ${nonce}\n${filler}\n`
}

/** 从一条 usage 记录里读缓存命中 token 数（兼容后端的多种字段名）。 */
function cachedOf(usage: Record<string, unknown> | undefined): number {
  if (usage === undefined) return 0
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined
  return details?.cached_tokens ?? (usage.prompt_cache_hit_tokens as number | undefined) ?? 0
}

/** 打印一行观测结果。 */
function report(label: string, result: ProbeResult): void {
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====`)
  // eslint-disable-next-line no-console
  console.log(`HTTP ${result.status}`)
  if (result.errorText !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`error body: ${result.errorText.slice(0, 600)}`)
    return
  }
  // eslint-disable-next-line no-console
  console.log(`SSE 顶层字段: ${result.bodyKeys.join(', ')}`)
  // eslint-disable-next-line no-console
  console.log(`usage 原始 JSON:\n${JSON.stringify(result.usages, null, 2)}`)
}

suite(`buddy ${MODEL} cache probe e2e`, () => {
  it(
    'dumps raw usage and tests prompt_cache_key / prefix reuse',
    async () => {
      const credential = loadCredential()
      // eslint-disable-next-line no-console
      console.log(`credential: user=${credential.nickname ?? '?'} account=${credential.account_type ?? '?'} domain=${credential.domain ?? '?'}`)

      const prefix = longPrefix('cache-probe')

      // ── A：不带 prompt_cache_key ──
      // 注意：A 的结果**取决于该前缀是否已预热**，不是稳定对照组。
      // 首轮运行命中 0，其后运行会命中（前缀已建缓存）。此处只观察缓存分区
      // 行为，并不断言"不带 key 必为 0"——理由见文件头说明。
      const a = await probe(credential, [
        { role: 'user', content: `${prefix}\nReply with exactly: OK` },
      ])
      report('A: no prompt_cache_key (result depends on prefix prewarm state)', a)

      // ── B：带 prompt_cache_key（对齐 codearts 的做法）──
      const b = await probe(
        credential,
        [{ role: 'user', content: `${prefix}\nReply with exactly: OK` }],
        { prompt_cache_key: 'dsh-cache-probe-session' },
      )
      report('B: with prompt_cache_key', b)

      // ── C：重复 B 的完全相同前缀，测量缓存复用 ──
      const c = await probe(
        credential,
        [{ role: 'user', content: `${prefix}\nReply with exactly: OK` }],
        { prompt_cache_key: 'dsh-cache-probe-session' },
      )
      report('C: repeat with same prompt_cache_key (measures reuse)', c)

      // ── D：冷启动对照（内容全新前缀 → 稳定命中 0）──
      // 这是"后端命中判定真实有效"的可靠证据：新前缀不可能有缓存条目。
      const d = await probe(
        credential,
        [{ role: 'user', content: `${coldPrefix()}\nReply with exactly: OK` }],
        { prompt_cache_key: `dsh-cold-${Date.now()}` },
      )
      report('D: cold prefix (fresh content, expect cached_tokens=0)', d)

      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(c.status).toBe(200)
      expect(d.status).toBe(200)
      expect(a.usages.length + b.usages.length + c.usages.length + d.usages.length).toBeGreaterThan(0)

      // C 复用 B 的完全相同前缀，必须命中（与 A 的预热状态无关）。
      expect(cachedOf(c.usages.at(-1))).toBeGreaterThan(0)
      // D 是全新前缀，必须为 0——证明命中判定不是恒真。
      expect(cachedOf(d.usages.at(-1))).toBe(0)
    },
    590_000,
  )

  /**
   * 走**真实适配器**验证修复生效：适配器现在应发送 prompt_cache_key 并把
   * 缓存命中从 usage 中解析出来。第二次请求复用同一前缀，必须报出
   * cacheReadTokens > 0 且 inputTokens 已扣除命中部分。
   */
  it(
    'adapter now reports cacheReadTokens for a reused prefix',
    async () => {
      const credential = loadCredential()
      const sessionId = `dsh-adapter-cache-${Date.now()}`
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => credential,
        refresh: async () => { throw new Error('e2e: refresh not supported') },
        sessionId,
      })
      const prefix = longPrefix('adapter-cache')

      /** 跑一轮适配器并收集 usage chunk。 */
      const run = async (): Promise<Array<Record<string, number>>> => {
        const seen: Array<Record<string, number>> = []
        for await (const chunk of adapter.stream({
          provider: 'buddy',
          model: MODEL,
          messages: [{ role: 'user', content: `${prefix}\nReply with exactly: OK` }],
          signal: new AbortController().signal,
        } as never)) {
          if (chunk.type === 'usage') seen.push(chunk.usage as unknown as Record<string, number>)
        }
        return seen
      }

      const first = await run()
      const second = await run()
      // eslint-disable-next-line no-console
      console.log(`\n===== adapter usage =====\nfirst:  ${JSON.stringify(first)}\nsecond: ${JSON.stringify(second)}`)

      const last = second.at(-1)
      expect(last).toBeDefined()
      // 核心断言：修复前适配器只吐 inputTokens/outputTokens，cacheReadTokens
      // 永远缺席；现在必须报出真实命中量。
      //
      // 这里用 longPrefix（固定文本）而非 coldPrefix：该前缀一旦被请求过就会
      // 写入缓存，此后每轮都复用——因此本断言不依赖运行前的预热状态。反之若用
      // coldPrefix，两轮前缀不同，反而永远测不到复用。
      expect(last!.cacheReadTokens ?? 0).toBeGreaterThan(0)

      // 计费口径断言（不依赖预热状态）：inputTokens 只计未命中部分，命中部分
      // 单列 cacheReadTokens，两者之和应等于完整 prompt token 数。
      //
      // 注意**不要**断言 first.inputTokens > second.inputTokens：若该前缀在此前
      // 运行中已预热，则 first 一轮同样命中，两者相等（实测会误报失败）。
      // 正确做法是与后端返回的 prompt_tokens 总量对齐。
      const lastUsage = last! as { inputTokens?: number; cacheReadTokens?: number }
      const firstUsage = first.at(-1) as { inputTokens?: number; cacheReadTokens?: number } | undefined
      if (firstUsage !== undefined) {
        // 完整 prompt 量 = 未命中 + 命中（两轮的 prompt 完全相同）。
        const fullPrompt = (firstUsage.inputTokens ?? 0) + (firstUsage.cacheReadTokens ?? 0)
        expect((lastUsage.inputTokens ?? 0) + (lastUsage.cacheReadTokens ?? 0)).toBe(fullPrompt)
        // 命中部分确实被扣除：未命中量必须远小于完整 prompt 量。
        expect(lastUsage.inputTokens ?? 0).toBeLessThan(fullPrompt)
      }
    },
    590_000,
  )
})
