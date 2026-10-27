/**
 * `officeace-base-url.spec.ts` —— **推理/探测必须用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## 背景：这是一个阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 用户报障：「Jet Hub 的 provider 列表里有 OfficeAce、我也加了账号，
 * 但对话中选择模型的列表里看不到 OfficeAce 的模型」。
 *
 * 根因：适配器一律打硬编码的 `OFFICEACE.defaultBaseUrl`
 *（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 * 而华为**按账号下发专属网关** `modelgw-0004.officeace.cn-southwest-2...`。
 * 同一个 Basic 凭据实测：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码，修复前用的）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 选择器**空分组**；而空返回与
 * 「无账号」**同形** ⇒ 目录门控把整个 provider 隐藏。**全程零日志**。
 *
 * ⚠️ `maasBaseUrl` 早就写进了凭据（`fetchModelInfo` 从云侧 `model_api_url_base` 取），
 *    只是**从没被读过** —— 典型「写了不读的死字段」。此前审计已登记为已知缺口，
 *    但**低估了它**（判为「影响有限」），真机证明它是主路径。
 *
 * ## 本文件守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 有 `maasBaseUrl` 时，probe 与推理都打它 | 401 ⇒ 模型列表空（原始缺陷）|
 * | 2 | 没有 `maasBaseUrl` 时回退默认域 | 老凭据/异常形状下零行为变化 |
 * | 3 | 尾斜杠被规范化（不出现 `//v2/...`）| 部分网关对双斜杠 404 |
 * | 4 | **V11 签名端点不受影响** | 误改会把余额/倍率一起打挂（它们是管理面 API）|
 *
 * ⚠️ 不发真实网络：`fetchImpl` 记录 URL 后回最小响应。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OfficeAceAdapter, maasBaseUrlOf } from '../../src/officeace-adapter.js'
import { OFFICEACE } from '../../src/officeace-product.js'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

const ACCOUNT_BASE = 'https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com'

function cred(overrides: Partial<OfficeAceCredential> = {}): OfficeAceCredential {
  return {
    modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: ACCOUNT_BASE,
    access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'r', dpopPrivateJwk: {},
    ...overrides,
  }
}

describe('maasBaseUrlOf（纯函数：选哪个 host）', () => {
  it('① 凭据带 maasBaseUrl ⇒ 用它（这是本缺陷的核心断言）', () => {
    expect(maasBaseUrlOf(cred()), ACCOUNT_BASE)
      .toBe(ACCOUNT_BASE)
  })

  it('② 凭据缺 maasBaseUrl ⇒ 回退默认域（零行为变化，别让老凭据打挂）', () => {
    expect(maasBaseUrlOf(cred({ maasBaseUrl: '' }))).toBe(OFFICEACE.defaultBaseUrl)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: '   ' })), '纯空白应按缺失处理')
      .toBe(OFFICEACE.defaultBaseUrl)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: undefined as never }))).toBe(OFFICEACE.defaultBaseUrl)
  })

  it('③ 尾斜杠被规范化（避免出现 `//v2/chat/completions`）', () => {
    expect(maasBaseUrlOf(cred({ maasBaseUrl: `${ACCOUNT_BASE}/` }))).toBe(ACCOUNT_BASE)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: `${ACCOUNT_BASE}///` }))).toBe(ACCOUNT_BASE)
  })
})

describe('适配器真的用了按账号下发的 host（端到端，mock fetch）', () => {
  /** 记录所有请求 URL，并按路径回最小可用响应。 */
  function makeAdapter(c: OfficeAceCredential) {
    const urls: string[] = []
    const adapter = new OfficeAceAdapter({
      credentialProvider: async () => c,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('/v2/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }) as typeof fetch,
    })
    return { adapter, urls }
  }

  it('④ listModels 的 probe 打的是账号专属 host（打错 = 空列表 = 本缺陷）', async () => {
    const { adapter, urls } = makeAdapter(cred())
    await adapter.listModels('officeace')
    const probeUrls = urls.filter((u) => u.includes('/v2/models'))
    expect(probeUrls.length, 'probe 必须真的发出去过').toBeGreaterThan(0)
    // ⚠️ 这是本用例的关键：URL 必须以账号域名开头，而不是硬编码默认域。
    expect(probeUrls[0], 'probe 仍打默认域 ⇒ 401 ⇒ 模型列表为空（原始症状）')
      .toContain(ACCOUNT_BASE)
    expect(probeUrls[0], '不得再打硬编码默认域')
      .not.toContain(OFFICEACE.defaultBaseUrl)
  })

  it('⑤ 模型列表非空（probe 通过后按静态表返回，共 8 个）', async () => {
    const { adapter } = makeAdapter(cred())
    const models = await adapter.listModels('officeace')
    expect(models.length, 'probe 通过后应返回静态表全部模型').toBeGreaterThan(0)
    expect(models.every((m) => m.provider === 'officeace')).toBe(true)
  })

  it('⑥ 推理请求也打账号专属 host，且路径正确', async () => {
    const { adapter, urls } = makeAdapter(cred())
    const prepared = await adapter.prepareCall('officeace', 'glm-5.2')
    // 消费流（忽略内容，只要请求发出去）
    for await (const _ of prepared.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) { /* drain */ }
    const chatUrls = urls.filter((u) => u.includes('/v2/chat/completions'))
    expect(chatUrls.length, '推理请求必须发出去').toBeGreaterThan(0)
    expect(chatUrls[0], '推理仍打默认域 ⇒ 401（与模型列表空同因）').toContain(ACCOUNT_BASE)
  })

  it('⑦ 凭据没带 maasBaseUrl 时回退默认域（不引入回归）', async () => {
    const { adapter, urls } = makeAdapter(cred({ maasBaseUrl: '' }))
    await adapter.listModels('officeace')
    const probeUrls = urls.filter((u) => u.includes('/v2/models'))
    expect(probeUrls[0]).toContain(OFFICEACE.defaultBaseUrl)
  })
})

