/**
 * OpenCode Zen 凭据结构、指纹派生与代理地址归一。
 *
 * ## 指纹依据（设计文档 §0 + 2026-10-15 真机 1.19.0 抓包复核）
 *
 * `session/llm/request.ts`（1.18.22）/ 等价注入点（1.19.0）对 opencode provider 发：
 * `x-opencode-project` / `x-opencode-session` / `x-opencode-session-id`（1.19.0 新增，
 * 值与 session 相同）/ `x-opencode-request` / `x-opencode-client` / `User-Agent`。
 *
 * ⚠️ 1.19.0 实测变更（MITM 抓包，2026-10-15）：
 * - `x-opencode-request` 是**消息 id 形状** `msg_` + 12 位 hex 时间戳 + 14 位 base62
 *   （1.18.22 时代注释猜的 `req_` + 32 hex 被证伪）。
 * - UA 是复合串 `opencode/<ver> ai-sdk/provider-utils/<x> runtime/bun/<y>`，不再裸版本。
 *
 * ⚠️ **不发** `x-session-affinity` / `X-Session-Id` —— 那是非 opencode provider 分支的头。
 *
 * ## 2026-10-15 鉴权门禁（本轮适配的根因）
 *
 * Zen 免费模型新增**传输指纹门禁**：免费模型 + `Bearer public`（或任意 key 走免费档）
 * 时，非官方 CLI 的 TLS/HTTP 栈（Node fetch、curl、python、甚至 npm 版 Bun 反代、
 * Bun 裸 TLS + 完全复刻的头序）一律 403 FreeTierError；官方 CLI 1.19.0 直连 200。
 * 付费模型路径无此门禁（假 key 能走到上游凭据校验拿 401 Invalid credential）。
 * ⇒ 匿名通道（`public`）从 DSH 直发已死，只能绑定付费 key 或走官方 CLI 跳板；
 *   头部形状修正是保真必需，但**救不回**匿名通道。
 *
 * ## 为什么 project id 用 40 hex
 *
 * 真实取值是 `sha1("git-remote:" + 归一化 remote URL)`
 * （`packages/core/src/project.ts` 的 `resolve()`），本机 opencode.db 实测
 * 形如 `895debfe16b1fcca5ebfa2e24b7b914797e632ec`。
 * opencode2dsh 用的是 `prj_<24hex>`（无依据的服务端形状猜测），我们跟真实 CLI 同形。
 *
 * ## session id 的形状不是随意选的
 *
 * Zen 的 FreeTier 门禁（2026-09-16 起）对 session id 做了正则校验：
 * `ses_` + 12 位小写 hex + 26 位 base62（opencode2dsh ids.ts 的
 * `CANONICAL_SESSION_PATTERN`，其「12 hex = 6 字节时间戳」与官方
 * `id/index.ts` 的 `timeBytes` 同构）。形状不对就是 403 FreeTierError。
 */

import { createHash, randomBytes } from 'node:crypto'
import { OPENCODE } from './opencode-product.js'

/** 一份可持久化的指纹。 */
export interface OpencodeFingerprint {
  /** 40 位小写 hex，与真实 CLI project id 同形。 */
  projectId: string
  /** 轮换代次；+1 后 project id 整体变化。 */
  generation: number
}

/** 账号凭据（存 `ctx.credentials`，不进 settings 明文）。 */
export interface OpencodeCredential {
  /** Zen API key（`sk-…`），身份本体；匿名槽用字面量 `public`。 */
  api_key: string
  nickname?: string
  /** 首次添加时生成；旧账号缺失时由 `newAccountFingerprint` 补。 */
  fingerprint?: OpencodeFingerprint
  /** 代理 URL；空/缺省 = 直连（与其它无代理账号共享本机出口）。 */
  proxy?: string
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * session id 尾段的**总长度**（12 位 hex 时间戳 + 随机段）。
 *
 * ⚠️ 取值 26 直接来自官方 `id/index.ts` 的 `const LENGTH = 26`；
 * 随机段长度 = `LENGTH - 12` = **14**。别把 26 当成随机段长度
 * （我第一版就是这么错的，代价是匿名通道全线 403）。
 */
const SESSION_TAIL_LENGTH = 26
/** 随机段长度（26 - 12 = 14）。 */
const SESSION_RANDOM_LENGTH = SESSION_TAIL_LENGTH - 12

/** 固定长度 base62 随机串（对齐官方 id 模块的 `randomBase62`）。 */
function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[bytes[i]! % BASE62.length]
  return out
}

