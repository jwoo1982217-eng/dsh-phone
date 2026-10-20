/** 对照 ZCode aac4755666d 的 BigModelUsageQuotaProvider；只使用本人 DSH 登录态。 */
import type { ZcodeCredential } from './zcode.js'
export type ResetType = 'FIVE_HOUR' | 'WEEK'
export interface ResetScope {
  credential: ZcodeCredential
  organizationId?: string
  projectId?: string
  assertCurrent(): void | Promise<void>
}
export interface ResetStatus {
  availableFiveHourResets: { expireAt: number }[]
  availableWeekResets: { expireAt: number }[]
  latestFiveHourResetHistory: { usedAt: number } | null
  latestWeekResetHistory: { usedAt: number } | null
  hasUnreadHistory: boolean
}
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function statusData(data: unknown): ResetStatus {
  if (!object(data)) throw new Error('额度重置返回格式无效')
  const opportunities = (value: unknown) => {
    if (!Array.isArray(value) || value.some(v => !object(v) || !timestamp(v.expire_at))) throw new Error('额度重置机会格式无效')
    return value.map(v => ({ expireAt: v.expire_at as number }))
  }
  const history = (value: unknown) => { if (value === null) return null; if (!object(value) || !timestamp(value.used_at)) throw new Error('额度重置历史格式无效'); return { usedAt: value.used_at } }
  if (typeof data.has_unread_history !== 'boolean') throw new Error('额度重置状态格式无效')
  return { availableFiveHourResets: opportunities(data.available_five_hour_resets), availableWeekResets: opportunities(data.available_week_resets), latestFiveHourResetHistory: history(data.latest_five_hour_reset_history), latestWeekResetHistory: history(data.latest_week_reset_history), hasUnreadHistory: data.has_unread_history }
}
export async function resetCodingPlan(scope: ResetScope, action: 'status' | 'opportunity' | 'use', options: { idempotencyKey?: string; resetType?: ResetType; confirmed?: boolean } = {}, fetchImpl: typeof fetch = fetch): Promise<ResetStatus | { granted: boolean; nextTryAt: number | null } | { used: true }> {
  if (!['status', 'opportunity', 'use'].includes(action)) throw new Error('无效的额度重置操作')
  if (action !== 'status' && (typeof options.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.idempotencyKey))) throw new Error('额度重置幂等键无效')
  if (action === 'use' && (options.confirmed !== true || !['FIVE_HOUR', 'WEEK'].includes(options.resetType ?? ''))) throw new Error('请先确认要消耗的额度重置机会')
  const c = scope.credential, token = c.zai_access_token ? c.zai_access_token : c.bigmodel_access_token
  if (!c.zcode_jwt?.trim() || !token?.trim()) throw new Error('额度重置需要 ZCode 和对应平台授权，请重新登录此账号')
  if (!!scope.organizationId !== !!scope.projectId) throw new Error('机构套餐缺少完整项目范围')
  await scope.assertCurrent()
  const headers: Record<string, string> = { Authorization: /^Bearer\s/i.test(c.zcode_jwt) ? c.zcode_jwt : `Bearer ${c.zcode_jwt}`, 'X-Bigmodel-Authorization': token, 'Bigmodel-Target-Type': scope.organizationId ? 'TEAM' : 'PERSONAL' }
  if (scope.organizationId) { headers['Bigmodel-Organization'] = scope.organizationId; headers['Bigmodel-Project'] = scope.projectId! }
  const body = action === 'status' ? undefined : JSON.stringify({ idempotency_key: options.idempotencyKey, ...(action === 'use' ? { reset_type: options.resetType } : {}) })
  if (body) headers['Content-Type'] = 'application/json'
  let response: Response
  try { response = await fetchImpl(`https://zcode.z.ai/api/v1/coding-plan/reset/${action}`, { method: body ? 'POST' : 'GET', headers, body, signal: AbortSignal.timeout(15000), redirect: 'error' }) }
  catch { throw new Error('额度重置请求未取得结果；若已确认重置，请保留原操作重试，避免重复消耗机会') }
  const text = await response.text(); let payload: unknown
  if (text.length <= 1024 * 1024) { try { payload = JSON.parse(text) } catch {} }
  // 先读取业务码，避免 HTTP 4xx 的稳定错误被 HTML 或上游原文盖住。
  if (object(payload) && Number.isInteger(payload.code) && payload.code !== 0) {
    if (action === 'opportunity' && payload.code === 3301 && object(payload.data) && timestamp(payload.data.next_try_at)) return { granted: false, nextTryAt: payload.data.next_try_at }
    throw new Error(`额度重置未获上游允许（业务码 ${payload.code}）`)
  }
  if (!response.ok) throw new Error(`额度重置请求失败（HTTP ${response.status}）${response.status === 429 ? '，请稍后再试' : ''}`)
  if (!object(payload) || payload.code !== 0 || !object(payload.data)) throw new Error('额度重置返回格式无效')
  const data = payload.data
  if (action === 'status') return statusData(data)
  if (action === 'opportunity') { if (typeof data.granted !== 'boolean') throw new Error('额度重置机会格式无效'); return { granted: data.granted, nextTryAt: null } }
  if (data.used !== true) throw new Error('上游未确认额度重置完成，请保留原操作重试')
  return { used: true }
}
