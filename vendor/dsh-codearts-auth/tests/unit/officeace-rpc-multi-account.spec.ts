/**
 * `officeace-rpc-multi-account.spec.ts` —— OfficeAce **多账号/号池**契约守卫。
 *
 * ## 这个文件为什么存在（以及它取代了什么）
 *
 * 2026-10-13 曾加过一个 `officeace-rpc-single-credential.spec.ts`，守的是
 * 「禁止建第二个 OfficeAce 账号」。那条约束是**错的**：它把一个实现缺陷
 * （所有卡片共用 `session.json` 一份凭据）当成了产品约束，用「拦截功能」
 * 去掩盖「数据会互相覆盖」。用户提了一个致命反问：
 *   「我要是想添加几个不同的账号呢？提示删除我怎么用号池？」
 *
 * 真正的修法是**让每个账号有自己的凭据**，而不是禁止多账号。凭据存储已从
 * 「自己写 `session.json`」改为**走 DSH 凭据库、按 `credentialRef` 索引**
 * （与 gemini / raccoon / minimax 的 `persistLogin(credential, { refName })`
 * 同款范式）—— 号池多账号由此天然成立。故原文件删除，改为本文件。
 *
 * ## 守的三条不变量
 *
 * | # | 不变量 | 违反的后果（实测） |
 * |---|--------|------------------|
 * | 1 | 允许建**多个**账号，各自有独立 credentialRef | 号池不可用，禁用功能 |
 * | 2 | 第二次登录**不覆盖**第一个账号的凭据 | 旧账号静默失效（数据损坏） |
 * | 3 | 两个账号的凭据**内容互相独立** | 串号：换号等于换掉所有人 |
 *
 * ⚠️ 不变量 2/3 是原 `single-credential` 文件想防的事 —— 但那个文件防错了
 *    地方（拦在入口），这里防对了地方（**凭据隔离**）。
 *
 * ⚠️ 本文件**不发真实网络**：`startLogin` / `completeLogin` 用桩替代。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

/**
 * 造一个能注册 RPC 的最小 ctx（抄自 `zcode-rpc-login.spec.ts`，
 * 那里有逐条踩坑注释）。
 *
 * ⚠️ `credentials` 用**内存 Map** 实现：本文件的核心就是验证「凭据按 ref
 *    隔离」，所以它必须是可观测的存储，而不是被 mock 掉的黑盒。
 */
function makeCtx(): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
  /** 收集 `ctx.logger.warn` 的**首参**（用来断言「降级必须留痕」）。 */
  warns: string[]
} {
  const ctx = new Context()
  const warns: string[] = []
  // ⚠️ 必须提供 logger：查重降级那条腿的**唯一可观测出口**就是 warn
  //    （变异验证实测：删掉 warn 后所有行为断言仍全绿 ⇒ 没有 logger 断言时它是无牙的）。
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: (message: unknown) => { warns.push(String(message)) },
    info: () => {},
    error: () => {},
    debug: () => {},
  }
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials: store, handler: () => handler, warns }
}

/**
 * 桩 `officeace` auth：两步式登录的第二步（`login.poll`）会调 `completeLogin`
 * 与 `persistLogin`，这里让它们**立刻成功**并返回可区分的凭据。
 *
 * ⚠️ `accountSeq` 让每次登录产出**不同**凭据内容 —— 不变量 3（内容互相独立）
 * 就靠这个可区分性来断言。
 */
