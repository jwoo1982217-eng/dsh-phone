import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  creditCapabilitiesOf,
  descriptorOf,
} from '../../src/provider-registry.js'

describe('ProviderDescriptor：与既有产物的逐条一致性', () => {
  it('id 一律纯小写字母（带连字符会让四处正则断言静默漏算）', () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(d.id, `${d.id} 必须纯小写字母`).toMatch(/^[a-z]+$/)
    }
  })

  it('id 不重复', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个 provider 都有非空 label / logoClass', () => {
    // ⚠️ 不断言 icon：registry **刻意不持有图标**（那会让宿主产物白白背上
    //    几十 KB 的 data URI 字面量，而宿主从不使用图标）。图标在客户端的
    //    PROVIDER_ICONS 里，由 Step 8 那条「两边 id 集合相等」的守卫覆盖。
    for (const d of PROVIDER_REGISTRY) {
      expect(d.label.length, `${d.id} 缺 label`).toBeGreaterThan(0)
      expect(d.logoClass.length, `${d.id} 缺 logoClass`).toBeGreaterThan(0)
    }
  })

  it('共 22 条（21 个真渠道 + aggregate）', () => {
    // ⚠️ 2026-10-13 合并：officeace（第 15）与 accio（第 16）**同一次**并入，
    //    故从 15/14 直接跳到 17/16 —— 不是漏了一格。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版，第 17 个真渠道）：
    //    它与 `minimax` 账号不互通、API 主机不同 ⇒ 是两个 provider。
    // ⚠️ 2026-10-16 并入 astudio（第 18 个真渠道）。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱，第 19 个真渠道）。
    // ⚠️ 2026-10-16 **本 fork** 并入 modelscope（魔搭，第 20 个真渠道）：上游没有它。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版，第 21 个真渠道）：
    //    与 autoclaw 账号不互通（手机号 / 邮箱）、API 主机不同、**登录方式也不同**
    //    ⇒ 与 minimaxintl 同款判据（实测国内 token 打国际基址 → `401 Invalid token`）。
    //    ⚠️ 合并上游时**不要**把这里改回上游数字 —— 那会让两个声明都失去守卫
    //    （条数断言是「注册表没被误删」的唯一防线）。
    expect(PROVIDER_REGISTRY).toHaveLength(23)
    expect(PROVIDER_REGISTRY.filter((d) => d.channel).length).toBe(22)
    expect(PROVIDER_REGISTRY.find((d) => d.id === 'aggregate')?.channel).toBe(false)
  })

  /**
   * ⚠️⚠️ **声明序 = 设置页左栏的默认渲染序**（2026-10-17，用户报障）。
   *
   * 未自定义 `providerOrder` 时，左栏完全按 `PROVIDER_REGISTRY` 的**声明序**
   * 渲染（`sortOpenProvidersByOrder` 对空序是恒等函数）；而已关闭组**恒按声明序
   * 沉底**、永不被自定义序覆盖。
   *
   * ⚠️ 本条守的是**相对位置**而非绝对下标：新增 provider 时下标必然漂移，
   * 钉死数字会变成「必然过期」的快照（仓库对这类魔数断言有明确教训）。
   *
   * 需求：ModelScope 的设置标签应排在**聚合之上**。
   */
  it('★ modelscope 的声明序在 aggregate 之前（设置页左栏的默认渲染序）', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    const im = ids.indexOf('modelscope')
    const ia = ids.indexOf('aggregate')
    expect(im, 'registry 里找不到 modelscope').toBeGreaterThan(-1)
    expect(ia, 'registry 里找不到 aggregate').toBeGreaterThan(-1)
    expect(im, 'ModelScope 必须排在聚合之上，否则它在左栏会被排到聚合下面')
      .toBeLessThan(ia)
  })

  it('★ 真实排出的左栏顺序与声明序一致（复刻客户端排序口径，非源码断言）', async () => {
    // ⚠️ 真跑客户端的排序纯函数：只测 registry 的相对位置不足以覆盖
    //    「用户已自定义过 providerOrder」这条路径（未出现在序里的项按声明序补后）。
    const { sortOpenProvidersByOrder } = await import('../../plugin-src/client/provider-toggle.js')
    const ids = PROVIDER_REGISTRY.map((d) => ({ id: d.id }))
    // 复刻本机实测的 providerOrder：自定义但**不含** aggregate / modelscope
    const order = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'trae', 'cline',
      'loomy', 'raccoon', 'minimax', 'zcode', 'opencode', 'gemini', 'qoder', 'qodercn']
    const sorted = sortOpenProvidersByOrder(ids, order).map((p) => p.id)
    expect(sorted.indexOf('modelscope'),
      `实际左栏顺序：${sorted.join(' → ')}`).toBeLessThan(sorted.indexOf('aggregate'))
  })

  it('descriptorOf 按 id 取；未知返回 undefined', () => {
    expect(descriptorOf('buddy')?.label).toBe('CodeBuddy (腾讯)')
    expect(descriptorOf('nope')).toBeUndefined()
  })
})

