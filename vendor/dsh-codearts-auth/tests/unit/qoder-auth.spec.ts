import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderAuth, RefreshTokenExpiredError } from '../../src/qoder-auth.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: QoderAuth[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
})

/**
 * 内存凭据提供者，形状与 ctx.credentials 一致。
 *
 * 用真实 `Context` + `ctx.provide('credentials', ...)`（而非裸对象 mock）：
 * cordis 的 `Service` 构造会调用 `ctx.provide`，裸对象会在
 * `Cannot read properties of undefined (reading 'provide')` 处炸掉。
 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: unknown) {
    const value = this.store.get(keyOf(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const has = this.store.has(keyOf(ref))
    return { configured: has, source: has ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(keyOf(ref), value) }
  async unset(ref: unknown) { this.store.delete(keyOf(ref)) }
  has(ref: unknown): boolean { return this.store.has(keyOf(ref)) }
  raw(ref: unknown): string | undefined { return this.store.get(keyOf(ref)) }
}

/** 取凭据 ref 的键名（credentialRef(name) 返回 `{ name }` 形态）。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/** 建立带凭据存储的 Context。初始条目形如 `[['QODER_ACCESS_TOKEN', json]]`。 */
function makeCtx(entries: Array<[string, string]> = []): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  for (const [ref, value] of entries) void credentials.set(ref, value)
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 构造 service 并登记以便 afterEach 清理。 */
function newService(ctx: Context, fetcher: typeof fetch): QoderAuth {
  const service = new QoderAuth(ctx, { product: QODER, fetcher })
  services.push(service)
  return service
}

/** 读回已存凭据的 JSON。 */
function readCred(credentials: FakeCredentials, ref: string): Record<string, unknown> {
  return JSON.parse(credentials.raw(ref)!) as Record<string, unknown>
}

const credJson = JSON.stringify(buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' }))

/** 成功的续期响应。 */
function refreshOk(token = 'tok-2', refresh = 'ref-2'): Response {
  return new Response(JSON.stringify({ device_token: token, refresh_token: refresh }), { status: 200 })
}

describe('QoderAuth 续期', () => {
  it('401 抛 RefreshTokenExpiredError 且 name 精确（refresh.ts 按 name 判定）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
  })

  it('403 同样视为终态', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('网络失败抛普通 Error（可重试，不是终态）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).not.toBe('RefreshTokenExpiredError')
  })

  it('5xx 抛普通 Error（可重试）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect((error as Error).name).not.toBe('RefreshTokenExpiredError')
  })

  it('成功续期回写新 token 并保留 machine_id', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    const saved = readCred(credentials, 'QODER_ACCESS_TOKEN')
    expect(saved.access_token).toBe('tok-2')
    expect(saved.machine_id).toBe('m-1')
    expect(saved.refresh_token).toBe('ref-2')
  })

  it('续期请求体带 refresh_token 与 machine_id', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    const call = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(String(call[0])).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
    expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({
      refresh_token: 'ref', machine_id: 'm-1',
    })
  })

  it('无 refresh_token 时抛终态错误', async () => {
    const noRefresh = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok' }), { machineId: 'm' })
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', JSON.stringify(noRefresh)]])
    const auth = newService(ctx, vi.fn() as never)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('未配置凭据时报错', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx, vi.fn() as never)
    await expect(auth.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('响应 200 但无 token 视为终态（拿不到新凭据）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })
})

describe('QoderAuth status / logout', () => {
  it('status 报告 configured / refreshable / expiresAt', async () => {
    const withExpiry = buildQoderCredential(
      parseQoderTokenPayload({ token: 't', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' }),
      { machineId: 'm' })
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', JSON.stringify(withExpiry)]])
    const auth = newService(ctx, vi.fn() as never)
    const status = await auth.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(true)
    expect(status.expiresAt).toBe(Date.parse('2030-01-01T00:00:00Z'))
  })

  it('未配置时 status.configured 为 false', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx, vi.fn() as never)
    const status = await auth.status()
    expect(status.configured).toBe(false)
    expect(status.refreshable).toBe(false)
  })

  it('logout 清除凭据', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const auth = newService(ctx, vi.fn() as never)
    await auth.logout()
    expect(credentials.has('QODER_ACCESS_TOKEN')).toBe(false)
  })

  it('logout 后在途续期不回写（登出竞态保护）', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => {
      await gate
      return refreshOk('tok-x', 'ref-x')
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const inFlight = auth.refresh().catch(() => {})
    await auth.logout()
    release?.()
    await inFlight
    expect(credentials.has('QODER_ACCESS_TOKEN')).toBe(false)
  })
})

describe('QoderAuth refreshAll（只按 refreshable 过滤，不看 enabled）', () => {
  it('已停用但可续期的账号仍被续期', async () => {
    // AGENTS.md 强制约定：停用只影响选号，不该让凭据烂掉
    const { ctx, credentials } = makeCtx([['QODER_ACCOUNT_A', credJson]])
    const fetcher = vi.fn(async () => refreshOk('tok-new', 'ref-new')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [{
          id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A',
          enabled: false, refreshable: true, nickname: 'a', createdAt: 0,
        }]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(readCred(credentials, 'QODER_ACCOUNT_A').access_token).toBe('tok-new')
  })

  it('不可续期的账号被跳过', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [{ id: 'a', provider: 'qoder', credentialRef: 'X', enabled: true, refreshable: false,
          nickname: 'a', createdAt: 0 }]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('单账号失败不中断其他账号', async () => {
    const { ctx, credentials } = makeCtx([
      ['QODER_ACCOUNT_A', credJson],
      ['QODER_ACCOUNT_B', credJson],
    ])
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return refreshOk('ok', 'r')
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [
          { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', enabled: true,
            refreshable: true, nickname: 'a', createdAt: 0 },
          { id: 'b', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_B', enabled: true,
            refreshable: true, nickname: 'b', createdAt: 0 },
        ]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(calls).toBe(2)
    expect(readCred(credentials, 'QODER_ACCOUNT_B').access_token).toBe('ok')
  })

  it('refreshAccountCredential 刷指定 ref（不动默认单凭据）', async () => {
    const { ctx, credentials } = makeCtx([
      ['QODER_ACCESS_TOKEN', credJson],
      ['QODER_ACCOUNT_Z', credJson],
    ])
    const fetcher = vi.fn(async () => refreshOk('z-new', 'z-ref')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAccountCredential('QODER_ACCOUNT_Z')
    expect(readCred(credentials, 'QODER_ACCOUNT_Z').access_token).toBe('z-new')
    expect(readCred(credentials, 'QODER_ACCESS_TOKEN').access_token).toBe('tok')
  })
})
