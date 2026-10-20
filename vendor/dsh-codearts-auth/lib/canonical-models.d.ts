/**
 * 跨渠道模型**归一化**：把同一个真实模型在各 provider 下的不同 modelId / 不同
 * 展示名，收敛成一个「候选键」，供聚合 provider 归组。
 *
 * ## 为什么需要两张通道（id 与 name）
 *
 * 各 provider 的 modelId **不都是自描述的**：
 *
 * | provider | modelId | 展示名 | id 能认出模型吗 |
 * |---|---|---|---|
 * | buddy / codearts / lobsterai / opencode | `deepseek-v4.1-flash` | `Deepseek-V4.1-Flash` | ✅ |
 * | raccoon | `sn-glm-5-3` | `GLM-5-3 · x0.75` | ✅（剥 `sn-` 后） |
 * | **qoder / qodercn** | **`gfmodel`** | `GLM-5.3-Flash` | ❌ **内部代号** |
 * | trae | `DeepSeek-V4-Flash-Official` | 同左 | ✅ |
 *
 * qoder 那类必须靠**展示名**通道才能归组 —— 这是本设计要两张通道的原因。
 *
 * ## 仲裁规则：按 provider 声明**主通道**，不是两通道投票
 *
 * ⚠️ 实测（见本文件单测）：**展示名通道会错误合并 workbuddy 的
 * `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg`** —— 两者展示名逐字都是
 * `Deepseek-V4.1-Flash`，但 `-sg` 是新加坡区的**另一条通道**。若两通道投票或
 * 让 name 通道优先，这两个不同的东西会被并成一个虚拟模型，而请求只发往其中一个
 * ⇒ 用户以为在用新加坡区，实际打到了主区（静默错配）。
 *
 * ⇒ 规则：**按 provider 声明主通道**。只有 qoder / qodercn（id 是代号）声明为
 * `name`，其余全部 `id`。
 *
 * ⚠️ **「主通道算不出结果时才回落另一通道」的回落逻辑不在本模块**：本文件只提供
 * {@link channelOf} 这个「主通道是哪条」的判据，回落由 Task 2 的
 * `canonicalKeyFor` 负责（它才需要在归一化结果为空时改走另一条通道）。
 *
 * ## 保守方向：宁可漏合并，不可错合并
 *
 * - 日期快照（`-0731`）**不剥离** ⇒ 与无后缀版本分开；
 * - `-official` 后缀**不剥离** ⇒ 与无后缀版本分开；
 * - 归一化结果互不相同的候选**不合并**（各自成为一个虚拟模型，或都不归入）。
 *
 * 漏合并的代价是「同一个模型出现两条」，用户一眼能看出并手工关掉一条；
 * 错合并的代价是「请求打到了不是用户想要的那个模型」，且**没有任何提示**。
 *
 * @module src/canonical-models.ts
 */
/**
 * 抽象路由别名 —— **不是真实模型**，不参与归一化。
 *
 * 两个来源：
 * - workbuddy 的 `default-model` / `fast-model` / `balanced-model` /
 *   `primary-model` / `deep-model` 是**服务端抽象路由**（名字就叫 Auto / Fast /
 *   Balanced / Primary / Deep），由后端决定实际用哪个模型；
 * - qoder 系的 `auto` 是**客户端选模模式**，不是可指定调用的模型。
 *
 * ⚠️ 它们若参与归一化会变成若干「只有一个渠道」的虚拟模型，且语义上是空的
 * （用户选 `aggregate/default-model` 等于选了个我们无法保证语义的东西）。
 */
export declare const EXCLUDED_ALIASES: ReadonlySet<string>;
/** 该 provider 的归一化主通道；未声明者默认 `id`。 */
export declare function channelOf(provider: string): 'id' | 'name';
/**
 * 把一个模型 id 归一成候选键。
 *
 * 步骤（顺序有意为之）：
 * 1. **剥命名空间前缀**（取最后一个 `/` 之后）：`cline-free/x` → `x`；
 * 2. 去 `:free` 后缀；
 * 3. 剥 `sn-` 前缀（raccoon）；
 * 4. **所有点号转连字符**；
 * 5. 空格转连字符（展示名通道会用到）；
 * 6. 全小写。
 *
 * ⚠️ **第 4 步是「所有点号」而不是「版本号里的点号」**（初版写成
 * `/v(\d+)\.(\d+)/` 只匹配 `v4.1` 这种形态，**漏掉了 `6.8` / `k2.8` / `m2.7`
 * 等不带 `v` 的写法** ⇒ `sensenova-6.8-flash`、`kimi-k2.8-preview` 会带着点号
 * 留在键里，与 `CANONICAL_NAMES` 的键对不上）。全部转掉即可 —— 见下方「为什么
 * 全部转掉仍然安全」。
 *
 * ⚠️ **不剥** 4 位数字日期后缀（`-0731`）与 `-official`：见模块头「保守方向」。
 * ⚠️ 第 1 步用 `lastIndexOf`：`cline-free/x` 这类取最后一段即可。
 *
 * ## 为什么「所有点号转连字符」仍然安全
 *
 * 关键风险是「点号一转就把 `v4.1` 与 `v4` 混为一谈」。转连字符**不会**——
 * `deepseek-v4.1-flash` → `deepseek-v4-1-flash`，而 `deepseek-v4-flash` 里
 * 没有点号，保持 `deepseek-v4-flash`，两者**仍然不同**。真正会混淆的是
 * 「删掉点号」（`v41` vs `v4`），本函数不做那件事。
 */
