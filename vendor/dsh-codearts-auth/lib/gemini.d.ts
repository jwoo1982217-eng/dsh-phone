/**
 * Gemini（Google Cloud Code Assist 免费线）协议层：产品常量、凭据、字母序信封、
 * 模型档表与 JSON Schema 清洗。
 *
 * ## 来源与取证基准
 *
 * 逐点移植自 `F:\project\cmdc-pak-align-wb\internal\upstream\gemini\`
 * （`client.go` / `model.go` / `translate.go` / `types.go`）。
 * ⚠️ 常量基准 = cmdc-pak **0.8.6.1（两轮 MITM）+ 0.8.8（oracle 61 探针）**；
 * `cmdc-pak v0.8.9.exe` 已全量字符串加密（`x-machine-id` / `antigravity` /
 * 两个 sessionId / `aicode-consumers` / `v1internal` 全部 0 命明文），
 * 静态取证失效。详见 `docs/GEMINI-PORT-PLAN.md` §九。
 *
 * ## 三条必须保留的上游对齐细节（计划 §2.2）
 *
 * 1. **身份五头逐字写死、不许随机**（{@link GEMINI_IDENTITY_HEADERS}）。
 *    ⚠️ 且**不带** `x-goog-api-key` / `x-goog-api-client`。
 * 2. **流式请求刻意不带 `Accept` 头** —— 抓包一致。见 {@link geminiHeaders}
 *    的 `includeAccept` 开关（默认 false）。
 * 3. **信封逐层字母序序列化**（{@link marshalAlphabetical}）。Go 的
 *    `encoding/json` 对 `map` 键自动字母序排，而 TS 的 `JSON.stringify`
 *    按 V8 插入序 —— 不排序就与上游看到的字节不同。
 *
 * ## ⚠️ 2026-10-05 更正：`sessionId` 不是常量
 *
 * 早前按历次抓包把推理/冒烟各钉一个常量（`3124275334370613369` /
 * `-6686302828062879362`）。真机对照实验推翻了它：
 *
 *     sessionId = f(project, contents[0].text, lane)
 *
 * 换 project 会变；换 model / maxOutputTokens / systemInstruction / 对话轮数
 * 都不变。那两个"常量"只是**特定输入的输出**被反复抓到。
 *
 * 写死的后果是**所有用户、所有对话共用一个会话** —— 而原版的会话归并与
 * `thoughtSignature` 回填都挂在这个字段上。现在走
 * {@link deriveGeminiSessionId} 确定性派生（同对话稳定、跨对话隔离）。
 *
 * 注意：原版哈希本体尚未反推出来（已否证 50+ 种），故**取值不与原版逐字相同**，
 * 对齐的是依赖维度与"同输入同输出"。`GEMINI_SESSION_ID_*` 仅作覆盖示例保留。
 *
 * ## 实测确认的三条事实（计划 §七）
 *
 * - **模型名是准入钥匙**：发裸 `gemini-3.8-flash` 上游 404，必须带档位后缀
 *   （`gemini-3.8-flash-high`）。
 * - **lite 已整体移除**（用户 2026-10-03 拍板「不要 lite 模型」）：真机实测
 *   `gemini-3.8-flash-lite` 在两端点上**恒 404**
 *   （`{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`），
 *   与是否传档位无关 ⇒ 该模型名不在本账号的准入表里，暴露它只会让用户选中即失败。
 * - **思考预算是自由旋钮**：名字叫 `medium` 但预算给 10000 → 实测 213 token；
 *   给 4000 → 164 token。名字只是标签，预算才是行为。
 * - **「关闭思考」是假关**：关掉 `includeThoughts` 照样思考照样计费
 *   （实测 195 token）⇒ 不提供 `none` 档，`includeThoughts` **恒 true**。
 */
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm';
/** 主端点（`client.go` 的 `EndpointDaily`）。 */
export declare const GEMINI_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
/** 沙箱端点（`client.go` 的 `EndpointSandbox`）。 */
export declare const GEMINI_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
/**
 * 端点轮换顺序（原版 `NewClient` 的初始 `endpoints`）。
 *
 * ⚠️ 用户 2026-10-03 澄清：**两端点的差异未获实验支持**（404 与 project 两类
 * 失败在两端点上行为完全一致）。换端点**零成本无害**，但**不能当 quota 的
 * 有效解法** —— 主救场手段是**换账号**。
 */
