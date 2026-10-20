import { AsyncLocalStorage } from 'node:async_hooks'
import { accountQuotaError, streamError, hasStreamOutput } from './account-failover.js'

/** 每个实际模型请求独立选号；目录查询、续期与设置页不会另占顺位。 */
export interface RotationRequest {
  provider: string
  model: string
  signal?: AbortSignal
  accounts: Map<object, string>
  excluded?: Map<object, Set<string>>
  failover?: Map<object, (error: unknown) => Promise<boolean>>
  sources?: Map<object, Map<string, string>>
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
      request.excluded ??= new Map()
      request.failover ??= new Map()
      const retry = async (error: unknown): Promise<boolean> => {
        if (signal?.aborted || !accountQuotaError(error)) return false
        for (const selectNext of request.failover!.values()) if (await selectNext(error)) return true
        return false
      }
      const attempt = async function* (): AsyncIterable<T> {
        for (;;) {
          const buffered: T[] = []
          let output = false, restart = false
          try {
            for await (const chunk of create()) {
              const error = streamError(chunk)
              if (!output && error && await retry(error)) { restart = true; break }
              output ||= hasStreamOutput(chunk)
              if (output || error) {
                yield* buffered.splice(0)
                yield chunk
              } else buffered.push(chunk)
            }
          } catch (error) {
            if (!output && await retry(error)) restart = true
            else { yield* buffered; throw error }
          }
          if (restart) continue
          yield* buffered
          return
        }
      }
      const iterator = requests.run(request, () => attempt()[Symbol.asyncIterator]())
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
