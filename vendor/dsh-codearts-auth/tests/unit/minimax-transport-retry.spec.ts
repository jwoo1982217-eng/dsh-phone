import { describe, expect, it, vi } from 'vitest'
import {
  MINIMAX_TRANSPORT_RETRIES,
  isMinimaxTransportError,
  minimaxFetchWithRetry,
} from '../../src/minimax.js'

/**
 * MiniMax **传输级重试**的回归（2026-10-15 真实缺陷）。
 *
 * ## 真实缺陷
 *
 * 用户报障：「模型连接测试失败，显示 `fetch failed`」「积分查询及领取失败」。
 * 本机实测（同一凭据、同一端点、连打 10 次）：
 * ```
 * 签到 (signin/status): 成功 5/10 —— 失败全是
 *   fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
 * 目录 (models)       : 成功 10/10
 * ```
 * ⇒ 环境里的 **HTTPS 检查代理**（企业 / 杀软 / Clash 的 MITM 证书）约 **50%** 概率
 * 打断请求。这是**环境问题**，但症状落在插件上：一次偶发中断 = 整轮失败。
 * 重试一次几乎必然成功 ⇒ 本模块给它加传输级重试。
 *
 * ## ⚠️ 本文件守的**边界**（比「能重试」更重要）
 *
 * 1. **只重试传输错误**，绝不重试 HTTP 状态错误 —— 4xx/5xx 是服务端的**明确答复**
 *    （401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因；
 * 2. **abort 绝不重试** —— 用户点了停止还继续发是**不可接受**的行为；
 * 3. **真因在 `cause` 里** —— undici 把底层错误包成一句 `TypeError: fetch failed`，
 *    判据必须沿 `cause` 链找，只读 `message` 会漏掉 `SELF_SIGNED_CERT_IN_CHAIN`；
 * 4. **重试耗尽时抛最后一次的原错误对象** —— 保住 `cause` 链，真因仍可见
 *    （换成自定义文案会让用户再也看不到「自签证书」这类唯一出路）。
 */

/** 造一个 undici 形状的 `fetch failed`（真因挂在 `cause` 上）。 */
function fetchFailedWith(cause: NodeJS.ErrnoException): TypeError {
  return new TypeError('fetch failed', { cause })
}

/** 代理证书抖动：真因是自签证书（本机实测的失败形态）。 */
function selfSignedCause(): NodeJS.ErrnoException {
  const e = new Error('self-signed certificate in certificate chain') as NodeJS.ErrnoException
  e.code = 'SELF_SIGNED_CERT_IN_CHAIN'
  return e
}

