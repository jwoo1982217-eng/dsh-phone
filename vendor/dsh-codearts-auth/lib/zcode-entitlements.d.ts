/**
 * ZCode 的**按模型权益判据**（纯函数，零 IO、零 import 副作用）。
 *
 * ## 这个模块解决什么（真实缺陷，用户报障 2026-10-12）
 *
 * **用户报障原文**：
 *
 * > 智谱账号送的 8m 算力其中分为 5.3-3m 和 5.3flsh-5m，插件判断这个账号
 * > 没用完，就不会切换下一个账号使用……可否判定 plan 中的 token 是属于哪个
 * > 模型专属的
 *
 * **本机只读实测**（`scripts/probe-zcode-plan-buckets.mjs`，启用账号
 * `zcode-894618ad`，HTTP 200）：
 *
 * ```json
 * [bucket] show_name="GLM-5.3"        capabilities=["model:glm-5.3"]
 *          total_units=3000000        remaining_units=3000000
 * [bucket] show_name="GLM-5.3-Flash"  capabilities=["model:glm-5.3-flash"]
 *          total_units=5000000        remaining_units=5000000
 * ```
 *
 * ⇒ **8M = 3M + 5M，两个桶各带一个模型归属**，判据是上游直接下发的
 * `capabilities: ["model:<小写模型 id>"]`。
 *
 * ## 缺陷根因：全桶汇总把「某模型专属桶已尽」冲掉了
 *
 * 折算层（`aggregate-expiry.ts` 的 `zcodeExpiry`）的判据是**全桶汇总**的
 * `balance.remaining > 0` —— 它**不接收也不判断 modelId**。于是 GLM-5.3 的
 * 3M 烧光后，只要 Flash 的 5M 还在：
 *
 * | 层 | 行为 |
 * |---|---|
 * | 折算（`zcodeExpiry`） | `remaining = 5M > 0` ⇒ 该渠道「有额度、可用」 |
 * | 选型（auto / aggregate） | 该 zcode 仍进候选，可能被派发 **GLM-5.3** |
 * | 池的按模型过滤 | `modelRateLimits['GLM-5.3']` 仍是空的（**只有真撞墙后才写**）⇒ 过滤问不出东西 |
 * | 结果 | 请求发出 → 上游报额度用尽 → 才开始换号（用户看到的「不切换」） |
 *
 * ⚠ 这与 codearts benefit（免费额度）是**同源模式**，那里也是「额度耗尽写进
 * `modelRateLimits[modelId]`」（`llm-adapter.ts` 的三处 `updateModelRateLimit`）。
 * 差别在于：codearts 只能**事后**从错误报文里得知，而 zcode 的余额接口
 * **直接给出了按模型的余量** ⇒ 可以**事前**判定。
 *
 * ## ⚠⚠ 本模块只回答「这个模型在这个账号上还有额度吗」，不碰任何 IO
 *
 * 写池标记、切号、决策都在调用方（`zcode-adapter.ts` / `aggregate-expiry.ts`）。
 * 这样判据只有一份，且能被纯函数用例穷尽覆盖 —— 本仓库在「同一语义两套判据」
 * 上出过红线级事故（`buddy-growth.ts`）。
 */
import type { ZcodeBalanceBucket } from './zcode-upstream.js';
/**
 * 从一条 `capabilities` 项里取模型 id。
 *
 * 上游形状实测为 **`"model:<小写模型 id>"`**（如 `model:glm-5.3`）。
 *
 * ⚠ **前缀不匹配一律返回 `undefined`**（不猜、不宽容）：
 * `capabilities` 里将来可能加别的维度（如 `tool:web_search`），
 * 把它们当成模型名会产生一个**永远匹配不上任何 modelId 的桶**，
 * 后果是「该桶被忽略」—— 若那个桶其实是通用额度，就会误封账号。
 * 宁可漏判（不写标记）也不误判（封掉可用账号），这是本仓库的既定方向。
 *
 * @returns 小写模型 id；非 `model:` 前缀时 `undefined`。
 */
