/**
 * ZCode **按模型额度**（专属桶 vs 通用赠送桶）的回归测试。
 *
 * **真实缺陷**（用户报障 2026-10-12）：
 *
 * > 智谱账号送的 8m 算力其中分为 5.3-3m 和 5.3flsh-5m，插件判断这个账号
 * > 没用完，就不会切换下一个账号使用……可否判定 plan 中的 token 是属于哪个
 * > 模型专属的
 *
 * ## 本机只读实测（`scripts/probe-zcode-plan-buckets.mjs`，HTTP 200）
 *
 * ```json
 * [bucket] show_name="GLM-5.3"        capabilities=["model:glm-5.3"]
 *          total_units=3000000        remaining_units=3000000
 * [bucket] show_name="GLM-5.3-Flash"  capabilities=["model:glm-5.3-flash"]
 *          total_units=5000000        remaining_units=5000000
 * ```
 *
 * ⇒ 8M = 3M + 5M，**每个桶带一个模型归属**（`capabilities`），而旧实现把它丢弃。
 *
 * ## 本文件守的三件事
 *
 * 1. **读得到**：`fetchZcodeBalance` 必须把 `capabilities` / `entitlement_id`
 *    带出来（否则判据无米下锅）。
 * 2. **判得对**：`exhaustedModelsOf` 的三格 —— 专属桶见底要标；
 *    **通用桶还有余额时绝不能标**（用户明确要求）；
 *    专属桶还有余额时绝不能标。
 * 3. **写得进池、且不沉底**：标记的键必须是**目录形态**（大写），
 *    且写标记**不得**改变账号顺序（那是 `updateModelRateLimit` 的语义，
 *    不是观测的语义）。
 *
 * ⚠️ **两侧大小写不同**是本缺陷最容易写错的一点（实测）：
 * 上游 `capabilities` 是 `glm-5.3`（小写），池过滤键是目录的 `GLM-5.3`（大写）
 * ⇒ 不归一化就**静默失效**（标记写了，查询永远不命中，零报错）。
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { createExpiryProbe, zcodeExpiry } from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { ZCODE } from '../../src/zcode-product.js'
import { fetchZcodeBalance } from '../../src/zcode-upstream.js'
import {
  bucketCoversModel,
  entitlementForModel,
  exhaustedModelsOf,
  modelOfCapability,
  recoveredModelsOf,
} from '../../src/zcode-entitlements.js'
import type { ZcodeCredential } from '../../src/zcode.js'
import type { ZcodeBalanceBucket } from '../../src/zcode-upstream.js'

const CRED = { zcode_jwt: 'jwt', device_mid: 'mid', app_version: '3.14.4' } as ZcodeCredential

/** 本测试文件所在目录（用于读 `src/` 源码做结构判据）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 剥掉块注释与行注释（避免「注释满足正则」的假绿）。
 *
 * ⚠️ 取自 `provider-runtime-wiring.spec.ts` 的同名助手（那里已验证过该写法）：
 * 源码判据**必须**先剥注释 —— 否则「把代码注释掉」等于「代码还在」，
 * 而注释里恰好写着同样的符号名时（本仓库的注释非常长）假绿概率很高。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 目录 id（**大写**，DSH 用的形态）。 */
const CATALOG = ['GLM-5.3', 'GLM-5.3-Flash'] as const

/** 实测形态的桶构造器。 */
function bucket(input: {
  capabilities?: readonly string[]
  remaining?: number
  total?: number
  expiresAt?: number
  showName?: string
}): ZcodeBalanceBucket {
  return {
    ...input.capabilities === undefined ? {} : { capabilities: input.capabilities },
    ...input.showName === undefined ? {} : { showName: input.showName },
    totalUnits: input.total ?? input.remaining ?? 0,
    remainingUnits: input.remaining ?? 0,
    availableUnits: input.remaining ?? 0,
    ...input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt },
  }
}

/** 8M 形态：GLM-5.3 专属 3M + GLM-5.3-Flash 专属 5M（都满额）。 */
const EIGHT_M_FULL = [
  bucket({ capabilities: ['model:glm-5.3'], remaining: 3_000_000, showName: 'GLM-5.3' }),
  bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 5_000_000, showName: 'GLM-5.3-Flash' }),
]

/** 按 URL 分派 `balance` / `preview`（`fetchZcodeBalance` 总会补一次 preview）。 */
function stubZcode(balanceBody: unknown, previewBody: unknown = { code: 0, data: { plans: [] } }) {
  vi.stubGlobal('fetch', (async (url: string) => new Response(
    JSON.stringify(String(url).includes('/preview') ? previewBody : balanceBody),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch)
}

// ───────────────────────── 1. 读数：上游字段必须被带出来 ─────────────────────────

describe('★ fetchZcodeBalance 必须带出「模型归属」', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('★★ `capabilities` 与 `entitlement_id` 必须逐桶带出（实测形态）', async () => {
    const r = await fetchZcodeBalance(CRED, (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        balances: [
          {
            plan_id: 'zcode-v3-start-plan-0817',
            entitlement_id: 'ent_2_0817_glm_5p3',
            show_name: 'GLM-5.3',
            capabilities: ['model:glm-5.3'],
            unit_type: 'token',
            total_units: 3_000_000,
            remaining_units: 3_000_000,
            available_units: 3_000_000,
          },
          {
            entitlement_id: 'ent_2_0817_glm_5p3f',
            show_name: 'GLM-5.3-Flash',
            capabilities: ['model:glm-5.3-flash'],
            total_units: 5_000_000,
            remaining_units: 5_000_000,
          },
        ],
      },
    }), { status: 200 })) as unknown as typeof fetch)
    expect(r?.buckets[0]?.capabilities).toEqual(['model:glm-5.3'])
    expect(r?.buckets[0]?.entitlementId).toBe('ent_2_0817_glm_5p3')
    expect(r?.buckets[1]?.capabilities).toEqual(['model:glm-5.3-flash'])
  })

  it('★ `capabilities` 缺失 ⇒ 字段**不出现**（`undefined` 而不是 `[]`）', async () => {
    // ⚠️ 两者的语义**不同**：`undefined` = 「上游没说」（通用桶），
    //    `[]` = 「上游说它不覆盖任何模型」。混淆会让通用桶被忽略 ⇒ 误封可用账号。
    const r = await fetchZcodeBalance(CRED, (async () => new Response(JSON.stringify({
      code: 0, data: { balances: [{ remaining_units: 100, available_units: 100 }] },
    }), { status: 200 })) as unknown as typeof fetch)
    expect(r?.buckets[0]?.capabilities).toBeUndefined()
    expect(bucketCoversModel(r!.buckets[0]!, 'GLM-5.3'), '通用桶覆盖一切').toBe(true)
  })

  it('★ `capabilities` 里的非字符串元素被丢弃，全空 ⇒ 视作通用桶', async () => {
    const r = await fetchZcodeBalance(CRED, (async () => new Response(JSON.stringify({
      code: 0,
      data: { balances: [{ remaining_units: 5, available_units: 5, capabilities: [null, 42, ''] }] },
    }), { status: 200 })) as unknown as typeof fetch)
    expect(r?.buckets[0]?.capabilities, '全被过滤 ⇒ undefined').toBeUndefined()
  })
})

