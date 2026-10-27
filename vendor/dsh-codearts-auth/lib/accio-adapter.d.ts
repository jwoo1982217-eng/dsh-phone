/**
 * Accio（阿里 Accio Work）LLM 适配器。
 *
 * 骨架取自 `src/trae-adapter.ts` / `src/lobsterai-adapter.ts`（`LlmAdapter` 子类 +
 * `createModelCatalog` 共享目录骨架 + `prepareCall` 包装），但**协议层完全不同**：
 *
 * | 项 | Accio | Trae / LobsterAI |
 * |---|---|---|
 * | 信封 | Gemini 风格（`contents` / `parts` / `system_instruction`），键 **snake_case** | OpenAI 风格 |
 * | 鉴权 | **token 在 body**（放 `Authorization` 头恒流内 402） | Bearer / Cloud-IDE-JWT |
 * | 响应 | 顶层 `content.parts[]` + `thought` 标记 | OpenAI SSE / SOLO 自定义事件 |
 * | 签名 | **不需要**（实测不带 `pctb-x-*` 同样 200） | 无 / WASM 加密 |
 *
 * ## 复用边界
 *
 * - 帧归一化与消费：`src/accio-messages.ts` 的 `consumeAccioSse`（内部复用
 *   `consumeGeminiSse`）。本文件**不重写** SSE 解析。
 * - 目录解析：`normalizeAccioModel` / `parseAccioCatalog` 的**唯一实现**在
 *   `src/accio-auth.ts`，本文件只 `import` 并**再导出**（兼容导入路径）——
 *   「同一语义两套判据」是本仓库首条红线。
 *
 * ## ⚠️ 三处**实测**修正（2026-10-13，真实凭据，唯一变量对照）
 *
 * 1. **`system_instruction` 必须是字符串**（⚠️ **源头已修**，本条只留作背景）。
 *    `buildAccioBody` **初版**产出 Gemini 风格对象 `{parts:[{text}]}`，实测**恒**回
 *    `HTTP 200 + 流内 {"error_code":"400","error_message":"Invalid request format"}`；
 *    同一文本改成字符串则 200。官方客户端 proto 里该字段本就是 `string`。
 *    ⚠️ 该纯函数已由 **commit `3034d03`** 修正为直接产出**字符串**，
 *    `tests/unit/accio-product.spec.ts` 也同步锁定**字符串**形态。
 *    ⇒ {@link AccioAdapter.stream} 里对 `system_instruction` 的改写**保留为
 *    纵深防御**（不改写也正确；把「wire 上该键必为字符串」这条硬约束显式写在
 *    适配器里，纯函数或上游形状若再次漂移仍能兜住）。**刻意不删。**
 *
 * 2. **工具调用是分片的，且共享消费者不合并**。上游把**一次**调用拆成多帧
 *    （首帧 `{id,name}` 无参数，后续帧**重复完整的** `args_json`）。
 *    `consumeAccioSse` 对每个 `functionCall` part 各产出一个**独立**的
 *    tool-call 块 ⇒ 一次调用会变成 N 个块（首个参数 `{}`），harness 会
 *    **执行 N 次**。合并职责归适配器（设计如此）⇒ 见
 *    {@link accioToolCallMergeTransform}。
 *
 * 3. **思考关不掉**。`includeThoughts` / `thinkingBudget` / `thinkingLevel` /
 *    `reasoningEffort` 四类字段逐格实测：思考字符数**一个都没变**
 *    （`reasoningEffort=off` 甚至回 505）。⇒ 会话命名只能走
 *    `planSessionTitleThinking` 的**抬预算**兜底（issue IKKVDH）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type CatalogEntry } from './model-catalog.js';
import { type AccioFallbackModel, type AccioProduct } from './accio-product.js';
import { type AccioCredential } from './accio.js';
import { normalizeAccioModel, parseAccioCatalog } from './accio-auth.js';
export { normalizeAccioModel, parseAccioCatalog };
/** 本适配器注册的 provider 路由名。 */
export declare const ACCIO_PROVIDER = "accio";
/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ 与 `ACCIO_REQUEST_TIMEOUT_MS`（30s，整个请求的上限）**不是一回事**：
 * 这里是「多久没有新字节就认定流卡死」。上游生成大工具参数期间可能长时间不
 * flush，裸 `reader.read()` 会无限期挂起（症状「发消息后永远转圈」）。
 * 归 `TIMEOUT`（可重试）。
 */