export declare function modelOfCapability(capability: string): string | undefined;
/**
 * 该桶**是否覆盖**指定模型。
 *
 * ## 三态语义（⚠ 这里的区分是刻意的，别合并）
 *
 * | 桶的 `capabilities` | 含义 | 是否覆盖 |
 * |---|---|---|
 * | 含 `model:<该模型>` | 明确专属该模型 | ✅ |
 * | 含别的 `model:*` | 明确专属**别的**模型 | ❌ |
 * | 缺失 / 空 / 无任何 `model:` 项 | **上游没说** ⇒ 视为通用桶 | ✅ |
 *
 * ⚠ **最后一格必须判「覆盖」**：赠送的通用额度（如 1 亿 token 的
 * `start-plan`）在实测里**不限定模型**，若把它当成「不覆盖任何模型」，
 * 一个**确实可用**的账号就会被判成「该模型已耗尽」而被误封 ——
 * 方向相反的两种错误里，误封可用账号代价更大（本仓库在
 * `isZcodeQuotaExhausted` 的 HTML 短路、`refreshable` 单向门上反复记过这条）。
 *
 * @param bucket - 一个额度桶。
 * @param modelId - 目标模型 id（**大小写不敏感**，上游 `capabilities` 用小写）。
 */
export declare function bucketCoversModel(bucket: ZcodeBalanceBucket, modelId: string): boolean;
/** 一个模型在某账号上的权益结论。 */
export interface ZcodeModelEntitlement {
    /** 该模型可用吗（至少有一个覆盖它的桶**明确**还有余额）。 */
    readonly usable: boolean;
    /**
     * 覆盖该模型的桶数。
     *
     * ⚠️ 调用方**必须**用它区分「确定已尽」与「证据不足」：
     * `bucketCount === 0` 表示**没有任何桶**声称承接这个模型 ——
     * 那是「不知道」，**不是**「已用尽」（见 {@link exhaustedModelsOf}）。
     */
    readonly bucketCount: number;
    /**
     * ★ 覆盖该模型的桶里，有多少个的**额度数值读不出来**
     *（`available_units` / `remaining_units` 缺失或非数字）。
     *
     * ## ⚠️⚠️ 为什么必须有这个计数（真实缺陷，对抗审计实测 2026-10-12）
     *
     * `zcode-upstream.ts` 的 `num()` **只认 `number`** —— 上游把额度下发成
     * `"3000000"`（字符串）时，两个字段都解析成 `undefined`。若判据按
     * 「`undefined` ⇒ 0 ⇒ 已尽」处理，就会给**所有**模型写持久标记 ⇒
     * **账号锁死到次日**（实测见 `scripts/verify-zcode-string-units.mjs`）。
     *
     * ⚠️ 这是我这次改动**放大**的后果：旧行为下同一字段问题只会让折算
     * 短暂 `UNUSABLE`（下一轮自愈），现在会写持久标记。
     *
     * ⇒ 调用方见到 `unreadableBuckets > 0` 且 `!usable` 时**不得判定已尽**
     *（见 {@link exhaustedModelsOf}）：证据不足，宁可漏判不可误封。
     */
    readonly unreadableBuckets: number;
}
/**
 * 判定**某个模型**在这个账号上还有没有额度。
 *
 * ## 判据
 *
 * 覆盖该模型（{@link bucketCoversModel}）的桶里，**任意一个**额度
 * **明确** `> 0` ⇒ `usable: true`。
 *
 * ## ⚠ 为什么是「任意一个 > 0」而不是「汇总 > 0」
 *
 * 因为「汇总」正是本缺陷的成因。这两个判据在**单桶**场景下等价，
 * 只在多桶且覆盖同一模型时才有差别 —— 而那正是实测形态
 * （3M 的 GLM-5.3 专属桶 + 通用赠送桶同时覆盖 `glm-5.3`）；
 * 这里取「任意一个还有」，语义是「上游还有任何一份额度能承接这个模型」，
 * 通用桶还有余额时**不会**因为专属桶见底就误封。
 *
 * ⚠️ **`buckets` 为空 ⇒ `usable: false` 且 `bucketCount: 0`** ——
 * 调用方据此判「证据不足」而不是「已尽」（见 {@link exhaustedModelsOf}）。
 *
 * ⚠️ 「额度读不出来」的桶计入 {@link ZcodeModelEntitlement.unreadableBuckets}
 * 而**不算**「已尽」—— 见那里的长注释（防「字符串字段 ⇒ 误封整天」）。
 */