export declare const GEMINI_ENDPOINTS: readonly string[];
/** 非流式推理路径。 */
export declare const GEMINI_GENERATE_PATH = "/v1internal:generateContent";
/** 流式推理路径（SSE）。 */
export declare const GEMINI_STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
/** 配额查询路径（**Summary 变体**，请求体见 `gemini-credits.ts`）。 */
export declare const GEMINI_QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
/**
 * 账号档位 / 项目探测路径。
 *
 * 面板的「账号规格」一栏用它（原版 `project.go:15` 的 `loadCodeAssistPath`，
 * 但原版的 `loadCodeAssistResponse` **没有 `paidTier` 字段**，故原版区分不开
 * pro / free —— 见 `gemini-credits.ts` 的 `parseGeminiAccountTier`）。
 */
export declare const GEMINI_LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
/**
 * 档位探测的请求体（**逐字**，content-length 恰为 38）。
 *
 * ⚠️ 对齐原版 `project.go:97-103`：**不带** `platform` / `pluginType` /
 * `cloudaicompanionProject`，多一个字段就可能被上游识别成非官方客户端。
 */
export declare const GEMINI_LOAD_CODE_ASSIST_BODY = "{\"metadata\":{\"ideType\":\"ANTIGRAVITY\"}}";
/**
 * 上游身份五头。
 *
 * ⚠️ **逐字写死**：任何一个字符不同都可能被上游识别为非官方客户端。
 * ⚠️ **不要**加 `x-goog-api-key` / `x-goog-api-client` —— 原版不带。
 */
export declare const GEMINI_IDENTITY_HEADERS: Readonly<Record<string, string>>;
/** 信封里的 `userAgent` 字段（与 `x-client-name` 同值）。 */
export declare const GEMINI_UPSTREAM_USER_AGENT = "antigravity";
/**
 * 上游项目号（`loadCodeAssist` 探测为空/失败时的**兜底**）。
 *
 * ⚠️ 2026-10-05 更正：这不是"恒为此值"。真机对照实验证明原版读
 * `loadCodeAssist` 的 `cloudaicompanionProject`（假上游返回 `CCP-TWO`，
 * 信封里就是 `CCP-TWO`）。免费档账号的 LCA 返回空 project，才回落到这个串
 * —— 这也是历次抓包都看到 `aicode-consumers` 的原因。
 */
export declare const GEMINI_DEFAULT_PROJECT = "aicode-consumers";
/**
 * 两条会话派生路径的标签。
 *
 * ⚠️ 2026-10-05 更正：早前以为这两条路径各自对应一个**预置常量**
 * （推理 `3124275334370613369` / 冒烟 `-6686302828062879362`）。真机对照实验
 * 推翻了它：`sessionId = f(project, contents[0].text, lane)`，那两个"常量"
 * 只是特定输入的输出被反复抓包，被误当成了身份常量。
 *
 * 因此标签不再参与**取值**，只用于区分两条派生路径（lane 进哈希）。
 */
export declare const GEMINI_SESSION_LANE_INFER = "infer";
export declare const GEMINI_SESSION_LANE_SMOKE = "smoke";
/**
 * 推理用 sessionId 的**历史常量**（仅作覆盖示例 / 文档留证，不再是默认值）。
 *
 * @deprecated 默认走 {@link deriveGeminiSessionId} 派生。要复刻历史抓包时用
 * `sessionId` 选项显式钉住。
 */
export declare const GEMINI_SESSION_ID_INFER = "3124275334370613369";
/** 冒烟/探测用 sessionId 的**历史常量**。@deprecated 同 {@link GEMINI_SESSION_ID_INFER}。 */
export declare const GEMINI_SESSION_ID_SMOKE = "-6686302828062879362";
/**
 * 按 `(project, 首条 user 文本, lane)` **确定性派生** sessionId。
 *
 * ⚠️ 取"首条 user 文本"的规则见 `gemini-messages.ts` 的 `geminiFirstUserText`
 * （只有 `contents[0]` 参与、且只看其中的文本 part）。
 *
 * 与原版的依赖维度对齐（2026-10-05 真机对照实验）：
 *
 * - **吃**：`project`、`contents[0]` 的文本、lane（推理 / 冒烟）
 * - **不吃**：model、maxOutputTokens、systemInstruction、对话轮数、后续文本、机器特征
 *
 * ⚠️ **取值不与原版逐字相同**。原版的哈希函数本体尚未反推出来（已否证
 * FNV-1a/1、murmur64A、MD5/SHA 系列等 50+ 种），这里用 FNV-1a 复刻的是
 * **依赖维度与"同输入同输出"**，不是数值。想要数值一致得先做动态断点。
 *
 * 输出形态对齐原版：有符号 int64 的十进制串（原版取到的值正负都有）。
 *
 * ## `generation`（会话升代自愈）
 *
 * 上游按 `sessionId` 在**服务端**累计对话输入；长工具循环会把累计推过 1M，
 * 此后该 sessionId 的**每个**请求都 400
 * `The input token count exceeds the maximum number of tokens allowed 1048576`，
 * 直到该服务端会话过期。升一代 = 换一个全新 sessionId = 上游开新会话，
 * 对话无感恢复（`Antigravity-Manager` 的 `[FIX session-1M]` 与 wb 的
 * `SessionOverflowBump` 是两个独立佐证）。
 *
 * ⚠️ `generation === 0` 时**不把代数拼进输入** —— 必须与升代前逐字同值，
 * 否则升级这个功能本身就会让所有进行中的对话换一次 sessionId（丢 prompt cache）。
 */