export declare const ACCIO_SSE_IDLE_TIMEOUT_MS = 120000;
/**
 * 把 `modelDisplayName` 与**计费倍率**拼成展示名：`模型名 · x倍率`。
 *
 * ## 为什么倍率必须进 `name`（不是 `description`）
 *
 * composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读）——
 * 倍率写进 description 等于没写。倍率跨度 0.013 ~ 2.8（**215 倍**），
 * 是用户选型时最重要的信号。
 *
 * ## 三条边界
 *
 * - **倍率 1 照拼**（`1` 不是「无」）；
 * - **倍率 0 照拼**（免费是**合法**倍率，与「没有倍率信息」语义不同，
 *   故判据必须是 `!== undefined` 而不是真值判断）；
 * - **非有限值不拼**（不产出 `xNaN` / `xInfinity`）。
 *
 * 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`。
 */
export declare function displayNameOfAccioModel(model: {
    name: string;
    multiple?: number;
}): string;
/**
 * 把一个 accio 模型条目映射成 DSH 的**思考档位声明**；无可声明时返回 `undefined`。
 *
 * ## ⚠️ 核心判据：`efforts` 为空但 `defaultEffort` 有值时，也要**声明一档**
 *
 * 用户要求原文：「需要有档位**即使是只有一档也要显示**，使用远端真实下发的档位」。
 *
 * 远端实测（38 条）：只有 7 条给了 `reasoningEfforts` 数组；而 **5 条只给了
 * `defaultReasoningEffort`、数组是 `null`**（GLM-5.3 `max` / GLM-5.2 `max` /
 * GLM 5.3 Flash `max` / DeepSeek V4.1 Flash `high` / DeepSeek V4 Pro `high` /
 * MiniMax M3 `adaptive`）。⚠️ 这几个的 default **实测发过去服务端接受**
 * （`max` 与 `adaptive` 都 ✅ 返回正常正文）⇒ 它就是一个**真实可用的档位**。
 *
 * ⇒ 三格判据（**顺序不可换**）：
 *
 * | 形态 | 声明 |
 * |---|---|
 * | `efforts` 非空 | 全部档位；`defaultEffort` **落在集合内才带**（DSH 会校验，指到集合外会抛 `UNSUPPORTED_REASONING_EFFORT`） |
 * | `efforts` 空、`defaultEffort` 有值 | **单档**（就声明那一个） |
 * | 两者都无 | **不声明**（`undefined`）—— 编造档位 = 让用户选一个服务端不认的值 |
 *
 * ## 显示名
 *
 * ⚠️ **原样用上游的档位 id 当 `name`**，不做「low→低」这类翻译：
 * - 这些 id 是**服务端认的字面量**（要原样回发），译成中文会让用户
 *   在排查时对不上日志；
 * - 本仓库既有先例：`cline` 的档位用 `CLINE_REASONING_EFFORTS` 的**固定英文名**
 *   （`Low` / `Medium` / …）—— 名字属于**展示层契约**，而 accio 的 id 本身
 *   已经是可读英文，无需再造一份映射表（造了就有「两处判据」腐坏风险）。
 */
