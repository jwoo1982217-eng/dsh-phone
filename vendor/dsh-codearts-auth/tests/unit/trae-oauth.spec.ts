/**
 * TRAE 登录流程单元测试。
 *
 * 重点覆盖**端口占用**这一真实缺陷：
 *
 * `startTraeLoginFlow` 早期直接 `server.listen(port)` 且未注册 `'error'`
 * 处理器 —— Node 的 listen 失败（`EADDRINUSE`）是通过 `'error'` **事件**
 * 异步抛出的，不属于 Promise 链，因此：
 * - 逃过了 RPC 层 `try/catch`；
 * - 成为**进程级 unhandled error**，直接崩掉整个 DSH 宿主进程。
 *
 * 用户实际症状：TRAE 面板点「+ 新建账号」时若 18080 已被占用，不是看到一条
 * 可读错误，而是 `Error: listen EADDRINUSE: address already in use :::18080`
 * 加整堆栈、进程退出。
 *
 * 正确行为：把启动期的 listen 失败转成**可捕获的 Promise reject**，让 RPC
 * 层照常返回规范错误响应（前端展示可读文案）。
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTraeLoginURL,
  fixNicknameMojibake,
  machineTraceId,
  parseTraeCallback,
  parseTraeCallbackDetailed,
  startCallbackServer,
  startTraeLoginFlow,
} from '../../src/trae-oauth.js'
import { TRAE } from '../../src/trae-product.js'

/** 所有需要清理的 server（避免测试间端口泄漏）。 */
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
    })
  }
  servers.length = 0
})

/**
 * 占住一个端口，返回该端口号与释放函数。
 *
 * ⚠️ 必须绑 **127.0.0.1**（而不是默认的 `::`）：产品侧的回调服务器只绑回环
 * 地址，而 Windows 上 `::` 与 `127.0.0.1` 是两套可共存的栈 —— 若占位方绑
 * `::`，产品绑 `127.0.0.1` 仍会成功，"端口已占用"的前提根本不成立，用例会
 * 变成假阳性。绑同一地址族才能真实复现 EADDRINUSE。
 */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker = createServer()
  servers.push(blocker)
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const address = blocker.address()
  if (address === null || typeof address === 'string') throw new Error('无法取得端口')
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  }
}

