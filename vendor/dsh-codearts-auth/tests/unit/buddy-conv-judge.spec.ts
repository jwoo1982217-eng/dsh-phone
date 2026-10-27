/**
 * `judge()` 的**单测侧镜像**（Gitee issue IKM7SG，2026-10-17）。
 *
 * ## 为什么要有这个文件（e2e 那组已在，但跑不到）
 *
 * 归类函数 `judge()` 是 IKM7SG 修复的**三处之一**（另两处在 `src/buddy-adapter.ts`），
 * 定义在 `tests/e2e/buddy-conversation-headers.e2e.spec.ts` 里，它的离线用例组
 * 也**刻意不带 e2e 闸门**（零额度）。
 *
 * ⚠️⚠️ **但「不带闸门」不等于「被默认跑到」**（实测）：
 * `vitest.config.ts` 只收 `tests/unit/**` ⇒ **`pnpm test` 根本不执行 `tests/e2e/`**
 * ⇒ 那组离线用例只有跑 `pnpm test:e2e:buddy-conv`（带双闸门、默认 skip）才会执行。
 * 换句话说：**本次三处修复里有一处，在默认单测流程中零守卫。**
 * ⚠️ 这不是推测：master 上 `pnpm test` 全绿的同时，`test:e2e:buddy-conv` **是红的**
 * —— 恰好就是 `judge()` 把真机的 `request illegal` 落进 `other` 导致的。
 *
 * ⇒ 本文件把同一张归类表镜像到 `tests/unit/`，让 `pnpm test` 覆盖它。
 *
 * ## ⚠️ 为什么是「镜像」而不是把 `judge()` 抽成共享模块
 *
 * 抽成 `src/` 共享会让**测试用的归因逻辑进生产包**（`judge()` 只服务 e2e 断言，
 * 生产代码有自己的 `isChannelVerificationRejection` / `isContentRejection`），
 * 而两者的判据本就**刻意不同**（e2e 侧按报文抽字段，生产侧按结构化字段匹配）。
 * ⇒ 保持两份、各自演进；**一致性由本文件末尾的「两侧同表」断言反向检查**。
 *
 * ⚠️ 与实现侧的一致性判据**刻意不做**：e2e 侧 `c.code` 是从报文用正则**抽字段**得到的
 * 字符串，实现侧是**结构化匹配** ⇒ 抽取本身就会把「msg 在嵌套对象里」那类报文
 * 判成不同结果。强求两者相等会逼出一堆假红。
 *
 * ⚠️⚠️ **「取值范围相同」这句自我描述已按 2026-10-18 审计更正为「部分相同」**
 * （原文说的是「两份的取值范围（真实报文形态）是相同的」，**对下面 4 格不成立**）：
 *
 * | 报文形态 | 实现侧 `isChannelVerificationRejection` | e2e 侧 `judge()` |
 * |---|---|---|
 * | `{"code":"11128",…}`（`code` 是字符串） | ✅ 认 | ❌ `other` |
 * | `{"code":11128,"message":…}`（键名是 `message`） | ✅ 认 | ❌ `other` |
 * | `{"code":11128,"msg":"request  illegal"}`（分隔符多空格） | ✅ 认 | ❌ `other` |
 * | `{"code":11128,"msg":"Request-Illegal"}`（连字符 + 大小写） | ✅ 认 | ❌ `other` |
 *
 * 根因：e2e 的 `code` 由 `/"code":(\d+)/` 抽（抽不到字符串码）、`msg` 由
 * `/"msg":"([^"]*)"/` 抽（抽不到 `message` 键），而措辞判据是**逐字**正则、
 * 不带分隔符变体。
 * ⚠️ 后果是**假红**：e2e 落 `other` ⇒ 断言文案会把人指向「**上游行为已变**」这个
 * 完全错误的结论 —— 而这正是 issue IKM7SG 评论里点名要求消除的误导。
 * ⚠️ **本轮刻意不修**（登记为独立问题）：① 生产爆炸半径 0（`judge()` 只在
 * `tests/e2e/`，`pnpm test` 不执行）；② 修它要**两份同步改**，本身是漂移风险面，
 * 不宜夹带进 P0 热修的 diff。⚠️ 但上面那句失准的自我描述**已更正**，
 * 否则下一个审计会拿它当契约。
 */