describe('isMinimaxTransportError：判「要不要重发」', () => {
  it('★ 认 undici 的 `fetch failed`（真因在 cause 里）', () => {
    expect(isMinimaxTransportError(fetchFailedWith(selfSignedCause()))).toBe(true)
  })

  it('★ 认 cause 链上的 `SELF_SIGNED_CERT_IN_CHAIN`（本机真实失败形态）', () => {
    // 多层包裹：真实环境里 undici 可能再套一层。
    const wrapped = new Error('outer', { cause: fetchFailedWith(selfSignedCause()) })
    expect(isMinimaxTransportError(wrapped)).toBe(true)
  })

  it('认 undici 的 `UND_ERR_*` 错误码族（含 name 与 code 两种载体）', () => {
    const byName = new Error('socket') as Error & { name: string }
    byName.name = 'UND_ERR_SOCKET'
    expect(isMinimaxTransportError(byName)).toBe(true)
    const byCode = new Error('timeout') as NodeJS.ErrnoException
    byCode.code = 'UND_ERR_CONNECT_TIMEOUT'
    expect(isMinimaxTransportError(byCode)).toBe(true)
  })

  it('认连接类错误码（ECONNRESET / ETIMEDOUT / EAI_AGAIN…）', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      const e = new Error('x') as NodeJS.ErrnoException
      e.code = code
      expect(isMinimaxTransportError(e), `${code} 应判为传输错误`).toBe(true)
    }
  })

  it('认 `socket hang up` / `terminated` / `other side closed` 文案', () => {
    for (const message of ['socket hang up', 'terminated', 'other side closed']) {
      expect(isMinimaxTransportError(new Error(message)), `${message} 应判为传输错误`).toBe(true)
    }
  })

  /**
   * ★★ **反向：非传输错误不得被判成传输错误** —— 否则 4xx 也会被重发。
   */
  it('★★ 普通 Error（无传输特征）**不是**传输错误', () => {
    expect(isMinimaxTransportError(new Error('minimax: HTTP 402 — insufficient balance'))).toBe(false)
    expect(isMinimaxTransportError(new Error('minimax: credential expired'))).toBe(false)
    expect(isMinimaxTransportError(undefined)).toBe(false)
    expect(isMinimaxTransportError(null)).toBe(false)
    expect(isMinimaxTransportError('fetch failed')).toBe(false) // 裸字符串不算（无法确认是传输层）
  })

  it('⚠️ 沿 cause 链查找时防环（自引用不得死循环）', () => {
    const e = new Error('loop') as Error & { cause?: unknown }
    e.cause = e
    expect(isMinimaxTransportError(e)).toBe(false)
  })
})

describe('minimaxFetchWithRetry：重试策略', () => {
  it('★ 首次成功即返回（不发多余请求）', async () => {
    const once = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const res = await minimaxFetchWithRetry(once)
    expect(res.status).toBe(200)
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('★★ 传输错误重试后成功（本缺陷的修复本体）', async () => {
    const once = vi.fn()
      .mockRejectedValueOnce(fetchFailedWith(selfSignedCause()))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await minimaxFetchWithRetry(once)
    expect(res.status).toBe(200)
    expect(once).toHaveBeenCalledTimes(2)
  })

  it('★★ **HTTP 状态错误类异常不重试**（4xx/5xx 是服务端明确答复）', async () => {
    // 一个**非**传输错误：即便抛了，也只发一次。
    const once = vi.fn().mockRejectedValue(new Error('minimax: HTTP 402 — insufficient balance'))
    await expect(minimaxFetchWithRetry(once)).rejects.toThrow('HTTP 402')
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('★★ **abort 不重试**（用户点了停止还继续发是不可接受的）', async () => {
    const controller = new AbortController()
    controller.abort()
    const once = vi.fn().mockImplementation(() => {
      throw fetchFailedWith(selfSignedCause())
    })
    await expect(minimaxFetchWithRetry(once, controller.signal)).rejects.toThrow()
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('★ 重试耗尽时共发 `1 + MINIMAX_TRANSPORT_RETRIES` 次，且抛**最后一次的原错误**', async () => {
    const cause = selfSignedCause()
    const lastError = fetchFailedWith(cause)
    const once = vi.fn().mockRejectedValue(lastError)
    await expect(minimaxFetchWithRetry(once)).rejects.toBe(lastError)
    expect(once).toHaveBeenCalledTimes(1 + MINIMAX_TRANSPORT_RETRIES)
  })

  it('★★ 重试耗尽后错误对象**保住 cause 链**（真因仍可见，不被替换成自定义文案）', async () => {
    const once = vi.fn().mockRejectedValue(fetchFailedWith(selfSignedCause()))
    const error = await minimaxFetchWithRetry(once).catch((e: unknown) => e as Error)
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('SELF_SIGNED_CERT_IN_CHAIN')
  })

  it('支持自定义重试次数（0 = 不重试，只发一次）', async () => {
    const once = vi.fn().mockRejectedValue(fetchFailedWith(selfSignedCause()))
    await expect(minimaxFetchWithRetry(once, undefined, 0)).rejects.toThrow()
    expect(once).toHaveBeenCalledTimes(1)
  })
})