// ───────────────────────── 2. 判据：纯函数各格 ─────────────────────────

describe('★ 模型归属解析（`model:` 前缀）', () => {
  it('★ 小写 id 被取出；大小写不敏感', () => {
    expect(modelOfCapability('model:glm-5.3')).toBe('glm-5.3')
    expect(modelOfCapability('MODEL:GLM-5.3')).toBe('glm-5.3')
    expect(modelOfCapability(' model:glm-5.3-flash ')).toBe('glm-5.3-flash')
  })

  it('★★ 非 `model:` 前缀一律 `undefined`（不猜、不宽容）', () => {
    // 将来上游可能加别的维度（tool / feature），把 `tool:web_search` 当成模型名
    // 会产生一个永远匹配不上的桶 ⇒「该桶被忽略」⇒ 若它是通用额度就会误封账号。
    expect(modelOfCapability('tool:web_search')).toBeUndefined()
    expect(modelOfCapability('model:')).toBeUndefined()
    expect(modelOfCapability('')).toBeUndefined()
    expect(modelOfCapability('glm-5.3')).toBeUndefined()
  })
})

describe('★★ 大小写（上游小写 vs 目录大写 —— 本缺陷最容易写错的一点）', () => {
  it('★★ `exhaustedModelsOf` 返回的键必须是**目录形态**（大写）', () => {
    // ⚠️ 这是「标记能被池查询命中」的**唯一保证**：池的过滤是
    //    `a.modelRateLimits[modelId]` 精确匹配，而 modelId 来自 DSH 的**大写**目录 id。
    //    若这里返回小写，标记写了也永远不命中，且**零报错**。
    const buckets = [bucket({ capabilities: ['model:glm-5.3'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual(['GLM-5.3'])
  })

  it('★★ 上游给大写 / 混合大小写时同样命中（比对是大小写不敏感的）', () => {
    const buckets = [bucket({ capabilities: ['MODEL:GLM-5.3'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual(['GLM-5.3'])
  })

  it('★ 目录里没有的模型 ⇒ 不产出（不写无效键）', () => {
    const buckets = [bucket({ capabilities: ['model:glm-5.2'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual([])
  })

  it('★ 产出保 `catalogIds` 的原样元素（不自己改写大小写）', () => {
    // 目录若将来改成别的形态（如 `glm-5.3` 小写），产出必须跟着它，而不是被写死。
    const out = exhaustedModelsOf(
      [bucket({ capabilities: ['model:glm-5.3'], remaining: 0 })],
      ['glm-5.3'],
    )
    expect(out).toEqual(['glm-5.3'])
  })
})

describe('★★ 覆盖判定：专属桶 / 通用桶 / 别的模型', () => {
  it('★ 专属桶只覆盖自己那个模型', () => {
    const b = bucket({ capabilities: ['model:glm-5.3'], remaining: 100 })
    expect(bucketCoversModel(b, 'GLM-5.3')).toBe(true)
    expect(bucketCoversModel(b, 'glm-5.3'), '大小写不敏感').toBe(true)
    expect(bucketCoversModel(b, 'GLM-5.3-Flash')).toBe(false)
  })

  it('★★ 通用桶（无 `capabilities`）覆盖一切 —— 不得判成「不覆盖」', () => {
    const generic = bucket({ remaining: 100_000_000 })
    expect(bucketCoversModel(generic, 'GLM-5.3')).toBe(true)
    expect(bucketCoversModel(generic, 'anything')).toBe(true)
  })

  it('★ 空 modelId ⇒ 覆盖（调用方没给目标时不筛）', () => {
    expect(bucketCoversModel(bucket({ capabilities: ['model:glm-5.3'] }), '')).toBe(true)
  })
})

describe('★★ 单模型权益判定', () => {
  it('★★ 专属桶见底 + 通用桶还有余额 ⇒ **可用**（用户明确要求的兼容格）', () => {
    // 用户原话：「专用的用光了赠送的还在也不切换」—— 即上游仍能承接该模型。
    const facts = entitlementForModel(
      [
        bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
        bucket({ remaining: 100_000_000 }), // 通用赠送
      ],
      'GLM-5.3',
    )
    expect(facts.usable, '通用桶还有余额 ⇒ 不得判死').toBe(true)
    expect(facts.bucketCount).toBe(2)
  })

  it('★★ 专属桶见底 + 无通用桶 ⇒ 不可用', () => {
    const facts = entitlementForModel(
      [
        bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
        bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 5_000_000 }),
      ],
      'GLM-5.3',
    )
    expect(facts.usable).toBe(false)
    expect(facts.bucketCount, '只有 GLM-5.3 的专属桶覆盖它').toBe(1)
  })

  it('★ 同一模型有多个专属桶 ⇒ 任意一个还有余额即可用', () => {
    const facts = entitlementForModel(
      [
        bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
        bucket({ capabilities: ['model:glm-5.3'], remaining: 7 }),
      ],
      'GLM-5.3',
    )
    expect(facts.usable).toBe(true)
    expect(facts.bucketCount).toBe(2)
  })
})

/**
 * ★★★ **保守性**：写出持久标记只能来自正向证据。
 *
 * ## 为什么这些用例必须打在 `exhaustedModelsOf` 上（而不是某个中间函数）
 *
 * 初版给一个**零生产调用方**的「单模型三态判定」导出函数写了一组用例 ——
 * 它们全绿，而生产路径的保守性**完全不受保护**（那个函数根本没人调，
 * 后来已删除）。这正是本仓库记过的「登记了一处例外 ≠ 这处例外有守卫」：
 * **用例全绿只证明那个函数是对的，不证明它被调用。**
 *
 * ⇒ 现在全部打在**真实生产入口** `exhaustedModelsOf` 上，逐格验证
 * 「什么情况下**不会**产出标记」。
 * ⚠️ 本条刻意不写出那个已删函数的名字（写进注释会让「该符号应不存在」这类
 * grep 判据失效 —— `AGENTS.md` 的注释级陷阱）。
 */
describe('★★★ 保守性：`exhaustedModelsOf` 在证据不足时**绝不产出标记**', () => {
  it('★★ 空桶 ⇒ 不标（上游字段漂移时不得一次封掉所有账号）', () => {
    // ⚠️ 危险方向：若把「无桶」判成「所有模型都已尽」，**每个** zcode 账号
    //    都会被标到次日 0 点 ⇒ 整个渠道不可用，且用户无法自愈。
    expect(exhaustedModelsOf([], CATALOG)).toEqual([])
  })

  it('★★ 桶里没有该模型的任何归属 ⇒ 不标（不本地判死）', () => {
    // 实测 `GLM-5.2` / `GLM-5-Turbo` 在本机账号上没有专属桶（它们在 Start Plan
    // 下返回空响应，见 `zcode-product.ts`）⇒ 这种「确实没权益」交给上游拒绝，
    // 而不是我们持久判死。
    const buckets = [bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 100 })]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual([])
  })

  it('★★ 传空目录 ⇒ 不标（判定范围为空时什么都不做）', () => {
    expect(exhaustedModelsOf(EIGHT_M_FULL, [])).toEqual([])
  })

  it('★★ 目录里的空串与**纯空白** id 必须跳过（否则落盘永不命中的噪音键）', () => {
    /**
     * ⚠️ 真实缺口（本机实测 2026-10-12）：`bucketCoversModel` 对空 target 返回
     * `true`（那是「调用方没给目标 ⇒ 不筛」的**合法**语义），于是空白 id 会把
     * **所有**桶都算作覆盖 ⇒ 桶都见底时产出一个空白键。
     *
     * 后果分级（实测）：
     * - **空串**会被池的写入侧拦住（`modelId.length === 0` 守卫）⇒ 无害；
     * - **纯空白**（`'   '`）长度非 0 ⇒ **会真的落盘**一个永不命中的键
     *   （池的查询永远用真实模型 id）。
     *
     * ⇒ 修在 `exhaustedModelsOf`（判空一律 `trim()`），**不**改
     * `bucketCoversModel` 的语义（那会让「不筛」这一格失效）。
     */
    const empty = [bucket({ capabilities: ['model:glm-5.3'], remaining: 0 })]
    expect(exhaustedModelsOf(empty, ['', 'GLM-5.3'])).toEqual(['GLM-5.3'])
    expect(exhaustedModelsOf(empty, ['   ', 'GLM-5.3'])).toEqual(['GLM-5.3'])
    expect(exhaustedModelsOf(empty, ['\t\n', 'GLM-5.3'])).toEqual(['GLM-5.3'])
    // 目录**只有**空白 ⇒ 什么都不标（而不是产出一个垃圾键）。
    expect(exhaustedModelsOf(empty, ['', '   '])).toEqual([])
  })

  it('★ 目录重复项被去重（不重复写同一个键）', () => {
    const buckets = [bucket({ capabilities: ['model:glm-5.3'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, ['GLM-5.3', 'GLM-5.3', 'GLM-5.3'])).toEqual(['GLM-5.3'])
  })

  it('★★ `available_units` 与 `remaining_units` 不一致时以 `available_units` 为准', () => {
    /**
     * ⚠️ 对抗审计点名的覆盖漏洞（`M09`）：测试构造器 `bucket()` 恒把两者设成同值
     * ⇒ 「丢弃 `available_units`」这种变异**不可观测**。
     *
     * 口径依据：`fetchZcodeBalance` 的汇总用的是
     * `bucket.availableUnits ?? bucket.remainingUnits ?? 0`（同源），
     * 本项目对「同一语义两套判据」有红线 ⇒ 判据必须与它逐格一致。
     */
    // available=0 但 remaining 有值 ⇒ 判已尽（与汇总口径一致）。
    expect(exhaustedModelsOf(
      [{ capabilities: ['model:glm-5.3'], availableUnits: 0, remainingUnits: 3_000_000 }],
      ['GLM-5.3'],
    )).toEqual(['GLM-5.3'])
    // available 有值但 remaining=0 ⇒ 判可用（反向对照，防「只看 remaining」）。
    expect(exhaustedModelsOf(
      [{ capabilities: ['model:glm-5.3'], availableUnits: 3_000_000, remainingUnits: 0 }],
      ['GLM-5.3'],
    )).toEqual([])
  })

  it('★★ 已尽的桶带**更早**的 `expires_at` ⇒ 折算不得取它（否则会把已尽的当临期首选）', async () => {
    /**
     * ⚠️ 对抗审计点名的覆盖漏洞（`M17`）：把折算的 `remaining > 0` 守卫删掉，
     * 一个「已尽但临期最早」的桶会让折算返回它的到期时刻 ⇒ 该渠道被当成
     * 「最快作废、优先烧」而排到最前 —— 而它其实已经没额度了。
     */
    stubZcode({
      code: 0,
      data: {
        balances: [
          // 已尽，但到期时间**最早**（若不判 remaining，折算会取它）。
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0, expires_at: 1_700_000_000 },
          // 还有额度，到期时间较晚。
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 5, available_units: 5, expires_at: 1_900_000_000 },
        ],
      },
    })
    const value = await zcodeExpiry(CRED)
    expect(value, '必须取**有余额**那个桶的到期时刻').toBe(1_900_000_000 * 1000)
    expect(value, '绝不能取已尽桶的更早时刻').not.toBe(1_700_000_000 * 1000)
  })

  it('★ 垃圾值在**解析边界**就被过滤掉（契约：`capabilities` 里只有非空字符串）', () => {
    /**
     * ⚠️ 类型契约：`ZcodeBalanceBucket.capabilities` 声明为 `readonly string[]`
     * —— 过滤发生在**解析边界** `fetchZcodeBalance` 的 `capabilitiesOf`（那里才见得到
     * 上游的 `unknown`）。本函数因此**不做**二次防御：在内部再判一次
     * `typeof === 'string'` 属于「同一语义两套判据」，且会让类型契约失去意义。
     *
     * ⇒ 这一格由**上游解析**那一条用例守住（见文件开头「必须带出模型归属」段），
     * 这里只钉住「解析后全是垃圾 ⇒ 退化成通用桶」的**结果**。
     */
    const buckets = [{ remainingUnits: 0, availableUnits: 0 }]
    expect(exhaustedModelsOf(buckets, ['GLM-5.3', 'GLM-5.3-Flash']))
      .toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
  })

  it('★ 无 `capabilities` 的桶（通用桶）+ 仍有余额 ⇒ 覆盖一切 ⇒ 一个都不标', () => {
    const buckets = [{ remainingUnits: 100, availableUnits: 100 }]
    expect(exhaustedModelsOf(buckets, ['GLM-5.3', 'GLM-5.3-Flash'])).toEqual([])
  })

  it('★★ 有覆盖桶且全见底 ⇒ 标（这才是 8M 缺陷那一格）', () => {
    const buckets = [bucket({ capabilities: ['model:glm-5.3'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, ['GLM-5.3'])).toEqual(['GLM-5.3'])
  })

  it('★★★ 额度字段**读不出来**（上游下发字符串）⇒ 一个都不标（防锁死整天）', () => {
    /**
     * ⚠️⚠️ 真实缺陷（对抗审计实测 2026-10-12，我独立复现）：
     * `zcode-upstream.ts` 的 `num()` **只认 `number`**（它自己的注释登记过
     * 「额度数值若以字符串下发会静默退化」）⇒ 上游给 `"3000000"` 时两个额度
     * 字段都是 `undefined`。
     *
     * 若判据按「`undefined` ⇒ 0 ⇒ 已尽」处理 ⇒ **所有**模型都被写持久标记
     * ⇒ **账号锁死到次日**（旧行为只让折算短暂 `UNUSABLE`，本轮把它放大了）。
     * 实测：`scripts/verify-zcode-string-units.mjs`。
     *
     * ⇒ 「读不到」必须与「读到了 0」严格区分，两个方向（写/清）都不动。
     */
    const unreadable = [
      { capabilities: ['model:glm-5.3'] },
      { capabilities: ['model:glm-5.3-flash'] },
    ]
    expect(exhaustedModelsOf(unreadable, CATALOG), '读不到 ⇒ 不得判已尽').toEqual([])
    expect(recoveredModelsOf(unreadable, CATALOG), '读不到 ⇒ 也不得判可用').toEqual([])
  })

  it('★★ 部分桶读不到 + 部分明确为 0 ⇒ 仍不标（证据不足）', () => {
    // ⚠️ 只要**有任何一个**覆盖该模型的桶读不到，就不足以判「已尽」——
    //    那个读不到的桶可能正是还有额度的那个。
    const mixed = [
      { capabilities: ['model:glm-5.3'], remainingUnits: 0, availableUnits: 0 },
      { capabilities: ['model:glm-5.3'] }, // 读不到
    ]
    expect(exhaustedModelsOf(mixed, ['GLM-5.3'])).toEqual([])
  })

  it('★ 额度明确为 0 且**没有**读不到的桶 ⇒ 照常标（防上一条过宽）', () => {
    // 反向对照：上一条不能把「正常已尽」也一起放过。
    const clear = [{ capabilities: ['model:glm-5.3'], remainingUnits: 0, availableUnits: 0 }]
    expect(exhaustedModelsOf(clear, ['GLM-5.3'])).toEqual(['GLM-5.3'])
  })
})

// ───────────────────────── 3. 要写哪些标记 ─────────────────────────

describe('★★★ `exhaustedModelsOf`：8M 两专属桶 与 通用赠送桶', () => {
  it('★★ 8M 都满额 ⇒ 一个都不标', () => {
    expect(exhaustedModelsOf(EIGHT_M_FULL, CATALOG)).toEqual([])
  })

  it('★★★ 8M 的 GLM-5.3 烧光、Flash 还有 ⇒ **只标 GLM-5.3**（本缺陷主格）', () => {
    const buckets = [
      bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 5_000_000 }),
    ]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual(['GLM-5.3'])
  })

  it('★★ 两个专属桶都烧光 ⇒ 两个都标', () => {
    const buckets = [
      bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 0 }),
    ]
    expect(exhaustedModelsOf(buckets, CATALOG).sort()).toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
  })

  it('★★★ 专属桶烧光 + 通用赠送桶还有 1 亿 ⇒ **不标**（用户要求的兼容格）', () => {
    // 用户原话：「同时要兼容之前除了 8M 的 2 种模型的专用 tokens 外还有赠送的
    // 1 亿 token 专用的用光了赠送的还在也不切换」
    const buckets = [
      bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 0 }),
      bucket({ remaining: 100_000_000 }), // 通用赠送额度
    ]
    expect(exhaustedModelsOf(buckets, CATALOG), '通用桶覆盖两者 ⇒ 一个都不该标').toEqual([])
  })

  it('★★★ 通用桶烧光 + 专属桶还有 ⇒ **不标**（只剩专属额度的账号仍可用）', () => {
    const buckets = [
      bucket({ remaining: 0 }), // 通用赠送烧光
      bucket({ capabilities: ['model:glm-5.3'], remaining: 3_000_000 }),
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 5_000_000 }),
    ]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual([])
  })

  it('★★ 通用桶烧光 + 专属桶也烧光 ⇒ 两个都标', () => {
    const buckets = [
      bucket({ remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 0 }),
    ]
    expect(exhaustedModelsOf(buckets, CATALOG).sort()).toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
  })

  it('★ 空桶 / 不传目录 ⇒ 一个都不标（保守）', () => {
    expect(exhaustedModelsOf([], CATALOG)).toEqual([])
    expect(exhaustedModelsOf(EIGHT_M_FULL, [])).toEqual([])
  })

  it('★ 目录外的模型被跳过（不写无效键）', () => {
    const buckets = [bucket({ capabilities: ['model:glm-5.2'], remaining: 0 })]
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual([])
  })

  it('★ 结果保目录顺序且去重', () => {
    const buckets = [
      bucket({ capabilities: ['model:glm-5.3-flash'], remaining: 0 }),
      bucket({ capabilities: ['model:glm-5.3'], remaining: 0 }),
    ]
    // ⚠️ 顺序取 `catalogIds`（GLM-5.3 在前），不是桶的顺序。
    expect(exhaustedModelsOf(buckets, CATALOG)).toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
  })
})

// ───────────────────────── 4. 端到端：折算层真的写进池 ─────────────────────────

/** 内存凭据（与 `zcode-dedup.spec.ts` 同型）。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async set(ref: string, value: string): Promise<void> { this.store.set(ref, value) }
  async unset(ref: string): Promise<void> { this.store.delete(ref) }
}

function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  return ctx
}

/** 建两个账号（A 在前、B 在后），返回池。 */
async function seedTwoAccounts(ctx: Context): Promise<AccountPool> {
  const pool = new AccountPool(ctx)
  for (const id of ['zcode-A', 'zcode-B']) {
    await pool.addAccount({
      id,
      provider: ZCODE.id,
      nickname: id,
      enabled: true,
      credentialRef: `ZCODE_ACCOUNT_${id.slice(-1)}`,
      refreshable: false,
      createdAt: 1,
    } as never)
    const creds = ctx.get('credentials') as unknown as FakeCredentials
    await creds.set(`ZCODE_ACCOUNT_${id.slice(-1)}`, JSON.stringify({
      zcode_jwt: `jwt-${id}`, device_mid: `mid-${id}`, app_version: '3.14.4',
    }))
  }
  return pool
}

let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env['DSH_JET_HUB_STATE_DIR']
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-zcode-entitle-'))
  process.env['DSH_JET_HUB_STATE_DIR'] = isolatedHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSH_JET_HUB_STATE_DIR']
  else process.env['DSH_JET_HUB_STATE_DIR'] = previousHome
  if (isolatedHome !== undefined) {
    try { rmSync(isolatedHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

beforeEach(() => {
  clearProviderRuntimes()
  for (const [id, expiry] of Object.entries(createProviderExpiry())) {
    registerProviderRuntime({ descriptor: descriptorOf(id)!, expiry })
  }
})
afterEach(() => { vi.unstubAllGlobals(); clearProviderRuntimes() })

describe('★★★ 端到端：折算层把「该模型已尽」写进池，且**不沉底**', () => {
  it('★★★ GLM-5.3 烧光、Flash 还有 ⇒ 池里只标 GLM-5.3（余下模型仍可用）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 },
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 5_000_000, available_units: 5_000_000 },
        ],
      },
    })

    const probe = createExpiryProbe(pool, async () => 'GLM-5.3', {
      catalogIdsOf: async () => [...CATALOG],
    })
    // 折算本身仍说「这个渠道有额度」（Flash 的 5M）—— 这是既有语义，不变。
    expect(await probe(ZCODE.id), 'Flash 还有额度 ⇒ 渠道可用').not.toBe(UNUSABLE)

    /**
     * ★ 关键断言：标记写到了**正确的键**上。
     *
     * ⚠️ 若不做大小写归一化，这里会是 `undefined`（键写成小写 `glm-5.3`，
     * 而查询用大写的目录 id）—— 且**没有任何报错**。
     */
    const availableFor53 = await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3')
    expect(availableFor53, 'GLM-5.3 已尽 ⇒ 该模型上无可用账号').toBeNull()
    // ⚠️ 反向对照：Flash 未被标记 ⇒ 它在 Flash 上仍可用（不得误伤）。
    const availableForFlash = await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3-Flash')
    expect(availableForFlash?.entry.id, 'Flash 未被标记 ⇒ 照常可用').toBe('zcode-A')
  })

  it('★★★ 专属桶烧光 + 通用赠送桶还有 ⇒ **不写任何标记**（用户要求的兼容格）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 },
          { remaining_units: 100_000_000, available_units: 100_000_000 }, // 通用赠送
        ],
      },
    })
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3', {
      catalogIdsOf: async () => [...CATALOG],
    })
    await probe(ZCODE.id)

    // ⚠️ 通用桶覆盖 GLM-5.3 ⇒ 上游仍能承接 ⇒ **绝不能**标记（否则误封可用账号到次日）。
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3'), '通用额度还在 ⇒ 必须仍可用')
      .not.toBeNull()
  })

  it('★★★ 写标记**不得改变账号顺序**（观测不是「撞限额」，不该沉底）', async () => {
    /**
     * ⚠️⚠️ 这条**必须直接测池的方法**，不能靠「探针跑一轮再看顺序」。
     *
     * 初版正是那么写的，而它**没有区分能力**（反向验证实测）：桩 fetch 对
     * 两个账号返回同一份余额 ⇒ **两个账号都会被标记** ⇒ 若实现会沉底，
     * 恰好沉底两次、顺序回到原样 ⇒ 用例照样绿。这是典型的假绿。
     *
     * ⇒ 直接构造「**只有第一个账号**被标记」的形态：若实现会沉底，
     * 它会被挪到末尾，顺序必然变化。
     */
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    const before = (await pool.listAllAccounts())
      .filter(a => a.provider === ZCODE.id).map(a => a.id)
    expect(before, '前置：A 必须排在 B 前面').toEqual(['zcode-A', 'zcode-B'])

    // 只标记排在第一位的 A。
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])

    const after = (await pool.listAllAccounts())
      .filter(a => a.provider === ZCODE.id).map(a => a.id)
    expect(after, '⚠️ 观测动作不得沉底 —— 否则用户每次 auto 选型都看到账号顺序变化')
      .toEqual(before)
    // 标记本身必须真的写下了（否则「顺序没变」是因为什么都没做）。
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    expect(entry?.modelRateLimits?.['GLM-5.3'], '标记必须真的写入').toBeGreaterThan(Date.now())
  })

  it('★★★ 对照：`updateModelRateLimit`（撞限额语义）**会**沉底 —— 证明上面那条有区分力', async () => {
    // ⚠️ 这条是**反向对照**：它证明「顺序不变」不是因为池根本不会重排。
    //    没有它，上面那条在「沉底功能被整体删掉」时也会绿。
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    await pool.updateModelRateLimit('zcode-A', 'GLM-5.3', Date.now() + 3_600_000)
    const after = (await pool.listAllAccounts())
      .filter(a => a.provider === ZCODE.id).map(a => a.id)
    expect(after, '撞限额 ⇒ 沉底（A 被挪到 B 之后）').toEqual(['zcode-B', 'zcode-A'])
  })

  it('★ 标记时长 = UTC+8 次日 0 点（与 zcode 免费额度的自然日结算一致）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    const reset = entry?.modelRateLimits?.['GLM-5.3']
    expect(reset, '必须写入').toBeDefined()
    // 北京时间 = UTC+8；次日 0 点必须是 UTC+8 的整日边界。
    const beijing = new Date(reset! + 8 * 3600 * 1000)
    expect(beijing.getUTCHours(), 'UTC+8 的 0 点').toBe(0)
    expect(beijing.getUTCMinutes()).toBe(0)
    expect(beijing.getUTCSeconds()).toBe(0)
  })

  it('★ 空模型列表 ⇒ 不落盘（最常见的一格，别白写）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    await pool.markModelsExhaustedForExpiry('zcode-A', [])
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    expect(entry?.modelRateLimits ?? {}).toEqual({})
  })

  it('★ 已有更晚的标记 ⇒ 不覆盖（不把既有标记提前）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    const later = Date.now() + 30 * 24 * 3600 * 1000
    await pool.updateModelRateLimit('zcode-A', 'GLM-5.3', later)
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    expect(entry?.modelRateLimits?.['GLM-5.3'], '更晚的既有标记必须保留').toBe(later)
  })

  it('★★★ 分两批标不同模型 ⇒ 先标的**不得被抹掉**（保留其它模型的既有标记）', async () => {
    /**
     * ⚠️ 对抗审计点名的覆盖漏洞（`N04`）：若写标记时丢掉 `...current`
     * （只写本次那一条），那么「先标 Flash、再标 GLM-5.3」会把 Flash 的标记
     * **整个抹掉** ⇒ Flash 上已尽的账号又被放回候选。
     *
     * 这正是本仓库「构造全新对象抹掉字段」的同型坑（zcode 凭据覆盖事故的同一形态）。
     */
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3-Flash'])
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    expect(Object.keys(entry?.modelRateLimits ?? {}).sort(), '两条标记都必须还在')
      .toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
  })

  it('★★ 空 `accountId` ⇒ 不写任何标记（守卫不得放宽）', async () => {
    /**
     * ⚠️ 对抗审计点名的覆盖漏洞（`M31`）：把 `accountId.length > 0` 守卫
     * 翻成 `>= 0`（恒真）后所有用例仍绿。空 accountId 意味着「不知道是哪个账号」
     * ⇒ 写标记必然写错对象（本仓库对「不猜」有明确口径）。
     */
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [{ capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 }],
      },
    })
    const marks: unknown[] = []
    await zcodeExpiry(CRED, {
      accountId: '',
      catalogIds: async () => ['GLM-5.3'],
      markModelsExhausted: async (...args) => { marks.push(args) },
    })
    expect(marks, '空 accountId ⇒ 不得写标记').toEqual([])
  })

  it('★★ 查不到余额（HTTP 500）⇒ 不写任何标记（未知 ≠ 已尽）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3', {
      catalogIdsOf: async () => [...CATALOG],
    })
    expect(await probe(ZCODE.id)).toBe(UNUSABLE)
    // ⚠️ 上游失败 ⇒ 绝不能据此写持久标记（会封掉可用账号到次日）。
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3'), '查不到 ⇒ 不得封号').not.toBeNull()
  })

  it('★★ 未注入 `catalogIdsOf`（既有装配/测试桩）⇒ 退回 probeModel 一个，行为不炸', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [{ capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 }],
      },
    })
    // ⚠️ 不传 catalogIdsOf：判定范围退化为 `['GLM-5.3']`（probeModel）。
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3')
    await probe(ZCODE.id)
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3')).toBeNull()
  })
})

