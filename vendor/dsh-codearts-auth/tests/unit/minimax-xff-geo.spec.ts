/**
 * MiniMax 国际站 `X-Forwarded-For` 与**地理路由判别**的回归
 * （2026-10-17，Gitee issue IKMEVG）。
 *
 * ## 真机取证（本机实测，用户协助完成国际站授权）
 *
 * `agent.minimax.io` 对**所有**路径恒返 `307 → agent.minimaxi.com`，而是否
 * 307 **由 Akamai 按请求来源 IP 的国别判定**（40 个变体穷举，只有 XFF 有效）：
 *
 * | 来源 IP | 结果 |
 * |---|---|
 * | 美国 `8.8.8.8` / `1.1.1.1`、日本 `133.130.0.1`、新加坡、香港 | **留在国际站（200）** |
 * | 中国 `114.114.114.114` / `223.5.5.5` / `180.76.76.76` | **307 → 中国站** |
 * | 内网 `127.0.0.1` / `10.0.0.1` / `::1`、空值、非法串 | 视为无此头 ⇒ **307** |
 * | `Accept-Language` / `x-mavis-region` / `region` / `?lang=` / UA / Origin / Cookie | **全部 307（无效）** |
 *
 * ⇒ **不是 lang/region 头的问题，是出口 IP 的地理位置**。
 *
 * ## ⚠️ 本文件守的**关键不变式**
 *
 * 1. **XFF 只对 `minimaxintl` 生效** —— 给中国站附这个头纯属伪造来源、无收益；
 * 2. **未设置 ⇒ 一个头都不加**（行为与修复前逐字节一致，老用户零影响）；
 * 3. **非法值绝不进请求头**（CRLF 头注入的防线，两道：store 归一 + 请求侧兜底）；
 * 4. **地理路由必须在跟随之前判** —— 跟到中国站后，国际站 token 得到的
 *    `401 invalid access token` 与「凭据真失效」**逐字同形**，事后无法区分。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MINIMAX_XFF_HEADER,
  describeMinimaxGeoRoute,
  isMinimaxGeoRoute,
  minimaxFetch,
  minimaxHeadersFor,
  minimaxInferHeadersFor,
  withMinimaxXff,
} from '../../src/minimax.js'
import { sanitizeMinimaxXff } from '../../src/jet-hub-store.js'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalance,
} from '../../src/minimax-credits.js'
import { MINIMAX_INTL } from '../../src/minimax-product.js'
import type { MinimaxCredential } from '../../src/minimax.js'

const CRED: MinimaxCredential = { access_token: 'a'.repeat(60), token_type: 'Bearer' }

describe('sanitizeMinimaxXff：只放行 IP 字面量（头注入防线）', () => {
  it('★ 接受合法 IPv4 / IPv6', () => {
    for (const ip of [
      '8.8.8.8', '1.1.1.1', '203.0.113.1', '0.0.0.0', '255.255.255.255',
      '::1', '2001:db8::1', 'fe80::1%eth0', '2606:4700:4700::1111',
    ]) {
      expect(sanitizeMinimaxXff(ip), `${ip} 应被接受`).toBe(ip)
    }
  })

  it('★★ 拒绝 CRLF 等头注入载荷（这是本校验存在的首要理由）', () => {
    for (const bad of [
      '1.2.3.4\r\nX-Evil: 1',
      '1.2.3.4\nX-Evil: 1',
      '1.2.3.4\r',
      '1.2.3.4 X-Evil: 1',
      ' 1.2.3.4\n',
    ]) {
      expect(sanitizeMinimaxXff(bad), `${JSON.stringify(bad)} 应被拒绝`).toBeUndefined()
    }
  })

  it('★★ 拒绝主机名与 XFF 链（本设置只接受单个 IP）', () => {
    for (const bad of [
      'my.proxy.example',
      '8.8.8.8, 1.1.1.1',      // 逗号分隔的链
      '8.8.8.8,1.1.1.1',
      'example.com',
      'localhost',
    ]) {
      expect(sanitizeMinimaxXff(bad), `${bad} 应被拒绝`).toBeUndefined()
    }
  })

  it('拒绝越界 / 畸形 IP', () => {
    for (const bad of [
      '999.1.1.1', '8.8.8', '8.8.8.8.8', '300.0.0.1',
      // ⚠️ IPv6 段数（2026-10-17 审计指出的真实缺口，实现已补校验）：
      //    初版只做形状校验、不数段数 ⇒ 10 段被放行，而 IPv6 最多 8 段。
      '1:2:3:4:5:6:7:8:9:10',   // 10 段，无 :: ⇒ 必须拒
      '1:2:3:4:5:6:7',          // 7 段，无 :: ⇒ 必须拒（不够 8 组）
      '1::2::3',                // :: 出现两次 ⇒ 必须拒
      '12345::1',               // 组内超 4 位十六进制 ⇒ 必须拒
    ]) {
      expect(sanitizeMinimaxXff(bad), `${bad} 应被拒绝`).toBeUndefined()
    }
  })

  it('接受合法 IPv6 段数形态（含 :: 压缩与 zone）', () => {
    for (const ok of [
      '1:2:3:4:5:6:7:8',        // 恰好 8 组
      '::1',                     // 压缩 + 1 组
      '::',                      // 全压缩
      '2001:db8::1',
      'fe80::1%eth0',
      'fe80::1%25eth0',          // 百分号编码形态也放行（值原样透传）
    ]) {
      expect(sanitizeMinimaxXff(ok), `${ok} 应被接受`).toBe(ok)
    }
  })

  /**
   * ⚠️ **这条用例的输入是刻意选的**（2026-10-17 审计指出原输入无牙）：
   *
   * 原输入 `'8.8.8.8'.repeat(30)` 长度 210 > 128，但**即使删掉长度判据**，
   * 它也会被「IPv4 必须四段」判据拒掉 ⇒ 那条用例证明不了长度判据存在。
   *
   * 改用 `fe80::1%` + 130 个字母：含 `%` ⇒ 字符集放宽到字母、IPv6 形状也合法
   * ⇒ **只有**长度判据能拦住它。
   */
  it('超长值被拒绝（>128，用只有长度判据能拦的输入）', () => {
    const zoneTooLong = 'fe80::1%' + 'a'.repeat(130)
    expect(zoneTooLong.length).toBeGreaterThan(128)
    expect(sanitizeMinimaxXff(zoneTooLong), '含 % 且形状合法，只有长度判据能拒')
      .toBeUndefined()
  })

  it('★★ 空串 / 纯空白 / 非字符串 ⇒ undefined（= 不附头）', () => {
    for (const empty of ['', '   ', '\t', undefined, null, 42, {}, []]) {
      expect(sanitizeMinimaxXff(empty)).toBeUndefined()
    }
  })

  it('trim 但**不改写** IP 本身（八进制/缩写原样保留，便于用户对照自己的代理）', () => {
    expect(sanitizeMinimaxXff('  8.8.8.8  ')).toBe('8.8.8.8')
    expect(sanitizeMinimaxXff('2001:DB8::1')).toBe('2001:DB8::1')  // 大小写不折
  })
})

