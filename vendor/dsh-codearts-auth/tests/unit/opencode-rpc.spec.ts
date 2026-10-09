import { describe, expect, it, vi } from 'vitest'
import { handleOpencodeRpc, type OpencodePoolLike } from '../../src/opencode-rpc.js'
import { deriveProjectId } from '../../src/opencode.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

interface Result { ok: boolean; value?: unknown; error?: { message: string } }

/**
 * 最小宿主替身。
 *
 * ⚠️ 真机报障「unknown method: opencode.addAnonymous」的根因是**注册方式错了**
 * （本模块曾自己 `rpc.register`，而 Jet Hub 唯一通道是 `jet-hub-rpc.ts` 的
 * `handleMethod`）。故这里直接调 {@link handleOpencodeRpc} —— 与真实链路一致。
 * 另有源码文本断言锁死「并入主 switch」这条约定（见文件末尾 describe）。
 */
function harness() {
  const ctx = {
    credentials: { set: vi.fn(async () => {}) },
    logger: { info: () => {}, warn: () => {} },
  }
  const pool = {
    listAccountsByProvider: vi.fn(() => [] as Array<{ id: string; enabled: boolean; credentialRef: string }>),
    addAccount: vi.fn(async () => {}),
    updateAccount: vi.fn(async () => {}),
    setOpencodeProxy: vi.fn(async () => {}),
    updateOpencodeFingerprintGeneration: vi.fn(async () => {}),
    opencodeFingerprintGenerationFor: vi.fn(() => 0),
  }
  const call = async (method: string, payload: unknown): Promise<Result | undefined> => {
    const result = await handleOpencodeRpc(
      ctx as never, pool as unknown as OpencodePoolLike, method, payload,
    )
    return result as Result | undefined
  }
  return { call, pool, ctx }
}

describe('分派归属（真实事故 2026-10-02）', () => {
  const hubRpc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/jet-hub-rpc.ts'),
    'utf8',
  )

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配，而非自己回错误信封）', async () => {
    const { call } = harness()
    // 若这里回 {ok:false}，别的 provider 的方法名会被误判成「格式错误」。
    expect(await call('some.other.method', {})).toBeUndefined()
  })

  it('⚠️ 本模块不再自注册端点（那是真机报障的根因）', () => {
    const rpcSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/opencode-rpc.ts'),
      'utf8',
    )
    // ⚠️ 只看**代码行**：模块头注释里刻意保留了这句「我最初在这里调
    // `rpc.register`…」作为后人提醒，它不该让这条断言变红。
    const code = rpcSource.split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/rpc\.register\(/)
    expect(rpcSource).not.toMatch(/export function registerOpencodeRpc/)
  })

  it('⚠️ 主 handleMethod 在 switch 之前先试 opencode 分支', () => {
    // Jet Hub 只有一条通道（connection.fetch.register → handleMethod），
    // 若不并入它的 switch，所有 opencode.* 方法都落在 default → unknown method。
    const at = hubRpc.indexOf('async function handleMethod(')
    const body = hubRpc.slice(at, at + 900)
    expect(body).toMatch(/handleOpencodeRpc\(/)
    expect(body.indexOf('handleOpencodeRpc(')).toBeLessThan(body.indexOf('switch (method)'))
  })
})

const VALID_KEY = `sk-${'a'.repeat(48)}`

describe('opencode.addAccount', () => {
  it('key 形状非法时拒绝且不写池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.addAccount', { apiKey: 'not-a-key' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('sk-')
    expect(pool.addAccount).not.toHaveBeenCalled()
  })

  it('key 过短拒绝（sk- 后至少 20 位）', async () => {
    const { call, pool } = harness()
    expect((await call('opencode.addAccount', { apiKey: 'sk-short' })).ok).toBe(false)
    expect(pool.addAccount).not.toHaveBeenCalled()
  })

  it('合法 key 写入凭据 + 账号池条目', async () => {
    const { call, pool, ctx } = harness()
    const r = await call('opencode.addAccount', { apiKey: VALID_KEY, nickname: '主号' })
    expect(r.ok).toBe(true)
    expect((r.value as { existed: boolean }).existed).toBe(false)
    expect(ctx.credentials.set).toHaveBeenCalled()
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.provider).toBe('opencode')
    expect(entry.nickname).toBe('主号')
    expect(entry.enabled).toBe(true)
    // ⚠️ 手动 key 不可续期，标 true 是不实承诺
    expect(entry.refreshable).toBe(false)
  })

  it('⚠️ 写入的凭据里指纹由 key 派生（每账号指纹独立）', async () => {
    const { call, ctx } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    const cred = JSON.parse(value) as { api_key: string; fingerprint: { projectId: string; generation: number } }
    expect(cred.api_key).toBe(VALID_KEY)
    expect(cred.fingerprint.projectId).toBe(deriveProjectId(VALID_KEY, 0))
    expect(cred.fingerprint.generation).toBe(0)
  })

  it('⚠️ 凭据值里不含明文指纹以外的可推信息（只有 api_key 与派生量）', async () => {
    const { call, ctx } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual(['api_key', 'fingerprint', 'nickname'])
  })

  it('未给昵称时按 key 尾段自动命名（可区分多个账号）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(String(entry.nickname)).toContain(VALID_KEY.slice(-6))
  })

  it('重复 key 复用同一账号（不产生第二个条目）', async () => {
    const { call, pool } = harness()
    const first = await call('opencode.addAccount', { apiKey: VALID_KEY })
    const id = (first.value as { accountId: string }).accountId
    pool.listAccountsByProvider.mockReturnValue([{ id, enabled: true, credentialRef: 'X' }])
    const second = await call('opencode.addAccount', { apiKey: VALID_KEY })
    expect((second.value as { existed: boolean }).existed).toBe(true)
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
  })
})

