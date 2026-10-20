/**
 * CodeBuddy 登录流程原始响应探针。
 *
 * 目的：把 `fetchAuthState → loopGetToken → getAccount` 每一步的**原始 JSON**
 * 打印出来，用于确认：
 *  1. `/v2/plugin/auth/token` 返回的 `expiresAt` 到底叫什么、是毫秒还是 ISO、是否为空；
 *  2. `scope` 是否真的含换行；
 *  3. `login/account` 返回的账户字段名。
 *
 * 默认跳过，仅在设置 DSH_BUDDY_PROBE=1 时执行（需要人工在浏览器点击授权）。
 */
import { describe, expect, it } from 'vitest'
import {
  API_ENDPOINT,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  LOGIN_ACCOUNT_PATH,
  BUDDY_USER_AGENT,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  API_DOMAIN,
  PLATFORM,
} from '../../src/buddy.js'

const PROBE = process.env.DSH_BUDDY_PROBE === '1'
const suite = PROBE ? describe : describe.skip

/** 打印一段带标题的原始 JSON（长字符串截断，但完整打印键名与短值）。 */
function dump(label: string, value: unknown): void {
  console.log(`\n===== ${label} =====`)
  if (value === null || typeof value !== 'object') {
    console.log(JSON.stringify(value))
    return
  }
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') {
      const text = typeof node === 'string' ? node : JSON.stringify(node)
      const shown = text.length > 120 ? `${text.slice(0, 120)}…(len=${text.length})` : text
      const hasNewline = typeof node === 'string' && /[\r\n]/.test(node)
      console.log(`${prefix}= ${shown}${hasNewline ? '   <<< 含换行!' : ''}`)
      return
    }
    if (Array.isArray(node)) {
      console.log(`${prefix}[array len=${node.length}]`)
      node.slice(0, 5).forEach((item, i) => walk(item, `${prefix}  [${i}].`))
      return
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${prefix}${k}.`)
  }
  walk(value, '')
}

/** 解析 JWT payload（不验签，仅用于查看 exp / nickname 等声明）。 */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

suite('CodeBuddy 登录流程原始响应探针', () => {
  it('逐步打印 auth/state、auth/token、login/account 的原始返回', async () => {
    // ── 1. auth/state ──
    const stateRes = await fetch(`${API_ENDPOINT}${AUTH_STATE_PATH}?platform=${PLATFORM}`, {
      method: 'POST',
      headers: {
        [HTTP_HEADER_DOMAIN]: API_DOMAIN,
        [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
        [HTTP_HEADER_NO_USER_ID]: 'true',
        [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
        [HTTP_HEADER_NO_DEPARTMENT_INFO]: 'true',
        'User-Agent': BUDDY_USER_AGENT,
      },
    })
    const stateBody = await stateRes.json() as Record<string, unknown>
    dump('auth/state 响应', stateBody)
    const stateData = stateBody.data as Record<string, unknown> | undefined
    const state = String(stateData?.state ?? '')
    const authUrl = String(stateData?.authUrl ?? '')
    expect(state).not.toBe('')

    console.log('\n========================================')
    console.log('请在浏览器中打开下面的链接完成授权：')
    console.log(authUrl)
    console.log('========================================\n')

    // ── 2. 轮询 auth/token，打印**每一次**原始响应 ──
    const tokenUrl = `${API_ENDPOINT}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
    const deadline = Date.now() + 5 * 60 * 1000
    let tokenData: Record<string, unknown> | undefined
    let attempt = 0
    while (Date.now() < deadline) {
      attempt += 1
      await new Promise(r => setTimeout(r, 2000))
      const res = await fetch(tokenUrl, {
        method: 'GET',
        headers: { [HTTP_HEADER_NO_AUTHORIZATION]: 'true', 'User-Agent': BUDDY_USER_AGENT },
      })
      const body = await res.json() as Record<string, unknown>
      const code = body.code
      const data = body.data
      console.log(`[token poll #${attempt}] HTTP ${res.status} code=${String(code)} data=${data === null || data === undefined ? String(data) : 'present'}`)
      if (res.status === 200 && data !== undefined && data !== null) {
        dump(`auth/token 成功响应（第 ${attempt} 次轮询）`, body)
        tokenData = data as Record<string, unknown>
        break
      }
    }
    expect(tokenData).toBeDefined()

    // ── 3. access_token 的 JWT 声明 ──
    const accessToken = String(tokenData?.accessToken ?? '')
    const payload = jwtPayload(accessToken)
    if (payload !== undefined) {
      console.log('\n===== access_token JWT payload =====')
      for (const [k, v] of Object.entries(payload)) {
        const text = typeof v === 'string' ? v : JSON.stringify(v)
        console.log(`  ${k} = ${text.length > 100 ? `${text.slice(0, 100)}…` : text}`)
      }
      const exp = payload.exp
      if (typeof exp === 'number') {
        console.log(`  → exp 换算: ${new Date(exp * 1000).toISOString()}`)
      }
    }

    // ── 4. login/account ──
    const accountUrl = `${API_ENDPOINT}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
    // ⚠️ `||` 而非 `??`：探针若用 `??`，token 未下发 domain（空串）时会打印
    // 「X-Domain 为空」却看不出原因 —— 正是 PR!19 要暴露的那种假阴性。
    const tokenDomain = String(tokenData?.domain || API_DOMAIN)
    const accountRes = await fetch(accountUrl, {
      method: 'GET',
      headers: {
        [HTTP_HEADER_DOMAIN]: tokenDomain,
        Authorization: `Bearer ${accessToken}`,
        [HTTP_HEADER_NO_USER_ID]: 'true',
        [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
        'User-Agent': BUDDY_USER_AGENT,
      },
    })
    const accountBody = await accountRes.json() as Record<string, unknown>
    dump('login/account 响应', accountBody)

    // ── 5. 结论摘要 ──
    console.log('\n===== 关键字段摘要 =====')
    console.log(`token.expiresAt        = ${JSON.stringify(tokenData?.expiresAt)}`)
    console.log(`token.refreshExpiresAt = ${JSON.stringify(tokenData?.refreshExpiresAt)}`)
    console.log(`token.scope            = ${JSON.stringify(tokenData?.scope)}`)
    console.log(`token.domain           = ${JSON.stringify(tokenData?.domain)}`)
    console.log(`token.tokenType        = ${JSON.stringify(tokenData?.tokenType)}`)
    console.log(`jwt.exp                = ${JSON.stringify(payload?.exp)}`)
    console.log(`jwt.nickname           = ${JSON.stringify(payload?.nickname)}`)
    console.log(`jwt.preferred_username = ${JSON.stringify(payload?.preferred_username)}`)
    console.log('=======================\n')
  }, 360_000)
})