describe('withMinimaxXff：请求头层', () => {
  it('★★ 未设置 ⇒ 不加任何头（老用户行为逐字节不变）', () => {
    for (const none of [undefined, '', '   ']) {
      const h = withMinimaxXff(new Headers(), none)
      expect(h.get(MINIMAX_XFF_HEADER), `xff=${JSON.stringify(none)} 不应加头`).toBeNull()
    }
  })

  it('★ 设置了 ⇒ 加上该头', () => {
    const h = withMinimaxXff(new Headers(), '8.8.8.8')
    expect(h.get(MINIMAX_XFF_HEADER)).toBe('8.8.8.8')
  })

  it('★★ 请求侧**独立**再挡一次 CRLF（即便 store 层被绕过）', () => {
    // 这道是纵深防御：万一有别的写入路径没走 sanitizeMinimaxXff。
    const h = withMinimaxXff(new Headers(), '1.2.3.4\r\nX-Evil: 1')
    expect(h.get(MINIMAX_XFF_HEADER), 'CRLF 值不得进请求头').toBeNull()
    expect(h.get('x-evil')).toBeNull()
  })

  it('不覆盖 Authorization（只加一个头）', () => {
    const base = new Headers({ Authorization: 'Bearer T' })
    const h = withMinimaxXff(base, '8.8.8.8')
    expect(h.get('authorization')).toBe('Bearer T')
    expect(h.get(MINIMAX_XFF_HEADER)).toBe('8.8.8.8')
  })
})

