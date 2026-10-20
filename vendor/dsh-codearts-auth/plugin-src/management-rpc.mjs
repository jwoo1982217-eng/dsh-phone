/**
 * Jet Hub 管理 API 调用函数。
 *
 * Host 侧注册独立 RPC 通道（旧宿主兼容 Fetch 注册器），
 * Client 侧通过 connection.rpc.call() 调用。
 *
 * 路径格式：
 *   Host 注册：/jet-hub/manage
 *   Client 调用：connection.rpc.call('/jet-hub', 'manage', { method, payload }, signal)
 */

const ENDPOINT = 'manage'

/**
 * 调用 Jet Hub 管理 API。
 *
 * @param {import('@deepseek-ai/dsh-connection').Connection} connection
 * @param {string} channel  通道名（如 '/jet-hub'，用于识别）
 * @param {string} method  端点方法名（如 'account.list'）
 * @param {unknown} payload  请求载荷
 * @param {AbortSignal} [signal]  可选的取消信号
 * @returns {Promise<unknown>}  RPC 响应结果
 */
export function callManagementRpc(connection, channel, method, payload, signal) {
  // 使用独立管理通道，避免与宿主已经注册的 /api 拦截器冲突。
  return connection.rpc.call(channel, ENDPOINT, { method, payload }, signal)
}

/**
 * 解包 RPC 响应结果。
 * DSH connection.rpc.call 返回 { ok, value?, error? } 格式。
 * 如果 ok=true 返回 value，否则抛出 error。
 */
export function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = new Error(result.error?.message || 'Jet Hub API 请求失败')
    error.code = result.error?.code
    throw error
  }
  return result
}