describe('opencode.addAnonymous', () => {
  it('创建一条 api_key = public 的池条目', async () => {
    const { call, pool, ctx } = harness()
    const r = await call('opencode.addAnonymous', {})
    expect(r.ok).toBe(true)
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.provider).toBe('opencode')
    expect(String(entry.id)).toMatch(/^opencode-anon-[0-9a-f]{6}$/)
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect(JSON.parse(value).api_key).toBe('public')
  })

  it('⚠️ 昵称自动编号（用户可不填）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', {})
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(String(entry.nickname)).toBe('匿名通道 1')
  })

  it('可指定昵称', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', { nickname: '香港出口' })
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.nickname).toBe('香港出口')
  })

  it('⚠️ 每次调用创建新条目（不覆盖既有匿名通道）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', {})
    await call('opencode.addAnonymous', {})
    expect(pool.addAccount).toHaveBeenCalledTimes(2)
    const ids = pool.addAccount.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('opencode.setProxy', () => {
  it('合法代理归一后写入账号池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', 'http://127.0.0.1:7897')
  })

  it('socks5 归一后写入', async () => {
    const { call, pool } = harness()
    await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'socks5h://127.0.0.1:1080' })
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', 'socks5://127.0.0.1:1080')
  })

  it('⚠️ 空串 = 清除代理（回到同 IP 策略），label 说明直连', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: '  ' })
    expect(r.ok).toBe(true)
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', '')
    expect((r.value as { label: string }).label).toContain('直连')
  })

  it('非法代理返回可读中文理由且不写池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'vmess://x' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('不支持')
    expect(pool.setOpencodeProxy).not.toHaveBeenCalled()
  })

  it('accountId 缺失拒绝', async () => {
    const { call } = harness()
    expect((await call('opencode.setProxy', { proxy: 'http://1.2.3.4:8080' })).ok).toBe(false)
  })

  it('⚠️ 回显的 label 对密码脱敏（不回显明文口令）', async () => {
    const { call } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'http://u:secret@1.2.3.4:8080' })
    expect((r.value as { label: string }).label).not.toContain('secret')
  })
})

describe('opencode.testProxy', () => {
  it('经代理查出出口 IP 并返回', async () => {
    const { call } = harness()
    const stub = vi.fn(async () => new Response(JSON.stringify({ status: 'success', query: '1.2.3.4', country: 'US' }), { status: 200 }))
    vi.stubGlobal('fetch', stub as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    vi.unstubAllGlobals()
    expect(r.ok).toBe(true)
    expect((r.value as { exitIp: string }).exitIp).toBe('1.2.3.4')
    expect((r.value as { country: string }).country).toBe('US')
    expect(stub.mock.calls[0]![1]).toHaveProperty('dispatcher')
  })

  it('非法代理直接拒绝（不发请求）', async () => {
    const { call } = harness()
    const stub = vi.fn()
    vi.stubGlobal('fetch', stub as never)
    expect((await call('opencode.testProxy', { proxy: 'ftp://x' })).ok).toBe(false)
    vi.unstubAllGlobals()
    expect(stub).not.toHaveBeenCalled()
  })

  it('代理返回非 2xx 时给出可读失败', async () => {
    const { call } = harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    vi.unstubAllGlobals()
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('502')
  })

  it('连接抛错时给出可读失败（不把底层异常抛给 UI）', async () => {
    const { call } = harness()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:1' })
    vi.unstubAllGlobals()
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('ECONNREFUSED')
  })
})

describe('opencode.rotateFingerprint', () => {
  it('代次 +1 并写回账号池', async () => {
    const { call, pool } = harness()
    pool.opencodeFingerprintGenerationFor.mockReturnValue(2)
    const r = await call('opencode.rotateFingerprint', { accountId: 'opencode-a' })
    expect(r.ok).toBe(true)
    expect((r.value as { generation: number }).generation).toBe(3)
    expect(pool.updateOpencodeFingerprintGeneration).toHaveBeenCalledWith('opencode-a', 3)
  })

  it('从 0 起轮换得到 1', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.rotateFingerprint', { accountId: 'opencode-a' })
    expect((r.value as { generation: number }).generation).toBe(1)
    expect(pool.updateOpencodeFingerprintGeneration).toHaveBeenCalledWith('opencode-a', 1)
  })

  it('accountId 缺失拒绝', async () => {
    const { call } = harness()
    expect((await call('opencode.rotateFingerprint', {})).ok).toBe(false)
  })
})

describe('未知方法', () => {
  it('⚠️ 返回 undefined 而不是错误信封（2026-10-02 语义变更）', async () => {
    // 旧实现回 {ok:false, '未知方法 X'}，那会**抢走**别的 provider 的方法名 ——
    // 主 switch 拿不到 undefined 就无法继续匹配。现交回 undefined，由主 switch
    // 自己的 default 给出 `unknown method`（归属更准确）。
    const { call } = harness()
    expect(await call('opencode.nope', {})).toBeUndefined()
  })
})
