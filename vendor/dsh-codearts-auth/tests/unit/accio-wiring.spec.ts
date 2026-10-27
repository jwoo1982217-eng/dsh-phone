/**
 * Accio（阿里）的**接线守卫**（Task 7）。
 *
 * ## 它守的两件事
 *
 * 1. **`PROVIDER_REGISTRY` 的声明**（纯数据侧）：`accio` 必须作为
 *    `channel: true` 的真渠道登记，且 `dailyCheckin` **显式**写 `false`。
 * 2. **`src/index.ts` 的六处落点**（实现侧）：auth 实例、LLM 适配器、
 *    能力注册表、`modelAdapters`、`registerJetHubRpc` 的 `auths` 命名对象键。
 *
 * ## ⚠️ 为什么「dailyCheckin 必须是 false」值得单独一条
 *
 * Accio **没有签到端点** —— 每日 200 积分由**登录**触发服务端发放
 *（`DAILY_REWARD`，24h 有效、不累积）。登记 `true` 会让客户端渲染一个
 * 「一键领取」按钮，而它发不出任何有意义的请求（本仓库记录过同型缺陷：
 * 对不支持的 provider 无条件发必然失败的请求）。raccoon 是同一形态。
 *
 * ## ⚠️ 为什么 auths 键用 **AST** 而不是正则
 *
 * 命名对象里键与键之间**没有语义**（可任意重排、可插键）。正则守的是
 * 「源码里有那串字符」，而这里要守的是「运行时真的传进去了那个键」——
 * 用 `tests/helpers/jet-hub-auths.ts` 的 AST 助手读**调用点第三个实参**，
 * 重排 / 换行 / 注释都不影响，而键真的漏了必然变红。
 *（本仓库既有约定：`zcode-wiring.spec.ts` 的「接口键 === 调用点键」用它。）
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_REGISTRY, descriptorOf, creditCapabilitiesOf } from '../../src/provider-registry.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const indexSrc = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8')

describe('★ registry 声明', () => {
  it('accio 在 PROVIDER_REGISTRY 里', () => {
    const d = descriptorOf('accio')
    expect(d).toBeDefined()
    expect(d?.id).toBe('accio')
    expect(d?.channel).toBe(true)
  })

  it('⚠️⚠️ dailyCheckin 必须是 false —— Accio 没有签到端点', () => {
    // 每日额度由**登录**触发服务端发放（DAILY_REWARD 200），不是可调用的签到接口。
    // 登记 true 会让客户端渲染一个「一键领取」按钮，而它发不出任何有意义的请求。
    expect(descriptorOf('accio')?.credits.dailyCheckin).toBe(false)
    expect(creditCapabilitiesOf().accio?.dailyCheckin).toBe(false)
  })

  it('balance: true（量纲是积分，与 buddy 系同量纲，不是 token）', () => {
    expect(descriptorOf('accio')?.credits.balance).toBe(true)
  })

  it('id 是纯小写字母（带连字符会让四处正则断言静默漏算）', () => {
    expect(descriptorOf('accio')?.id).toMatch(/^[a-z]+$/)
  })

  it('settingsNamespace 是 llm-accio（老契约的 namespace 清单里必须有它）', () => {
    expect(descriptorOf('accio')?.settingsNamespace).toBe('llm-accio')
  })
})

describe('★ index.ts 六处接线', () => {
  it('创建 AccioAuth 实例', () => {
    expect(indexSrc).toMatch(/new AccioAuth\(/)
  })

  it('注册 LLM 适配器', () => {
    expect(indexSrc).toMatch(/registerAccioLlm\(/)
  })

  it('能力注册表含 accio', () => {
    expect(indexSrc).toMatch(/\[\s*'accio'\s*,\s*\w+\s*\]/)
  })

  it('modelAdapters 含 accio（走 pruned 包装）', () => {
    expect(indexSrc).toMatch(/accio:\s*pruned\(/)
  })

  it('⚠️ auths 命名对象含 accio 键（键必须与 provider id 同形）', () => {
    // ⚠️ 按 **AST** 读调用点的键，不用正则 —— 正则守的是「源码里有那串字符」，
    //    而这里要守的是「运行时真的传进去了 `accio` 这个键」（键名即语义）。
    expect(indexSrc).toMatch(/registerJetHubRpc\(/)
    expect(Object.keys(jetHubAuthsCallKeys(indexSrc))).toContain('accio')
  })

  it('⚠️ 不得给 registerJetHubRpc 加位置参数（会破坏「PROVIDERS 条数 + 1 == 形参个数」不变量）', () => {
    const start = indexSrc.indexOf('registerJetHubRpc(')
    // ⚠️ `indexOf` 的结果**必须先断言 >= 0** 再参与比较/切片：
    //    找不到时 `slice(-1)` 会静默取到文件末尾，断言在错误的片段上求值。
    expect(start, 'index.ts 里找不到 registerJetHubRpc 调用点').toBeGreaterThan(-1)
    const call = indexSrc.slice(start)
    const head = call.slice(0, call.indexOf('}'))
    // 命名对象形态：第 3 参是 `{ ... }`
    expect(head).toMatch(/\{\s*\n?\s*codearts/)
  })
})

/**
 * ★★ **`account.create` 的 accio 登录分支**（真实行为，不是源码文本）。
 *
 * ## 为什么必须单独守这一条
 *
 * 其余十家的模式是「RPC 的 `account.create` 登记占位条目、`auth.startLogin`
 * 不碰池」（`jet-hub-rpc.ts` 十余处）。而 accio **相反**：
 * `AccioAuth.startLogin` 自己登记占位条目（它要保证「返回 loginUrl 时占位条目
 * 已就位」，否则前端 `login.poll` 会先看到一个不存在的账号）。
 *
 * ⇒ 两个方向都是真缺陷，本组双向锁死：
 * 1. **RPC 又 `addAccount` 一次** ⇒ 同 id 两次写入（被 dedup 兜住 + 打 warn，
 *    功能无害但日志误导排查）；
 * 2. **RPC 不把 `pool` / `accountId` 透传给 `startLogin`** ⇒ 占位条目**根本
 *    没人登记** ⇒ `login.poll` 永远 `done:false` ⇒ 用户点了「添加账号」、
 *    授权成功、界面**永不出现该账号**（静默失败）。
 *
 * ⚠️ 用**真跑端点**而不是断言源码含某串字符：后者在「调用点被删但字符串
 * 还在注释里」时恒绿（本仓库反复记录过的形态）。
 */
