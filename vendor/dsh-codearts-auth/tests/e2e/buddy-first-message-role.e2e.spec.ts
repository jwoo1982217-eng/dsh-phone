/**
 * 实测凭据：**wire 的首条角色**决定腾讯系是否放行（2026-10-12）。
 *
 * ## 为什么这个文件必须**入库**
 * `buddy-adapter.ts` 的 `stream()` 里那条「首条必须是 system，否则补一条最小
 * system」的判据，其**两个**来源都是实测：
 * ① `account-probe.ts` 的 `PROBE_SYSTEM` 注释里有 2026-09-25 的双端点对照
 *    （WorkBuddy 无 system → 400/11128）；
 * ② 本文件测的 space-bunny 11148（首条是带 tool_calls 的 assistant 时报
 *    `tool calls and tool results do not match`）。
 * 判据写死在实现里，单测只能锁「代码按判据做」，**锁不住判据本身对不对** ——
 * 而 2026-10-12 的审计恰恰在判据本身上抓到一个真缺陷：初版写的是
 * `=== 'assistant'`，漏掉 user-first / tool-first 的历史。
 *
 * ⚠️ 别把它挪回被 gitignore 的 `scripts/`。
 *
 * ## 闸门（消耗极小额度：每例 `max_tokens=16`，被拒不耗额度）
 *   DSH_BUDDY_FIRSTMSG_E2E=1 + DSH_BUDDY_FIRSTMSG_E2E_CONFIRM=yes
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENABLED = process.env.DSH_BUDDY_FIRSTMSG_E2E === '1'
const CONFIRMED = process.env.DSH_BUDDY_FIRSTMSG_E2E_CONFIRM === 'yes'

function firstCredential(): Record<string, unknown> {
  const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s+(BUDDY_ACCOUNT_[0-9A-F]+|BUDDY_ACCESS_TOKEN):\s*'(.*)'\s*$/.exec(line)
    if (m === null) continue
    try {
      const cred = JSON.parse(m[2]) as Record<string, unknown>
      if (typeof cred.access_token === 'string' && cred.access_token.length > 0) return cred
    } catch { /* 跳过非 JSON */ }
  }
  throw new Error('磁盘上没有 CodeBuddy 凭据（请先在 Jet Hub 登录）')
}

const ENDPOINT = 'https://copilot.tencent.com'

async function probe(model: string, messages: unknown[]): Promise<{ blocked: boolean; code?: string }> {
  const cred = firstCredential()
  const res = await fetch(`${ENDPOINT}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(cred.access_token)}`,
      Accept: 'text/event-stream', 'Content-Type': 'application/json',
      'X-Domain': 'copilot.tencent.com', 'X-Product-Code': 'codebuddy',
      'X-IDE-Name': 'CodeBuddy', 'X-IDE-Type': 'CodeBuddy', 'X-IDE-Version': '1.106.1',
      'X-Product': 'CodeBuddy', 'User-Agent': 'CodeBuddyIDE/1.106.1',
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 16 }),
  })
  if (!res.ok) {
    const body = await res.text()
    return { blocked: true, code: /"code":(\d+)/.exec(body)?.[1] }
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done === true) break
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p.includes('"code"') && !p.includes('chat.completion.chunk')) return { blocked: true }
    }
  }
  return { blocked: false }
}

const SYS = { role: 'system', content: 'You are helpful. Reply OK.' }
const U = (t: string) => ({ role: 'user', content: t })
const AT = (content: string | null) => ({
  role: 'assistant', content, reasoning_content: '',
  tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"q":"x"}' } }],
})
const TR = { role: 'tool', tool_call_id: 't1', content: 'result body' }

describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系：wire 首条角色（2026-10-12 实测依据）', () => {
  it('基线：首条是 system 时必须 200（否则本文件全部结论作废）', async () => {
    const r = await probe('space-bunny', [SYS, U('read it'), AT(null), TR, U('ok')])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ space-bunny：首条是带 tool_calls 的 assistant → 11148', async () => {
    const r = await probe('space-bunny', [AT(null), TR, U('ok')])
    expect(r.blocked).toBe(true)
    expect(r.code).toBe('11148')
  }, 60_000)

  it('★ step-5-preview 容忍同一形状（所以「换个模型就好」是假解法）', async () => {
    // 这条是 2026-10-12 审计的关键反直觉点：同一份请求体，step-5 放行、
    // space-bunny 报 11148。⇒ 不能因为 step-5 能用就认为请求没问题。
    const r = await probe('step-5-preview', [AT(null), TR, U('ok')])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ 首条是 user 但前面有 system → 放行（判据是「首条角色」，不是「有没有 tool_call」）', async () => {
    const r = await probe('space-bunny', [SYS, U('read it'), AT(null), TR, U('ok')])
    expect(r.blocked).toBe(false)
  }, 60_000)
})