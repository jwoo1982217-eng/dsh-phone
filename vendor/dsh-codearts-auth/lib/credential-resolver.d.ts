/**
 * `resolveCredential` 的**共享编排** —— 每个 provider 每轮请求「选哪个账号、取哪份凭据」。
 *
 * ## 它消除什么（实测）
 *
 * `src/index.ts` 原有 **13 个** `resolveCredential` 闭包（共约 400 行）。
 * 本 Task 把其中 **12 个**收敛到本模块；**codearts 刻意排除**（理由见文末）。
 *
 * ### 骨架同构度（**实测**，不是估计）
 *
 * 把 13 个闭包按两种口径归一化后分组（抽块 → 去注释/空白 → 分组计数）：
 *
 * | 归一化口径 | 分组数 | 最大组 | 多成员组 |
 * |---|---|---|---|
 * | 严格（仅去注释与空白） | 13 | **1** | 无 |
 * | 宽松（再把 provider 常量 / 凭据类型名 / 选择器与解析器标识符折叠成占位符） | 10 | **3** | `3 + 2` |
 *
 * ⇒ **逐字同构的闭包一个都没有**（严格口径下 13 个各自成组）。
 * 宽松口径下最大同构组是 `raccoon / minimax / gemini`（3 家），
 * 次大组是 `qoder / qodercn`（2 家）—— 即「多成员组共 5 个成员」。
 * ⚠️ 任何「6 个逐字同构」的说法都与实测不符，不要沿用。
 *
 * ### ⚠️ 收益与代价（**实测**，别把它当「减少重复」的胜利）
 *
 * 规模（2026-10-08 实测，口径逐项标明）：
 * - `src/index.ts`：**总行数 2555 → 2438（净减 117）**、非空行 2493 → 2381（净减 112）
 *   —— 两者**差 5 行**，混用会得出错数，故分别列出；
 * - 本模块：**新增那一刻（`03acdeb`）396 行**；此后随复审修复增长
 *   （`0cba1a2` → 458、`adc953f` → 458、本段写成时已 464）。
 * ⚠️⚠️ **本模块的「当前行数」刻意不写死** —— 它随本文件每次增删而变，
 * 同一 Task 内已因「拿中途快照当当前值」复发 **3 次**。
 * ⇒ **要引用当前行数，先自己量**：`(Get-Content src/credential-resolver.ts).Count`
 *（或 `wc -l`）。别沿用任何注释里写的数字，包括这一行。
 * ⇒ 结论只依赖**结构性事实**：12 份 per-provider 配置**并不比**原来的闭包短，
 * 故本 Task 的收益是结构性的（见下），**不是**「减少重复」的行数胜利。
 *
 * 真正的收益只有三条（都是**结构性**的，不是行数）：
 *
 * 1. **单一分派点**：骨架顺序（免费短路 → 分档 → 池选号 → 回报 → 限流判定 → 兜底）
 *    此前是 12 份各自维护的**约定**，现在结构上无法被绕过；
 * 2. **不可绕过的顺序**：限流判定必须排在池取号**之后**、兜底**之前** ——
 *    这类「改一处漏一处」的顺序约定现在只有一处实现；
 * 3. 删掉 buddy 系那个**已被本模块取代的编排闭包**（约 90 行）——
 *    那才是本次唯一真实的去重。
 *
 * 代价（如实登记）：多一层间接；`reportPickedAccount` 这个开关**只**为钉住一个
 * 既有的不对称而存在（见该字段说明）；以及下面那处**无法消除的 `as`**。
 *
 * ⚠️ 因此**不要**为了「减少行数」再往本模块搬东西 —— 那只会加深代价。
 *
 * ### 四类骨架（本模块按它们参数化）
 *
 * | 骨架 | 家数 | 特征 |
 * |---|---|---|
 * | A 池选号 + 限流判定 + 单凭据回退 | 10 | raccoon / minimax / gemini / qoder / qodercn / cline / lobsterai / trae / buddy / workbuddy |
 * | B 池选号 + **自定义**兜底 + **刻意不判**限流 | 1 | zcode |
 * | C 余额分档（buddy 协议）+ 免费短路 + 锁定抛错 | 4 | buddy / workbuddy / lobsterai / trae |
 * | D 余额分档（loomy 协议，**不回落池**） | 1 | loomy |
 *
 * A 与 C 在同一家上首尾相接（buddy 系 = C 的编排 + A 的尾巴）。
 *
 * ## ⚠️ 骨架顺序**不可调整**（每一步都是修过的缺陷）
 *
 * ```
 * resolve(modelId)
 *   ├─ ① 有 balance 计划？ → 候选筛（enabled + 模型未受限）
 *   │      ├─ buddy 协议：免费短路 → 余额分档编排 → 锁定则**抛错，绝不回落**
 *   │      └─ loomy 协议：分档 select → 选中即取凭据（**不换号**）→ 锁定则抛错
 *   ├─ ② getAvailableAccount(id, modelId, tried)   ← ⚠️ modelId 必须透传
 *   │      └─ **loomy 不走这一步**（它旧闭包里没有池取号，加上就是行为变更）
 *   ├─ ③ reportAccount(池实际选中的账号 id | undefined)  ← 账本 + qoder/cline/zcode 标记
 *   ├─ ④ throwIfAllRateLimited(product, modelId)     ← 区分限流与没登录
 *   └─ ⑤ 兜底（读固定 ref / 调用方自定义）
 * ```
 *
 * 四条**不可省**的细节（每条都在现有代码里有注释或用例）：
 *
 * 1. **`modelId` 必须透传**给 `getAvailableAccount` —— 传空串会让模型级限流过滤
 *    整体短路（`if (modelId.length === 0) return true`），被标记限流的号仍会被选中，
 *    「换号」形同虚设（真实缺陷，`trae-model-id-selection.spec.ts`）。
 * 2. **`reportAccount` 的契约是「回报池的决策结果」**（未命中时也报 `undefined`）
 *    —— 策略放在回调里，见该字段的说明。
 * 3. **锁定抛错不得回落**（回落会让「锁定永久积分」形同虚设，用户明确要求报错）。
 * 4. **凭据解析（含形状校验）一律由调用方给** —— 本模块**不**自己做
 *    `JSON.parse`。裸 parse 会让 `{"foo":1}` 这种损坏凭据当成有效凭据返回，
 *    随后适配器的 `credential.access_token.length` 抛不可诊断的 TypeError
 *    （TRAE / LobsterAI 的注释记录了这条）。
 *
 * ## ⚠️ 为什么是「一个 `readCredential(ref)`」而不是「`resolveRaw` + `parseCredential`」
 *
 * 各 provider 已经有一个**共用**的按 ref 解析器（`resolveBuddyCredentialByRef` /
 * `resolveTraeCredentialByRef` / `resolveLobsteraiCredentialByRef` /
 * `resolveLoomyCredentialByRef`），**余额选择器也调它**。若本模块改收
 * 「resolveRaw + parseCredential」两个半截，同一份「解析 + 形状校验」判据就会出现
 * **两处实现**（选择器一处、本模块一处）—— 正是那些注释警告的「改一处漏一处」，
 * 也正是本 Task 要消除的东西。
 *
 * ⚠️ **各家的形状校验强度本就不一致，本 Task 逐字保留**（零行为变更）：
 * `resolveTraeCredentialByRef` / `resolveLobsteraiCredentialByRef` 校验
 * `access_token` 是字符串，而 buddy / loomy / qoder 系 / cline / raccoon /
 * minimax / gemini / zcode 的兜底是**裸 `JSON.parse`**。统一强度会改变行为
 * （把此前被接受的损坏凭据改成被拒），故不在本 Task 范围内。
 *
 * ## ⚠️ 为什么 codearts 不在本模块内（13 个里唯一未替换的一个）
 *
 * 三条**同时成立**的差异，任何一条都足以让它不能参数化：
 *
 * 1. **它没有任何回退读取**：其闭包只调 `getAvailableAccount`，没有
 *    「退到单凭据 ref」那一步。而 `CODEARTS_ACCESS_TOKEN` 自多账号改造起
 *    **不再被写入也不再被读取**（其闭包注释与 AGENTS.md 同）—— 纳进来会**新读**
 *    一个空 ref，属于真实行为变更；
 * 2. **它不收 `modelId`**（签名是 `() => Promise<…>`）：适配器传进来的模型
 *    在它这里没有落点，而本模块的骨架顺序与四条细节全部围绕 `modelId` 展开；
 * 3. **它刻意不做限流判定**（`getAvailableAccount('codearts', '')` 传空串，
 *    模型级限流压根不参与筛选）—— 故它既不会误报「限流」也不会误报「未登录」，
 *    给它接判定反而会改变既有行为（`ratelimit-misreport-behavior.spec.ts`
 *    有专门一条锁死这个现状）。
 */
