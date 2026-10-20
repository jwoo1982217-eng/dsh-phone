/**
 * TRAE（字节跳动 TRAE IDE）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts` / `src/buddy-adapter.ts`，但**载荷转换与 SSE 解析全部重写**。
 *
 * ## 与现有适配器的关键差异
 *
 * | 项 | TRAE | Buddy / LobsterAI |
 * |---|---|---|
 * | 请求体 | OpenAI → SOLO 转换（function/config_name/tools 归一化） | 透传 OpenAI 格式 |
 * | SSE 格式 | SOLO 自定义事件（output/token_usage/done/error）→ 转 OpenAI | 标准 OpenAI SSE |
 * | 请求头 | `Cloud-IDE-JWT <token>` + X-* 系列 | Bearer / X-LobsterAI-Client-* |
 * | 图片 | 不支持 | Buddy / LobsterAI 支持 |
 * | prompt_cache_key | 不发 | Buddy 发（腾讯前缀缓存） |
 *
 * 复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` / `resolveToolPairing` /
 * `normalizeToolArguments` / `isTruncatedArguments`）——它们处理的是 OpenAI 协议层的通用陷阱。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type TraeCredential, type TraeRemoteModel } from './trae.js';
import { type TraeProduct } from './trae-product.js';
/** 本适配器注册的 provider 路由名。 */
export declare const PROVIDER = "trae";
/**
 * TRAE 适配器选项。
 */
export interface TraeAdapterOptions {
    credentialRef: CredentialRef;
    /**
     * 从凭据存储解析凭据。
     *
     * ⚠️ 入参是**本轮要用的模型 id**，实现**必须**透传给
     * `AccountPool.getAvailableAccount` 的 `modelId`：限流是**按模型**记的
     * （`modelRateLimits[model]`），传空串会让 `getAvailableAccount` 的限流
     * 过滤整体短路（`if (modelId.length === 0) return true`）—— 于是适配器
     * 刚写下的限流标记，下次选号时被完全忽略，**换号形同虚设**
     * （用户报障「没有切换」的两个根因之一）。
     *
     * 与 `LoomyAdapterOptions.resolveCredential` 同款（那里是既有正确实现）。
     */
    resolveCredential: (modelId?: string) => Promise<TraeCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 动态拉取远端模型列表；失败时回退到 `product.fallbackModels`。 */
    fetchRemoteModels?: () => Promise<TraeRemoteModel[]>;
    fetchImpl?: typeof fetch;
    /** 多账号池（用于限流时切换账号）。 */
    accountPool?: AccountPool;
    /**
     * 读取图片附件的原始字节（内联为 `data:` URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`。未提供时收到图片会报
     * `UNSUPPORTED_CONTENT`（而不是静默丢弃）—— 见 `stream()` 的图片分支。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link TRAE}。 */
    product?: TraeProduct;
}
/**
 * 组装模型选择器里展示的名字：`模型名 · 倍率`。
 *
 * ## 为什么倍率必须拼进 `name`
 *
 * composer 的模型切换菜单**只渲染 `name`**（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`），
 * `description` **完全不读**。用户报障「消耗倍率没有显示在切换模型列表的后面」
 * 正是因为早期版本放进了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`，故附加价格不会
 * 污染会话历史。`resolveModel` 的 `name` **不带**倍率（价格只属于选择列表语境，
 * 与 Qoder 的处理一致）。
 *
 * 形态：
 * - 常态 `Qwen3.8-Flash · x0.08`
 * - 活动期 `Doubao-Seed-2.1-Pro · x0.80→x0.08`（箭头比「（促销 …）」短，适合窄菜单）
 * - 无倍率信息时只显示模型名（**不编造** `x1`）
 */
export declare function traeDisplayName(model: TraeRemoteModel): string;
/**
 * TRAE 模型适配器。
 */