export declare function accioReasoningOf(model: Pick<AccioFallbackModel, 'efforts' | 'defaultEffort'>): NonNullable<CatalogEntry['reasoning']> | undefined;
/**
 * 一个 accio 模型条目的**对外 id**（DSH 目录里的 `id`，也是注入给模型的身份）。
 *
 * ## 为什么必须是「人话」（用户要求，2026-10-13）
 *
 * 用户追问（附模型自报截图）：「为什么现在还是回复中的模型不是标准模型 id」。
 *
 * 上游 `modelCode` 形如 `1Drift-F8hS3mK7pL2n` —— **故意不可读**的内部代号，
 * 真名只在 `modelDisplayName` 里。而 DSH 把 `CatalogEntry.id` 注入给模型当身份
 * ⇒ 模型只能自报一串乱码（它自己也无从知道那是哪个基座）。
 *
 * ⇒ 对外 id 改用**展示名归一后的 slug**（`qwen-3-8-flash`）。
 *
 * ## ⚠️ 与聚合**共用同一套归一规则**
 *
 * 用 `normalizeNameKey`（`canonical-models.ts`），**不自己写第二份**：
 * 聚合的规范键就是这么算的，两处若各写一份必然漂移 —— 而漂移的后果是
 * 「直连看到的 id」与「聚合里的键」对不上，用户无法把两处对应起来。
 *
 * ## ⚠️ 兜底：归一后为空时回退原始 id
 *
 * 展示名可能是空白 / 只由分隔符组成（`'·'`）⇒ 归一后得空串 ⇒ 若原样返回，
 * DSH 的目录校验会因**空 id** 抛 `INVALID_CATALOG`，**整个 provider 不可用**。
 * ⇒ 宁可回退成一个不可读但非空的 id（与改造前行为一致），也不产出空串。
 */
export declare function accioModelIdOf(model: Pick<AccioFallbackModel, 'id' | 'name'>): string;
/**
 * 由**对外 slug** 反查上游 `modelCode`（上行请求必须用它）；查不到则**原样返回**。
 *
 * ⚠️ **上行绝不能发 slug**：Accio 的推理端点只认 `modelCode`，发 slug 会请求打空，
 * 而症状是「模型不回复」这种极具误导性的形态。
 *
 * ⚠️ **查不到时原样返回入参**（不抛错、不返回空串）：
 * - 用户可能手填一个 id（DSH 允许），此时应由**上游**报错，而不是在这里
 *   静默变成空模型名（那会让请求发到一个空 `model` 字段）；
 * - 抛错则会把这个未知 id 变成一次**本地失败**，掩盖上游的真实错误信息。
 */
