/**
 * **AutoClaw 国际版「查对站」守卫**（2026-10-20 审计补，P1）。
 *
 * ## 为什么必须单独一份
 *
 * PR121 自己在注释里把「漏传 `product` 会静默查错站」列为**头号陷阱**，
 * 但审计实测：把三处 `AUTOCLAW_INTL` 分别改成 `AUTOCLAW`（或删掉 `product` 实参），
 * **9 个 spec / 545 passed 全绿**。连 `AUTOCLAW_INTL.apiBase` 改成国内基址也
 * **407 passed 全绿**。
 *
 * 根因：`credits-runtime-parity.spec.ts` 的 `BALANCE_PATH_OF` 只比对**路径**
 *（`/agent-assetmgr/api/v1/wallets_std` 之类），而两站**路径完全相同** ——
 * 主机才是唯一的判别维度，而**没有任何用例断言主机**。
 * 对照 `tests/unit/minimax-intl.spec.ts` 逐端点断言 `agent.minimax.io`，
 * autoclaw 缺一份等价 spec。
 *
 * ## 本文件的判据（打**行为**，不打源码文本）
 *
 * 1. `AUTOCLAW_INTL.apiBase` 的主机名**逐字**是国际站，且与国内不同；
 * 2. 通过 `credits.balances` 走**真实端点路径**，断言请求**真的打到**国际站主机；
 * 3. 通过 `provider-expiry` 的折算路径，断言它也用国际站主机
 *    （这条是「漏传 product」最隐蔽的一处 —— 折算恒 `UNUSABLE` 时静默）。
 *
 * ⚠️ 判据必须读**请求 URL 的主机**，不能读「有没有发请求」：
 *    查错站同样会发请求，只是打到 `autoglm-acceleration-api.zhipuai.cn`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOCLAW, AUTOCLAW_INTL, AUTOCLAW_INTL_API_BASE, AUTOCLAW_API_BASE } from '../../src/autoclaw-product.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'
import { AccountPool } from '../../src/account-pool.js'

let isolatedHome: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-intl-site-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
  clearProviderRuntimes()
})

afterEach(() => {
  clearProviderRuntimes()
  if (previousHome === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousHome
  rmSync(isolatedHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const INTL_HOST = 'autoglm-api.autoglm.ai'
const CN_HOST = 'autoglm-acceleration-api.zhipuai.cn'

describe('AutoClaw 两站的基址必须物理隔离', () => {
  it('★ AUTOCLAW_INTL.apiBase 的主机名必须是国际站（且与国内不同）', () => {
    // ⚠️ 原仓库只断言了 `AUTOCLAW.apiBase`（`autoclaw.spec.ts:734`），
    //    国际版这条**从未被断言** ⇒ 改成国内基址 407 条全绿（审计实测）。
    expect(new URL(AUTOCLAW_INTL.apiBase).host).toBe(INTL_HOST)
    expect(new URL(AUTOCLAW.apiBase).host).toBe(CN_HOST)
    expect(
      AUTOCLAW_INTL.apiBase,
      '★ 两站基址必须不同 —— 相同时「漏传 product」就再也查不出来',
    ).not.toBe(AUTOCLAW.apiBase)
    expect(AUTOCLAW_INTL_API_BASE).toBe(AUTOCLAW_INTL.apiBase)
    expect(AUTOCLAW_API_BASE).toBe(AUTOCLAW.apiBase)
  })

  it('★ 两站的 userData 目录必须不同（三个读点共用这一处真相源）', () => {
    // ⚠️ 这是 P0 的根因字段：登录页 `/autoclaw/import-local` 与 `resolveDeviceId`
    //    原先各自写死国内目录。收进产品配置后，两站**必须**不同。
    expect(AUTOCLAW_INTL.userDataDirName).toBe('AutoClaw-oversea-official')
    expect(AUTOCLAW.userDataDirName).toBe('AutoClaw-official')
    expect(AUTOCLAW_INTL.userDataDirName).not.toBe(AUTOCLAW.userDataDirName)
  })

  it('★ 凭据 ref 前缀必须分属两个命名空间（否则账号归属会判错）', () => {
    expect(AUTOCLAW_INTL.defaultCredentialRef.startsWith('AUTOCLAWINTL_')).toBe(true)
    expect(AUTOCLAW.defaultCredentialRef.startsWith('AUTOCLAW_')).toBe(true)
    // ⚠️ `AUTOCLAWINTL` 以 `AUTOCLAW` 开头（超串），故这里只断言**不相同**。
    expect(AUTOCLAW_INTL.defaultCredentialRef).not.toBe(AUTOCLAW.defaultCredentialRef)
  })
})

describe('积分端点：国际版必须真的打到国际站主机', () => {
  it('★ credits.balances("autoclawintl") 的请求 URL 主机是国际站', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      urls.push(String(input))
      // 返回一个「读得到但空」的合法响应，避免重试/回退干扰。
      return new Response(JSON.stringify({ code: 0, data: { total_balance: 0, wallets: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const credits = createProviderCredits()
    const entry = credits.autoclawintl
    expect(entry, 'autoclawintl 必须登记积分能力').toBeDefined()

    // ⚠️ 必须走**真实**的 fetchBalanceDetailed —— 那正是「漏传 product」的现场。
    await entry!.fetchBalanceDetailed({ access_token: 'tok', device_id: 'dev' } as never)

    expect(urls.length, '★ 必须真的发过请求（否则下面关于主机的断言是恒真的）')
      .toBeGreaterThan(0)
    const hosts = urls.map((u) => new URL(u).host)
    expect(
      hosts.every((h) => h === INTL_HOST),
      `★ 所有请求必须打到国际站 ${INTL_HOST}，实际：${[...new Set(hosts)].join(', ')}`
      + '（打到国内站 = 漏传 product，症状是 410000 且日志零字）',
    ).toBe(true)
  })

  it('★ 反向对照：国内版必须打到国内站（证明上一条不是恒真）', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ code: 0, data: { total_balance: 0, wallets: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const credits = createProviderCredits()
    await credits.autoclaw!.fetchBalanceDetailed({ access_token: 'tok', device_id: 'dev' } as never)

    const hosts = urls.map((u) => new URL(u).host)
    expect(hosts.length).toBeGreaterThan(0)
    expect(
      hosts.every((h) => h === CN_HOST),
      `国内版必须打到 ${CN_HOST}，实际：${[...new Set(hosts)].join(', ')}`,
    ).toBe(true)
  })
})

describe('聚合折算：国际版的 expiry 也必须打到国际站主机', () => {
  it('★ provider-expiry 的 autoclawintl 折算请求主机是国际站', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ code: 0, data: { total_balance: 0, wallets: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const expiry = createProviderExpiry()
    const entry = expiry.autoclawintl
    expect(entry, 'autoclawintl 必须登记临期折算能力').toBeDefined()

    await entry!.credentialExpiry({ access_token: 'tok', device_id: 'dev' } as never, undefined)

    expect(urls.length, '★ 必须真的发过请求').toBeGreaterThan(0)
    const hosts = urls.map((u) => new URL(u).host)
    expect(
      hosts.every((h) => h === INTL_HOST),
      `★ 折算必须用国际站基址（漏传 product ⇒ 恒 UNUSABLE ⇒ 聚合轮换里静默不可见），`
      + `实际：${[...new Set(hosts)].join(', ')}`,
    ).toBe(true)
  })
})