import type { BuddyNoAccountReason, BuddySelectorLike } from './buddy-balance-selector.js';
import type { LoomyCandidateAccount, LoomyNoAccountReason, LoomySelectionResult } from './loomy-balance-selector.js';
import type { LoomyTierOptions } from './loomy-balance-rank.js';
/**
 * 编排用到的那部分账号池（**结构化**，便于单测注入替身）。
 *
 * ⚠️ 只声明真正读到的三个方法：`AccountPool` 天然满足本接口（既有调用点
 * 一行不用改），而单测不必构造整个池。
 *
 * ⚠️ `TCredential` **默认 `unknown`**：本模块不关心具体形状（形状校验是各家
 * `parseCredential` 的职责），各个调用点各自传自己的类型即可。默认值让既有测试桩
 * （它们只关心 `entry`）一行不用改。
 *
 * ⚠️ **刻意不写「几家」**：本句原写「**13 家**各自传自己的类型」，实测走本模块的
 * 只有 **12** 个调用点（`codearts` 的 `resolveCredential` 无 fallback 且不收
 * `modelId`，**刻意不纳入**本模块 —— 见 `AGENTS.md` 的抽象边界一节）。
 * 这类「家数」是**必然腐坏**的快照，同一 PR 里已在别处写错过多次
 * （`model-catalog.ts` 的未知模态名单 5 → 10 → 12）。
 * ⇒ 名单的权威是调用点本身，不是本注释。
 */