describe('从 registry 派生的能力表与既有断言逐条相等', () => {
  it('CREDITS 派生结果与既有 7 条 toEqual 断言一致（astudio 2026-10-16 加入）', () => {
    const caps = creditCapabilitiesOf()
    expect(caps.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.buddy).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.workbuddy).toEqual({ balance: true, dailyCheckin: false })
    expect(caps.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.loomy).toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
    // ⚠️ 2026-10-16 并入 astudio：逐家 toEqual，漏写这一条则「registry 加了
    //    而客户端能力表没派生出来」这种漂移不会被本用例发现。
    expect(caps.astudio).toEqual({ balance: true, dailyCheckin: true })
  })

  it('只有 cline 有 subscriptionQuota（既有断言 toEqual([\'cline\'])）', () => {
    const withQuota = Object.entries(creditCapabilitiesOf())
      .filter(([, c]) => c.subscriptionQuota === true)
      .map(([id]) => id)
      .sort()
    expect(withQuota).toEqual(['cline'])
  })

  /**
   * ⚠️ **三张派生表必须同款：外层与内层各自 `Object.freeze`**（2026-10-08 复审修复）。
   *
   * 重构前 `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
   * `Object.freeze({…})`；改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` —— 那只冻结
   * **外层容器**，**内层条目仍可被改写**。同文件另外两张表
   *（`RATE_LIMIT_CAPABILITIES` / `ACCOUNT_TEST_CAPABILITIES`）各自都留着
   * `Object.freeze({…})`，故这是**只在其中一张表上静默失效的保险**。
   *
   * ⚠️ 这条用例本身就是「保险的保险」：本仓库的约定是「保险失效比变红更糟」——
   * 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了），故冻结本身
   * 也必须由一条会变红的断言守着。
   */
  it('⚠️ 派生表的每个条目自身也是冻结的（外层冻结挡不住内层改写）', async () => {
    const caps = creditCapabilitiesOf()
    // `creditCapabilitiesOf()` 返回的是**未冻结的外层**（冻结由调用方做：
    // 客户端 `Object.freeze(creditCapabilitiesOf())`）—— 但**每条必须已冻结**，
    // 否则调用方的外层冻结只是一道挡不住内层改写的空保险。
    for (const [id, entry] of Object.entries(caps)) {
      expect(Object.isFrozen(entry), `${id} 的能力条目应逐条冻结`).toBe(true)
    }
    // ⚠️ 三张表**同款**才算修好：另两张（限流 / 测试）各自都留着逐条冻结，
    //    若只有积分表缺，那是「只在其中一张表上静默失效的保险」。
    const client = await import('../../plugin-src/client/credits-capabilities.js')
    for (const [name, table] of [
      ['CREDITS_CAPABILITIES', client.CREDITS_CAPABILITIES],
      ['RATE_LIMIT_CAPABILITIES', client.RATE_LIMIT_CAPABILITIES],
      ['ACCOUNT_TEST_CAPABILITIES', client.ACCOUNT_TEST_CAPABILITIES],
    ] as const) {
      expect(Object.isFrozen(table), `${name} 外层应冻结`).toBe(true)
      for (const [id, entry] of Object.entries(table)) {
        expect(Object.isFrozen(entry), `${name}.${id} 应逐条冻结`).toBe(true)
      }
    }
    expect(Object.isFrozen(PROVIDER_REGISTRY), 'registry 数组应冻结').toBe(true)
  })

  it('permanentLock 恰好是既有的 6 家（officeace 2026-10-12 加入）', () => {
    const locked = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true)
      .map((d) => d.id).sort()
    expect(locked).toEqual(['buddy', 'lobsterai', 'loomy', 'officeace', 'trae', 'workbuddy'])
  })

  it('usesExpiryWindow 恰好是 7 家（loomy 不在内，它没有窗口概念；autoclaw 2026-10-17 加入）', () => {
    const win = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true)
      .map((d) => d.id).sort()
    // ⚠️ autoclaw 2026-10-17 加入：流水每笔发放带 `wallet_expires_at`，未过期批次
    //    之和 == total_balance（守恒实测）⇒ 批次包带 `deductionEndTime` 可分三档。
    // ⚠️ 2026-10-20 加 autoclawintl：与 autoclaw **同源**（同一份 credits 实现），
    //    实测国际站批次同样带 `deductionEndTime`（3000→10/21、10000→10/27）。
    expect(win).toEqual(['autoclaw', 'autoclawintl', 'buddy', 'lobsterai', 'officeace', 'trae', 'workbuddy'])
  })

  it('rateLimit === false 恰好是 7 家（astudio 2026-10-18 加入；accio 2026-10-18 退出）', () => {
    const off = PROVIDER_REGISTRY.filter((d) => d.rateLimit === false)
      .map((d) => d.id).sort()
    // ⚠️ **六家理由分两类**（见 registry 里各自的字段注释）：
    // - loomy：根本不返回限流错误（静默降级扣永久积分）；
    // - gemini / officeace：限流是服务端配额窗口制，本地标记与重测都不改变配额；
    // - astudio（**本 fork**）：**不写 `modelRateLimits` 且不在 `probeById` 里**
    //   （`astudio-adapter.ts` 同款）⇒ 两个按钮恒为惰性（零请求、零清除）。
    // - autoclaw：**与 astudio 同族**（刻意不做请求级换号 + 冷却，不进 `probeById`）。
    // - autoclawintl（2026-10-20）：与 autoclaw **同一个适配器类、同一份 registry
    //   字段语义** ⇒ 必然一起为 false。
    // - modelscope（**本 fork**，2026-10-17 用户要求）：**能力齐全但刻意关入口** ——
    //   它确实会写 `modelRateLimits`、也确实注入了 `markLimited`。
    //   ⚠️ 与前几家**不同源**：代价是「冷却标记仍写进池，但用户没法用按钮清除」
    //   （只能等自然过期或删号重加），而不是「按钮点了没用」。
    //   ⚠️ 它在 `credits-capabilities.spec.ts` 的 `RATE_LIMIT_OFF_BY_CHOICE`
    //   里有独立登记（那张表专门区分「产品取舍」与「语义管辖不到」两类）。
    //
    // ⚠️⚠️ **accio 曾在这张表里，2026-10-18 因 issue IKM3ZV 退出**（7 家 → 6 家）：
    //   当时它的理由是「不写 `modelRateLimits` 且不在 `probeById` 里 ⇒ 按钮恒惰性」。
    //   接上请求级换号 + 冷却（`accio-adapter.ts` 的 `markCurrentAccount`，
    //   额度至 UTC+8 当日 24:00 / 限流 1h）后，① 真的写标记了、② `probeById`
    //   也登记了 ⇒ 那个理由**已不成立**，`rateLimit: true` 是**实打实可用**的入口
    //   （与 modelscope 的「能力齐全但刻意关」相反）。
    //   ⚠️ **三处必须同改**（registry 本行 / `src/index.ts` 的 `probeById` /
    //   `tests/helpers/provider-sets.ts` 的 `WRITES_RATE_LIMIT_PROVIDERS`），
    //   由 `provider-runtime-wiring.spec.ts` 双向比对锁死 —— 本表是**第四道**闸。
    //
    // 新增一家时**不要**只改这里：判据是 registry 的落地问法
    //「这个按钮点下去，能不能让用户少受限一次？」——
    // ⚠️ 而 modelscope 打破的正是这条问法的前提（它**能**，只是不要）。
    //    ⇒ 所以「能」不再是必要条件，「用户是否要这个按钮」才是。
    expect(off).toEqual(['astudio', 'autoclaw', 'autoclawintl', 'gemini', 'loomy', 'modelscope', 'officeace'])
  })

  it('accountTest === true 恰好是 gemini', () => {
    const t = PROVIDER_REGISTRY.filter((d) => d.accountTest === true).map((d) => d.id)
    expect(t).toEqual(['gemini'])
  })

  it('creditPackages 必须覆盖所有 usesExpiryWindow 的家（判据从能力事实派生，不是手写名单）', () => {
    // ⚠️⚠️ **本用例原先是一份手写 9 家名单，把「漏项」固化成了期望值**
    //    （2026-10-20 审计实测）：`autoclawintl` 漏了 `creditPackages`，
    //    补上它反而**变红**（`expected [...(10)] to deeply equal [ Array(9) ]`）。
    //    那正是本仓库反复记载的「守卫把 bug 写成期望值」形态 —— 它保护的是
    //    当时的快照，不是正确性。
    //
    // ⇒ 判据改为两条**从能力事实派生**的不变式：
    //   ① `usesExpiryWindow: true` 的家必须**也有** `creditPackages`
    //      —— 「按到期分档」与「逐包列明细」消费的是同一份数据
    //      （`packages[].deductionEndTime`）；声明了前者却不声明后者，
    //      用户就只看得到分档、看不到是哪几包。
    //   ② `creditPackages` 的家必须真的能读余额（否则无包可列）。
    //
    // ⚠️ 反向不成立（有 `creditPackages` 但无 `usesExpiryWindow`）：astudio /
    //    qoder / qodercn 三家**有逐包到期时间**但未接入「按到期分档」的窗口
    //    回传 ⇒ 只列明细、不分档，是合法组合，**不得**被这条判据误伤。
    const usesExpiryWindow = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true)
    const missing = usesExpiryWindow.filter((d) => d.creditPackages !== true).map((d) => d.id)
    expect(missing, 'usesExpiryWindow 的家必须有 creditPackages（同一份数据）').toEqual([])

    const noBalance = PROVIDER_REGISTRY
      .filter((d) => d.creditPackages === true && d.credits?.balance !== true)
      .map((d) => d.id)
    expect(noBalance, 'creditPackages 的家必须真的能读余额').toEqual([])

    // 至少要有若干家，防止「全表被清空」这种退化仍绿（同义反复的反面）。
    expect(PROVIDER_REGISTRY.filter((d) => d.creditPackages === true).length).toBeGreaterThan(5)
  })

  it('autoCheckinExcluded 恰好是 zcode', () => {
    const x = PROVIDER_REGISTRY.filter((d) => d.autoCheckinExcluded === true).map((d) => d.id)
    expect(x).toEqual(['zcode'])
  })

  it('channel === true 的 19 家都有 settingsNamespace 除了 opencode', () => {
    const withNs = PROVIDER_REGISTRY.filter((d) => d.settingsNamespace !== undefined)
      .map((d) => d.id).sort()
    expect(withNs).toEqual([
      'accio', 'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'cline', 'codearts', 'gemini', 'lobsterai', 'loomy',
      'minimax', 'minimaxintl', 'officeace', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
    ])
  })
})

