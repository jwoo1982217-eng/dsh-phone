/**
 * 各 provider 的**临期折算能力实现表** —— `ProviderRuntime.expiry` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`src/aggregate-expiry.ts` 的 `credentialExpiry(provider, credential)`
 * 是一个 7-case `switch`，而**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`）—— 与 `account.refresh` 的 13 个同构 case
 * 完全同型。那 7 个分支体里**没有一行协议逻辑**，只有「选哪个原语」。
 *
 * ## ⚠️ 为什么单独一个文件（而不是把表内联在 `index.ts`）
 *
 * 内联在 `index.ts` 里时，**单测无法复用**那张表：`createExpiryProbe` /
 * `AggregateAdapter` 有几十处用例直接构造（**不调 `apply()`**），它们要验证
 * 折算**值**（TTL 缓存、取全部账号、`clear()` 等）就必须让 runtime 里有真实实现。
 * 若那些用例各写一份自己的表，就出现**同一语义两套判据** —— 本仓库首条红线
 *（`buddy-growth.ts` 因两处对同一字段给出相反判据而静默失效）。
 * ⇒ 表放在这里，`src/index.ts` 与单测**共用同一份**。
 *
 * ⚠️ 与 `createProviderCredits` / `createProviderOnboarding` 同款理由
 *（那两张表也是「工厂在 src、生产与单测共用」）。
 *
 * ## ⚠️ 边界：本表只做「选哪个原语」，**不**抽象原语本身
 *
 * 各家 `*Expiry` 函数（判据不同、量纲不同）原样保留在 `aggregate-expiry.ts`，
 * 本表只是把它们挂到一张可查的表上（设计文档 §3.5.3 / §3.6）。
 * `buddy` 与 `workbuddy` **共用** `buddyExpiry`、只换 product 配置 ——
 * 与 `BuddyProduct` 驱动其余差异同款，避免同族分叉。
 *
 * ## ⚠️ 只覆盖**已接入临期折算**的渠道（刻意不在此写数字：权威是
 * `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`，抄一份必然漂移）
 *
 * 未接入的渠道（`qoder` / `qodercn` / `cline` / `raccoon` / `minimax` /
 * `gemini` / `opencode`）**刻意缺席**：它们的余额响应没有跨账号的到期口径
 *（见 `aggregate-expiry.ts` 的逐渠道判据表）。缺席的**运行时后果**是
 * `credentialExpiry` 返回 `UNUSABLE`（该候选本轮被剔除）。
 *
 * ## ⚠️⚠️ **但「哪些虚拟模型可以播报」不由本表派生**（2026-10-08 设计复审更正）
 *
 * 那由 `aggregate-expiry.ts` 的**编译期常量** `WIRED_EXPIRY_PROVIDERS` 决定。
 * 两者回答的是**两个不同的问题**：本表答「**运行时**该调哪个原语」（要到
 * `apply()` 注册时才填充），那个常量答「这个渠道**接入了**折算吗」（编译期事实：
 * 源码里有没有为它写折算原语）—— 不是同一件事，故不能互为派生源。
 *
 * ⇒ **别把那个常量改成本表的派生值**（它看起来像一份冗余的手抄清单，其实不是）。
 * 它在源码里有 **5 个**消费点：`aggregate-adapter.ts` 的**四处**过滤
 *（探测排序 / 面板候选 / 虚拟模型播报 / 选择器价格后缀）加 `aggregate-expiry.ts`
 * 的「未接入」短路（⚠️ **轮换候选**的闸门正是这处短路，不是那四处过滤）；
 * 更要紧的是它被**大量不调 `apply()`** 的既有测试消费（实测：在 `tests/unit` 里
 * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）——
 * 派生版本在那些场景下**恒为空数组**，`refreshCatalog` 会把**所有虚拟模型过滤掉**、
 * 聚合 provider 的模型列表**整个变空**。
 * 两者的一致性由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
 */

import {
  accioExpiry,
  buddyExpiry,
  codeArtsExpiry,
  lobsteraiExpiry,
  loomyExpiry,
  officeaceExpiry,
  traeExpiry,
  // ⚠️ **本 fork 独有**（魔搭，2026-10-17）
  modelscopeExpiry,
  // ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
  autoclawExpiry,
  zcodeExpiry,
} from './aggregate-expiry.js'
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）
import { MODELSCOPE } from './modelscope-product.js'
import type { ModelscopeCredential } from './modelscope.js'
// ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js'
import type { AutoclawCredential } from './autoclaw.js'
import type { AccioCredential } from './accio.js'
import type { OfficeAceCredential } from './officeace-auth.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { TRAE } from './trae-product.js'
import type { BuddyCredential } from './buddy.js'
import type { CodeArtsCredential } from './types.js'
import type { LoomyCredential } from './loomy.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { TraeCredential } from './trae.js'
import type { ZcodeCredential } from './zcode.js'
import type { ProviderRuntime } from './provider-runtime.js'
// ⚠️ 只导入**类型**（`CreditBalance` 是取数原语的返回形状）：本表只是「选哪个原语」，
//    不解释余额内容（那个判据在 `aggregate-expiry.ts` 的各家原语里）。
import type { CreditBalance } from './credits.js'