export interface ResolverPool<TCredential = unknown> {
    /** 列出该 provider 的**全部**账号（含已停用）。 */
    listAccountsByProvider(provider: string): ReadonlyArray<{
        id: string;
        credentialRef: string;
        enabled: boolean;
        modelRateLimits?: Record<string, number>;
    }>;
    /** 该 provider 是否处于「锁定永久积分」状态。 */
    orderForRequest?<T extends {
        id: string;
    }>(provider: string, candidates: readonly T[]): T[];
    withSelection?<T>(provider: string, select: () => Promise<T>): Promise<T>;
    requestCandidateAllowed?(entry: {
        id: string;
        credentialRef: string;
        enabled: boolean;
        modelRateLimits?: Record<string, number>;
    }, model: string): Promise<boolean>;
    rememberSelection?(provider: string, id: string): void;
    isRotationRequest?(provider: string): boolean;
    permanentLocked(provider: string): boolean;
    /** 取「当前最该用的一个账号」；`null` = 没有可用账号。 */
    getAvailableAccount(provider: string, modelId: string, excludeAccountIds?: ReadonlySet<string>): Promise<{
        entry: {
            id: string;
            credentialRef: string;
        };
        credential: TCredential;
    } | null>;
}
/** 注入的共享设施。 */
export interface CredentialResolverDeps<TCredential = unknown> {
    readonly pool: ResolverPool<TCredential>;
    /**
     * 回报「本笔请求解析出的账号」。
     *
     * ⚠️ **契约是「回报池的决策结果」**：池兜底未命中时**也会**以 `undefined`
     * 调用一次。各家对 `undefined` 的处理不同，故**策略放在回调里**
     * 而不是本模块里多开一个开关：
     *
     * - buddy / workbuddy / lobsterai / trae / raccoon / minimax / gemini：
     *   回调自己忽略 `undefined`（`if (accountId !== undefined) …`），
     *   与它们旧闭包「只在取到号时回报」逐字等价；
     * - qoder / qodercn / cline / zcode：`undefined` 是**有意义的事件** ——
     *   它要**清空**「本次实际使用的账号」标记（留着旧 id 会误伤无辜账号）。
     */
    readonly reportAccount?: (accountId: string | undefined) => void;
}
/**
 * loomy 选号器的**结构化**形状。
 *
 * ⚠️ 与 {@link BuddySelectorLike} 分开声明，不合并成一个「通用选号器」接口：
 * 两者的 `reason` 类型（`LoomyNoAccountReason` vs `BuddyNoAccountReason`）与
 * 余额语义（`dailyBalance` vs `expiring/permanent`）都不同。设计边界是
 * **抽象编排、不抽象协议** —— 强行合并会丢掉「今日赠送额度」这层语义。
 */