describe('客户端图标表与 registry 同步（行为断言）', () => {
  it('PROVIDER_ICONS 的键集合与 registry 的 id 集合完全相等', async () => {
    // ⚠️ 直接 import 客户端的导出，**不读源码文本**。
    //    失败时 toEqual 的 diff 会明确指出缺哪个 id。
    //
    // ⚠️ 2026-10-08：初稿 import 的是 `plugin-src/client/jet-hub.js`，
    //    但**实测失败** —— 本仓库 `node_modules` 里**没有 react**
    //    （`react` 只在 `build.mjs` 的 `external` 里、由宿主注入），
    //    报 `Cannot find package 'react' imported from .../jet-hub.js`。
    //    故按 brief 的 fallback：图标与 `PROVIDER_ICONS` 抽到**纯数据模块**
    //    `plugin-src/client/provider-icons.js`（无 react 依赖），测试指向它。
    //    这与本仓库既有的 `aggregate-panel-logic.js` / `badge-model.js` /
    //    `new-account.js` 同款 —— 都是「为可单测而从 jet-hub.js 拆出」。
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    expect(Object.keys(PROVIDER_ICONS).sort())
      .toEqual(PROVIDER_REGISTRY.map((d) => d.id).sort())
  })

  it('每个图标都是非空 data URI（防止键存在但值是 undefined）', async () => {
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    for (const [id, icon] of Object.entries(PROVIDER_ICONS)) {
      expect(typeof icon, `${id} 的图标类型`).toBe('string')
      expect((icon as string).startsWith('data:image/'), `${id} 的图标必须是 data URI`).toBe(true)
    }
  })
})
