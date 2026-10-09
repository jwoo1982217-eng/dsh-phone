/**
 * Qoder **中国版**登录与端点探针。
 *
 * ⚠️ 会真实发网络请求，但**全部只读**（不发消息、不领取），故零额度。
 *
 * 它要回答设计文档 §15 里那个**最高风险**问题：
 * `client_id = 732aef47-…`（取自 CN asar 的 `authClientIds.prod`）是否真被
 * 服务端接受。**国际版的教训**：用错 client_id 时入口 **302 完全正常**，
 * 只在用户点「授权」之后才报「参数无效」—— 所以本探针只能证明
 * 「URL 构造与端点形态正确」，**授权闭环仍需人工在浏览器里点一次**
 * （或在 Jet Hub 中国版面板登录一次，然后跑本探针的续期用例）。
 *
 * 端点存在性的判别法沿用国际版已验证的那条（AGENTS.md Qoder 要点 4）：
 * 轮询路径返回 **404**（= 被网关豁免认证、业务层报「会话未就绪」），
 * 而**任意不存在的路径**返回 **401** —— 两者区分开才证明路径真的存在。
 *
 * 闸门：`DSH_QODERCN_E2E=1`（只读，单闸门即可）
 * 用 `pnpm test:e2e:qodercn` 运行。
 * 凭据来源：`DSH_QODERCN_CREDENTIAL_JSON`，或 `.credentials.yaml` 里的
 * `QODERCN_ACCOUNT_*`（需先在 Jet Hub「Qoder (中国版)」面板登录）。
 */
import { describe, expect, it } from 'vitest'
import { QODER_CN } from '../../src/qoder-product.js'
import {
  QODER_REFRESH_PATH,
  QODER_USERINFO_PATH,
  buildQoderAuthUrl,
  buildQoderPollUrl,
  createQoderDeviceSession,
  qoderRefreshBody,
} from '../../src/qoder.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODERCN_E2E === '1'
const suite = RUN ? describe : describe.skip

suite('QoderCN 登录与端点探针（只读，零额度）', () => {
  it('授权 URL 落在中国版域名且带中国版 client_id', () => {
    const session = createQoderDeviceSession()
    const url = buildQoderAuthUrl(session, QODER_CN)
    console.log(`  loginUrl = ${url}`)
    expect(url.startsWith('https://qoder.cn/device/selectAccounts?')).toBe(true)
    // ⚠️ 断言里带上国际版 id 的**反向检查**：一旦产品配置被改错或两站配置
    // 被合并，这里会立刻红，而不是等用户登录失败才发现。
    expect(url).toContain('client_id=732aef47-9cf2-46a2-95fe-4cebb5d0d1fa')
    expect(url).not.toContain('e883ade2')
    // PKCE 参数族必须齐全（与 CN asar 的 `Sft()` 逐参数一致，设计文档 E3）。
    for (const key of ['challenge=', 'challenge_method=S256', 'nonce=', 'machine_id=']) {
      expect(url, `授权 URL 缺少 ${key}`).toContain(key)
    }
  })

  it('中国版轮询端点存在：404（会话未就绪）而不是 401（无此路由）', async () => {
    // 判别法沿用国际版实测（AGENTS.md Qoder 要点 4）：该路径被网关豁免认证，
    // 无待授权会话时回 404；而任意不存在的路径回 401。故 404 才是「路径存在」的证据。
    const session = createQoderDeviceSession()
    const url = buildQoderPollUrl(session, QODER_CN)
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    const body = await response.text()
    console.log(`  poll ${response.status} ${body.slice(0, 200)}`)
    expect(response.status, '轮询端点行为与国际版不同（404 = 存在但无会话）').toBe(404)
  })

  it('同 host 上不存在的路径回 401（与上一条对照，证明 404 不是网关兜底）', async () => {
    const url = `${QODER_CN.openApiBase}/api/v1/zzz-not-exist-probe-${Date.now()}`
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    console.log(`  bogus ${response.status} ${(await response.text()).slice(0, 160)}`)
    expect(response.status).toBe(401)
  })

  it('中国版 userinfo 端点存在（无凭据回 401 TOKEN_INVALID，与国际版同形）', async () => {
    // 实测依据（设计文档 E7）：CN 回 `{"code":"TOKEN_INVALID",…}`，
    // 与国际版**逐字节同形** —— 这是「积分/昵称链路可整套复用」的直接证据。
    const response = await fetch(`${QODER_CN.openApiBase}${QODER_USERINFO_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.text()
    console.log(`  userinfo ${response.status} ${body.slice(0, 160)}`)
    expect(response.status).toBe(401)
    expect(body).toContain('TOKEN_INVALID')
  })

  it('加密推理端点在 gateway 上存在（GET 被拒为方法不支持，而不是 404）', async () => {
    // 实测依据（E9）：CN 与 intl 都回 `400 "Request method 'GET' not supported"`
    // → 同一套 `algo` 网关，只是换了域名。
    const url = `${QODER_CN.encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation`
      + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    const body = await response.text()
    console.log(`  infer ${response.status} ${body.slice(0, 200)}`)
    expect(body).toContain("Request method 'GET' not supported")
  })

  it('已登录凭据可续期（若已在中国版面板登录）', async () => {
    const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })
    if (entries.length === 0) {
      console.log('  跳过：未找到 QODERCN_ACCOUNT_* 凭据（先在面板登录一次）')
      return
    }
    const { credential, uid } = entries[0]!
    if (credential.refresh_token === undefined || credential.refresh_token.length === 0) {
      console.log(`  跳过：${uid} 无 refresh_token`)
      return
    }
    const response = await fetch(`${QODER_CN.openApiBase}${QODER_REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(qoderRefreshBody(credential)),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    console.log(`  refresh ${response.status} ${body.slice(0, 300)}`)
    expect(response.status, '续期被拒 —— 检查 CN 是否校验 machine_id 来源').toBe(200)
  })
})