function makeOfficeAceStub(options: { autoComplete?: boolean; accountId?: string } = {}) {
  const { autoComplete = true } = options
  let seq = 0
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'stub-verifier',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => (autoComplete ? 'stub-code' : undefined),
    completeLogin: async () => {
      seq += 1
      return {
        modelAppKey: `app-key-${seq}`,
        modelAppSecret: `app-secret-${seq}`,
        maasBaseUrl: 'https://officeace.example',
        access: `ak-${seq}`,
        secret: `sk-${seq}`,
        securityToken: `token-${seq}`,
        projectId: 'p',
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        refreshToken: `refresh-${seq}`,
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
        // ⚠️ 默认每次登录都是**不同的**云侧身份（现有用例 ①②③ 依赖它）；
        //    传入 `accountId` 可固定成同一个身份，用于「重复登录」用例 ④⑤；
        //    传空串 = 云侧未下发身份，用于「放弃去重」用例 ⑦。
        accountId: options.accountId ?? `account-${seq}`,
      }
    },
    persistLogin: async (
      credential: Record<string, unknown>,
      opts: { refName: string; credentials: { set(ref: string, value: string): Promise<void> } },
    ) => {
      // ⚠️ **真实地**按 ref 写进凭据库 —— 本文件验证的就是这个行为，
      //    不能 mock 掉，否则断言的是桩而不是实现。
      await opts.credentials.set(opts.refName, JSON.stringify(credential))
      return { accountId: credential.accountId }
    },
  }
}

function makeRpc(officeace: Record<string, unknown>) {
  const { ctx, credentials, handler, warns } = makeCtx()
  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never,
      officeace: officeace as never,
    } as never,
    undefined,
  )
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    // ⚠️ 括号**不可省**：`x as T['result']` 会被解析成索引访问类型而非取属性。
    const body = (await res.json()) as {
      result: { ok: boolean; value?: any; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { call, pool, credentials, warns }
}

/** 造一个账号并等它登录完成（两步式：create → 轮询 poll）。 */
async function addAccount(
  call: (method: string, payload: unknown) => Promise<any>,
): Promise<{ accountId: string; credentialRef: string }> {
  const created = await call('account.create', { provider: 'officeace' })
  expect(created.ok, 'account.create 应当成功').toBe(true)
  const accountId = created.value.accountId as string
  // 两步式：轮询直到 done（桩里第一次 poll 即完成）。
  for (let i = 0; i < 20; i++) {
    const polled = await call('login.poll', { accountId })
    if (polled.value?.done === true) break
  }
  return { accountId, credentialRef: `OFFICEACE_ACCOUNT_${'X'}` }
}

describe('OfficeAce 号池：多账号共存（凭据按 credentialRef 隔离）', () => {
  it('① 允许添加多个账号，且各有独立 credentialRef', async () => {
    const { call, pool } = makeRpc(makeOfficeAceStub() as unknown as Record<string, unknown>)

    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    expect(accounts, '多账号被拦截了 ⇒ 号池不可用').toHaveLength(2)
    const refs = accounts.map((a) => a.credentialRef)
    expect(new Set(refs).size, `credentialRef 重复了 ⇒ 凭据会互相覆盖：${refs.join(', ')}`).toBe(2)
  })

  it('② 第二次登录**不覆盖**第一个账号的凭据（旧账号不会静默失效）', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub() as unknown as Record<string, unknown>,
    )

    await addAccount(call)
    const first = (await pool.listAccounts('officeace'))[0]!
    const firstSnapshot = credentials.get(first.credentialRef)
    expect(firstSnapshot, '第一个账号的凭据未落库').toBeDefined()

    await addAccount(call)

    // ⚠️ 核心断言：第一个账号的凭据**原样还在**。
    expect(
      credentials.get(first.credentialRef),
      '第二次登录把第一个账号的凭据覆盖了 ⇒ 旧账号静默失效',
    ).toBe(firstSnapshot)
  })

  it('③ 两个账号的凭据内容互相独立（串号 ⇒ 换号会换掉所有人）', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub() as unknown as Record<string, unknown>,
    )

    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    const [a, b] = accounts
    const credA = credentials.get(a!.credentialRef)
    const credB = credentials.get(b!.credentialRef)
    expect(credA, 'A 的凭据缺失').toBeDefined()
    expect(credB, 'B 的凭据缺失').toBeDefined()
    expect(credA, '两个账号指向同一份凭据 ⇒ 串号').not.toBe(credB)

    // 内容层面也应当可区分（不同账号 = 不同 AK / refresh token）。
    const parsedA = JSON.parse(credA!) as { access: string }
    const parsedB = JSON.parse(credB!) as { access: string }
    expect(parsedA.access).not.toBe(parsedB.access)
  })
})

