/**
 * Loomy「锁定永久积分 + 余额查不到」的**错误契约**（issue IKMCOO 缺陷 2 / 3）。
 *
 * ## 本文件守什么
 *
 * | 判据 | 为什么必须测 |
 * |---|---|
 * | 文案按「**全部**查不到 / **部分**查不到 / 确认用尽」**三档**分 | 原来的单档 `unknown` 把「3 个号全查不到」说成「**部分**账号」，并让用户去查凭据 —— 而实测凭据有效 |
 * | 错误码落在宿主**默认可重试集合**里 | 自定义码（如 `BALANCE_UNAVAILABLE`）**不在** `DEFAULT_RETRYABLE_CODES` 内 ⇒ 宿主照样不重试，缺陷 3 根本没被修好 |
 * | `all-unknown` 文案**不**让用户去查凭据、**要**给可执行的下一步 | 照着原文案做完全无效（本机 4 个账号 `/points/records` 全部 200） |
 *
 * ⚠️ **错误码那条必须用宿主的真实常量验证**，不能把自己写的码抄一遍 ——
 *    抄一遍就成恒真断言，正是 issue 缺陷 3 当初「以为修好了」的原因。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rankLoomyAccountsByBalance } from '../../src/loomy-balance-rank.js'
import { LoomyBalanceSelector } from '../../src/loomy-balance-selector.js'
import type { LoomyCredential } from '../../src/loomy.js'
import { LOOMY } from '../../src/loomy-product.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = stripComments(readFileSync(resolve(here, '../../src/index.ts'), 'utf8'))

/** 剥掉注释（接线断言不该因为「注释里提到了某个符号」而通过）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 切出 `loomyLockedError` 那个函数的函数体。 */
function lockedErrorBody(): string {
  const start = indexSource.indexOf('const loomyLockedError')
  expect(start, '★ 必须能定位到 loomyLockedError').toBeGreaterThan(-1)
  const end = indexSource.indexOf('const buddy = new BuddyAuth', start)
  return indexSource.slice(start, end === -1 ? start + 4000 : end)
}

/**
 * ★ 读**宿主** `DEFAULT_RETRYABLE_CODES` 的真实值。
 *
 * ⚠️⚠️ **为什么读文件而不是 `import()`**（2026-10-16 实测）：
 *   宿主包的 `exports` 拦掉深导入（实测报
 *   `Missing "./types/retry-policy.js" specifier in "@deepseek-ai/dsh-llm"`），
 *   而 `.catch()` **接不住**它 —— 那不是运行期 reject，是**静态解析期**的
 *   模块解析失败，直接让整个 suite 崩掉（不是「退回兜底」）。
 *   ⇒ 改为按路径读文件 + 正则提取。
 *
 * ⚠️ `EMPTY_RESPONSE_CODE` 在数组里是**常量表达式**（`EMPTY_RESPONSE_CODE,`），
 *   故要从 `error.js` 里把它的值取出来再替换。
 *
 * ⚠️ 找不到时**抛错而不是静默兜底**：兜底一份写死的清单 = 恒真断言，
 *   那正是 issue 缺陷 3 当初「以为修好了」的原因。
 */