describe('★★ `zcodeExpiry` 的折算值不得被写标记影响', () => {
  it('★ 有余额 ⇒ 折算值仍是「最早到期」（与写标记前逐字一致）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0, expires_at: exp },
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 5, available_units: 5, expires_at: exp },
        ],
      },
    })
    const marks: Array<{ id: string; models: readonly string[] }> = []
    const value = await zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => [...CATALOG],
      markModelsExhausted: async (id, models) => { marks.push({ id, models }) },
    })
    expect(value).toBe(exp * 1000)
    expect(marks, 'FLASH 还有余额 ⇒ 折算取它的到期时刻').toEqual([
      { id: 'acct-1', models: ['GLM-5.3'] },
    ])
  })

  it('★★ `markModelsExhausted` 抛错 ⇒ 折算值**照常返回**（观测失败不影响选型）', async () => {    const exp = Math.floor(Date.now() / 1000) + 3600
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 },
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 5, available_units: 5, expires_at: exp },
        ],
      },
    })
    const value = await zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => [...CATALOG],
      markModelsExhausted: async () => { throw new Error('磁盘写失败') },
    })
    expect(value, '标记写失败不得让折算失败').toBe(exp * 1000)
  })

  it('★ 企业版 ⇒ `NEVER` 且**不写任何标记**（额度都不知道，无从判模型）', async () => {
    stubZcode({ code: 0, data: { displayMode: 'enterprise' } })
    const marks: unknown[] = []
    const value = await zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => [...CATALOG],
      markModelsExhausted: async (...args) => { marks.push(args) },
    })
    expect(value).toBe(NEVER)
    expect(marks).toEqual([])
  })

  it('★ 缺 accountId（回退路径）⇒ 折算照常，只是不写标记', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    stubZcode({
      code: 0,
      data: {
        balances: [
          // GLM-5.3 已尽（本该被标记），但缺 accountId ⇒ 写不了。
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 },
          // Flash 还有余额 ⇒ 折算取它的到期时刻。
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 5, available_units: 5, expires_at: exp },
        ],
      },
    })
    const marks: unknown[] = []
    const value = await zcodeExpiry(CRED, {
      catalogIds: async () => [...CATALOG],
      markModelsExhausted: async (...args) => { marks.push(args) },
    })
    expect(value).toBe(exp * 1000)
    expect(marks).toEqual([])
  })

  it('★★★ `catalogIds()` 抛 `AbortError` ⇒ 必须原样逃逸（不得被吞成折算值）', async () => {
    /**
     * ⚠️⚠️ 真实缺陷（对抗审计实测证伪，2026-10-12）：写标记那段的 `try/catch`
     * 初版是**裸的** ⇒ 用户取消请求时，`AbortError` 被静默吞掉、折算照常返回一个值。
     * 而本仓库的硬约束是「**abort 立刻抛 `AbortError`，绝不折算**」
     * —— 这条在 `aggregate-expiry.ts` 被踩过三次（各 catch 都要判）。
     *
     * 症状：用户点「停止」后，本该立刻中止的请求会**继续**走完选型，
     * 并可能把请求发给上游（而不是让 harness 归为 aborted）。
     */
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    stubZcode({
      code: 0,
      data: {
        balances: [{ capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 }],
      },
    })
    await expect(zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => { throw abortError },
      markModelsExhausted: async () => {},
    }), 'AbortError 必须逃逸，不得折算成返回值').rejects.toThrow(/abort/i)
  })

  it('★★★ `markModelsExhausted` 抛 `AbortError` ⇒ 同样必须逃逸', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    stubZcode({
      code: 0,
      data: {
        balances: [{ capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 }],
      },
    })
    await expect(zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => ['GLM-5.3'],
      markModelsExhausted: async () => { throw abortError },
    })).rejects.toThrow(/abort/i)
  })

  it('★ 对照：**非中止**的异常仍被吞（不得把上一条放宽成「什么都抛」）', async () => {
    // ⚠️ 反向对照：上两条只针对 AbortError；普通 IO 失败**必须**继续静默
    //    （否则一次磁盘抖动会让整轮选型失败 —— 那是本改动要避免的）。
    const exp = Math.floor(Date.now() / 1000) + 3600
    stubZcode({
      code: 0,
      data: {
        balances: [{ capabilities: ['model:glm-5.3'], remaining_units: 5, available_units: 5, expires_at: exp }],
      },
    })
    const value = await zcodeExpiry(CRED, {
      accountId: 'acct-1',
      catalogIds: async () => ['GLM-5.3'],
      markModelsExhausted: async () => { throw new Error('磁盘写失败') },
    })
    expect(value, '普通异常必须被吞').toBe(exp * 1000)
  })
})

