/**
 * CodeBuddy / WorkBuddy 的「锁定永久积分」**接线**回归（`src/index.ts`）。
 *
 * ## 为什么单独守这个
 *
 * 判据与选号都是纯函数（已由 `buddy-balance-rank.spec.ts` /
 * `buddy-balance-selector.spec.ts` 锁死）。但历史上反复出问题的从来不是
 * 算法，而是**没接上**：
 *
 * - WorkBuddy 的「刷新」按钮一直坏着，因为新增分支时漏接了一处 case；
 * - Qoder 的 `modelId` 曾传空串，于是模型级限流过滤整体短路；
 * - Loomy 的锁定制过「绕过」的坑：锁定后绝不可落到单凭据兜底。
 *
 * 所以这里逐条钉住接线本身。UI 无法在单测里渲染（react 不在本仓库依赖内），
 * 故与 `loomy-wiring.spec.ts` 同款：**源码级断言 + 可执行部分用行为级验证**。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import { BUDDY_EXPIRING_WINDOW_DAYS } from '../../src/buddy-balance-rank.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance } from '../../src/credits.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言**不能**因为「注释里提到了某个符号」就通过或失败：
 * 本仓库的注释大量解释「为什么绝不能走某条兜底路径」，于是对兜底的
 * **否定**断言必须只看代码（与 `refresh-bootstrap-wiring.spec.ts` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)

/** 取编排函数的**函数体**（以下一个 provider 注册语句为界，避免窗口溢出到调用方）。 */
function pickHelperBody(): string {
  const start = indexCode.indexOf('const pickBuddyCredential =')
  expect(start, 'index.ts 里找不到 pickBuddyCredential').toBeGreaterThan(-1)
  const end = indexCode.indexOf('const buddy = new BuddyAuth(ctx)', start)
  expect(end, 'index.ts 里找不到 BuddyAuth 注册（分界标记变了要同步改本用例）').toBeGreaterThan(start)
  return indexCode.slice(start, end)
}

/**
 * 取某个 provider 的 `pickBuddyCredential({ … })` **调用块**原文。
 *
 * 起点是紧邻 `product: <PROVIDER>` 之前的那次调用，终点是其闭合的 `})`。
 * 之所以要定位到「调用块」而不是整文件：接线类断言若只做全文件子串匹配，
 * 同一标识符在别处（选择器定义、文档注释）出现一次就会让断言恒真 ——
 * 已实测过这种同义反复（见下方 ★ 用例的注释）。
 *
 * @param productVar - `indexCode` 里 `product:` 后面那个变量名（TRAE / LOBSTERAI）。
 */
function pickCallBlock(productVar: string): string {
  const anchor = `const picked = await pickBuddyCredential({\n        product: ${productVar},`
  const start = indexCode.indexOf(anchor)
  expect(start, `index.ts 里找不到 ${productVar} 的 pickBuddyCredential 调用`).toBeGreaterThan(-1)
  const end = indexCode.indexOf('\n      })', start)
  expect(end, `${productVar} 的调用块没有闭合（接线形状变了要同步改本用例）`).toBeGreaterThan(start)
  return indexCode.slice(start, end)
}

