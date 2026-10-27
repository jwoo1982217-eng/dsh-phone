/**
 * `X-Conversation-*` 三头的**真机对照凭据**（Gitee issue IKM73W / IKM7SG）。
 *
 * ## ⚠️ 为什么这个探针不可省
 *
 * 2026-10-16 两轮审计用真实凭据实测（约 90 次请求）**证伪**了本仓库曾写进注释的
 * 结论「三头缺任一即 400/11128 `conversation id missing`」：
 * - 逐枚消融适配器构造的 **14 枚头，全部仍 200**（含这三枚）；
 * - 6 模型 × 4 请求形状 = 48 格，三头与响应状态**零关联**；
 * - 逐级剥到「连 UA / 鉴权头 / 身份头都不发」仍 200；
 * - `conversation id missing` **零次复现**（同批复现了另两句 11128）。
 *
 * 同时实测到一条**机制性结论**：上游把三头**回显**成 completion id 的种子
 * （填 `abc-123` ⇒ 回包 `"id":"abc-123"`）。
 *
 * ## ⚠️⚠️ 但「三头**不是**准入必需」是**按账号**的，不是全局结论（IKM7SG，2026-10-16）
 *
 * 报障者用**本文件**、**只换 `WB_REF`**，结果就分叉（模型固定 `deepseek-v4.1-flash`）：
 *
 * | `WB_REF` | 基线 | 删任一枚 | 三枚全删 |
 * |---|---|---|---|
 * | `D87606B1` | ✅ 200 | ✅ 200 | ✅ 200 |
 * | **`66E05E7C`** | ✅ 200 | ❌ **400/11128** | ❌ **400/11128** |
 *
 * ⇒ **两边都没错，差的是「账号」这个控制变量。** 在 `66E05E7C` 上逐项单变量穷举：
 * `X-User-Id`/`X-Session-ID`/`X-Agent-Intent`/`X-Request-Id`/`X-Trace-Id`/`X-Client-Platform`
 * 全 400（都不是判据）；**仅补一枚** Conv 头仍 400；**三枚同值 / 各自不同 / 填 `abc-123`
 * 全 200**（不校验值语义、不要求一致）；**三枚填空串 400**；带三头→紧接无头 `200→400`
 * ⇒ **逐请求**判定（非封禁、非粘性）；换 system / 换最简 body 仍 400（**内容无关**）。
 * ⇒ 判据 = 「**三枚 Conv 头同时存在且非空**」，**但仅对该账号生效**。
 *
 * ⚠️ **为什么只有该账号：未知**（IKM7SG 明确未定论）。唯一可观测差异是
 * `66E05E7C` 的 token 缺 `name`/`family_name`/`given_name`（1321 vs 1414 字符，
 * 即一次未走完整 profile 流程的凭据）—— **n=1、无因果证据，仅作线索**。
 *
 * ✅ **可向上游升级的具体凭据**（IKM7SG 第二次取证，2026-10-16 19:23，模型
 * `deepseek-v4.1-flash`）：该账号在「无三头 / 仅 `-ID` / 仅 `-Request-ID` /
 * 仅 `-Message-ID`」四格各得一个 `400/11128`，`requestId` 依次为
 * `e9ddbadc-…-25374490f57a`、`48a02add-…-3adba1e6d202`、
 * `20c1e310-…-5d8592e0f379`、`c0942bd4-…-712e0de8675a`
 *（完整值见 `docs/agent-notes/providers-buddy.md` 的 IKM7SG 节）。
 * 同一现象跨**约 7 小时**稳定（12:26 / 12:45 / 13:32 / 19:23 四次均 400）
 * ⇒ **「上游抖动」这一解释已被排除**；但「为什么只有该账号」仍**未定论**。
 * ⚠️ 本仓库**未独立复跑**那四发（无该账号凭据）。
 *
 * ⇒ **本文件的两个用例对「该账号」会红，而红因是账号、不是上游行为变更。**
 * 断言文案必须据此区分（见下方 `judge` 的说明），否则会把人引向错误结论。
 *
 * ⚠️⚠️ **这份数据现在写进了多处注释与文档，但它一度与它推翻的原表享有完全相同的
 * 证据等级 —— 零。** 本仓库的规矩（见 `tests/e2e/README.md` 与
 * `src/openai-gateway/tencent-fingerprint.ts` 文件头）：
 * **单测只能锁「代码按某个范围做」，锁不住「那个范围本身对不对」**。
 * 上面两条结论都是「范围本身」，只能靠真实请求固定。
 *
 * ⇒ 本文件就是那份缺失的凭据。**任何人都能重跑它来推翻或确认上述结论。**
 *
 * ## 闸门（双重，缺一不可 —— 被拒不耗额度，但列目录仍要显式确认）
 * ```
 * DSH_BUDDY_CONV_E2E=1
 * DSH_BUDDY_CONV_E2E_CONFIRM=yes
 * ```
 *
 * ## 跑法
 * ```
 * pnpm test:e2e:buddy-conv
 * ```
 * 可用环境变量覆盖：
 * - `WB_REF` —— 凭据 ref（默认读账号池里**全部** workbuddy 账号，逐账号对照，
 *   见下「账号矩阵」）
 * - `WB_MODEL` —— 模型（默认 `fast-model`；⚠️ 见下方「两个复现陷阱」）
 * - `DSH_BUDDY_CONV_E2E_FIRST_ONLY=1` —— **只跑账号池第一个账号**（省额度；
 *   默认跑全部，理由见下）
 *
 * ## ⚠️ 账号矩阵（默认跑全部账号）
 *
 * IKM7SG 的教训：本文件原先**只跑一个账号**（池里第一个），于是「某个账号要求三头」
 * 这类边界**永远取决于本机池顺序是否恰好命中** —— 命中就红、不命中就绿，
 * 而**红绿都说明不了上游行为**。
 * ⇒ 默认改为**逐账号**跑（每个账号独立判据、独立归因）。代价是额度 × 账号数
 *（每例 `max_tokens=8`）；要省额度用 `DSH_BUDDY_CONV_E2E_FIRST_ONLY=1` 退回单账号。
 *
 * ## ⚠️ 两个复现陷阱（IKM7SG 实测，都会让「本轮无判据」而不是给出真判据）
 *
 * 1. **`firstWorkbuddyRef()` 取池里第一个账号，而它可能额度已耗尽** ——
 *    IKM7SG 实测 `66E05E7C` 的 `fast-model` 额度耗尽 ⇒ 基线直接 `429/14018`
 *    ⇒ 整套用例因「基线不通」而**无判据**。
 * 2. **`deep-model` 恒报 11102 `service info not found`** ⇒ 会把「不支持该模型」
 *    伪装成判据。
 * ⇒ 基线不通时**必须**明确说「本轮无判据、换账号或换模型再跑」，不得当成失败结论。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

const E2E = process.env.DSH_BUDDY_CONV_E2E === '1'
  && process.env.DSH_BUDDY_CONV_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip

const CONV = ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']
const MODEL = process.env.WB_MODEL ?? 'fast-model'
/** 只跑池里第一个账号（省额度）；默认跑全部账号，理由见文件头「账号矩阵」。 */
const FIRST_ONLY = process.env.DSH_BUDDY_CONV_E2E_FIRST_ONLY === '1'