export declare function deriveGeminiSessionId(project: string, firstUserText: string, lane: string, generation?: number): string;
/** 推理请求超时。 */
export declare const GEMINI_REQUEST_TIMEOUT_MS = 120000;
/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ 与 minimax / cline 等适配器同款：上游在生成大 functionCall 参数期间
 * 可能长时间不 flush 任何字节，裸 `reader.read()` 会**无限期挂起**
 * （表现为「发消息后永远转圈」）。超时归类为可重试的 `TIMEOUT`，
 * harness 才能重试该步骤。
 */
export declare const GEMINI_IDLE_TIMEOUT_MS = 120000;
/** OAuth 端点请求超时。 */
export declare const GEMINI_OAUTH_TIMEOUT_MS = 20000;
/** 配额查询超时。 */
export declare const GEMINI_CREDITS_TIMEOUT_MS = 30000;
/** 配额缓存 TTL（原版 `quotaCacheTTL`）。 */
export declare const GEMINI_QUOTA_CACHE_TTL_MS = 60000;
/** 凭据过期余量（原版 `Credentials.Valid()` 留 60 秒）。 */
export declare const GEMINI_EXPIRY_LEAD_MS = 60000;
/** Gemini 产品描述（与 minimax 的 `MinimaxProduct` 同形态）。 */
export interface GeminiProduct {
    readonly id: string;
    readonly displayName: string;
    readonly defaultCredentialRef: string;
    /** 图片像素预算（第一跳缩放用）。 */
    readonly imagePixelBudget: number;
    /** 默认最大输出 token（用户 2026-10-03 定为 64000，原版是 65536）。 */
    readonly maxOutputTokens: number;
}
export declare const GEMINI: GeminiProduct;
/** 按 id 查产品（探测分派表用）。 */
export declare function geminiProductById(id: string): GeminiProduct | undefined;
/**
 * Gemini 凭据（原版 `oauth.Credentials`）。
 *
 * ⚠️ 字段名与 OAuth 响应**逐字一致**（`access_token` / `expiry` …），
 * 因为整份 JSON 会被原样落盘并在刷新时回写。
 */
export interface GeminiCredential {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    /** RFC3339 时间戳（原版 `expiry`）。 */
    expiry?: string;
    sub?: string;
    email?: string;
    cloudaicompanionProject?: string;
}
/**
 * 解析凭据 JSON。
 *
 * ⚠️ **失败返回 `undefined` 而不抛错**（与 `parseMinimaxCredential` 同口径）：
 * 凭据损坏是**可预期**的运行态（用户手工编辑过、旧版本格式），
 * 抛错会让整批 `refreshAll` 中断。
 */
export declare function parseGeminiCredential(value: string): GeminiCredential | undefined;
/**
 * 凭据过期时刻（毫秒）。
 *
 * ⚠️ 取不到时返回 `undefined`（**不编造**）—— `shouldRefreshNow` 会把它当作
 * 「需要续期」，从而走一次真实的 refresh 请求；比假装没过期安全。
 */
export declare function geminiCredentialExpiresAtMs(credential: GeminiCredential): number | undefined;
/** 凭据是否已过期（含 60 秒余量，同原版 `Valid()`）。 */
export declare function isGeminiExpired(credential: GeminiCredential, nowMs?: number): boolean;
/** 凭据是否具备续期材料。 */
export declare function isGeminiRefreshable(credential: GeminiCredential): boolean;
/** 取用户身份显示名（昵称用）。 */
export declare function geminiAccountLabel(credential: GeminiCredential): string | undefined;
/**
 * 构造推理请求头。
 *
 * ⚠️ `includeAccept` 默认 **false**：流式请求**刻意不带 `Accept` 头**
 *（抓包一致）。调用方若要发非流式请求，可显式传 true。
 * ⚠️ 身份五头**逐字**注入，且**不注入** `x-goog-api-key`。
 */
