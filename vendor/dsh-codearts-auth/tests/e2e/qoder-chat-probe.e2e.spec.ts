/**
 * Qoder 对话与续期探针。
 *
 * ⚠️ 本用例会**真实发送模型请求**。默认用 `qmodel_38max`（Qwen3.8-Max，免费额度模型，
 * **不消耗积分**）；若用 `DSH_QODER_MODEL` 改成付费模型则会消耗额度。
 *
 * 用途：验证两件在单测里无法证明的事：
 * 1. **推理链路**：`POST api2.qoder.sh/…/agent_chat_generation?Encode=1`（加密）走通并
 *    返回 SSE（单测只能证明请求构造正确，不能证明服务端接受）；
 * 2. **续期**：`POST /api/v1/deviceToken/refresh` 接受本插件生成的
 *    `machine_id`（**这是本设计最大的未验证假设** —— 见设计文档 §8：
 *    Qoder 官方用的是硬件指纹，本插件用随机 UUID，若服务端校验设备一致性
 *    则续期会失败）。
 *
 * 第 2 点是本探针**首要**要回答的问题：它比对话本身更重要 ——
 * 续期不通意味着用户每天都要重新登录。
 *
 * 双重闸门（缺一不可，防止误跑）：
 *   DSH_QODER_CHAT_E2E=1
 *   DSH_QODER_CHAT_E2E_CONFIRM=yes
 *
 * 用 `pnpm test:e2e:qoder-chat` 运行（两个变量已内置）。
 * 凭据来源：`DSH_QODER_CREDENTIAL_JSON`，或本地 `.credentials.yaml`
 * 中的 `QODER_ACCOUNT_*` 条目。
 */

import { describe, expect, it } from 'vitest'
import { QODER } from '../../src/qoder-product.js'
import {
  QODER_CHAT_PATH,
  QODER_REFRESH_PATH,
  parseQoderTokenPayload,
  qoderBearerToken,
  qoderRefreshBody,
} from '../../src/qoder.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODER_CHAT_E2E === '1'
  && process.env.DSH_QODER_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/**
 * 被测模型：默认 `qmodel_38max`（Qwen3.8-Max，**免费额度模型，不消耗积分**），
 * 可用 `DSH_QODER_MODEL` 覆盖（例如改成 `dmodel`（DeepSeek-V4-Pro）会消耗积分）。
 */
const MODEL = process.env.DSH_QODER_MODEL ?? 'qmodel_38max'

suite('Qoder 对话与续期探针（默认用免费模型 Qwen3.8-Max / qmodel_38max）', () => {
  const entries = readQoderCredentialsFromDshStore()

  it('至少有一个已登录的 Qoder 账号', () => {
    expect(
      entries.length,
      '未找到 Qoder 凭据。请先在 Jet Hub 的 Qoder 面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('推理链路返回 SSE（默认免费模型，不消耗积分）', async () => {
    const { credential } = entries[0]!
    console.log('\n===== 推理请求 =====')
    console.log(`  url   = ${QODER.inferBase}${QODER_CHAT_PATH}`)
    console.log(`  model = ${MODEL}`)

    const response = await fetch(`${QODER.inferBase}${QODER_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qoderBearerToken(credential)}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '回复两个字：收到' }],
        stream: true,
        stream_options: { include_usage: true },
        metadata: {
          context: {
            request_id: crypto.randomUUID(),
            session_id: crypto.randomUUID(),
            client_type: QODER.clientMetadata.client_type,
            business_product: QODER.clientMetadata.business_product,
            business_type: QODER.clientMetadata.business_type,
            scene: QODER.clientMetadata.scene,
          },
        },
      }),
    })

    console.log(`  status = ${response.status}`)
    if (!response.ok) {
      // 打印错误体：401 说明令牌失效，403 可能意味着需要额外签名头
      // （那将推翻「推理只需 Bearer」的结论，必须让排查者看到原始响应）。
      console.log(`  body   = ${(await response.text()).slice(0, 500)}`)
    }
    expect(response.status, '推理请求被拒 —— 检查令牌是否有效').toBe(200)

    const text = await response.text()
    expect(text, '响应不是 SSE（未出现 data: 帧）').toContain('data:')
    // 至少要有一帧可解析的 JSON，证明协议形态与预期一致。
    const frames = text.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((payload) => payload.length > 0 && payload !== '[DONE]')
    expect(frames.length, '没有任何可解析的 SSE 帧').toBeGreaterThan(0)
    console.log(`  frames = ${frames.length}`)
  }, 300_000)

  it('续期接受本插件生成的 machine_id（⚠️ 本设计最关键的假设）', async () => {
    const { credential, uid } = entries[0]!
    expect(
      credential.refresh_token,
      `${uid} 无 refresh_token，无法验证续期`,
    ).toBeTruthy()

    console.log('\n===== 续期请求 =====')
    console.log(`  url        = ${QODER.openApiBase}${QODER_REFRESH_PATH}`)
    console.log(`  machine_id = ${credential.machine_id.slice(0, 8)}…（本插件生成的随机 UUID）`)

    const response = await fetch(`${QODER.openApiBase}${QODER_REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(qoderRefreshBody(credential)),
    })

    console.log(`  status = ${response.status}`)
    if (!response.ok) {
      console.log(`  body   = ${(await response.text()).slice(0, 500)}`)
    }
    // 若这里失败而 401 之外的状态码出现，说明服务端对 machine_id 有校验，
    // 需要改用硬件指纹（见设计文档 §8 风险表）。
    expect(
      response.status,
      '续期被拒 —— 若为 4xx 而非 401，说明服务端校验了设备标识，'
      + '需改用硬件指纹派生 machine_id（见设计文档 §8）',
    ).toBe(200)

    const payload = parseQoderTokenPayload(await response.json() as unknown)
    expect(payload.accessToken, '续期响应缺少 device_token').toBeTruthy()
    console.log(`  新令牌已下发 = ${payload.accessToken.length > 0}`)
    console.log(`  新 refresh_token = ${payload.refreshToken !== undefined}`)
  }, 60_000)
})
