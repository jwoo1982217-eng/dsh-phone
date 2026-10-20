/**
 * ZCode **重复账号去重**的测试（真实缺陷，2026-10-02）。
 *
 * ## 背景
 *
 * 同一账号点两次「添加账号」会得到**两条独立条目**：各自参与选号、
 * 各自消耗额度，而 UI 上看起来像两个账号（昵称也一样，无从分辨）。
 *
 * ## ⚠ 判据必须是 `user_id`，不能用 `device_mid`
 *
 * | 字段 | 来源 | 同一账号多次登录 |
 * |---|---|---|
 * | `device_mid` | **我们随机生成**（`generateDeviceMid()`） | **会变** ⇒ 不可作标识 |
 * | `user_id` | **服务端下发** | **不变** ⇒ 正确判据 |
 *
 * 实测依据（`zcode-login.ts`）：「同一 JWT 换任意随机 UUID 都返回 200」
 * —— `device_mid` 的值不被服务端绑定校验，故它**不是**账号身份。
 *
 * ⚠ 这条尤其值得守：我最初给用户的判据就是错的（说可用 `device_mid`），
 * 若照那个实现，**同一账号重新登录一次就会被判成新账号**，
 * 去重功能等于反向失效。故本文件用一条**专门的反例**把它钉住。
 *
 * ## 测试脚手架的注意点（踩过）
 *
 * `AccountPool` 是**真实**实现，会读写磁盘（`DSH_JET_HUB_STATE_DIR`
 * → profileContext → `DSH_HOME` → `~/.dsh`）。必须：
 * ① 用 `mkdtempSync` + `DSH_JET_HUB_STATE_DIR` **隔离**，否则污染真实状态；
 * ② 用 `ctx.provide('credentials', fake)` 注入内存凭据（不是属性赋值 ——
 *    `AccountPool` 经 `ctx.credentials` 取服务）；
 * ③ **不要**用 `replaceAll`（那是 Jet Hub 的导入路径，语义不同）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { ZCODE } from '../../src/zcode-product.js'
import { isUsableZcodeCredential } from '../../src/zcode.js'

/** 内存凭据实现（与既有的 `zcode-credential-resolution.spec.ts` 同型）。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value)
  }
  async unset(ref: string): Promise<void> {
    this.store.delete(ref)
  }
}

function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  // 静音 logger。
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  return ctx
}

/** 建一个账号（带给定凭据）。 */
async function seed(
  ctx: Context,
  options: { id: string; ref: string; enabled?: boolean; credential: Record<string, unknown> },
): Promise<void> {
  const pool = new AccountPool(ctx)
  await pool.addAccount({
    id: options.id,
    provider: ZCODE.id,
    nickname: options.id,
    enabled: options.enabled ?? true,
    credentialRef: options.ref,
    refreshable: false,
    createdAt: 1,
  } as never)
  const creds = ctx.get('credentials') as unknown as FakeCredentials
  await creds.set(options.ref, JSON.stringify(options.credential))
}