describe('minimaxHeadersFor / minimaxInferHeadersFor：只对国际站生效', () => {
  it('★★ 国际站 ⇒ 带上 XFF', () => {
    const h = minimaxHeadersFor(CRED, '8.8.8.8', 'minimaxintl')
    expect(h.get(MINIMAX_XFF_HEADER)).toBe('8.8.8.8')
    expect(h.get('authorization')).toBe(`Bearer ${CRED.access_token}`)
  })

  it('★★ 中国站 ⇒ **即使传了 XFF 也不加**（它不需要绕过分流）', () => {
    const h = minimaxHeadersFor(CRED, '8.8.8.8', 'minimax')
    expect(h.get(MINIMAX_XFF_HEADER), '中国站不得附加 XFF').toBeNull()
  })

  it('国际站但未设置 XFF ⇒ 不加头', () => {
    expect(minimaxHeadersFor(CRED, undefined, 'minimaxintl').get(MINIMAX_XFF_HEADER)).toBeNull()
  })

  it('推理头同理（国际站带、中国站不带），且保留 Content-Type / Accept', () => {
    const intl = minimaxInferHeadersFor(CRED, '1.1.1.1', 'minimaxintl')
    expect(intl.get(MINIMAX_XFF_HEADER)).toBe('1.1.1.1')
    expect(intl.get('content-type')).toBe('application/json')
    expect(intl.get('accept')).toBe('text/event-stream')

    const cn = minimaxInferHeadersFor(CRED, '1.1.1.1', 'minimax')
    expect(cn.get(MINIMAX_XFF_HEADER)).toBeNull()
  })
})

describe('isMinimaxGeoRoute：跟随**之前**的地理路由判别', () => {
  it('★★ 识别「国际站 307 到中国站」（本机实测的真实形态）', () => {
    expect(isMinimaxGeoRoute(
      'agent.minimax.io',
      307,
      'https://agent.minimaxi.com/minimax-cloud/api/v1/credit/details',
    )).toBe(true)
  })

  it('308 也算（同样是保留方法的永久重定向）', () => {
    expect(isMinimaxGeoRoute(
      'agent.minimax.io', 308, 'https://agent.minimaxi.com/x',
    )).toBe(true)
  })

  it('★★ 反向：非同族主机之间的 307 不算地理路由', () => {
    // 例如 account.minimax.io 的 OAuth 重定向、或任意别的迁移
    expect(isMinimaxGeoRoute('account.minimax.io', 307, 'https://agent.minimaxi.com/x')).toBe(false)
    expect(isMinimaxGeoRoute('agent.minimax.cn', 307, 'https://agent.minimaxi.com/x')).toBe(false)
    expect(isMinimaxGeoRoute('agent.minimax.io', 307, 'https://agent.minimax.io/x')).toBe(false)
    expect(isMinimaxGeoRoute('agent.minimax.io', 307, 'https://example.com/x')).toBe(false)
  })

  it('★★ 反向：非 3xx 状态码不算', () => {
    for (const status of [200, 301, 302, 303, 400, 401]) {
      expect(isMinimaxGeoRoute('agent.minimax.io', status, 'https://agent.minimaxi.com/x'),
        `status=${status} 不应算地理路由`).toBe(false)
    }
  })

  it('无 Location / 非法 Location 不算', () => {
    expect(isMinimaxGeoRoute('agent.minimax.io', 307, null)).toBe(false)
    expect(isMinimaxGeoRoute('agent.minimax.io', 307, '')).toBe(false)
    expect(isMinimaxGeoRoute('agent.minimax.io', 307, '不是URL')).toBe(false)
  })
})

describe('describeMinimaxGeoRoute：必须同时给出两条出路', () => {
  it('★★ 文案包含「X-Forwarded-For」设置与「代理」两条路径（缺一条用户就无法自救）', () => {
    const text = describeMinimaxGeoRoute()
    expect(text).toContain('X-Forwarded-For')
    expect(text).toContain('代理')
    // 必须明确「不是凭据问题」——否则用户会去重登（而重登一百次也没用）
    expect(text).toContain('不是凭据问题')
  })

  /**
   * ⚠️⚠️ **真实缺陷的守卫**（2026-10-17 自查发现，本组用例的存在理由）。
   *
   * `geoRouted` 只表示「这次请求**经历过** 307」，**不表示失败原因就是地理路由**。
   * 实测反例：`307 → 402 insufficient_balance_error`。
   *
   * 旧实现把文案整个换成地理路由说明 ⇒ 用户看到的全是「去填 IP / 走代理」，
   * 而**「去充值」这个唯一有效动作彻底消失** —— 他会一直折腾网络，
   * 永远不知道账号没钱。
   */
  it('★★★ 带业务错误原文时，**原文必须出现**（不能只报地理路由）', () => {
    const text = describeMinimaxGeoRoute('insufficient_balance_error')
    expect(text, '业务错误原文必须保留 —— 否则「去充值」这个动作消失')
      .toContain('insufficient_balance_error')
    // 地理路由的背景解释仍要在（两者共存，不是互相覆盖）
    expect(text).toContain('X-Forwarded-For')
    // ⚠️ 业务错误要排在前面（它是用户当下要做的事）
    expect(text.indexOf('insufficient_balance_error'))
      .toBeLessThan(text.indexOf('X-Forwarded-For'))
  })

  it('无业务错误时只给地理路由说明（不出现「上游还返回了：」这种空壳前缀）', () => {
    for (const empty of [undefined, '', '   ']) {
      const text = describeMinimaxGeoRoute(empty)
      expect(text).not.toContain('上游还返回了')
      expect(text).toContain('X-Forwarded-For')
    }
  })

  it('超长业务错误被截断（它要进 UI 文案）', () => {
    const text = describeMinimaxGeoRoute('x'.repeat(1000))
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(700)
  })
})