export interface LoomySelectorLike {
    select(candidates: readonly LoomyCandidateAccount[], options?: LoomyTierOptions & {
        preferOrder?: boolean;
    }): Promise<LoomySelectionResult>;
}
/**
 * **buddy 协议**的余额分档计划（buddy / workbuddy / lobsterai / trae 四家共用）。
 *
 * 编排本身直接复用 `pickBuddyAccount`（**已导出的共享实现**），本模块不再手写
 * 一份候选循环 —— 那正是本 Task 要消除的重复。
 */
export interface BuddyBalancePlan {
    readonly kind: 'buddy';
    readonly selector: BuddySelectorLike;
    /**
     * 锁定且无可用账号时的报错文案（各家不同，**必须由调用方逐字提供**）。
     *
     * ⚠️ 必须按 `reason.kind` 分三种报（与 loomy 同型缺陷）：把「余额查不到」
     * 报成「额度已用尽」，用户会去解锁或白等，而号其实有钱；
     * 把「凭据全坏」也报成「额度已用尽」同样是**自相矛盾**（分档刚证明它有钱）。
     */
    readonly lockedError: (reason: BuddyNoAccountReason) => Error;
    /**
     * 本次请求的模型是否**免费**（消耗 0 积分）。免费时**跳过**余额分档。
     *
     * ⚠️ 必须是**已确认**的免费：`true` 会跳过余额分档（即不受锁定约束），
     * 误判成免费会让付费模型绕开锁定、真烧掉永久积分。故判据在适配器里，
     * 只在能确认 0 积分时才返回 true。
     */
    readonly isFreeModel?: (modelId?: string) => Promise<boolean> | boolean;
    /**
     * 分档**选中账号**时是否回报 `reportAccount`。缺省 `true`。
     *
     * ⚠️ **这不是「正确行为」的开关，而是钉住既有的不对称**：buddy 与 workbuddy
     * 的旧闭包在「分档选中」那一支**没有**回报账本（只在池兜底那一支回报），
     * 而 lobsterai / trae 两支都回报。零行为变更要求原样保留，故由调用方声明。
     * 该不对称在生产里无害（四个适配器随后自己都会回报账本），但改掉它就是
     * 一次行为变更。
     */
    readonly reportPickedAccount?: boolean;
}
/**
 * **loomy 协议**的余额分档计划。
 *
 * ⚠️ 与 {@link BuddyBalancePlan} 的**关键差异**（本 Task 的裁定 3）：
 * loomy 的分档**自己就是完整的选号** —— 选中的账号凭据坏掉时它
 * **不换号、也不回落池**，直接退单凭据（旧闭包里根本没有池取号调用）。
 * 把它并进 `pickBuddyAccount` 会同时引入「换号重试」与「池兜底」两个行为变更。
 */
