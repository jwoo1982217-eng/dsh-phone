/**
 * 网关瞬时签名故障的**有界重发**（`isTransientSignatureFailure` + `SIGNATURE_RETRY_MAX`）。
 *
 * ## 为什么这个文件存在（2026-10-19 对抗审计）
 *
 * 该功能合入时**一条测试都没有**。对抗审计逐条变异后实测**四处全绿**：
 *
 * | 变异 | 结果 |
 * |---|---|
 * | `isTransientSignatureFailure` 正则改成永不匹配 | 全量与基线逐项相同 |
 * | `signatureRetries < SIGNATURE_RETRY_MAX` 改成恒假 | 同上 |
 * | `isAuthError` 删掉签名腿 | 同上 |
 *
 * 即：功能本身有效（探针实测签名故障一次即自愈），但**零回归保护** ——
 * 将来任何人改坏这四处，CI 照样全绿。本文件逐条补上牙。
 *
 * ## 判据必须同时锁住的四条腿
 *
 * 1. **报文判据**：`body hash mismatch` 命中；`verify ak sk signature fail`
 *    **不得**命中（它同时覆盖真实 AK/SK 错误，放宽会让用户永远等不到
 *    「请重新登录」）。
 * 2. **有界重发**：故障持续时**必须恰好重发 `SIGNATURE_RETRY_MAX` 次**，
 *    不是无限重试。
 * 3. **不消耗续期名额**：签名故障**不得**触发 `refresh()`。
 * 4. **abort 后停手**：用户按「停止」后**不得再发请求**（见下方 I1 用例）。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CodeArtsAdapter, isTransientSignatureFailure } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 用户报障 2026-10-03 会话日志原文（APIG.0301 的「哈希对不上」那一支）。 */
const SIGNATURE_MISMATCH_BODY =
  '{"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication information: calc ak sk signature fail:body hash mismatch x-sdk-content-sha256 header"}'

/** APIG.0301 的另一半 —— 它**同时**覆盖真实 AK/SK 错误，不得被当成瞬时。 */
const VERIFY_SIGNATURE_BODY =
  '{"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication information: calc ak sk signature fail:verify ak sk signature fail"}'

/** 真实凭据失效（对照组）：必须走 refresh，不得被签名腿拦下。 */
const INVALID_TOKEN_BODY = '{"error_code":"APIG.0602","error_msg":"Invalid token"}'

function signatureResponse(): Response {
  return new Response(SIGNATURE_MISMATCH_BODY, { status: 401 })
}

interface RunOutcome {
  chatCalls: number
  refreshCalls: number
  /** 以 200 + 合法 SSE 收尾，让 stream 正常结束（否则会落到排队探测路径）。 */
  finish: () => void
}