/**
 * ★★★ **两种标记语义不得互相打架**（真实缺陷，两个独立审计共同命中 2026-10-12）。
 *
 * `modelRateLimits` 是**一张共用表**，而两个来源写的键与值**完全相同**
 *（`accountId` + `modelId` + UTC+8 次日 0 点）：
 *
 * | 来源 | 语义 | 证据强度 |
 * |---|---|---|
 * | `updateModelRateLimit`（适配器） | **撞墙**：上游真的拒绝了 | **强**（一次真实失败的请求） |
 * | `markModelsExhaustedForExpiry`（折算观测） | 余额接口说该模型没额度了 | 弱（可能滞后/口径不同） |
 *
 * 而折算**每轮选型都跑** ⇒ 若清除路径无条件删键，就会擦掉适配器刚写的标记：
 *
 * ```
 * round0: pick=A 适配器写标记=true 折算后仍在=false   ← 被擦了
 * round1: pick=A ...                                  ← 死循环，每次真烧一发请求
 * ```
 *
 * 实测（**关掉折算缓存**后 `3/3` 轮全中）：`scripts/verify-zcode-fight-single.mjs`。
 * ⚠️ 关缓存是关键：不关时第二轮命中 60 秒缓存、根本没重跑，会把**死循环**
 * 误测成「只多撞一次」。
 */
