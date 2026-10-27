/**
 * `officeace-credential-health.spec.ts` —— **凭据级熔断**（Gitee issue IKLTHB 第 ③ 条）。
 *
 * ## 背景
 *
 * 2026-10-14 23:13 起 264+ 次连续失败，每一轮都是同一个报文：
 *
 * ```
 * HTTP 401 {"error_msg":"AppKey or AppSecret is invalid","error_code":"APIG.1009"}
 * ```
 *
 * 这是华为 APIG 对 `modelAppKey:modelAppSecret` 的**确定性拒绝**（重发多少次都一样），
 * 而改前**没有任何一层记得住这件事**：折算走的是**另一套 V11 签名鉴权**，
 * 照样读得到余额 ⇒ officeace 留在聚合候选表里（甚至排第一）⇒ 用户每一轮都先撞墙
 * 再改道，还会连带把档位从 `max` 降到 `high`。
 *
 * 本文件守的不变量：
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 只有**确定的凭据拒绝形状**才熔断 | 网关/代理层抖动被放大成「渠道消失」|
 * | 2 | 连续 2 次才熔断 | 一次抖动即熔断 |
 * | 3 | 到期**自动解除**（TTL），且 `0` 可关闭 | 单向门：渠道永久消失，用户看到「有额度却选不到」|
 * | 4 | 成功后清零并删除 | 下一次偶发 401 被算进旧账 |
 * | 5 | 指纹只认 Basic 二元组 | 重新登录造出的**幽灵账号**各撞一次（issue 取证：ref/STS 变了、key 没变）|
 * | 6 | `officeaceExpiry` 在熔断期判 `UNUSABLE`（且**不打**余额请求）| 熔断了却还在候选表里 ⇒ 熔断形同虚设 |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_OFFICEACE_BREAKER_MINUTES,
  OFFICEACE_BREAKER_DEFAULT_MINUTES,
  OFFICEACE_BREAKER_THRESHOLD,
  isBasicCredentialRejection,
  noteOfficeaceRejection,
  noteOfficeaceSuccess,
  officeaceBreakerMinutes,
  officeaceBreakerOpen,
  officeaceBreakerState,
  officeaceCredentialFingerprint,
  resetOfficeaceBreakerForTest,
} from '../../src/officeace-credential-health.js'

/** 真机报文原文（issue IKLTHB 取证）。 */
const REAL_401 = JSON.stringify({ error_msg: 'AppKey or AppSecret is invalid', error_code: 'APIG.1009' })

function cred(key: string, secret: string, extra: Record<string, unknown> = {}) {
  return { modelAppKey: key, modelAppSecret: secret, ...extra }
}

const NOW = Date.UTC(2026, 9, 15, 6, 0, 0)

beforeEach(() => {
  resetOfficeaceBreakerForTest()
})

describe('isBasicCredentialRejection（哪一种 401 才证明「这对 key 是死的」）', () => {
  it('① 真机报文（APIG.1009）⇒ 可熔断', () => {
    expect(isBasicCredentialRejection(401, REAL_401)).toBe(true)
  })

  it('② 只看措辞腿也能认（网关包装层改码时）', () => {
    expect(isBasicCredentialRejection(401, '{"message":"AppKey or AppSecret is invalid"}')).toBe(true)
  })

  it('★ ③ 其它形状的 401 **不得**熔断（宁可多撞一次，不可误伤整渠道）', () => {
    // 网关 / 代理层的 401：HTML 或空体，形状未知。
    expect(isBasicCredentialRejection(401, '<html><body>401 Unauthorized</body></html>')).toBe(false)
    expect(isBasicCredentialRejection(401, '')).toBe(false)
    // APIG.0301 是**管理面** V11 验签失败，与推理用的 Basic 无关。
    expect(isBasicCredentialRejection(401, '{"error_code":"APIG.0301"}')).toBe(false)
  })

  it('★ ④ 报文点名了这对凭据 ⇒ **任何 4xx** 都算（官方文档说 400，真机回 401）', () => {
    // ⚠️ 本条原先**写反了**：标题写着「只认报文，不认状态码」，断言却是
    //    `(400, REAL_401) === false` / `(403, REAL_401) === false` —— 把「钉死 401」
    //    这个缺口当成期望值锁住了。而实现里正是 `if (status !== 401) return false`，
    //    与它自己上面那句「不得依赖状态码」**自相矛盾**（第二轮对抗性审计查出）。
    //    失效方向很实在：华为文档把 APIG.1009 定义为 **400**，一旦网关按文档回 400，
    //    诊断文案与熔断**双双失效**，每轮又白撞一次（正是 issue 第 ③ 条）。
    expect(isBasicCredentialRejection(400, REAL_401)).toBe(true)
    expect(isBasicCredentialRejection(403, REAL_401)).toBe(true)
    // 边界画在**状态类**上，不是枚举码：换个包装层状态码不该漏。
  })

  it('★ ④b **2xx 绝不算**：那时 body 是模型输出，一次成功回答不得熔断整渠道', () => {
    // ⚠️ 这是把下界设在 400 的**唯一**理由，也是本条存在的意义：用户正是在排查这个
    //    错误，模型完全可能原样复述这句报文 —— 若判据不看状态码，一次**成功**的回答
    //    就会让整个渠道「消失 10 分钟」。
    expect(isBasicCredentialRejection(200, REAL_401)).toBe(false)
    expect(isBasicCredentialRejection(200, 'AppKey or AppSecret is invalid')).toBe(false)
  })

  it('★ ④c **5xx 绝不算**：那是基础设施抖动，形状未知（宁可多撞一次，不可误伤）', () => {
    expect(isBasicCredentialRejection(500, REAL_401)).toBe(false)
    expect(isBasicCredentialRejection(503, REAL_401)).toBe(false)
  })
})