export declare class TraeAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 动态模型缓存。 */
    private remoteModels;
    /**
     * 目录加载闸门：并发去重 + 失败/空结果冷却。
     * 依据见 `src/remote-catalog-gate.ts`（首屏「加载模型巨长」的实测归因）。
     */
    private readonly catalogGate;
    /** 远端模型元数据索引。 */
    private remoteMeta;
    /** 产品级兜底模型索引。 */
    private readonly fallbackIndex;
    /**
     * 已发起的 chat 请求计数（仅在启用机器指纹轮换时使用，见
     * {@link TraeAdapter.machineIdGeneration}）。
     */
    private sendCount;
    constructor(options: TraeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /** 懒加载远端模型目录（仅拉取一次）。 */
    private ensureRemoteModels;
    /**
     * 模型接受的输入模态 —— **逐模型**判定，不是按 provider 一刀切。
     *
     * 判据是远端 `display_config.multimodal`（见
     * {@link TraeRemoteModel.multimodal} 的实测记录）：
     *
     * - `true` → `['text', 'image']`
     * - `false` / **未声明** → `['text']`（保守：兜底表没有该字段，
     *   且「远端没说」不等于「远端支持」）
     *
     * ⚠️ **这里返回的 `image` 是 DSH 的准入闸门**：不声明 `image` 时，图片会在
     * **附件入库阶段**就被拒（`session/attachment-invalid`），用户看到
     * 「当前模型不支持图片」——而图根本没发到上游。因此漏报 `image` 不只是
     * 「少个功能」，而是「连降级成文本占位符的机会都没有」。
     *
     * **历史缺陷**（Issue #IKHDKC）：早期这里恒返回 `['text']`（参数名甚至是
     * `_model`，即刻意忽略模型），理由是「SOLO 通道未见图片能力」—— 实测证伪：
     * 远端一直在目录里声明该能力，且直发图片后模型真的看得见。
     */
    private inputModalitiesFor;
    /**
     * 该模型所属的聊天通道（`function`）。
     *
     * ⚠️ **模型只在列出它的通道里可调用**：发错通道上游会回流内
     * `code=4001 param is invalid`（实测 `glm-5.1` 在 `solo_work_lite` 报错、
     * 在 `solo_agent_remote` 正常；`glm-5-turbo` 恰好相反）。
     * 远端目录里每条模型都带自己的 `function`；查不到时回退默认通道。
     *
     * ⚠️ **这里拿到的一定是白名单内的通道**（Issue IKJOZ7）：非白名单通道的条目
     * 已在 `parseTraeBatchModelList` 里被整组剔除，故 `remoteMeta` 里不可能存在
     * 「通道不可调用」的模型。兜底路径（远端目录不可用 → 兜底表）本就没有通道
     * 信息，只能回退 `product.function`（`solo_work_lite`，已在白名单内）。
     *
     * ⚠️ 若在此处**再加**一层白名单校验，会让「用户用 `DSH_TRAE_CHANNELS` 自定义
     * 白名单 + 模型来自兜底表」的组合出现两条判据不一致；故准入只在解析器一处
     * 执行（单一真相源）。
     */
    private channelFor;
    /**
     * 模型的上下文窗口：远端优先，兜底表次之。
     *
     * ⚠️ 开启 Max 模式时改用 `context_window_tokens.max`（1M）。两者**不能混用**：
     * 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，而上游按 200K 校验后
     * 拒绝（输入被截断或 4xx）。
     */
    private contextWindowFor;
    /**
     * 该模型本次是否启用 **Max 模式**（1M 上下文）。
     *
     * 三个条件缺一不可（对齐 `Trae2api-cn/trae_remote_client.py:249-277`）：
     * 1. 产品级开关（`DSH_TRAE_MAX_MODE`）未关 —— **默认开启**，用户要求
     *    「上下文用最大的那一档」；显式设 `0` / `false` 才关回 200K；
     * 2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套
     *    Max 参数，上游会拒绝（`_max_mode_requested` 的注释明写
     *    "Never fabricate max limits for a model the account config does not mark"）；
     * 3. 若配置了白名单，模型须在其中。
     */
    private maxModeFor;
    /**
     * 模型可选的推理强度档位（`reasoning_effort_config`）。
     *
     * TRAE 的 `options` 是**单值字符串**（既是产品侧档位名、也是 wire 值），
     * 与 LobsterAI 的 `level` / `openclawLevel` 双字段形态不同，故不需要映射表
     * 之外的转换（命名仅用于展示）。
     *
     * 不声明 `reasoning` 的两种情形：
     * - 远端没有该配置 → UI 显示「当前模型未提供推理等级」（而不是给个发了没用的档位）
     * - `support_thinking === false` → 远端明确说不支持思考
     *
     * `defaultEffort` 必须落在 `efforts` 内（DSH 会拿它直接发请求），远端数据
     * 不一致时退化为不声明默认值。
     */
    private reasoningFor;
    /**
     * 模型的输出上限：远端优先 → 兜底表 → 产品级兜底值。
     *
     * ⚠️ 实测远端主流模型声明的是 **32000**，而兜底表旧值写的 128000 会让
     * DSH 索要一个上游不接受的值。远端可用时一律以远端为准。
     */
    private maxOutputTokensFor;
    /**
     * 静态兜底模型目录。
     *
     * 始终过滤 `isHidden === true` 的条目（这些是上游内部/隐藏模型，不应出现在
     * 对话模型目录中）。与远端路径的过滤逻辑一致（`parseTraeBatchModelList` 中也
     * 硬性过滤 `isHidden === true`）。
     */
    private staticFallbackModels;
    /**
     * 完整模型目录（**不应用用户黑名单**）。
     *
     * ## 为什么需要它
     *
     * `listModels` 会按用户黑名单过滤（Jet Hub「显示列表」开关），于是**被关闭的
     * 模型不在其返回值里**。而设置页必须把关闭的模型也渲染出来（否则用户无法重新
     * 打开），RPC 层只能凭黑名单的 key（裸 id）补回 —— 那条路径拿不到展示名，
     * 只能回退成裸 id，**倍率与模型显示名随之丢失**（用户报障：「关闭的就没有显示
     * 倍率，关闭的应该也显示倍率」）。
     *
     * 故这里提供「不过滤黑名单」的目录，由 `model.list` 端点使用：它据此拿到
     * 每个 id 的**真实展示名（含倍率）**，再自行回填 `disabled` 状态。
     * 对话框模型选择器读的仍是 `listModels`（已过滤），可见性行为不变。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 该模型是否**消耗 0 积分**（免费），用于跳过「锁定永久积分」那道门。
     *
     * ## 为什么需要它
     *
     * 选号编排里 `isFreeModel: true` 会**完全跳过余额分档**：免费模型既不扣临时
     * 积分也不扣永久积分，与「别把永久积分烧掉」这个保护目标无关。若不跳过，
     * 用户锁定了永久积分、账号只剩永久积分时，选号会落 `none` 档并抛出
     * 「积分都已用尽」—— 而他用的模型**根本不扣积分**，报错完全误导
     * （buddy 系已因此产生过真实报障，见 `index.ts` 的 `isFreeModel` 参数注释）。
     *
     * ## 判据
     *
     * 远端目录的 `creditsRate`（`readConsumptionRate()` 解析 `display_contact_config`
     * 里的 `consumption_rate.data.rate`）**等于 0** 即免费。
     *
     * ⚠️ **`rate: 0` 是合法值**，不能与「解析不出来」混为一谈（`readConsumptionRate`
     * 的注释已记这条坑）。展示层同样把它显示为「免费」（见 `traeDisplayName`）。
     *
     * ⚠️ **只在确定免费时返回 true**：查不到目录 / 解析失败一律 false ——
     * 方向保守（宁可多走一次余额门），与 `BuddyAdapter.isFreeModel` 同一约定。
     *
     * ⚠️ 远端目录是懒加载的，必须先 `await ensureRemoteModels()`，否则「直接进会话」
     * 等路径查不到目录，会**静默退回被拦截的行为**。
     *
     * @param modelId - 模型 id。
     * @returns true 仅当能确认该模型消耗 0 积分。
     */
    isFreeModel(modelId: string | undefined): Promise<boolean>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
    /**
     * 当前应使用的机器指纹代次。
     *
     * **默认恒为 0（不轮换）** —— 只有显式设置
     * `DSH_TRAE_ROTATE_MACHINE_ID=1` 时才按每 4 次请求递增一代。
     *
     * 默认关闭的原因见 {@link deriveRotatingMachineId}：轮换能降低端点风控，
     * 但会让设备身份漂移，与「machine_id 登录后绝不变」的既定约束冲突。
     * 该开关是出现集中 401/风控时的第一个可尝试手段。
     */
    private machineIdGeneration;
    /**
     * 消费 SOLO 自定义 SSE 流，转为 OpenAI StreamChunk。
     *
     * SOLO 事件格式（solosse.go）：
     * ```
     * event:output
     * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
     *
     * event:token_usage
     * data:{"prompt_tokens":21,"completion_tokens":142,...}
     *
     * event:done
     * data:{"finish_reason":"stop"}
     *
     * event:error
     * data:{"code":4008,"message":"quota exceeded"}
     * ```
     */
    private consumeSse;
}
/**
 * ⚠️ TRAE **没有**本地历史闸门（2026-10-04 删除）。改动本文件前请先读完这段。
 *
 * 这里原先有一道「请求体字符预算」裁剪：超预算就从最早的非系统消息开始整轮丢弃
 * （`trimTraeHistory` + `resolveMaxHistoryChars` + `TRAE_MAX_CHARS_PER_TOKEN`，
 * 以及逃生舱 `DSH_TRAE_MAX_HISTORY_CHARS`）。它已被**整体删除**，理由三条：
 *
 * 1. **它的依据是从别的项目抄来的，未在本仓库实测**。原文写的是「对齐
 *    `Trae2api-cn` 的实测结论：上游在 query 超过约 500K 字符时会静默结束事件流」，
 *    于是把那个项目的 `TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 抄成本插件写死的
 *    480,000。而 `480000 = 2.4 × 200000` —— 那是**声明窗口本身的量级**，
 *    不是量出来的字符天花板。
 * 2. **它守的是别人客户端的形态**。那两道闸门的另一道是
 *    `TRAE_REMOTE_QUERY_MAX_CHARS`（**扁平化 query** 的硬上限），而本插件的 trae
 *    链路里**根本没有 `query` 字段** —— 我们发的是 OpenAI 形状的 `messages[]`
 *    （上游那句 `Messages with role 'tool' must be a response to a preceding
 *    message with 'tool_calls'` 本身就证明它在逐条读 role）。
 * 3. **它的前提被本仓库的探针推翻了**。2026-10-04 的实发探针（请求体抓下来打印确认
 *    档位）在**常规档**（非 Max，`含 strategy=false context_window_size=false`）实测：
 *
 *    | 正文字符 | 服务端 `input_tokens` | 字符/token | 结果 |
 *    |---|---|---|---|
 *    | 40,398（标定） | 9,827 | 4.11 | 200 + 正中标记命中 |
 *    | **700,404** | 173,712 | 4.03 | **200 + 正中标记命中** |
 *    | **1,000,484** | 249,351 | 4.01 | **200 + 正中标记命中**（比 200K 窗口还多 24%） |
 *    | 900,303（中文正文） | 422,672 | 2.13 | 200 + 正中标记命中 |
 *
 *    ⇒ 「约 500K 字符即静默断流」被**证伪到 2 倍**（100 万字符仍完整送达）；
 *    ⚠️ 并**更正一处旧误标**：早先那次 900,303 字符的记录被写成「Max 档」，
 *    但探针构造适配器时没有注入远端元数据，而 `maxModeFor()` 要求远端
 *    `display_config.max_mode === true`（见本文件 `maxModeFor`）—— 它其实是**常规档**。
 *
 * ## 它造成的是**净损害**（这是删除的决定性理由）
 *
 * 引入 Max 模式（声明 1M tokens）后，写死的 480,000 没跟着涨，与 DSH 的压缩点
 * （`窗口 × 0.8`，1M → 800K tokens ≈ 170 万字符）**脱钩**：界面显示「才用了 8%」，
 * 适配器却每轮静默丢掉约四分之三的历史（真实会话量：1,898,903 字符 = 旧预算的
 * **396%**）。用户报障原文「trae 显示的上下文长度不对」——
 * **那正是这道闸门造成的**，不是任何上游限制造成的。
 *
 * 中间版本把它改成「声明窗口 × 系数」（系数 2 → 5），能让**实测内容**下不再误伤，
 * 但仍有两个消不掉的问题：
 *
 * - **字符闸门在数学上不可能被证明「永不先于 DSH 的压缩点生效」**：DSH 的界是
 *   token、闸门是字符，只要内容的字符/token 足够高（系数 5 ⇒ 6.25），任何**有限**
 *   系数都会被绕过。系数 5 只是把触发条件推到实测值（中文 2.13、英文/代码 4.0）
 *   之外，而不是消灭它。
 * - 全仓库**只有 trae 有这条「静默丢历史」的路径**：其余 13 个 provider 把 DSH 的
 *   压缩点当唯一真相；唯一的另一类体积防护（`src/image-budget.ts`，13 家共用）
 *   作用在**单张图的编码字节**上，且压不下去时**抛 `UNSUPPORTED_CONTENT`**（可见），
 *   而不是悄悄丢消息。
 *
 * ⇒ 因此删掉它：**静默丢历史这一类缺陷在结构上消失**，trae 与其余 13 家同形，
 * 真正的限制只有一个 —— DSH 的压缩点。
 *
 * ## 如果将来要加回来
 *
 * 先做**实发探针**，不要抄常数、也不要按窗口折算：
 *
 * 1. 用真实链路量出「多大体积开始出问题」，以及出问题时是**可见错误**还是
 *    **静默结束**。⚠️ 截至 2026-10-04：常规档已知 **100 万字符 / 24.9 万 tokens
 *    仍正常返回**（正中标记命中），「约 50 万字符」那条传闻已被证伪到 2 倍；
 *    真正的 **Max 档**（注入远端 `max_mode=true` 后的 1M 声明）与常规档 > 100 万
 *    字符**都还没探** —— 但闸门已删，这两点只在「想加回来」时才需要补；
 * 2. 若确实要设闸门，它**必须可观测**（记日志/上报），不能静默改语义；
 * 3. 判据与全部取证见 `AGENTS.md` 的「TRAE 历史闸门（已删除）」段。
 *
 * 失败落点（**已知可见**，不是静默）：一个上游事件都没收到会抛 `TRANSPORT`
 * （"upstream returned no events"，见本文件 `stream()` 的 `!sawAnyUpstreamEvent`
 * 分支），并由 DSH 的常规重试接管（那次重试判据见 `isTransportError`）。
 *
 * ---
 *
 * 在 `ctx.llm` 上注册 TRAE provider 路由与适配器。
 */
export declare function registerTraeLlm(ctx: Context, options: TraeAdapterOptions): TraeAdapter;
//# sourceMappingURL=trae-adapter.d.ts.map