/**
 * 从 `~/.dsh/.credentials.yaml` 取某 ref 的凭据。
 *
 * ⚠️ 该文件是 **YAML**：值是**单引号包裹的 JSON 字符串**，且串内可以有**真实 LF**
 * （本仓 `scope` 字段就是多行）⇒ 直接 `JSON.parse` 原文会报
 * `Bad control character in string literal`。这里只做本探针需要的取值，不引 yaml 依赖：
 * YAML 单引号串内 `''` 表示一个字面 `'`，LF 会被折叠成空格。
 */
function credentialFor(ref: string): BuddyCredential {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const key = `${ref}:`
  const idx = text.indexOf(key)
  if (idx < 0) throw new Error(`凭据 ${ref} 未找到`)
  const body = text.slice(idx + key.length).slice(text.slice(idx + key.length).indexOf("'") + 1)
  let i = 0
  for (;; i += 1) {
    if (body[i] === "'") {
      if (body[i + 1] === "'") { i += 1; continue }
      break
    }
  }
  const raw = body.slice(0, i).replace(/''/g, "'").replace(/\r?\n\s*/g, '\\n')
  return JSON.parse(raw) as BuddyCredential
}

/**
 * 账号池里**全部** workbuddy 账号的凭据 ref（`FIRST_ONLY` 时只取第一个）。
 *
 * ⚠️ 默认取全部：见文件头「账号矩阵」—— IKM7SG 的教训是「只跑一个账号」会让
 * 「某个账号要求三头」这条边界**取决于本机池顺序是否恰好命中**（红绿都不说明上游行为）。
 * 顺序即池内顺序（用户在 Jet Hub 拖拽的顺序），故**可复现**。
 */
