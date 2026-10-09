/**
 * ★ ZCode **coding-plan（付费订阅）通道的接线**回归测试（2026-10-05）。
 *
 * ## 守的是一条**早已存在、但从未被修好**的断链
 *
 * `fetchCodingPlanApiKey`（`zcode-transport.ts`）能拿登录时拿到的 OAuth
 * access_token **现换** coding-plan 的 api-key（三步、只 GET、不在云上建 key）。
 * 但它建好之后**一个调用方都没有**：
 *
 * | | 状态 |
 * |---|---|
 * | `coding_plan_key_zai` / `_bigmodel` 的**唯一**写入点 | 「从本机 ZCode 客户端读凭据」—— 2026-10-05 已整体删除 |
 * | `fetchCodingPlanApiKey` 的调用方 | **零**（此前只有测试调它） |
 * | `zcode-transport.ts` 的通道可用性判定 | 完全依赖上面两个字段（`available()`） |
 *
 * ⇒ **纯插件登录用户的 coding-plan 通道一直不可用**（表现为 `glm-5.3` /
 * `glm-5.3-flash` 在通道表里 unavailable，付费订阅白白买了）。
 *
 * 本次把缺的那一环接上（`ZcodeAuth.resolveCodingPlanKey`，由 `startLogin` 调用），
 * 本文件锁死它的行为。
 *
 * ## 为什么 mock 的是 `runZcodeLogin` 而不是打真实网络
 *
 * `zcode-rpc-login.spec.ts` 走的是**真实** OAuth 端点（那是有意的端到端验证）。
 * 本文件要验的是「拿到 token 之后会不会去换 key、换到写哪个字段、换不到怎么办」，
 * 那些与上游协议无关 —— 换 token 的三步各自已有 20 条用例在
 * `zcode-transport.spec.ts` 里逐个锁死。
 */
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZcodeLoginResult } from '../../src/zcode-login.js'

/** 登录结果的可改写副本（每条用例按需覆盖字段）。 */
const LOGIN_RESULT: ZcodeLoginResult = {
  zcodeJwt: 'JWT-1',
  userId: '15951790100986814',
  displayName: '付费用户',
}

/**
 * 替身 `runZcodeLogin`：立刻回调授权 URL 再返回结果。
 *
 * ⚠⚠ **必须回调 `onAuthorizeUrl`**：`startLogin` 是两步式，它 `await` 一个
 * 只由该回调 resolve 的 `urlPromise` 才会返回。替身不回调 ⇒ `urlPromise`
 * 永远挂起 ⇒ 整条用例 5 秒超时（看起来像「接线失败」，实则是桩不合格）。
 *
 * ⚠ 用**可变状态**而不是逐条 `mockImplementation`：后者写的
 * `() => fakeLogin(...)` 箭头函数**不接参数**，会把 `options`（含
 * `onAuthorizeUrl`）整个吞掉 —— 同一个坑的另一个入口（我在这里踩过一次）。
 */
let currentOverrides: Partial<ZcodeLoginResult> = {}

const runZcodeLoginMock = vi.fn(
  async (options?: { onAuthorizeUrl?: (url: string) => void }): Promise<ZcodeLoginResult> => {
    options?.onAuthorizeUrl?.('https://example.invalid/authorize')
    return { ...LOGIN_RESULT, ...currentOverrides }
  },
)

vi.mock('../../src/zcode-login.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/zcode-login.js')>()
  return { ...actual, runZcodeLogin: (...args: unknown[]) => runZcodeLoginMock(...(args as [])) }
})

const { ZcodeAuth } = await import('../../src/zcode-auth.js')
const { ZCODE } = await import('../../src/zcode-product.js')
type ZcodeCredentialShape = import('../../src/zcode.js').ZcodeCredential

/** 内存凭据存储。 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeCtx(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('settings', { register: () => ({ get: () => undefined, replace: () => {} }) } as never)
  return { ctx, credentials }
}

/**
 * coding-plan 换取链路的 fetch 桩（三个只读 GET）。
 *
 * ⚠ 端点与形状**逐字**对应 `fetchCodingPlanApiKey`：写错形状会让某一步
 * 返回 `undefined`，换取静默失败 ⇒ 那正是本文件要能发现的失败。
 */