describe('★★★ 两种标记语义：观测路径不得擦掉适配器的「撞墙」标记', () => {
  it('★★★ 适配器写过标记后，折算的清除路径**不得**删掉它（否则死循环）', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    // 上游余额接口报「还有额度」——但适配器刚刚撞墙（口径不同/计数滞后）。
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 3_000_000, available_units: 3_000_000 },
        ],
      },
    })
    // ① 适配器撞墙（真实路径：`zcode-adapter.ts` 的 `switchAccountOnQuota`）。
    await pool.updateModelRateLimit('zcode-A', 'GLM-5.3', Date.now() + 3_600_000)
    // ② 折算（模拟下一次 auto/aggregate 选型）。
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3', {
      catalogIdsOf: async () => ['GLM-5.3'],
    })
    await probe(ZCODE.id)
    // ③ 标记必须**还在** —— 擦了就会反复选中同一个已撞墙的号。
    const entry = (await pool.listAllAccounts()).find(a => a.id === 'zcode-A')
    expect(entry?.modelRateLimits?.['GLM-5.3'], '⚠️ 适配器的事后证据不得被观测路径擦掉')
      .toBeDefined()
    // ④ 且该号确实被挡住了（这才是标记的意义）。
    const stillPickable = await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3')
    expect(stillPickable?.entry.id, 'zcode-A 已撞墙 ⇒ 不得再被选中').not.toBe('zcode-A')
  })

  it('★★ 反向对照：**本机制**写的标记仍必须能被清掉（自愈不能因此失效）', async () => {
    // ⚠️ 没有这条，「不许擦」会被实现成「一律不清」⇒ 同日额度恢复的单向门复发。
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 3_000_000, available_units: 3_000_000 },
        ],
      },
    })
    // 只由**本机制**写下（不经过适配器）⇒ 应可被清除。
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    expect((await pool.listAllAccounts()).find(a => a.id === 'zcode-A')?.modelRateLimits?.['GLM-5.3'])
      .toBeDefined()
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3', {
      catalogIdsOf: async () => ['GLM-5.3'],
    })
    await probe(ZCODE.id)
    expect((await pool.listAllAccounts()).find(a => a.id === 'zcode-A')?.modelRateLimits?.['GLM-5.3'],
      '本机制写的标记必须能被清除（否则单向门复发）').toBeUndefined()
  })

  it('★ 清除路径只删登记过的键：`clearModelsExhaustedForExpiry` 对适配器标记无效', async () => {
    // 直接测池方法（不经折算），把「来源判据」这一层单独钉住。
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    await pool.updateModelRateLimit('zcode-A', 'GLM-5.3', Date.now() + 3_600_000)
    await pool.clearModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    expect((await pool.listAllAccounts()).find(a => a.id === 'zcode-A')?.modelRateLimits?.['GLM-5.3'],
      '适配器写的标记不得被本方法的清除路径删除').toBeDefined()
  })
})

