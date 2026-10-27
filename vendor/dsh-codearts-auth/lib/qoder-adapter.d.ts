/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type QoderCredential } from './qoder.js';
import { type QoderInferMessage, type QoderInferTool } from './qoder-wasm.js';
import { type NativeSource } from './native-search-contract.js';
import { type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js';
import { type ImageRequestTarget } from './image-budget.js';
import { BILLING_BUSINESS_CODE, BILLING_BUSINESS_CODES, QUEUE_BUSINESS_CODE, QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError, queueDelayMs, type QueueInfo } from './model-queue.js';
/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export { BILLING_BUSINESS_CODE as QODER_BILLING_CODE, BILLING_BUSINESS_CODES as QODER_BILLING_CODES, QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE, QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError as parseQoderQueueError, queueDelayMs as qoderQueueDelayMs, type QueueInfo as QoderQueueInfo, };
/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export declare const PROVIDER = "qoder";
/**
 * 该模型在 UI 上可选的思考档位（复刻客户端 `gU()` 的行为）。
 *
 * 三条口径：
 * 1. `efforts` 原样取用（目录顺序保持 —— 官方客户端也按对象键序渲染）；
 * 2. `supportsDisable` 为真时**追加** `none`（即「关闭思考」）；
 *    客户端 `gU()`：`… || e.includes('none') ? e : [...e, 'none']`。
 * 3. 两者皆无 → 返回空数组，调用方**不声明 `reasoning`**
 *    （UI 显示「当前模型未提供推理等级」，对应 IDE 的「不支持」）。
 *
 * ⚠️ **`qmodel` / `qmodel_latest` 这类「有 `disabled` 但无 `efforts`」的模型
 * 会得到 `['none']`** —— 即只提供「关闭思考」一项。这是**远端事实**
 * （用户 2026-09-28 确认「上面两个没有思考档位就是关闭的意思」），
 * **不要**给它们补默认档位。
 */
export declare function qoderEffortsFor(model: QoderFallbackModel): string[];
/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export declare function buildQoderTools(tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}[] | undefined): QoderInferTool[];
/** {@link buildQoderHistory} 的入参：DSH 序列化后的 wire 消息（OpenAI 形态）。 */
interface QoderWireMessage {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
}
/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export declare function buildQoderHistory(messages: readonly QoderWireMessage[]): QoderInferMessage[];
/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
    /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
    credentialRef: CredentialRef;
    /** 从凭据存储解析凭据。 */
    resolveCredential: (modelId?: string) => Promise<QoderCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 多账号池（用于限流时切换账号与模型黑名单）。 */
    accountPool?: AccountPool;
    /**
     * 补齐凭据缺失的 **`uid`**（加密推理必需）。
     *
     * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
     * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
     * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
     * `Signature invalid (101)`（真实缺陷，用户报障）。
     *
     * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
     * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
     *
     * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
     */
    resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>;
    /**
     * 读取图片附件的原始字节（内联为 data URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
     * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
     *
     * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
     * 而不是抛错 —— 缩放是优化，不能因为"想缩图"把一次本来能成功的请求打死。
     * 判据与回退都在共享的 `projectRequestImage` 里（buddy / raccoon 用同一份）。
     *
     * 背景（issue !IKITT9）：qoder 撞的是**请求体体积**上限（实测 8 张原图能过、
     * 15 张 ≈57 MiB 直接 `TRANSPORT: fetch failed`），与腾讯的图片 token 预算
     * 是两种约束，但同样只能靠缩放解决。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link QODER}。 */
    product?: QoderProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 当前生效账号的 id（额度受限时用于**标记该账号**）。
     *
     * ⚠️ 做成**回调**而不是构造期常量：账号会在 `refreshAll` / 限流切换 /
     * Jet Hub 手动启停后变化，构造期快照会标记到**已经不再使用**的账号上。
     * 未提供时跳过标记（仍会尝试切号），不会因此崩。
     */
    currentAccountId?: () => string | undefined;
    /**
     * 注入的休眠实现（**测试用**）。
     *
     * 排队重试要真等（最长 10s × 180 次），单测不能真睡 —— 注入后即可断言
     * 「等了几次、每次多久」，并在毫秒级完成。
     */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /**
     * 「远端模型目录已落地」的回调。
     *
     * ⚠️ **必须由接线层注入 `broadcastCatalogChanged(ctx)`**（`registerQoderLlm`
     * 已代劳）：DSH 客户端把目录缓存在 `status === 'ready'` 即短路的 store 里，
     * 只有收到 `llm/adapters-updated` 才重读 ⇒ 远端目录异步落地后不广播，
     * 模型选择器会**永久**停留在冷启动那份兜底表上（`catalog-broadcast.ts` 记着
     * 这条真实症状：设置页 5 个模型、对话框只剩 2 个）。
     */
    onCatalogLoaded?: () => void;
    /**
     * 目录读取失败的告警出口（缺省静默）。
     *
     * ⚠️ 与「失败即回退兜底表」配套：回退是**静默**的，没有这条日志就没有
     * 任何证据表明上游目录取不到（只剩「倍率不更新」这种无信息的症状）。
     */
    warn?: (message: string) => void;
    /** 注入的时钟（测试用；缺省 `Date.now`）。 */
    now?: () => number;
    /**
     * 拉取**远端模型目录**（由接线层注入 `QoderAuth.fetchModels(pool)`）。
     *
     * ## ⚠️ 为什么是「注入一个取数函数」而不是适配器自己解析凭据
     *
     * 适配器手上的取凭据入口是 `resolveCredential`，而它**有副作用**：
     * 选中账号时会 `reportAccount(id)`（接线层据此维护「本次实际使用的账号」，
     * 供额度报错时标记）。目录请求是**周期性**的 —— 20 分钟刷新器可能在一次
     * 聊天请求选号之后跑到，把那个记录**改写成目录用的账号** ⇒ 额度标记落到
     * 无辜账号上（真实后果见 `index.ts` 的 `activeQoderAccountId` 注释）。
     *
     * 故与其余 11 家同形：由 auth 服务做**只读**取号 + 拉取，适配器只拿结果。
     *
     * 省略时**不发远端请求**（恒用兜底表）—— 纯测试/未接线场景的安全默认。
     */
    fetchRemoteModels?: () => Promise<readonly QoderFallbackModel[]>;
}
/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export declare class QoderAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /**
     * ⚠️ **2026-10-08 Task 7b：三个方法收敛到共享骨架** `createModelCatalog`。
     * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
     * 现在只剩 `toCatalogEntry`（本家私有形状 + 静态表判据 + 倍率格式）。
     */
    private readonly catalog;
    /**
     * **远端**模型目录缓存（成功拉取后保留 20 分钟）。
     *
     * ⚠️ 2026-10-20 前本家**恒用编译期兜底表**（一次远端请求都不发），
     * 上游改价/改免费额度/上下架模型都不会反映 —— 用户报障
     * 「DeepSeek-Flash 上游已经 0×（免费）了，插件还显示 0.1」。
     * 现在远端优先、兜底表只作回退（见 `src/qoder-catalog.ts`）。
     */
    private remoteModels;
    /**
     * 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ 与 `remoteModels` **并存**、不是替代：前者存「有哪些模型」，
     * 本字段存「何时读到的」（只有前者的目录永不刷新）。
     */
    private catalogAt;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
    private readonly catalogGate;
    /**
     * **静态兜底表专用**的第二套骨架（只在 `resolveModel` 的并集回退里用）。
     *
     * ⚠️ 存在的唯一理由：`resolveModel` 与 `listModels` 共用 `loadCatalog()`，
     * 而前者要「远端 ∪ 静态表」、后者要「远端独占」。故把静态表也包成一套
     * `ModelCatalog`，让**骨架自己的装配逻辑**（裸名/context/reasoning）
     * 复用到回退路径上，而不是在适配器里重写一遍。
     * `loadCatalog` / `syncCatalog` 都是同步静态表 ⇒ 零网络。
     */
    private readonly fallbackCatalog;
    constructor(options: QoderAdapterOptions);
    /**
     * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
     *
     * ⚠️ **必须响应 `signal`**：排队等待最长可达 30 分钟，用户中途取消会话时
     * 不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
     */
    private sleep;
    /**
     * 复用本适配器**同一套**选号编排解析凭据（供插件内部的原生搜索使用）。
     *
     * ## 为什么需要这个转发方法
     *
     * `options` 是构造器的 `private readonly`，插件其余模块从外部读
     * `adapter.options.resolveCredential` 会**编译失败**（`strict: true`）。
     * 而原生搜索**必须**与聊天链路用同一个 `resolveCredential` 实例 ——
     * 另建一份会让「enabled 过滤 / 模型级限流 / 免费判定 / 余额分档 / 池兜底 /
     * 账本回报」这六步在两条链路上漂移（与 `BuddyAdapter.resolveCredentialFor`
     * 同款理由）。
     *
     * ⚠️ `modelId` **必须透传**：它同时决定模型级限流过滤与免费判定，
     * 吞掉会让搜索选到聊天链路不会选的号（例如正在限流期的号）。
     *
     * @param modelId - 本次请求的模型 id（取自当前会话路由）。
     * @returns 选中账号的凭据；无可用账号时为 `undefined`。
     */
    resolveCredentialFor(modelId: string | undefined): Promise<QoderCredential | undefined>;
    /**
     * 原生搜索：执行**一次单 query**，返回投影成官方 `sources[]` 形态的结果。
     *
     * ## 协议（全部来自官方客户端源码 + 真机实测，2026-10-14）
     *
     * | 项 | 值 |
     * |---|---|
     * | host | 本产品的 `encryptedInferBase`（CN `gateway.qoder.com.cn`；国际实测 `center.qoder.sh` / `api2.qoder.sh` 均可） |
     * | path | `/api/v1/webSearch/oneSearch` |
     * | body | `{ payload: JSON.stringify({query, timeRange:'NoLimit', contents:{...}}), encodeVersion:'1' }` |
     * | 信封 | body 由 **WASM 加密**；请求头由 `prepareRequest` 生成（含 `Authorization: Bearer COSY.<载荷>.<签名>`） |
     * | 响应 | `{ requestId, pageItems: [{title, link, snippet, publishedTime, hostname, hostLogo}], searchInformation }` |
     *
     * 官方客户端对应实现（`qoder-worker-runtime` 的 `tPl` / `APl` / `$rA`）：
     * ```js
     * let n = i.prepareRequest(A, e, "POST", "auth", t, void 0)
     * return { url: n.url, headers: kc(n.headers), body: n.body ?? t, free: () => n.free() }
     * ```
     *
     * ## ⚠️ 三个必须遵守的点
     *
     * 1. **`QoderEncryptedInfer` 每次建、每次 `dispose()`**：`gluePromise` 是进程级
     *    单例，`QoderContext` 是 wasm 堆上的 Rust 对象，不释放会让堆只增不减，
     *    长上下文会话最终以裸 `RuntimeError: unreachable` 暴毙（真实事故史见
     *    `qoder-wasm.ts` 文件头）。用 `try/finally` 而非顺序调用。
     * 2. **`publishedTime` / `hostname` / `hostLogo` 一律丢弃**：官方 output schema
     *    有 `additionalProperties: false`，多传字段会让 `createSuccessResult` 抛
     *    `ToolOutputError`，**整条调用失败**（不是少一条结果）。
     *    ⚠️ **但 `publishedTime` 其实有对应字段**（PR95 审计修正）：官方
     *    `dsh-tool-web` 的 output schema 与 seam 的 `WebSearchSource` **都**声明了
     *    可选的 `publishedAt?: string`（语义就是「provider 给的发布时间戳」）。
     *    原注释把三个字段一锅端说成「schema 不允许」，那对 `hostname` /
     *    `hostLogo` 成立，对 `publishedTime` **不成立**。
     *    ⚠️ **本次仍照原样丢弃**：接它需要先确认 Qoder 的 `publishedTime` 确实是
     *    ISO-8601 字符串（seam 的类型注释如此声明，但我们**没有真机取证**），
     *    而接错的后果是整条调用失败（`ToolOutputError`）—— 收益（多一列时间）远
     *    小于风险。**待办**：取一次真实响应确认格式后再接。
     * 3. **`X-Session-ID` 用随机 UUID**：实测不传也能 200，但官方客户端会带；
     *    这里跟随官方行为。它与账号无关，只是会话标识。
     * 4. **自己 arm 一份 20s 预算**（PR95 审计修正）：只透传 `signal` 会让
     *    `NativeSearchCodes.timeout` / `aborted` 在本路径永不产生，而契约注释却
     *    声称「各适配器 20s 预算小于官方 30s」⇒ 注释与实现不符。
     *
     * @param query - 单个查询串（已由工具层 trim + 去重）。
     * @param credential - `resolveCredentialFor` 的返回值（本方法自己收窄）。
     * @param signal - 取消信号（工具层传多 query 的 batch signal）。
     */
    searchOnce(query: string, credential: unknown, signal: AbortSignal): Promise<NativeSource[]>;
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 按 id 取**当前**目录条目（远端优先，回退编译期兜底表）。
     *
     * ⚠️ **不能用构造期的静态索引**：只存在于远端的模型（如 `fast`）查静态表会得到
     * 「未知」，而本方法与 `stream()` 都把它当**能力判据**用 —— `accio` 记过同款教训
     * （把「未知」当「明确不支持」会让能力**静默变窄**：图片被拒、档位消失）。
     */
    /**
     * 按 id 取条目，供**能力/元数据**判据使用：**远端优先，未命中回退编译期兜底表**。
     *
     * ## ⚠️⚠️ 为什么必须是「两份目录的并集」，而不是只用远端
     *
     * 第一版把它写成 `catalogSource().find(...)`（远端落地后静态表完全不参与），
     * 被独立审计打穿（缺陷 1，已复现）：**远端目录是「按账号」下发的**，
     * 一个免费额度号只拿到 2 条；此时静态表里其它 15 条模型会被判成「未知」
     * ⇒ `inputModalitiesFor` 报 `['text']` ⇒ `stream()` **硬拒图片**
     * （`UNSUPPORTED_CONTENT`），同时 `resolveModel` 的 name 退化成裸 id、
     * `context`/`reasoning` 消失、请求体的 `display_name`/`max_input_tokens`/
     * `is_reasoning` 一并退化。
     *
     * | 场景 | 只查远端（第一版） | 并集（现行） |
     * |---|---|---|
     * | `dmodel` + 远端大目录 | ✅ | ✅ 远端优先 |
     * | `dmodel` + 远端只剩 2 条（免费号） | ❌ 硬拒图片 + 元数据退化 | ✅ 回退静态表 |
     * | `fast`（只在远端有） | ✅ | ✅ 远端命中 |
     *
     * ⚠️ **菜单（`listModels`）仍以远端为准** —— 这条并集只作用于
     * 「能力/元数据判据」，不改变「有哪些模型可选」。本仓同型铁律见
     * `docs/agent-notes/client-ui.md` 的「判『某个 id 在不在目录里』时两个目录
     * 来源必须取并集」（Issue IKJW33）：让**能力**判据取并集，让**可选项**保持单一来源。
     */
    private catalogModel;
    /**
     * 模型接受的输入模态。
     *
     * 按**模型**判定（目录条目的 `supportsImage`），不是按 provider 一刀切。
     * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会失败）。
     *
     * ⚠️ 判据取自 `catalogModel()`（**远端 ∪ 静态表**）—— 只取远端会让
     * 「按账号收缩的目录」把静态表里已知的模型判成未知（见该方法的表）。
     */
    private inputModalitiesFor;
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     *
     * ⚠️ **2026-10-08 Task 7b**：骨架（含上面这条理由）已上移到共享实现
     * `src/model-catalog.ts`，此处只剩委托。
     *
     * ⚠️ **2026-10-08 复审**：本方法上方原先还压着**一段无主的 JSDoc**
     * （以「模型目录。」开头、讲「Qoder 的模型列表端点需要 WASM 签名」）——
     * 它本来是某个已被删掉的方法的文档，删方法时留下了壳。
     * 它与紧邻的本块连在一起看像「同一个方法有两套互相矛盾的文档」。
     * 已删除。
     *
     * ⚠️ **那段旧文档里「恒用产品兜底表、不发网络请求」这句已于 2026-10-20 作废**：
     * 本家现在与其余 12 家同形 —— 远端优先（`src/qoder-catalog.ts`）、
     * 兜底表只作回退。见 `catalogSource()` 的注释。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 把本家目录条目（**远端优先**，回退兜底表）转成共享骨架的中间结构。
     *
     * ⚠️ 远端条目经 `src/qoder-catalog.ts` 归一成与兜底表**同形**的结构后才到这里
     * ⇒ 倍率/档位/能力三条判据对两条来源**完全同源**（不会出现「远端少了某个
     * 字段于是倍率不显示」这类分叉）。
     */
    private toCatalogEntry;
    /**
     * 该条目的思考档位。
     *
     * ⚠️ **`reasoning` 是「思考强度」选择器出现在模型菜单里的唯一入口**
     * （composer 读 `resolveModel().reasoning`）。此前本适配器**只声明了
     * `context`，从不声明 `reasoning`** → 中国版/国际版全都看不到档位选择器，
     * 尽管目录早已下发 `thinking_config`（用户报障「qoder中国版可以设置思考档位，
     * 我们应该按照他的设置给出可设置的档位选择」）。
     */
    private reasoningForEntry;
    /**
     * 目录来源：**远端优先**，未落地时回退编译期兜底表。
     *
     * ⚠️ 回退不是「优化」而是**必需**：纯插件用户（或上游目录接口故障时）
     * 若目录为空，DSH 的 `buildModelCatalog` 会把该 provider 判成「没有模型」
     * 而**整个隐藏**（`providerCatalogVisible` 之外的第二层门）。
     */
    private catalogSource;
    /** 同步视图（`listAllModels()` 与 `CatalogEntry` 转换共用）。 */
    private syncCatalogEntries;
    /** 编译期兜底表的条目视图（第二套骨架专用；同步、零网络）。 */
    private fallbackEntries;
    private loadCatalogEntries;
    /**
     * 懒加载远端模型目录（**每 20 分钟**一次；失败/空结果走闸门冷却）。
     *
     * 三条口径与其余 12 家逐字同构：
     * 1. 入口用 `isCatalogFreshFor`（多一条「用户刚改设置⇒立即失效」的正交腿）；
     * 2. 并发去重与失败冷却交给 `RemoteCatalogGate`（同一份实现，不自己写判据）；
     * 3. **只在成功时**记 `catalogAt`（失败也记会让一次网络抖动把 TTL 上界刷掉，
     *    下一轮要再等满 20 分钟才发现上游没恢复）。
     */
    private ensureRemoteModels;
    /**
     * 真发一次远端目录请求（失败返回空数组，由闸门记冷却）。
     *
     * ⚠️ **不在这里解析凭据**：取数是接线层注入的 `fetchRemoteModels`
     *（= `QoderAuth.fetchModels(pool)`），它只做池的**只读**读取。
     * 理由见 `QoderAdapterOptions.fetchRemoteModels` 的长注释
     *（走 `resolveCredential` 会把「本次实际使用的账号」改写成目录用的账号）。
     */
    private loadRemoteModels;
    private nowImpl;
    /**
     * ★ **后台目录刷新入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️⚠️ **必须显式转发** `catalog.refresh`：`ModelCatalog` 上的成员**不会**
     * 自动变成适配器的成员（`dead-model-store.ts` 的 `pruned()` Proxy 只透传
     * **适配器自己的**成员）。漏转发 ⇒ 刷新器「已武装」却对本家**空转**，
     * 且**零日志** —— 这条陷阱在 `accio-adapter.ts` 有逐字记录（`be42b25` 踩过）。
     * ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**续期）**不是同一件事**，
     * 两者同名纯属巧合，**不得合并**。
     */
    refresh(): Promise<void>;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 解析模型元信息（**能力/元数据的并集回退**，见 `catalogModel()` 的表）。
     *
     * ## ⚠️ 为什么这里要路由到两套目录
     *
     * `resolveModel` 与 `listModels` **共用** `loadCatalog()`，但两者的正确口径不同：
     * - `listModels`（**菜单**）必须**只**给当前账号真能用的模型 ⇒ 远端独占；
     * - `resolveModel`（**元数据**）必须认识「可能正在被使用、但不在当前账号菜单里」
     *   的模型（会话开着、目录随账号收缩）⇒ 远端 ∪ 静态表。
     *
     * 故：远端目录认识该 id 就照旧走它（新值优先）；不认识而静态表有，就交给
     * **静态表专用的第二个骨架实例** —— 复用骨架自己的装配逻辑（裸名 / context /
     * reasoning 三态），**不在这里重写一遍**（那会是同一语义的第二套判据）。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 额度受限时：**标记当前账号该模型受限到 UTC+8 当日 24:00，然后切下一个账号**。
     *
     * ## 用户要求（2026-09-27）
     *
     * > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
     * > （他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00 受限）
     * > 然后切换账号池中的下一个可用模型
     *
     * ## ⚠️ 与 buddy/CodeArts 的**关键差异**
     *
     * 它们的错误文案里**带重置时间**（`parseRateLimitError` 从中解析）；
     * Qoder **不带** —— 故这里用 {@link nextUtc8DayStartMs} **自己算**
     * 「UTC+8 当日 24:00」。**不能**复用 `parseRateLimitError`：它会因解析不到
     * 时间而退回「1 小时后」（`Date.now() + 3_600_000`），那对**按自然日**结算的
     * 额度是错的 —— 会让标记过早失效，用户 1 小时后再撞一次同样的墙。
     *
     * @param activeAccountId - **当前正在使用的**账号 id（见下）。
     * @returns 新凭据；无可用账号时 `undefined`（调用方如实抛出原错误）。
     */
    private switchAccountOnQuota;
    /**
     * 排队等待（HTTP 层与 SSE 层**共用**）。
     *
     * 两处形态必须走同一套判据，否则会再次出现「只修了一条路径」的缺陷。
     */
    private waitForQueue;
    /**
     * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
     *
     * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
     * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
     * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
     */
    private ensureUid;
    /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
    private sendEncrypted;
}
/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export declare function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean;
/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
export declare function qoderDisplayName(model: QoderFallbackModel, now?: Date): string;
/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `qoder`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export declare function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter;
//# sourceMappingURL=qoder-adapter.d.ts.map