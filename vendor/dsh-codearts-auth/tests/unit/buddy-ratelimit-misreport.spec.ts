/**
 * 回归：**全部启用账号都被目标模型限流**时，必须报「限流 + 解禁时刻」，
 * 而不是误导性的 `no usable credential; log in from the Jet Hub panel first`。
 *
 * ## 原始症状（真实缺陷，2026-10-03）
 *
 * 用户 `/compact` 连续四次失败，UI 只显示通用文案
 * 「Compaction could not produce a useful summary」；解出会话日志后发现
 * `compaction/end` 携带的真实错误是
 * `buddy: no usable credential; log in from the Jet Hub panel first`。
 *
 * 而当时 Jet Hub 里 buddy 账号**已登录、已启用**，凭据完全可用 —— 真实原因
 * 是它被 `deepseek-v4.1-flash` 的模型级限流标记挡住（解禁时刻就存在
 * `modelRateLimits` 里，插件却一个字都没往外报）。用户被指去「重新登录」，
 * 方向完全错。
 *
 * ## 链路
 *
 * 唯一启用账号被限流 → `pickBuddyCredential` 候选筛成空集 →
 * `select()` 回笼统的 `exhausted`（未锁定时 `reason` 被丢弃）→ 退到单凭据
 * ref `BUDDY_ACCESS_TOKEN`（Jet Hub 登录只写 `*_ACCOUNT_XXX`，该 ref 不存在）
 * → 适配器抛 `MISSING_CREDENTIAL`。
 *
 * ## 与既有用例的关系
 *
 * 与 `buddy-wiring.spec.ts` / `buddy-free-model-lock.spec.ts` 同款：既做
 * **行为级**验证（判据必须对），也做**源码级**接线断言（接线不能断）。
 * 后者刻意用「剥注释后的源码」判定，避免因注释里提到某符号而误判。
 *
 * ⚠️ 本补丁**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
 * 仍然失败。因此用例同时锁死「不绕过限流标记」「不静默换模型」两条红线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { allAccountsRateLimitedForModel } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const poolSource = readFileSync(resolve(here, '../../src/account-pool.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 剥掉注释后的源码。⚠️ 接线断言必须只看代码，不能因「注释里提到某符号」而误判。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)
const poolCode = codeOnly(poolSource)

const NOW = 1_791_009_000_000

/** 构造一个启用账号，可带某模型的限流时刻。 */
function account(
  id: string,
  modelRateLimits?: Record<string, number>,
  enabled = true,
): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled,
    credentialRef: `BUDDY_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 0,
    refreshable: true,
    ...modelRateLimits === undefined ? {} : { modelRateLimits },
  }
}

describe('全部账号被模型限流时，报限流而非「未登录」', () => {
  describe('判据（行为级）', () => {
    it('唯一启用账号被该模型限流 → 命中，并给出解禁时刻', () => {
      const reset = NOW + 3_600_000
      const got = allAccountsRateLimitedForModel(
        [account('a', { 'deepseek-v4.1-flash': reset })],
        'deepseek-v4.1-flash',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: reset, accountCount: 1 })
    })

    it('多个账号全被限流 → 取**最早**解禁时刻（用户最该等的那一个）', () => {
      const got = allAccountsRateLimitedForModel(
        [
          account('a', { m: NOW + 9_000_000 }),
          account('b', { m: NOW + 1_000_000 }),
          account('c', { m: NOW + 5_000_000 }),
        ],
        'm',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: NOW + 1_000_000, accountCount: 3 })
    })

    it('只要有一个账号不受该模型限制，整体就不成立（候选非空，轮不到本函数）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 }), account('b')],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('账号限制的是**别的**模型时不算命中（限流是「账号 × 模型」维度）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { 'other-model': NOW + 1000 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('解禁时刻已过（now >= resetAt）不算命中', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW })],
        'm',
        NOW,
      )).toBeUndefined()
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW - 1 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('resetAt 为 0 视为「不受限」（与选号侧判据一致）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: 0 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('空 modelId 直接不判定 —— 否则会把「未登录」误报成「限流」', () => {
      // 选号侧约定：空 modelId 不做限流过滤（`if (modelId.length === 0) return true`）。
      // 本函数必须同口径，否则「没有传模型」这种普通情形会被误报。
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('存在 modelRateLimits[""] 脏键时，空 modelId 仍不判定（守卫不能省）', () => {
      // ⚠️ 这条才真正锁住 `modelId.length === 0` 早退：`updateModelRateLimit`
      // **不校验** modelId，理论上可落下空串键。没有该守卫时，下面这组数据会
      // 被判成「全部限流」并上报给用户（反向验证：删掉守卫 → 本用例变红）。
      expect(allAccountsRateLimitedForModel(
        [account('a', { '': NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('没有启用账号时不判定（那是「未登录」，不是「限流」）', () => {
      // ℹ️ 本条与「循环不执行 → earliest 保持 undefined」同义，属**边界说明**
      // 而非可区分的回归保护（反向验证：删掉早退守卫它照样通过）。
      // 保留是为了锁死对外行为：空列表绝不能报成「全部限流」。
      expect(allAccountsRateLimitedForModel([], 'm', NOW)).toBeUndefined()
    })
  })

  describe('接线（源码级）', () => {
    it('两个 provider 的兜底路径都插入了限流判定', () => {
      expect(indexCode).toContain('throwIfAllAccountsRateLimited(CODEBUDDY, modelId)')
      expect(indexCode).toContain('throwIfAllAccountsRateLimited(WORKBUDDY, modelId)')
    })

    it('判定必须**先于**单凭据 ref 兜底 —— 否则仍会降级成 MISSING_CREDENTIAL', () => {
      // ⚠️ 锚点必须是**真正的兜底调用**，不能只搜 ref 名：`BUDDY_CREDENTIAL_REF`
      // 在文件更早处（import 与 `credentialRef(...)` 注册）也出现过，搜名字会
      // 命中错位置（写用例时实测到：check=12308 反而大于 fallback=751）。
      const checkCallOrder = (product: string, fallbackCall: string) => {
        const check = indexCode.indexOf(`throwIfAllAccountsRateLimited(${product}, modelId)`)
        const fallback = indexCode.indexOf(fallbackCall)
        expect(check).toBeGreaterThan(-1)
        expect(fallback).toBeGreaterThan(-1)
        expect(check).toBeLessThan(fallback)
      }
      checkCallOrder('CODEBUDDY', 'ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))')
      checkCallOrder('WORKBUDDY', 'ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))')
    })

    it('判定放在 getAvailableAccount 兜底**之后**（池里还有号时不该报限流）', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      expect(fnStart).toBeGreaterThan(-1)
      for (const product of ['CODEBUDDY', 'WORKBUDDY']) {
        const available = indexCode.indexOf(`getAvailableAccount(${product}.id, modelId ?? '', picked.tried)`)
        const check = indexCode.indexOf(`throwIfAllAccountsRateLimited(${product}, modelId)`)
        expect(available).toBeGreaterThan(-1)
        // 先问池 → 池也没号 → 才判限流。
        expect(available).toBeLessThan(check)
      }
    })

    it('只统计**启用**账号 —— 停用账号不参与自动选号，算进来会误报', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('.filter(a => a.enabled)')
    })

    it('抛的是 QUOTA_EXCEEDED，而不是让它继续降级成 MISSING_CREDENTIAL', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain("'QUOTA_EXCEEDED'")
      expect(fnBody.slice(0, end)).toContain('new LlmError(')
    })

    it('文案里带解禁时刻与「无需重新登录」，否则用户仍会去重登', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      const block = fnBody.slice(0, end)
      expect(block).toContain('toLocaleString')
      expect(block).toContain('无需重新登录')
    })

    it('判据复用 account-pool 的纯函数，不在 index.ts 里重写一遍', () => {
      expect(indexCode).toContain('allAccountsRateLimitedForModel')
      expect(poolCode).toMatch(/export function allAccountsRateLimitedForModel\(/)
    })
  })

  describe('不削弱既有语义（回归保护）', () => {
    it('判据与选号侧同口径：缺标记 / 0 / 已过期都算不受限', () => {
      const fnStart = poolCode.indexOf('export function allAccountsRateLimitedForModel')
      expect(fnStart).toBeGreaterThan(-1)
      const body = poolCode.slice(fnStart, fnStart + 2000)
      expect(body).toContain('resetAt === undefined')
      expect(body).toContain('resetAt === 0')
      expect(body).toContain('now >= resetAt')
    })

    it('限流标记仍然照常写入 —— 本补丁只读标记，不删不改', () => {
      // 红线：绝不能让「报错更清楚」演变成「绕开限流」。写标记的路径必须原样保留。
      expect(poolCode).toContain('async updateModelRateLimit(')
      const adapterSource = readFileSync(resolve(here, '../../src/buddy-adapter.ts'), 'utf8')
      expect(adapterSource).toContain('updateModelRateLimit')
    })

    it('未命中判定时静默返回，原有的 MISSING_CREDENTIAL 路径保持可用', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('if (limited === undefined) return')
      // 单凭据兜底仍在（老数据兼容路径），只是排到判定之后。
      expect(indexCode).toContain('const resolved = await ctx.credentials.resolve')
    })
  })

  /**
   * **cline 也接上了这条**（2026-10-03 用户报障，同型缺陷）。
   *
   * 症状与 buddy 那次**一模一样但报错文案不同**：用户等完限流倒计时再连，得到的是
   * `cline: no usable credential; log in first` —— 凭据明明在、账号也登录着，
   * 只是被 `cline-free/deepseek-v4.1-flash` 的模型级限流标记挡住。
   *
   * ⚠️ cline 的取号调用**不带 `tried`**（它只有一个显式回退路径，与 buddy 的
   * `pickBuddyCredential` 不同），故接线断言的锚点必须按它的实际写法写，
   * 不能照抄 buddy 那组（照抄会永远红）。
   */
  describe('接线（源码级）：cline 同型缺陷', () => {
    it('cline 的兜底路径也插入了限流判定', () => {
      expect(indexCode).toContain('throwIfAllAccountsRateLimited(CLINE, modelId)')
    })

    it('判定**先于**单凭据 ref 兜底 —— 否则仍会降级成「请先登录」', () => {
      const check = indexCode.indexOf('throwIfAllAccountsRateLimited(CLINE, modelId)')
      const fallback = indexCode.indexOf('ctx.credentials.resolve(credentialRef(CLINE.defaultCredentialRef))')
      expect(check).toBeGreaterThan(-1)
      expect(fallback).toBeGreaterThan(-1)
      expect(check).toBeLessThan(fallback)
    })

    it('判定放在 getAvailableAccount 之后（池里还有号时不该报限流）', () => {
      const available = indexCode.indexOf('getAvailableAccount(CLINE.id, modelId ?? \'\')')
      const check = indexCode.indexOf('throwIfAllAccountsRateLimited(CLINE, modelId)')
      expect(available).toBeGreaterThan(-1)
      expect(available).toBeLessThan(check)
    })

    it('助手的 product 参数只要求 id / displayName（cline 与 buddy 是两个类型）', () => {
      // 写死 `product: BuddyProduct` 会让 cline 无法复用；断言签名已放宽。
      // ⚠️ 不能按「第一个 `{`」切签名——类型字面量自己就带 `{`，会切在 `product: ` 上
      // （写用例时实测到）。取固定长度的窗口。
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const signature = indexCode.slice(fnStart, fnStart + 400)
      expect(signature).toContain('{ id: string; displayName: string }')
      expect(signature).not.toContain('BuddyProduct')
    })
  })

  /**
   * **其余 9 个 provider 同型缺陷**（Gitee issue IKJOZ9，2026-10-05）。
   *
   * ## 症状
   *
   * 用户的 qoder 单账号撞上**当日额度用尽**，第一次请求报
   * `Billing daily count exceeded`（正确），标记落下后**第二次请求**却报：
   *
   * ```
   * qoder: no usable credential; log in first     ← 把用户指向「重新登录」
   * ```
   *
   * 而凭据是好的、账号是登录着的 —— 真实原因是那个模型被**模型级限流**挡住。
   * 用户据此重新登录，问题照旧（根因是限流），白跑一趟。
   *
   * ## 为什么这次是「九个一起漏」
   *
   * 判定助手 `throwIfAllAccountsRateLimited` 自 2026-10-03 起只接了
   * buddy / workbuddy / cline 三家，新增的 provider **谁都没接**。这不是九个
   * 独立缺陷，而是**同一条接线约定没有被强制**——所以下面的断言是
   * **按 provider 逐个点名**，而不是「断言至少存在若干处调用」：
   * 后者对新增 provider 恒成立，挡不住下一个同类回归。
   *
   * ⚠️ **codearts 刻意不在名单里**：它取号时传的是**空 modelId**
   * （`getAvailableAccount('codearts', '')`），模型级限流**压根不参与筛选**，
   * 因此既不会误报「限流」、也不会误报「未登录」。给它接判定属于改变
   * 既有行为，超出本 issue 范围；此处的名单必须与事实一致，不能图省事全列上。
   */
  describe('接线（源码级）：其余 provider 同型缺陷（IKJOZ9）', () => {
    /**
     * 每个 provider 的「池取号调用 → 判定 → 单凭据兜底」三个锚点。
     *
     * ⚠️ 锚点必须**逐个 provider 写死**，不能只搜函数名：
     * `getAvailableAccount(X.id, modelId ?? '')` 这个形出现在十处以上，
     * 只搜形参会命中第一个（buddy），断言恒真。
     */
    const WIRING: Array<{ product: string; pool: string; fallback: string }> = [
      { product: 'CODEBUDDY', pool: 'getAvailableAccount(CODEBUDDY.id', fallback: 'credentialRef(BUDDY_CREDENTIAL_REF)' },
      { product: 'WORKBUDDY', pool: 'getAvailableAccount(WORKBUDDY.id', fallback: 'credentialRef(WORKBUDDY.defaultCredentialRef)' },
      // ⚠️ lobsterai / trae 的兜底锚点是 `resolveXxxCredentialByRef(...)` 而不是
      // `ctx.credentials.resolve(credentialRef(...))`：master 把那两处内联的
      // `JSON.parse` 收敛成了复用解析器（理由见 index.ts 里那处的注释）。
      // 本断言的价值正在于此 —— master 一改兜底写法，它立刻报红而不是悄悄失配。
      { product: 'LOBSTERAI', pool: 'getAvailableAccount(LOBSTERAI.id', fallback: 'resolveLobsteraiCredentialByRef(LOBSTERAI.defaultCredentialRef)' },
      { product: 'QODER', pool: 'getAvailableAccount(QODER.id', fallback: 'credentialRef(QODER.defaultCredentialRef)' },
      { product: 'QODER_CN', pool: 'getAvailableAccount(QODER_CN.id', fallback: 'credentialRef(QODER_CN.defaultCredentialRef)' },
      { product: 'TRAE', pool: 'getAvailableAccount(TRAE.id', fallback: 'resolveTraeCredentialByRef(TRAE.defaultCredentialRef)' },
      { product: 'CLINE', pool: 'getAvailableAccount(CLINE.id', fallback: 'credentialRef(CLINE.defaultCredentialRef)' },
      { product: 'LOOMY', pool: 'listAccountsByProvider(LOOMY.id)', fallback: 'credentialRef(LOOMY.defaultCredentialRef)' },
      { product: 'RACCOON', pool: 'getAvailableAccount(RACCOON.id', fallback: 'credentialRef(RACCOON.defaultCredentialRef)' },
      { product: 'MINIMAX', pool: 'getAvailableAccount(MINIMAX.id', fallback: 'credentialRef(MINIMAX.defaultCredentialRef)' },
      { product: 'GEMINI', pool: 'getAvailableAccount(GEMINI.id', fallback: 'credentialRef(GEMINI.defaultCredentialRef)' },
      // ⚠️ **刻意不含 ZCODE** —— 它的兜底形态与其余各家不同，见下方
      // 「zcode 同型缺陷判定」段（那是唯一一条「不接也算对」的断言）。
    ]

    it.each(WIRING)('$product：判定已接线，且位于「取号之后、兜底之前」', ({ product, pool, fallback }) => {
      // ⚠️ 三个锚点必须**在同一切片里**按先后比较，不能各自 indexOf 全文：
      // `credentialRef(X.defaultCredentialRef)` 在 `registerXxxLlm` 的
      // `credentialRef:` 注册行就出现过一次（**早于** resolveCredential），
      // 全文搜索会命中那处、把「判定先于兜底」判反（写用例时实测到）。
      // 正确做法：先定位取号点，再在**它之后**的切片里找判定与兜底。
      const available = indexCode.indexOf(pool)
      expect(available, `${product} 的取号锚点没找到`).toBeGreaterThan(-1)
      const tail = indexCode.slice(available)
      const check = tail.indexOf(`throwIfAllAccountsRateLimited(${product}, modelId)`)
      const fallbackAt = tail.indexOf(fallback)
      expect(check, `${product} 未接限流判定`).toBeGreaterThan(-1)
      expect(fallbackAt, `${product} 的兜底锚点没找到`).toBeGreaterThan(-1)
      // 顺序：先问池 → 池也没号 → 才判限流 → 最后才退单凭据。
      // ⚠️ 判定放到取号之前，会让「池里明明还有号」也被报成限流。
      expect(check).toBeLessThan(fallbackAt)
    })

    it('名单覆盖全部走 resolveCredential 取号的 provider（新增 provider 记得加进来）', () => {
      // ⚠️ **必须同时认两种取号形态**（2026-10-06 审计发现原判据有盲区）：
      // ① `getAvailableAccount(X.id, modelId …)` —— 绝大多数 provider；
      // ② `listAccountsByProvider(X.id)` + **自己内联**一份 `modelRateLimits` filter
      //    —— 本仓库已有 2 处先例（buddy 的 `pickBuddyCredential`、loomy 的
      //    `resolveCredential`）。只认 ① 的话，将来第 13 个 provider 照抄 ② 的写法
      //    就会**静默漏接且断言恒绿**。
      //
      // ⚠️ 排除 `refresh:` 里那些**不带 modelId** 的取号（那是续期路径，刻意用
      // 空串以便拿到被限流的账号去续期 —— 语义不同，不能判限流）；故 ① 的正则
      // 必须带 `, modelId`。
      const guarded = new Set(WIRING.map(w => w.product))
      const EXEMPT = new Set([
        // 助手内部对「任意 provider」的通用统计，参数是形参 `product.id`，
        // 不是某个具体产品常量。
        'product',
        // opencode 是**槽制**，没有 resolveCredential：`listIdentitySlots` 只按
        // `enabled` 过滤，`PoolEntrySnapshot` 压根不携带 `modelRateLimits`
        // ⇒ opencode 侧模型级标记**只写不读**（只供面板徽章与「重测」恢复）。
        // 它槽位耗尽时报的是自己的 `QUOTA_EXCEEDED`，不会误报「未登录」。
        'OPENCODE',
        // zcode 是**唯一「不接判定也算对」**的一家：它的兜底 `zcode.current()`
        // 会再读一次账号池且不看 `enabled`/限流 ⇒ 池被筛空时仍返回凭据，
        // 根本不会误报「未登录」（IKJOZ9 的症状在它身上不存在）。
        // 加判定反而会收窄可用性 —— 见下一段「zcode 同型缺陷判定」。
        'ZCODE',
      ])
      const seen = [
        ...[...indexCode.matchAll(/getAvailableAccount\((\w+)\.id, modelId/g)].map(m => m[1]!),
        ...[...indexCode.matchAll(/listAccountsByProvider\((\w+)\.id\)/g)].map(m => m[1]!),
      ]
      const missing = [...new Set(seen)].filter(p => !guarded.has(p) && !EXEMPT.has(p))
      expect(missing, '这些 provider 从池取号（可能内联限流 filter），却没接限流判定').toEqual([])
      // 反向自检：判据本身不能是空转的 —— 上面必须真的扫到了名单里的成员。
      expect(seen.filter(p => guarded.has(p)).length, '判据没扫到任何已知 provider，说明正则已失效').toBeGreaterThan(0)
    })

    /**
     * **锁死「opencode 不需要接线」这个结论**（2026-10-06 审计建议）。
     *
     * 之前它只是「不在名单里」—— 一个**否定性事实**，没有任何断言守着。将来若有人
     * 给 `PoolEntrySnapshot` 加上 `modelRateLimits` 并让 `listIdentitySlots` 据此
     * 过滤槽位，opencode 就会**静默**变成第 13 个受害者：候选筛空 → 报「未登录」，
     * 而没有任何一条用例会红。
     */
    it('opencode 仍是槽制：没有 resolveCredential，且槽位快照不携带 modelRateLimits', () => {
      const opencodeAuthSource = readFileSync(resolve(here, '../../src/opencode-auth.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
      // ① 注册项里没有 resolveCredential（opencode 走 identitySlots 槽制）
      const registration = indexCode.slice(indexCode.indexOf('const opencodeAdapter = registerOpencodeLlm('))
      const registrationEnd = registration.indexOf('\n  })')
      const block = registration.slice(0, registrationEnd)
      expect(block, 'opencode 注册项出现了 resolveCredential —— 它不再是槽制，需重新评估').not.toContain('resolveCredential')
      // ② 槽位快照的类型定义里不携带模型级限流。
      // ⚠️ 锚点必须用 `export interface PoolEntrySnapshot`（定义处），不能
      // 只搜类型名 —— 名字在 import / 注释里更早出现，按名字切会落到无关代码上
      // （写用例时实测到：切出来是 `nextFingerprintGeneration`）。
      const snapshotStart = opencodeAuthSource.indexOf('export interface PoolEntrySnapshot')
      expect(snapshotStart, 'PoolEntrySnapshot 的定义没找到，检查类型是否被移动或改名').toBeGreaterThan(-1)
      const snapshotType = opencodeAuthSource.slice(snapshotStart, opencodeAuthSource.indexOf('\n}', snapshotStart))
      expect(snapshotType, 'PoolEntrySnapshot 携带了 modelRateLimits —— opencode 已进入本 issue 的形态').not.toContain('modelRateLimits')
      // ③ 槽位列举只按 enabled 过滤，不看模型级限流
      const listSlots = opencodeAuthSource.slice(opencodeAuthSource.indexOf('function listIdentitySlots'))
      expect(listSlots, 'listIdentitySlots 开始处没找到').not.toContain('modelRateLimits')
    })

    /**
     * **zcode 是唯一「不接判定也算对」的一家**（2026-10-06 对抗性审计推翻了我最初的接线）。
     *
     * 我最初把 zcode 也接上了，理由是「池取不到号就该判限流」。审计指出这会收窄
     * 可用性，我用临时探针（真实 `apply()` + 真账号池）实测确认**审计是对的**：
     * `zcode.current()` 的兜底会**再读一次账号池**（`readStoredCredential` →
     * `readCredentialFromPool`），且既不看 `enabled`、也不看 `modelRateLimits`：
     *
     * | 场景（账号池状态） | `zcode.current()` 返回 |
     * |---|---|
     * | 唯一启用账号被该模型限流、凭据合法 | **那份凭据** ⇒ 不会误报「未登录」 |
     * | 池里另有「停用但健康」账号且排在前面 | **那个停用账号的凭据** ⇒ 请求能跑通 |
     *
     * ⇒ ① IKJOZ9 的症状在 zcode 身上**不存在**（它不报「未登录」）；② 加判定会把
     * 上表第二行那发**能跑通的请求变成硬失败**。故 zcode 刻意不接 —— 这条断言
     * 防止后来者「看到别人都接了，顺手也给 zcode 补上」。
     */
    it('zcode 刻意不接限流判定：它的兜底会再读池，本就不会误报「未登录」', () => {
      const at = indexCode.indexOf('throwIfAllAccountsRateLimited(ZCODE, modelId)')
      expect(at, 'zcode 又被接上判定了 —— 它的兜底 current() 会再读池，加判定会收窄可用性（见本用例注释）').toBe(-1)
      // 且必须确认 zcode 的取号点仍在（否则这条会因为「整段被删」而假绿）。
      expect(indexCode, 'zcode 的取号点不见了，兜底 current() 也应一并复核').toContain('getAvailableAccount(ZCODE.id, modelId')
      expect(indexCode, 'zcode 的兜底应仍是 zcode.current()').toContain('await zcode.current()')
    })
  })
})