describe('buildTraeLoginURL — 必须与 login.sh 的 18 参数完全一致', () => {
  /** login.sh:50-69 / Go callback.go:28-51 的权威参数集。 */
  const REQUIRED_PARAMS = [
    'login_version', 'auth_from', 'login_channel', 'plugin_version', 'auth_type',
    'client_id', 'redirect', 'login_trace_id', 'auth_callback_url',
    'machine_id', 'device_id', 'x_device_id', 'x_machine_id',
    'x_device_brand', 'x_device_type', 'x_os_version', 'x_app_version', 'x_app_type',
  ]

  const machineId = 'a'.repeat(32)
  const deviceId = 'b'.repeat(32)
  const callbackUrl = 'http://127.0.0.1:18080/authorize'
  const url = new URL(buildTraeLoginURL(TRAE, machineId, deviceId, callbackUrl))

  it('发出**全部** 18 个参数（缺任一都会让登录页停在授权中）', () => {
    // 真实缺陷：早期只发 5 个参数（client_id/machine_id/device_id/
    // callback_url/redirect_uri），登录页**永远停在认证中**。
    expect([...url.searchParams.keys()].sort()).toEqual([...REQUIRED_PARAMS].sort())
  })

  it('回调地址的参数名是 auth_callback_url（不是 callback_url / redirect_uri）', () => {
    // 这是「一直停在认证中」的直接原因：名字错了 TRAE 拿不到回调地址，
    // 授权完成后既不跳转也不回传任何东西。
    expect(url.searchParams.get('auth_callback_url')).toBe(callbackUrl)
    expect(url.searchParams.has('callback_url')).toBe(false)
    expect(url.searchParams.has('redirect_uri')).toBe(false)
  })

  it('走 solo 本地回调通道（auth_from / login_channel / auth_type / redirect）', () => {
    expect(url.searchParams.get('auth_from')).toBe('solo')
    expect(url.searchParams.get('login_channel')).toBe('native_ide')
    expect(url.searchParams.get('auth_type')).toBe('local')
    expect(url.searchParams.get('redirect')).toBe('0')
    expect(url.searchParams.get('login_version')).toBe('1')
  })

  it('plugin_version 用登录门户的插件版本，不是 IDE 版本', () => {
    expect(url.searchParams.get('plugin_version')).toBe(TRAE.pluginVersion)
    expect(url.searchParams.get('plugin_version')).toBe('2.3.62834')
    // IDE 版本是另一个字段（chat 端点的模型准入用）。
    expect(url.searchParams.get('plugin_version')).not.toBe(TRAE.ideVersion)
  })

  it('client_id 与 machine/device id 正确下发（含 x_ 系列镜像）', () => {
    expect(url.searchParams.get('client_id')).toBe(TRAE.clientId)
    expect(url.searchParams.get('machine_id')).toBe(machineId)
    expect(url.searchParams.get('device_id')).toBe(deviceId)
    // x_ 系列是同一对 id 的镜像（客户端形态伪装）。
    expect(url.searchParams.get('x_machine_id')).toBe(machineId)
    expect(url.searchParams.get('x_device_id')).toBe(deviceId)
  })

  it('login_trace_id 是 hex16（回调据此反查 pending）', () => {
    const trace = url.searchParams.get('login_trace_id')!
    expect(trace).toHaveLength(16)
    expect(trace).toBe(machineTraceId(machineId, deviceId))
  })

  it('x_* 客户端形态参数与 login.sh 一致', () => {
    expect(url.searchParams.get('x_device_brand')).toBe('PC')
    expect(url.searchParams.get('x_device_type')).toBe('PC')
    expect(url.searchParams.get('x_os_version')).toBe('1.0')
    expect(url.searchParams.get('x_app_type')).toBe('stable')
    expect(url.searchParams.get('x_app_version')).toBe(TRAE.ideVersion)
  })

  it('指向 trae.cn 的 /authorization', () => {
    expect(url.origin).toBe('https://www.trae.cn')
    expect(url.pathname).toBe('/authorization')
  })
})

describe('machineTraceId', () => {
  it('取拼接串尾部 16 字符（对齐 Go 的 machineTraceID）', () => {
    expect(machineTraceId('a'.repeat(32), 'b'.repeat(32))).toBe('b'.repeat(16))
  })

  it('长度不足时左侧补 0', () => {
    expect(machineTraceId('a', 'b')).toBe('0'.repeat(14) + 'ab')
  })
})