/**
 * ★★★ **接线守卫**：判定范围必须来自**真实装配**，不能只手写桩。
 *
 * ## 为什么必须单独一组（对抗审计实测证伪，2026-10-12）
 *
 * 本文件上面所有用例都传**手写的** `catalogIdsOf: async () => [...CATALOG]`
 * —— 它们证明「判据拿到一份目录时算得对」，**完全不证明生产装配真的给了那份目录**。
 *
 * 实测：把 `src/index.ts` 里 `catalogIdsOf` 那段接线改名（= 整段失效），
 * 本文件 + `zcode-wiring.spec.ts` **85 条全绿**；生产行为却退化成
 * 「判定范围只有 `probeModel` 一个模型」⇒ 需求 (C)「两个专属桶都烧光 ⇒ 两个都标」
 * 只标得动一个，另一个模型仍会被派发到已尽的账号。
 *
 * ⇒ 判据对、**规模错** —— 这是「函数级用例挡不住接线缺失」的又一实例
 *（本仓库的对策一贯是：**从真源码取值**，不手写桩）。
 *
 * ## 本组怎么做
 *
 * 从 `src/index.ts` 的**源码文本**里取出那段装配真的调了什么，
 * 而不是复刻一份 —— 复刻会变成「测我的副本」（同义反复）。
 * 判据锚定**片段**（`provider !== ZCODE.id` 门控 + `models.map(...model.id)`），
 * 不用整串匹配（那会让无关重构假失败，本仓库有该教训）。
 */