/** 一个渠道的临期折算实现（`ProviderRuntime.expiry` 的非空形态）。 */
export type ProviderExpiry = NonNullable<ProviderRuntime['expiry']>

/**
 * buddy 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 单独抽出来是为了让下面两条一眼看出「它们只差一个 product」——
 * 若将来有人给其中一家写一份自己的判据，那正是「同族分叉」的开始。
 *
 * ⚠️ `context.cachedBalance` 原样透给原语（2026-10-15，规格 §5.7）：
 * 那样「吃共享读数」这条能力**只在这一处**声明，四家自动一致
 *（各写一遍必然有一家漏掉 ⇒ 静默多发一次上游请求）。
 */
function buddyFamilyExpiry(product: BuddyProduct): ProviderExpiry {
  return {
    credentialExpiry: (c, context) => buddyExpiry(
      product,
      c as BuddyCredential,
      context?.cachedBalance === undefined
        ? undefined
        : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
    ),
  }
}

/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方（`index.ts` 与单测）各自持有一份，
 * 互不影响；表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export function createProviderExpiry(): Readonly<Record<string, ProviderExpiry>> {
  return {
    // ⚠️ 两个 buddy 系产品：原语相同、product 不同（`CODEBUDDY` / `WORKBUDDY`）。
    buddy: buddyFamilyExpiry(CODEBUDDY),
    workbuddy: buddyFamilyExpiry(WORKBUDDY),
    loomy: { credentialExpiry: (c) => loomyExpiry(c as LoomyCredential) },
    codearts: { credentialExpiry: (c) => codeArtsExpiry(c as CodeArtsCredential) },
    zcode: { credentialExpiry: (c, context) => zcodeExpiry(c as ZcodeCredential, context) },
    lobsterai: {
      credentialExpiry: (c, context) => lobsteraiExpiry(
        c as LobsteraiCredential,
        LOBSTERAI,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    trae: {
      credentialExpiry: (c, context) => traeExpiry(
        c as TraeCredential,
        TRAE,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ accio：与 loomy **同形**（命名池、无逐包时间戳）⇒ 单独一条原语。
    //    加它时必须**同时**进 `WIRED_EXPIRY_PROVIDERS`（`expiry-runtime-parity.spec.ts`
    //    真跑 `apply()` 锁这两者一致；只改一处会红）。
    accio: { credentialExpiry: (c) => accioExpiry(c as AccioCredential) },
    // ⚠️ officeace：与 **buddy 系同形**（订阅的每个积分桶都带 `expiresAt`）。
    //    ⚠️ **必须传 `context.credentialRef`**：它的余额入口只有拿到 ref 才走
    //    云侧直读，否则回落到果办客户端的全局单 cookie ⇒ 多账号折算成同一份
    //    余额（串号），而聚合候选排序是每账号粒度 ⇒ 会选错人。
    //    同 accio：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改。
    officeace: {
      credentialExpiry: (c, context) =>
        officeaceExpiry(c as OfficeAceCredential, context?.credentialRef),
    },
    // ⚠️ **本 fork 独有**（魔搭，2026-10-17，用户明确要求加入聚合轮换）：
    //    属「有余额但不下发到期时间」那一类 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae 同款 —— 聚合每轮折算会对
    //    同一账号反复提问，没有共享读数就会白发大量重复请求。
    //    同 accio / officeace：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改，
    //    由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致。
    modelscope: {
      credentialExpiry: (c, context) => modelscopeExpiry(
        c as ModelscopeCredential,
        MODELSCOPE,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ **AutoClaw**（智谱，2026-10-17 审计 P0 修复）：与 modelscope **同格**
    //    （钱包余额不下发到期时间 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`）。
    //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
    //    这是该陷阱的第 4 次复发，漏任何一处的症状都是**静默**的
    //    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
    //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
    autoclaw: {
      credentialExpiry: (c, context) => autoclawExpiry(
        c as AutoclawCredential,
        AUTOCLAW,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    /**
     * **AutoClaw 国际版**（`autoclawintl`，2026-10-20）。
     *
     * ⚠️⚠️ **product 必须传 `AUTOCLAW_INTL`**：`autoclawExpiry` 内部拿它调
     *    `fetchAutoclawBalanceDetailed(cred, { product })` ⇒ 传国内版会用
     *    **国内基址**查国际账号的余额 ⇒ `410000 未登录` ⇒ 折算恒 `UNUSABLE`
     *    ⇒ 国际账号在聚合轮换列表里**静默不可见**。
     *    这是「同一实现两个实例」最容易踩的一处（与 `provider-credits.ts` 同型）。
     *
     * ⚠️ 批次**实测带** `deductionEndTime`（国际站 3000 → 10/21、10000 → 10/27），
     *    与 buddy 系同形 ⇒ 走 `sharedPackageExpiry` 正确的按到期折算，不是恒 NEVER。
     */
    autoclawintl: {
      credentialExpiry: (c, context) => autoclawExpiry(
        c as AutoclawCredential,
        AUTOCLAW_INTL,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
  }
}