describe('parseTraeCallback — 回调直接回传 token，不是 ?code=', () => {
  /** 构造真实形态的回调 URL（login.sh:117 / callback.go:117）。 */
  function makeCallback(query: Record<string, string>): string {
    const params = new URLSearchParams(query)
    return `http://127.0.0.1:18080/authorize?${params.toString()}`
  }

  it('从 refreshToken + userInfo + userJwt 解出凭证', () => {
    const parsed = parseTraeCallback(makeCallback({
      refreshToken: 'RT-XYZ',
      userInfo: JSON.stringify({ UserID: 'u-123', ScreenName: '张三', TenantID: 'ent-9' }),
      userJwt: JSON.stringify({ Token: 'AT-jwt', RefreshToken: 'RT-jwt' }),
    }))
    expect(parsed).toMatchObject({
      refreshToken: 'RT-XYZ',
      uid: 'u-123',
      nickname: '张三',
      // ⚠️ 回调字段名是 TenantID（不是 EnterpriseID）。
      enterpriseId: 'ent-9',
      // 有 refreshToken 时不该动 accessToken（走 ExchangeToken 分支）。
      accessToken: '',
    })
  })

  it('⚠️ 带 ?code= 的回调是**合法**回调，只解不出 token（第二次修正）', () => {
    // 第一版结论是「TRAE 回调没有 code，故带 code 即无效」—— 那是**过度断言**：
    // TRAE 授权页并存两套流程（Trae2api-cn/src/main.py:478-484）：
    //   新流程 = PKCE（回带 code / authCodeInfo）；老流程 = 直传 refreshToken。
    // 若上游切到 PKCE 流程，把合法回调判为「无效」会让用户看到完全错误的
    // 排查方向（"缺少 refreshToken"），症状却与真正的缺陷一样。
    //
    // 故现在：带 code 时不返回 undefined，而是明确报出「走了 PKCE 流程」。
    const plain = parseTraeCallbackDetailed(makeCallback({ code: 'abc' }))
    expect(plain.ok).toBe(false)
    expect(plain).toMatchObject({ authCodeFlow: true })
    expect((plain as { reason: string }).reason).toContain('PKCE')

    // ?code= 仍不应被当成可用凭据（否则会拿 code 去换 token）。
    expect(parseTraeCallback(makeCallback({ code: 'abc' }))).toBeUndefined()
  })

  it('authCodeInfo（对象/纯串两种形态）同样识别为 PKCE 流程', () => {
    const asJson = parseTraeCallbackDetailed(makeCallback({
      authCodeInfo: JSON.stringify({ code: 'ac-1' }),
    }))
    expect(asJson).toMatchObject({ ok: false, authCodeFlow: true })

    const asRaw = parseTraeCallbackDetailed(makeCallback({ authCodeInfo: 'ac-2' }))
    expect(asRaw).toMatchObject({ ok: false, authCodeFlow: true })

    const altKey = parseTraeCallbackDetailed(makeCallback({ authCode: 'ac-3' }))
    expect(altKey).toMatchObject({ ok: false, authCodeFlow: true })
  })

  it('⚠️ token 与 code 同时存在时**优先用 token**（老流程优先，不误判）', () => {
    // 只要有可用 token 就必须走老流程，不能被 code 的存在带偏。
    const parsed = parseTraeCallback(makeCallback({
      refreshToken: 'RT-both',
      code: 'should-be-ignored',
    }))
    expect(parsed).toMatchObject({ refreshToken: 'RT-both', authCode: 'should-be-ignored' })
  })

  it('无 refreshToken 时回退 userJwt.RefreshToken（login.sh:165-166）', () => {
    const parsed = parseTraeCallback(makeCallback({
      userJwt: JSON.stringify({ RefreshToken: 'RT-from-jwt' }),
    }))
    expect(parsed?.refreshToken).toBe('RT-from-jwt')
    // 有 refreshToken → 不用 Token 兜底。
    expect(parsed?.accessToken).toBe('')
  })

  it('refreshToken 与 userJwt.RefreshToken 都缺时用 userJwt.Token 兜底', () => {
    const parsed = parseTraeCallback(makeCallback({
      userJwt: JSON.stringify({ Token: 'AT-only' }),
    }))
    expect(parsed).toMatchObject({ refreshToken: '', accessToken: 'AT-only' })
  })

  it('两种凭证来源都缺时返回 undefined', () => {
    expect(parseTraeCallback(makeCallback({ userInfo: JSON.stringify({ UserID: 'u' }) }))).toBeUndefined()
  })

  it('支持相对形式（/authorize?...）', () => {
    const parsed = parseTraeCallback('/authorize?refreshToken=RT')
    expect(parsed?.refreshToken).toBe('RT')
  })

  it('userInfo 中文被双重编码时也能解出（parse_json_param 容错）', () => {
    // 真实形态：userInfo 被 percent-encode 两次。
    const inner = JSON.stringify({ UserID: 'u-1', ScreenName: '张三' })
    const parsed = parseTraeCallback(`http://127.0.0.1:18080/authorize?refreshToken=RT&userInfo=${encodeURIComponent(encodeURIComponent(inner))}`)
    expect(parsed?.uid).toBe('u-1')
  })

  it('userInfo / userJwt 非法 JSON 时不抛错（字段留空）', () => {
    const parsed = parseTraeCallback(makeCallback({ refreshToken: 'RT', userInfo: 'not-json', userJwt: '{' }))
    expect(parsed?.refreshToken).toBe('RT')
    expect(parsed?.uid).toBe('')
  })
})

