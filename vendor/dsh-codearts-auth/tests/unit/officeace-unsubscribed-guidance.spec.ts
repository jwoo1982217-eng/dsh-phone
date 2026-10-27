/**
 * `officeace-unsubscribed-guidance.spec.ts` —— 「账号未开通 MaaS」时的**出路文案**守卫
 * （Gitee IKM741 追补，2026-10-16）。
 *
 * ## 这个文件为什么存在（真机因果链）
 *
 * 同一个华为号（手机号注册的根账号）在果办客户端点「开通」**前后**：
 *
 * | 时刻 | 云侧 `client-permission-validate` |
 * |---|---|
 * | 20:57（开通前） | `subscription: null` |
 * | 21:16（开通后） | `model_auth_info` 齐全，网关 `modelgw-00xx…` |
 *
 * 而修前插件只回一句「账号可能未订阅 ModelArts MaaS」——**没有告诉用户怎么办**，
 * 用户为此在客户端里摸索了半天。⇒ 本条文案的**出路信息**（去哪、做什么）是**被测行为**。
 *
 * ## ⚠️⚠️ 本文件同时是「不许把依赖 ide 的方案塞回来」的守卫
 *
 * 曾经实现过一版自动开通（读果办客户端 CAS 落盘 profile + 调 versatile 的
 * `/v1/agreement`、`/v1/claw/client-subscription`），真机证伪（三处请求全
 * `401 APIGW.0301`，凭据来源不对）**且必然依赖 ide**（用户 2026-10-16 明确否决）。
 * ⇒ 两条守卫把它挡在门外：
 * 1. **行为**：未开通时**只允许**发 token 交换 + permission-validate 两个请求；
 * 2. **源码**：剥掉注释后的代码里**不得**出现读客户端落盘 / 本地 API / versatile 开通端点的字样。
 */

import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loginNeedsExternalAction } from '../../src/login-failure.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeLogin } from '../../src/officeace-auth.js'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = resolve(here, '../../src/officeace-auth.ts')

/** 一次被记录下来的请求。 */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

async function makeJwk(): Promise<Record<string, unknown>> {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return await webcrypto.subtle.exportKey('jwk', kp.privateKey) as Record<string, unknown>
}

const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const PERMISSION_URL = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-permission-validate'

const STS_BODY = JSON.stringify({
  credentials: {
    access_key_id: 'AK_TEST', secret_access_key: 'SK_TEST', security_token: 'STS_TEST',
    expiration: '2030-01-01T00:00:00.000Z',
  },
  refresh_token: 'rt.test.refresh',
})

interface Reply { status?: number; body: string }

/**
 * 按 URL 分派的 fetch 桩 + 调用记录。
 * ⚠️ **未登记的 URL 一律 404**（刻意）：多打一个请求（哪怕只是探测）都会红。
 */
function installFetch(replies: Record<string, Reply>): Recorded[] {
  const seen: Recorded[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const url = String(input)
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const reply = replies[url]
    const status = reply?.status ?? (reply === undefined ? 404 : 200)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => reply?.body ?? '{"error":"unregistered url"}',
      json: async () => JSON.parse(reply?.body ?? '{}') as unknown,
    } as unknown as Response
  })
  return seen
}

const PERMISSION_WITH_MAAS = JSON.stringify({
  account_id: 'acct-with-maas',
  principal_urn: 'iam::x:user:someone',
  subscription: {
    model_info: {
      model_auth_info: { model_app_key: 'k-on', model_app_secret: 's-on' },
      model_api_url_base: 'modelgw-00xx.officeace.cn-southwest-2.huaweicloud-agentarts.com',
    },
  },
})

/** 真机拿到的未开通形状：`subscription: null`。 */
const PERMISSION_NO_MAAS = JSON.stringify({ account_id: 'acct-before', subscription: null })

