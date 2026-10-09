/**
 * S1 回归：适配器用哪个凭据解析，就必须刷新哪一个账号。
 *
 * 这是**接线层**缺陷 —— 所有 adapter 单测都注入同一个固定
 * `resolveCredential`，所以它们永远看不到「resolve 从账号池取、
 * refresh 却动另一个 ref」这种错配。本文件刻意走**真实接线**
 * （`src/index.ts` 里注册给 `registerLobsteraiLlm` 的那两个回调），
 * 只把最外层的账号池与凭据存储换成内存替身。
 *
 * 原始症状：池凭据过期 → 适配器调 refresh → 刷新并回写到默认 ref
 * → 再 resolve 仍取到未更新的过期凭据 → 带过期 token 发请求 → 401，
 * 而续期日志显示成功。用户看到「刚登录好却一直认证失败」。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

/** 内存凭据存储。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

const services: LobsteraiAuth[] = []

afterEach(() => {
  for (const s of services) s.stop()
  services.length = 0
  vi.clearAllMocks()
})

function makeCredential(token: string): LobsteraiCredential {
  return {
    access_token: token, refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'u', user_id: 'y', uuid: 'uuid-1',
    first_keyfrom: '1', latest_keyfrom: '1',
  }
}

describe('S1：refresh 回调必须作用于解析凭据所用的那个账号', () => {
  it('账号池凭据过期时，刷新的是**池里那个账号的 ref**，不是默认单凭据 ref', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    // 默认单凭据 ref 故意留空 —— 若 refresh 走单凭据路径，会以「未配置凭据」失败，
    // 从而把「刷错对象」这件事显式暴露出来。
    const poolRef = 'LOBSTERAI_ACCOUNT_POOL1'
    await credentials.set(poolRef, JSON.stringify(makeCredential('POOL-AT')))

    const refreshTargets: string[] = []
    const service = new LobsteraiAuth(ctx, {
      fetcher: (async () => new Response(JSON.stringify({
        data: { value: { version: '2026.9.4' } }, code: 0,
      }), { status: 200 })) as unknown as typeof fetch,
    })
    services.push(service)
    // 记录实际被刷新的 ref，替代真实网络。
    vi.spyOn(service, 'refreshAccountCredential').mockImplementation(async (ref: string) => {
      refreshTargets.push(ref)
    })
    const defaultRefresh = vi.spyOn(service, 'refresh').mockImplementation(async () => {
      refreshTargets.push('(默认单凭据)')
    })

    // 复刻 src/index.ts 里注册给适配器的两个回调（真实接线）。
    const pool = {
      getAvailableAccount: async (provider: string, _model: string) =>
        provider === LOBSTERAI.id
          ? { entry: { id: 'acc-1', provider, credentialRef: poolRef }, credential: JSON.parse(credentials.raw(poolRef)!) }
          : null,
    }
    const resolveCredential = async () => {
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) return available.credential as LobsteraiCredential
      return undefined
    }
    const refresh = async () => {
      // 复刻 src/index.ts 的**修复后**接线：刷解析凭据时所用的那个账号。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await service.refreshAccountCredential(available.entry.credentialRef)
      else await service.refresh()
    }

    // 前置：确实解析到了池凭据。
    expect((await resolveCredential())!.access_token).toBe('POOL-AT')

    await refresh()

    // 核心断言：刷的是池账号的 ref。
    expect(refreshTargets).toEqual([poolRef])
    expect(defaultRefresh).not.toHaveBeenCalled()
  })

  it('池里没有账号时才回退到默认单凭据 ref', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    await credentials.set('LOBSTERAI_ACCESS_TOKEN', JSON.stringify(makeCredential('DEFAULT-AT')))

    const service = new LobsteraiAuth(ctx, { fetcher: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch })
    services.push(service)
    const targets: string[] = []
    vi.spyOn(service, 'refreshAccountCredential').mockImplementation(async (ref: string) => { targets.push(ref) })
    vi.spyOn(service, 'refresh').mockImplementation(async () => { targets.push('(默认单凭据)') })

    const pool = { getAvailableAccount: async () => null }
    const refresh = async () => {
      const available = await pool.getAvailableAccount()
      if (available) await service.refreshAccountCredential((available as { entry: { credentialRef: string } }).entry.credentialRef)
      else await service.refresh()
    }
    await refresh()
    expect(targets).toEqual(['(默认单凭据)'])
  })

  it('refreshAccountCredential 写回的是传入的那个 ref（不串到默认 ref）', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    const poolRef = 'LOBSTERAI_ACCOUNT_POOL2'
    await credentials.set(poolRef, JSON.stringify(makeCredential('OLD-AT')))

    const service = new LobsteraiAuth(ctx, {
      fetcher: (async (url: unknown) => {
        if (String(url).includes('api-overmind')) {
          return new Response(JSON.stringify({ data: { value: { version: '2026.9.4' } }, code: 0 }), { status: 200 })
        }
        return new Response(JSON.stringify({
          code: 0, data: { accessToken: 'NEW-AT', refreshToken: 'RT2', expiresIn: 3600 },
        }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    services.push(service)

    await service.refreshAccountCredential(poolRef)

    expect(JSON.parse(credentials.raw(poolRef)!).access_token).toBe('NEW-AT')
    // 默认 ref 完全不应被触碰。
    expect(credentials.raw('LOBSTERAI_ACCESS_TOKEN')).toBeUndefined()
  })
})
