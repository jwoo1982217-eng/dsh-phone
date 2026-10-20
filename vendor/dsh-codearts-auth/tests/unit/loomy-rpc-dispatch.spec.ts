import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const typesSource = readFileSync(resolve(here, '../../src/types.ts'), 'utf8')

/**
 * 源码级回归：RPC 分派必须包含 Loomy 的各个分支。
 *
 * 用源码断言而非实例化 `registerJetHubRpc`（它需要完整 ctx 与 connection 服务），
 * 与既有的 `lobsterai-rpc-dispatch.spec.ts` 同法。
 */
describe('Loomy RPC 分派', () => {
  it('types.ts 的 account.create 契约扩展了 phone 与 loginMode', () => {
    expect(typesSource).toMatch(/interface RpcCreateAccountRequest \{[\s\S]*?phone\?: string/)
    expect(typesSource).toMatch(/interface RpcCreateAccountResponse \{[\s\S]*?loginMode\?: 'url' \| 'sms'/)
  })

  it('types.ts 定义了短信登录与新手任务的 RPC 类型', () => {
    for (const name of [
      'RpcSendSmsRequest', 'RpcSendSmsResponse', 'RpcSubmitSmsRequest', 'RpcSubmitSmsResponse',
      'RpcOnboardingStatusRequest', 'RpcOnboardingStatusResponse',
      'RpcOnboardingClaimRequest', 'RpcOnboardingClaimResponse',
    ]) {
      expect(typesSource, `缺少 ${name}`).toContain(`interface ${name}`)
    }
  })

  it('account.create 有 loomy 分支并返回微信弹窗页 loginUrl', () => {
    expect(rpcSource).toContain('provider === LOOMY.id')
    expect(rpcSource).toContain('loomy.startWechatLogin()')
    expect(rpcSource).toMatch(/loginUrl: started\.loginUrl/)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
   *
   * 早期 `account.create` 要求必须带 `phone`，但验证码表单要等它返回
   * `loginMode:'sms'` 才渲染 —— 用户根本没机会输入手机号，直接报错，
   * **表单永远出不来**。这是**顺序死锁**。
   *
   * 改用微信扫码后，`account.create` **不得**再要求 `phone`。
   */
  it('account.create 不再要求 phone（顺序死锁回归）', () => {
    const start = rpcSource.indexOf('provider === LOOMY.id')
    expect(start).toBeGreaterThan(-1)
    const end = rpcSource.indexOf('} else {', start)
    const body = rpcSource.slice(start, end > start ? end : start + 3000)
    // ⚠️ 只检查**代码**，剥掉注释 —— 注释里引用了那句历史报错文案做说明，
    // 不剥会把「解释缺陷」误判成「缺陷仍在」。
    const code = body
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('Loomy 短信登录需要手机号')
    expect(code).not.toContain('req.phone')
    // 不再返回 loginMode:'sms'（那是表单式登录的标记，已改微信弹窗）
    expect(code).not.toContain("loginMode: 'sms'")
  })

  it('account.refresh 的 switch 有 loomy case', () => {
    expect(rpcSource).toMatch(/case LOOMY\.id:[\s\S]{0,200}refreshAccountCredential/)
  })

  it('credits.status / claimAll / balances 各有 loomy 分支', () => {
    // 三个端点各出现一次（加上 account.create / refresh 的分支，总计 >= 5 次）
    const occurrences = rpcSource.split('LOOMY.id').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(5)
  })

  it('新增了 login.sendSms / login.submitSms / onboarding.status / onboarding.claim 端点', () => {
    for (const method of ["'login.sendSms'", "'login.submitSms'", "'onboarding.status'", "'onboarding.claim'"]) {
      expect(rpcSource, `缺少端点 ${method}`).toContain(`case ${method}`)
    }
  })

  /**
   * ⚠️ **永久积分锁定**端点（用户需求：Loomy 先做，CodeBuddy / WorkBuddy 后加）。
   *
   * 三个 provider 共用一个通用端点 `credits.permanentLock`（provider 维度），
   * `loomy.permanentLock` 保留为**同一实现的历史别名** —— 老客户端 bundle 仍在
   * 调它，直接删会让 Loomy 面板的按钮静默失效。
   */
  it('通用端点与 Loomy 历史别名共用同一实现（读 / 写两用）', () => {
    expect(rpcSource).toContain("case 'credits.permanentLock'")
    expect(rpcSource).toContain("case 'loomy.permanentLock'")
    // 走 provider 维度的表，而不是老的单字段方法
    expect(rpcSource).toMatch(/pool\.permanentLocked\(/)
    expect(rpcSource).toMatch(/pool\.setPermanentLocked\(/)
    // locked 省略 = 只读
    expect(rpcSource).toMatch(/req\.locked === undefined/)
    // ⚠️ 老别名必须忽略载荷里的 provider（否则老前端能借它越权改别的 provider）
    expect(rpcSource).toMatch(/method === 'loomy\.permanentLock'/)
  })

  /**
   * ⚠️ 两个 buddy 的响应必须**回传当前生效的窗口天数**。
   *
   * 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端文案若继续用写死的
   * 15 就会出现「提示说只烧 15 天内的、实际按 31 天筛号」。Loomy 没有窗口
   * 概念，故只有 buddy 系带这个字段。
   */
  it('buddy 系的响应回传窗口天数（前端文案据此渲染）', () => {
    expect(rpcSource).toMatch(/provider === CODEBUDDY\.id \|\| provider === WORKBUDDY\.id/)
    expect(rpcSource).toMatch(/windowDays: buddyExpiringWindowDays\(\)/)
    expect(rpcSource).toContain("from './buddy-balance-rank.js'")
    expect(typesSource).toMatch(/interface RpcPermanentLockResponse \{[\s\S]*?windowDays\?: number/)
  })

  /**
   * ⚠️ **TRAE / LobsterAI 也必须回传窗口天数**（2026-10-06 PR !68 审计补齐）。
   *
   * 判据已从「是不是 buddy」改成「**是否按到期时间分桶**」，而这两家走的是同一个
   * `splitBuddyCreditsByExpiry`、同样受 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响。
   *
   * ⚠️ 上面那条用例的正则只覆盖 buddy 那一半：把 `|| provider === TRAE.id
   * || provider === LOBSTERAI.id` 整段删掉，全量单测**照样全绿** —— 而后果是
   * 用户把窗口改成 7 天时，面板仍按默认 15 天渲染文案，与真实判据不一致
   * （提示说只烧 15 天内的、实际按 7 天筛号）。
   */
  it('★ TRAE / LobsterAI 的响应同样回传窗口天数（判据是「按到期时间分桶」）', () => {
    // 取 `usesExpiryWindow` 那一行起算，避免被别处同名字符串匹配到。
    const start = rpcSource.indexOf('const usesExpiryWindow =')
    expect(start, 'jet-hub-rpc.ts 里找不到 usesExpiryWindow').toBeGreaterThan(-1)
    const decl = rpcSource.slice(start, start + 300)
    expect(decl, 'usesExpiryWindow 必须含 TRAE').toContain('provider === TRAE.id')
    expect(decl, 'usesExpiryWindow 必须含 LOBSTERAI').toContain('provider === LOBSTERAI.id')
    // 判据**不是**「是不是 buddy」—— 保留断言防止有人改回旧写法。
    expect(decl).not.toMatch(/isBuddy|=== 'buddy'/)
  })

  it('后端有 provider 白名单，且与 Loomy/Buddy 的支持面一致', () => {
    expect(rpcSource).toMatch(/PERMANENT_LOCK_PROVIDERS[\s\S]{0,200}LOOMY\.id/)
    expect(rpcSource).toContain('CODEBUDDY.id')
    expect(rpcSource).toContain('WORKBUDDY.id')
    expect(rpcSource).toMatch(/PERMANENT_LOCK_PROVIDERS\.has\(provider\)/)
  })

  /**
   * ⚠️ 写锁定会改变**选号结果**，故必须广播 `llm/adapters-updated`
   * （与 `model.setDisabled` 同理，见 AGENTS.md 的对应章节）。
   */
  it('写锁定后广播 llm/adapters-updated，且包 try/catch', () => {
    const start = rpcSource.indexOf("case 'loomy.permanentLock'")
    expect(start).toBeGreaterThan(-1)
    const end = rpcSource.indexOf("case 'onboarding.claim'", start)
    expect(end).toBeGreaterThan(start)
    const body = rpcSource.slice(start, end)
    expect(body).toContain("ctx.emit('llm/adapters-updated')")
    // 通知失败不能反噬已落盘的开关
    expect(body).toMatch(/try \{[\s\S]{0,200}ctx\.emit\([\s\S]{0,300}catch/)
  })

  it('未登记的 provider 调 onboarding.* 时返回可读错误（不是泛化文案）', () => {
    expect(rpcSource).toMatch(/onboarding[\s\S]{0,3000}unsupported provider/)
  })

  it('LOOMY 已导入', () => {
    expect(rpcSource).toContain("from './loomy-product.js'")
  })

  /**
   * ⚠️ 短信登录的 msgid 是**一次性中间态**（5 分钟有效），
   * 不该写进 `ctx.credentials` 污染凭据命名空间。
   */
  it('msgid 用内存暂存表，不写进凭据存储', () => {
    expect(rpcSource).toContain('pendingSmsMsgid')
    expect(rpcSource).toMatch(/pendingSmsMsgid\.set\(/)
  })

  it('短信登录成功后不把 refreshable 置 true（Loomy 不可续期）', () => {
    const start = rpcSource.indexOf("case 'login.submitSms'")
    expect(start).toBeGreaterThan(-1)
    const body = rpcSource.slice(start, start + 3000)
    expect(body).toContain('refreshable: false')
    expect(body).not.toContain('refreshable: true')
  })
})
