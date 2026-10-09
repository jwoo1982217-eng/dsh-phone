import { AsyncLocalStorage } from 'node:async_hooks'

/** 每个实际模型请求独立选号；目录查询、续期与设置页不会另占顺位。 */
export interface RotationRequest {
  provider: string
  model: string
  signal?: AbortSignal
  accounts: Map<object, string>
}

const requests = new AsyncLocalStorage<RotationRequest>()
export function rotationRequest(provider: string): RotationRequest | undefined {
  const request = requests.getStore()
  return request?.provider === provider ? request : undefined
}

/** 在迭代器的每一步恢复上下文，覆盖准备后的 stream、异常与取消清理。 */
export function rotatingStream<T>(provider: string, model: string, create: () => AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const request: RotationRequest = rotationRequest(provider) ?? { provider, model, signal, accounts: new Map() }
      const iterator = requests.run(request, () => create()[Symbol.asyncIterator]())
      return {
        next: () => requests.run(request, () => { signal?.throwIfAborted(); return iterator.next() }),
        return: (value?: unknown) => requests.run(request, () => iterator.return
          ? iterator.return(value) : Promise.resolve({ done: true as const, value: value as T })),
        throw: (error?: unknown) => requests.run(request, () => iterator.throw
          ? iterator.throw(error) : Promise.reject(error)),
      }
    },
  }
}

/** 按稳定 ID 续接用户排列；已删除的上次账号不参与，新增账号自然进入环。 */
export function afterAccount<T extends { id: string }>(accounts: readonly T[], last?: string): T[] {
  const index = accounts.findIndex(account => account.id === last)
  if (index < 0) return [...accounts]
  return [...accounts.slice(index + 1), ...accounts.slice(0, index + 1)]
}