export declare function entitlementForModel(buckets: readonly ZcodeBalanceBucket[], modelId: string): ZcodeModelEntitlement;
/**
 * 从一次余额查询判定「某单个模型可不可用」的导出函数**刻意不存在**（记下来免得后人再加）。
 *
 * 初版曾写过一个做「未知 vs 确定已尽」三态区分的导出函数，并给它配了 5 条用例
 * （全绿）—— 但**反向验证实测它零生产调用方**：生产路径（`zcodeExpiry`）需要的是
 * 「**这个账号上哪些模型已尽**」（一次算全部），而那是 {@link exhaustedModelsOf}；
 * 「单个模型可不可用」在生产上**没有第二个问法**。
 *
 * ⚠️ 留着一个没人调的「安全判定」比没有更糟：它的注释会读起来像关键防线
 *（「只在拿到正向证据时才回 false」），而真正在生效的守卫是
 * {@link exhaustedModelsOf} 里的 `facts.bucketCount > 0` 那一格。
 * 这正是本仓库记过的「**登记了一处例外 ≠ 这处例外有守卫**」的同型陷阱 ——
 * 用例全绿只证明那个函数是对的，**不证明它被调用**。
 */
/**
 * 列出这个账号里**明确已用尽**的模型（返回的就是**目录形态**的 id）。
 *
 * ## ⚠⚠ 判据**只有一份**：逐模型调 {@link entitlementForModel}
 *
 * 本函数**不另写一套判据**，而是对每个候选模型复用同一个
 * `entitlementForModel`（「覆盖它的桶里是否还有余额」）——
 * 因为「哪些模型已尽」与「这个模型能不能用」是**同一个问题**的两种问法。
 * 本仓库在「同一语义两套判据」上有红线级事故史（`buddy-growth.ts`），
 * 故这里刻意不自己算一遍。
 *
 * ## ★ 大小写问题在这里**天然不存在**（别再加一道归一化 —— 加过，是死代码）
 *
 * 实测两侧大小写不同（上游 `capabilities` 是 `model:glm-5.3` **小写**，
 * 目录 id 是 `GLM-5.3` **大写**），但本函数的三个环节各自已经处理掉了：
 *
 * | 环节 | 怎么处理 |
 * |---|---|
 * | 解析 `capabilities` | `modelOfCapability` 把模型 id **统一小写**输出 |
 * | 比对 | `bucketCoversModel` 把**两边都小写**再比 ⇒ 大小写不敏感 |
 * | 产出 | 直接回**传进来的** `catalogIds` 元素 ⇒ 天然是目录形态 |
 *
 * ⇒ 返回的键**必定**能被 `a.modelRateLimits[modelId]` 精确命中。
 * ⚠️ 初版曾额外写一个「大小写归一化」导出函数专门做这件事，**反向验证时实测它
 * 零生产调用方**（上面三格已覆盖）⇒ 已删除。**别再加回来**：那会是一份没有读者、
 * 却看起来像「关键防线」的代码（本仓库对「看起来有守卫」的假防线有明确警戒）。
 * ⚠️ **别在注释里写出已删符号的名字**（本段初版正是那么写的，已改）——
 * 它会让「该符号应不存在」这类 grep 判据失效（`AGENTS.md` 的注释级陷阱）。
 *
 * ## 为什么是「列出全部」而不是「判某一个是哪个」
 *
 * 调用方（`zcodeExpiry`）在选型时被问的是「这个渠道还能不能用」，
 * 它**不知道用户下次要用哪个模型**。故一次性把所有已尽的模型都算出来，
 * 覆盖面最全，且**一次余额查询就算完所有模型**（不额外发请求）。
 *
 * ## ⚠⚠ 通用桶**必须参与**（用户明确要求，别照「只看专属桶」的直觉写）
 *
 * **用户报障原文**（2026-10-12）：
 *
 * > 同时要兼容之前除了 8M 的 2 种模型的专用 tokens 外还有赠送的 1 亿 token
 * > 专用的用光了赠送的还在也不切换
 *
 * ⇒ 语义是**取并集**：「专属额度」与「赠送的通用额度」都能承接同一个模型，
 * 必须**两边都见底**才判该模型已尽。落到判据上就是
 * {@link entitlementForModel} 的「覆盖该模型的桶里任意一个还有余额」——
 * 通用桶覆盖一切，故它还有余额时**任何**模型都不会被判已尽。
 *
 * 反例（若错写成「只看专属桶」）：GLM-5.3 的 3M 专属桶烧光、但赠送的 1 亿
 * 通用额度还在 ⇒ 请求**本来能成功**（上游按 `priority` 回落），
 * 却被我们本地标记成「GLM-5.3 已尽」⇒ **误封一个可用账号**到次日 0 点。
 *
 * ## 一个必须保守的边界
 *
 * **`bucketCount === 0`（无任何桶覆盖该模型）⇒ 不列**：可能是「这账号确实
 * 没有该模型权益」（如 `GLM-5.2` / `GLM-5-Turbo` 在本机账号上没有专属桶），
 * 也可能是上游字段漂移。两者都不该由我们在本地**持久**判死 ——
 * 交给上游在请求时如实拒绝（秒回空 ⇒ 走既有 `isFastEntitlementMiss` 切号）。
 *
 * @param buckets - 该账号的全部额度桶。
 * @param catalogIds - 该渠道的目录模型 id（**判定范围**与**返回形态**都用它）。
 *   ⚠️ 空串 / **纯空白**的项一律跳过（见下方说明），故调用方不必先过滤。
 * @returns 确定已尽的目录模型 id 列表（保 `catalogIds` 的顺序、已去重）。
 */
