import { createDsmlMarkerNormalizer } from './sse.js'
/**
 * 腾讯 OrcaTerm（遨驰终端）LLM adapter。
 *
 * 把腾讯云 ligai 网关的 ACP 协议（`/assistant/chat`）投影成 harness 的 provider 合约。
 * 与仓库里其余 adapter 的差异集中在三处，全部由 {@link ORCATerm} 的字段驱动：
 *
 * 1. **凭据不是 bearer token**，而是腾讯云网页登录态 cookie（`uin`/`skey`）或桌面
 *    `ot_session` JWT。两者请求头不同：网页形态**只带 Cookie**，补一个
 *    `Authorization: Bearer` 会被上游按 ot_session 校验并返回 `code=10050000`；
 *    桌面形态则必须同时带 Bearer 与 Cookie。{@link authHeaders} 是唯一的裁决点。
 * 2. **请求体是 ACP 信封**：`input.input` 是 `{"_format":"acp-prompt",…}` 的**字符串**，
 *    不是 `messages` 数组；模型 id 必须上游全名，短名会被静默吞掉。
 * 3. **流式不是纯文本增量**：上游 SSE 的 `content` 字段拼起来是整个响应信封
 *    JSON（`{action,thinking,taskCompletion}`），答案文本本身以 JSON 转义形态分帧到达。
 *    {@link OrcaTermEnvelopeParser} 负责在任意帧切点上增量解码。
 *
 * @module orcaterm-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { ORCATerm, ORCATerm_FALLBACK_MODELS, isKnownOrcaTermModel } from './orcaterm-product.js'
import { prepareOrcaTermInput, resolveOrcaTermTools, OrcaTermToolTextGate } from './orcaterm-harness.js'

// ───────────────────────────────────────────────────────────── 凭据

/** 从账号池取到的一件凭据。两种形态互斥，由 `kind` 区分。 */
export type OrcaTermCredential =
  | { kind: 'web'; uin: string; skey: string; userId: string }
  | { kind: 'desktop'; otSession: string }

/** 网页 cookie 串形态（`uin=…; skey=…; userId=…`）。 */
export function webCookieString(credential: Extract<OrcaTermCredential, { kind: 'web' }>): string {
  const parts = [
    `uin=${credential.uin}`,
    `skey=${credential.skey}`,
    'userAccountType=txcloud',
    'userAccountLoginMethod=console',
  ]
  if (credential.userId) parts.push(`userId=${credential.userId}`)
  return parts.join('; ')
}

/**
 * 请求头裁决点。
 *
 * ⚠️ 网页形态**刻意不加** `Authorization`：实测给它补 Bearer 会让上游按
 * ot_session 校验并失败（`code=10050000 Invalid or expired AccessToken`），
 * 而只带 Cookie 时 HTTP 200 正常出字。
 */
export function authHeaders(credential: OrcaTermCredential): Record<string, string> {
  if (credential.kind === 'desktop') {
    return {
      Authorization: `Bearer ${credential.otSession}`,
      Cookie: `ot_session=${credential.otSession}; userAccountLoginMethod=oauth; userAccountType=wechat`
        + (userIdFromJwt(credential.otSession) ? `; userId=${userIdFromJwt(credential.otSession)}` : ''),
    }
  }
  return { Cookie: webCookieString(credential) }
}

/** 从 ot_session JWT 的 payload 取 userId（不验签）。 */
export function userIdFromJwt(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return payload.userId !== undefined && payload.userId !== null ? String(payload.userId) : ''
  } catch {
    return ''
  }
}

/** 账号 userId：网页形态用 cookie 里的 userId，回退 uin 去 `o` 前缀。 */
export function credentialUserId(credential: OrcaTermCredential): string {
  if (credential.kind === 'desktop') return userIdFromJwt(credential.otSession)
  return credential.userId || credential.uin.replace(/^o/, '')
}

// ───────────────────────────────────────────────────────────── 请求体

/** ACP 信封字符串（放进 `input.input`）。 */
export function acpPrompt(text: string): string {
  return JSON.stringify({ _format: 'acp-prompt', version: 1, prompt: [{ type: 'text', text }] })
}