describe('index.ts 的接线', () => {
  it('导入选号器与编排函数（漏 import 就等于没接）', () => {
    expect(indexCode).toContain("from './buddy-balance-selector.js'")
    expect(indexCode).toContain('BuddyBalanceSelector')
    expect(indexCode).toContain('pickBuddyAccount')
    // 报错文案里的窗口天数必须**运行时解析**（可用环境变量覆盖），
    // 不能在文案里写死字面量 —— 否则用户改了窗口，报错还在说 15 天。
    expect(indexCode).toContain("from './buddy-balance-rank.js'")
    expect(indexCode).toContain('buddyExpiringWindowDays()')
  })

  /**
   * ⚠️ 每个 provider 必须各有**自己的** selector 实例。
   * 共用一份缓存会让 CodeBuddy 的余额结果被 WorkBuddy 读到（键是账号 id，
   * 两站账号 id 不同，看似不会撞 —— 但凭据解析与 endpoint 都跟着 product 走，
   * 共用实例等于把「两站同构」这一前提写死进运行时）。
   *
   * ⚠️ 2026-10-06 起 TRAE / LobsterAI 也接了同一套编排，故实例数由 2 变 4。
   * 本用例改为「**每个支持锁定的 provider 各一个**」—— 数量随白名单走，
   * 而不是写死 2（写死会让下次加 provider 时这条无关断言先红）。
   */
  it('每个支持锁定的 provider 各建一个选号器', () => {
    expect(indexCode).toMatch(/const buddyBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: CODEBUDDY,/)
    expect(indexCode).toMatch(/const workbuddyBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: WORKBUDDY,/)
    expect(indexCode).toMatch(/const traeBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: TRAE,/)
    expect(indexCode).toMatch(/const lobsteraiBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: LOBSTERAI,/)
    expect(indexCode.match(/new BuddyBalanceSelector\(/g)).toHaveLength(4)
  })

  it('凭据解析函数两站共用一份（同协议，差别只在 endpoint）', () => {
    expect(indexCode).toContain('const resolveBuddyCredentialByRef =')
    // ⚠️ **不能用「标识符出现次数」来断言**（PR !68 初版就是这么写的，已实测是
    // 同义反复）：把两个 selector 里的 `resolveCredential: resolveBuddyCredentialByRef`
    // 改成 `(r) => resolveBuddyCredentialByRef(r)` 后，标识符**仍然是 4 次**，
    // 计数断言照样绿 —— 而「两个 selector 确实用了 buddy 那份解析器」已不存在。
    // 改成**逐个选择器定义块**内做精确匹配。
    for (const name of ['buddyBalanceSelector', 'workbuddyBalanceSelector']) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector(`)
      expect(start, `index.ts 里找不到 ${name}`).toBeGreaterThan(-1)
      const block = indexCode.slice(start, indexCode.indexOf('})', start))
      expect(block, `${name} 必须直接用 resolveBuddyCredentialByRef`).toMatch(
        /resolveCredential:\s*resolveBuddyCredentialByRef\b/,
      )
    }
    // 编排的**入参**必须真的被传下去（只断言 `options.resolveCredential` 出现在
    // 源码里是不够的 —— 它只有定义处一处命中，观测不到调用点）。
    const body = pickHelperBody()
    expect(body, '编排必须把 resolveCredential 传给 pickBuddyAccount').toMatch(
      /pickBuddyAccount\([\s\S]*?resolveCredential,/,
    )
  })

  it('所有走选号编排的 provider 都调 pickBuddyCredential', () => {
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: CODEBUDDY,/)
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: WORKBUDDY,/)
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: TRAE,/)
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: LOBSTERAI,/)
    expect(indexCode.match(/await pickBuddyCredential\(\{/g)).toHaveLength(4)
  })

  /**
   * ⚠️ 非 buddy 的 provider **必须**传自己的解析器：编排的缺省值是 buddy 系那一份，
   * 而 TRAE / LobsterAI 的凭据结构不同（`TraeCredential` 有 uid/machine_id、
   * `LobsteraiCredential` 另有字段）—— 用错解析器会静默产出错误形状的凭据。
   */
  it('★ TRAE / LobsterAI 显式传自己的凭据解析器（不得落到 buddy 缺省值）', () => {
    // ⚠️ **必须在「编排调用块」范围内匹配**，不能全文件 `toContain`：
    // 那两个标识符在选择器定义处（`new BuddyBalanceSelector({ resolveCredential: … }）`）
    // 本来就各出现一次，于是哪怕把 `pickBuddyCredential` 调用里的那一行删掉、
    // 让编排静默退回 buddy 缺省值，用例照样绿 —— 已实测复现（反向验证）。
    // 任何崩不了的实现都能过的用例比没有更危险，故这里取「调用点到闭合」这一段。
    const traeCall = pickCallBlock('TRAE')
    expect(traeCall, 'TRAE 的 pickBuddyCredential 调用块').toContain('resolveCredential: resolveTraeCredentialByRef,')
    const lobsteraiCall = pickCallBlock('LOBSTERAI')
    expect(lobsteraiCall, 'LobsterAI 的 pickBuddyCredential 调用块').toContain('resolveCredential: resolveLobsteraiCredentialByRef,')
  })

  /**
   * ⚠️ **TRAE 必须传 `isFreeModel`**（PR !68 审计补齐，buddy 系早已接上）。
   *
   * TRAE 确有 `rate: 0` 的**合法免费模型**（`trae.ts` 的 `readConsumptionRate`
   * 注释 + `traeDisplayName` 把 0 显示成「免费」）。不跳过余额分档的话，
   * 「锁定 + 账号只剩永久积分 + 选中免费模型」会抛「积分都已用尽」——
   * 而免费模型根本不扣积分，错误信息把用户引向完全错误的排查方向。
   */
  it('★ TRAE 接线传 isFreeModel（免费模型不被锁定误拦）', () => {
    expect(pickCallBlock('TRAE')).toContain('isFreeModel: await traeAdapter.isFreeModel(modelId)')
  })

  /**
   * ⚠️ 两家的凭据解析器必须**做形状校验**，且与各自 auth 的 `parseCredential` 对齐。
   *
   * 裸 `JSON.parse` 会把 `{"foo":1}` 这种损坏凭据当成有效凭据返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（不是可诊断的
   * `MISSING_CREDENTIAL`），且发生在选号之后、不在余额查询的 try/catch 覆盖内。
   *
   * 判据取 `typeof parsed.access_token === 'string'`，与 `trae-auth.ts` /
   * `lobsterai-auth.ts` 的 `parseCredential` 逐字一致。
   */
  it('★ 两家凭据解析器做形状校验（与各自 auth 的 parseCredential 对齐）', () => {
    for (const fn of ['resolveTraeCredentialByRef', 'resolveLobsteraiCredentialByRef']) {
      const start = indexCode.indexOf(`const ${fn} = async`)
      expect(start, `index.ts 里找不到 ${fn}`).toBeGreaterThan(-1)
      const body = indexCode.slice(start, indexCode.indexOf('\n  }', start))
      expect(body, `${fn} 必须校验 access_token 是字符串`).toContain("typeof parsed.access_token === 'string'")
    }
  })

  /**
   * ⚠️ 两家的**选号器**必须注入自己的 `fetchBalance`。
   *
   * 漏传时不会用 buddy 的缺省实现去发请求（那样只是查不到），而是把
   * `TraeProduct` 喂给 `fetchCreditBalance` —— 它读 `product.endpoint`，而
   * `TraeProduct` **根本没有这个字段** ⇒ 拼出 `undefined/v2/billing/...` 的
   * 畸形 URL。后果：余额恒查不到 ⇒ 未锁定时换号优化静默失效、锁定时永远报
   * 「无法确认是否有可用账号」，而积分一分没花。
   *
   * ⚠️ 该漏洞**已由 `BuddySelectionDeps` 的条件类型在编译期关闭**
   * （非 buddy provider 的 `fetchBalance` 必填，实测漏传报 TS2345）；
   * 这里再钉一道源码级断言作双保险 —— 万日后退化成可选类型，本用例仍能红。
   */
  it('★ 两家选号器注入自己的 fetchBalance（不用 buddy 缺省实现）', () => {
    for (const [name, product, fn] of [
      ['TRAE', 'TRAE', 'fetchTraeCreditBalance'],
      ['LobsterAI', 'LOBSTERAI', 'fetchLobsteraiCreditBalance'],
    ] as const) {
      const re = new RegExp(
        `const ${name.toLowerCase()}BalanceSelector = new BuddyBalanceSelector\\(\\{\\s*\\n\\s*product: ${product},[\\s\\S]*?fetchBalance:`,
      )
      expect(indexCode, `${name} 的选择器必须注入 fetchBalance`).toMatch(re)
      expect(indexCode, `${name} 应调用 ${fn}`).toContain(fn)
    }
  })

  /**
   * ⚠️ **兜底必须带上 `picked.tried`**（PR !68 新增，此前是漏的）。
   *
   * 不带的话，档位最优但**凭据损坏**的账号会被 `getAvailableAccount` 立刻选回
   * （池按手动顺序取第一个）⇒ 兜底**原地打转**，换号形同虚设。
   * 这与 AGENTS.md 反复强调的「切号必须传 tried」是同一类缺陷。
   *
   * ⚠️ 已实测：删掉第三个参数后**全量单测照样全绿** —— 必须钉住。
   */
  it('★ 两家兜底调 getAvailableAccount 必须透传 picked.tried', () => {
    for (const id of ['TRAE.id', 'LOBSTERAI.id']) {
      const re = new RegExp(
        `getAvailableAccount\\(${id}, modelId \\?\\? '', picked\\.tried\\)`,
      )
      expect(indexCode, `${id} 的兜底必须传 tried 排除集`).toMatch(re)
    }
  })

  /**
   * ⚠️ **Token 账本归属不能丢**：`reportLedgerAccount(<ID>.id, picked.accountId)`。
   *
   * `pickBuddyCredential` 的返回值新增 `accountId` 就是为了这个（PR 说明里专门写了
   * 「重构时**保持不丢**」）。实测把这两行删掉、或把 provider 报成 `'buddy'`，
   * **全量单测全绿** —— token 账本会把这笔消耗记到错误的 provider 上。
   */
  it('★ 两家回报 token 账本时用自己选中的账号（不得丢失或报错 provider）', () => {
    for (const id of ['TRAE', 'LOBSTERAI']) {
      const re = new RegExp(
        `reportLedgerAccount\\(${id}\\.id, picked\\.accountId\\)`,
      )
      expect(indexCode, `${id} 必须回报 picked.accountId`).toMatch(re)
    }
  })

  /**
   * ⚠️ **`modelId` 必须透传给编排与兜底**。
   *
   * 漏传给编排 ⇒ 候选的模型级限流过滤整体短路（`if (key.length === 0) return true`）
   * ⇒ 被标记限流的号仍被选中；漏传给兜底 ⇒ 同理短路。
   * buddy 侧 `trae-model-id-selection.spec.ts` 防的是「传空串」，**防不了整行不传**。
   */
  it('★ 两家把 modelId 透传给编排与兜底（限流过滤不得短路）', () => {
    for (const block of [pickCallBlock('TRAE'), pickCallBlock('LOBSTERAI')]) {
      expect(block, '编排调用必须带 modelId').toMatch(/modelId,/)
    }
    for (const id of ['TRAE.id', 'LOBSTERAI.id']) {
      expect(indexCode, `${id} 的兜底必须透传 modelId`).toMatch(
        new RegExp(`getAvailableAccount\\(${id}, modelId \\?\\? ''`),
      )
    }
  })

  /**
   * ⚠️ 候选必须**先**按 enabled + 模型限流过滤，余额分档只在候选内进行 ——
   * 与 Loomy 同一约定（用户要求「策略建立在模型没有受限且账户没有被停用的基础上」）。
   * 顺序反了就会出现「被限流的号因为积分多而被选中」。
   */
  it('候选过滤：provider id 取自产品配置、enabled、模型限流三项齐全', () => {
    const body = pickHelperBody()
    // provider 实参用 product.id 而非字面量（写死字面量在改名/多产品时会静默查不到账号）
    expect(body).toContain('listAccountsByProvider(options.product.id)')
    expect(body).toContain('filter(a => a.enabled)')
    expect(body).toContain('const key = options.modelId ?? ')
    expect(body).toContain('modelRateLimits[key]')
    expect(body).toContain('Date.now() >= resetAt')
  })

  it('锁定状态按 provider 读，且判据是取反（permanentLocked=true ⇒ allowPermanent=false）', () => {
    expect(pickHelperBody()).toContain('const allowPermanent = !pool.permanentLocked(options.product.id)')
  })

  /**
   * ⚠️ **锁定时绝不可落到 `getAvailableAccount` 兜底** —— 那会绕过锁定、
   * 照样消耗永久积分，使锁定形同虚设（Loomy 那条同因，用户明确要求报错）。
   *
   * ⚠️ 且必须**分两种原因报**（与 Loomy 同型缺陷）：把"余额查不到"报成
   * "额度已用尽"，用户会去解锁或白等，而号其实有钱。
   */
  it('编排返回 locked 时直接抛错，函数体内不做任何兜底', () => {
    const body = pickHelperBody()
    expect(body).toMatch(/if \(picked\.kind === 'locked'\) \{/)
    // 整个编排函数里都不该出现兜底取号 —— 兜底只属于未锁定的调用方路径
    expect(body).not.toContain('getAvailableAccount')

    const throws = body.match(/throw new Error\(/g) ?? []
    expect(throws.length, '应有"查不到"与"确实用尽"两条报错').toBeGreaterThanOrEqual(2)
    expect(body).toMatch(/picked\.reason\?\.kind === 'unknown'/)
    // 两条文案各自说清
    expect(body).toContain('无法确认是否有可用账号')
    expect(body).toContain('没有可用账号')
    // 文案要告诉用户去哪个面板解锁，并按窗口说清「什么算临时积分」
    expect(body).toContain('options.displayName')
    expect(body).toContain('buddyExpiringWindowDays()')
    expect(body).toContain('解锁永久积分')
  })

  it('未锁定且编排没选到时，兜底必须带上 tried 排除集（否则原地打转）', () => {
    // buddy 与 workbuddy 两处兜底都要传
    const calls = indexCode.match(/pool\.getAvailableAccount\((?:CODEBUDDY|WORKBUDDY)\.id, modelId \?\? '', picked\.tried\)/g) ?? []
    expect(calls).toHaveLength(2)
  })

  it('两个 provider 各自的报错文案用其产品名', () => {
    expect(indexCode).toContain("displayName: 'CodeBuddy'")
    expect(indexCode).toContain("displayName: 'WorkBuddy'")
  })
})

/**
 * 行为级：**endpoint 必须随产品切换**。
 *
 * `product` 是选号器唯一的路由信息来源 —— 若两站共用一份 product，
 * 中国版账号会拿着国际版的余额（或反之），锁定判据就建立在错的数据上。
 * 这是本插件反复踩过的坑（endpoint 不可当全局常量）。
 */
describe('选号器按产品取 endpoint（两站不串味）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const balance: CreditBalance = {
    total: 250,
    packages: [{
      name: 'Bonus Pack',
      unit: 'credits',
      remaining: 250,
      total: 250,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      deductionEndTime: Date.now() + 9 * DAY,
    }],
    expiredTotal: 0,
  }

  function selectorFor(product: typeof CODEBUDDY, seen: string[]) {
    return new BuddyBalanceSelector({
      product,
      resolveCredential: async ref => ({ access_token: 'AT', domain: product.apiDomain } as BuddyCredential & { domain: string }) as unknown as BuddyCredential,
      fetchBalance: async (_credential, p) => {
        seen.push(`${p.endpoint}/v2/billing/meter/get-user-resource`)
        return balance
      },
    })
  }

  it('CodeBuddy 用 copilot.tencent.com，WorkBuddy 用 www.workbuddy.ai', async () => {
    const seen: string[] = []
    const buddy = selectorFor(CODEBUDDY, seen)
    const workbuddy = selectorFor(WORKBUDDY, seen)

    const pickedBuddy = await buddy.select([{ id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' }], {})
    const pickedWorkbuddy = await workbuddy.select([{ id: 'w1', credentialRef: 'WORKBUDDY_ACCOUNT_W1' }], {})

    expect(seen).toEqual([
      `${CODEBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
      `${WORKBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
    ])
    // 两站都有「15 天内到期」的包 ⇒ 都落在 expiring 档、都被选中
    expect(pickedBuddy?.account.id).toBe('b1')
    expect(pickedWorkbuddy?.account.id).toBe('w1')
    expect(pickedBuddy?.balance.tier).toBe(0)
  })

  it('编排层拿到的凭据来自实际选中的那个账号', async () => {
    const seen: string[] = []
    const selector = selectorFor(CODEBUDDY, seen)
    const result = await pickBuddyAccount(selector, [
      { id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' },
    ], {
      allowPermanent: false,
      resolveCredential: async ref => ({ access_token: `token-${ref}` }) as unknown as BuddyCredential,
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.credential.access_token).toBe('token-BUDDY_ACCOUNT_B1')
  })

  it('窗口边界在编排里同样生效（17 天的包在锁定时不可用）', async () => {
    const seen: string[] = []
    const selector = new BuddyBalanceSelector({
      product: CODEBUDDY,
      resolveCredential: async ref => ({ access_token: ref }) as unknown as BuddyCredential,
      fetchBalance: async () => ({
        total: 100,
        expiredTotal: 0,
        packages: [{
          name: 'CodeBuddy个人版国内运营裂变包',
          unit: 'credits',
          remaining: 100,
          total: 100,
          used: 0,
          active: true,
          cycleStartTime: '',
          cycleEndTime: '',
          expiredTime: '',
          // 实测中国版裂变包的到期分布密集落在 17～30 天
          deductionEndTime: Date.now() + 17 * DAY,
        }],
      }),
    })
    const result = await pickBuddyAccount(selector, [{ id: 'b1', credentialRef: 'R1' }], {
      allowPermanent: false,
      resolveCredential: async () => ({ access_token: 'x' }) as unknown as BuddyCredential,
    })
    // ⇒ 该账号在锁定期间「等同于不可用」：这正是用户要的语义，不是缺陷
    expect(result.kind).toBe('locked')
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
  })
})