let jwk: Record<string, unknown>
beforeEach(async () => { jwk = await makeJwk() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('已开通账号：正常路径且**零额外请求**', () => {
  it('① 只打 token 交换 + permission-validate；凭据字段逐项正确', async () => {
    const seen = installFetch({
      [TOKEN_URL]: { body: STS_BODY },
      [PERMISSION_URL]: { body: PERMISSION_WITH_MAAS },
    })
    const credential = await completeLogin('code-1', 'verifier-1', jwk as never)
    expect(seen.map((r) => r.url)).toEqual([TOKEN_URL, PERMISSION_URL])
    expect(credential.modelAppKey).toBe('k-on')
    expect(credential.modelAppSecret).toBe('s-on')
    expect(credential.maasBaseUrl).toBe('https://modelgw-00xx.officeace.cn-southwest-2.huaweicloud-agentarts.com')
    expect(credential.accountId).toBe('acct-with-maas')
  })
})

describe('未开通账号：抛错文案**必须给出路**', () => {
  it('② `subscription: null` ⇒ 文案同时含「未开通」「果办客户端」「开通」三要素', async () => {
    const seen = installFetch({
      [TOKEN_URL]: { body: STS_BODY },
      [PERMISSION_URL]: { body: PERMISSION_NO_MAAS },
    })
    const error = await completeLogin('code-2', 'verifier-2', jwk as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('华为云未返回 MaaS 凭据')
    expect(message).toContain('尚未开通 ModelArts MaaS')
    // ⚠️ 出路两要素：**去哪**（果办客户端）+ **做什么**（点开通/同意授权）
    expect(message, '文案必须指路「果办客户端」——否则用户只能像 2026-10-16 那样自己摸索').toContain('果办客户端')
    expect(message, '文案必须说清动作是「开通」').toContain('开通')
    // ⚠️⚠️ **必须带「出路在外部」标记**（2026-10-20 用户报障）：否则登录收尾处会给它
    //    拼上「请重新点击「+ 新建账号」」—— 那句是**假出路**：开通与授权只能在**果办**
    //    里做，重新点新建账号只会重走一遍 OAuth 然后再失败一次，还把上面那两句
    //    唯一有用的指路冲淡了。
    //    ⚠️ 「文案分支」本身的守卫在 `login-poll-terminal-failure.spec.ts`
    //    （「带标记不得加通用后缀 / 未标记必须加」两条，那里有完整 RPC 夹具）。
    expect(
      loginNeedsExternalAction(error),
      '未开通错误必须被标记为「重试无用、出路在外部」',
    ).toBe(true)
    // ⚠️ 且**只允许**这两个请求（不许偷偷读客户端落盘 / 调本地 API）
    expect(seen.map((r) => r.url)).toEqual([TOKEN_URL, PERMISSION_URL])
  })

  it('③ 半截凭据（只有 model_app_key、没有 secret）⇒ 同样按未开通处理，绝不写半截凭据', async () => {
    const seen = installFetch({
      [TOKEN_URL]: { body: STS_BODY },
      [PERMISSION_URL]: {
        body: JSON.stringify({
          account_id: 'acct-half',
          subscription: { model_info: { model_auth_info: { model_app_key: 'only-key' } } },
        }),
      },
    })
    const error = await completeLogin('code-3', 'verifier-3', jwk as never).catch((e: unknown) => e)
    expect((error as Error).message).toContain('尚未开通 ModelArts MaaS')
    expect(seen.map((r) => r.url)).toEqual([TOKEN_URL, PERMISSION_URL])
  })

  it('④ permission-validate 自身失败（HTTP 500）⇒ 保底文案不变，且不带未开通指引', async () => {
    installFetch({
      [TOKEN_URL]: { body: STS_BODY },
      [PERMISSION_URL]: { status: 500, body: 'boom' },
    })
    await expect(completeLogin('code-4', 'verifier-4', jwk as never)).rejects.toThrow(/华为云权限校验失败：HTTP 500/)
  })
})

describe('⚠️ 结构性守卫：代码里不许再出现「依赖 ide / 调 versatile 开通端点」', () => {
  it('⑤ 剥掉注释后的源码不含读客户端落盘、本地 API、开通端点等字样', () => {
    const source = readFileSync(sourcePath, 'utf8')
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（含 JSDoc）
      .replace(/^[ \t]*\/\/.*$/gm, '')       // 行注释
    for (const banned of [
      'secure-config-nodejs',                // 果办客户端凭据落盘目录
      'oauth-profile-encryption-key',        // 其加密密钥
      'client-subscription',                 // versatile 开通端点
      '/v1/agreement',                       // versatile 协议端点
      '127.0.0.1:3003',                      // 客户端本地 API
      'create-order',                        // 客户端本地下单端点
      'claim-bonus',                         // 客户端本地领取端点
      'ticket-validate',                     // CAS ticket 校验
    ]) {
      expect(codeOnly.includes(banned), `代码里出现了禁止字样：${banned}（注释里说明可以，代码里不行）`).toBe(false)
    }
    /**
     * ⚠️ **如实登记的既有例外**（本次**刻意不撤**，用户 2026-10-16 只要求开通/授权链路零依赖）：
     *
     * `readSessionCookie()` 读 `~/.office-claw/session.cookie`（DPAPI）用于**积分读数**的
     * 本地 API 路径 —— 它**不在**开通/授权链路上，而且在**当前客户端版本**上该文件已不存在
     * （实测 `~/.office-claw` 顶层只有 `users/`、`user-catalogs/`、`provider-profiles*.json` 等）
     * ⇒ 那条腿**恒失效**、读数落到缓存兜底。下面这条断言把它**钉在唯一一处**，防止扩散。
     */
    expect(
      (codeOnly.match(/session\.cookie/g) ?? []).length,
      '`session.cookie` 只应存在于 readSessionCookie 这一处既有实现里（新增即视为扩散，需先议）',
    ).toBeLessThanOrEqual(1)
  })
})