function workbuddyRefs(): string[] {
  const state = JSON.parse(
    readFileSync(join(homedir(), '.dsh', 'jet-hub', 'state.json'), 'utf8'),
  ) as { accounts?: { provider?: string; credentialRef?: string }[] }
  const refs = (state.accounts ?? [])
    .filter((a) => a.provider === 'workbuddy')
    .map((a) => a.credentialRef)
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
  if (refs.length === 0) throw new Error('账号池里没有 workbuddy 账号')
  return FIRST_ONLY ? refs.slice(0, 1) : refs
}

/**
 * 账号 × 环境覆盖后的待测 ref 列表。
 *
 * ⚠️ `WB_REF` 仍受支持（IKM7SG 的复现方式就是「只换 `WB_REF`」）——
 * 一旦显式给出，就**只跑它**（不再展开账号矩阵），否则用账号池全量。
 */
function targetRefs(): string[] {
  const explicit = process.env.WB_REF
  if (explicit !== undefined && explicit.length > 0) return [explicit]
  return workbuddyRefs()
}

interface Case { status: number; code: string; msg: string; completionsId: string }

/**
 * 一次实测的**归因**：把「上游行为」与「本机账号/额度」分开。
 *
 * ⚠️⚠️ 这是 IKM7SG 之后本文件最重要的改动。原先的断言只有「状态 == 200」，
 * 于是**任何**非 200 都被读成「三头是准入必需」（即证实了那条已被推翻的旧结论）。
 * 但实测已知至少三类非 200 与三头**无关**：
 * | 观测 | 真因 | 归因 |
 * |---|---|---|
 * | `429` / `14018` | 该账号该模型**额度耗尽** | `no-verdict`（本轮无判据） |
 * | `11102 service info not found` | 用了 `deep-model` | `no-verdict` |
 * | **`400` / `11128 conversation id missing`** | **该账号要求三头**（IKM7SG） | `account-gated` |
 * | 其它 `400`（如 `first message is not system prompt`） | 请求形状问题 | `other` |
 */
type Verdict = 'ok' | 'account-gated' | 'no-verdict' | 'other'

