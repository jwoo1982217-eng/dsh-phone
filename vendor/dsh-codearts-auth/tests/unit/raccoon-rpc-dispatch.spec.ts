import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/**
 * Raccoon 的 RPC 分派（源码级回归）。
 *
 * ⚠️ 为什么用源码扫描而不是实例化端点：`registerJetHubRpc` 的参数是**位置参数**
 * （12 个），在测试里逐个填替身既脆弱又与既有 `jet-hub-rpc.spec.ts` 的桩重复。
 * 本文件锁的是**语义约定**（哪个分支返回什么形状），那些约定一旦写错，
 * 表现为「UI 显示矛盾的数字」这类**单测容易漏掉**的问题。
 *
 * 更深的行为验证在 `tests/unit/jet-hub-rpc.spec.ts`（复用它的端点桩）。
 */
describe('Raccoon 的 RPC 分派', () => {
  it('六条路径都已接上', () => {
    // ⚠️ 用「先定位分支起点，再在切片里查找」而不是大跨度正则 ——
    // 后者对字符数敏感（注释一变就误报），也难看出断裂处。
    const branchOf = (anchor: string, size = 3000): string => {
      const start = rpcSource.indexOf(anchor)
      expect(start, `未找到锚点：${anchor}`).toBeGreaterThan(-1)
      return rpcSource.slice(start, start + size)
    }

    // account.create
    expect(branchOf('} else if (provider === RACCOON.id)')).toMatch(/raccoon\.startLogin\(\)/)
    // account.refresh
    expect(branchOf('case RACCOON.id:')).toMatch(/raccoon\.refreshAccountCredential/)
    // credits.balances —— ⚠️ 该文件里 `if (req.provider === RACCOON.id)` 出现多次，
    // 故用**该分支独有的**注释锚点定位，避免命中 onboarding 的那一处。
    const balanceAnchor = rpcSource.indexOf('余额来自 `GET /points/v1/balance`')
    expect(balanceAnchor, '未找到 credits.balances 的 raccoon 分支').toBeGreaterThan(-1)
    expect(rpcSource.slice(balanceAnchor, balanceAnchor + 2000)).toMatch(/raccoon\.fetchCreditBalance/)
    // credits.claimAll（显式拒绝）
    expect(rpcSource).toMatch(/Raccoon Work 不支持每日签到/)
    // onboarding.status
    expect(rpcSource).toMatch(/raccoon\.fetchOnboardingStatus/)
    // onboarding.claim
    expect(rpcSource).toMatch(/raccoon\.claimLoginReward/)
  })

  it('onboarding.status / claim 同时接受 loomy 与 raccoon（共用端点）', () => {
    // 两处判据都必须是「属于其中之一」而不是只认 Loomy
    const guards = rpcSource.match(
      /req\.provider !== LOOMY\.id && req\.provider !== RACCOON\.id/g,
    )
    expect(guards?.length, '两个端点各需一处放开判据').toBeGreaterThanOrEqual(2)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：
   *
   * 账号已领过登录奖励时，UI 显示
   * 「✅ 1 个此前已完成 / 累计已领 **0** / 3000」—— **自相矛盾**：
   * 既然「此前已完成」，那 3000 分显然已经拿到手了。
   *
   * 根因：`onboarding.claim` 的 `already-claimed` 分支把 `earned` 写成 0，
   * 而客户端直接显示 `累计已领 ${res.earned} / ${res.total}`。
   *
   * 正确语义：`earned` 回答「该项目**累计**领到多少」，与「本次是否新增」无关。
   * 故已领时必须报满分。
   */
  it('⚠️ onboarding.claim 已领时 earned 报满分（不是 0）', () => {
    // 抓 onboarding.claim 里 raccoon 分支的 return 块
    const claimStart = rpcSource.indexOf("case 'onboarding.claim'")
    expect(claimStart).toBeGreaterThan(-1)
    const branch = rpcSource.slice(claimStart, claimStart + 3000)
    const raccoonPart = branch.slice(branch.indexOf('req.provider === RACCOON.id'))
    const returnBlock = raccoonPart.slice(0, raccoonPart.indexOf('satisfies RpcOnboardingClaimResponse'))

    // 不能出现「already-claimed → earned: 0」这种写法
    expect(
      returnBlock,
      'earned 不得在已领分支归零（会让 UI 显示「已完成 / 累计已领 0」）',
    ).not.toMatch(/earned:\s*outcome\.kind === 'claimed'\s*\?\s*outcome\.credit\s*:\s*0/)

    // 必须无条件等于 points（无论本次是否新增）
    expect(returnBlock).toMatch(/earned:\s*points/)
    expect(returnBlock).toMatch(/total:\s*points/)
  })

  it('已领时的金额从账单反查（与 onboarding.status 同一数据源）', () => {
    const claimStart = rpcSource.indexOf("case 'onboarding.claim'")
    const branch = rpcSource.slice(claimStart, claimStart + 3000)
    // 已领路径要调 fetchOnboardingStatus，否则金额可能与 status 显示的不一致
    expect(branch).toMatch(/fetchOnboardingStatus/)
  })

  it('credits.claimAll 的拒绝文案含「每日积分由服务端自动发放」', () => {
    // 该文案是可操作提示的来源；写成泛化的 unsupported provider
    // 会让排查者误以为「provider 没注册」。
    expect(rpcSource).toMatch(/每日积分由服务端自动发放/)
  })

  it('account.create 的失败路径都删除占位条目（不留幽灵账号）', () => {
    const createStart = rpcSource.indexOf('provider === RACCOON.id')
    const branch = rpcSource.slice(createStart, createStart + 3000)
    // startLogin 抛错 + 后台 catch 各一处
    const removals = branch.match(/pool\.removeAccount\(id\)/g)
    expect(removals?.length, '两处失败路径都应删占位条目').toBeGreaterThanOrEqual(2)
  })

  it('account.create 回填 refreshable（raccoon 有 refresh 端点）', () => {
    const createStart = rpcSource.indexOf('provider === RACCOON.id')
    const branch = rpcSource.slice(createStart, createStart + 3000)
    // ⚠️ 不能像 Loomy 那样写死 false
    expect(branch).toMatch(/refreshable:\s*result\.refreshable/)
  })
})