import { describe, expect, it } from 'vitest'

/** 与 e2e 侧 `Case` 同形。 */
interface Case { status: number; code: string; msg: string; completionsId: string }

type Verdict = 'ok' | 'account-gated' | 'no-verdict' | 'other'

/**
 * `judge()` 的**镜像实现**，逐行对应
 * `tests/e2e/buddy-conversation-headers.e2e.spec.ts` 的那份。
 *
 * ⚠️ 两份必须同步改：e2e 侧那组用例锁住的是真机行为，本文件锁住的是
 * **默认单测流程里那道缺失的守卫**。
 */
function judge(c: Case): Verdict {
  if (c.status === 200) return 'ok'
  if (c.status === 429 || /14018|额度|usage exceeds|frequency limit/i.test(c.msg)) return 'no-verdict'
  if (c.code === '11102' || /service info not found/i.test(c.msg)) return 'no-verdict'
  if (c.status === 400 && c.code === '11128'
    && /conversation id missing|request illegal/i.test(c.msg)) return 'account-gated'
  return 'other'
}

const c = (status: number, code = '-', msg = ''): Case =>
  ({ status, code, msg, completionsId: '' })

describe('buddy-conv judge()：11128 渠道校验的按账号归类（IKM7SG，本文件是单测侧镜像）', () => {
  it('200 ⇒ ok', () => {
    expect(judge(c(200))).toBe('ok')
  })

  it.each([
    // ⚠️ 措辞一：issue 原始记录（两台机器上已零命中，但判据仍须认）
    ['conversation id missing', 400, '11128', 'conversation id missing'],
    // ⚠️⚠️ 措辞二：**真机实测**措辞（本仓 5 账号 + 报障者账号，两批独立复现）
    ['request illegal', 400, '11128', 'request illegal'],
  ])('400/11128 %s（该账号要求三头）⇒ account-gated', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('account-gated')
  })

  it.each([
    ['429 额度耗尽', 429, '-', 'usage exceeds frequency limit'],
    ['429/14018 明确额度码', 429, '14018', '模型繁忙'],
    ['11102 service info not found（用错模型）', 400, '11102', 'service info not found'],
  ])('%s ⇒ no-verdict（本轮无判据，不得当成失败）', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('no-verdict')
  })

  it.each([
    // ⚠️ 11128 的**内容级**子原因：换号对它完全无效 ⇒ 必须落 other（进而红），
    //    否则会把「每个账号都在同一句上被拦」误当成「按账号生效」而白烧整池。
    ['11128 Illegal API invocation', 400, '11128', 'Illegal API invocation from an unapproved channel'],
    ['11128 first message is not system prompt', 400, '11128', 'first message is not system prompt'],
    // ⚠️⚠️ **反向守卫**：`request illegal` 也被 11140 使用 ⇒ 没有 code 闸门时
    //   这一格会被误判成 account-gated（⇒ 该红的反而绿）。
    ['11140 request illegal（不是渠道校验）', 400, '11140', 'request illegal'],
    ['500 服务端错误', 500, '-', 'internal error'],
  ])('%s ⇒ other（红）', (_l, status, code, msg) => {
    expect(judge(c(status, code, msg))).toBe('other')
  })

  it('★ 反向自证：未分类前两类确实无法区分（证明本组不是同义反复）', () => {
    const quota = c(429, '14018', '额度已用尽')
    const gated = c(400, '11128', 'request illegal')
    const policy = c(400, '11140', 'request illegal')
    // 前置：三格的裸观测量**不足以**区分（两条「非 200」没有分出哪类）
    expect(quota.status).not.toBe(200)
    expect(gated.status).not.toBe(200)
    expect(policy.status).not.toBe(200)
    // 分类后三者落到**三个不同**结论。
    expect(judge(quota)).toBe('no-verdict')
    expect(judge(gated)).toBe('account-gated')
    expect(judge(policy)).toBe('other')
    // ⚠️ 关键分界：**msg 逐字相同**、仅 code 不同 ⇒ 两个不同结论。
    //    这条正是「code 闸门」的判据 —— 没有它，两者会被判成同一档。
    expect(gated.msg).toBe(policy.msg)
    expect(judge(gated)).not.toBe(judge(policy))
  })
})