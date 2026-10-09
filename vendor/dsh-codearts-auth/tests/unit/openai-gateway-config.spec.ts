import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGatewayConfig } from '../../src/openai-gateway/config.js'
import { loadOrCreateApiKey } from '../../src/openai-gateway/auth.js'

describe('OpenAI gateway config', () => {
  it('uses localhost and port 8326 by default', () => {
    expect(resolveGatewayConfig({})).toEqual({ host: '127.0.0.1', port: 8326 })
  })

  it('accepts a valid port override', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).port).toBe(9382)
  })

  it('rejects an invalid port override', () => {
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '0' })).toThrow(/port/i)
  })

  it('prefers the environment API key', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    // 返回结构而非裸字符串：设置页要据此显示「来自环境变量」并隐藏文件路径。
    const source = loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-secret' })
    expect(source.value).toBe('env-secret')
    expect(source.fromEnv).toBe(true)
    expect(source.path).toBeNull()
  })

  it('generates and persists a key when the environment is empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    const first = loadOrCreateApiKey(home, {}).value
    const second = loadOrCreateApiKey(home, {}).value
    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect(readFileSync(join(home, 'openai-gateway', 'api-key'), 'utf8')).toBe(first)
  })
})