/**
 * ★★ **离线判据用例**（零额度、**刻意放在闸门之外**）。
 *
 * ## 为什么必须有它
 *
 * `judge()` 是本次改动**新增的核心逻辑**：本文件里**全部**断言都经过它分类，
 * 它判错一格就会把「额度耗尽」读成「上游行为变更」、或把真正的行为变更**放过**。
 * 而它自己此前只在真机 e2e 里跑（**有双闸门、默认跳过**）⇒ 等于**零守卫**。
 *
 * ⇒ 本组把它的每一格都固定住（用 `describe` 而非 `suite`，即**不需要** e2e 闸门）。
 * ⚠️ 与 `image-limit-bisect.e2e.spec.ts` 的「图片边界判据（离线，不消耗额度）」
 * 同款做法。
 *
 * ⚠️⚠️ **但「不需要闸门」≠「被 `pnpm test` 跑到」**（2026-10-17 审计实测更正）：
 * 本文件在 `tests/e2e/` 下，而 `vitest.config.ts` 只收 `tests/unit/**`
 * ⇒ **`pnpm test` 根本不执行本组**，只有 `--config vitest.e2e.config.ts` 才跑。
 * 本组标注「零额度、不需要闸门」是对的，但**实际覆盖它的是 e2e 那条命令**，
 * 不是默认的单测命令 —— 而 `judge()` 是本次三处修复之一，把它放在默认跑不到的
 * 通道里，等于该修复**在 CI/本地默认流程中无守卫**。
 * ⚠️ 处理：见 `tests/unit/` 下 `buddy-conv-judge.spec.ts`（本组逻辑的**单测侧镜像**，
 * 断言同一张归类表）—— 两处刻意并存，因为 e2e 侧那组必须与真机报文同源演进。
 */
describe('judge() 归因：把「上游行为」与「本机账号/额度」分开（离线，零额度）', () => {
  const c = (status: number, code = '-', msg = ''): Case => ({
    status, code, msg, completionsId: '',
  })

  it('200 ⇒ ok', () => {
    expect(judge(c(200))).toBe('ok')
  })

  it.each([
    // ⚠️ 这一格是**本文件的立命之本**：`66E05E7C` 类账号确实要求三头。
    //    若把它错判成「上游行为变更」，就会按旧结论去改实现/注释。
    ['400/11128 conversation id missing（该账号要求三头）', 400, '11128', 'conversation id missing'],
    // ⚠️⚠️ 这一格是**本机真机实测的措辞**（2026-10-17 复现 + 报障者独立复现）：
    //    真实报文稳定是 `request illegal`，`conversation id missing` 在两台
    //    机器、两批账号上**零命中**。少这一格 ⇒ master 上那个红就是从这里来的。
    ['400/11128 request illegal（真机实测措辞，本账号要求三头）', 400, '11128', 'request illegal'],
  ])('%s ⇒ account-gated', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('account-gated')
  })

  it.each([
    ['429 额度耗尽', 429, '-', 'usage exceeds frequency limit'],
    ['429/14018 明确额度码', 429, '14018', '模型繁忙'],
    ['200 里的 14018 异常形态', 400, '14018', '额度已用尽'],
    ['11102 service info not found（用错模型）', 400, '11102', 'service info not found'],
  ])('%s ⇒ no-verdict（本轮无判据，不得当成失败）', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('no-verdict')
  })

  it.each([
    // ⚠️ 这些才是**真正需要人看**的东西 ⇒ 必须落到 `other`（进而红）。
    ['400/11128 但 msg 不是 conversation id missing（别族子原因）', 400, '11128', 'Illegal API invocation from an unapproved channel'],
    ['400 first message is not system prompt', 400, '11128', 'first message is not system prompt'],
    ['500 服务端错误', 500, '-', 'internal error'],
    ['403 认证类', 403, '-', 'forbidden'],
  ])('%s ⇒ other（红）', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('other')
  })

  it('★ 反向自证：判据本身在**未分类**前确实会把两类混淆（证明本组不是同义反复）', () => {
    // 「只看 status == 200」这条旧判据会把下面两格都读成「失败」——
    // 而它们的真因分别是「额度」与「该账号要求三头」，都不是上游行为变更。
    const quota = c(429, '14018', '额度已用尽')
    const gated = c(400, '11128', 'conversation id missing')
    expect(quota.status).not.toBe(200)
    expect(gated.status).not.toBe(200)
    // 分类后两者都不再是「其它失败」⇒ 旧的裸断言无法区分，本函数能。
    expect(judge(quota)).toBe('no-verdict')
    expect(judge(gated)).toBe('account-gated')
    expect(judge(quota)).not.toBe(judge(gated))
  })
})

