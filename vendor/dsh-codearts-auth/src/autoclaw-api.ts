/** 智谱 AutoClaw 2.0.4 官方客户端协议；与 ZCode 账号、额度隔离。 */
import { createHash } from 'node:crypto'

export const AUTOCLAW = { id: 'autoclaw', displayName: 'AutoClaw (智谱)', origin: 'https://autoglm-acceleration-api.zhipuai.cn' } as const
// 官方客户端内的公共应用标识，不是用户密钥。
const APP_ID = '100003'
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
export interface AutoclawCredential {
  access_token: string
  refresh_token: string
  user_id: string
  device_id: string
  nickname: string
}
export interface AutoclawModel {
  id: string
  name: string
  api: 'openai-completions' | 'anthropic-messages'
  input: ('text' | 'image')[]
  contextWindow?: number
  maxTokens?: number
}
export function autoclawHeaders(token?: string, now = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000))
  return {
    'Content-Type': 'application/json', 'X-Version': '2.0.4',
    'X-Tm': process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform,
    'X-Product': 'autoclaw', 'X-Auth-Appid': APP_ID, 'X-Auth-TimeStamp': timestamp,
    'X-Auth-Sign': createHash('md5').update(`${APP_ID}&${timestamp}&${APP_KEY}`).digest('hex'),
    'X-Lang': 'zh-CN', 'X-Channel': 'official',
    ...token ? { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}` } : {},
  }
}
export function parseAutoclawCredential(raw: string): AutoclawCredential | undefined {
  try {
    const c = JSON.parse(raw)
    return ['access_token', 'refresh_token', 'user_id', 'device_id'].every(k => typeof c?.[k] === 'string' && c[k].trim()) ? c : undefined
  } catch { return undefined }
}
export function autoclawExpiry(c: AutoclawCredential): number | undefined {
  try {
    const value = JSON.parse(Buffer.from(c.access_token.replace(/^Bearer\s+/i, '').split('.')[1]!, 'base64url').toString()).exp
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined
  } catch { return undefined }
}
/** 不编造模型目录：只使用当前账号拿到的官方配置。 */
export function parseAutoclawModels(value: unknown): AutoclawModel[] {
  const models = (value as { models?: unknown })?.models
  if (!Array.isArray(models) || models.length > 128) throw new Error('AutoClaw 模型目录格式无效')
  const seen = new Set<string>()
  return models.map(raw => {
    const m = typeof raw === 'string' ? { id: raw } : raw
    if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 256) throw new Error('AutoClaw 返回了无效模型')
    if (m.api !== undefined && !['openai-completions', 'anthropic-messages'].includes(m.api)) throw new Error('AutoClaw 模型协议暂不支持')
    const positive = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined
    const contextWindow = positive(m.contextWindow)
    const maxTokens = positive(m.maxTokens)
    return {
      id: m.id, name: typeof m.name === 'string' && m.name.trim() ? m.name : m.id,
      api: m.api ?? 'openai-completions',
      input: Array.isArray(m.input) && m.input.includes('image') ? ['text', 'image'] : ['text'],
      ...contextWindow ? { contextWindow } : {},
      ...maxTokens && (!contextWindow || maxTokens < contextWindow) ? { maxTokens } : {},
    } as AutoclawModel
  }).filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
}
export class AutoclawApi {
  constructor(readonly fetchImpl: typeof fetch = fetch) {}
  async request(path: string, body?: unknown, c?: AutoclawCredential, signal?: AbortSignal): Promise<any> {
    const response = await this.fetchImpl(`${AUTOCLAW.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: autoclawHeaders(c?.access_token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`AutoClaw 请求失败（HTTP ${response.status}）`)
    const text = await response.text()
    if (text.length > 512 * 1024) throw new Error('AutoClaw 响应过大')
    let value
    try { value = JSON.parse(text) } catch { throw new Error('AutoClaw 返回格式无效') }
    if (typeof value.code === 'number' && value.code !== 0) {
      // 不把完整响应或登录令牌写入日志。
      const message = typeof value.msg === 'string' ? value.msg.slice(0, 160).replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_.-]+/g, '[已隐藏]') : '服务拒绝请求'
      throw new Error(`AutoClaw：${message}（${value.code}）`)
    }
    return value
  }
  async sendSms(phone: string, device: string): Promise<void> {
    const r = await this.request('/userapi/v1/agent-send-code', { phone, source_id: 'autoclaw', device_id: device })
    if (r.data?.result !== true) throw new Error('AutoClaw 未确认发送验证码，请稍后重试')
  }
  async login(phone: string, code: string, device: string): Promise<AutoclawCredential> {
    const r = await this.request('/userapi/v1/agent-login', { phone, code: Number(code), source_id: 'autoclaw', device_id: device })
    const c = parseAutoclawCredential(JSON.stringify({ ...r.data, device_id: device, nickname: r.data?.user_name || `AutoClaw (${phone.slice(-4)})` }))
    if (!c) throw new Error('AutoClaw 登录未返回完整凭据')
    return c
  }
  async refresh(c: AutoclawCredential): Promise<AutoclawCredential> {
    const body = { refresh_token: c.refresh_token, source_id: 'autoclaw', device_id: c.device_id }
    let r
    try { r = await this.request('/userapi/v1/refresh', body) }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('(400002)')) throw error
      r = await this.request('/userapi/v1/agent-refresh', body)
    }
    const next = parseAutoclawCredential(JSON.stringify({ ...c, ...r.data }))
    if (!next) throw new Error('AutoClaw 续期未返回完整凭据')
    return next
  }
  async models(c: AutoclawCredential): Promise<AutoclawModel[]> {
    return parseAutoclawModels(await this.request('/autoclaw-proxy/proxy/autoclaw-model-config', undefined, c))
  }
  async balance(c: AutoclawCredential): Promise<number> {
    const r = await this.request('/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw', undefined, c)
    const total = r.data?.total_balance
    if (typeof total !== 'number' || !Number.isFinite(total)) throw new Error('AutoClaw 未返回积分余额')
    return total
  }
}