describe('凭据指纹（重新登录造出的幽灵账号必须一起熔断）', () => {
  it('★ ① 同一对 key/secret、不同 STS/accountId ⇒ **同一个**指纹（issue 取证的核心）', () => {
    // 取证：重新登录换掉了 credentialRef（OFFICEACE_ACCOUNT_651558E5 → F1557964）、
    // 换掉了整条 STS 三元组，却让 modelAppKey/modelAppSecret 逐字节不变。
    const before = cred('ffff8ba7', 'bd4da972', { access: 'OLD', securityToken: 'OLD' })
    const after = cred('ffff8ba7', 'bd4da972', { access: 'NEW', securityToken: 'NEW' })
    expect(officeaceCredentialFingerprint(before)).toBe(officeaceCredentialFingerprint(after))
    // 指纹是哈希切片，不是原文（否则 modelAppSecret 会以明文多留一份在进程里）。
    expect(officeaceCredentialFingerprint(before)).toMatch(/^[0-9a-f]{16}$/)
    expect(officeaceCredentialFingerprint(before)).not.toContain('ffff8ba7')
  })

  it('② 换了 key 或 **secret** ⇒ 不同指纹（该重试）', () => {
    const base = cred('k', 's')
    expect(officeaceCredentialFingerprint(cred('k2', 's'))).not.toBe(officeaceCredentialFingerprint(base))
    expect(officeaceCredentialFingerprint(cred('k', 's2'))).not.toBe(officeaceCredentialFingerprint(base))
  })

  it('③ 取不到 Basic 二元组 ⇒ 空指纹（此时**不参与**熔断）', () => {
    expect(officeaceCredentialFingerprint(undefined)).toBe('')
    expect(officeaceCredentialFingerprint({ modelAppKey: '', modelAppSecret: 's' })).toBe('')
    expect(officeaceCredentialFingerprint({ modelAppKey: 'k', modelAppSecret: '' })).toBe('')
    // 空指纹 ⇒ 记账与查询都是惰性的（把整池一起熔断是过度反应）。
    expect(noteOfficeaceRejection({ modelAppKey: '', modelAppSecret: '' })).toEqual({ open: false, consecutive: 0 })
    expect(officeaceBreakerOpen({ modelAppKey: '', modelAppSecret: '' })).toBe(false)
  })
})

