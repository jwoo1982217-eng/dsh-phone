/**
 * 各 provider 的**元数据与能力声明** —— 本插件里「有哪些 provider、各自有什么能力」
 * 的**唯一真相源**。
 *
 * ## ⚠️ 本文件必须零 import
 *
 * 它同时被两侧消费：
 * - **Node 宿主**（`tsc` → `lib/`）：`src/jet-hub-rpc.ts` 等读它；
 * - **浏览器客户端**（`esbuild` → `lib/client/jet-hub.js`）：
 *   `plugin-src/client/*.js` 经 `import { … } from '../../src/provider-registry.js'`
 *   直接复用它。
 *
 * 后者**已实测可行**（设计文档 §1.4）：esbuild 会把 `./x.js` 解析到同名 `x.ts`。
 * 但浏览器里没有 `node:fs` / `node:path` 等，故本文件**不得** import 任何 `node:*`。
 *
 * ## 为什么要把元数据集中到这里
 *
 * 重构前，加一个 provider 要手改 **13 处**，其中两处会**静默失效**：
 *
 * 1. **四处单测的正则断言**用 `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 从客户端
 *    `PROVIDERS` 派生 id —— `[a-z]+` **不匹配连字符**。若新 provider id 写成
 *    `kuku-ai`，守卫会**静默漏掉一个 id 而照样全绿**（本仓库原注释：
 *    「保险失效比变红更糟」）。
 * 2. **`registerJetHubRpc` 的位置参数**（当时 16 个）—— 注释自陈
 *    「历史上已因少传/插队错位复发 **6 次**」。
 *
 * 本文件消除第 1 处：四处断言改为读 `PROVIDER_REGISTRY`，不再解析源码文本。
 *
 * ## 与各 product 的 `displayName` 的关系
 *
 * 本文件的 `displayName` 当前与对应 product 的 `displayName`（如
 * `src/product.ts` 的 `CodeBuddy (腾讯)`）**取值相同**，但
 * ⚠️ **没有任何断言守着这条一致性** —— 2026-10-08 之前有，那些断言在
 * 客户端 `PROVIDERS` 改为派生后**改锁 `label`** 了（见
 * `raccoon-client-panel.spec.ts` / `zcode-wiring.spec.ts`）。
 *
 * ⚠️ 且它**当前零生产消费者**：真正被读的是各 product 自己的 `displayName`。
 * ⇒ 结构与去留由 Task 11 的收尾审计定夺（选项：删掉本字段只留 `label`，
 * 或保留并补一条「与 product 逐字一致」的断言把它变成可测量的）。
 * **在那之前，不要把本字段当作契约来依赖。**
 */
/** 积分能力（原客户端 `CREDITS_CAPABILITIES` 的每一项）。 */
export interface CreditsCapability {
    /** 能否查积分余额（决定是否渲染「刷新积分」与徽章读数）。 */
    readonly balance: boolean;
    /**
     * 能否每日签到领取（决定是否渲染「一键领取积分」）。
     *
     * ⚠️ **省略 = false**，且「省略」是有语义的、不是偷懒 —— 它表示
     * 「该渠道**没有可调用的签到端点**」。目前只有 `raccoon` 这样登记：
     * 实测「每日 300 积分」是**服务端按日自动发放**的（账单
     * `biz_type: 'daily_grant'`），根本没有签到接口可调；
     * 若强行写成 `dailyCheckin: false` 也能跑，但那样就**看不出作者是否想过**
     *（「忘了登记」与「确认没有端点」会长得一模一样）。故这里**刻意允许省略**，
     * 让 raccoon 那条的 `credits` 保持「缺失即缺失」。
     *
     * ⚠️ 判据一律是 `=== true`（见客户端 `supportsDailyCheckin`），
     * 故 `undefined` 与 `false` 行为**完全一致**，省略不会引入任何功能差异。
     */
    readonly dailyCheckin?: boolean;
    /** 是否有**一次性**新手/登录奖励（Loomy 新手任务 / raccoon 登录奖励）。 */
    readonly onboardingTasks?: boolean;
    /** 是否有**订阅额度窗口**（目前只有 Cline 有「5 小时 / 周 / 月」这一层）。 */
    readonly subscriptionQuota?: boolean;
}
/**
 * 一个 provider 的元数据与能力声明。
 *
 * ⚠️ **可选项的默认语义不统一，这是刻意的**（照搬既有各表的约定，见各字段注释）：
 * - `credits.balance` **必填**（无默认，强制想清楚）；
 * - `credits.dailyCheckin` **可省略，省略 = false** —— 但省略承载语义
 *   「该渠道没有可调用的签到端点」（目前只有 raccoon 如此，见该字段注释）；
 * - `rateLimit` 省略 = **true**（限流按钮是既有 UI，默认关闭会让新 provider
 *   凭空少按钮 —— 可见的功能回退）；
 * - `accountTest` / `permanentLock` / `creditPackages` / `autoCheckinExcluded`
 *   省略 = **false**（默认关闭，避免发必然失败的请求 / 渲染无效按钮）。
 */
