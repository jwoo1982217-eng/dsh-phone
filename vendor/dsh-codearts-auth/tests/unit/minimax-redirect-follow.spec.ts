/**
 * MiniMax **保凭据跟随重定向**的回归（2026-10-17 真实缺陷，Gitee issue IKMEVG）。
 *
 * ## 真实缺陷
 *
 * 用户报障：「minimax 国际版登录无法查询余额，领取积分失败，疑似授权不成功」。
 * 面板三条症状：积分行「余额查询失败」、「一键领取积分」报
 * `签到响应缺少有效的 claim_result`、账号却显示「已启用」。
 *
 * 本机取证：
 * ```
 * GET https://agent.minimax.io/minimax-cloud/api/v1/credit/details
 *   → 307 Location: https://agent.minimaxi.com/…
 * ```
 * 而按 fetch 规范**跨 origin 重定向会移除 `Authorization`**（本文件用本机
 * 双端口实验锁住这条行为）⇒ 第二跳无凭据 ⇒ ALB 回
 * `400 {"error":"invalid signature"}`。
 *
 * ⚠️ 那个 400 与「**完全不发 token**」**同形**，所以看起来像「凭据无效」。
 * 决定性反证：手动跟随并保留 `Authorization` 后，签到 / 积分 / 推理**全部 200**。
 *
 * ## 本文件守的四条边界
 *
 * 1. **每一跳都重新附凭据** —— 这是修复本体，也是最容易写错的地方
 *    （把 `buildInit` 的结果缓存一份就退化成 fetch 的默认行为）；
 * 2. **只跟可信主机** —— 跟随 3xx 等于把 `Authorization` 发到服务端指定的任意
 *    主机，必须白名单 + 防仿冒（`evil-minimax.io`）；
 * 3. **307/308 保留方法与 body**（301/302/303 按规范降级 GET）；
 * 4. **abort 不继续跟随**、跳数有上限、不可信/超限时**原样返回 3xx**
 *    （绝不假装成功）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  MINIMAX_REDIRECT_MAX_HOPS,
  isMinimaxTrustedHost,
  minimaxFetch,
  minimaxFetchFollowRedirects,
} from '../../src/minimax.js'

/** 造一个 3xx 响应。 */
function redirectTo(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location } })
}

