/**
 * 限流账号真实性探针：settings 里记着「限额重置」的账号，现在到底还受不受限？
 *
 * ⚠️ 本用例会向 CodeBuddy 后端发起**真实模型请求，消耗账号积分**。
 *
 * 背景：Jet Hub 账号卡片上的「限额重置」徽章只比较
 * `modelRateLimits[model] > Date.now()`——它是一个**历史事件的快照**，
 * 而不是该账号此刻的真实可用性。服务端在重置时间到达前提前放行是常见的，
 * 于是出现「卡片显示超额使用，但发消息能正常回复」。
 *
 * 本探针把两件事分开测，以便定位差异来源：
 *   A. 直连 /v2/chat/completions（绕过适配器与账号池）——服务端的真实答复；
 *   B. 走 BuddyAdapter 完整链路——插件实际会发生什么。
 *
 * 判定：
 *   - A 返回 200 且有正文 → 该账号**并未真的受限**，徽章记录已过期/失效；
 *   - A 返回 429/6004 且被 {@link isRateLimited} 判为限流 → **确实受限**，徽章记录准确。
 *
 * ⚠️ 限流判定**必须复用生产代码的 `isRateLimited`**，不要在这里另写一份正则：
 * 早期本探针内联了 `/频率限制|使用量已超出|rate.?limit/i`（只认中文），于是国际版
 * WorkBuddy 的英文 6004 会被误判为「非限流失败」，把排查引向错误方向。判定逻辑只有
 * 一份真相源，才不会两边各自漂移。
 *
 * 双重闸门（缺一不可，防止误跑消耗积分）：
 *   DSH_BUDDY_RATELIMIT_E2E=1             启用本探针
 *   DSH_BUDDY_RATELIMIT_E2E_CONFIRM=yes   显式确认愿意消耗积分
 *
 * 可选：DSH_BUDDY_MODEL 覆盖被测模型（默认 deepseek-v4.1-flash）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { isRateLimited } from '../../src/llm-adapter.js'
import type { BuddyCredential } from '../../src/buddy.js'

const E2E = process.env.DSH_BUDDY_RATELIMIT_E2E === '1'
  && process.env.DSH_BUDDY_RATELIMIT_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip

const TARGET_MODEL = process.env.DSH_BUDDY_MODEL ?? 'deepseek-v4.1-flash'

/** settings.yaml 里解析出的一个 Jet Hub 账号条目。 */
interface AccountEntry {
  id: string
  provider: string
  enabled: boolean
  nickname?: string
  credentialRef: string
  /** 模型 → 重置时间戳（毫秒）。 */
  modelRateLimits: Record<string, number>
}

/**
 * 按行扫描 jet-hub.accounts（不引 yaml 依赖）。
 *
 * YAML 结构固定：条目以 4 空格 + `- ` 起始，字段 6 空格，
 * `modelRateLimits` 的子键 8 空格。只解析本探针需要的四个字段。
 */
function readAccounts(): AccountEntry[] {
  const text = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
  const sectionStart = text.indexOf('jet-hub:')
  if (sectionStart < 0) return []
  // 截到下一个顶层键（无缩进的 key:）为止
  const after = text.slice(sectionStart + 'jet-hub:'.length)
  const nextTop = after.search(/\n[A-Za-z][\w-]*:/)
  const block = nextTop < 0 ? after : after.slice(0, nextTop)

  const entries: AccountEntry[] = []
  let current: AccountEntry | undefined
  let inLimits = false

  for (const rawLine of block.split(/\r?\n/)) {
    const item = /^ {4}-\s+id:\s*(\S+)/.exec(rawLine)
    if (item !== null) {
      current = { id: item[1], provider: '', enabled: false, credentialRef: '', modelRateLimits: {} }
      entries.push(current)
      inLimits = false
      continue
    }
    if (current === undefined) continue
    if (/^ {6}modelRateLimits:\s*$/.test(rawLine)) { inLimits = true; continue }
    const limit = /^ {8}(\S+):\s*(\d+)\s*$/.exec(rawLine)
    if (inLimits && limit !== null) {
      current.modelRateLimits[limit[1]] = Number(limit[2])
      continue
    }
    if (!/^ {6}\S/.test(rawLine)) continue
    inLimits = false
    const field = /^ {6}(\w+):\s*(.*)$/.exec(rawLine)
    if (field === null) continue
    const [, key, value] = field
    if (key === 'provider') current.provider = value.trim()
    else if (key === 'enabled') current.enabled = value.trim() === 'true'
    else if (key === 'nickname') current.nickname = value.trim()
    else if (key === 'credentialRef') current.credentialRef = value.trim()
  }
  return entries
}