export declare function accioModelCodeOf(models: readonly Pick<AccioFallbackModel, 'id' | 'name'>[], slug: string): string;
/** 解析 `AccioAdapter` 的构造选项。 */
export interface AccioAdapterOptions {
    /**
     * 解析本轮要用的凭据。
     *
     * ⚠️ 入参是**本轮要用的模型 id**：多账号池的选号会按它过滤限流账号，
     * 传空串会让限流过滤整体短路（与 `TraeAdapterOptions.resolveCredential` 同因）。
     */
    resolveCredential: (modelId?: string) => Promise<AccioCredential | undefined>;
    /** 静默续期凭据（过期 / 401 时调用）。 */
    refresh: () => Promise<void>;
    /** 动态拉取远端模型目录；失败或未登录时回退 `product.fallbackModels`。 */
    fetchRemoteModels?: () => Promise<AccioFallbackModel[]>;
    /** 注入的 fetch（测试用）；缺省全局 `fetch`。 */
    fetchImpl?: typeof fetch;
    /**
     * 内联一张图片为**原始字节**（由调用方桥接 `ctx.attachments.readImage`）。
     *
     * ⚠️ 契约与 `buddy-adapter.ts` 一致：**读不到必须返回 `undefined`**（不是抛错，
     * 也不是返回空）—— 由 {@link AccioAdapter.stream} 统一判成
     * `UNSUPPORTED_CONTENT`。静默丢图会让用户以为图片被模型看到了。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 取**请求版本**图片（附件服务按目标尺寸缩放）。
     *
     * ⚠️ 契约与 `readImage` **相反**：不可用时返回 `undefined`（不是抛错）——
     * 缩放是优化，拿不到就发原图（见 `image-budget.ts`）。
     */
    readImageRequest?: (attachment: unknown, target: {
        width: number;
        height: number;
        maxBytes: number;
    }) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 多账号池（用于记录当前账号归属）。 */
    accountPool?: AccountPool;
    /**
     * 设备标识（`utdid`）。
     *
     * ⚠️ 实测上游**不校验**它（自造值同样 200），故缺省用进程内稳定的兜底值；
     * 接线层可注入 `~/.accio/utdid` 的真实值。
     */
    utdid?: string;
    /** 产品配置；默认 {@link ACCIO}。 */
    product?: AccioProduct;
    /**
     * 时钟（注入以便单测推进目录 TTL；缺省 `Date.now`）。
     *
     * ⚠️ 只用于**目录新鲜度**（`ensureRemoteModels` 的 `isCatalogFresh`），
     *    不用于超时/退避计时 —— 那些仍走真实时钟。
     *    ⚠️ **buddy 是例外**：它的 `catalogGate` 也吃这个时钟（冷却与
     *    「距上次尝试 ≥10 秒」判定都走它），所以别把本行当成全仓库通用口径。
     */
    now?: () => number;
    /**
     * 远端目录**落地后**的通知回调（issue IKJVTF）。
     *
     * 由 `registerAccioLlm` 注入为 `broadcastCatalogChanged(ctx)` —— 适配器本身
     * 拿不到 `ctx`，必须由接线层桥接。
     */
    onCatalogLoaded?: () => void;
}
/**
 * 把 **DSH 原生消息块** 转成 `serializeAccioMessages` 认得的 **OpenAI 传输形状**。
 *
 * ## 为什么必须有这一层（真实缺陷，本任务的测试当场抓到）
 *
 * `serializeAccioMessages`（Task 3）是按 **OpenAI 形状**实现的：
 * 它读 `message.tool_calls[]`（`{id, function:{name,arguments}}`）与
 * `message.tool_call_id` / `message.name`。而 DSH 交给适配器的是**原生块**：
 *
 * ```jsonc
 * { "role": "assistant", "content": [{ "type": "tool-call", "id": "c1", "name": "read_file", "arguments": "…" }] }
 * { "role": "tool", "toolCallId": "c1", "content": "…" }        // 0.1.7 一等消息
 * ```
 *
 * 直接把原生块喂进去的后果是**全字段静默丢失**（实测）：
 * `tool_calls` 不存在 ⇒ 一个 `functionCall` 都不产出；`tool_call_id` 不存在 ⇒
 * `functionResponse.id` 落成空串、`name` 也落成空串 —— 而 Accio 的
 * `functionResponse` **按 name 配对**，空 name 的响应等于把工具结果丢掉。
 *
 * 这与 `trae-adapter.ts` / `lobsterai-adapter.ts` 的 `serializeMessages`
 * 是**同一步骤、同一原因**（那两家的注释里记着同一个真实缺陷）。
 *
 * ## 两条既有防线必须保留
 *
 * 1. **入口先 `normalizeHarnessMessages`**（DSH 0.1.7 把工具结果改为一等
 *    `role:'tool'` 消息）—— 漏掉它 `tool-result` 判据恒不命中，
 *    `resolveToolPairing` 会把 assistant 的 `tool_calls` **整体剔除**；
 * 2. **孤儿工具调用/结果必须剔除**（上游对无法配对的条目回 400）。
 *
 * ## 图片（issue IKLR7V 接线，2026-10-14）
 *
 * ⚠️ 本层**必须保留图片块**，不能只取文本。三种位置都要覆盖：
 *
 * | 位置 | 处理 |
 * |---|---|
 * | user 消息的顶层 `content[]` | `content` 产出**数组**（含 `image` 块）⇒ 由 `serializeAccioMessages` 的 `accioUserParts` 内联 |
 * | `tool-result` **内嵌**的图片 | **提升**为紧随其后的一条 user 消息（协议约束见下） |
 * | 其余 | 维持原样（纯文本仍然产出**字符串** `content`，线上格式逐字节不变） |
 *
 * ⚠️ **工具结果内嵌图片不能就地并进 `functionResponse`**：`functionResponse` 只吃
 * `responseJson`（一个**字符串**），塞图片没有位置。沿用 `trae-adapter.ts` 的
 * `flushToolImages` 范式 —— 该图挂到 `role:'tool'` **之后**的独立 user 消息里，
 * 并带一句 `TOOL_RESULT_IMAGE_TEXT` 说明来路（否则模型看到一张**没有上下文**的图）。
 */