export declare function exhaustedModelsOf(buckets: readonly ZcodeBalanceBucket[], catalogIds: readonly string[]): string[];
/**
 * 列出这个账号里**明确仍有额度**的模型（即「应当清除已尽标记」的那些）。
 *
 * ## ⚠️⚠️ 为什么必须有它（真实缺陷 —— 本轮修复自己引入的回归）
 *
 * 只写标记、**从不清除**，会把标记变成**单向门**：zcode 的免费额度按自然日结算，
 * 而用户**当天**烧光后去面板签到、又领到额度（或上游调整、或换了通用桶）时，
 * 标记仍挂在池里到 UTC+8 次日 0 点 ⇒
 *
 * > 「签到成功了，但这个模型当天还是用不了」—— 用户会认为签到没用/插件坏了。
 *
 * ⚠️ 实测确认过（`scripts/verify-zcode-mark-after-claim.mjs`）：
 * `credits.claimAll` 成功只清**折算缓存**（`clearExpiryCache`），
 * **不清 `modelRateLimits`** ⇒ 光靠签到路径救不回来。
 *
 * ⚠️ 本仓库对「单向门」有明确的事故史（`refreshable` 被当过滤条件用，
 * 一次瞬时失败把账号永久标死）⇒ 判据必须支持**自愈**，不能只靠到点过期。
 *
 * ## 判据：与写标记**同源**（调同一个 {@link entitlementForModel}）
 *
 * 返回「`bucketCount > 0` **且** `usable === true`」的模型 —— 即
 * **明确查到它有额度**的那些。与 {@link exhaustedModelsOf} 恰好互补：
 *
 * | 情形 | `exhausted` | `recovered` |
 * |---|---|---|
 * | 有覆盖桶且全部见底 | ✅ 收录 | ❌ |
 * | 有覆盖桶且至少一个有余额 | ❌ | ✅ 收录 |
 * | `bucketCount === 0`（证据不足，如 `GLM-5.2`） | ❌ | ❌ **两边都不动** |
 *
 * ⚠️ **最后一格是刻意的**：证据不足时**既不写也不清** ——
 * 清除需要正向证据，猜「它可用」同样会误判（与写标记的保守方向一致）。
 *
 * ⚠️ 调用方只应清除**确实已被标记**的那些（本函数不知道池里有什么标记）。
 * 池侧的 `clearModelsExhaustedForExpiry` 自己判断（它返回 `Promise<void>`，
 * 内部对「键不存在 / 不是本机制写的」直接跳过）。
 * ⚠️ 别把它与 `clearModelRateLimits`（那个**确实**返回清除条数）混为一谈 ——
 * 两者参数与语义都不同，本仓库把这类「注释里的跨函数事实漂移」列为警戒项。
 *
 * @param buckets - 该账号的全部额度桶。
 * @param catalogIds - 该渠道的目录模型 id（**判定范围**与**返回形态**都用它）。
 * @returns 明确仍有额度的目录模型 id 列表（保 `catalogIds` 顺序、已去重、跳过空白 id）。
 */
export declare function recoveredModelsOf(buckets: readonly ZcodeBalanceBucket[], catalogIds: readonly string[]): string[];
//# sourceMappingURL=zcode-entitlements.d.ts.map