/** 上游请求体。 */
export function buildRequestBody(
  credential: OrcaTermCredential,
  text: string,
  model: string,
  stream: boolean,
  emphasisPrompt = '',
): Record<string, unknown> {
  const empty: never[] = []
  return {
    conversationId: `cid-${crypto.randomUUID()}-${ORCATerm.product}`,
    user: {
      id: credentialUserId(credential),
      setting: {
        mcpServers: empty, uiServers: empty, tools: empty, approvedTools: empty,
        approvedMCPTools: empty, enableAutoSubtaskExecution: false, env: empty,
        // ⚠️ 必须全名：短名（如 `hy3`）会被上游静默接受但返回空结果。
        model, modelDesc: {},
        hideToolMessage: true, isNormalToolMessageIgnored: true, shouldHideDirectOutputToolReview: true,
      },
    },
    input: { type: 'start', input: acpPrompt(text), id: crypto.randomUUID(), emphasisPrompt, files: empty },
    stream,
  }
}

/**
 * 把 harness 消息折叠成本次输入文本。
 *
 * 单条用户消息原样发送；多条压成 `【角色】正文` 转写，保证上下文不丢。
 */
export function composeInputText(options: GenerateOptions): string {
  return prepareOrcaTermInput(options).text
}

// ───────────────────────────────────────────────────────────── 响应

/** 上游响应信封的解析结果。 */
export interface OrcaTermResult {
  action: string
  text: string
  thinking: string
  tool?: { name?: unknown; args?: unknown }
  truncated?: boolean
}

/** 上游错误，`code` 供 harness 的重试策略判定。 */
export class OrcaTermError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'OrcaTermError'
    this.code = code
  }
}

/** 鉴权失效判定：上游 HTTP 200 但信封 code 非 0，或裸 HTTP 500 NEED_UIN_AND_SKEY。 */
export function isAuthFailure(code: number, message: string): boolean {
  const lower = String(message ?? '').toLowerCase()
  return code === 10050000
    || lower.includes('invalid or expired accesstoken')
    || lower.includes('need_uin_and_skey')
}

/** 从信封 data 取结果。 */
export function readEnvelope(data: Record<string, unknown>): OrcaTermResult {
  const action = typeof data.action === 'string' ? data.action : ''
  const thinking = typeof data.thinking === 'string' ? data.thinking : ''
  if (action === 'completion') {
    return { action, text: String(data.taskCompletion ?? ''), thinking }
  }
  if (action === 'ask') {
    return { action, text: String(data.question ?? ''), thinking }
  }
  if (action === 'review') {
    const tool = (data.tool ?? {}) as Record<string, unknown>
    return { action, text: '', thinking, tool: { name: tool.name, args: tool.args } }
  }
  throw new OrcaTermError(`未知 action=${action}（多为 model 全名不正确）`, 'SERVER')
}

// ───────────────────────────────────────────────────────────── 流式解码

/**
 * 上游 SSE 信封的增量解码器。
 *
 * 上游 `stream:true` 时推 `data: {"content":"…"}`，`content` 拼起来是**整个**响应信封
 * JSON 的原文（含 JSON 转义）。本类边收边解出目标字段（`taskCompletion` / `question`）
 * 的明文增量，并在任意帧切点保持正确：
 *
 * - 转义符被帧边界切断（`\` 结尾）→ 等下一帧；
 * - `\uXXXX` 只收到一半 → 等下一帧；
 * - 结构键还没到齐 → 保持 `fieldStart = -1`，下一帧重试。
 *
 * ⚠️ 用「解出全 ASCII」当凭据正确性的判据，错误的 key 不会产出可打印明文。
 */
export class OrcaTermEnvelopeParser {
  constructor(private readonly allowMixedReview = false) {}
  private accum = ''
  private action: string | null = null
  private actionEnd = -1
  private fieldStart = -1
  private out = ''
  private closed = false
  private thinkingOut = ''
  private plain = false

