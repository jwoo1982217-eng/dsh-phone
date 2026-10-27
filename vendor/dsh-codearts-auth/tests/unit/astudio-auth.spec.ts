/**
 * astudio-auth.spec.ts —— AStudio 凭据层（Cookie 串构造 / 权威 api_key 取值 / 刷新链）单测【草案】
 *
 * drop-in 位置：tests/unit/astudio-auth.spec.ts（本草案不写进 worktree，由后续意图原样落盘）
 * 被测源码：src/astudio-auth.ts（`astudioCookieHeader` / `astudioControlHeaders` /
 *            `extractAstudioApiKey` / `class AstudioAuth.refreshOnce`）+ src/astudio.ts（纯函数头构造）
 *
 * ── 零网络 / 零真实凭据（硬约束）──────────────────────────────────────
 * AstudioAuth 走 `AstudioAuthOptions{fetcher, product, env, store}` **四个假替身**注入：
 *   · `fetcher`：假 fetch，只回 fixture 信封，永远不打 agent.xfyun.cn；
 *   · `env`：**必须**把 `DSH_ASTUDIO_SESSION_FILE` 指到本用例 mkdtemp 出来的 fixture 文件。
 *     src/astudio-auth.ts 顶部（fact 478 引用的 L98-101 警告）明写：不覆盖就会直读
 *     `…\AStudio Data\userdata\astron-session.json` 的**用户真实 modelBearerToken** 并发真请求。
 *     ⇒ 本文件的 `newService()` **没有**「不传 env 的默认构造」这条通路，见源码级守卫。
 *   · `store`：内存凭据库，且用来断言**绝不回写客户端文件**。
 *
 * ── 依赖 fact 478 的改动才生效的期望 ───────────────────────────────────
 * 【D2｜fact 478 ②】`fetchAuthoritativeCredential` 的 `credential` 收窄 + L316 类型断言：
 *     未修时该文件本身过不了 `pnpm typecheck`（TS2352 / TS2345），本 spec 也就编译不过。
 * 【D3｜fact 478 ③】`refreshOnce` 成功分支当前**硬编码 `via: 'is_current'`**，应改为透传
 *     `fetchAuthoritativeCredential` 内 `extractAstudioApiKey(body)` 的 `pick.via`。
 *     ⇒ 下面 `@depends-on D3` 的用例（is_default 命中时期望 `via==='is_default'`）未改前会红。
 *     注意实测账号形态（fact 414）：9 行里**没有一行 is_current=true**，只有 astronclaw-auto
 *     的 is_default=true —— 所以硬编码 'is_current' 会让日志归因恒错，这是本用例存在的理由。
 * 【D1｜fact 478 ⑤】`ASTUDIO_SESSION_DEAD_CODES` 加入 80000：下面「code=80000 走终态、
 *     且不依赖中文文案」的用例依赖它（该判定链是 parseAstudioEnvelope → extractAstudioApiKey
 *     → pick.terminal → fetchAuthoritativeCredential 抛终态 → isAstudioTerminalRefreshError）。
 *
 * ── tsconfig.tests.json ────────────────────────────────────────────────
 * 默认**不在** include 名单，要进 `pnpm typecheck:tests` 需补一行
 * `"tests/unit/astudio-auth.spec.ts",`（锚点：紧跟现有 `"tests/unit/jet-hub-rpc-signature.spec.ts"` 之后）。
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  astudioChatHeaders,
  astudioControlHeaders,
  astudioCookieHeader,
  type AstudioCredential,
} from '../../src/astudio.js'
import {
  AstudioAuth,
  astudioSessionFilePath,
  buildAstudioApiKeyConfigUrl,
  extractAstudioApiKey,
  isAstudioTerminalRefreshError,
  parseAstudioCredential,
  readAstudioDiskCredential,
  type AstudioCredentialStore,
} from '../../src/astudio-auth.js'
import { ASTUDIO, ASTUDIO_SESSION_FILE_ENV } from '../../src/astudio-product.js'
// ⚠️ 源码切片必须走它（行尾无关 + AST 括号匹配），本仓 autocrlf=true
import { sourceScope } from '../helpers/source-scope.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const src = readFileSync(join(SRC_DIR, 'astudio-auth.ts'), 'utf8')
const scope = sourceScope(src, 'astudio-auth.ts')
const astudioSrc = readFileSync(join(SRC_DIR, 'astudio.ts'), 'utf8')
const astudioScope = sourceScope(astudioSrc, 'astudio.ts')

const FIXTURE_TOKEN = 'fixture-model-bearer-token-never-real'
const FIXTURE_SSO = 'fixture-sso-session-id'
const FIXTURE_ACCOUNT = '17469144703'

// ════════════════════════════════════════════════════════════════════════
// 假替身
// ════════════════════════════════════════════════════════════════════════

/** 最小内存凭据库，形状与 ctx.credentials 一致（对齐 accio-auth.spec.ts 的 FakeCredentials）。 */
class FakeStore implements AstudioCredentialStore {
  readonly map = new Map<string, string>()
  /** 记录被写过的 ref，用于断言「只写 DSH 凭据库」。 */
  readonly setCalls: string[] = []

  async resolve(ref: CredentialRef) {
    const value = this.map.get(String(ref))
    return value === undefined ? undefined : { value }
  }

  async set(ref: CredentialRef, value: string) {
    this.setCalls.push(String(ref))
    this.map.set(String(ref), value)
  }