function judge(c: Case): Verdict {
  if (c.status === 200) return 'ok'
  if (c.status === 429 || /14018|额度|usage exceeds|frequency limit/i.test(c.msg)) return 'no-verdict'
  if (c.code === '11102' || /service info not found/i.test(c.msg)) return 'no-verdict'
  // ⚠️ 这一格正是 IKM7SG 的发现：该账号**确实**要求三头 ⇒ 不是上游行为变更，
  //    而是「本文件的结论在**该账号**上不成立」。断言文案必须区分（见下方用例）。
  //
  // ⚠️⚠️ `msg` 必须**同时**认两句（2026-10-17 真机复现，master 上的独立复验）：
  // IKM7SG 记的是 `conversation id missing`，而本机实测稳定拿到的是
  // **`request illegal`** —— 两句都对应「该账号要求三头」这一形态，
  // 只认一句会让另一半真实报文落进 `other` 而假红。
  // ⚠️ 这里**必须带 code 闸门**：`request illegal` 也是 11140 族在用的措辞，
  // 只按 msg 判会把 11140 也算成 account-gated（与实现侧的收窄口径一致）。
  if (c.status === 400 && c.code === '11128'
    && /conversation id missing|request illegal/i.test(c.msg)) return 'account-gated'
  return 'other'
}

/** 走**真实适配器**，在 `fetchImpl` 里按 `drop` 删头后转发到真实上游。 */
async function viaAdapter(
  credential: BuddyCredential, ref: string, drop: string[],
): Promise<Case> {
  let status = 0
  let body = ''
  const fetchImpl: typeof fetch = async (url, init) => {
    const h = new Headers(init?.headers as HeadersInit)
    for (const name of drop) h.delete(name)
    const res = await fetch(url, { ...init, headers: h })
    status = res.status
    body = (await res.clone().text()).slice(0, 600)
    return res
  }
  const adapter = new BuddyAdapter({
    credentialRef: ref as never,
    resolveCredential: async () => credential,
    refresh: async () => {},
    sessionId: 'conv-e2e-probe',
    product: WORKBUDDY,
    fetchImpl,
  })
  try {
    const prepared = await adapter.prepareCall('workbuddy', MODEL)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of prepared.stream({
      model: MODEL,
      messages: [{ role: 'user', content: '回复 OK' }],
      system: 'You are a helpful assistant.',
      maxTokens: 8,
    })) { /* 只为把流消费掉 */ }
  } catch {
    // 失败信息取自 HTTP 状态与报文，不取自异常 —— 判据在上游那侧。
  }
  return {
    status,
    code: /"code":(\d+)/.exec(body)?.[1] ?? '-',
    msg: /"msg":"([^"]*)"/.exec(body)?.[1] ?? '',
    completionsId: /"id":"([^"]+)"/.exec(body)?.[1] ?? '',
  }
}

