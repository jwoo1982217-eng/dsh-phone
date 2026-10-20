/**
 * configurable provider 目录项的入参（透传 dsh-llm 契约）。
 *
 * ⚠ 本插件**当前不再产生**这类注册（见模块头），保留该类型只是为了让
 * {@link AdapterRegisterTarget} 如实描述 dsh-llm 的接口形状。
 */
export interface ConfigurableProviderEntry {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: readonly string[];
}
/** {@link registerAdapterIdempotent} 的入参（透传 dsh-llm 契约）。 */
export interface AdapterRegisterTarget {
    registerConfigurableProviders(entries: readonly ConfigurableProviderEntry[]): unknown;
    registerAdapter(providers: readonly string[], adapter: unknown): unknown;
}
/**
 * dsh-llm 对 adapter 的最小形状契约（本文件只包 `stream`，其余方法原样透传）。
 */
export interface StreamCapableAdapter {
    stream(options: never): AsyncIterable<unknown>;
    [key: string]: unknown;
}
/**
 * 把适配器包上 **Token 记账**（issue「本地 Token 计数」第 1 期的单点接入）。
 *
 * ## 为什么要在这里包（而不是改 13 个适配器）
 *
 * 全部 provider 的注册都收敛到 {@link registerAdapterIdempotent} —— 在它内部
 * 包一层，一处代码覆盖全仓库，且**完全不碰各适配器的推理路径**。包装只做三件事：
 *
 * 1. 透传 `stream()` 产出的**每一个** chunk（逐帧 `yield`，不改内容、不改顺序）；
 * 2. 捕获 `type:'usage'` 的 chunk 写账本（usageReported = true）；
 * 3. 捕获抛错写账本（usageReported = false + error），然后**原样再抛**——
 *    记账绝不吞错、也绝不反噬推理（`recordTokenUsage` 自身也不抛）。
 *
 * ## 渠道判定
 *
 * `options` 上带网关的 `GATEWAY_CHANNEL_MARK`（`src/openai-gateway/channel.ts`
 * 打标）→ `gateway`，否则 `direct`。打标丢失只会保守记成 direct，不会错账
 * （见 channel.ts 模块头的退化分析）。
 *
 * ## provider / model 的取值
 *
 * - provider：注册时的 `providers[]`（路由名，与 UI 的 provider 一致）；
 * - model：`options.model`（wire 口径）。
 *
 * ## ⚠️ 为什么用 Proxy 而不是 `{ ...adapter }` 展开（真实缺陷，写完即被测试抓住）
 *
 * 适配器是 **class 实例**，`providerInfo` / `listModels` / `resolveModel` 等
 * 方法都在**原型**上。对象展开只拷贝自有可枚举属性 —— 实例字段会留下，
 * 但全部原型方法会被丢掉，于是 `listModels()` 变成 "not a function"，
 * Jet Hub 的模型目录整体失效。`Proxy` 的 get 陷阱把**一切属性访问**转给
 * 原适配器（含原型链），只有 `stream` 被截获替换 —— 语义是「同一个适配器，
 * 换了个带记账的 stream」，而不是「拷贝了一个看起来像的」。
 *
 * ⚠️ **重复注册分支不包**：重启竞态时保留的是**上一轮已包装的路由**（同一代码），
 * 对它再包一层只会造成双记。`try` 分支（新注册）才包装。
 */
export declare function wrapAdapterWithTokenLedger<T extends object>(providers: readonly string[], adapter: T): T;
/**
 * 包住一次流式调用的**记账骨架**（与 {@link wrapAdapterWithTokenLedger} 配套）。
 *
 * 独立成函数是为了能用假适配器做行为单测（不必起真实 provider）。
 *
 * 语义：
 * - 正常结束且没等到 usage ⇒ 记 `usageReported: false`（显示 `—` 不显示 0）；
 * - 流内出现过 usage（哪怕 0 token）⇒ 记 `usageReported: true`；
 * - 抛错 ⇒ 记失败行后**原样再抛**（记账不吞错）；
 * - `finally` 兜底记 `durationMs`（cancel/提前 return 也算一笔）。
 */