/** 造一个 200 响应。 */
function ok(body = '{"ok":true}'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('isMinimaxTrustedHost：跟随即信的安全闸门', () => {
  it('★ 放行本家自有域（实测出现过的全部主机）', () => {
    for (const host of [
      'agent.minimax.io',
      'account.minimax.io',
      'agent.minimax.cn',
      'agent.minimaxi.com',
      'account-test.xaminim.com',
    ]) {
      expect(isMinimaxTrustedHost(host), `${host} 应可信`).toBe(true)
    }
  })

  it('★★ 拒绝仿冒域（不能用 includes 判）', () => {
    for (const host of [
      'evil-minimax.io',        // 前缀仿冒：includes('minimax.io') 会误放行
      'minimax.io.evil.com',    // 后缀仿冒
      'notminimax.cn',
      'minimaxi.com.evil',
      'evil.com',
      '',
    ]) {
      expect(isMinimaxTrustedHost(host), `${host} 不应可信`).toBe(false)
    }
  })

  it('大小写与空白归一（上游可能给 `AGENT.MINIMAX.IO`）', () => {
    expect(isMinimaxTrustedHost('AGENT.MINIMAX.IO')).toBe(true)
    expect(isMinimaxTrustedHost('  agent.minimax.io  ')).toBe(true)
  })
})

describe('minimaxFetchFollowRedirects：保凭据跟随', () => {
  it('★★ 修复本体：每一跳都重新附上 Authorization（不是只带第一跳）', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seen.push({ url, auth: headers.get('authorization') })
      if (seen.length === 1) return redirectTo('https://agent.minimaxi.com/second')
      return ok()
    }) as unknown as typeof fetch

    const res = await minimaxFetchFollowRedirects(
      'https://agent.minimax.io/first',
      () => ({ headers: { Authorization: 'Bearer TOKEN-1' } }),
      fetcher,
    )

    expect(res.status).toBe(200)
    expect(seen).toHaveLength(2)
    // 第一跳
    expect(seen[0]!.url).toBe('https://agent.minimax.io/first')
    expect(seen[0]!.auth).toBe('Bearer TOKEN-1')
    // ★★ 第二跳（跨 origin）**必须仍带凭据** —— fetch 自动跟随在这里会给出 null
    expect(seen[1]!.url).toBe('https://agent.minimaxi.com/second')
    expect(seen[1]!.auth).toBe('Bearer TOKEN-1')
  })

  it('★★ 必须传 `redirect: manual`（否则 fetch 自己跟并剥头，修法失效）', async () => {
    const inits: RequestInit[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {})
      if (inits.length === 1) return redirectTo('https://agent.minimaxi.com/x')
      return ok()
    }) as unknown as typeof fetch

    await minimaxFetchFollowRedirects(
      'https://agent.minimax.io/a',
      () => ({ headers: { Authorization: 'Bearer T' } }),
      fetcher,
    )
    expect(inits[0]?.redirect).toBe('manual')
  })

  it('★★ 307 保留 POST 方法与 body（跟随不得把它降级成 GET）', async () => {
    const calls: Array<{ method?: string; body?: unknown }> = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body })
      if (calls.length === 1) return redirectTo('https://agent.minimaxi.com/messages')
      return ok()
    }) as unknown as typeof fetch

    const buildInit = (): RequestInit => ({
      method: 'POST',
      body: '{"model":"MiniMax-M2.7"}',
      headers: { Authorization: 'Bearer T' },
    })
    await minimaxFetchFollowRedirects('https://agent.minimax.io/messages', buildInit, fetcher)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.method).toBe('POST')
    // ⚠️ 原样透传：buildInit 每跳重新给同一份 body
    expect(calls[1]?.method).toBe('POST')
    expect(calls[1]?.body).toBe('{"model":"MiniMax-M2.7"}')
  })

  it('★ 非 3xx 直接返回（200 不走跟随逻辑）', async () => {
    const fetcher = vi.fn(async () => ok()) as unknown as typeof fetch
    const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/x', () => ({}), fetcher)
    expect(res.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('★★ 不可信主机**不跟随**，原样返回 3xx（绝不假装成功）', async () => {
    const fetcher = vi.fn(async () => redirectTo('https://evil.com/steal')) as unknown as typeof fetch
    const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/x', () => ({}), fetcher)
    expect(res.status).toBe(307)
    // 只发了第一跳 —— 凭据没有外泄
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('非 https 的 Location 不跟随（防降级到明文）', async () => {
    const fetcher = vi.fn(async () => redirectTo('http://agent.minimaxi.com/x')) as unknown as typeof fetch
    const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/x', () => ({}), fetcher)
    expect(res.status).toBe(307)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('★ 无 Location 头时返回原 3xx（不做无意义重发）', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 307 })) as unknown as typeof fetch
    const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/x', () => ({}), fetcher)
    expect(res.status).toBe(307)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('★★ 跳数上限：无限重定向环不得死循环，超限返回最后一个 3xx', async () => {
    const fetcher = vi.fn(async () => redirectTo('https://agent.minimax.io/loop')) as unknown as typeof fetch
    const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/loop', () => ({}), fetcher)
    expect(res.status).toBe(307)
    // 首发 + maxHops 次跟随
    expect(fetcher).toHaveBeenCalledTimes(1 + MINIMAX_REDIRECT_MAX_HOPS)
  })

  it('★★ abort 后不再继续跟随（用户点了停止还继续发是不可接受的）', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async () => {
      controller.abort() // 第一跳后就取消
      return redirectTo('https://agent.minimaxi.com/next')
    }) as unknown as typeof fetch

    const res = await minimaxFetchFollowRedirects(
      'https://agent.minimax.io/x',
      () => ({}),
      fetcher,
      controller.signal,
    )
    expect(res.status).toBe(307)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('相对 Location 按当前跳解析（`/a/b` 形态）', async () => {
    const urls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (urls.length === 1) return redirectTo('/relative/path')
      return ok()
    }) as unknown as typeof fetch

    await minimaxFetchFollowRedirects('https://agent.minimax.io/base/x', () => ({}), fetcher)
    expect(urls[1]).toBe('https://agent.minimax.io/relative/path')
  })

  it('301/302/303 也跟随（本家目前只出现 307，但跟随逻辑要覆盖规范）', async () => {
    for (const status of [301, 302, 303, 308]) {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(redirectTo('https://agent.minimaxi.com/next', status))
        .mockResolvedValueOnce(ok()) as unknown as typeof fetch
      const res = await minimaxFetchFollowRedirects('https://agent.minimax.io/x', () => ({}), fetcher)
      expect(res.status, `status=${status} 应被跟随`).toBe(200)
    }
  })
})

describe('minimaxFetch：重试与跟随的**顺序**（漏任一层都是静默失效）', () => {
  it('★★ 传输错误发生在**第二跳**时仍会被重试（重试罩住整条链）', async () => {
    let hop = 0
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect !== 'manual') throw new Error('必须 manual')
      hop += 1
      // 第 1 跳正常 307；第 2 跳传输失败；第 3 跳成功。
      if (hop === 1) return redirectTo('https://agent.minimaxi.com/second')
      if (hop === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })
      return ok()
    }) as unknown as typeof fetch

    const res = await minimaxFetch(
      'https://agent.minimax.io/first',
      () => ({ headers: { Authorization: 'Bearer T' } }),
      { fetcher, retries: 2 },
    )
    expect(res.status).toBe(200)
    // 1 跳 + (失败 + 重试成功) ⇒ 3 次
    expect(hop).toBe(3)
  })

  it('★ 4xx 是明确答复，**不重试**（重发只会掩盖真因）', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"invalid signature"}', { status: 400 })) as unknown as typeof fetch
    const res = await minimaxFetch('https://agent.minimax.io/x', () => ({}), { fetcher, retries: 2 })
    expect(res.status).toBe(400)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