suite('IKM73W / IKM7SG：X-Conversation-* 三头的真机对照（消耗真实额度，每例 max_tokens=8）', () => {  /**
   * ★★ **逐账号**跑逐枚消融，并按**归因**分类（IKM7SG，2026-10-16）。
   *
   * ## 为什么必须逐账号 + 分类归因
   *
   * 原先本用例**只跑池里第一个账号**、且断言只有「状态 == 200」。IKM7SG 实测那
   * 会把两类**与三头无关**的失败读成「三头是准入必需」：
   * - 该账号该模型**额度耗尽** ⇒ `429/14018`；
   * - `deep-model` ⇒ `11102 service info not found`。
   * 而真正的分叉是**第三个**：**某些账号**（实测 `66E05E7C`）在三头缺失时**确实**
   * 返回 `400/11128`，另一些（实测 `D87606B1`）**不返回**。
   *
   * ## 判据（按归因，不按裸状态码）
   *
   * - `account-gated` ⇒ **跳过**该账号（它**确实**要求三头，与「上游行为变更」无关，
   *   而「非准入必需」这条结论**本来就不是全局的**）；打印告警；
   * - `ok` ⇒ 断言成立（该账号上三头非必需）；
   * - `no-verdict`（额度耗尽 / 用错模型）⇒ **跳过**并明确说「本轮无判据」；
   * - `other`（别的 400）⇒ **红**，那才是真需要人看的东西。
   *
   * ⚠️ 仍保留一条**能红的**判据：若某账号基线 200、删头后**既不是** `account-gated`
   * **也不是** `no-verdict` 却失败 ⇒ 才是「上游行为变更」。
   */
  it('逐枚消融（逐账号）：每一枚头删掉后请求仍应成功，除非该账号本就要求三头', async () => {
    const refs = targetRefs()
    console.log(`\n===== 模型 ${MODEL} / 端点 ${WORKBUDDY.endpoint} / 账号数 ${refs.length} =====`)

    const summary: string[] = []
    for (const ref of refs) {
      const credential = credentialFor(ref)
      console.log(`\n----- 账号 ${ref} -----`)

      // ⚠️ 先验基线：不删任何头。若基线就不通，后续每格都**无判据**（额度/模型失效
      // 都会伪装成「三头必需」）⇒ 该账号**跳过**（不是失败），并说明原因。
      const baseline = await viaAdapter(credential, ref, [])
      const baselineVerdict = judge(baseline)
      console.log(`  基线（头一枚不减）：HTTP ${baseline.status} ${baseline.code} ${baseline.msg} ⇒ ${baselineVerdict}`)
      if (baselineVerdict !== 'ok') {
        const why = baselineVerdict === 'no-verdict'
          ? `基线就不通且**不是**三头问题（${baseline.code} ${baseline.msg}）—— 换模型或换账号再跑，本轮该账号无判据`
          : `基线异常（${baseline.code} ${baseline.msg}）`
        summary.push(`  ${ref}: ${baselineVerdict}（基线 ${baseline.status}）`)
        // `no-verdict` 是**已知的无判据形态**（额度/模型），跳过而不红；
        // `other` 才交给断言去红（那才是需要人看的）。
        if (baselineVerdict === 'no-verdict') continue
        expect(baseline.status, why).toBe(200)
      }

      // 逐枚消融。⚠️ **必须逐枚单独跑**：并起来删只会得到「缺这三枚仍 200」，
      // 无法区分「三枚都不需要」与「其中某几枚需要」。
      const rows: string[] = []
      const results: Array<{ name: string; c: Case }> = []
      for (const name of CONV) {
        const r = await viaAdapter(credential, ref, [name])
        results.push({ name, c: r })
        rows.push(`  删 ${name.padEnd(28)} → HTTP ${r.status} ${r.code} ${r.msg} ⇒ ${judge(r)}`)
      }
      const allThree = await viaAdapter(credential, ref, CONV)
      results.push({ name: '（三枚全删）', c: allThree })
      rows.push(`  删 三枚全删${' '.repeat(21)}→ HTTP ${allThree.status} ${allThree.code} ${allThree.msg} ⇒ ${judge(allThree)}`)
      console.log(`\n===== 逐枚消融 =====\n${rows.join('\n')}`)

      const gated = results.filter((x) => judge(x.c) === 'account-gated')
      if (gated.length > 0) {
        // ⚠️ 这正是 IKM7SG 的分叉：**该账号**确实要求三头。**不是**上游行为变更，
        //    也不与「多数账号上三头非必需」矛盾 —— 两个结论范围不同。
        console.warn(
          `⚠️ 账号 ${ref} 要求三头（${gated.length}/${results.length} 格为 400/11128，`
          + `实测 msg 为 \`request illegal\`）—— 这不是上游行为变更，而是 IKM7SG 记录的`
          + `「按账号生效」：本用例在该账号上不适用。请勿据此改动实现或注释。`,
        )
        summary.push(`  ${ref}: account-gated（${gated.length}/${results.length} 格被拒）`)
        continue
      }
      summary.push(`  ${ref}: ok（${results.length} 格全 200）`)

      // 只有「既非 account-gated、也非 no-verdict」的失败才红。
      for (const { name, c } of results) {
        const v = judge(c)
        if (v === 'no-verdict') {
          console.warn(`⚠️ ${ref} / ${name}：无判据（${c.code} ${c.msg}）`)
          continue
        }
        expect(
          c.status,
          `账号 ${ref}：删掉 ${name} 后失败（${c.code} ${c.msg}），且**不是** IKM7SG 记录的`
          + `「该账号要求三头」形态 ⇒ 这才是「上游行为变更」，请更新注释与 `
          + `docs/agent-notes/providers-buddy.md`,
        ).toBe(200)
      }
    }

    console.log(`\n===== 账号汇总 =====\n${summary.join('\n')}`)
  }, 900_000)

  it('回显：X-Conversation-ID 的值会出现在回包 id 里（逐账号）', async () => {
    const refs = targetRefs()
    for (const ref of refs) {
      const credential = credentialFor(ref)
      const marker = 'abc123'
      const convId = `${marker}${'0'.repeat(32 - marker.length)}`
      const base: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Agent-Purpose': 'conversation',
        'X-Domain': WORKBUDDY.apiDomain,
        'X-Product-Code': WORKBUDDY.productCode,
        'X-Product': WORKBUDDY.attributionName,
        'X-IDE-Name': WORKBUDDY.attributionName,
        'X-IDE-Type': WORKBUDDY.attributionName,
        'X-IDE-Version': WORKBUDDY.clientVersion,
        'User-Agent': WORKBUDDY.userAgent,
      }
      const res = await fetch(`${WORKBUDDY.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...base,
          Authorization: `Bearer ${credential.access_token}`,
          'X-Conversation-ID': convId,
          'X-Conversation-Request-ID': convId,
          'X-Conversation-Message-ID': convId,
        },
        body: JSON.stringify({
          model: MODEL, stream: true, max_tokens: 8,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: '回复 OK' },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const text = (await res.text()).slice(0, 600)
      const id = /"id":"([^"]+)"/.exec(text)?.[1] ?? ''
      console.log(`\n  账号 ${ref}`)
      console.log(`  发的 X-Conversation-ID = ${convId}`)
      console.log(`  回包 id                = ${id}`)
      console.log(`  HTTP                   = ${res.status}`)
      // ⚠️ 本用例**三枚都发**，故**不受** IKM7SG 那条「三枚必须齐全」的按账号校验影响
      //（该账号要求的正是「三枚同时存在且非空」，这里满足了）。
      // ⇒ 它不像上面那条消融用例那样需要按账号分叉；但仍逐账号跑，因为
      //   「回显」这条机制本身可能按账号不同（IKM7SG 只在 66E05E7C 上复核过）。
      // ⚠️ 无判据形态（额度耗尽 / 用错模型）跳过，不红 —— 否则会把额度问题
      //   读成「回显机制失效」。
      const v = judge({ status: res.status, code: /"code":(\d+)/.exec(text)?.[1] ?? '-', msg: /"msg":"([^"]*)"/.exec(text)?.[1] ?? '', completionsId: id })
      if (v === 'no-verdict') {
        console.warn(`⚠️ 账号 ${ref}：无判据（HTTP ${res.status}）—— 换模型或换账号再跑`)
        continue
      }
      expect(res.status, `账号 ${ref}：HTTP ${res.status}`).toBe(200)
      // 机制性结论：上游拿三头当 completion id 的种子 ⇒ 从机制上就不可能是
      // 「过不了就 400」的闸门。⚠️ 若上游将来改用独立 id 生成器，本用例会红 ——
      // 那是**上游行为变更**，届时三头的「无害」前提需重新评估。
      expect(id, `账号 ${ref}：回包 id 未含所发的三头值 ⇒ 回显机制失效`).toContain(marker)
    }
  }, 600_000)
})