export declare function recordThroughStream(openStream: () => AsyncIterable<unknown>, meta: {
    channel: 'direct' | 'gateway';
    provider: string;
    model: string;
    startedAt: number;
}): AsyncIterable<unknown>;
/**
 * 幂等版的 `ctx.llm.registerAdapter`。
 *
 * ⚠ 重复场景下的行为：保留现有 adapter 路由（重启竞态，见模块头）。
 * ⚠ 返回 dsh-llm 的 handle（含 `.replace()`）——重复分支没有 handle 可还，
 * 返回 `undefined`；调用方若需要 replace 能力应保存成功路径的返回值。
 *
 * ## 顺带做 Token 记账包装
 *
 * ⚠ 成功路径注册的是**记账包装**（`wrapAdapterWithTokenLedger`），重复分支
 * **不再包一层**（上一轮已是包装后的路由，再包会双记）。
 *
 * ## 顺带做「已失效模型」剔除包装
 *
 * 本函数是**全部适配器**的唯一注册入口，故在这里统一包装，避免十四个
 * `registerXxxLlm` 各写一遍（见 `dead-model-store.ts` 模块头：为什么不能改用
 * 「远端目录比对」，以及为什么判据必须是**阳性证据**）。
 *
 * ⚠ 包装失败**不阻断注册** —— 它只是显示层的收敛，回退到原适配器即可，
 * 不能因为它挂掉导致整个 provider 起不来。
 *
 * ## ⚠ 两层包装的顺序（曾一度是语义性的，现已不敏感）
 *
 * 当前顺序是 **记账在内、剔除在外**：
 *
 * ```ts
 * withDeadModelPruning(providers, wrapAdapterWithTokenLedger(providers, adapter))
 * ```
 *
 * **历史**（值得记住，因为它是一类极易复发的缺陷）：`wrapAdapterWithTokenLedger`
 * 早先**只拦顶层 `stream`**，而 dsh-llm 的 `adapterStream` 走的是
 * `adapter.prepareCall(...)` 返回的 `adapterCall.stream(options)`
 *（`dsh-llm/lib/index.js`：`dispatch = (options) => adapterCall.stream(options)`），
 * **从不直接调用顶层 `adapter.stream`**。当时记账之所以生效，全靠各适配器的
 * `prepareCall` 恰好写成 `stream: (o) => this.stream(o)`、且 `this` 落在 Proxy 上
 * —— 一条**隐式依赖**：顺序写反（或任一适配器改成闭包引用）就**静默失效**。
 *
 * ⇒ 现已**显式包装 `prepareCall` 返回的 `call.stream`**（见
 * `wrapAdapterWithTokenLedger` 的注释），因此**两种顺序都能记账**，不再依赖
 * `this` 绑定链。顺序仍保持「记账在内」只是为了与既有注释/测试一致。
 *
 * ⚠️ 同根因的既有教训见 `src/dead-model-store.ts`：只包 `stream` 会让包装
 * **在生产环境完全不生效**（单测却全绿，因为直接调了 `proxy.stream`）。
 * **通用手法：别问「哪个成员被包了」，去 `node_modules` 读消费者的真实调用链。**
 *
 * 回归用例：`tests/unit/token-ledger-wiring.spec.ts` 的「两层包装的嵌套顺序」段
 *（按 dsh-llm 的 `prepareCall → call.stream` 真实路径驱动，含闭包式适配器用例）。
 */
/** 同时覆盖 SDK 的 prepareCall 和直接 stream；不改写或持久化旧消息形状。 */
export declare function wrapAdapterWithRotation<T extends object>(providers: readonly string[], adapter: T): T;
export declare function registerAdapterIdempotent(llm: AdapterRegisterTarget, providers: readonly string[], adapter: unknown, warn?: (message: string) => void, pruning?: {
    enabled?: boolean;
}): unknown;
//# sourceMappingURL=llm-register-compat.d.ts.map