/**
 * ⚠️⚠️ **忠实度守卫**：用**真 Node http server** 复刻「跨 origin 307 剥 Authorization」
 * 这条 fetch 规范行为。
 *
 * 为什么要这一条：本修复的**全部价值**建立在「fetch 自动跟随会剥头」之上。
 * 若某天 Node/undici 改了这条行为（或我们误以为它不改），上面那些用手写
 * fetcher 的用例**全部仍会绿**（它们根本没走真 fetch）。故这里起两个端口
 * （不同 origin），用**全局真 fetch** 走一次自动跟随，断言第二跳**收到 null**。
 */
describe('★★★ 事实基线：真 fetch 跨 origin 自动跟随确实剥掉 Authorization', () => {
  it('★★★ 自动跟随 ⇒ 第二跳收到的 Authorization 为 null（本修复的前提）', async () => {
    const received: Array<string | null> = []
    const target = createServer((req, res) => {
      received.push(req.headers.authorization ?? null)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()))
    const targetPort = (target.address() as AddressInfo).port

    const entry = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/second` })
      res.end()
    })
    await new Promise<void>((resolve) => entry.listen(0, '127.0.0.1', () => resolve()))
    const entryPort = (entry.address() as AddressInfo).port

    try {
      // ⚠️ 端口不同 ⇒ 不同 origin ⇒ 触发 fetch 的跨源凭据剥离规则。
      const res = await fetch(`http://127.0.0.1:${entryPort}/first`, {
        headers: { Authorization: 'Bearer SECRET' },
      })
      expect(res.status).toBe(200)
      expect(received).toHaveLength(1)
      // ★★★ 这就是缺陷根因：凭据在第二跳消失了。
      expect(received[0]).toBeNull()
    } finally {
      await new Promise<void>((resolve) => entry.close(() => resolve()))
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })
})
