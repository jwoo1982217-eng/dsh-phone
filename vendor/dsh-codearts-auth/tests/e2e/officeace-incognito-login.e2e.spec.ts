/**
 * `officeace-incognito-login.e2e.spec.ts` —— **真开浏览器窗口**的验证
 * （华为云换账号登录）。
 *
 * ## 为什么这条必须放 e2e（2026-10-13，用户明确要求）
 *
 * 「打开浏览器窗口的测试只能放在 e2e 里」—— 这是本仓库的架构约束，理由是实测的：
 * 我最初把「`openIncognitoWindow` 不抛错、返回 boolean」写进**单测**，
 * 而该函数会**真的 `spawn` 浏览器可执行文件** ⇒ 每跑一次 `pnpm test` 就在用户
 * 桌面上弹一个窗口。更隐蔽的一处是 `officeace-rpc-multi-account.spec.ts`：
 * 它走**真实的 `account.create` RPC**，桩数据里带
 * `authorizeUrl: 'https://auth.huaweicloud.com/stub'`，于是全量测试一跑，
 * 用户桌面上就多出一堆 `auth.huaweicloud.com/stub` 空白窗口。
 * 用户原话：「打开一堆空白窗口没用，挡我视线会被我关掉」。
 *
 * ⇒ 纪律分为两层：
 * 1. **单测**（`tests/unit/officeace-incognito-login.spec.ts`）只做**源码级断言**
 *    （读文本、判形态），**绝不触发真进程**；且 `src/login.ts` 里有
 *    `NODE_ENV === 'test'` 断路器，保证任何单测路径都不会真开窗。
 * 2. **e2e**（本文件）才允许真开窗，且有**闸门** —— 默认跳过，
 *    CI 与普通 `pnpm test` 都不会弹窗。
 *
 * ## 闸门
 *
 * 需要 `DSH_OFFICEACE_E2E=1`（见 `package.json` 的 `test:e2e:officeace`）。
 * 运行时会真的弹出无痕窗口，需**人工确认它落在华为云登录页**（而不是被
 * 自动放行/直接跳到回调）—— 那正是「换账号登录」是否生效的唯一判据。
 */

import { describe, expect, it } from 'vitest'
import { openIncognitoWindow } from '../../src/login.js'

// 仅在 `pnpm test:e2e:officeace` 下执行（需 DSH_OFFICEACE_E2E=1）；
// 默认跳过，以免 CI 和普通 `pnpm test` 打开浏览器窗口。
const E2E = process.env.DSH_OFFICEACE_E2E === '1'

describe.runIf(E2E)('officeace incognito login e2e', () => {
  /**
   * ⚠️ 人工判据：窗口打开后**必须看到华为云登录框**（二维码 / 手机号 / 密码）。
   *
   * 若看到的是「已自动登录并跳走」，说明无痕隔离**没生效**（退回复用会话），
   * 本用例应判失败 —— 这正是本功能要修的症状本身。
   */
  it('拉起真实无痕窗口并返回 true（人工确认落在华为云登录页）', async () => {
    // 用真实的授权 URL 形态（与本插件 `startLogin` 生成的一致）。
    // ⚠️ 此处**不**向云侧登记新 state —— 本用例只验「窗口能否打开、
    //    是否显示登录框」，不验完整授权链（那需要真实账号，见 README）。
    const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
    const params = new URLSearchParams({
      client_id: 'pdp5_for_agentarts',
      code_challenge: 'e2e-placeholder-challenge-e2e-placeholder',
      code_challenge_method: 'SHA-256',
      // ⚠️ state 必须是 32 位 hex（云侧校验），但本用例不消费它，
      //    故用固定值即可 —— 它只影响登录页是否显示「参数错误」。
      state: '0123456789abcdef0123456789abcdef',
      scope: 'openid',
      redirect_uri: `${CLAW_BASE}/v1/claw/auth/callback`,
      response_type: 'code',
    })
    const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
      `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
    )}`

    console.log(
      '\n[officeace e2e] 即将以**无痕窗口**打开华为云登录页。\n'
      + '请人工确认：窗口里出现的是**登录框**（二维码 / 手机号 / 密码），\n'
      + '而不是「已登录并直接跳走」—— 后者说明无痕隔离没生效（本功能的核心症状）。\n'
      + `授权 URL：${authorizeUrl}\n`,
    )
    const ok = openIncognitoWindow(authorizeUrl)
    expect(ok, '无痕窗口未能拉起（读不到默认浏览器 / spawn 失败）').toBe(true)
    // 给人工确认留出观察时间（e2e 的超时是 240 秒，这里只需几秒）。
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }, 60_000)

  /**
   * ⚠️ **反向用例**：同一个 URL 用**普通**（非无痕）窗口打开时，
   * 华为 authui 会复用已有会话、**看不到登录框**。
   *
   * 这条是「为什么必须无痕」的对照实验 —— 它**故意**复现缺陷形态。
   * 用户若已登录华为云，会观察到窗口直接跳走而非停在登录页。
   * ⚠️ 因为它会开一个普通窗口，同样只在 e2e 闸门下运行。
   */
  it('对照：普通窗口会复用会话（证明无痕是必需的）', async () => {
    const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
    const params = new URLSearchParams({
      client_id: 'pdp5_for_agentarts',
      code_challenge: 'e2e-placeholder-challenge-e2e-placeholder',
      code_challenge_method: 'SHA-256',
      state: '0123456789abcdef0123456789abcdef',
      scope: 'openid',
      redirect_uri: `${CLAW_BASE}/v1/claw/auth/callback`,
      response_type: 'code',
    })
    const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
      `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
    )}`
    console.log(
      '\n[officeace e2e] 对照实验：用**普通**窗口打开同一 URL。\n'
      + '预期：如果你已在浏览器登录过华为云，它会**直接放行**、看不到登录框\n'
      + '（这正是「新建账号却复用旧账号」的根因）。\n',
    )
    // 复用生产实现里的浏览器定位逻辑，但走「普通窗口」形态：
    // 直接用系统默认打开器（`openBrowser`）即可 —— 它开的必然是共享 cookie 的窗口。
    const { openBrowser } = await import('../../src/login.js')
    openBrowser(authorizeUrl)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    expect(true).toBe(true)
  }, 60_000)
})