/**
 * 派生 project id。
 *
 * @param identity  账号标识（接线层传 API key；匿名槽传固定串 `'anonymous'`）。
 * @param generation 轮换代次。
 *
 * 刻意**不**把 key 全文直接进哈希链的明文位置：identity 先过 SHA-256，
 * 再以 `git-remote:` 前缀走 SHA-1 —— 既复用真实 CLI 的派生外形，
 * 又使明文 key 片段不出现在任何可从 project id 反推的中间量。
 */
export function deriveProjectId(identity: string, generation: number): string {
  const inner = createHash('sha256').update(`${identity} ${generation}`).digest('hex')
  return createHash('sha1').update(`git-remote:opencode/${inner}`).digest('hex')
}

/**
 * 派生 session id：`ses_` + 12 位小写 hex（6 字节时间戳）+ **14** 位 base62。
 *
 * ## ⚠️⚠️ 尾段是 14 而不是 26（真实报障 2026-10-01）
 *
 * 官方 `id/index.ts` 里写的是 `const LENGTH = 26`，但那是**整段尾部长度**
 * （`randomBase62(LENGTH - 12)`），不是随机段长度。我第一版误读成「随机 26 位」，
 * 产出 `ses_` + 38 字符，形状不对 ⇒ 匿名通道一律 403 `FreeTierError`
 * （"free tier can only be used from within OpenCode"）。
 *
 * 证据（本机官方 CLI 1.18.22 真实 session id，日志实证）：
 *   ses_f078262d9ffeFwtz1QB7VnN4kM   ← 12 hex + 14 base62 = 26
 * 与 opencode2dsh 记录的门禁正则 `ses_[0-9a-f]{12}[0-9A-Za-z]{14}` 一致。
 *
 * ⚠️ **每次调用都是新值**：调用方负责在**一次 DSH 会话内**缓存复用
 * （见 `opencode-adapter.ts` 的 `sessionIds`）。每次都随机会让同一会话
 * 在服务端被看成多个独立会话，反而破坏亲和。
 */
export function deriveSessionId(): string {
  const time = Buffer.alloc(6)
  let now = BigInt(Date.now())
  for (let i = 0; i < 6; i++) {
    time[i] = Number(now & 0xffn)
    now >>= 8n
  }
  // ⚠️ 随机段固定 14 位（26 - 12）；写成 26 会让总长变成 38 而被门禁拒绝。
  return `ses_${time.toString('hex')}${randomBase62(SESSION_RANDOM_LENGTH)}`
}

/**
 * 派生 request id：`msg_` + 12 位小写 hex（6 字节时间戳）+ **14** 位 base62。
 *
 * ⚠️ 2026-10-15 真机 1.19.0 抓包实证（MITM，见 capture.log）：
 *   x-opencode-request: msg_13d406f1e001nIXjoKZX2ugXUi
 * 形状与官方消息 id 完全一致（`msg_` + 12hex + 14base62）。1.18.22 时代
 * 「`msg_` 前缀改 `req_`」的旧注释是错的——那是当时对服务端形状的猜测，被证伪。
 * 每次调用都是新值（一次 DSH 会话内的每个请求各带各的，与官方语义一致）。
 */
export function deriveRequestId(): string {
  return `msg_${timeHex12()}${randomBase62(SESSION_RANDOM_LENGTH)}`
}

/** 6 字节小端时间戳的 12 位 hex（与 session id 时间段同构）。 */
function timeHex12(): string {
  let now = BigInt(Date.now())
  const bytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number(now & 0xffn)
    now >>= 8n
  }
  return bytes.toString('hex')
}

/** UA：缺省用产品常量（`opencode/<version>`），接线层用真机安装版本覆盖。 */
export function opencodeUserAgent(override?: string): string {
  const value = override?.trim()
  return value !== undefined && value.length > 0 ? value : OPENCODE.defaultUserAgent
}