export declare function toAccioWireMessages(messages: readonly {
    role: string;
    content?: unknown;
}[]): Array<Record<string, unknown>>;
/** Accio 的失败类别（`auth` 只换号、绝不写冷却，见上文语义表）。 */
export type AccioFailureClass = 'quota' | 'rate' | 'auth' | 'other';
/**
 * 失败类别 → 该不该**换号**（写不写冷却另由 {@link recordsAccioRateLimit} 判）。
 *
 * ⚠️ 必须把 `httpErrorCode` / `accioErrorFrame` 的**产出**喂进来，不得重扫状态码
 * —— 同一仓库两套同义判据是本仓库首条红线（PR !62 的事故）。
 */
export declare function accioFailureClassOf(code: string): AccioFailureClass;
/**
 * 该类别是否值得**换号重试**。
 *
 * ⚠️ `other` 为 false 的理由与 minimax / loomy 同款：400 参数错、5xx、
 * 风控拦截页这些是**请求本身或环境**的问题，换号只会白烧整池。
 */
export declare function shouldRotateAccioAccount(code: string): boolean;
/**
 * 该类别是否**写冷却标记**。
 *
 * ⚠️ **认证类恒 false**（见上文语义表的不变式）—— 这条是「一个请求封死整池」
 * 与「坏账号永远轮不到」之间的取舍点，两家都选前者。
 */
export declare function recordsAccioRateLimit(code: string): boolean;
/**
 * 合并一次工具调用的多个参数分片。
 *
 * ## 实测形状（2026-10-13，三轮取样，每次都是同一形态）
 *
 * ```
 * frame#8  {"function_call":{"id":"call_x","name":"read_file"}}                              ← 无参数
 * frame#9  {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * frame#10 {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * ```
 *
 * 即**首帧无参数、后续帧重复完整的参数**（不是增量、也不是逐帧增长）。
 * 但「重复全量」与「逐帧增长」在真机上都可能出现，故本函数两种都处理：
 *
 * 1. **累积式**（后一份以前一份为前缀）⇒ 取**最后一份**（它就是全量）；
 * 2. **增量式**（不是前缀关系）⇒ 把各片段**依次拼接**。
 *
 * 两条分支都不编造内容：全为空时返回空串，由调用方决定是否省略 `args_json`。
 */
export declare function mergeAccioToolArgs(fragments: readonly string[]): string;
export declare function accioToolCallMergeTransform(): TransformStream<Uint8Array, Uint8Array>;
/**
 * Accio 模型适配器。
 */