describe('熔断生命周期', () => {
  it('★ ① 连续 2 次（阈值）才熔断，第 1 次不熔断', () => {
    expect(OFFICEACE_BREAKER_THRESHOLD).toBe(2)
    const c = cred('k', 's')
    expect(noteOfficeaceRejection(c, REAL_401, NOW)).toEqual({ open: false, consecutive: 1 })
    expect(officeaceBreakerOpen(c, NOW)).toBe(false)
    expect(noteOfficeaceRejection(c, REAL_401, NOW)).toEqual({ open: true, consecutive: 2 })
    expect(officeaceBreakerOpen(c, NOW)).toBe(true)
  })

  it('② 剩余时长 = 默认 10 分钟，且带出「最近一次报文」供诊断', () => {
    const c = cred('k', 's')
    noteOfficeaceRejection(c, REAL_401, NOW)
    noteOfficeaceRejection(c, REAL_401, NOW)
    const state = officeaceBreakerState(c, NOW)
    expect(state.remainingMs).toBe(OFFICEACE_BREAKER_DEFAULT_MINUTES * 60_000)
    expect(state.lastReason).toContain('APIG.1009')
  })

  it('★★ ③ TTL 到期**自动解除**（本仓库的「单向门」红线）', () => {
    const c = cred('k', 's')
    noteOfficeaceRejection(c, REAL_401, NOW)
    noteOfficeaceRejection(c, REAL_401, NOW)
    const ttl = OFFICEACE_BREAKER_DEFAULT_MINUTES * 60_000
    expect(officeaceBreakerOpen(c, NOW + ttl - 1), 'TTL 内应仍熔断').toBe(true)
    expect(officeaceBreakerOpen(c, NOW + ttl), '到期即解除（不需要清理任务）').toBe(false)
  })

  it('★ ③b 半开：到期后再失败一次 ⇒ **立刻**重新熔断（而不是再攒 2 次）', () => {
    const c = cred('k', 's')
    noteOfficeaceRejection(c, REAL_401, NOW)
    noteOfficeaceRejection(c, REAL_401, NOW)
    const ttl = OFFICEACE_BREAKER_DEFAULT_MINUTES * 60_000
    const later = NOW + ttl + 1
    expect(officeaceBreakerOpen(c, later)).toBe(false)
    expect(noteOfficeaceRejection(c, REAL_401, later)).toEqual({ open: true, consecutive: 3 })
    expect(officeaceBreakerOpen(c, later)).toBe(true)
  })

  it('★ ④ 成功后清零并**删除**记录（阈值不会退化成 1）', () => {
    const c = cred('k', 's')
    noteOfficeaceRejection(c, REAL_401, NOW)
    noteOfficeaceRejection(c, REAL_401, NOW)
    expect(officeaceBreakerOpen(c, NOW)).toBe(true)
    noteOfficeaceSuccess(c)
    expect(officeaceBreakerOpen(c, NOW)).toBe(false)
    // 关键：删除而不是留一条 `consecutive: 1`，否则下一次偶发 401 会直接熔断。
    expect(noteOfficeaceRejection(c, REAL_401, NOW)).toEqual({ open: false, consecutive: 1 })
    expect(officeaceBreakerOpen(c, NOW)).toBe(false)
  })

  it('⑤ 不同凭据互不影响（熔断是凭据级，不是 provider 级）', () => {
    noteOfficeaceRejection(cred('k1', 's'), REAL_401, NOW)
    noteOfficeaceRejection(cred('k1', 's'), REAL_401, NOW)
    expect(officeaceBreakerOpen(cred('k1', 's'), NOW)).toBe(true)
    expect(officeaceBreakerOpen(cred('k2', 's'), NOW)).toBe(false)
  })

  it('★ ⑥ `DSH_OFFICEACE_BREAKER_MINUTES=0` = 关闭熔断，且**立刻**放行已在熔断中的记录', () => {
    const c = cred('k', 's')
    const env = { [DSH_OFFICEACE_BREAKER_MINUTES]: '0' }
    expect(officeaceBreakerMinutes(env)).toBe(0)
    expect(noteOfficeaceRejection(c, REAL_401, NOW, env), '关闭时不熔断').toEqual({ open: false, consecutive: 1 })
    // ⚠️ 第 2 次也**必须带 env**：原先这里（已删）漏传 env ⇒「攒到阈值那一刻」永远走的是
    //    默认 10 分钟那条腿 ⇒ 把 `minutes > 0 &&` 整条删掉（变异 q）**15 条单测全绿**
    //    （第二轮对抗性审计实测 d 类无牙）。返回值说 `open: true` 本身是错的：
    //    即便 `until` 恰好等于 `now`（随后立刻判关），将来谁消费这个返回值就会误判。
    expect(noteOfficeaceRejection(c, REAL_401, NOW, env), '关闭时攒到阈值也不许说 open')
      .toEqual({ open: false, consecutive: 2 })
    expect(officeaceBreakerOpen(c, NOW, env)).toBe(false)
    // 已在熔断中的记录也要立刻放行（否则「改配置不生效、得等 10 分钟」）
    const opened = cred('k9', 's')
    noteOfficeaceRejection(opened, REAL_401, NOW)
    expect(noteOfficeaceRejection(opened, REAL_401, NOW), '默认设置下阈值 2 就该熔断')
      .toEqual({ open: true, consecutive: 2 })
    expect(officeaceBreakerOpen(opened, NOW)).toBe(true)
    expect(officeaceBreakerOpen(opened, NOW, env)).toBe(false)
  })

  it('★ ⑦ 非法/缺省值回落默认；`0` **不得**被 falsy 陷阱换成默认', () => {
    // ⚠️ 与 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 同一个坑：`Number(x) || default` 会把
    //    合法的 0 静默换成默认值。
    expect(officeaceBreakerMinutes({})).toBe(OFFICEACE_BREAKER_DEFAULT_MINUTES)
    expect(officeaceBreakerMinutes({ [DSH_OFFICEACE_BREAKER_MINUTES]: '' })).toBe(OFFICEACE_BREAKER_DEFAULT_MINUTES)
    expect(officeaceBreakerMinutes({ [DSH_OFFICEACE_BREAKER_MINUTES]: 'abc' })).toBe(OFFICEACE_BREAKER_DEFAULT_MINUTES)
    expect(officeaceBreakerMinutes({ [DSH_OFFICEACE_BREAKER_MINUTES]: '-1' })).toBe(OFFICEACE_BREAKER_DEFAULT_MINUTES)
    expect(officeaceBreakerMinutes({ [DSH_OFFICEACE_BREAKER_MINUTES]: ' 3 ' })).toBe(3)
    expect(officeaceBreakerMinutes({ [DSH_OFFICEACE_BREAKER_MINUTES]: '0' })).toBe(0)
  })
})

/**
 * ⚠️ **折算层的接线**（「熔断 ⇒ 候选表里没有它」）在 `officeace-expiry.spec.ts` 里，
 * 因为那里已经有 `fetchSubscriptionSummary` 的 mock 基础设施。本文件只测熔断表本身。
 */