export declare function geminiHeaders(credential: GeminiCredential, options?: {
    includeAccept?: boolean;
}): Headers;
/** 按键名升序序列化（{@link sortValue} 的 JSON 出口）。 */
export declare function sortedStringify(value: unknown): string;
/** 与上游一致的字母序信封序列化（Go `marshalAlphabetical` 的等价物）。 */
export declare function marshalAlphabetical(value: unknown): string;
/** 生成每请求随机的 requestId（原版 `newRequestID()`）。 */
export declare function newGeminiRequestId(nowMs?: number): string;
/** 思考档位。 */
export type GeminiTier = 'low' | 'medium' | 'high' | 'tiered';
/** 主模型上游名（**不带**档位后缀，后缀由 {@link geminiModelSpec} 拼）。 */
export declare const GEMINI_UPSTREAM_FLASH = "gemini-3.8-flash";
export declare const GEMINI_BUDGET_LOW = 1000;
export declare const GEMINI_BUDGET_MEDIUM = 4000;
export declare const GEMINI_BUDGET_HIGH = 10000;
/** tiered 档：只发 `includeThoughts`，**不发** `thinkingBudget`。 */
export declare const GEMINI_BUDGET_TIERED = -1;
/** 上下文窗口（用户拍板填 1_000_000）。 */
export declare const GEMINI_CONTEXT_WINDOW = 1000000;
/** 一个可选档位的 id（与 `reasoningEffort` 同域）。 */
export declare const GEMINI_EFFORT_IDS: readonly string[];
/** 默认档位。 */
export declare const GEMINI_DEFAULT_EFFORT = "medium";
/** 档位 id → 中文显示名（用户拍板用中文）。 */
export declare function geminiEffortLabel(id: string): string;
/**
 * 静态模型表条目（与 `MinimaxModelEntry` 同形态，便于复用同一套适配器写法）。
 *
 * ⚠️ `maxTokens` **必须**是安全正整数：DSH 校验不通过会抛
 * `INVALID_MODEL_MAX_TOKENS` 并让**整轮对话起不来**。
 */
export interface GeminiModelEntry {
    readonly id: string;
    readonly name: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly supportsImage: boolean;
    readonly effortOptions?: readonly string[];
    readonly defaultEffort?: string;
}
/**
 * 静态模型表（用户拍板：**静态表**，不拉远端目录）。
 *
 * 暴露 1 条：主模型带 4 档 efforts。
 * ⚠️ **不暴露 4 个带后缀的模型名** —— 档位走 efforts 下拉框。
 * ⚠️ **不暴露 lite**（用户 2026-10-03 拍板）：上游恒 404，暴露即坑。
 */
export declare const GEMINI_FALLBACK_MODELS: readonly GeminiModelEntry[];
/** 取静态模型表。 */
export declare function geminiFallbackEntries(): readonly GeminiModelEntry[];
/** 档位 id 归一（未知/缺省一律 medium，同原版 `EffortToTier` 默认分支）。 */
export declare function geminiEffortToTier(effort: string | undefined): GeminiTier;
/** 档位 → 思考预算。 */
export declare function geminiThinkingBudget(tier: GeminiTier): number;
/** 一次请求的模型规格。 */
export interface GeminiModelSpec {
    /** 真正发给上游的模型名（带档位后缀）。 */
    readonly upstream: string;
    readonly tier: GeminiTier;
    readonly thinkingBudget: number;
    /** **恒 true**（「关闭思考」是假关，见文件头）。 */
    readonly includeThoughts: true;
}
/**
 * 归一化模型 id：剥掉档位后缀（`-low/-medium/-high/-tiered`），得到目录裸名。
 *
 * ⚠️ 限流标记（`modelRateLimits` 的 key）与 `account.test` 探测链路记录 /
 * 传递的可能是**带档位的名字**（写标记时用的是请求原始 id），而静态表的 id
 * 是裸名 —— 两处校验都必须先归一化，否则「测一下被限流的档位」会被误拒。
 * ⚠️ 只剥**已知档位**后缀：未来加第二个模型时，若其真名恰好以档位词结尾
 * （如 `gemini-x-high`），这里会把它误剥成 `gemini-x` —— 届时必须改为
 * 「按目录表全名优先匹配」再回落剥后缀。
 */