export declare class AccioAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    private readonly utdid;
    /** 远端目录缓存（成功拉取后保留 20 分钟）。 */
    private remoteModels;
    /**
     * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
     *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
     */
    private catalogAt;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
    private readonly catalogGate;
    /** 共享目录骨架（门控 → 读目录 → 黑名单 → 回填 → 三态）。 */
    private readonly catalog;
    constructor(options: AccioAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 懒加载远端模型目录（**每 20 分钟**重新拉一次，用户 2026-10-18 的要求；
     * 失败/空结果走闸门冷却）。
     */
    private ensureRemoteModels;
    /**
     * 把本家条目转成共享骨架的中间结构。
     *
     * ## ⚠️⚠️ `inputModalities` 的三态决策（2026-10-14 真机实测后**已改**）
     *
     * ### 改之前的判据（已废弃，别再改回去）
     *
     * 原先**恒省略**，理由是「本 provider 的图片通路整体未实测」——那时确实没有
     * 任何一次真实图片请求被验证过，故「未知」是唯一诚实的编码。
     *
     * ### 现在为什么可以写数组
     *
     * issue IKLR7V 的真机实测把那个前提消掉了：
     *
     * | 声明 | 实测（四象限色块图） |
     * |---|---|
     * | `multimodal: true`（3 个模型） | **3/3 四色全对**（红/绿/蓝/白）⇒ 真收图 |
     * | `multimodal: false`（3 个模型） | **3/3 未认图**；GLM-5.3 / Qwen 3.5 A3B 明说「没看到图片」，**GLM 5.1 幻觉**出一份答案 |
     *
     * 且远端 15 条可见模型的 `multimodal` 字段**从不缺失**（38 条原始行里
     * 可见的都有该键）、与兜底表 **100% 一致**。
     *
     * ### ⇒ 本家**不再有「未知」态**，与 loomy / raccoon / zcode / minimax / qoder 同形
     *
     * DSH 的三态语义在这里落成：
     * - `supportsImage === true` ⇒ `['text','image']`；
     * - `supportsImage === false` ⇒ **`['text']`（明确不支持）**。
     *
     * ⚠️⚠️ **`false` 必须写成 `['text']`，不能省略** —— 这是本次实测最重要的结论：
     * 上游对 `multimodal: false` 的模型**不报错，而是静默忽略图片**（GLM 5.1 甚至
     * 据此编造答案）。若省略（= 未知），DSH 会把图片一路放行到适配器，用户就会拿到
     * 一份**基于幻觉的、看起来正常的回答** —— 这是最难排查的一类失败。
     * 写 `['text']` 则让 DSH 在**附件准入阶段**就拒掉，用户当场得到「当前模型不支持图片」。
     *
     * ⚠️ 与 `model-catalog-parity.spec.ts` 的 `OMIT_UNKNOWN_MODALITIES` **必须同改**：
     * 那条用例按「真实适配器」双向断言，只改一处会变红并点名 accio。
     */
    private toCatalogEntry;
    /** 本家全部条目（远端优先，未落地时回退兜底表）。 */
    private catalogEntries;
    private loadCatalogEntries;
    /**
     * 同步视图（`listAllModels` 用）。
     *
     * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读缓存，
     * 未落地时回退兜底表（否则冷缓存下返回空数组，设置页会把 provider
     * 误显示成「已关闭」）。
     */
    private syncCatalogEntries;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 全量目录（**不套用户黑名单**），带最终展示名（含倍率）。
     *
     * 设置页必须能渲染已关闭的模型（否则用户无法重新打开），而 `listModels`
     * 会按黑名单过滤掉它们 ⇒ RPC 层只能凭裸 id 补回、展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。
     */
    /**
     * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog`（`model-catalog.ts`）
     *    上的这个成员**不会**自动变成适配器的成员 —— `pruned()` 的 Proxy 只透传
     *    **适配器自己的**成员（`dead-model-store.ts:748-749`）。
     *    漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且**零日志**（`refreshOf` 返回
     *    `undefined` 时静默跳过 —— `index.ts` 的装配注释写着这件事）。
     *    ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**重取）**不是同一件事**，
     *    两者同名纯属巧合，**不得合并**。
     */
    refresh(): Promise<void>;
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 兼容 0.1.1-rc.2+：`LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`。**必须包它**（PR !66 的教训：
     * 包装适配器时漏了 `prepareCall` 会让凭据续期 / 模型解析走偏，
     * 且记账包装也会静默失效）。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 发起一次推理请求；网络失败映射为可重试的 `TRANSPORT`。 */
    private send;
}
/**
 * 在 `ctx.llm` 上注册 Accio provider 路由与适配器。
 */
export declare function registerAccioLlm(ctx: Context, options: AccioAdapterOptions): AccioAdapter;
//# sourceMappingURL=accio-adapter.d.ts.map