export interface ProviderDescriptor {
    /** provider id。⚠️ **必须纯小写字母**（`^[a-z]+$`，见文件头第 1 条）。 */
    readonly id: string;
    /** Jet Hub 左栏（rail）上的显示名。⚠️ 长度受 `.dim-jh-rail` 宽度算式约束。 */
    readonly label: string;
    /**
     * 产品显示名。⚠️ 当前**零生产消费者、零断言**（见文件头的如实说明）——
     * 真正被读的是各 product 自己的 `displayName`。**不要**把它当契约依赖。
     */
    readonly displayName: string;
    /** 图标容器的 CSS 类名（`jet-hub-styles.js` 里按它上样式）。 */
    readonly logoClass: string;
    /** 积分能力。 */
    readonly credits: CreditsCapability;
    /**
     * 该渠道是否具备「模型限流」机制（服务端会因限流拒请求）。
     *
     * ⚠️ **省略 = true**（与 `credits` 的默认关闭**相反**）。理由：限流按钮
     *（重测 / 重置）是**既有 UI**，若默认关闭，将来新增 provider 时忘记登记
     * 会让老用户**凭空失去**按钮 —— 那是可见的功能回退。
     */
    readonly rateLimit?: boolean;
    /** 是否支持账号卡片上的「测试」按钮（无条件真发一次请求探活）。省略 = false。 */
    readonly accountTest?: boolean;
    /**
     * 余额是否**真的由多个资源包构成且有到期信息**（决定账号名 hover 是否列包）。
     *
     * ⚠️ 这不是「避免冗余」，而是**防止显示错误信息**：loomy 的 `packages` 是我们
     * 自己合成的两个条目、**没有** `deductionEndTime`，若不加门控，卡片上会出现
     *「每日赠送 4992 / 4992 永久」—— 而那笔恰恰**当天就作废**，说反了。
     */
    readonly creditPackages?: boolean;
    /** 是否支持「锁定永久积分」。省略 = false。 */
    readonly permanentLock?: boolean;
    /**
     * 是否按**到期时间分桶**（决定「锁定永久积分」是否回传 `windowDays`）。
     *
     * ⚠️ 判据是「是否走 `splitBuddyCreditsByExpiry`」，**不是「是不是 buddy」**：
     * TRAE 与 LobsterAI 走同一套、同样受 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响；
     * 而 loomy 是**服务端直接给两个命名池**、没有窗口概念，故不在内。
     */
    readonly usesExpiryWindow?: boolean;
    /**
     * 每日自动签到是否**排除**该渠道。
     *
     * ⚠️ 它记的不是「谁有签到接口」，而是「谁有签到**代价**」—— 目前只有 zcode：
     * 每次领取都要现场产阿里云 captcha（web 版下会拉起 headful Chromium，
     * 且阿里云按**设备**限流 150 次/小时）。用户仍可**手动**签到。
     */
    readonly autoCheckinExcluded?: boolean;
    /** 老契约（DSH ≤0.1.6）的 settings namespace；省略则不注册。 */
    readonly settingsNamespace?: string;
    /**
     * 是否是一个普通「渠道」（有账号、有凭据、有积分）。
     *
     * `false` 只有 `aggregate`（聚合层不持有账号与积分，它复用各渠道的）。
     * ⚠️ 用布尔而不是「有没有 `accountExtras`」来推断：那是**巧合**而非语义。
     */
    readonly channel: boolean;
}
/**
 * ⚠️ 图标字面量**不写在这里**，而在 `plugin-src/client/provider-icons.js`
 *（它们是几百到几万字符的 base64 / SVG data URI）。原设计想让 registry 持有图标，
 * 但那会让**宿主侧**的 `lib/index.js` 白白背上约 40 KB 的字面量 ——
 * 而宿主从不使用图标。
 *
 * ⇒ 折中：registry 只持有 `logoClass`（两侧都要用），图标由客户端自己的
 * `PROVIDER_ICONS` 表按 id 提供，并由一条单测锁「两边 id 集合相等」。
 * 这样「新增 provider 忘记加图标」仍会**变红**，但不会把大字符串搬进宿主产物。
 */
export declare const PROVIDER_REGISTRY: readonly ProviderDescriptor[];
/** 按 id 取声明；未知返回 `undefined`（调用方决定报错措辞）。 */
export declare function descriptorOf(id: string): ProviderDescriptor | undefined;
/**
 * 派生出客户端 `CREDITS_CAPABILITIES` 的同形结构。
 *
 * ⚠️ 只拷贝**已声明**的可选字段（不用 `undefined` 占位）：既有断言用的是
 * `toEqual`，而 `toEqual` 会忽略 `undefined` 属性 —— 但显式写 `undefined`
 * 在快照/序列化场景下仍可能产生差异，保持"缺失即缺失"最安全。
 */
export declare function creditCapabilitiesOf(): Record<string, CreditsCapability>;
//# sourceMappingURL=provider-registry.d.ts.map