export interface LoomyBalancePlan {
    readonly kind: 'loomy';
    readonly selector: LoomySelectorLike;
    /** 锁定且无可用账号时的报错文案（与 buddy 同款要求：两种原因分开报）。 */
    readonly lockedError: (reason: LoomyNoAccountReason) => Error;
}
export type BalancePlan = BuddyBalancePlan | LoomyBalancePlan;
/** 池里没有可用账号时的**兜底**。 */
export type ResolverFallback<TCredential> = 
/** 读某个固定单凭据 ref（12 家里的 11 家）。 */
{
    readonly kind: 'ref';
    readonly refName: string;
}
/**
 * 交给调用方自己的兜底（**只有 zcode**）。
 *
 * ⚠️ 与 `ref` 分开是**必须**的：`zcode.current()` 会**再读一次账号池**
 * 且不看 `enabled` / 限流标记 —— 这正是它「不接限流判定也算对」的原因
 *（池被筛空时它照样返回凭据，故不会误报「未登录」）。把它当成
 * 「读某个 ref」会丢掉这层语义。
 */
 | {
    readonly kind: 'custom';
    readonly resolve: () => Promise<TCredential | undefined>;
};
/** 单家 provider 的配置。 */
export interface CredentialResolverConfig<TCredential> {
    readonly product: {
        readonly id: string;
        readonly displayName: string;
    };
    /**
     * 按 ref 解析凭据，**并做各家自己的形状校验**（返回 `undefined` 或抛错
     * 都表示该 ref 的凭据不可用）。
     *
     * ⚠️ 传的是各 provider **已有的那份解析器**（`resolveTraeCredentialByRef` 等）
     * —— 它同时是余额选择器用的那一份。**不要**在这里另写一个 `JSON.parse`：
     * 那会让同一判据出现两处实现（本模块存在的意义就是消除这种分叉）。
     *
     * ⚠️ **必传**（zcode 那份可以传一个恒返回 `undefined` 的实现，因为它的
     * `fallback.kind` 是 `custom`，永远不会被调用到 —— 但**不要**因此把本项改成
     * 可选：可选会让「忘了传」编译期无声通过，而那正是 TRAE 注释里记的坑）。
     */
    readonly readCredential: (refName: string) => Promise<TCredential | undefined>;
    /** 池里没有可用账号时退到哪里。 */
    readonly fallback: ResolverFallback<TCredential>;
    /**
     * 区分「全部账号被该模型限流」与「没登录」。
     *
     * ⚠️ **可选**，且缺省是「不判定」：zcode **刻意**不接这条 —— 其余各家的兜底
     * 读的是 Jet Hub 登录路径下从不被写入的 `*_ACCESS_TOKEN`，池被筛空必然降级成
     * 「请先登录」（真实缺陷 IKJOZ9）；而 zcode 的兜底 `current()` 会**再读一次
     * 账号池**，本就不会误报，加判定反而会把本来能跑通的一发变成硬失败。
     */
    readonly throwIfAllRateLimited?: (product: {
        id: string;
        displayName: string;
    }, modelId?: string) => void;
    /** 余额分档计划；缺省 ⇒ 纯池选号（骨架 A）。 */
    readonly balance?: BalancePlan;
}
/**
 * 造一个与适配器契约一致的 `resolveCredential`。
 *
 * @param modelId - 本次请求的模型 id；⚠️ 会被透传给 `getAvailableAccount`
 *   与 `isFreeModel`（不要吞掉）。
 */
export declare function createCredentialResolver<TCredential>(deps: CredentialResolverDeps<TCredential>, config: CredentialResolverConfig<TCredential>): (modelId?: string) => Promise<TCredential | undefined>;
//# sourceMappingURL=credential-resolver.d.ts.map