function codingPlanFetch(
  calls: string[],
  opts: { keys?: boolean; orgs?: boolean } = {},
): typeof fetch {
  const { keys = true, orgs = true } = opts
  return (async (input: string | URL | Request) => {
    const u = String(input)
    calls.push(u)
    if (u.includes('/customer/getCustomerInfo')) {
      return new Response(JSON.stringify({
        code: 0,
        data: orgs
          ? { organizations: [{ organizationId: 'org-1', organizationName: '默认机构', projects: [{ projectId: 'proj-1', projectName: '默认项目', projectType: '1' }] }] }
          : { organizations: [] },
      }), { status: 200 })
    }
    if (u.includes('/api_keys/copy/')) {
      return new Response(JSON.stringify({ secretKey: 'SECRET' }), { status: 200 })
    }
    if (u.includes('/api_keys')) {
      return new Response(JSON.stringify(keys ? [{ name: 'zcode-api-key', apiKey: 'AK-1' }] : []), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

/** 登录一次并返回落库后的凭据。 */
async function loginAndRead(
  ctx: Context,
  credentials: FakeCredentials,
  fetchImpl: typeof fetch,
  refName = 'ZCODE_TEST_REF',
): Promise<ZcodeCredentialShape> {
  const auth = new ZcodeAuth(ctx, { fetchImpl })
  const started = await auth.startLogin({ refName })
  await started.result
  const resolved = await credentials.resolve(refName)
  if (resolved === undefined) throw new Error('凭据未落库')
  return JSON.parse(resolved.value) as ZcodeCredentialShape
}

beforeEach(() => {
  runZcodeLoginMock.mockClear()
  currentOverrides = {}
})

describe('★ coding-plan key：登录后顺带换取（修 IKJNPZ 同批的断链）', () => {
  it('★ zai 渠道换到 key ⇒ 写进 coding_plan_key_zai（不是 _bigmodel）', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = { zaiAccessToken: 'OAUTH-ZAI', bigmodelAccessToken: undefined }
    const calls: string[] = []
    const cred = await loginAndRead(ctx, credentials, codingPlanFetch(calls))

    expect(cred.coding_plan_key_zai).toBe('AK-1.SECRET')
    // ⚠ 字段按**拿到哪个 token**落位，两个 key 只会有其一。
    expect(cred).not.toHaveProperty('coding_plan_key_bigmodel')
    // 三个 GET 都发了，且打到正确的 biz origin。
    expect(calls.filter((c) => c.includes('api.z.ai'))).toHaveLength(3)
  })

  it('★ bigmodel 渠道换到 key ⇒ 写进 coding_plan_key_bigmodel', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = { zaiAccessToken: undefined, bigmodelAccessToken: 'OAUTH-BM' }
    const cred = await loginAndRead(ctx, credentials, codingPlanFetch([]))

    expect(cred.coding_plan_key_bigmodel).toBe('AK-1.SECRET')
    expect(cred).not.toHaveProperty('coding_plan_key_zai')
  })

  it('★ 换不到 key（云上没有）⇒ 登录照常成功，且不写空键', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = { zaiAccessToken: 'OAUTH-ZAI', bigmodelAccessToken: undefined }
    // 没有名为 zcode-api-key 的 key ⇒ reason 'no-key'。
    const cred = await loginAndRead(ctx, credentials, codingPlanFetch([], { keys: false }))

    // 登录的**全部**既有产物必须完好 —— 没订阅是常态，不能因此把用户挡在门外。
    expect(cred.zcode_jwt).toBe('JWT-1')
    expect(cred.user_id).toBe('15951790100986814')
    expect(cred.device_mid).toMatch(/^[0-9a-f-]{36}$/)
    expect(cred).not.toHaveProperty('coding_plan_key_zai')
    expect(cred).not.toHaveProperty('coding_plan_key_bigmodel')
  })

  it('★ org 取不到（reason=no-org）同样不牵连登录', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = { zaiAccessToken: 'OAUTH-ZAI', bigmodelAccessToken: undefined }
    const cred = await loginAndRead(ctx, credentials, codingPlanFetch([], { orgs: false }))
    expect(cred.zcode_jwt).toBe('JWT-1')
    expect(cred).not.toHaveProperty('coding_plan_key_zai')
  })

  it('★ 换取过程抛错也不牵连登录（网络炸了照样能用 start-plan）', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = { zaiAccessToken: 'OAUTH-ZAI', bigmodelAccessToken: undefined }
    const boom = (async () => { throw new Error('网络炸了') }) as unknown as typeof fetch
    const cred = await loginAndRead(ctx, credentials, boom)
    expect(cred.zcode_jwt).toBe('JWT-1')
    expect(cred).not.toHaveProperty('coding_plan_key_zai')
  })

  it('★ 两个 access token 都缺 ⇒ 一个请求都不发（不空转）', async () => {
    const { ctx, credentials } = makeCtx()
    currentOverrides = {}
    const calls: string[] = []
    const cred = await loginAndRead(ctx, credentials, codingPlanFetch(calls))

    // 没有 token 时 `fetchCodingPlanApiKey` 只会回 no-oauth-token；本实现更早短路。
    expect(calls.filter((c) => c.includes('api.z.ai'))).toHaveLength(0)
    expect(cred.zcode_jwt).toBe('JWT-1')
  })
})