  async unset(ref: CredentialRef) {
    this.map.delete(String(ref))
  }
}

/**
 * 剥掉**行注释**（trim 后以 // 开头）的源码文本。
 *
 * ⚠️ 源码级 `not.toMatch(/<某实现字面量>/)` 型守卫必须先过这一层：sourceScope.fn() 取的是
 * AST 节点的 getText()，包含函数体内的行注释（只跳过前置 JSDoc）。开发者在体内留一句
 * 「此前写死 via: 'is_current'」这类说明性注释，守卫就会对**注释**假红（fact 552 第三节 (b)/(c)）。
 */
function stripLineComments(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function makeContext(): { ctx: Context; store: FakeStore } {

  const ctx = new Context()
  const store = new FakeStore()
  ctx.provide('credentials', store as never)
  return { ctx, store }
}

/** 磁盘会话文件的 fixture 形态（字段名与 astron-session.json 一致，值全为假）。 */
function sessionFileJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accountId: FIXTURE_ACCOUNT,
    uid: 'fixture-uid',
    mobile: '13800001234',
    modelBearerToken: FIXTURE_TOKEN,
    ssoSessionId: FIXTURE_SSO,
    token: FIXTURE_SSO,
    loginMethod: 'wechat',
    loggedInAt: '2026-10-15T14:00:53Z',
    ...overrides,
  })
}

const tempDirs: string[] = []

/** ⚠️ 每个 fixture 都落在 mkdtemp，绝不指向真实会话文件路径。 */
function makeSessionFixture(json = sessionFileJson()): { env: Record<string, string | undefined>; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'astudio-spec-'))
  tempDirs.push(dir)
  const file = join(dir, 'astron-session.json')
  writeFileSync(file, json, 'utf8')
  return { env: { [ASTUDIO_SESSION_FILE_ENV]: file }, file }
}

/**
 * bot/models/configs 的**真实信封形态**（fact 414：`data` 是**数组**、无 message 字段、
 * count 为 null；实测本账号 9 行里无一行 is_current=true）。
 *
 * ⚠️ 返回**对象**而不是 JSON 字符串（fact 529 第三节第 3 类根因）：
 * `extractAstudioApiKey` 第一步就是 `parseAstudioEnvelope(body)`，而它首行
 * `if (typeof body !== 'object' || body === null || Array.isArray(body))` 一律拒绝
 * 非对象 ⇒ 直接喂字符串会让整个取值阶梯恒落 `{apiKey:'', via:'none'}`（7 条假红）。
 * 需要「响应文本」的地方（`new Response(...)`）显式用 `configsEnvelopeText`。
 */
function configsEnvelope(rows: readonly unknown[]): Record<string, unknown> {
  return { flag: true, code: 0, desc: '成功', count: null, data: rows }
}

/** fetch 替身用的**文本**形态（Response body 必须是字符串/Buffer）。 */
function configsEnvelopeText(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(configsEnvelope(rows))
}