/**
 * ⚠️⚠️ **同一个云侧账号被登录两次时必须查重**（IKM741 追补，2026-10-16 **真机复现**）。
 *
 * ## 症状（用户 2026-10-16 截图 + 号池实测三条）
 *
 * 同一个华为号连登两次 ⇒ 两张卡片的 `accountId` / `modelAppKey` / MaaS 网关
 * **三项完全相同**（`id=41` 与 `id=43` 的 `accountId` / `modelAppKey` / 网关**三项完全相同**），
 * 只有 `credentialRef` 与 `refreshToken` 不同。
 *
 * ## 为什么必须治（不只是「多一张卡」）
 *
 * OfficeAce 的 `refresh_token` 是**一次性**的。两张同账号的卡各持一份 token，
 * 而**两者都会参与批量续期**（`refreshAll` 只看 `refreshable`、不看 `enabled`）
 * ⇒ 谁先续谁赢、后到的立刻作废；若「重复卡」先跑，废掉的正是**那张可用卡**
 * ⇒ 面板上表现为「账号突然凭证过期 / 积分查询失败」。
 *
 * ## 处置（照 zcode 范式）
 *
 * ① **不删条目**（删了 `login.poll` 会显示成「登录失败」，与事实相反）⇒ 停用 + 改名；
 * ② 新凭据**转写回原账号**（让可用卡保持最新）；③ 清掉重复条目自己的凭据（消灭双 token）。
 */