  get currentAction(): string | null { return this.action }
  get text(): string { return this.out }
  get thinking(): string { return this.thinkingOut }

  /** 喂入一个 content 增量，返回新解出的明文增量（可能为空串）。 */
  feed(delta: string): string {
    if (!delta) return ''
    this.accum += delta
    const prefix = this.accum.trimStart()
    if (prefix.startsWith('```') && prefix.length > 7 && !prefix.startsWith('```json') && !/^```\s*\{/.test(prefix)) this.plain = true
    const firstKey = /^\{\s*"([^"]+)"\s*:/.exec(prefix)?.[1]
    if (firstKey && !['action', 'thinking', 'taskCompletion', 'question', 'tool'].includes(firstKey)) this.plain = true
    if (!this.plain && prefix && !prefix.startsWith('{') && !prefix.startsWith('```')
      && !'```'.startsWith(prefix)) this.plain = true
    if (this.plain) {
      let upto = this.accum.length
      if (this.allowMixedReview) {
        const mark = /```(?:json)?\s*\{|\{\s*"dsh_tool_calls"\s*:/i.exec(this.accum)
        const example = mark && /示例|例子|演示|格式|example|sample|do not execute|不要执行/i.test(this.accum.slice(0, mark.index))
        upto = mark && !example ? mark.index : Math.max(0, this.accum.length - 24)
      }
      const fresh = this.accum.slice(this.out.length, upto)
      this.out += fresh
      return fresh
    }
    this.detectAction()
    if (this.action !== null) {
      const key = this.accum.indexOf('"thinking"')
      if (key >= 0) {
        const start = valueStartAfterKey(this.accum, key + 10)
        if (start !== null) this.thinkingOut = decodeJsonString(this.accum, start).decoded
      }
    }
    this.ensureField()
    if (this.fieldStart < 0 || this.closed) return ''
    const { decoded, end } = decodeJsonString(this.accum, this.fieldStart)
    if (end >= 0) this.closed = true
    if (decoded.length <= this.out.length) return ''
    const fresh = decoded.slice(this.out.length)
    this.out += fresh
    return fresh
  }

  /** 信封原文（收尾整包解析用）。 */
  rawEnvelope(): string { return this.accum.trim() }

  /** 服务端可能在 review 后继续追加另一个动作；只取完整的第一个动作对象。 */
  firstResult(): OrcaTermResult | undefined {
    let raw = this.rawEnvelope().replace(/^```(?:json)?\s*/i, '')
    let preface = ''
    if (!raw.startsWith('{') && this.allowMixedReview) {
      const mark = /```(?:json)?\s*(?=\{)|(?=\{\s*"dsh_tool_calls"\s*:)/i.exec(raw)
      if (!mark || /示例|例子|演示|格式|example|sample|do not execute|不要执行/i.test(raw.slice(0, mark.index))) return undefined
      preface = raw.slice(0, mark.index)
      raw = raw.slice(mark.index + mark[0].length)
    }
    if (!raw.startsWith('{')) return undefined
    let depth = 0, quoted = false, escaped = false
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          const data = JSON.parse(raw.slice(0, index + 1)) as Record<string, unknown>
          if (this.allowMixedReview && Array.isArray(data.dsh_tool_calls) && Object.keys(data).length === 1) return { action: 'completion', text: raw.slice(0, index + 1), thinking: '' }
          if (preface && data.action !== 'review') return undefined
          if (['completion', 'ask', 'review'].includes(String(data.action))) {
            const result = readEnvelope(data)
            if (preface) result.text = preface
            return result
          }
        } catch { /* 不完整或非法参数不执行 */ }
        return undefined
      }
    }
    return undefined
  }

  /** 完整响应优先解析动作对象；正常 JSON/代码/纯文本答案保持原样。 */
  result(truncated = false): OrcaTermResult {
    const first = this.firstResult()
    if (first) return { ...first, truncated }
    const raw = this.rawEnvelope().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
    try {
      const object = JSON.parse(raw) as Record<string, unknown>
      if (object && ['completion', 'ask', 'review'].includes(String(object.action))) {
        return { ...readEnvelope(object), truncated }
      }
    } catch {
      if (this.action !== null) {
        if (truncated && this.action !== 'review' && this.out) {
          return { action: this.action, text: this.out, thinking: this.thinkingOut, truncated: true }
        }
        throw new OrcaTermError('上游动作信封不完整，未执行工具', 'SERVER')
      }
    }
    return { action: 'completion', text: this.accum, thinking: '', truncated }
  }

  private detectAction(): void {
    if (this.action !== null) return
    const key = this.accum.indexOf('"action"')
    if (key < 0) return
    // `"action"` 长 8：key + 8 是闭引号之后，valueStartAfterKey 从冒号开始扫。
    const valueStart = valueStartAfterKey(this.accum, key + 8)
    if (valueStart === null) return
    const { decoded, end } = decodeJsonString(this.accum, valueStart)
    if (end < 0) return
    this.action = decoded
    this.actionEnd = end
  }

  private ensureField(): void {
    if (this.fieldStart >= 0 || this.action === null) return
    const field = this.action === 'completion' ? 'taskCompletion'
      : this.action === 'ask' ? 'question' : null
    if (!field) return
    const from = this.actionEnd > 0 ? this.actionEnd : 0
    const key = this.accum.indexOf(`"${field}"`, from)
    if (key < 0) return
    const valueStart = valueStartAfterKey(this.accum, key + field.length + 2)
    if (valueStart === null) return // 结构未到齐，下一帧重试
    this.fieldStart = valueStart
  }
}

/** 跳过键名后的空白与冒号，返回值的开引号后一位；结构未到齐返回 null。 */
function valueStartAfterKey(source: string, from: number): number | null {
  let index = from
  while (index < source.length && /\s/.test(source[index]!)) index++
  if (index >= source.length || source[index] !== ':') return null
  index++
  while (index < source.length && /\s/.test(source[index]!)) index++
  if (index >= source.length || source[index] !== '"') return null
  return index + 1
}

/** 从 `start`（开引号后一位）解码 JSON 字符串；未收完返回 `end = -1`。 */
function decodeJsonString(source: string, start: number): { decoded: string; end: number } {
  let out = ''
  let index = start
  while (index < source.length) {
    const char = source[index]!
    if (char === '"') return { decoded: out, end: index + 1 }
    if (char === '\\') {
      if (index + 1 >= source.length) break
      const escape = source[index + 1]!
      if (escape === 'n') { out += '\n'; index += 2 }
      else if (escape === 't') { out += '\t'; index += 2 }
      else if (escape === 'r') { out += '\r'; index += 2 }
      else if (escape === 'u') {
        if (index + 5 >= source.length) break
        const cp = Number.parseInt(source.slice(index + 2, index + 6), 16)
        out += Number.isNaN(cp) ? source.slice(index + 2, index + 6) : String.fromCharCode(cp)
        index += 6
      } else { out += escape; index += 2 }
    } else { out += char; index += 1 }
  }
  return { decoded: out, end: -1 }
}

// ───────────────────────────────────────────────────────────── transport

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OrcaTerm/1.0.0 Chrome/120.0.0.0 Safari/537.36'
const ORIGIN = 'http://tauri.localhost'

/** 发一次请求，返回原始 Response（流式与非流式共用）。 */
async function post(
  credential: OrcaTermCredential,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(ORCATerm.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      'X-Product': ORCATerm.product,
      'X-Seq-Id': crypto.randomUUID(),
      'X-Csrfcode': '',
      'X-Referer': `${ORIGIN}/`,
      Origin: ORIGIN,
      'User-Agent': USER_AGENT,
      ...authHeaders(credential),
    },
    body: JSON.stringify(body),
    signal,
  })
}

/** 非流式一轮。 */
export async function completeOnce(
  credential: OrcaTermCredential,
  text: string,
  model: string,
  signal?: AbortSignal,
): Promise<OrcaTermResult> {
  const response = await post(credential, buildRequestBody(credential, text, model, false), signal)
  const raw = await response.text()
  if (!response.ok) {
    throw new OrcaTermError(
      `上游 HTTP ${response.status}：${raw.slice(0, 300)}`,
      isAuthFailure(response.status, raw) ? 'AUTH' : 'SERVER',
    )
  }
  let root: Record<string, unknown>
  try { root = JSON.parse(raw) as Record<string, unknown> } catch {
    throw new OrcaTermError(`上游响应不是 JSON：${raw.slice(0, 200)}`, 'SERVER')
  }
  const code = Number(root.code ?? 0)
  if (code !== 0) {
    const message = String(root.message ?? '')
    throw new OrcaTermError(
      isAuthFailure(code, message)
        ? `OrcaTerm 登录态失效（code=${code}）：请在 Jet Hub 面板重新登录`
        : `上游返回 code=${code}：${message.slice(0, 200)}`,
      isAuthFailure(code, message) ? 'AUTH' : 'SERVER',
    )
  }
  return readEnvelope((root.data ?? {}) as Record<string, unknown>)
}

/** 流式一轮；`onDelta` 收到明文增量。 */
export async function completeStreamed(
  credential: OrcaTermCredential,
  text: string,
  model: string,
  signal: AbortSignal | undefined,
  onDelta: (delta: string) => void,
  channel: { emphasisPrompt?: string; onThinking?: (delta: string) => void; tools?: readonly ToolSchema[]; discoveredTools?: ReadonlySet<string> } = {},
): Promise<OrcaTermResult> {
  const response = await post(credential, buildRequestBody(credential, text, model, true, channel.emphasisPrompt), signal)
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new OrcaTermError(`上游 HTTP ${response.status}：${raw.slice(0, 300)}`,
      isAuthFailure(response.status, raw) ? 'AUTH' : 'SERVER')
  }
  const checkCode = (root: Record<string, unknown>): void => {
    const code = Number(root.code ?? 0)
    if (code !== 0) {
      const message = String(root.message ?? '')
      throw new OrcaTermError(isAuthFailure(code, message)
        ? `OrcaTerm 登录态失效（code=${code}）` : `上游返回 code=${code}：${message.slice(0, 200)}`,
      isAuthFailure(code, message) ? 'AUTH' : 'SERVER')
    }
  }
  if (!(response.headers.get('content-type') ?? '').includes('event-stream')) {
    const raw = await response.text()
    let root: Record<string, unknown>
    try { root = JSON.parse(raw) as Record<string, unknown> } catch {
      throw new OrcaTermError('上游响应不是 JSON', 'SERVER')
    }
    checkCode(root)
    const result = readEnvelope((root.data ?? root) as Record<string, unknown>)
    if (result.thinking) channel.onThinking?.(result.thinking)
    if (result.text) onDelta(result.text)
    return result
  }
  if (!response.body) throw new OrcaTermError('上游流式响应无 body', 'SERVER')
  const parser = new OrcaTermEnvelopeParser(Boolean(channel.tools?.length))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', data: string[] = [], sawDone = false, emitted = '', thinking = '', envelopeThinking = ''
  let hostResult: OrcaTermResult | undefined
  const dispatch = (): void => {
    if (!data.length) return
    const payload = data.join('\n')
    data = []
    if (payload === '[DONE]') { sawDone = true; return }
    let frame: Record<string, unknown>
    try { frame = JSON.parse(payload) as Record<string, unknown> } catch {
      throw new OrcaTermError('上游 SSE 数据帧不是完整 JSON', 'SERVER')
    }
    checkCode(frame)
    if (typeof frame.reasoningContent === 'string' && frame.reasoningContent) {
      thinking += frame.reasoningContent
      channel.onThinking?.(frame.reasoningContent)
    }
    if (typeof frame.content === 'string' && frame.content) {
      const fresh = parser.feed(frame.content)
      // 上游若已经用 reasoningContent 下发思考，不再从信封重复交付。
      if (!thinking && parser.thinking.length > envelopeThinking.length) {
        channel.onThinking?.(parser.thinking.slice(envelopeThinking.length))
        envelopeThinking = parser.thinking
      }
      if (fresh) { emitted += fresh; onDelta(fresh) }
      const candidate = parser.firstResult()
      // 只有参数完整且名称属于本轮 DSH 工具的调用才能提前交付。
      // 宿主自行执行，不让上游因没有相同工具而追加的兜底回复覆盖它。
      if (candidate && channel.tools?.length && (candidate.action === 'review' || candidate.text.trimStart().startsWith('{"dsh_tool_calls"'))) {
        // 完整请求先交给适配器校验；未提供的工具只作为失败回执续接，不执行。
        hostResult = candidate
      }
    }
  }
  const line = (raw: string): void => {
    if (!raw.trim()) { dispatch(); return }
    if (raw.startsWith('data:')) data.push(raw.slice(5).replace(/^ /, ''))
  }
  try {
    while (!sawDone && !hostResult) {
      const row = await reader.read()
      if (row.done) break
      buffer += decoder.decode(row.value, { stream: true })
      let split: number
      while ((split = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, split).replace(/\r$/, ''))
        buffer = buffer.slice(split + 1)
        if (sawDone || hostResult) break
      }
    }
    buffer += decoder.decode()
    if (!sawDone && !hostResult) { if (buffer) line(buffer.replace(/\r$/, '')); dispatch() }
    if (!parser.rawEnvelope()) throw new OrcaTermError('上游返回空流，请检查登录态和模型可用性', 'EMPTY_RESPONSE')
    const result = hostResult ?? parser.result(!sawDone)
    result.thinking = thinking || result.thinking
    if (result.thinking && !thinking && result.thinking.startsWith(envelopeThinking)) {
      const rest = result.thinking.slice(envelopeThinking.length)
      if (rest) channel.onThinking?.(rest)
    }
    if (result.text.startsWith(emitted)) {
      const tail = result.text.slice(emitted.length)
      if (tail) onDelta(tail)
    } else if (!emitted && result.text) onDelta(result.text)
    return result
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// ───────────────────────────────────────────────────────────── adapter

type StreamEvent = StreamChunk

/** OrcaTerm provider adapter。 */
export class OrcaTermAdapter {
  constructor(private readonly deps: {
    /** 取该 provider 的可用账号（账号池 + 凭据解析）。 */
    resolveCredential: (modelId: string) => Promise<OrcaTermCredential | undefined>
    /** 记录一次用量（失败也要记），供面板展示。 */
    providerClosed?: () => boolean
    recordUsage?: (record: { at: number; model: string; ok: boolean; input: number; output: number }) => void
    /** 最近一次失败原因，面板展示。 */
    warn?: (message: string) => void
  }) {}

  imageRequestPricing(): undefined { return undefined }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: ORCATerm.displayName }
  }

  /** 上游只有 500/网络类错误值得重试；AUTH 要用户重新登录。 */
  providerRetryPolicy(): Record<string, unknown> {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * 全量目录（**同步**，不套失效黑名单）。
   *
   * ⚠️ 契约要求同步：`modelAdapters` 表的类型是
   * `{ listAllModels(): readonly {id,name}[] }`，Jet Hub RPC 在「关闭整个
   * provider」时用它的长度当分母算 `closed = total>0 && disabled===total`。
   * 返回 Promise 会让该判据恒假 ⇒ provider 显示已关闭但模型仍可选。
   *
   * 目录是静态表（上游不接受动态列举，只有全名有效），故无需 async。
   */
  listAllModels(): ReadonlyArray<{ id: string; name: string }> {
    return ORCATerm_FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name }))
  }

  async listModels(provider: string): Promise<Array<Record<string, unknown>>> {
    if (this.deps.providerClosed?.()) return []
    return ORCATerm_FALLBACK_MODELS.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      description: '腾讯 OrcaTerm 内置 AI（跟随腾讯云登录态）',
      inputModalities: ['text'],
      context: { contextWindow: 131072 },
      defaultMaxTokens: 8192,
    }))
  }

  async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
    const known = ORCATerm_FALLBACK_MODELS.find((candidate) => candidate.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      inputModalities: ['text'],
      ...(known ? { context: { contextWindow: 131072 } } : {}),
      defaultMaxTokens: 8192,
    }
  }

  async prepareCall(provider: string, model: string): Promise<Record<string, unknown>> {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 包装成可中止的 async iterator（与其余 adapter 同款）。 */
  stream(options: GenerateOptions): AsyncIterableIterator<StreamEvent> & { [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> } {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal })
    const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method: 'next' | 'return' | 'throw', value?: unknown): Promise<IteratorResult<StreamEvent>> => {
      try {
        const row = await iterator[method](value as never)
        if (row.done) cleanup()
        return row
      } catch (error) { cleanup(); throw error }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => step('next'),
      return: (value?: unknown) => { controller.abort(); cleanup(); return step('return', value) },
      throw: (error?: unknown) => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  private async * runStream(options: GenerateOptions, correctionAttempt = 0): AsyncGenerator<StreamEvent> {
    const startedAt = Date.now()
    const model = options.model
    if (!isKnownOrcaTermModel(model)) {
      this.deps.warn?.(`[orcaterm] model "${model}" 不是上游全名，上游会返回空结果`)
    }

    let credential: OrcaTermCredential | undefined
    try {
      credential = await this.deps.resolveCredential(model)
    } catch (error) {
      this.deps.warn?.(`[orcaterm] 解析凭据失败：${(error as Error).message}`)
      credential = undefined
    }
    if (credential === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'OrcaTerm 未登录：请在 Jet Hub 面板点「登录」用微信扫码，'
              + '或把 uin/skey 写入 ~/.dsh/orcaterm_token.txt',
            code: 'AUTH',
          },
        },
      }
      return
    }

    let prepared: ReturnType<typeof prepareOrcaTermInput>
    try { prepared = prepareOrcaTermInput(options) } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error), code: 'INVALID_REQUEST' } } }
      return
    }
    const text = prepared.text
    if (!text) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '用户输入为空', code: 'EMPTY_INPUT' } } }
      return
    }
    const dsmlFix = createDsmlMarkerNormalizer()
    const gate = new OrcaTermToolTextGate(prepared.tools.length > 0)
    const pending: StreamEvent[] = []
    let notify: (() => void) | null = null
    let finished = false
    let failure: Error | null = null
    let outputText = '', reasoning = ''
    const push = (event: StreamEvent): void => { pending.push(event); notify?.(); notify = null }
    const completion = completeStreamed(credential, text, model, options.signal, (delta) => {
      const safe = dsmlFix.push(gate.feed(delta))
      if (safe) { outputText += safe; push({ type: 'text-delta', index: 0, text: safe }) }
    }, {
      emphasisPrompt: prepared.emphasis,
      tools: prepared.tools,
      discoveredTools: prepared.discoveredTools,
      onThinking: (delta) => { reasoning += delta; push({ type: 'reasoning-delta', index: 1, text: delta }) },
    })
    completion.then(
      () => { finished = true; notify?.(); notify = null },
      (error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); finished = true; notify?.(); notify = null },
    )
    while (!finished || pending.length) {
      if (pending.length) { yield pending.shift()!; continue }
      await new Promise<void>(resolve => { notify = resolve })
    }
    const inputTokens = Math.ceil((text.length + prepared.emphasis.length) / 4)
    if (failure) {
      const error = failure as Error & { code?: string }
      this.deps.recordUsage?.({ at: startedAt, model, ok: false, input: inputTokens, output: Math.ceil(outputText.length / 4) })
      if (error.message === '上游动作信封不完整，未执行工具' && prepared.tools.length && correctionAttempt < 2 && !options.signal?.aborted) {
        this.deps.warn?.('[orcaterm] 不完整的动作未执行，请上游重新生成完整宿主工具指令')
        yield* this.runStream({
          ...options,
          system: (options.system ?? '') + '\n上一份动作 JSON 不完整，任何工具都没有执行。请从最后一份真实宿主回执继续，重新输出一个完整 JSON 动作对象；不要重复已执行的工具，不要只描述下一步。',
        }, correctionAttempt + 1)
        return
      }
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { message: error.message, code: error.code ?? 'SERVER' } } }
      return
    }
    const result = await completion
    let calls: ReturnType<typeof resolveOrcaTermTools>
    try { calls = result.truncated ? [] : resolveOrcaTermTools(result, prepared.tools, prepared.discoveredTools) } catch (error) {
      if (result.action === 'review' && correctionAttempt < 2 && !options.signal?.aborted) {
        this.deps.warn?.(`[orcaterm] 未提供的工具请求未执行，返回失败回执进行一次纠正：${String(error)}`)
        const id = `orca_rejected_${crypto.randomUUID()}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
        const name = String(result.tool?.name ?? '')
        const args = typeof result.tool?.args === 'string' ? result.tool.args : JSON.stringify(result.tool?.args ?? {})
        const rejection = [
          { role: 'assistant', id: crypto.randomUUID(), source: { kind: 'model', provider: options.provider, model }, content: [{ type: 'tool-call', id, name, arguments: args }] },
          { role: 'tool', id: crypto.randomUUID(), source: { kind: 'tool', callId: id }, toolCallId: id, isError: true, content: [{ type: 'text', text: `工具未执行：${String(error)}。这不是可用的宿主工具。请使用本轮 tools 中列出的精确名称与参数，不能调用腾讯内部技能或云端工具。` }] },
        ] as unknown as GenerateOptions['messages']
        const corrected: GenerateOptions = { ...options, messages: [...options.messages, ...rejection] }
        yield* this.runStream(corrected, correctionAttempt + 1)
        return
      }
      this.deps.recordUsage?.({ at: startedAt, model, ok: false, input: inputTokens, output: Math.ceil(result.text.length / 4) })
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error), code: 'INVALID_TOOL_CALL' } } }
      return
    }
    const tail = dsmlFix.push(gate.finish(calls.length > 0 || result.truncated === true)) + dsmlFix.flush()
    if (tail) { outputText += tail; yield { type: 'text-delta', index: 0, text: tail } }
    if (outputText) yield { type: 'block-end', index: 0, block: { type: 'text', text: outputText } }
    if (reasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
    for (const [ordinal, call] of calls.entries()) {
      const index = ordinal + 2, id = `orca_${crypto.randomUUID()}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
    }
    const outputTokens = Math.ceil((result.text.length + calls.map(call => call.arguments).join('').length) / 4)
    this.deps.recordUsage?.({ at: startedAt, model, ok: true, input: inputTokens, output: outputTokens })
    yield { type: 'usage', usage: { inputTokens, outputTokens, reasoningTokens: Math.ceil(reasoning.length / 4), cacheReadTokens: 0 } }
    yield { type: 'finish', reason: { kind: result.truncated ? 'max-tokens' : calls.length ? 'tool-calls' : 'stop' } }
    this.deps.warn?.(`[orcaterm] ${result.action} ${model} in ${Date.now() - startedAt}ms (${result.text.length} chars)`)
  }
}

/**
 * 注册 OrcaTerm 适配器。
 *
 * @param ctx cordis 上下文
 * @param options 账号池接线：凭据解析、用量记账、告警
 * @returns adapter 实例（供 index.ts 记录与 `pruned()` 查询）
 */
export function registerOrcaTermLlm(
  ctx: Context,
  options: {
    resolveCredential: (modelId: string) => Promise<OrcaTermCredential | undefined>
    providerClosed?: () => boolean
    recordUsage?: (record: { at: number; model: string; ok: boolean; input: number; output: number }) => void
    warn?: (message: string) => void
  },
): OrcaTermAdapter {
  const adapter = new OrcaTermAdapter({
    resolveCredential: options.resolveCredential,
    providerClosed: options.providerClosed,
    recordUsage: options.recordUsage,
    warn: options.warn ?? ((message: string) => ctx.logger?.warn?.(message)),
  })
  registerAdapterIdempotent(ctx.llm, [ORCATerm.id], adapter as never)
  return adapter
}
