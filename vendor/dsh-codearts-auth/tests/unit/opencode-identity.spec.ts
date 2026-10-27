import { describe, expect, it } from 'vitest'
import {
  deriveProjectId, deriveRequestId, deriveSessionId, normalizeProxy,
  opencodeHeaders, opencodeUserAgent,
} from '../../src/opencode.js'

describe('指纹派生', () => {
  it('project id 是 40 位小写 hex（与真实 CLI project id 形状一致）', () => {
    expect(deriveProjectId('opencode-prj sk-abc', 0)).toMatch(/^[0-9a-f]{40}$/)
  })
  it('同 identity + 同代次 → 稳定', () => {
    expect(deriveProjectId('x', 1)).toBe(deriveProjectId('x', 1))
  })
  it('代次变化 → project id 变化（手动轮换生效）', () => {
    expect(deriveProjectId('x', 1)).not.toBe(deriveProjectId('x', 2))
  })
  it('不同账号 → 不同 project id（防关联的派生基础）', () => {
    expect(deriveProjectId('acct-A', 0)).not.toBe(deriveProjectId('acct-B', 0))
  })
  it('⚠️ session id 形状必须是 ses_ + 12hex + 14base62（门禁正则，真实报障 2026-10-01）', () => {
    // 官方真实值（本机 opencode CLI 1.18.22 日志）：ses_f078262d9ffeFwtz1QB7VnN4kM
    // = 12 位 hex + 14 位 base62 = 26 位尾段。
    // ⚠️ 写成 26 位随机段（总长 38）会让匿名通道全线 403 FreeTierError
    //    ("free tier can only be used from within OpenCode")。
    for (let i = 0; i < 50; i++) {
      const id = deriveSessionId()
      expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(id).toHaveLength(4 + 26)
    }
  })
  it('session 时间段使用 descending 算法而非裸时间戳', () => {
    expect(deriveSessionId(1).slice(4, 16)).toBe('ffffffffeffe')
    const timestamp = 1791900000000
    const expected = (~(BigInt(timestamp) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, '0')
    expect(deriveSessionId(timestamp).slice(4, 16)).toBe(expected)
  })
  it('request id 每次不同', () => {
    expect(deriveRequestId()).not.toBe(deriveRequestId())
  })
})

describe('opencodeHeaders（V2）', () => {
  const headers = opencodeHeaders({ projectId: 'p'.repeat(40), generation: 0 }, 'ses_abc', 'req_xyz', 'opencode/1.18.22')

  it('保留槽指纹，所有关联头复用同一 session，不再发旧 request ID', () => {
    expect(headers['x-opencode-project']).toBe('p'.repeat(40))
    for (const header of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'X-Session-Id']) {
      expect(headers[header]).toBe('ses_abc')
    }
    expect(headers['x-opencode-request']).toBeUndefined()
    expect(headers['x-opencode-client']).toBe('cli')
    expect(headers['user-agent']).toBe('opencode/latest/2.0.29/cli')
  })
  it('UA 缺省与旧本机版本都回落 V2，不能降级协议', () => {
    expect(opencodeUserAgent()).toBe('opencode/latest/2.0.29/cli')
    expect(opencodeUserAgent('opencode/1.19.0')).toBe(opencodeUserAgent())
    expect(opencodeUserAgent('opencode/2.0.30')).toBe('opencode/latest/2.0.30/cli')
    expect(opencodeUserAgent('opencode/latest/2.0.30/cli')).toBe('opencode/latest/2.0.30/cli')
  })
})

describe('normalizeProxy', () => {
  it('http://127.0.0.1:7897（本地客户端端口）', () => {
    const r = normalizeProxy('127.0.0.1:7897')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.proxy.kind).toBe('http')
      expect(r.proxy.url).toBe('http://127.0.0.1:7897')
    }
  })
  it('裸 host:port 补 http://', () => {
    const r = normalizeProxy('proxy.example.com:8080')
    expect(r.ok && r.proxy.url).toBe('http://proxy.example.com:8080')
  })
  it('https 保留', () => {
    expect(normalizeProxy('https://p.example.com:443').ok).toBe(true)
  })
  it('socks5 识别为 socks5 kind', () => {
    const r = normalizeProxy('socks5://127.0.0.1:1080')
    expect(r.ok && r.proxy.kind).toBe('socks5')
  })
  it('socks5h:// 归一为 socks5://', () => {
    const r = normalizeProxy('socks5h://127.0.0.1:1080')
    expect(r.ok && r.proxy.url).toBe('socks5://127.0.0.1:1080')
  })
  it('保留用户名密码认证', () => {
    const r = normalizeProxy('http://user:pass@1.2.3.4:8080')
    expect(r.ok && r.proxy.url).toBe('http://user:pass@1.2.3.4:8080')
  })
  it('空串 = 不设代理（清空）', () => {
    const r = normalizeProxy('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('空')
  })
  it('缺端口拒绝并给中文理由', () => {
    const r = normalizeProxy('http://1.2.3.4')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('端口')
  })
  it('未知协议拒绝', () => {
    const r = normalizeProxy('vmess://abc')
    expect(r.ok).toBe(false)
  })
  it('⚠️ 显式默认端口不被 WHATWG URL 归一化掉（真实 bug 的回归锁）', () => {
    // `new URL('https://h:443').port === ''` —— 只看 parsed.port 会把
    // 用户明确填的 443 误判成「缺端口」而拒绝一个合法地址。
    const r = normalizeProxy('https://p.example.com:443')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.proxy.url).toBe('https://p.example.com:443')
  })
  it('缺主机名拒绝', () => {
    expect(normalizeProxy('http://:8080').ok).toBe(false)
  })
})