async function readHostRetryableCodes(): Promise<readonly string[]> {
  const { readFileSync: read } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  // ⚠️⚠️ **必须从包根反推路径**（2026-10-16 实测踩了两次）：
  //   ① `import('@deepseek-ai/dsh-llm/types/retry-policy.js')` 被 `exports`
  //      拦掉，而 `.catch()` **接不住**（静态解析期失败，整个 suite 崩）；
  //   ② `require.resolve('@deepseek-ai/dsh-llm/lib/types/retry-policy.js')`
  //      同样被 `exports` 拦（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
  //   ⇒ 只有「先解析包根入口、再 join 相对路径」这一条走得通。
  let pkgEntry: string
  try {
    pkgEntry = req.resolve('@deepseek-ai/dsh-llm')
  } catch {
    throw new Error('★ 解析不到 @deepseek-ai/dsh-llm —— 判据无法验证（不得静默兜底）')
  }
  const libDir = dirname(pkgEntry)
  const policySrc = read(join(libDir, 'types', 'retry-policy.js'), 'utf8')
  const errorSrc = read(join(libDir, 'types', 'error.js'), 'utf8')

  const emptyResponse = /EMPTY_RESPONSE_CODE\s*=\s*["']([^"']+)["']/.exec(errorSrc)?.[1]
  if (emptyResponse === undefined) {
    throw new Error('★ 宿主 error.js 里读不到 EMPTY_RESPONSE_CODE 的值（判据自检失败）')
  }
  const block = /DEFAULT_RETRYABLE_CODES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(policySrc)
  if (block === null) {
    throw new Error('★ 宿主 retry-policy.js 里读不到 DEFAULT_RETRYABLE_CODES（判据自检失败）')
  }
  const codes = block[1]!
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s === 'EMPTY_RESPONSE_CODE' ? emptyResponse : s.replace(/^["']|["']$/g, '')))
  if (codes.length === 0) throw new Error('★ 提取到的可重试码不得为空（判据自检失败）')
  return codes
}

/**
 * 从 `loomyLockedError` 函数体里提取它抛出的**错误码**。
 *
 * ⚠️⚠️ **不能靠正则匹配 `new LlmError(..., 'CODE')`**（我第一版这么写，实测 0 匹配）：
 *   实际代码是**跨行字符串拼接** ——
 *   ```
 *   return new LlmError(
 *     'Loomy：……文案……'
 *     + '……更多文案……',
 *     'TRANSPORT',
 *   )
 * ```
 *   码在**第二个参数**，与括号之间隔着整段文案 + 换行。
 *   ⇒ 改为「取每个 `new LlmError(` 之后、**最后一个**独立单引号串」。
 */
function extractErrorCodes(body: string): string[] {
  const codes: string[] = []
  let i = -1
  while ((i = body.indexOf('new LlmError(', i + 1)) >= 0) {
    const tail = body.slice(i, i + 3000)
    // 只看本条语句（在下一个 `return` / 语句结束之前）
    const end = Math.min(
      ...['\n    }', '\n  }', '\nconst ']
        .map(marker => { const at = tail.indexOf(marker, 10); return at === -1 ? Number.POSITIVE_INFINITY : at }),
    )
    const stmt = tail.slice(0, Number.isFinite(end) ? end : tail.length)
    const quoted = [...stmt.matchAll(/'([A-Z][A-Z_]*)'/g)].map(m => m[1]!)
    if (quoted.length === 0) continue
    codes.push(quoted[quoted.length - 1]!)
  }
  return codes
}

describe('★★ 缺陷 3：错误码必须在宿主默认可重试集合里', () => {
  it('★★ 文案里用的码都落在宿主 DEFAULT_RETRYABLE_CODES 内', async () => {
    // ⚠️⚠️ **必须读宿主真实来源**。我第一版新增了自定义码
    //    `BALANCE_UNAVAILABLE`，看上去「可判定、可重试」，而实读
    //    `@deepseek-ai/dsh-llm/lib/types/retry-policy.js` 发现默认集合是
    //    `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
    //    —— **自定义码不在其中** ⇒ 宿主不重试，症状与修前一模一样。
    //    ⇒ 这条用例就是防「再有人自造一个码」的那道闸。
    const retryable = await readHostRetryableCodes()
    const body = lockedErrorBody()
    const codes = extractErrorCodes(body)
    expect(codes.length, '★ 必须能提取出 loomyLockedError 用的错误码（判据自检）').toBeGreaterThan(0)
    for (const code of codes) {
      expect(
        retryable as readonly string[],
        `★★ 错误码 ${code} 不在宿主默认可重试集合里 ⇒ 宿主不会重试（缺陷 3 未修好）`,
      ).toContain(code)
    }
  })

  it('★ 确认用的是 LlmError 而非裸 Error（裸 Error 没有 code）', () => {
    // ⚠️ 原实现抛的是 `new Error(...)` ⇒ `code` 为 `undefined`
    //    ⇒ 宿主既不能重试也不能分类。本条守住「至少那两档带 code」。
    const body = lockedErrorBody()
    const llmErrors = (body.match(/new LlmError\(/g) ?? []).length
    expect(llmErrors, '★ 查不到余额的两档必须用 LlmError（带 code）').toBeGreaterThan(0)
  })
})

describe('★★ 缺陷 2：文案必须三档分清，且 all-unknown 不让用户查凭据', () => {
  it('★★ 三档的 kind 都必须在选号器里真的产生（穷举性守卫）', async () => {
    // ⚠️ 与 buddy 那份同型的「穷尽性守卫」：`LoomyNoAccountReason` 有三档，
    //    文案必须**逐档点名**，少一档就会静默落进兜底分支。
    const body = lockedErrorBody()
    for (const kind of ['all-unknown', 'partial', 'exhausted']) {
      expect(body, `★★ 文案必须显式处理 '${kind}' 档`).toContain(`'${kind}'`)
    }
  })

  it('★★ all-unknown 文案：说「所有」且**明确否掉**「查凭据」这条路', async () => {
    const body = lockedErrorBody()
    const allUnknownBranch = body.slice(body.indexOf("'all-unknown'"), body.indexOf("'partial'"))
    expect(allUnknownBranch, '★ 必须说「所有」而不是「部分」').toContain('**所有**')
    // ⚠️ 关键：原文案让用户「检查凭据是否失效」，而实测凭据有效 ⇒ 必须**否掉**它
    expect(allUnknownBranch, '★★ 必须明确「不是凭据失效」，否则用户照着做无效')
      .toMatch(/不是\*\*凭据失效|无需重新登录/)
    // ⚠️ 且必须给**可执行**的下一步
    expect(allUnknownBranch, '★★ 必须给出可执行的下一步').toMatch(/重试|改用其它/)
  })

  it('★ partial 文案保留「可能仍有」但点名失败数', async () => {
    const body = lockedErrorBody()
    const partialBranch = body.slice(body.indexOf("'partial'"), body.indexOf('const exhaustedOnly'))
    expect(partialBranch, '★ 部分失败才说「可能仍有」').toContain('**部分**')
    expect(partialBranch, '★ 必须保留「可能仍有今日额度」').toContain('可能仍有')
  })

  it('★★ 选号器确实能产出两档（不是文案写了但永远走不到）', async () => {
    // ⚠️ **行为级**：文案分档只有与选号器产出对齐才有意义。
    //   这里分别构造「全员失败」与「部分失败」两种世界，断言产出的 kind。
    const REFS = ['AAAAAAAA', 'BBBBBBBB']
    const tok = (ref: string) => ref.padEnd(32, 'T')
    const okResponse = () => new Response(JSON.stringify({
      code: '000000', desc: '成功', trace_id: 't',
      data: { balance: 100, dailyBalance: 0, availableBalance: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const creds = new Map<string, LoomyCredential>(
      REFS.map(ref => [ref, { access_token: tok(ref), userid: ref } as LoomyCredential]),
    )
    const makeSelector = (failing: readonly string[]) => new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: async (ref) => creds.get(ref),
      // ⚠️ **按 ref 而非 token 判失败**：token 被 `padEnd` 补齐过，
      //   拿它去 `includes` 会永远匹配不上（我第一版就这样，症状是
      //   三个号**全部**"成功" → 产出 `exhausted` 而非 `all-unknown`）。
      fetcher: (async (_url: string, init: RequestInit) => {
        const token = (init.headers as Record<string, string>).token!
        const ref = REFS.find(r => tok(r) === token)
        if (ref !== undefined && failing.includes(ref)) throw new Error('boom')
        return okResponse()
      }) as unknown as typeof fetch,
    })

    // ① 全员失败
    {
      const selector = makeSelector(REFS)
      const r = await selector.select(
        [{ id: 'a1', credentialRef: 'AAAAAAAA' }, { id: 'a2', credentialRef: 'BBBBBBBB' }],
        { allowPermanent: false },
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.kind, '★ 全员失败').toBe('all-unknown')
    }

    // ② 部分失败（一个失败、一个确认 0）
    {
      const selector = makeSelector(['AAAAAAAA'])
      const r = await selector.select(
        [{ id: 'a1', credentialRef: 'AAAAAAAA' }, { id: 'a2', credentialRef: 'BBBBBBBB' }],
        { allowPermanent: false },
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.kind, '★ 部分失败').toBe('partial')
    }
  })

  it('★★ 缺陷 4 的下游：缺 balance 的号在锁定时仍按「有今日额度」可选', async () => {
    // ⚠️ 这是缺陷 4 的**端到端**判据：`fetchLoomyCreditDetail` 现在不再因
    //   缺 `balance` 判死 ⇒ 分档看得见 `daily` ⇒ 锁定时该账号仍可用。
    //   没有这条，「修了口径」只是接口层面的改动，选号行为没变。
    const entries = [{ id: 'a1', dailyBalance: 4992, permanentBalance: undefined }]
    const ranked = rankLoomyAccountsByBalance(entries, { allowPermanent: false })
    expect(ranked[0]!.id, '★★ 缺永久池但有今日额度的账号必须仍可选').toBe('a1')
  })
})