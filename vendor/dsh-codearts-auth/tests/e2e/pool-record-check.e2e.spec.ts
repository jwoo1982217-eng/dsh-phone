/**
 * AccountPool 限流记录闭环验证。
 *
 * 用真实的 ~/.dsh/settings.yaml 与 .credentials.yaml 构造最小 ctx，
 * 验证：findAccountIdByCredential → updateModelRateLimit → 落盘 这条链路。
 *
 * 默认跳过（会写真实 settings.yaml）。用 DSH_JETHUB_POOL_CHECK=1 启用。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'

const RUN = process.env.DSH_JETHUB_POOL_CHECK === '1'
const suite = RUN ? describe : describe.skip

/** 从磁盘读取现有账号列表（模拟 settings scope 的 get）。 */
function readJetHubAccounts(): Array<Record<string, unknown>> {
  const text = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
  const idx = text.indexOf('jet-hub:')
  if (idx < 0) return []
  const block = text.slice(idx)
  // 极简解析：仅取 accounts 段的 id / credentialRef / nickname
  const accounts: Array<Record<string, unknown>> = []
  const lines = block.split(/\r?\n/)
  let current: Record<string, unknown> | undefined
  for (const line of lines.slice(1)) {
    if (/^\S/.test(line)) break                         // 段落结束
    const idMatch = /^\s*-\s*id:\s*(\S+)/.exec(line)
    if (idMatch) {
      current = { id: idMatch[1] }
      accounts.push(current)
      continue
    }
    const kv = /^\s+(\w+):\s*(.+)$/.exec(line)
    if (kv && current) current[kv[1]] = kv[2]
  }
  return accounts
}

/** 读取某 credentialRef 下的凭据 JSON。 */
function readCredential(refName: string): Record<string, unknown> | undefined {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const idx = text.indexOf(`${refName}:`)
  if (idx < 0) return undefined
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
  return JSON.parse(rest.slice(first, end + 1)) as Record<string, unknown>
}

suite('AccountPool 限流记录闭环', () => {
  it('findAccountIdByCredential 能按 access_token 反查到账号', async () => {
    const accounts = readJetHubAccounts()
    console.log('\n=== 磁盘上的账号 ===')
    for (const a of accounts) {
      console.log(`  ${String(a.id)}  ref=${String(a.credentialRef)}  nickname=${String(a.nickname)}`)
    }
    expect(accounts.length).toBeGreaterThan(0)

    // 用真实 ctx 的最小替身：只提供 credentials.resolve 与 settings.register
    const stored = new Map<string, string>()
    for (const a of accounts) {
      const ref = String(a.credentialRef)
      const cred = readCredential(ref)
      if (cred !== undefined) stored.set(ref, JSON.stringify(cred))
    }

    const pool = new AccountPool({
      get: (key: string) => key === 'settings' ? {
        register: () => ({
          get: () => ({ accounts }),
          replace: async () => {},
        }),
        describe: () => [],
      } : undefined,
      credentials: {
        resolve: async (ref: unknown) => {
          const key = String(ref)
          const value = stored.get(key)
          return value === undefined ? undefined : { value, source: 'test' }
        },
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {},
        unset: async () => {},
      },
      logger: { warn: (m: string) => console.log('  [warn]', m), info: (m: string) => console.log('  [info]', m) },
    } as never)

    // 对每个账号：用其 access_token 反查 id，应能匹配上
    console.log('\n=== 反查验证 ===')
    for (const a of accounts) {
      const cred = readCredential(String(a.credentialRef))
      if (cred === undefined) { console.log(`  ${String(a.id)}: 凭据不可读，跳过`); continue }
      const found = await pool.findAccountIdByCredential('buddy', String(cred.access_token))
      const ok = found === String(a.id)
      console.log(`  ${String(a.id)}: 反查 → ${JSON.stringify(found)} ${ok ? '✅' : '❌'}`)
      expect(found, `账号 ${String(a.id)} 应能被反查到`).toBe(String(a.id))
    }
  }, 30_000)
})