describe('fixNicknameMojibake — 回调中文昵称双重编码修复', () => {
  it('修复 latin-1 误读导致的乱码', () => {
    // 「张三」被 latin-1 误读后的形态。
    const mojibake = Buffer.from('张三', 'utf8').toString('latin1')
    expect(fixNicknameMojibake(mojibake, 'u-1234')).toBe('张三')
  })

  it('无法修复且不含 CJK 时回退为「用户+uid末4位」', () => {
    // 实测乱码形态（login.sh:135-150 的注释里就举了这个例子）。
    expect(fixNicknameMojibake('Óû§8847309959', 'u-8847309959')).toBe('用户9959')
  })

  it('本来就是正常中文时原样返回', () => {
    expect(fixNicknameMojibake('张三', 'u-1')).toBe('张三')
  })

  it('空串原样返回', () => {
    expect(fixNicknameMojibake('', 'u-1')).toBe('')
  })
})

describe('startTraeLoginFlow — 端口占用不得崩进程（真实缺陷回归）', () => {
  it('端口被占用时回退到随机端口并正常返回（而非崩进程）', async () => {
    // 真实缺陷：早期直接 `server.listen(port)` 且未注册 'error' 处理器 ——
    // listen 失败是**事件**异步抛出的，不属于 Promise 链，于是逃过 RPC 的
    // try/catch 成为**进程级 unhandled error**，把整个 DSH 宿主崩掉。
    //
    // 修复后：启动失败被转成可捕获路径；且因为 TRAE 的 auth_callback_url 是
    // 我们自己构造并随登录 URL 下发的，端口不固定也能工作 —— 于是被占用时
    // **回退到系统分配的随机端口**，功能保持可用。
    const { port } = await occupyPort()

    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port })

    // 关键：返回了可用的 loginUrl，而不是抛错/崩进程。
    expect(started.loginUrl).toContain('https://www.trae.cn/authorization')
    // 回调地址必须指向**实际**端口（不是被占用的那个）。
    const url = new URL(started.loginUrl)
    const callbackUrl = url.searchParams.get('auth_callback_url')!
    const uriPort = Number(new URL(callbackUrl).port)
    expect(uriPort).toBeGreaterThan(0)
    // 用解析出的端口比较，而不是字符串包含 —— 端口号存在数值巧合
    // （如回退端口的数字恰好出现在别的部分），字符串断言会假失败。
    expect(uriPort).not.toBe(port)

    await started.close()
  })

  it('回退后的回调服务器真的在自己的端口上监听（auth_callback_url 可用）', async () => {
    // 这是上一条的强化版：不仅 URL 里写着端口，那个端口必须**真的**有人听。
    const { port } = await occupyPort()
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port })
    const callbackUrl = new URL(started.loginUrl).searchParams.get('auth_callback_url')!

    // 向该地址发一个**无效回调**请求：应得到 400（说明请求处理器在工作），
    // 而不是 ECONNREFUSED。
    const response = await fetch(callbackUrl).catch(() => undefined)
    expect(response, 'auth_callback_url 指向的端口没有在监听').toBeDefined()
    expect(response!.status).toBe(400)

    await started.close()
  })

  it('首选端口空闲时就用首选端口（行为可预期）', async () => {
    const { port, release } = await occupyPort()
    await release()

    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port })
    const callbackUrl = new URL(started.loginUrl).searchParams.get('auth_callback_url')!
    expect(callbackUrl).toContain(`:${port}/`)

    await started.close()
  })

  it('正常启动时立即返回 loginUrl（不阻塞到用户授权完成）', async () => {
    // 浏览器只在 transient activation 窗口（约 5 秒）内允许 window.open，
    // 因此本函数必须在毫秒级返回 URL，绝不能等到回调落定。
    const { port, release } = await occupyPort()
    await release()

    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port })
    expect(typeof started.loginUrl).toBe('string')
    expect(started.loginUrl.length).toBeGreaterThan(0)

    // result 必须是**尚未落定**的 Promise（否则说明阻塞到了授权完成）。
    // 用竞态探测：给它 50ms，若已 settle 说明行为错误。
    const probe = await Promise.race([
      started.result.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])
    expect(probe, 'result 不应在返回时即已落定').toBe('pending')

    // close() 应能正常清理（并清掉兜底超时定时器）。
    await started.close()
  })
})

