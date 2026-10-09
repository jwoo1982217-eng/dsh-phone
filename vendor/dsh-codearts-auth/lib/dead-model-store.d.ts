/**
 * 「已失效模型」的**运行时实证**记录与剔除。
 *
 * ## 解决什么（真实报障，2026-10-05）
 *
 * 用户在 Jet Hub 选中 cline 的 `cline-free/deepseek-v4.1-flash`，每轮都失败：
 *
 * ```
 * cline: model not found HTTP_404
 * ```
 *
 * 账号、余额、网络都正常。该模型**已被 Cline 从 `free` 数组移除**，但模型列表里
 * 仍然显示它、并且仍然标着「免费」—— 用户拿到的是一个看着可用、一点就 404 的条目。
 *
 * 根因是各 provider 的**兜底模型表**（`product.fallbackModels` 等）是**编译期快照**，
 * 上游下架模型时它不会自己跟着变。
 *
 * ## ⚠️ 为什么不能用「远端目录里没有 ⇒ 已下架」来剔除
 *
 * 那个判据只在**远端完整权威**的 provider 上成立。本仓库的实际情况分三类：
 *
 * | Provider | 远端目录 | 目录比对是否可用 |
 * |---|---|---|
 * | cline | `recommended-models` 的 `free` 数组完整权威 | ✅ 可用（已在 `cline-models.ts` 修） |
 * | buddy / codebuddy / workbuddy | **已知残缺** | ❌ **会删掉可用模型** |
 * | qoder / qoder-cn | 无（端点需 WASM 签名） | ❌ 无数据可比对 |
 *
 * buddy 那一类是刻意反过来设计的：`reconcileWithFallback` **以兜底表为准**，
 * 因为插件 CLI token 只拿到 13 个内部别名、而 IDE 是 20 个（见 `buddy-adapter.ts`）。
 * 在那里做目录比对会把「你有权用、只是 CLI token 看不到」的模型删掉 ——
 * 作者已为此踩过一次（`product.ts` 里 `hy4-preview` 的补录注释）。
 *
 * ⇒ 唯一**跨 provider 安全**的判据是**阳性证据**：这个模型**真的**请求失败并返回
 * 「模型不存在」时，才把它记为失效。**不从残缺目录反推。**
 *
 * ## 行为
 *
 * 1. **记录**：适配器的 `stream()` 抛出的错误被判定为「模型已失效」时，
 *    按 `provider + modelId` 落盘到 `$DSH_HOME/jet-hub/dead-models.json`。
 * 2. **剔除**：此后该 provider 的 `listModels()` / `listAllModels()` 不再播报它。
 * 3. **过期**：记录带 TTL（默认 30 天）。上游若把模型重新上架，最多 30 天后自动
 *    回到列表 —— 因为已被剔除的模型用户**选不到**，不可能靠「再成功一次」自愈，
 *    只能靠过期回收。TTL 可用 `DSH_DEAD_MODEL_TTL_DAYS` 覆盖（0 = 永不过期）。
 *
 * ## 判据为什么必须保守
 *
 * 误判（把可用模型记成失效）会把一个好模型从列表里藏起来，且**用户无法自行恢复**
 * （见上：选不到 ⇒ 不可能再成功 ⇒ 记录不会清）。故：
 *
 * - 只认明确的「模型不存在」文案；
 * - 出现限流 / 额度 / 认证类关键词时**一律不记**（那些是账号问题，不是模型问题）；
 * - 错误码为 AUTH / QUOTA_EXCEEDED / RATE_LIMIT / MISSING_CREDENTIAL /
 *   PERMISSION_DENIED 时一律不记。
 *
 * ## 为什么落独立文档，而不是并进 `state.json`
 *
 * 同 `permanent-lock-store.ts` 记录的那类风险：`state.json` 是 **dsh home 级、
 * 全局共享**的（同机多个 profile 共用一份），而本插件的存储是**整体替换**语义 ——
 * 旧版本代码整体重写时会静默抹掉它不认识的字段。独立文档则无人争抢。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 独立文档的文件名（与 state.json 同目录）。 */
export declare const DEAD_MODELS_FILE = "dead-models.json";
/**
 * 判断一个错误是否构成「该模型已失效」的**阳性证据**。
 *
 * @param error - 适配器抛出的错误。
 * @returns true 仅当能确认模型本身不可用（而非账号 / 网络 / 参数问题）。
 */
export declare function isModelGoneError(error: unknown): boolean;
/**
 * 注入 ctx。
 *
 * 两个用途：**把日志接进 DSH 的 logger**，以及**复用同一份 home 解析**。
 * 不调用也能工作（退化为环境变量解析 + 不记日志），`index.ts` 的 apply 里
 * 调用一次即可 —— 且**必须在任何 `registerXxxLlm` 之前**。
 */
export declare function configureDeadModelStore(ctx: Context): void;
/**
 * 记录一个「已失效」模型。
 *
 * @param provider - provider id（`product.id`）。
 * @param modelId - 裸模型 id。
 * @param reason - 判据命中的错误文案（排查用）。
 * @returns true 表示这是**新**记录（此前未记过）。
 */