describe('★ account.create(accio)：占位条目由 startLogin 登记，RPC 不得重复登记', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 搭一个只记录 `addAccount` 的 RPC 端点，accio 的 `startLogin` 换成替身。 */
  function setup(): {
    call: (provider: string, extra?: Record<string, unknown>) => Promise<{ ok: boolean; value?: { loginUrl?: string; accountId?: string }; error?: { message?: string } }>
    added: Array<Record<string, unknown>>
    startLoginArgs: Array<Record<string, unknown>>
  } {
    let handler: Handler | undefined
    const added: Array<Record<string, unknown>> = []
    const startLoginArgs: Array<Record<string, unknown>> = []

    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) handler = c.fetch } } }
        : undefined,
      inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const pool = {
      addAccount: async (entry: Record<string, unknown>) => { added.push(entry) },
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
      listAllAccounts: async () => [],
    }
    const stub = {} as never
    const accioStub = {
      /**
       * ⚠️ **替身复刻真实契约**：`AccioAuth.startLogin` 自己登记占位条目。
       * 若 RPC 分支也 `addAccount`，`added` 就会有**两条**同 id 记录 ⇒ 红。
       */
      async startLogin(options: Record<string, unknown>) {
        startLoginArgs.push(options)
        const accountId = String(options.accountId ?? '')
        if (options.pool !== undefined && accountId !== '') {
          await (options.pool as { addAccount(e: Record<string, unknown>): Promise<void> }).addAccount({
            id: accountId,
            provider: 'accio',
            nickname: accountId,
            enabled: true,
            credentialRef: String(options.refName ?? ''),
            refreshable: false,
            createdAt: Date.now(),
          })
        }
        return {
          loginUrl: 'https://www.accio-ai.com/login?x=1',
          // 永不落定：本用例只关心「返回 URL 之前」的接线。
          result: new Promise<void>(() => {}),
          close: () => {},
        }
      },
    }

    registerJetHubRpc(ctx as never, pool as never, {
      codearts: stub, buddy: stub, workbuddy: stub, lobsterai: stub, qoder: stub,
      qodercn: stub, trae: stub, cline: stub, loomy: stub, raccoon: stub,
      minimax: stub, zcode: stub, gemini: stub,
      accio: accioStub as never,
    } as never)

    return {
      added,
      startLoginArgs,
      call: async (provider, extra = {}) => {
        const h = handler
        if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
        const res = await h(new Request('http://localhost/api/jet-hub', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'r1', method: 'jet-hub',
            payload: { method: 'account.create', payload: { provider, ...extra } },
          }),
        }))
        return (await res.json() as { result: never }).result
      },
    }
  }

  it('★ accio 有 account.create 分支（不再报 unknown provider）', async () => {
    const { call } = setup()
    const result = await call('accio')
    expect(
      result.ok,
      `accio 的 account.create 失败：${result.error?.message} —— 用户点「添加账号」会直接报错`,
    ).toBe(true)
    expect(result.value?.loginUrl).toContain('accio-ai.com')
    expect(result.value?.accountId).toMatch(/^accio-/)
  })

  it('⚠️⚠️ 占位条目**恰好登记一次**（RPC 不得再 addAccount —— 与其余十家分工相反）', async () => {
    const { call, added } = setup()
    await call('accio')
    // 同 id 的两次写入会被 writeAccounts 的 dedup 兜住并打 warn —— 功能无害，
    // 但那条日志会误导排查（「谁才是对的」）。
    expect(
      added.map((e) => e.id),
      'accio 的占位条目被登记了两次：RPC 分支不得再 addAccount（startLogin 自己会登记）',
    ).toHaveLength(1)
    expect(added[0]).toMatchObject({ provider: 'accio', enabled: true, refreshable: false })
  })

  it('⚠️⚠️ pool 与 accountId 必须透传给 startLogin（否则占位条目根本没人登记）', async () => {
    const { call, startLoginArgs, added } = setup()
    await call('accio')
    expect(startLoginArgs, 'startLogin 没被调用').toHaveLength(1)
    const args = startLoginArgs[0]!
    // 这两个是「占位条目能被登记」的唯一前提；缺任一个，AccioAuth 内部会
    // 静默跳过登记（见它的 `options.pool !== undefined && accountId !== ''` 判据）。
    expect(args.pool, 'startLogin 没拿到 pool ⇒ 占位条目不会被登记').toBeDefined()
    expect(String(args.accountId ?? ''), 'startLogin 没拿到 accountId ⇒ 占位条目不会被登记')
      .toMatch(/^accio-/)
    // 反向：确认「透传真的产生了登记」（上面那条若因别的路径登记了也不算数）。
    expect(added).toHaveLength(1)
  })

  it('⚠️ region 过白名单：未登记值回落 cn（客户端自报载荷，无 schema 校验）', async () => {
    const { call, startLoginArgs } = setup()
    await call('accio', { accioRegion: 'not-a-region' })
    expect(startLoginArgs[0]?.region, '未登记的 region 必须回落 cn').toBe('cn')

    const { call: call2, startLoginArgs: args2 } = setup()
    await call2('accio', { accioRegion: 'global' })
    expect(args2[0]?.region, '已登记的 region 必须原样透传').toBe('global')
  })
})