export declare function normalizeModelKey(raw: string): string;
/**
 * 把一条**展示名**归一成候选键：先剥掉非模型信息，再走 {@link normalizeModelKey}。
 *
 * 要剥掉的东西（各家的展示名里都混着它们）：
 * - 倍率后缀 ` · x0.75` / ` · x0.2→x0.1`（raccoon / loomy 直接写在表里）；
 * - 「免费」标注（raccoon 的 `· 免费`、cline 的 ` · 免费`）。
 *
 * ⚠️ 只剥**第一个 `·` 之后**的全部内容：`·` 是倍率分隔符（U+00B7），在本仓库
 * 所有 provider 的展示名里都不作为模型名的一部分出现。
 *
 * ⚠️ 下面那条 `/免费/g` 是**独立于 `·` 规则**的一道闸门：它只对**不带 `·` 的裸
 * 「免费」**生效（`SenseNova-6.8-Flash 免费`）。带 `·` 的形态（`… · 免费`）其实
 * 已被上一行连同 ` · ` 一并剥掉，走不到这里 —— 两种输入在单测里各有一条断言守着。
 */
export declare function normalizeNameKey(name: string): string;
/**
 * 显式映射补丁：`provider → realId → 规范键`。
 *
 * ## 什么时候需要它
 *
 * 两个通道**都**给不出正确归属时才用。已知两类：
 *
 * 1. **id 是内部代号、展示名又不带版本号**（qoder 系的 `dfmodel` 展示名叫
 *    `DeepSeek-Flash`，同表的 `dmodel` 却叫 `DeepSeek-V4-Pro` —— 前者无法从
 *    展示名判断是 V4 还是 V4.1）；
 * 2. **id 与模型名完全无字面关系**（lobsterai 的远端专有 `deepseek-flash`
 *    实际是 `DeepSeek-V4.1-Flash`，而它兜底表里的 `deepseek-v4-flash` 是
 *    **另一代更旧的模型**）。
 *
 * ## ⚠️ 每条都必须有实测依据
 *
 * 本表**不得**凭名字相似猜测 —— 猜错会让请求打到错的模型，且无任何提示。
 * 未实测确认的条目**不要**加进来（宁可让它各自成一个单渠道虚拟模型）。
 * 实施时用 e2e 探针逐条核对（见设计文档 §11 的 O1/O2）。
 */
export declare const CANONICAL_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>>;
/**
 * 一个候选条目归入哪个规范键。
 *
 * 顺序（**不可调换**）：
 * 1. **排除集**（查 `realId`、`idKey`、**以及 `nameKey`**，见下）→ `undefined`；
 * 2. **显式补丁** → 补丁值（最高优先：它是人工实测结论，胜过任何推导）；
 * 3. **主通道**（`channelOf`）→ 归一化结果；
 * 4. 主通道算出的键与 realId 完全一致**且** provider 声明的是 `name` 通道时，
 *    说明 name 通道没提供信息 → 回落 id 通道。
 *
 * ## ⚠️ 排除集必须查**三条**候选键，不能只查 id
 *
 * 初版只查 `realId` / `idKey`。但 `name` 通道的 provider 可以用**展示名**算出键
 * —— 若某条目的展示名归一后落在排除集里（如展示名就叫 `Auto`）而它的 id 不是
 * `auto`，初版会**放行**它，于是产出一个 `key === 'auto'` 的虚拟模型，与
 * `AGGREGATE_AUTO_MODEL` **撞名**：用户会在模型选择器里看到两个 `auto`，
 * 且 DSH 的 `listModels` 会因 **id 重复**抛 `INVALID_CATALOG`（整个聚合 provider
 * 的目录直接不可用）。
 *
 * ⇒ 排除判定必须在**算出键之后**再做一次，而不是只看 id。
 * ⚠️ qoder 的 `auto` 恰好 `realId === 'auto'`，所以初版能挡住它 —— **这不代表
 * 初版是对的**：挡住它靠的是巧合（id 与展示名同形），换个 id 就漏。
 *
 * @returns `via` 标明归属来源，供面板标注 `⚠️补丁`（人工核查用）。
 */
export declare function canonicalKeyFor(provider: string, realId: string, realName: string): {
    key: string;
    via: 'id' | 'name' | 'patch';
} | undefined;
/** 规范键 → 展示名；未登记的回退为键本身（不编造）。 */
export declare function canonicalDisplayName(key: string): string;
//# sourceMappingURL=canonical-models.d.ts.map