/** 从 .credentials.yaml 里取某个 ref 的凭据 JSON（花括号配对扫描）。 */
function credentialFor(ref: string): BuddyCredential {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const idx = text.indexOf(`${ref}:`)
  expect(idx, `凭据 ${ref} 未找到`).toBeGreaterThan(-1)
  const rest = text.slice(idx)
  const first = rest.indexOf('{')
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = first; i < rest.length; i++) {
    const ch = rest[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const raw = rest.slice(first, end + 1).replace(/''/g, "'")
  return JSON.parse(raw) as BuddyCredential
}

/** 一次直连请求的结果摘要。 */
interface DirectResult {
  status: number
  body: string
  /** 是否成功收到正文。 */
  ok: boolean
  text: string
  /** 服务端给出的重置时间文本（限流时）。 */
  resetText?: string
}

/** 直连 /v2/chat/completions 发一次最小流式请求，绕过适配器与账号池。 */
async function directProbe(credential: BuddyCredential, model: string): Promise<DirectResult> {
  const response = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.access_token}`,
      // ⚠️ `||` 而非 `??`（空串不是 undefined —— 见 PR!19 的同型缺陷）。
      'X-Domain': credential.domain || 'www.codebuddy.cn',
      'X-Product': 'SaaS',
      'X-Product-Code': 'codebuddy',
      'User-Agent': 'CodeBuddyIDE/1.106.1',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 32,
      prompt_cache_key: `ratelimit-probe-${Date.now()}`,
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const reset = /将在\s+([\d-]+\s+[\d:]+)\s+UTC[+-]\d+/.exec(body)
    return {
      status: response.status,
      body,
      ok: false,
      text: '',
      ...reset !== null ? { resetText: reset[1] } : {},
    }
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> })
          .choices?.[0]?.delta
        if (typeof delta?.content === 'string') text += delta.content
      } catch { /* 忽略无法解析的分片 */ }
    }
  }
  return { status: response.status, body: '', ok: true, text }
}

suite('限流账号真实性探针', () => {
  it(`对记录受限的账号实发 ${TARGET_MODEL} 请求，判定是否真限流`, async () => {
    const accounts = readAccounts()
    const buddy = accounts.filter((a) => a.provider === 'buddy')
    console.log('\n===== Jet Hub buddy 账号 =====')
    for (const a of buddy) {
      const reset = a.modelRateLimits[TARGET_MODEL]
      const state = reset === undefined
        ? '(无该模型记录)'
        : reset > Date.now()
          ? `记录受限，重置于 ${new Date(reset).toLocaleString()}（${((reset - Date.now()) / 3_600_000).toFixed(2)} 小时后）`
          : `记录已过期（${new Date(reset).toLocaleString()}）`
      console.log(`  ${a.id.padEnd(20)} enabled=${String(a.enabled).padEnd(5)} ${a.nickname ?? '-'} ${state}`)
    }

    // 优先选「已启用 + 该模型有未到期记录」的账号（即卡片显示超额的那个）
    const limited = buddy.find((a) => a.enabled && (a.modelRateLimits[TARGET_MODEL] ?? 0) > Date.now())
      ?? buddy.find((a) => (a.modelRateLimits[TARGET_MODEL] ?? 0) > Date.now())
    expect(limited, `没有找到 ${TARGET_MODEL} 有未到期限流记录的 buddy 账号`).toBeDefined()

    console.log('\n===== 被测账号 =====')
    console.log(`  id            = ${limited!.id}`)
    console.log(`  nickname      = ${limited!.nickname ?? '-'}`)
    console.log(`  enabled       = ${limited!.enabled}`)
    console.log(`  credentialRef = ${limited!.credentialRef}`)
    const recorded = limited!.modelRateLimits[TARGET_MODEL]
    console.log(`  记录重置时间   = ${new Date(recorded).toLocaleString()}`)
    console.log(`  当前时间       = ${new Date().toLocaleString()}`)

    const credential = credentialFor(limited!.credentialRef)

    // ── A. 直连探针（服务端真实答复）──
    console.log('\n===== A. 直连 /v2/chat/completions（绕过适配器）=====')
    const direct = await directProbe(credential, TARGET_MODEL)
    console.log(`  HTTP status = ${direct.status}`)
    if (direct.ok) {
      console.log(`  正文        = ${JSON.stringify(direct.text.slice(0, 120))}`)
    } else {
      console.log(`  响应体      = ${direct.body.slice(0, 300)}`)
      if (direct.resetText !== undefined) console.log(`  服务端重置   = ${direct.resetText}`)
    }

    // ── B. 适配器链路 ──
    console.log('\n===== B. BuddyAdapter 完整链路 =====')
    const adapter = new BuddyAdapter({
      credentialRef: limited!.credentialRef as never,
      resolveCredential: async () => credential,
      refresh: async () => { console.log('  [refresh] 被调用') },
      sessionId: 'ratelimit-probe',
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init)
        console.log(`  [request] ${TARGET_MODEL} → HTTP ${response.status}`)
        return response
      },
    })
    let adapterText = ''
    let adapterError = ''
    try {
      for await (const chunk of adapter.stream({
        model: TARGET_MODEL,
        messages: [{ role: 'user', content: '只回答两个字：收到' }],
      })) {
        if (chunk.type === 'text-delta') adapterText += chunk.text
      }
      console.log(`  正文        = ${JSON.stringify(adapterText.slice(0, 120))}`)
    } catch (error) {
      adapterError = error instanceof Error ? error.message : String(error)
      console.log(`  抛出异常    = ${adapterError}`)
    }

    // ── 结论 ──
    // 复用生产判定（中英文 + 业务码三重判据），避免与适配器行为分叉。
    const reallyLimited = direct.status === 429
      || (direct.status >= 400 && isRateLimited(direct.body))
    console.log('\n===== 结论 =====')
    if (reallyLimited) {
      console.log(`  真限流：服务端对 ${TARGET_MODEL} 返回 ${direct.status}。`)
      console.log('  → 徽章记录准确；本地记录的模型/时间与服务端一致。')
    } else if (direct.ok) {
      console.log(`  未真限流：服务端对 ${TARGET_MODEL} 返回 200 并正常生成。`)
      console.log('  → 徽章上的「限额重置」只是历史快照，该账号当前可用。')
      console.log('  → 这正是「显示超额使用但发消息能正常回复」的原因。')
    } else {
      console.log(`  非限流失败：HTTP ${direct.status}（需人工判断，非频率限制）。`)
    }
    console.log(`  适配器链路：${adapterError.length > 0 ? `失败（${adapterError}）` : '成功'}`)

    // 断言：本探针只做判定，不强制结论——但至少要拿到一个明确答复。
    // 真限流与未限流都是有效结论；只有「两者都没解释清楚」才算失败。
    expect(direct.status).toBeGreaterThan(0)
    if (!reallyLimited && !direct.ok) {
      throw new Error(`直连既非限流也非成功：HTTP ${direct.status} ${direct.body.slice(0, 200)}`)
    }
  }, 180_000)
})