/**
 * ⚠️ **范围守卫：V11 签名端点不得被一起改**。
 *
 * 实测两个 host 的 `/v1/subscription` 与 `/v1/model-token-rates`
 * **都存在且都要求 IAM 签名**（返回 `failed parse aksk format` 而非 404/DNS 错）
 * ⇒ 它们是**管理面 API**，与推理面不同源。
 *
 * 若有人「为统一」把 V11 路径也换成 `credential.maasBaseUrl`，
 * 会把**余额与倍率**一起打挂（用户看到积分行报错、模型名没有 x 系数）。
 */
describe('范围守卫：V11 签名端点保持默认域（别一起改）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const authSource = readFileSync(resolve(here, '../../src/officeace-auth.ts'), 'utf8')

  it('⑧ V11 的 /v1/subscription 与 model-token-rates 仍用 defaultBaseUrl', () => {
    // 判据：这两条路径的 URL 拼接里，用的是 defaultBaseUrl 而非 maasBaseUrl。
    expect(authSource, 'V11 余额端点被改成了账号域 —— 它是管理面 API，两个 host 行为不同')
      .toMatch(/defaultBaseUrl[\s\S]{0,80}\/v1\/subscription/)
    expect(authSource, 'V11 倍率端点被改成了账号域')
      .toMatch(/defaultBaseUrl[\s\S]{0,80}\/v1\/model-token-rates/)
  })

  it('⑨ 适配器里不得再有裸的 defaultBaseUrl 拼接（三处推理路径全改）', () => {
    const adapterSource = readFileSync(resolve(here, '../../src/officeace-adapter.ts'), 'utf8')
    // 只允许出现在 `maasBaseUrlOf` 的回退分支与注释里；
    // 判据锚定「模板串里拼 defaultBaseUrl」这一形态。
    expect(
      adapterSource,
      '适配器里仍有 `\\${OFFICEACE.defaultBaseUrl}` 形式 —— 推理路径必须走 maasBaseUrlOf',
    ).not.toMatch(/`\$\{OFFICEACE\.defaultBaseUrl\}/)
  })
})
