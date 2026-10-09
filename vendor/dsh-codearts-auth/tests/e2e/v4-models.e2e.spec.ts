import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

// 仅在 `pnpm test:e2e` 下执行（需设置 DSH_CODEARTS_E2E=1）；
// 默认跳过，以免 CI 和普通 `pnpm test` 触发真实后端调用。
const E2E = process.env.DSH_CODEARTS_E2E === '1'

// e2e 实测确认的后端可用模型 ID：
// - deepseek-v4-flash（无日期后缀）✅ 后端已注册，可收发消息
// - deepseek-v4-pro ✅ 后端已注册，可收发消息
// - deepseek-v4.1-flash ✅ benefit（免费额度）模型，**必须带 maas_type: benefit**
//
// ⚠️ 修正（2026-09-23，对齐 deveco-code-rust fb1b4a2）：早期注释称
// 「deepseek-v4-flash-0731 后端未注册」，该结论**有误** —— 它返回
// InferHub.002002009.404 的真实原因是**缺少 maas_type: benefit 头**，带上即成功。
// 带日期后缀与无后缀是后端上两个不同的模型（benefit 属性相反），不能互相替代：
// gateway/config 下发的 benefit 组（-0731 / -0813 / deepseek-v4.1-flash）必须带该头，
// 而无后缀的 deepseek-v4-flash / -pro 带上反而报 `unsupported model`。
const V4_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
] as const

/**
 * 解析真实凭据：优先从 DSH_CODEARTS_CREDENTIAL_JSON 环境变量读取
 * （JSON 字符串，与 CODEARTS_ACCESS_TOKEN 存储值同构），其次从
 * DSH_CODEARTS_ACCESS_KEY_ID / SECRET_ACCESS_KEY / SECURITY_TOKEN / EXPIRES_AT
 * 拼装。两种方式都要求调用方先完成 `/codearts-login` 并把凭据注入环境。
 */
function loadCredentialFromEnv(): CodeArtsCredential {
  const json = process.env.DSH_CODEARTS_CREDENTIAL_JSON
  if (json && json.length > 0) {
    return JSON.parse(json) as CodeArtsCredential
  }
  const ak = process.env.DSH_CODEARTS_ACCESS_KEY_ID
  const sk = process.env.DSH_CODEARTS_SECRET_ACCESS_KEY
  const st = process.env.DSH_CODEARTS_SECURITY_TOKEN
  const expiresAt = process.env.DSH_CODEARTS_EXPIRES_AT
  if (ak && sk && st && expiresAt) {
    return { access_key_id: ak, secret_access_key: sk, security_token: st, expires_at: expiresAt }
  }
  throw new Error(
    'e2e 用例需要真实 CodeArts 凭据。请先完成 /codearts-login，然后设置 '
      + 'DSH_CODEARTS_CREDENTIAL_JSON（推荐，与 CODEARTS_ACCESS_TOKEN 存储值同构的 JSON 字符串）'
      + '或 DSH_CODEARTS_ACCESS_KEY_ID / DSH_CODEARTS_SECRET_ACCESS_KEY / '
      + 'DSH_CODEARTS_SECURITY_TOKEN / DSH_CODEARTS_EXPIRES_AT 环境变量。',
  )
}

describe.runIf(E2E)('codearts deepseek-v4 models e2e', () => {
  for (const model of V4_MODELS) {
    it(
      `${model.id} can send and receive messages`,
      async () => {
        const credential = loadCredentialFromEnv()
        const adapter = new CodeArtsAdapter({
          credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
          resolveCredential: async () => credential,
          refresh: async () => {
            throw new Error('e2e: credential refresh not supported; please re-login and update env')
          },
        })

        const sentMessage = `Reply with exactly this text and nothing else: LIVE_TEST_OK (model=${model.name})`
        const texts: string[] = []
        const reasoning: string[] = []
        let finishKind: string | undefined
        for await (const chunk of adapter.stream({
          provider: 'codearts',
          model: model.id,
          messages: [{ role: 'user', content: sentMessage }],
          signal: new AbortController().signal,
        } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
          if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
          if (chunk.type === 'finish') finishKind = chunk.reason.kind
        }

        // GLM 端点有时把整段回答作为 reasoning_content 发出且 content 为空，
        // 适配器会回退把推理作为可见文本。两种路径都算"收到回复"。
        const received = texts.join('') || reasoning.join('')
        expect(received.length).toBeGreaterThan(0)
        expect(received).toContain('LIVE_TEST_OK')
        // finish 应为 stop（纯文本回复，无工具调用）。
        expect(finishKind).toBe('stop')
      },
      290_000,
    )
  }
})
