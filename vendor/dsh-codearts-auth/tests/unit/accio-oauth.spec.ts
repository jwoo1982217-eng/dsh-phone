import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAccioAuthUrl,
  createAccioPkcePair,
  exchangeAccioCode,
  refreshAccioCredential,
} from '../../src/accio-oauth.js'
import type { AccioCredential } from '../../src/accio.js'
// ⚠️ 源码切片**必须**走它（行尾无关 + AST 括号匹配），理由见防回退锁用例的注释。
import { sourceScope } from '../helpers/source-scope.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

describe('createAccioPkcePair', () => {
  it('⚠️ challenge = base64url(SHA-256(verifier))，且方法恒 S256', () => {
    const { verifier, challenge } = createAccioPkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('verifier 是 base64url（48 随机字节 ⇒ 64 字符）', () => {
    const { verifier } = createAccioPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(verifier).toHaveLength(64)
  })

  it('两次调用不相同', () => {
    expect(createAccioPkcePair().verifier).not.toBe(createAccioPkcePair().verifier)
  })
})

describe('buildAccioAuthUrl', () => {
  const url = buildAccioAuthUrl({
    region: 'cn',
    redirectUri: 'http://127.0.0.1:12345/auth/callback',
    state: 'ab'.repeat(32),
    codeChallenge: 'CHALLENGE',
  })

  it('中国版域名', () => {
    expect(url.startsWith('https://www.accio-ai.com/login?')).toBe(true)
  })

  it('国际版域名', () => {
    const g = buildAccioAuthUrl({
      region: 'global',
      redirectUri: 'http://127.0.0.1:1/auth/callback',
      state: 'x',
      codeChallenge: 'y',
    })
    expect(g.startsWith('https://zh.accio.com/login?')).toBe(true)
  })

  it('⚠️ 参数逐项完整（缺 code_challenge 会命中登录页的 legacy 门禁弹「请升级客户端」）', () => {
    const q = new URL(url).searchParams
    expect(q.get('return_url')).toBe('http://127.0.0.1:12345/auth/callback')
    expect(q.get('state')).toBe('ab'.repeat(32))
    expect(q.get('code_challenge')).toBe('CHALLENGE')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('client_id')).toBe('accio-work')
  })

  it('⚠️ 带 ttid 与 language（IDE 同款参数集）', () => {
    const q = new URL(url).searchParams
    expect(q.get('ttid')).toMatch(/^ttid_/)
    expect(q.get('language')).toBe('zh')
  })
})

describe('exchangeAccioCode', () => {
  it('⚠️⚠️ 上游 expiresAt 是秒 ⇒ 必须 ×1000（否则账号被判永远过期）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      code: '200',
      data: {
        accessToken: 'a'.repeat(32),
        refreshToken: 'r'.repeat(128),
        expiresAt: 1_794_407_698,          // 秒
        sgcookie: 'SG',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const r = await exchangeAccioCode({
      region: 'cn', code: 'C', codeVerifier: 'V', redirectUri: 'http://127.0.0.1:1/auth/callback',
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(r.expires_at).toBe(1_794_407_698_000)
    expect(new Date(r.expires_at).getFullYear()).toBeGreaterThan(2025)
    expect(r.access_token).toBe('a'.repeat(32))
    expect(r.refresh_token).toBe('r'.repeat(128))
    expect(r.sgcookie).toBe('SG')
  })

  it('POST /api/oauth/token，body 含 code/codeVerifier/clientId/redirectUri', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true, data: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_794_407_698 },
    }), { status: 200 }))
    await exchangeAccioCode({
      region: 'global', code: 'CODE', codeVerifier: 'VER', redirectUri: 'http://127.0.0.1:9/auth/callback',
      fetcher: fetcher as unknown as typeof fetch,
    })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://phoenix-gw.alibaba.com/api/oauth/token')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'CODE', codeVerifier: 'VER', clientId: 'accio-work', redirectUri: 'http://127.0.0.1:9/auth/callback',
    })
  })

  it('信封失败时报错并带上服务端原文', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: '400', message: 'PKCE verification failed',
    }), { status: 200 }))
    await expect(exchangeAccioCode({
      region: 'cn', code: 'C', codeVerifier: 'V', redirectUri: 'u',
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow(/PKCE verification failed/)
  })

  it('响应字段不全时报错（accessToken/refreshToken/expiresAt 三者都要）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true, data: { accessToken: 'a', expiresAt: 1_794_407_698 },   // 缺 refreshToken
    }), { status: 200 }))
    await expect(exchangeAccioCode({
      region: 'cn', code: 'C', codeVerifier: 'V', redirectUri: 'u',
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow(/refreshToken/)
  })
})