describe('startCallbackServer — 端口占用同样不得崩进程', () => {
  it('端口被占用时回退到随机端口并返回该端口', async () => {
    const { port } = await occupyPort()
    // 该函数会一直等到回调（或超时），这里只关心它**没有崩掉**且返回了
    // 一个不同于首选端口的实际端口。用一个短超时避免测试等 10 分钟。
    const pending = startCallbackServer(port, undefined, 300)
    const settled = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])
    // 尚未收到回调 → 仍处于 pending，但**没有**进程级崩溃 / 立即抛错。
    expect(settled).toBe('pending')
    // 收尾：等它超时落定，避免留下挂起的定时器与 server。
    await pending.catch(() => {})
  })

  it('端口被占用时立即抛错的情况（不可回退的错误）不会崩溃进程', async () => {
    // 用一个**非法**端口号触发不可回退的启动错误（EACCES/ERR_SOCKET_BAD_PORT）。
    // 这类错误必须走可捕获路径，而不是成为 unhandled error。
    const error = await startCallbackServer(-1 as number, undefined, 300)
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
  })
})

/**
 * 端到端：真实回调打到真实服务器上，必须能落定。
 *
 * ⚠️ 这组用例是本模块**最重要的回归** —— 「一直显示认证中」的根因正是
 * 「回调服务器永远不 resolve」：旧实现按 OAuth 惯例找 `?code=`，而 TRAE 回调
 * 根本没有该参数，于是 `parseAuthCode` 恒 undefined → 回 400 →
 * `result` Promise 永不落定 → 前端 `login.poll` 永远拿不到 `done:true`。
 *
 * 下面用**真实的 HTTP 请求**打真实监听的服务器，因此能捕获整条链路
 * （参数名、解析、promise 落定）中的任何一处断链。
 */