function runStream(options: {
  /** 前 n 次返回 401 签名故障，之后正常。 */
  failures?: number
  failureBody?: string
  status?: number
  signal?: AbortSignal
}): Promise<RunOutcome & { error?: unknown }> {
  let chatCalls = 0
  let refreshCalls = 0
  let remainingFailures = options.failures ?? Number.POSITIVE_INFINITY
  const failureBody = options.failureBody ?? SIGNATURE_MISMATCH_BODY
  const status = options.status ?? 401

  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => validCredential,
    refresh: async () => { refreshCalls += 1 },
    fetchImpl: async (input) => {
      const url = String(input)
      // ⚠️ 排队状态探测：本用例不覆盖排队语义，直接返回 working 让它退出。
      if (url.includes('/queue/status')) {
        return new Response(JSON.stringify({ status: 'working' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      if (remainingFailures > 0) {
        remainingFailures -= 1
        return new Response(failureBody, { status })
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })

  const streamOptions = {
    model: 'GLM-5.2',
    messages: [],
    ...options.signal !== undefined ? { signal: options.signal } : {},
  } as never

  return (async () => {
    const outcome: RunOutcome & { error?: unknown } = {
      chatCalls: 0,
      refreshCalls: 0,
      finish: () => {},
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of adapter.stream(streamOptions)) { /* 读完即可 */ }
    } catch (error) {
      outcome.error = error
    }
    outcome.chatCalls = chatCalls
    outcome.refreshCalls = refreshCalls
    return outcome
  })()
}

describe('isTransientSignatureFailure（报文判据）', () => {
  it('认 APIG.0301 的「正文哈希对不上」那一支', () => {
    expect(isTransientSignatureFailure(401, SIGNATURE_MISMATCH_BODY)).toBe(true)
    expect(isTransientSignatureFailure(403, SIGNATURE_MISMATCH_BODY)).toBe(true)
  })

  it('大小写不敏感（上游措辞可能微调）', () => {
    expect(isTransientSignatureFailure(401, 'Body Hash Mismatch X-SDK-Content-Sha256')).toBe(true)
  })

  // ⚠️ 这条是判据的**收窄边**：放宽它会把真实 AK/SK 错误误判成瞬时故障。
  it('「verify ak sk signature fail」不得命中（它同时覆盖真实凭据错误）', () => {
    expect(isTransientSignatureFailure(401, VERIFY_SIGNATURE_BODY)).toBe(false)
  })

  it('真实凭据失效（APIG.0602）不得命中', () => {
    expect(isTransientSignatureFailure(401, INVALID_TOKEN_BODY)).toBe(false)
  })

  it('非 401/403 一律不命中', () => {
    for (const status of [200, 400, 402, 429, 500, 503]) {
      expect(isTransientSignatureFailure(status, SIGNATURE_MISMATCH_BODY)).toBe(false)
    }
  })

  it('空正文 / 非字符串不得抛错（保守判假）', () => {
    expect(isTransientSignatureFailure(401, '')).toBe(false)
    expect(isTransientSignatureFailure(401, undefined as unknown as string)).toBe(false)
    expect(isTransientSignatureFailure(401, null as unknown as string)).toBe(false)
  })
})

describe('签名故障的有界重发（行为腿）', () => {
  it('瞬时故障重发一次即自愈，且不消耗续期名额', async () => {
    const result = await runStream({ failures: 1 })
    expect(result.error).toBeUndefined()
    // 首次 401 → 重发 1 次 → 成功。
    expect(result.chatCalls).toBe(2)
    // ⚠️ 关键：不白刷凭据（刷了也修不好哈希不匹配）。
    expect(result.refreshCalls).toBe(0)
  })

  // ⚠️ 有界：不是无限重试。持续故障必须在有限次数后如实抛出。
  it('持续故障时重发次数有上限（不超过 3 次请求），最终仍抛 AUTH', async () => {
    const result = await runStream({ failures: Number.POSITIVE_INFINITY })
    expect(result.error).toBeInstanceOf(LlmError)
    expect((result.error as LlmError).code).toBe('AUTH')
    // 首次 + SIGNATURE_RETRY_MAX(2) 次重发 = 3。
    expect(result.chatCalls).toBe(3)
    expect(result.refreshCalls).toBe(0)
  })

  // ⚠️ 对照组：判据没放宽，真凭据问题**仍要**走续期兜底。
  it('对照组：真实凭据失效仍走 refresh（签名腿没有误伤真路径）', async () => {
    const result = await runStream({
      failures: Number.POSITIVE_INFINITY,
      failureBody: INVALID_TOKEN_BODY,
    })
    expect(result.error).toBeInstanceOf(LlmError)
    expect((result.error as LlmError).code).toBe('AUTH')
    expect(result.refreshCalls).toBe(1)
  })

  // ⚠️ I1 回归守卫：`delay()` 在 abort 时是**静默 resolve**，不判就直接
  // `continue` ⇒ 循环回到顶部再发一次完整请求（用户已按「停止」）。
  // 审计实测：基线 abort 后恒 2 次请求，加了重发后涨到 3 次。
  it('abort 后不再发请求（用户按「停止」后网关不得继续收到请求）', async () => {
    const controller = new AbortController()
    let chatCalls = 0
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => validCredential,
      refresh: async () => {},
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.includes('/queue/status')) {
          return new Response(JSON.stringify({ status: 'working' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        chatCalls += 1
        // 在首次 401 返回的同一拍里中止，模拟「用户看到失败立刻按停止」。
        controller.abort()
        return signatureResponse()
      },
    })

    try {
      const opts = {
        model: 'GLM-5.2',
        messages: [],
        signal: controller.signal,
      } as never
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of adapter.stream(opts)) { /* 读完即可 */ }
    } catch {
      // abort 后抛出属预期。
    }

    const callsAtAbort = chatCalls
    // 让退避窗口（500ms）过去，再断言请求数**没有增长**。
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(chatCalls).toBe(callsAtAbort)
    expect(callsAtAbort).toBe(1)
  })
})
