import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ZcodeCredential } from './zcode.js'
import { serializeMessages, consumeOpenAiSse } from './openai-compat.js'
import { accountQuotaError } from './account-failover.js'
/** 默认机构资源包/余额必须走通用OpenAI端点，避免错误消耗编程套餐。 */
export async function* streamZcodeOrganization(options: GenerateOptions, credential: ZcodeCredential, images: Map<string, string>, fetchImpl: typeof fetch): AsyncIterable<StreamChunk> {
  const source = credential.source_selection!
  const messages = serializeMessages(options.messages, images)
  const body = { model: options.model.trim().toLowerCase(), stream: true, messages: [...(options.system ? [{ role: 'system', content: options.system }] : []), ...messages],
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.tools?.length ? { tools: options.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}) }
  const response = await fetchImpl(source.url, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${source.key}`, 'Content-Type': 'application/json', 'bigmodel-organization': source.organizationId!, 'bigmodel-project': source.projectId! }, signal: options.signal, redirect: 'error' })
  if (!response.ok) {
    const text = (await response.text()).slice(0, 8192)
    let error: any
    try { const value = JSON.parse(text); error = value.error ?? value } catch { /* 保留可分类关键词。 */ }
    const code = ![401, 403].includes(response.status) && (response.status === 402 || accountQuotaError(error ?? { message: text })) ? 'QUOTA_EXCEEDED' : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`
    throw new LlmError(`ZCode 机构流量请求失败（HTTP ${response.status}）`, code)
  }
  yield* consumeOpenAiSse(response, { signal: options.signal }, { label: 'zcode', firstTokenTimeoutMs: 120_000, chunkTimeoutMs: 120_000 })
}