export declare function geminiCanonicalModelId(modelId: string): string;
/**
 * 由「模型 id + 用户选的档位」得出上游模型规格。
 *
 * ⚠️ 模型名必须带档位后缀 —— 它是上游的准入钥匙（见文件头实测）。
 *
 * ⚠️ **`modelId` 严格校验**：静态表（{@link GEMINI_FALLBACK_MODELS}）只暴露
 * `gemini-3.8-flash` 一个模型，upstream 恒为 `gemini-3.8-flash-<tier>`。
 * 曾经「任何 id 都放行」是有意的宽容（网关实测 `gemini/gemini-9.9-fake`、
 * `gemini/totally-bogus` 均 200 并正常作答 —— 名字根本没参与上游请求），
 * 但宽容的代价是**用户写错模型名时静默跑出 3.8 的答案且无任何征兆**
 * （不报错、不降级、答案就是不对，极难排查），故改为拒绝：未知 id 直接抛
 * `INVALID_REQUEST`，不发上游请求。带档位的 3.8 名（`gemini-3.8-flash-high`
 * 等，来自限流标记 / 探测链路）经 {@link geminiCanonicalModelId} 归一化后
 * 放行。
 * **加第二个模型时必须先用 `modelId` 选 upstream** —— 否则表里两个模型会撞车
 * （用户选 A、实际跑 B），症状与上述宽容完全相同。
 */
export declare function geminiModelSpec(modelId: string, effort?: string): GeminiModelSpec;
/**
 * 静态表条目 → DSH 的推理档位声明。
 *
 * ⚠️ 无档位时返回 `undefined`（**不声明**）—— 声明空数组会让面板显示一个
 * 点不开的空下拉框。与 `minimaxReasoningInfo` 同口径。
 */
export declare function geminiReasoningInfo(entry: GeminiModelEntry): LlmModelReasoningInfo | undefined;
/**
 * Gemini `FunctionDeclaration.parameters` 接受的键白名单。
 *
 * ⚠️ 白名单**之外**的键（`$schema` / `additionalProperties` / `default` /
 * `examples` / `$ref` …）必须整键删除 —— 上游对未知键是**硬 400**，
 * 而 harness 的工具 schema 由各工具自行声明，出现这些键是常态。
 */
export declare const GEMINI_SCHEMA_KEYS: ReadonlySet<string>;
/**
 * 递归清洗工具参数 schema（原版 `SanitizeGeminiSchema`）。
 *
 * 三条规则：
 * 1. 白名单外的键整键删除；
 * 2. `properties` / `items` / `anyOf` 递归清洗（`items` 可能是对象或数组）；
 * 3. `type` 为数组形态（如 `['string','null']`）时收敛成单个 type 并补
 *    `nullable: true`；`enum` 只要含**任何非字符串**值就整删（Gemini 只接受
 *    字符串枚举）。
 */
export declare function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown>;
/** 已内联的图片（`attachmentId` → base64 与 mediaType）。 */
export interface GeminiInlineImage {
    mediaType: string;
    /** **裸 base64**（不含 `data:` 前缀）—— `inlineData.data` 要的就是它。 */
    data: string;
}
/** 上游单张内联图片的体积上限（超出则整请求被拒）。 */
export declare const GEMINI_MAX_IMAGE_BYTES_INLINE: number;
/**
 * 请求体上限（发送前**真实检查**，见 `gemini-adapter.ts` 的发送点）。
 *
 * ⚠️ 2026-10-05：这个常量此前**定义了但全仓零引用** —— 看着有防护，实际没有。
 * 现已接上。超限归类走 `CONTEXT_WINDOW_EXCEEDED`（触发 harness 压缩重试）
 * 而不是 `INVALID_REQUEST`（死路）——理由与 `isGeminiContextOverflow` 同：
 * 归错码的代价不对称。
 */
export declare const GEMINI_MAX_REQUEST_BODY_BYTES: number;
/**
 * 校验 base64 是否可用（原版 `imagePart` 的口径）。
 *
 * ⚠️ 先做一次宽松清洗（去 `\n` / `\r` / 空格）再判 —— 上游接受带换行的
 * base64，但本地校验若不容忍换行会把**本来合法**的图片判死。
 */
export declare function normalizeBase64(data: string): string | undefined;
//# sourceMappingURL=gemini.d.ts.map