describe('OfficeAce 号池：同一云侧账号重复登录必须查重', () => {
  it('④ 第二次登录同一账号 ⇒ 不新增可用卡：新条目停用+改名，且 `login.poll` 仍如实报成功', async () => {
    const { call, pool } = makeRpc(
      makeOfficeAceStub({ accountId: 'same-cloud-id' }) as unknown as Record<string, unknown>,
    )
    const first = await addAccount(call)
    const second = await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    expect(accounts, '条目被删了 ⇒ login.poll 会显示成「登录失败」（与事实相反）').toHaveLength(2)
    const duplicate = accounts.find((a) => a.id === second.accountId)!
    const original = accounts.find((a) => a.id === first.accountId)!
    expect(original.enabled, '原来那张可用卡必须保持可用').toBe(true)
    expect(duplicate.enabled, '重复卡必须停用（这就是去重的实际效果）').toBe(false)
    expect(duplicate.nickname ?? '', '昵称要写明「重复」——用户一眼能看出并可自行删除').toContain('重复')
  })

  it('⑤ 新凭据转写回原账号 + 清掉重复条的凭据（否则两份一次性 token 互相作废）', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub({ accountId: 'same-cloud-id' }) as unknown as Record<string, unknown>,
    )
    const first = await addAccount(call)
    const second = await addAccount(call)

    const original = pool.findAccount(first.accountId)!
    const duplicate = pool.findAccount(second.accountId)!

    const originalCred = JSON.parse(credentials.get(original.credentialRef)!) as { refreshToken: string }
    expect(originalCred.refreshToken, '原账号的凭据应被刷新成最新那份（新凭据更新鲜）').toBe('refresh-2')
    expect(
      credentials.get(duplicate.credentialRef),
      '重复条的凭据必须清掉：两份一次性 refresh_token 会互相作废（先续的那张赢）',
    ).toBeUndefined()
    expect(credentials.size, '号池里只应留一份凭据').toBe(1)
  })

  it('⑥ 不同账号 ⇒ 不误杀：两条都可用、两份凭据都在', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub() as unknown as Record<string, unknown>,
    )
    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    expect(accounts).toHaveLength(2)
    expect(accounts.every((a) => a.enabled), '不同账号绝不能被停用').toBe(true)
    expect(credentials.size, '不同账号必须各留一份凭据').toBe(2)
  })

  it('⑦ 云侧未下发 accountId ⇒ **放弃去重**（不猜），两条都保留、都可用', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub({ accountId: '' }) as unknown as Record<string, unknown>,
    )
    // ⚠️ **直接观测「有没有去查重」**（行为断言不够：哪怕真去查了，空串也会被
    //    `findAccountIdByIdentityField` 的 `identity.length === 0` 守卫挡掉、
    //    结果看起来一样 —— 变异实测确认过这条会导致「无牙」）。
    //    判据：云侧不下发身份时**根本不该把空串送进查重口**。
    const spy = vi.spyOn(pool, 'findAccountIdByIdentityField')
    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    expect(accounts, '拿不到云侧身份时不得擅自去重（会误杀真实的多账号）').toHaveLength(2)
    expect(accounts.every((a) => a.enabled)).toBe(true)
    expect(credentials.size).toBe(2)
    expect(
      spy.mock.calls.every((c) => String(c[2]).length > 0),
      '云侧未下发身份时**不得**把空串送进查重口（空串进查重口 = 依赖内部守卫兜底，脆）',
    ).toBe(true)
  })

  it('⑧ ⚠️ 查重**读池失败**（替身池缺该方法）⇒ 不做去重、照常回填（读不到 ≠ 没有）', async () => {
    const { call, pool, warns } = makeRpc(
      makeOfficeAceStub({ accountId: 'same-cloud-id' }) as unknown as Record<string, unknown>,
    )
    // 模拟「池实现没有查重方法」（旧替身 / 未来接口变动）：偷换成抛错版本。
    // 判据是**登录结论不受影响** —— 而不是把异常吞成「无重复」再静默回填。
    const broken = pool as unknown as { findAccountIdByIdentityField: () => Promise<string> }
    broken.findAccountIdByIdentityField = async () => { throw new Error('查重依赖不可用') }

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value.accountId as string
    let polled: { done?: boolean; success?: boolean } | undefined
    for (let i = 0; i < 20; i++) {
      polled = (await call('login.poll', { accountId })).value
      if (polled?.done === true) break
    }
    expect(polled?.done, '查重依赖挂掉不该让登录停在中途').toBe(true)
    expect(polled?.success, '查重读不到 ⇒ 照常按成功回填（读不到 ≠ 没有）').toBe(true)
    const entry = (await pool.listAccounts('officeace')).find((a) => a.id === accountId)!
    expect(entry.enabled, '读不到池时不得擅自把账号停用').toBe(true)
    expect(entry.nickname ?? '', '应当走正常回填（不是「重复，已停用」）').not.toContain('重复')
    // ⚠️⚠️ **降级必须留痕**：这条是查重隐患的**唯一可观测出口**
    //    （变异实测：删掉 warn 后其它断言全绿 ⇒ 没有这条就是静默降级、无痕）。
    expect(
      warns.some((w) => w.includes('查重失败')),
      '查重读不到时应当记一条 warn（否则重复卡会静默回来，且日志零字）',
    ).toBe(true)
  })

  it('⑨ ⚠️ 查重**返回空串但不抛错**（依赖降级）⇒ 同样不许把账号停用（判据不能只看抛错）', async () => {
    const { call, pool } = makeRpc(
      makeOfficeAceStub({ accountId: 'same-cloud-id' }) as unknown as Record<string, unknown>,
    )
    // ⚠️ 与 ⑧ 是**两条不同的退化路径**：⑧ 是抛错、⑨ 是「静默返回空」。
    //    M6 变异实测证明：只测 ⑧ 时，把 catch 换成 return '' 仍然全绿 —— 会漏掉这一格。
    const silent = pool as unknown as { findAccountIdByIdentityField: () => Promise<string> }
    silent.findAccountIdByIdentityField = async () => ''

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value.accountId as string
    let polled: { done?: boolean; success?: boolean } | undefined
    for (let i = 0; i < 20; i++) {
      polled = (await call('login.poll', { accountId })).value
      if (polled?.done === true) break
    }
    expect(polled?.success, '查重退化 ⇒ 照常按成功回填').toBe(true)
    const entry = (await pool.listAccounts('officeace')).find((a) => a.id === accountId)!
    expect(entry.enabled, '查不到 ⇒ 不得擅自停用（宁可重复，不可误停）').toBe(true)
    expect(entry.nickname ?? '').not.toContain('重复')
  })
})