describe('refreshAccioCredential', () => {
  const cred: AccioCredential = {
    access_token: 'old', refresh_token: 'rt', expires_at: Date.now(), region: 'cn',
  }

  it('POST /api/auth/refresh_token，body 是 accessToken + refreshToken', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true, data: { accessToken: 'new', refreshToken: 'newRt', expiresAt: 1_794_500_000 },
    }), { status: 200 }))
    const r = await refreshAccioCredential({ credential: cred, fetcher: fetcher as unknown as typeof fetch })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://phoenix-gw.alibaba.com/api/auth/refresh_token')
    expect(JSON.parse(String(init.body))).toEqual({ accessToken: 'old', refreshToken: 'rt' })
    expect(r.access_token).toBe('new')
    expect(r.expires_at).toBe(1_794_500_000_000)
  })
})

describe('★ 防回退锁：打开浏览器绝不能用 cmd /c start', () => {
  const src = readFileSync(join(SRC_DIR, 'accio-oauth.ts'), 'utf8')

  /**
   * ⚠️ 必须先切片再断言。
   *
   * 直接对**整份源码**做 `toContain('rundll32')` 是**恒真**的：文件头注释与
   * `openBrowser` 的 JSDoc 里都写着这个词。实测把整个 `openBrowser` 函数体删掉，
   * 那三条断言**照样全绿** —— 正是本仓库记录过的「删掉目标代码照样全绿」形态。
   * ⇒ 断言必须锚定在**实现片段**上。
   *
   * ⚠️⚠️ 切片走 `sourceScope().fn()`（行尾无关 + AST 括号匹配），**不要**自写
   * `indexOf('\n}')`：本仓库 `core.autocrlf=true`，源码在工作区是 **CRLF**，
   * 而 `'\n}'` 在 CRLF 文本里**恒匹配不到**（实际是 `\r\n}`）⇒ `-1` ⇒
   * 要么切到文件尾部（断言恒假绿），要么被 `>= 0` 守卫抓成假红。
   * 见 `tests/unit/source-scope.spec.ts`（issue IKJMG1）。
   */
  function openBrowserBody(): string {
    return sourceScope(src).fn('openBrowser')
  }

  it('必须用 rundll32 url.dll,FileProtocolHandler 打开（锚定实现片段）', () => {
    const body = openBrowserBody()
    expect(body).toContain('rundll32.exe')
    expect(body).toContain('url.dll,FileProtocolHandler')
  })

  it('⚠️ 不得出现 cmd + start 的组合（& 会被 cmd 当命令分隔符截断 URL）', () => {
    // 三个现象全由这一个 bug 解释：误弹「请升级客户端」+ 弹出文件管理器 + 回调永不到达
    const body = openBrowserBody()
    expect(body).not.toMatch(/['"]cmd['"]/)
    expect(body).not.toMatch(/['"]\/c['"]/)
  })

  it('源码扫描型断言必须先确认取到了内容（否则 indexOf 为 -1 会让断言恒真）', () => {
    expect(src.length).toBeGreaterThan(500)
    expect(openBrowserBody().length).toBeGreaterThan(100)
  })
})