export declare function recordDeadModel(provider: string, modelId: string, reason?: string): boolean;
/** 取某 provider 的已失效模型 id 集合。 */
export declare function deadModelIdsFor(provider: string): ReadonlySet<string>;
/**
 * 移除失效记录 —— 这是用户**唯一的**自愈路径（`model.clearDead` 端点）。
 *
 * ⚠️ 不清理黑名单：`disabledModels` 是用户的**主动选择**，失效记录是系统推断，
 * 两者语义不同、必须分开清除（否则「重新显示」会顺带把用户特意关着的模型打开）。
 *
 * @param provider - 目标 provider。
 * @param modelId - 指定模型；省略则清空该 provider 的全部失效记录。
 * @returns 实际移除的条目数（0 = 本来就没有记录，属幂等）。
 */
export declare function clearDeadModels(provider: string, modelId?: string): number;
/** {@link withDeadModelPruning} 的可选行为。 */
export interface DeadModelPruningOptions {
    /**
     * 该 provider 是否**参与**失效模型机制（记录 + 过滤），默认 `true`。
     *
     * ⚠️ **聚合 provider 必须传 `false`**（真实缺陷，全分支终审 C2 + 审计轮次二补修）。
     *
     * ## 为什么聚合不该参与
     *
     * 本机制解决的是「各 provider 的**编译期兜底快照**跟不上上游下架」—— 快照不会
     * 自己变，故需要记下「这个 id 已失效」并在列表里剔除它。
     *
     * 但**聚合层的目录是动态推导的**：每个虚拟模型都来自各渠道**当前**的
     * `listModels()`，上游下架后下次推导自然消失。
     * ⇒ 它既**不需要记录**，也**不该被过滤** —— 过滤一个动态推导出来的目录没有任何
     * 正确用途（若某个虚拟键能推导出来，就说明有渠道当前正在广告它；若推导不出来，
     * 它压根不在目录里，过滤与否都一样）。
     *
     * ## ⚠️ 为什么必须是「完全不参与」而不是「只不记录」（本轮补修的残留面）
     *
     * 初版只跳过**记录**、仍保留**过滤**，留下一个真实缺口（审计轮次二实测证伪）：
     *
     * | 场景 | 后果 |
     * |---|---|
     * | **旧版本**（C2 修复前）跑过一次聚合，往表里写了 `aggregate` 维度的记录 | 该虚拟模型**仍被隐藏** |
     * | 恢复途径 | `model.clearDead` 的 UI 在设置页 provider 面板里，而客户端 `PROVIDERS` **没有 `aggregate`** ⇒ **本分支内没有任何 UI 能恢复**，只能手改 `dead-models.json` 或等 30 天 TTL |
     *
     * 实测（探针）：`dead-models.json` 里预置 `aggregate/m1` 后，经真实装配
     * （`withDeadModelPruning(['aggregate'], adapter, { enabled: false })`）
     * 的 `listModels` 返回 `['auto','m2']` —— `m1` 被隐藏。
     *
     * ⇒ 传 `false` 时本函数**直接返回原适配器**（不记录、也不过滤）。
     * 表里若已有历史遗留的 `aggregate` 记录，它们会被**忽略**（正是我们要的：
     * 那些记录语义上无意义，且无法在 UI 里清除）。
     */
    enabled?: boolean;
}
/**
 * 用「已失效模型」剔除包装一个适配器。
 *
 * 包装四处（其余原样透传）：
 *
 * - `listModels` —— 异步，等结果后过滤；
 * - `listAllModels` —— **必须保持同步**（`jet-hub-rpc` 的 `ModelCatalogSource`
 *   契约要求同步且消费者不 await，改成 async 会抛 `all is not iterable`）；
 * - `stream` —— 捕获迭代中抛出的错误，判定后记录，再原样抛出；
 * - **`prepareCall`** —— ⚠️ **这是生产环境唯一真正会走到的路径**（见下）。
 *
 * ## ⚠️⚠️ 为什么必须包 `prepareCall`（致命缺陷，2026-10-06 复审 !66 实测）
 *
 * 本仓库全部 14 个适配器的 `prepareCall` 都是这个形状：
 *
 * ```ts
 * async prepareCall(provider, model, signal) {
 *   return { model: await this.resolveModel(...), stream: (options) => this.stream(options) }
 * }
 * ```
 *
 * `prepareCall` 被 `bind` 到**原始对象**，故 `this` 是原对象，`this.stream` 拿到的是
 * **原始 stream** —— 完全绕过 Proxy 的 `stream` 拦截。而 dsh-llm 的两条运行时路径
 * **只走 prepareCall**：
 *
 * - `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` → `adapterCall.stream(options)`
 * - 同文件 `:1667` → `dispatch = (options) => adapterCall.stream(options)`
 *
 * ⇒ 只包 `stream` 时，**失效模型永远不会被记录**（实测确认）。
 *
 * ⚠️ **只包 `prepareCall` 本身也不够**：真实错误发生在 `call.stream(options)` 的
 * **迭代过程中**（dsh-llm `:1691` `iterator = dispatch(...)[Symbol.asyncIterator]()`，
 * `:1701` `iterator.next()`），不是 `prepareCall` 自己抛的。故必须包装
 * **返回的那个 `call.stream`**。
 *
 * @param providers - 该适配器注册的 provider id 列表。
 * @param adapter - 适配器实例。
 */
export declare function withDeadModelPruning<T extends object>(providers: readonly string[], adapter: T, options?: DeadModelPruningOptions): T;
//# sourceMappingURL=dead-model-store.d.ts.map