// ════════════════════════════════════════════════════════════════════════
describe('★ astudio-auth.ts 源码级契约', () => {
  it('⚠️⚠️ 绝不回写客户端文件：全文不得出现任何写文件系统的能力（fact 478：客户端是唯一权威写者）', () => {
    expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync/)
    // ⚠️ **不要**再写 `expect(src).not.toMatch(/config\.toml/)` 这类整份文本字面量守卫
    // —— astudio-auth.ts 顶部**注释**里就正当地提到 acode 的 config.toml（说明「为什么
    // 不能像旧实现那样双写 config.toml」），于是守卫永远假红（fact 529 第三节第 1 类）。
    // 真契约是上面那条「任何写文件系统的能力命中数=0」+ 下面的只读能力存在。
    // 只允许 readFileSync（磁盘快路径）
    expect(src).toMatch(/readFileSync/)
  })

  it('⚠️ 保存凭据只走注入的 store（DSH 凭据库），且 ref 名来自 product.defaultCredentialRef', () => {
    const save = scope.fn('saveCredential')
    expect(save).toMatch(/this\.store\.set\(/)
    expect(save).not.toMatch(/writeFileSync/)
    // 存储写失败必须**只告警不抛**（抛了会让整条刷新链显示成凭据问题）
    expect(save).toMatch(/catch/)
    expect(save).toMatch(/warn|logger/)
    expect(src).toContain('defaultCredentialRef')
  })

  it('⚠️ 控制面（bot/models/configs）不得带 Authorization —— 只发 Cookie（fact 402：Bearer 代 Cookie 会被拒）', () => {
    const headers = astudioScope.fn('astudioControlHeaders')
    expect(headers).not.toMatch(/Authorization/)
    expect(headers).toContain('astudioCookieHeader(')
    // 反向对照：推理面必须带 Bearer，两者不能写反
    const chat = astudioScope.fn('astudioChatHeaders')
    expect(chat).toMatch(/Authorization:\s*`Bearer \$\{credential\.access_token\}`/)
  })

  it('⚠️ 控制面的 Cookie 必须取自 credential.token，不得把 modelBearerToken 当 SSO token 发', () => {
    const cookie = astudioScope.fn('astudioCookieHeader')
    expect(cookie).not.toMatch(/access_token/)
    expect(cookie).toMatch(/credential\.token/)
    expect(cookie).toMatch(/credential\.sso_session_id/)
    expect(cookie).toMatch(/credential\.account_id/)
  })

  it('⚠️ 刷新只能由 fetchAuthoritativeCredential 供数，refreshOnce 不得自己拼 URL/头', () => {
    const refresh = scope.fn('refreshOnce')
    expect(refresh).not.toMatch(/fetchImpl\(/)
    expect(refresh).toMatch(/this\.fetchAuthoritativePick\(/)

  })

  /**
   * 【D3｜fact 478 ③】via 透传。
   * 未改前 refreshOnce 成功分支写死 `via: 'is_current'`，而真实取值阶梯在
   * fetchAuthoritativeCredential 里的 `extractAstudioApiKey(body)` —— 实测账号恒走
   * is_default 档，硬编码会让日志归因 100% 错误。
   */
  it('⚠️ refreshOnce 不得硬编码 via，必须透传 pick.via（依赖 fact 478 ③）', () => {
    const refreshCode = stripLineComments(scope.fn('refreshOnce'))
    expect(refreshCode).not.toMatch(/via:\s*'is_current'/)
    expect(refreshCode).toMatch(/via:\s*picked\.via/)
    // 取值阶梯与 via 的真正出处是实现层 fetchAuthoritativePick；公开的
    // fetchAuthoritativeCredential 只是 `.credential` 的三行薄包装，体内两者都没有。
    const fetchAuthoritative = scope.fn('fetchAuthoritativePick')
    expect(fetchAuthoritative).toMatch(/extractAstudioApiKey\(/)
    expect(fetchAuthoritative).toMatch(/via:\s*pick\.via/) // 必须把 via 透出（返回值带上）
  })


  it('⚠️ changed=false 时不得让上层重试（实测 token 不轮换，同 token 同 401 是确定性失败）', () => {
    const refresh = scope.fn('refreshOnce')
    expect(refresh).toMatch(/changed:\s*after !== before/)
  })

  it('⚠️ 传输层失败不得判终态（断网 ≠ 会话失效）', () => {
    const fetchAuthoritative = stripLineComments(scope.fn('fetchAuthoritativePick'))
    // 第一个 catch（fetchImpl 抛出）必须用**普通 Error**，不能是终态错误类。
    // 窗口收成该 catch 块自身：固定 400 字符会越过后面 HTTP 401/403 的终态抛出。
    const firstCatch = fetchAuthoritative.slice(fetchAuthoritative.indexOf('catch (error'))
    const catchBody = firstCatch.slice(0, firstCatch.indexOf('\n    }'))
    expect(catchBody.length).toBeGreaterThan(0)
    expect(catchBody).not.toMatch(/AstudioRefreshTokenExpiredError/)
    expect(catchBody).toMatch(/new Error\(/)

    // 但 HTTP 401/403 必须判终态
    expect(fetchAuthoritative).toMatch(/status === 401 \|\| status === 403/)
    expect(fetchAuthoritative).toMatch(/AstudioRefreshTokenExpiredError/)
  })

  it('⚠️ Cookie 拼不出时必须直接终态抛出，不得发这个请求（防匿名打权威端点）', () => {
    // 锚点同 (b)(c)：判序（cookie → throw → fetchImpl）只存在于实现层 fetchAuthoritativePick
    const fetchAuthoritative = scope.fn('fetchAuthoritativePick')

    const atCookie = fetchAuthoritative.indexOf('astudioCookieHeader(')
    const atThrow = fetchAuthoritative.indexOf('cookie.length === 0')
    const atFetch = fetchAuthoritative.indexOf('this.fetchImpl(')
    expect(atCookie).toBeGreaterThan(-1)
    expect(atThrow).toBeGreaterThan(atCookie)
    expect(atFetch).toBeGreaterThan(atThrow)
  })

  it('⚠️ mergeAstudioRefreshSeed 不得让空值覆盖另一侧的好值（否则 Cookie 被抹掉=永久失去刷新能力）', () => {
    const merge = scope.fn('mergeAstudioRefreshSeed')
    expect(merge).toMatch(/diskValue\.length > 0\) continue/)
    expect(merge).toContain("'sso_session_id'")
    expect(merge).toContain("'token'")
    // 【D2｜fact 478 ①】L316 的类型断言必须是双重断言，否则 TS2352
    expect(merge).toMatch(/as unknown as Record<string, unknown>/)
  })

  it('⚠️ 终态识别必须兼容「只有文案、没有码」的形态（isAstudioSessionDeadError 兜底）', () => {
    const term = scope.fn('isAstudioTerminalRefreshError')
    expect(term).toMatch(/name === 'RefreshTokenExpiredError'/)
    expect(term).toMatch(/isAstudioSessionDeadError\(/)
  })

  it('⚠️ 会话文件路径必须优先 env 覆盖（单测靠它挡真实凭据）', () => {
    const p = scope.fn('astudioSessionFilePath')
    // 源码是**常量索引** env[ASTUDIO_SESSION_FILE_ENV]；传变量值给 toContain 比的是常量的
    // 值（DSH_ASTUDIO_SESSION_FILE），源码文本里没有该字面量 ⇒ 永红（fact 552 第三节 (e)）。
    expect(p).toMatch(/env\[ASTUDIO_SESSION_FILE_ENV\]/)

    expect(p).toMatch(/override\.trim\(\)\.length > 0\) return override\.trim\(\)/)
  })

  it('★★ 默认会话路径必须按**当前用户推导**，不得是某台开发机的字面量（2026-10-18 审计 P1）', () => {
    // ⚠️⚠️ 缺陷本体：原 `ASTUDIO.sessionFilePath` 是
    //    `E:\\Users\\lin1\\AppData\\Local\\Programs\\AStudio Data\\userdata\\astron-session.json`
    //    ⇒ 除该开发机外**所有**用户点「⚡ 一键导入本机桌面端凭据」都必然失败，
    //    而那是客户端的**默认档**（`jet-hub.js` 的 `useState('local')`、
    //    `new-account.js` 的 `astudioLoginMethod ?? 'local'`）；且报错文案叫用户
    //    「请先启动 AStudio 客户端并登录」——用户照做也永远不会成功（代码查的是
    //    别人机器上的路径），文案把用户引向一个不存在的动作。
    //
    // ⚠️ 判据打在**行为**上：断言推导结果随传入的 `LOCALAPPDATA` 变化。
    //    只断言「源码里没有 E:\\Users」是**没牙**的（换个盘符/用户名即可绕过）。
    const a = astudioSessionFilePath({ LOCALAPPDATA: String.raw`D:\AppData\Local` })
    const b = astudioSessionFilePath({ LOCALAPPDATA: String.raw`C:\Other\Local` })
    expect(a.startsWith(String.raw`D:\AppData\Local`), `默认路径必须以 LOCALAPPDATA 为根，实际 ${a}`).toBe(true)
    expect(b.startsWith(String.raw`C:\Other\Local`), `换一个 LOCALAPPDATA 必须跟着变，实际 ${b}`).toBe(true)
    expect(a, '两个不同的 LOCALAPPDATA 不得得出同一条路径（那说明没在推导）').not.toBe(b)
    // 尾部固定：安装目录名与文件名是本家的协议事实，不该随环境变。
    expect(a.endsWith('Programs\\AStudio Data\\userdata\\astron-session.json')).toBe(true)
    // 反向：`LOCALAPPDATA` 缺失时仍须给出**可预期**的回落路径（不得抛、不得空串）。
    const bare = astudioSessionFilePath({})
    expect(bare.endsWith('astron-session.json'), 'LOCALAPPDATA 缺失时仍须有回落').toBe(true)
    // ⚠️ env 覆盖的**既有语义不许回退**（单测靠它挡真实凭据）。
    expect(astudioSessionFilePath({
      LOCALAPPDATA: String.raw`D:\AppData\Local`,
      DSH_ASTUDIO_SESSION_FILE: 'X:\\custom\\session.json',
    })).toBe('X:\\custom\\session.json')
  })

  it('☁️ 端点与 product 一致（不硬编码 URL 字面量）', () => {
    expect(buildAstudioApiKeyConfigUrl()).toBe(`${ASTUDIO.authBaseUrl}${ASTUDIO.apiKeyConfigPath}`)
    expect(buildAstudioApiKeyConfigUrl()).toContain('agent.xfyun.cn')
    expect(buildAstudioApiKeyConfigUrl()).toContain('/bot/models/configs')
    // 尾斜杠要归一，别拼出 //
    expect(buildAstudioApiKeyConfigUrl({ ...ASTUDIO, authBaseUrl: 'https://x.example/y/' }))
      .toBe('https://x.example/y/bot/models/configs')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioCookieHeader —— 四字段串与空值省键', () => {
  const full: AstudioCredential = {
    access_token: FIXTURE_TOKEN,
    account_id: FIXTURE_ACCOUNT,
    sso_session_id: FIXTURE_SSO,
    token: FIXTURE_SSO,
  }

  it('四字段齐全：ssoSessionId 与 sso_sessionid 同值各发一次（fact 372/378 的实测串）', () => {
    const cookie = astudioCookieHeader(full)
    expect(cookie).toBe(`ssoSessionId=${FIXTURE_SSO}; sso_sessionid=${FIXTURE_SSO}; account_id=${FIXTURE_ACCOUNT}; token=${FIXTURE_SSO}`)
    expect(cookie.split('; ')).toHaveLength(4)
  })

  it('空值 / undefined 一律省键，不留 `account_id=` 这种空对', () => {
    expect(astudioCookieHeader({ access_token: FIXTURE_TOKEN, sso_session_id: FIXTURE_SSO, token: FIXTURE_SSO }))
      .toBe(`ssoSessionId=${FIXTURE_SSO}; sso_sessionid=${FIXTURE_SSO}; token=${FIXTURE_SSO}`)
    expect(astudioCookieHeader({ access_token: FIXTURE_TOKEN, account_id: '' }))
      .not.toMatch(/account_id/)
    expect(astudioCookieHeader({ access_token: FIXTURE_TOKEN })).toBe('')
  })

  it('⚠️ 只有 account_id（没有 sso）时也照样输出，不抛异常；缺 ssoSessionId 的后果由上层判定', () => {
    expect(astudioCookieHeader({ access_token: FIXTURE_TOKEN, account_id: FIXTURE_ACCOUNT }))
      .toBe(`account_id=${FIXTURE_ACCOUNT}`)
  })

  it('⚠️ modelBearerToken(access_token) 绝不出现在 Cookie 串里', () => {
    expect(astudioCookieHeader(full)).not.toContain(FIXTURE_TOKEN)
  })

  it('astudioControlHeaders：带 Cookie + clientType + studioVersion，绝不带 Authorization', () => {
    const headers = astudioControlHeaders(full, ASTUDIO)
    expect(headers.Cookie).toContain('ssoSessionId=')
    expect(headers.clientType).toBe(ASTUDIO.clientType)
    expect(headers.studioVersion).toBe(ASTUDIO.studioVersion)
    expect(headers.Accept).toBe('application/json')
    expect(Object.keys(headers)).not.toContain('Authorization')
  })

  it('astudioControlHeaders：Cookie 拼不出时连 Cookie 键都不发（空串不发键）', () => {
    const headers = astudioControlHeaders({ access_token: FIXTURE_TOKEN }, ASTUDIO)
    expect(Object.keys(headers)).not.toContain('Cookie')
  })

  it('astudioChatHeaders：Bearer + Content-Type，account_id 有值才发 X-Account-Id', () => {
    const headers = astudioChatHeaders(full, ASTUDIO)
    expect(headers.Authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
    expect(headers['X-Account-Id']).toBe(FIXTURE_ACCOUNT)
    expect(headers['Content-Type']).toBe('application/json')
    const noAccount = astudioChatHeaders({ access_token: FIXTURE_TOKEN, account_id: '' }, ASTUDIO)
    expect(Object.keys(noAccount)).not.toContain('X-Account-Id')
    // 流式要 Accept: text/event-stream
    expect(astudioChatHeaders(full, ASTUDIO, 'text/event-stream').Accept).toBe('text/event-stream')
  })

  it('掩码：手机号只做昵称，不得把完整手机号带进任何头', () => {
    const headers = astudioChatHeaders({ ...full, nickname: '13800001234' }, ASTUDIO)
    for (const value of Object.values(headers)) expect(value).not.toContain('13800001234')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('readAstudioDiskCredential / astudioSessionFilePath —— 只读 fixture，不碰真实凭据', () => {
  it('env 覆盖指向 fixture 时读到的就是 fixture', () => {
    const { env, file } = makeSessionFixture()
    expect(astudioSessionFilePath(env)).toBe(file)
    const credential = readAstudioDiskCredential(env)
    expect(credential?.access_token).toBe(FIXTURE_TOKEN)
    expect(credential?.account_id).toBe(FIXTURE_ACCOUNT)
    expect(credential?.sso_session_id).toBe(FIXTURE_SSO)
    expect(credential?.source).toBe('session-file')
  })

  it('⚠️ 静态路径字面量必须已移除，回落改为按传入 env 推导（单测要读盘必须显式设 env）', () => {
    // ⚠️ 2026-10-18 审计 P1 后**语义变更**：`ASTUDIO` 不再持有静态
    //    `sessionFilePath`（原值是开发机绝对路径 ⇒ 除该机外**所有**用户的
    //    「一键导入本机凭据」必然失败，而那是客户端默认档）。回落 = 按
    //    **传入的 env** 推导当前用户路径。
    // ⚠️ 本函数只**计算**路径、不读盘，故在此断言它安全；真正读盘的是
    //    `readAstudioDiskCredential`，其单测**必须**设 `DSH_ASTUDIO_SESSION_FILE`
    //    指向 fixture（否则会读用户真实凭据 —— 见下一个用例）。
    expect(ASTUDIO.sessionFilePath, '静态字面量路径必须已被移除').toBeUndefined()
    // 空串 / 纯空白的覆盖视为未设置（不能拿 '' 当路径去读）
    expect(astudioSessionFilePath({
      [ASTUDIO_SESSION_FILE_ENV]: '   ',
      LOCALAPPDATA: String.raw`D:\AppData\Local`,
    })).toBe(String.raw`D:\AppData\Local\Programs\AStudio Data\userdata\astron-session.json`)
  })

  it('modelBearerToken 缺失或空串 → undefined（磁盘快路径不可用时交给凭据库）', () => {
    for (const bad of [{ modelBearerToken: '' }, { modelBearerToken: '   ' }, {}]) {
      const { env } = makeSessionFixture(JSON.stringify(bad))
      expect(readAstudioDiskCredential(env)).toBeUndefined()
    }
  })

  it('文件不存在 / 非法 JSON → undefined，不得抛（磁盘是后备，不是唯一来源）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astudio-spec-missing-'))
    tempDirs.push(dir)
    expect(readAstudioDiskCredential({ [ASTUDIO_SESSION_FILE_ENV]: join(dir, 'nope.json') })).toBeUndefined()
    const { env } = makeSessionFixture('{not json' as never)
    expect(readAstudioDiskCredential(env)).toBeUndefined()
  })

  it('parseAstudioCredential：只认带 access_token 字符串的对象', () => {
    expect(parseAstudioCredential('{"access_token":"a"}')?.access_token).toBe('a')
    expect(parseAstudioCredential('{}')).toBeUndefined()
    expect(parseAstudioCredential('{"access_token":123}')).toBeUndefined()
    expect(parseAstudioCredential('null')).toBeUndefined()
    expect(parseAstudioCredential('[')).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('extractAstudioApiKey —— 取值阶梯 is_current → is_default → first → 全表扫', () => {
  it('① is_current=true 且有 api_key → via=is_current', () => {
    const pick = extractAstudioApiKey(configsEnvelope([
      { id: 'lm1', model: 'xopglm52', api_key: 'KEY-CUR', is_default: false, is_current: true },
      { id: 'lm2', model: 'astronclaw-auto', api_key: 'KEY-DEF', is_default: true, is_current: false },
    ]))
    expect(pick).toMatchObject({ apiKey: 'KEY-CUR', model: 'xopglm52', via: 'is_current', terminal: false })
  })

  it('② ⚠️ 本账号的**真实形态**：9 行里无一行 is_current=true，只有 is_default=true → via=is_default', () => {
    // fact 414：只判 is_current 会恒取不到 ⇒ 刷新链静默失败
    const rows = [
      { id: 'lm1', model: 'xopglm52', api_key: '', is_default: false, is_current: false },
      { id: 'lm_auto', model: 'astronclaw-auto', api_key: 'KEY-DEF', is_default: true, is_current: false },
      { id: 'lm3', model: 'spark-x2.5', api_key: 'KEY-3', is_default: false, is_current: false },
    ]
    const pick = extractAstudioApiKey(configsEnvelope(rows))
    expect(pick.apiKey).toBe('KEY-DEF')
    expect(pick.via).toBe('is_default')
    expect(pick.terminal).toBe(false)
  })

  it('③ 既无 is_current 也无 is_default → 取 data[0]，via=first', () => {
    const pick = extractAstudioApiKey(configsEnvelope([
      { model: 'spark-x2.5', api_key: 'KEY-FIRST' },
      { model: 'xopglm52', api_key: 'KEY-2' },
    ]))
    expect(pick).toMatchObject({ apiKey: 'KEY-FIRST', via: 'first', terminal: false })
  })

  it('④ 全表扫兜底：is_current 行的 api_key 是空串时**跳过**它，继续往下找', () => {
    const pick = extractAstudioApiKey(configsEnvelope([
      { model: 'xopglm52', api_key: '   ', is_current: true },
      { model: 'astronclaw-auto', api_key: 'KEY-DEF', is_default: true },
    ]))
    expect(pick.apiKey).toBe('KEY-DEF')
    expect(pick.via).toBe('is_default')
  })

  it('⑤ 全表扫兜底：前三个阶梯位都拿不到 key，最终仍能从表尾拿到（不因排序变化而失败）', () => {
    const pick = extractAstudioApiKey(configsEnvelope([
      { model: 'a', api_key: '' },
      { model: 'b', api_key: '   ', is_current: true },
      { model: 'c', api_key: 'KEY-TAIL' },
    ]))
    expect(pick.apiKey).toBe('KEY-TAIL')
    expect(pick.terminal).toBe(false)
  })

  it('全表都无 api_key → apiKey 空 + terminal=true（=「需人工重新登录」语义，绝不返回空凭据）', () => {
    const pick = extractAstudioApiKey(configsEnvelope([{ model: 'a' }, { model: 'b', api_key: '' }]))
    expect(pick.apiKey).toBe('')
    expect(pick.via).toBe('none')
    expect(pick.terminal).toBe(true)
    expect(pick.reason.length).toBeGreaterThan(0)
  })

  it('⚠️ data 是**数组**才可能取到 key：目录型 {code:0,data:{models:[…]}} 判终态（形态不对别硬取）', () => {
    const pick = extractAstudioApiKey({ flag: true, code: 0, data: { models: [{ api_key: 'NOPE' }] } })
    expect(pick.apiKey).toBe('')
    expect(pick.terminal).toBe(true)
    expect(pick.via).toBe('none')
  })

  it('data 为空数组 → 终态（不是「暂时没数据、等会儿再试」）', () => {
    const pick = extractAstudioApiKey({ flag: true, code: 0, desc: '成功', data: [] })
    expect(pick.apiKey).toBe('')
    expect(pick.terminal).toBe(true)
  })

  it('1002/1005 → terminal=true 且 reason 带服务端文案', () => {
    const pick = extractAstudioApiKey({ flag: false, code: 1002, desc: '登录已过期', data: null })
    expect(pick).toMatchObject({ apiKey: '', via: 'none', terminal: true })
    expect(pick.reason).toContain('登录已过期')
  })

  it('【D1】code=80000 且**无中文文案**也走终态（ASTUDIO_SESSION_DEAD_CODES 含 80000 后不依赖文案正则）', () => {
    const pick = extractAstudioApiKey({ flag: false, code: 80000, desc: '', data: null })
    expect(pick.terminal).toBe(true)
    expect(pick.apiKey).toBe('')
    // 终态错误必须能被 isAstudioTerminalRefreshError 认出（凭码抛出的终态类）
    const err = new Error('astudio: 取不到权威 api_key')
    err.name = 'RefreshTokenExpiredError'
    expect(isAstudioTerminalRefreshError(err)).toBe(true)
  })

  it('非对象 body / 数组 body → via=none（不抛）', () => {
    for (const body of [null, undefined, 'text', [], 42]) {
      const pick = extractAstudioApiKey(body)
      expect(pick.apiKey).toBe('')
      expect(pick.via).toBe('none')
      expect(pick.terminal).toBe(false) // 形态错误 ≠ 会话失效，允许别的分支再试
    }
  })

  it('行里混入非对象元素不得崩', () => {
    const pick = extractAstudioApiKey(configsEnvelope([null, 'x', { model: 'a', api_key: 'KEY-OK' }]))
    expect(pick.apiKey).toBe('KEY-OK')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('AstudioAuth.refreshOnce —— 全假替身，零网络（断言 via 透传与 changed 语义）', () => {
  /** 唯一的构造入口：强制注入 env fixture，杜绝「顺手 new AstudioAuth(ctx)」。 */
  function newService(ctx: Context, options: ConstructorParameters<typeof AstudioAuth>[1]): AstudioAuth {
    return new AstudioAuth(ctx, options)
  }

  function okFetcher(json: string, status = 200) {
    return vi.fn(async () => new Response(json, { status })) as unknown as ReturnType<typeof vi.fn> & typeof fetch
  }

  it('⚠️ 刷新链一次请求都不许打到真实域名：URL 与请求头全由假 fetcher 捕获核对', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(configsEnvelopeText([{ model: 'astronclaw-auto', api_key: 'KEY-NEW', is_default: true }]), { status: 200 })
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher, env, store: new FakeStore() })

    const outcome = await service.refreshOnce()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(buildAstudioApiKeyConfigUrl())
    // 打的是 agent.xfyun.cn，不是上游 MAAS，也不是本地 4605
    expect(calls[0].url).not.toContain('127.0.0.1')
    expect(calls[0].url).not.toContain('model-gateway')
    // 控制面只发 Cookie：无 Authorization
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(calls[0].headers.Cookie).toContain(`ssoSessionId=${FIXTURE_SSO}`)
    expect(outcome.fetched).toBe(true)
  })

  /**
   * 【D3｜fact 478 ③】—— 本用例未改前会红（期望是改后行为，**不要**把期望写成 'is_current'）。
   * 实测账号形态下 is_default 才是命中档，硬编码 'is_current' 会让日志归因恒错。
   */
  it('via 必须透传 pick.via（is_default 命中 → via=is_default，不是硬编码 is_current）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, {
      fetcher: okFetcher(configsEnvelopeText([{ model: 'astronclaw-auto', api_key: 'KEY-NEW', is_default: true, is_current: false }])),
      env,
      store: new FakeStore(),
    })
    const outcome = await service.refreshOnce()
    expect(outcome.via).toBe('is_default')
  })

  it('via=is_current 只有在真有 is_current 行时才成立', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, {
      fetcher: okFetcher(configsEnvelopeText([{ model: 'xopglm52', api_key: 'KEY-NEW', is_current: true }])),
      env,
      store: new FakeStore(),
    })
    expect((await service.refreshOnce()).via).toBe('is_current')
  })

  it('阶梯取第一行时 via=first', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, {
      fetcher: okFetcher(configsEnvelopeText([{ model: 'spark-x2.5', api_key: 'KEY-NEW' }])),
      env,
      store: new FakeStore(),
    })
    expect((await service.refreshOnce()).via).toBe('first')
  })

  it('⚠️ token 不轮换：远端值与磁盘值相同时 changed=false（上层据此**不得**重试）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, {
      fetcher: okFetcher(configsEnvelopeText([{ model: 'xopglm52', api_key: FIXTURE_TOKEN, is_current: true }])),
      env,
      store: new FakeStore(),
    })
    const outcome = await service.refreshOnce()
    expect(outcome.fetched).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(outcome.before).toBe(outcome.after)
    expect(outcome.terminal).toBe(false)
  })

  it('取到新值：changed=true、指纹前后不同、凭据落进注入的 store（不落客户端文件）', async () => {
    const { ctx, store } = makeContext()
    const { env, file } = makeSessionFixture()
    store.map.set('ASTUDIO_ACCESS_TOKEN', JSON.stringify({ access_token: 'old-from-store', sso_session_id: FIXTURE_SSO, token: FIXTURE_SSO }))
    const service = newService(ctx, {
      fetcher: okFetcher(configsEnvelopeText([{ model: 'xopglm52', api_key: 'KEY-NEW', is_current: true }])),
      env,
      store,
    })
    const outcome = await service.refreshOnce()
    expect(outcome.changed).toBe(true)
    expect(outcome.credential?.access_token).toBe('KEY-NEW')
    expect(outcome.credential?.source).toBe('account-backend')
    expect(outcome.before).not.toBe(outcome.after)
    expect(store.setCalls).toContain('ASTUDIO_ACCESS_TOKEN')
    // ⚠️ 反向对照：磁盘 fixture 内容一字未改（客户端是唯一权威写者）
    expect(readFileSync(file, 'utf8')).toContain(FIXTURE_TOKEN)
  })

  it('【D1】远端回 HTTP 200 + code=80000 → terminal=true 且 credential 保留旧值（不误报成新凭据）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, {
      // 注意：这里**故意不给中文文案**，终态必须由码集判出来（依赖 fact 478 ⑤）
      fetcher: okFetcher(JSON.stringify({ flag: false, code: 80000, desc: '', data: null })),
      env,
      store: new FakeStore(),
    })
    const outcome = await service.refreshOnce()
    expect(outcome.terminal).toBe(true)
    expect(outcome.fetched).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(outcome.credential?.access_token).toBe(FIXTURE_TOKEN)
  })

  it('远端回 401/403 → 判终态（Cookie 侧失效，没有 refresh_token 可自救）', async () => {
    for (const status of [401, 403]) {
      const { ctx } = makeContext()
      const { env } = makeSessionFixture()
      const service = newService(ctx, { fetcher: okFetcher('{"error":{"message":"no"}}', status), env, store: new FakeStore() })
      const outcome = await service.refreshOnce()
      expect(outcome.terminal).toBe(true)
      expect(outcome.changed).toBe(false)
      expect(outcome.credential?.access_token).toBe(FIXTURE_TOKEN) // 保留旧凭据，别清空
    }
  })

  it('远端 500（非 401/403）→ **不**判终态（可重试；服务端抖动 ≠ 会话失效）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, { fetcher: okFetcher('<html>500</html>', 500), env, store: new FakeStore() })
    const outcome = await service.refreshOnce()
    expect(outcome.terminal).toBe(false)
    expect(outcome.fetched).toBe(true)
    expect(outcome.reason.length).toBeGreaterThan(0)
  })

  it('假 fetch 抛错（断网）→ terminal=false，绝不能被误判成需要重登', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher, env, store: new FakeStore() })
    const outcome = await service.refreshOnce()
    expect(outcome.terminal).toBe(false)
    expect(outcome.changed).toBe(false)
  })

  it('⚠️ Cookie 只拼得出 account_id（fixture 无 sso）→ 按源码现状如实钉：允许发出，但必须走终态', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture(JSON.stringify({ accountId: FIXTURE_ACCOUNT, modelBearerToken: FIXTURE_TOKEN }))
    // 会话缺 sso 时上游的真实回包形态（fact 402：sso 会话失效 = HTTP 200 + code=80000，
    // 且**不**给任何 api_key）—— 上一版这里喂的是 code=0+api_key 的成功信封，源码按契约
    // 会正常收下新凭据（terminal=false），于是「必须走终态」那条断言与 fixture 自相矛盾。
    // ⚠️ 此处必须保留 vi.fn 的 mock 元信息（下面用 fetcher.mock.calls 核对请求实参），
    //   故沿用 okFetcher 的交叉类型写法：`as unknown as ReturnType<typeof vi.fn> & typeof fetch`。
    //   旧写法 `as unknown as typeof fetch` 会抹掉 .mock ⇒ tsconfig.tests.json 补入
    //   astudio-auth.spec.ts（fact 574 那三行 include）后 typecheck:tests 报 TS2339；
    //   vitest 走 esbuild 不做类型检查，所以这条红只在 typecheck:tests 暴露。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ flag: false, code: 80000, desc: '', data: null }), { status: 200 })) as unknown as ReturnType<typeof vi.fn> & typeof fetch
    const service = newService(ctx, { fetcher, env, store: new FakeStore() })
    const outcome = await service.refreshOnce()
    // 【源码现状，fact 552 第三节 (f)】mergeAstudioRefreshSeed 会保住 account_id ⇒ cookie 串非空
    // ⇒ fetchAuthoritativePick 里 `cookie.length === 0` 的早抛不会命中 ⇒ 请求照发。
    // 不允许为此改 src（fact 544 第③条那两处协议缺口属后续单独一步）。真正要钉的安全语义是：
    // 唯一那次请求只带 Cookie、不带 Authorization，且结果仍归「需人工重登」终态、不回写凭据。
    expect(fetcher).toHaveBeenCalledTimes(1)
    const requestDump = JSON.stringify((fetcher.mock.calls as unknown as unknown[][])[0] ?? '')
    expect(requestDump).toContain('account_id=' + FIXTURE_ACCOUNT)
    expect(requestDump).not.toMatch(/ssoSessionId|sso_sessionid/)
    expect(requestDump).not.toMatch(/authorization/i)
    expect(outcome.terminal).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(outcome.fetched).toBe(true)
    // 终态时旧凭据必须原样保留，不得被清空成「空凭据」
    expect(outcome.credential?.access_token).toBe(FIXTURE_TOKEN)
  })


  it('非 JSON 响应但含登录字样 → 终态（网关劫持/会话失效页面）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, { fetcher: okFetcher('<html>请先登录</html>'), env, store: new FakeStore() })
    expect((await service.refreshOnce()).terminal).toBe(true)
  })

  it('非 JSON 且无登录字样 → 不判终态（别把解析失败当会话失效）', async () => {
    const { ctx } = makeContext()
    const { env } = makeSessionFixture()
    const service = newService(ctx, { fetcher: okFetcher('<html>gateway timeout</html>'), env, store: new FakeStore() })
    expect((await service.refreshOnce()).terminal).toBe(false)
  })

  it('currentCredential：磁盘优先于凭据库', async () => {
    const { ctx, store } = makeContext()
    const { env } = makeSessionFixture()
    await store.set(credentialRef('ASTUDIO_ACCESS_TOKEN'), JSON.stringify({ access_token: 'from-store', sso_session_id: 's', token: 't' }))
    const service = new AstudioAuth(ctx, { env, store })
    const credential = await service.currentCredential()
    expect(credential?.access_token).toBe(FIXTURE_TOKEN)
    expect(credential?.source).toBe('session-file')
  })

  it('currentCredential：磁盘没有才回落凭据库', async () => {
    const { ctx, store } = makeContext()
    const dir = mkdtempSync(join(tmpdir(), 'astudio-spec-empty-'))
    tempDirs.push(dir)
    await store.set(credentialRef('ASTUDIO_ACCESS_TOKEN'), JSON.stringify({ access_token: 'from-store', sso_session_id: 's', token: 't' }))
    const service = new AstudioAuth(ctx, { env: { [ASTUDIO_SESSION_FILE_ENV]: join(dir, 'absent.json') }, store })
    expect((await service.currentCredential())?.access_token).toBe('from-store')
  })
})