/** 构造发往 Zen 的完整指纹头集。 */
export function opencodeHeaders(
  fingerprint: OpencodeFingerprint,
  sessionId: string,
  requestId: string,
  userAgent: string,
): Record<string, string> {
  return {
    'x-opencode-project': fingerprint.projectId,
    'x-opencode-session': sessionId,
    // ⚠️ 1.19.0 新增，值与 `x-opencode-session` 相同（真机抓包实证）。
    'x-opencode-session-id': sessionId,
    'x-opencode-request': requestId,
    'x-opencode-client': 'cli',
    'user-agent': userAgent,
  }
}

export type OpencodeProxyKind = 'http' | 'socks5'

export interface NormalizedProxy {
  kind: OpencodeProxyKind
  /** 可直接交给 dispatcher 的完整 URL。 */
  url: string
  /** 展示用（脱敏，密码以 *** 代替）。 */
  label: string
}

/** 脱敏 URL 中的密码（面板与日志都只回显这个）。 */
function maskLabel(url: string): string {
  return url.replace(/^(\w+:\/\/[^:@/]+):[^@/]*@/, '$1:***@')
}

/**
 * 从**原始输入**里取权威段（scheme 之后、path 之前）。
 *
 * ⚠️ 端口校验必须走这里而不是 `new URL(...).port`：WHATWG URL 会把
 * **显式的默认端口抹掉**（`new URL('https://h:443').port === ''`），
 * 于是「用户确实填了 443」会被误判成「缺端口」而拒绝一个完全合法的地址。
 */
function authorityOf(raw: string): string {
  const afterScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const cut = afterScheme.search(/[/?#]/)
  return cut === -1 ? afterScheme : afterScheme.slice(0, cut)
}

/** 权威段里是否带了显式端口（已剥掉 `user:pass@` 前缀）。 */
function hasExplicitPort(authority: string): boolean {
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  return /:\d+$/.test(hostPart)
}

/**
 * 归一用户输入的代理地址。
 *
 * 接受三类（设计文档 §3）：本地代理客户端端口（裸 `host:port`）、HTTP(S)、SOCKS5。
 * 空串表示「清除代理」，返回 `ok: false` 让调用方走清理分支。
 */
export function normalizeProxy(input: string): { ok: true; proxy: NormalizedProxy } | { ok: false; reason: string } {
  const raw = input.trim()
  if (raw.length === 0) return { ok: false, reason: '代理地址为空（如需清除，请点「清除代理」）' }

  // 裸 host:port 补 http://（本地代理客户端端口最常见的填法）
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
  // socks5h:// 是 socks5 的「由代理解析 DNS」变体，undici 侧行为一致，归一为 socks5://
  const url = withScheme.replace(/^socks5h:\/\//, 'socks5://')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: '无法解析为 URL（形如 http://host:port）' }
  }

  const kind: OpencodeProxyKind | undefined =
    parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? 'http'
      : parsed.protocol === 'socks5:'
        ? 'socks5'
        : undefined
  if (kind === undefined) {
    return { ok: false, reason: `不支持的协议 ${parsed.protocol.replace(':', '')}（仅支持 http/https/socks5）` }
  }
  if (parsed.hostname.length === 0) return { ok: false, reason: '缺少主机名' }
  // ⚠️ 端口存在性从**原始串**的权威段判（见 `hasExplicitPort` 的注释），
  // 不用 `parsed.port` —— 后者会把用户显式写的 443/80 抹成空串。
  if (!hasExplicitPort(authorityOf(raw))) return { ok: false, reason: '缺少端口（如 http://127.0.0.1:7897）' }

  // ⚠️ 手工拼接而非直接用 `parsed.toString()`：后者会规范化默认端口、
  // 补尾斜杠，产生与用户输入不一致的 URL。这里只取已确认存在的 host:port。
  const scheme = kind === 'socks5' ? 'socks5' : parsed.protocol.replace(':', '')
  const auth = parsed.username.length > 0
    ? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ''}@`
    : ''
  // ⚠️ 端口用权威段里解析出来的**原始数字**（`parsed.port` 可能是空串）。
  const rawHostPort = authorityOf(raw)
  const hostOnly = auth.length > 0 ? rawHostPort.slice(rawHostPort.lastIndexOf('@') + 1) : rawHostPort
  const portMatch = /:(\d+)$/.exec(hostOnly)
  const port = portMatch?.[1] ?? parsed.port
  const normalized = `${scheme}://${auth}${parsed.hostname}:${port}`
  return { ok: true, proxy: { kind, url: normalized, label: maskLabel(normalized) } }
}
