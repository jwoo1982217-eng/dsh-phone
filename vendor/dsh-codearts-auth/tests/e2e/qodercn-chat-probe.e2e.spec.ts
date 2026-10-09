/**
 * Qoder **中国版**加密推理探针 —— 本计划**最关键**的一次实测。
 *
 * 它验证设计文档 §8 那条推论的边界：
 * 「国际版那份 WASM 能解密 CN 的 catalog（E5）」**不等于**
 * 「WASM 签出的推理请求会被 CN 网关接受」。**只有这一步能证伪「共用一份」**。
 *
 * 同时验证两件次级风险：
 * - `clientMetadata` 用 CLI 身份（`client_type: '5'`）CN 是否接受
 *   （CN 桌面端自己用的是 `Fh`：`clientType 10` / `businessProduct 'app'` /
 *   `sessionType 'app'`）；
 * - `session_type`：`src/qoder-wasm.ts` 的 `QoderInferAsk.sessionType` 注释写着
 *   「国际版是 `qodercli`，国内版是 `qoder_work`」，而代码默认值是 `'qodercli'`。
 *   静态层面无法定案（该字段在 obf worker 里构造，字符串是 XOR 编码的；
 *   CN asar 里 `qoder_work` 唯一的命中属于 `integrationMode → --ide-type`，
 *   与推理载荷无关）—— 故列为本探针的**头号嫌疑**，失败时优先试它。
 * - `encryptedInferBase = gateway.qoder.com.cn` 是否正确。
 *
 * ⚠️ 默认模型 `qfmodel`（Qwen3.8-Flash）在 CN catalog 里 `is_free: true`，
 * **不消耗积分**（另一个免费的是 `qmodel_38max`）。
 *
 * ⚠️ 与**国际版那份探针的关键区别**：CN 没有可用的公开端点（实测
 * `gateway.qoder.com.cn/model/v1/chat/completions` 与
 * `openapi.qoder.com.cn/...` 都回 **503**），所以这里必须直接走
 * `QoderEncryptedInfer` 构造加密请求，**不能**照抄国际版探针里
 * `POST {inferBase}{QODER_CHAT_PATH}` 的公开端点写法。
 *
 * 双重闸门（缺一不可，因为会真实调用模型）：
 *   DSH_QODERCN_CHAT_E2E=1
 *   DSH_QODERCN_CHAT_E2E_CONFIRM=yes
 * 用 `pnpm test:e2e:qodercn-chat` 运行。
 */
import { describe, expect, it } from 'vitest'
import { QODER_CN } from '../../src/qoder-product.js'
import { QoderEncryptedInfer, type QoderInferMessage } from '../../src/qoder-wasm.js'
import { unwrapQoderEnvelopeStream } from '../../src/qoder-envelope.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODERCN_CHAT_E2E === '1'
  && process.env.DSH_QODERCN_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 被测模型：默认免费额度的 Qwen3.8-Flash。 */
const MODEL = process.env.DSH_QODERCN_MODEL ?? 'qfmodel'
const QUESTION = '回复两个字：收到'

/**
 * `session_type` 覆盖（默认沿用国际版的 `'qodercli'`）。
 *
 * 若默认值被 CN 拒绝，用 `DSH_QODERCN_SESSION_TYPE=qoder_work` 重跑一次即可判定
 * 是不是这一项 —— 不必改代码。
 */
const SESSION_TYPE = process.env.DSH_QODERCN_SESSION_TYPE

suite(`QoderCN 加密推理探针（模型 ${MODEL}，免费额度）`, () => {
  const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })

  it('至少有一个已登录的中国版账号', () => {
    expect(
      entries.length,
      '未找到 QODERCN 凭据。请先在 Jet Hub 的「Qoder (中国版)」面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('加密推理走通：WASM 共用成立、gateway 域名正确、CLI 身份被接受', async () => {
    const { credential } = entries[0]!
    expect(
      credential.uid,
      '凭据缺少 uid —— 缺它时 WASM 会产出签名无效的请求，服务端回 '
      + '`Signature invalid (101)`（国际版真实缺陷）。请在面板重新登录一次。',
    ).toBeTruthy()

    const history: QoderInferMessage[] = [{ role: 'user', content: QUESTION }]

    const client = await QoderEncryptedInfer.create({
      user: {
        uid: credential.uid!,
        securityOauthToken: credential.security_oauth_token ?? credential.access_token,
      },
      machineId: credential.machine_id,
      metadata: { ...QODER_CN.clientMetadata },
      host: QODER_CN.encryptedInferBase,
    })
    // ⚠️ `prepareInfer` 是**同步**方法（返回 QoderInferRequest，不是 Promise）。
    const request = client.prepareInfer({
      modelKey: MODEL,
      userText: QUESTION,
      history,
      isReasoning: true,
      ...(SESSION_TYPE === undefined ? {} : { sessionType: SESSION_TYPE }),
      // ⚠️ 必填：缺了服务端会把请求路由到故障节点（国际版真实缺陷，
      // 症状是「只有某一个模型坏」，极易误判为服务端故障）。
      business: { type: 'agent' },
    })

    console.log('\n===== 加密推理请求 =====')
    console.log(`  url        = ${request.url}`)
    console.log(`  sessionType= ${SESSION_TYPE ?? 'qodercli（默认，沿用国际版）'}`)
    console.log(`  bodyLen    = ${request.body.length}（WASM 加密，本地不可解）`)

    const response = await fetch(request.url, {
      method: 'POST',
      // ⚠️ 头必须**原样透传**：Authorization 是 WASM 生成的
      // `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid。
      headers: { ...request.headers, Accept: 'text/event-stream' },
      body: request.body,
      signal: AbortSignal.timeout(180_000),
    })

    console.log(`  status     = ${response.status}`)
    if (!response.ok) {
      console.log(`  body       = ${(await response.text()).slice(0, 800)}`)
      console.log('  ── 排查方向（按嫌疑度排序）──')
      console.log('  1) 403 / Signature invalid → 那份 WASM 的钥匙不被 CN 接受，')
      console.log('     需按设计文档 §15 从 CN runtime 1.1.64 另提一份。')
      console.log('  2) 提到 session / session_type → 用')
      console.log('     DSH_QODERCN_SESSION_TYPE=qoder_work 重跑（见 qoder-wasm.ts 注释）。')
      console.log('  3) 提到 client / business / product → 把 clientMetadata 换成')
      console.log('     CN 桌面端的 Fh 那组（10 / app / app / app）。')
      console.log('  4) 404 → encryptedInferBase 域名错。')
    }
    expect(response.status, '加密推理被拒 —— 排查方向见上方打印').toBe(200)

    // ⚠️ `unwrapQoderEnvelopeStream` 返回的是**剥掉信封的新 Response**，
    // 不是异步块流 —— 直接读它的 text()。
    const unwrapped = unwrapQoderEnvelopeStream(response, 'qodercn')
    const text = await unwrapped.text()
    const frames = text.split('\n').filter((line) => line.startsWith('data:')).length
    console.log(`  frames     = ${frames}`)
    console.log(`  head       = ${text.slice(0, 300)}`)
    expect(text, '响应为空 —— 信封剥离或端点形态与预期不符').toContain('data:')
    expect(frames, '没有任何 SSE data 帧').toBeGreaterThan(0)
    // 错误帧必须**不被当成正常结束**（AGENTS.md：Qoder 用独立 `event: error` 行
    // + 顶层 `{code,message,type}`，不是 OpenAI 的 `{error:{message}}`）。
    expect(text, '响应里出现 error 事件帧').not.toContain('event: error')
  }, 300_000)
})