describe('★★★ 接线守卫：`src/index.ts` 必须为 zcode 提供**整份**目录', () => {
  it('★★★ `catalogIdsOf` 接线存在，且只对 zcode 生效、映射全部模型 id', () => {
    /**
     * ⚠️⚠️ **必须先剥注释再匹配**（真实缺陷，审计实测证伪 2026-10-12）：
     * 初版直接在整份源码文本上跑三条正则，而正则**不区分注释** ⇒
     * 把整段接线改成注释（语义完全失效）后三条**仍全部命中**、守卫静默放行。
     * 本仓库自己记过这条（「不要在注释里写出会被验收 grep 的字符串」），
     * 这里从**反向**踩了同一个坑。
     */
    const source = stripComments(readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8'))
    /**
     * ⚠️ **必须用「键形态」匹配，不能用 `toContain(name)`**：初版写
     * `toContain('catalogIdsOf')`，而把它改名成 `catalogIdsOf_DISABLED`
     *（= 接线失效）**仍然命中**（子串）⇒ 判据过宽、变异照样全绿（实测确认）。
     * `\b` 也拦不住 `_`（它是词字符）⇒ 显式锚定**后面的冒号**（对象字面量的键形态）。
     */
    expect(source, '`catalogIdsOf:` 必须作为装配的键出现（删掉它判定范围会退化）')
      .toMatch(/[\s{,]\s*catalogIdsOf\s*:/)
    // ② 只对 zcode 求值（其余 6 家零额外目录读取）。
    expect(source, '必须有 `provider !== ZCODE.id` 门控').toMatch(/provider\s*!==\s*ZCODE\.id/)
    // ③ 必须映射**全部**模型 id（漏了 map 就只返回一个，等于范围退化）。
    // ⚠️ 锚定片段而非整串：允许格式化/变量改名的重构。
    const block = source.slice(source.search(/[\s{,]\s*catalogIdsOf\s*:/))
    expect(block, '必须把目录**全部** id 映射出来（不能只取 [0]）')
      .toMatch(/models\.map\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.id\s*\)/)
  })

  it('★★ 该接线**真的被调用**：用真实探针跑一遍，范围必须覆盖整份目录', async () => {
    /**
     * 行为侧对照：造一个**两模型目录**，看写标记的范围是否覆盖第二个模型。
     *
     * ⚠️⚠️ **本条与上一条不是「互补」，两条都只测桩**（审计实测证伪 2026-10-12）：
     * 本用例传的是**手写桩** `catalogIdsOf: async () => [...]`，**不驱动
     * `index.ts` 的真接线** ⇒ 它证明的是「判据拿到一份目录时按范围枚举」，
     * 而**不**证明「生产装配真的给了那份目录」。
     *
     * ⇒ 「整段接线失效」这件事由**上一条**（剥注释后的源码判据）守住；
     * 两条的**分工**是「结构 vs 范围」，不是「互补覆盖接线」——
     * 这个区别是审计纠正的，别再把它们描述成互补。
     */
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    stubZcode({
      code: 0,
      data: {
        balances: [
          { capabilities: ['model:glm-5.3'], remaining_units: 0, available_units: 0 },
          { capabilities: ['model:glm-5.3-flash'], remaining_units: 0, available_units: 0 },
        ],
      },
    })
    // 目录给**两个**模型（模拟真实装配的 models.map）。
    const probe = createExpiryProbe(pool, async () => 'GLM-5.3-Flash', {
      catalogIdsOf: async () => ['GLM-5.3-Flash', 'GLM-5.3'],
    })
    await probe(ZCODE.id)
    // ⚠️ 两个模型都必须被标记 —— 只标第一个说明范围退化。
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3'), '第二个模型也必须被标')
      .toBeNull()
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3-Flash')).toBeNull()
  })
})

/**
 * ★★ **已登记的边界**（对抗审计实测 2026-10-12）：标记只在**池查询**那一层生效。
 *
 * ⚠️ 本组**不是**「修复的验证」，而是把一条**已知旁路**固化成可执行的见证 ——
 * 免得将来有人照着乐观描述去推断「直选一律认标记」。
 *
 * 事实：`createCredentialResolver` 在池返回 `null` 时会落 `fallback`，
 * 而 zcode 的 fallback 是 `zcode.current()`（`src/index.ts`），
 * 它**既不看 `enabled`、也不看 `modelRateLimits`** ⇒ 单账号 / 全池标尽时
 * **仍返回凭据**，请求照常发往已尽的模型。
 *
 * ⚠️ 这是**刻意的既有设计**（`src/index.ts` 在 2026-10-06 实测后决定保持原样：
 * 「zcode 没有 IKJOZ9 的症状，不该被『顺手修』；加判定反而会把本来能跑通的
 * 一发变成硬失败」）。⇒ 本组**不**断言它「应该」认标记，只钉住**当前事实**，
 * 使「有人改了 fallback」这件事**立刻可见**（而不是静默改变行为）。
 */
describe('★★ 已登记边界：`fallback` 绕过 `modelRateLimits`（刻意保留，非缺陷）', () => {
  it('★★ 池里该模型已尽 ⇒ 池查询返 `null`，但 fallback 仍能取到凭据', async () => {
    const ctx = makeCtx()
    const pool = await seedTwoAccounts(ctx)
    // 两个账号都标尽 ⇒ 池查询必然返 null ⇒ 走 fallback。
    await pool.markModelsExhaustedForExpiry('zcode-A', ['GLM-5.3'])
    await pool.markModelsExhaustedForExpiry('zcode-B', ['GLM-5.3'])
    expect(await pool.getAvailableAccount(ZCODE.id, 'GLM-5.3'), '池查询已拒绝').toBeNull()

    // 复刻 src/index.ts 的 fallback（`zcode.current()` → 按数组序取第一个能解析的）。
    const resolve = createCredentialResolver<ZcodeCredential>(
      { pool, reportAccount: () => {} },
      {
        product: ZCODE,
        readCredential: async () => undefined,
        fallback: {
          kind: 'custom',
          resolve: async () => {
            for (const entry of await pool.listAllAccounts()) {
              if (entry.provider !== ZCODE.id) continue
              const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
              if (resolved !== undefined) return JSON.parse(resolved.value) as ZcodeCredential
            }
            return undefined
          },
        },
      },
    )
    const got = await resolve('GLM-5.3')
    /**
     * ⚠️ 断言的是**当前事实**（取得到）—— 若将来有人让 fallback 也认标记，
     * 这条会变红，那正是**需要回来复核本段注释与文档 §七**的信号
     *（不是「用例写错了」）。反之若有人把它改成恒 `undefined`，
     * 则「池被筛空时仍要能跑通」那条既有取舍会被打破，也该回来复核。
     */
    expect(got, '⚠️ fallback 刻意不看 modelRateLimits（见本段注释）').toBeDefined()
  })
})