let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env['DSH_JET_HUB_STATE_DIR']
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-zcode-dedup-'))
  process.env['DSH_JET_HUB_STATE_DIR'] = isolatedHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSH_JET_HUB_STATE_DIR']
  else process.env['DSH_JET_HUB_STATE_DIR'] = previousHome
  if (isolatedHome !== undefined) {
    try { rmSync(isolatedHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

describe('ZCode 重复账号去重的判据', () => {
  it('★★ `user_id` 能匹配到已有账号（正确判据）', async () => {
    const ctx = makeCtx()
    await seed(ctx, {
      id: 'zcode-1',
      ref: 'ZCODE_ACCOUNT_1',
      credential: { zcode_jwt: 'a.b.c', device_mid: 'mid-1', user_id: 'user-123' },
    })

    const pool = new AccountPool(ctx)
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'user-123'))
      .resolves.toBe('zcode-1')
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'nobody'))
      .resolves.toBe('')
  })

  it('★★ `device_mid` **不能**作判据：同一账号重新登录后它变了', async () => {
    const ctx = makeCtx()
    await seed(ctx, {
      id: 'zcode-1',
      ref: 'ZCODE_ACCOUNT_1',
      // 同一账号，但凭据里存的是**上次**登录生成的 mid。
      credential: { zcode_jwt: 'a.b.c', device_mid: 'mid-OLD', user_id: 'user-123' },
    })

    const pool = new AccountPool(ctx)
    /**
     * ★ 关键反例：拿**新**登录生成的 mid 去查 ⇒ **查不到**。
     *
     * 这正是我们想要的结论 —— 说明 `device_mid` 不可作判据。
     * 若去重实现用了它，「同一账号重新登录」会被判成新账号，
     * 去重**反向失效**（而 `user_id` 那条仍然匹配得上，是正确路径）。
     */
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'device_mid', 'mid-NEW'))
      .resolves.toBe('')
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'user-123'))
      .resolves.toBe('zcode-1')
  })

  it('★ 早期凭据缺 `user_id` 时**跳过**（无法判断 ≠ 不匹配），且不报错', async () => {
    const ctx = makeCtx()
    await seed(ctx, {
      id: 'zcode-old',
      ref: 'ZCODE_ACCOUNT_OLD',
      // 2026-10-02 之前登录的凭据没有 user_id。
      credential: { zcode_jwt: 'a.b.c', device_mid: 'mid' },
    })

    const pool = new AccountPool(ctx)
    // 不报错；查不到（下次登录补上 user_id 后才能真正判重）。
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'user-123'))
      .resolves.toBe('')
  })

  it('★ 空 identity 直接返回空串（调用方据此放弃去重）', async () => {
    const ctx = makeCtx()
    const pool = new AccountPool(ctx)
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', '')).resolves.toBe('')
  })

  it('★ 只看同 provider：别的 provider 的相同 user_id 不误判', async () => {
    const ctx = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'qoder-1',
      provider: 'qoder',
      nickname: 'Qoder',
      enabled: true,
      credentialRef: 'QODER_ACCOUNT_1',
      refreshable: false,
      createdAt: 1,
    } as never)
    const creds = ctx.get('credentials') as unknown as FakeCredentials
    await creds.set('QODER_ACCOUNT_1', JSON.stringify({ user_id: 'user-123' }))

    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'user-123'))
      .resolves.toBe('')
  })

  it('★ 停用的账号同样参与判重（它仍占着一个条目的位置）', async () => {
    const ctx = makeCtx()
    await seed(ctx, {
      id: 'zcode-disabled',
      ref: 'ZCODE_ACCOUNT_D',
      enabled: false,
      credential: { zcode_jwt: 'a.b.c', device_mid: 'm', user_id: 'user-123' },
    })

    const pool = new AccountPool(ctx)
    /**
     * ⚠ 与 `findAccountIdByCredential`（那个见 `!entry.enabled` 就 continue）
     * 的**有意差异**：那个是限流归属专用；本方法是通用去重 ——
     * 停用账号仍占位置，重复添加它仍是重复。
     */
    await expect(pool.findAccountIdByIdentityField(ZCODE.id, 'user_id', 'user-123'))
      .resolves.toBe('zcode-disabled')
  })
})

describe('ZCode 凭据必须携带 user_id（去重的前提）', () => {
  it('★ isUsableZcodeCredential 不因缺 user_id 而拒绝（向后兼容老凭据）', () => {
    // 老凭据（无 user_id）仍必须可用 —— 否则老用户会突然无法用 zcode。
    expect(isUsableZcodeCredential({ zcode_jwt: 'a.b.c', device_mid: 'm' })).toBe(true)
    // 新凭据（带 user_id）同样可用。
    expect(isUsableZcodeCredential({
      zcode_jwt: 'a.b.c',
      device_mid: 'm',
      user_id: 'user-123',
    })).toBe(true)
  })
})