describe('回调链路端到端（「一直认证中」的根因回归）', () => {
  /** 构造真实形态的回调 URL。 */
  function realCallbackUrl(port: number, refreshToken = 'RT-E2E'): string {
    const params = new URLSearchParams({
      refreshToken,
      userInfo: JSON.stringify({ UserID: 'u-e2e', ScreenName: '张三', TenantID: 'ent-1' }),
      userJwt: JSON.stringify({ Token: 'AT-jwt', RefreshToken: 'RT-jwt' }),
    })
    return `http://127.0.0.1:${port}/authorize?${params.toString()}`
  }

  it('收到真实回调后 startCallbackServer 必须 resolve（不再永远挂起）', async () => {
    const { port, release } = await occupyPort()
    await release()

    const pending = startCallbackServer(port, undefined, 5_000)
    // 模拟浏览器跳转过来的真实回调。
    const response = await fetch(realCallbackUrl(port))
    expect(response.status).toBe(200)
    await response.text()

    // 关键断言：必须在超时前落定 —— 旧实现会一路挂到超时。
    const result = await pending
    expect(result.callback.refreshToken).toBe('RT-E2E')
    expect(result.callback.uid).toBe('u-e2e')
    expect(result.port).toBe(port)
  })

  it('PKCE 回调（带 ?code=）返回 400，且结果 Promise 落定为失败', async () => {
    const { port, release } = await occupyPort()
    await release()

    // 注意：带 code 的回调**不是**「格式错误」，而是「上游走了 PKCE 新流程」。
    // 这里断言的是「必须落定 + 带出可读原因」，而不是「被判为无效」。
    const pending = startCallbackServer(port, undefined, 60_000)
    // ⚠️ 必须在**触发回调之前**挂好拒绝处理器：回调一到达 Promise 就 reject，
    // 若等到 fetch 之后才 await，这段窗口里它就是「未处理拒绝」（Vitest 会把
    // 整个文件标记为有未处理错误）。
    const settled = pending.then(() => undefined).catch((e: unknown) => e)

    const response = await fetch(`http://127.0.0.1:${port}/authorize?code=abc`)
    expect(response.status).toBe(400)
    await response.text()

    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('PKCE')
  })

  it('⚠️ 无任何可用参数的回调也必须落定结果（第二个「一直认证中」根因）', async () => {
    // 第二个「一直认证中」的独立根因：**无效回调时结果 Promise 不落定**。
    // 早期实现在解析失败分支里只 `res.end()` 后 return，既没 resolve 也没
    // reject —— 前端 login.poll 永远拿不到 done:true，界面永久停在「认证中」。
    // 症状与「回调解析错了」一模一样，但根因完全不同。
    //
    // 这里给一个**既无 token 也无 code** 的回调：必须立刻 reject，
    // 而不是挂到超时（超时设得很长，挂起就一定失败）。
    const { port, release } = await occupyPort()
    await release()

    const pending = startCallbackServer(port, undefined, 60_000)
    // 同上：先挂拒绝处理器，再触发回调。
    const settled = pending.then(() => undefined).catch((e: unknown) => e)
    const response = await fetch(`http://127.0.0.1:${port}/authorize?foo=bar`)
    expect(response.status).toBe(400)
    await response.text()

    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('回调')
  })

  it('非 /authorize 路径返回 404', async () => {
    const { port, release } = await occupyPort()
    await release()
    const pending = startCallbackServer(port, undefined, 400)
    const response = await fetch(`http://127.0.0.1:${port}/other`)
    expect(response.status).toBe(404)
    await response.text()
    await pending.catch(() => {})
  })

  it('两步式登录收到真实回调后 result 落定且凭据可用', async () => {
    const { port, release } = await occupyPort()
    await release()

    // ExchangeToken + GetUserInfo 的 fetch 桩。
    const fetcher = (async (url: unknown) => {
      const target = String(url)
      if (target.includes('/ExchangeToken')) {
        return new Response(JSON.stringify({
          Result: {
            Token: 'AT-final', RefreshToken: 'RT-rotated',
            TokenExpireAt: Date.now() + 7_200_000, TokenExpireDuration: 7200,
          },
        }), { status: 200 })
      }
      if (target.includes('/GetUserInfo')) {
        return new Response(JSON.stringify({
          Result: { UserID: 'u-e2e', ScreenName: '张三', EnterpriseID: 'ent-1' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher })
    // 浏览器完成授权 → 跳回本地回调。
    const response = await fetch(realCallbackUrl(port))
    expect(response.status).toBe(200)
    await response.text()

    const result = await started.result
    const credential = JSON.parse(result.access) as Record<string, unknown>
    expect(credential.access_token).toBe('AT-final')
    // refresh_token 必须轮换成新值（ExchangeToken 会轮换）。
    expect(credential.refresh_token).toBe('RT-rotated')
    expect(credential.uid).toBe('u-e2e')
    // 机器指纹必须持久化（续期与签到都依赖它们）。
    expect(String(credential.machine_id)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(credential.device_id)).toMatch(/^[0-9a-f]{32}$/)
  })
})
