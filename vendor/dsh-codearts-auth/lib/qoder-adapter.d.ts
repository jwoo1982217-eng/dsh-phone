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
import { type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js';
import { type ImageRequestTarget } from './image-budget.js';
import { BILLING_BUSINESS_CODE, QUEUE_BUSINESS_CODE, QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError, queueDelayMs, type QueueInfo } from './model-queue.js';
/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export { BILLING_BUSINESS_CODE as QODER_BILLING_CODE, QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE, QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError as parseQoderQueueError, queueDelayMs as qoderQueueDelayMs, type QueueInfo as QoderQueueInfo, };
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
}
/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export declare class QoderAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
    private readonly fallbackIndex;
    constructor(options: QoderAdapterOptions);
    /**
     * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
     *
     * ⚠️ **必须响应 `signal`**：排队等待最长可达 30 分钟，用户中途取消会话时
     * 不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
     */
    private sleep;
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
     * 模型接受的输入模态。
     *
     * 按**模型**判定（兜底表的 `supportsImage`），不是按 provider 一刀切。
     * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会失败）。
     *
     * ⚠️ 兜底表是本地估计值，不是远端权威数据 —— 见 `qoder-product.ts` 的说明。
     */
    private inputModalitiesFor;
    /**
     * 模型目录。
     *
     * **不发任何网络请求**：Qoder 的模型列表端点需要 WASM 签名
     * （`qoder_auth_wasm`），本插件不实现，故恒用产品兜底表。
     * 见设计文档 §2.6 与 `qoder-product.ts` 的 `fallbackModels` 说明。
     */
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 解析模型元信息。
     *
     * ⚠️ **`reasoning` 是「思考强度」选择器出现在模型菜单里的唯一入口**
     * （composer 读 `resolveModel().reasoning`）。此前本适配器**只声明了
     * `context`，从不声明 `reasoning`** → 中国版/国际版全都看不到档位选择器，
     * 尽管目录早已下发 `thinking_config`（用户报障「qoder中国版可以设置思考档位，
     * 我们应该按照他的设置给出可设置的档位选择」）。
     */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
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