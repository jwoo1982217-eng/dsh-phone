import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOpencodeRpc, type OpencodePoolLike } from '../../src/opencode-rpc.js'
import { deriveProjectId } from '../../src/opencode.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * ⚠️ **代理路径的 fetch 来自外部 undici**（`proxyFetch` 与 dispatcher 同源，
 * 见 issue IKK4BY），故 `vi.stubGlobal('fetch', …)` **拦不到它** ——
 * 必须单独给 undici 的 fetch 装替身。
 *
 * ⚠️ 用 `importOriginal` 展开而不是整模块替换：`ProxyAgent` / `Pool` 必须保持
 * **真实**，否则 `buildProxyDispatcher` 会失去构造能力（那测的就不是本 provider 了）。
 */
const undiciFetchSpy = vi.hoisted(() => vi.fn())
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undiciFetchSpy,
}))

/**
 * ⚠️ 统一在 `afterEach` 收尾，**不要**在各用例里手写 `mockReset()`：
 * 手写版一旦某条断言在中途抛错，那行 `mockReset()` 就被跳过，
 * 被污染的替身会**泄漏到下一条用例**（表现为随机性的假失败，极难排查）。
 */
afterEach(() => {
  undiciFetchSpy.mockReset()
  vi.unstubAllGlobals()
})

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
    //
    // ⚠️⚠️ **不得用固定字符窗口切片**（2026-10-17 修）：原判据是
    //    `slice(at, at + 900)`，而本 fork 在同一函数里新增了 `modelscope.` 改道分支
    //    及其注释 ⇒ `switch (method)` 被挤出那 900 字符 ⇒
    //    `body.indexOf('switch (method)')` 变成 -1，而 `177 < -1` 为假 ⇒ 假红。
    //    ⚠️ **判据没抓住先怀疑判据本身**（本仓库反复记录的教训）：
    //    魔数窗口对本文件里「任何新增分支/注释」都是定时炸弹，与被测行为无关。
    // ⇒ 改为**锚点式**：从 `handleMethod` 起，取到**第一个** `switch (method)` 为止。
    const at = hubRpc.indexOf('async function handleMethod(')
    expect(at, 'handleMethod 不存在').toBeGreaterThan(-1)
    const sw = hubRpc.indexOf('switch (method)', at)
    expect(sw, 'handleMethod 里没有 switch (method)').toBeGreaterThan(at)
    const body = hubRpc.slice(at, sw)
    expect(body).toMatch(/handleOpencodeRpc\(/)
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
    undiciFetchSpy.mockImplementation(stub as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect((r.value as { exitIp: string }).exitIp).toBe('1.2.3.4')
    expect((r.value as { country: string }).country).toBe('US')
    // ⚠️ 断言的仍是**生产不变式**：有代理时必须带上与 fetch 同源的 dispatcher。
    expect(stub.mock.calls[0]![1]).toHaveProperty('dispatcher')
  })

  it('⚠️ 代理路径用的是 undici 自带的 fetch（不是全局 fetch）', async () => {
    // 这条锁死缺陷 IKK4BY 的修法：全局 fetch + 外部 dispatcher 会在
    // Node 22/24 上恒抛 UND_ERR_INVALID_ARG（跨实例 handler 契约冲突）。
    const { call } = harness()
    const globalSpy = vi.fn(async () => new Response('不该被调用', { status: 200 }))
    vi.stubGlobal('fetch', globalSpy as never)
    undiciFetchSpy.mockImplementation(
      (async () => new Response(JSON.stringify({ status: 'success', query: '9.9.9.9' }), { status: 200 })) as never,
    )
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect(globalSpy).not.toHaveBeenCalled()
  })

  it('非法代理直接拒绝（不发请求）', async () => {
    const { call } = harness()
    const stub = vi.fn()
    vi.stubGlobal('fetch', stub as never)
    expect((await call('opencode.testProxy', { proxy: 'ftp://x' })).ok).toBe(false)
    expect(stub).not.toHaveBeenCalled()
  })

  it('代理返回非 2xx 时给出可读失败', async () => {
    const { call } = harness()
    undiciFetchSpy.mockImplementation((async () => new Response('nope', { status: 502 })) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('502')
  })

  it('连接抛错时给出可读失败（不把底层异常抛给 UI）', async () => {
    const { call } = harness()
    undiciFetchSpy.mockImplementation((async () => { throw new Error('ECONNREFUSED') }) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('ECONNREFUSED')
  })

  it('⚠️ `fetch failed` 的根因在 cause 里，必须带出来（issue IKK4BY 第 2 点）', async () => {
    // Node 的 fetch 在传输层失败时 message 恒为 `fetch failed`，真因只在 cause。
    // 只取 message 会让所有故障退化成同一句无信息量的话。
    const { call } = harness()
    const cause = Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' })
    const failure = Object.assign(new TypeError('fetch failed'), { cause })
    undiciFetchSpy.mockImplementation((async () => { throw failure }) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('invalid onRequestStart method')
    expect(r.error?.message).toContain('UND_ERR_INVALID_ARG')
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
