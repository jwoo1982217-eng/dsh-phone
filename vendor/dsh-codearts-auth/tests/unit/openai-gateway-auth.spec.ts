import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateApiKey } from '../../src/openai-gateway/auth.js'

/**
 * 凭据的**损坏处理**。
 *
 * 背景：密钥文件是唯一持久来源。此前「读不到就重新生成」看似自愈，实则有一个
 * 隐蔽后果 —— 文件被改坏/误删时服务端会**换一个全新的 key**，所有已配置的
 * 客户端同时 401，而它们只回一句 `unauthorized`，用户无从判断是自己粘错了
 * 哪一位、还是服务端变了。
 *
 * 判据：文件里**只有我们生成的形态**才被采用。
 * - 空 / 纯空白 ⇒ 从未生成过，正常生成；
 * - 43 位 base64url ⇒ 我们自己写的，采信；
 * - 其它任何内容 ⇒ 明确报错，并给出恢复办法（删文件或改用环境变量）。
 */

const KEY_FILE = 'openai-gateway/api-key'
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

let home: string

function writeKeyFile(content: string): void {
  mkdirSync(join(home, 'openai-gateway'), { recursive: true })
  writeFileSync(join(home, KEY_FILE), content, 'utf-8')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('loadOrCreateApiKey', () => {
  it('未配置时生成一次并持久化，重启后不变', () => {
    const first = loadOrCreateApiKey(home, {})
    expect(first.value).toHaveLength(43)
    expect(first.value).toMatch(KEY_PATTERN)
    expect(first.fromEnv).toBe(false)
    expect(first.path).toBe(join(home, KEY_FILE))
    // 重新载入必须是同一个值 —— 否则「重启后保持不变」的验收就不成立。
    expect(loadOrCreateApiKey(home, {}).value).toBe(first.value)
  })

  it('环境变量优先于文件，且标记来源', () => {
    writeKeyFile('x'.repeat(43))
    const source = loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-key' })
    expect(source.value).toBe('env-key')
    expect(source.fromEnv).toBe(true)
    // 来自环境变量时没有文件路径可言，UI 不该显示一个假的路径。
    expect(source.path).toBeNull()
  })

  it('⚠️ 密钥文件内容被改坏时明确报错，不静默换一个', () => {
    writeKeyFile('这是被手工改坏的密钥')
    // 若这里改成「重新生成」，所有已配置的客户端会同时 401 且无从排查。
    expect(() => loadOrCreateApiKey(home, {})).toThrow(/api-key/i)
  })

  it('损坏报错时给出可执行的恢复办法（删文件或改用环境变量）', () => {
    writeKeyFile('short')
    let message = ''
    try {
      loadOrCreateApiKey(home, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('DSH_OPENAI_GATEWAY_API_KEY')
    expect(message).toMatch(/删除|移除/)
  })

  it('空文件按「尚未生成」处理，可正常生成（不是损坏）', () => {
    writeKeyFile('   \n')
    const source = loadOrCreateApiKey(home, {})
    expect(source.value).toMatch(KEY_PATTERN)
  })

  it('文件里合法的既有 key 被采信，不会被换掉', () => {
    const existing = 'a'.repeat(42) + 'Z'
    writeKeyFile(existing)
    expect(loadOrCreateApiKey(home, {}).value).toBe(existing)
  })

  it('环境变量已设置时，文件损坏也不报错（压根没读文件）', () => {
    writeKeyFile('坏内容')
    expect(loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-key' }).value).toBe('env-key')
  })
})