/**
 * ⚠️⚠️ **接线守卫**：上面那组只测 `describeMinimaxGeoRoute` 这个**纯函数**，
 * 证明不了「业务入口真的把业务错误传进去了」。
 *
 * 实测教训（本组用例的由来）：把 `requestEnvelope` 里
 * `describeMinimaxGeoRoute(describeMinimaxApiError(record))` 改成
 * `describeMinimaxGeoRoute()`（即不传业务错误）后，纯函数那几条**全绿**
 * 而缺陷已复活 —— 这正是本仓库反复记录的「函数对 ≠ 被用上」形态。
 * 故判据必须打在**业务入口**上。
 */
describe('★★★ 接线：业务入口在 307 → 402 时必须保留业务错误原文', () => {
  /** 先 307、再按给定状态/体应答。 */
  function geoThen(status: number, body: unknown) {
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://agent.minimaxi.com/minimax-cloud/api/v1/x' },
        })
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return fn
  }

  it('★★★ claim：307 → 402 的文案含 `insufficient_balance_error`（否则用户不知道要充值）', async () => {
    const outcome = await claimMinimaxDailyCheckin(
      CRED,
      geoThen(402, { error: 'insufficient_balance_error' }) as unknown as typeof fetch,
      MINIMAX_INTL,
    )
    expect(outcome.kind).toBe('failed')
    expect(outcome.message, '业务错误原文必须保留').toContain('insufficient_balance_error')
    // 地理路由的背景解释仍要在
    expect(outcome.message).toContain('X-Forwarded-For')
  })

  it('★★ claim：307 → 401 的文案含 `invalid access token`（两个原因都要可见）', async () => {
    const outcome = await claimMinimaxDailyCheckin(
      CRED,
      geoThen(401, { error: 'invalid access token' }) as unknown as typeof fetch,
      MINIMAX_INTL,
    )
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('invalid access token')
    expect(outcome.message).toContain('X-Forwarded-For')
  })

  it('★★ 余额入口：307 → 402 时同样判失败（且不静默当成 0）', async () => {
    const balance = await fetchMinimaxCreditBalance(
      CRED,
      geoThen(402, { error: 'insufficient_balance_error' }) as unknown as typeof fetch,
      MINIMAX_INTL,
    )
    expect(balance, '402 是失败，不是「余额 0」').toBeNull()
  })

  it('★ 反向：307 → 200 成功时**不得**被地理路由文案影响（走正常解析）', async () => {
    const balance = await fetchMinimaxCreditBalance(
      CRED,
      geoThen(200, { total_count: 0, base_resp: { status_code: 0 } }) as unknown as typeof fetch,
      MINIMAX_INTL,
    )
    expect(balance).toEqual({ total: 0, packages: [], expiredTotal: 0 })
  })
})

describe('minimaxFetch 的 onGeoRoute：时机必须在跟随**之前**', () => {
  it('★★ 回调在 307 那一跳被调用（此时还没跟到中国站）', async () => {
    const seen = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      if (seen.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://agent.minimaxi.com/minimax-cloud/api/v1/x' },
        })
      }
      return new Response('{"error":"invalid access token"}', { status: 401 })
    }) as unknown as typeof fetch

    let geo = 0
    const res = await minimaxFetch(
      'https://agent.minimax.io/minimax-cloud/api/v1/x',
      () => ({}),
      { fetcher, onGeoRoute: () => { geo += 1 } },
    )

    expect(geo, '应恰好回调一次').toBe(1)
    // 跟随仍然发生了（回调只作记录，不改变控制流）
    expect(res.status).toBe(401)
    expect(seen).toHaveLength(2)
  })

  it('★★ 反向：非地理路由的 307 不触发回调', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://agent.minimax.cn/x' },
    })) as unknown as typeof fetch

    let geo = 0
    await minimaxFetch('https://agent.minimax.io/x', () => ({}), {
      fetcher, onGeoRoute: () => { geo += 1 }, maxHops: 1,
    })
    expect(geo, '同族但非 minimaxi.com 目标，不应算地理路由').toBe(0)
  })

  it('★ 正常 200 不触发回调', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    let geo = 0
    await minimaxFetch('https://agent.minimax.io/x', () => ({}), {
      fetcher, onGeoRoute: () => { geo += 1 },
    })
    expect(geo).toBe(0)
  })
})
