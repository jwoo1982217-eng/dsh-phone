import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import type { CodeArtsCredential } from './types.js';
export declare const CHAT_API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2";
export declare const PROVIDER = "codearts";
/**
 * 本家**恒声明**的两档思考开关 —— 顺序即**强度序（弱 → 强）**（Issue IKLIDV）。
 *
 * ## 为什么顺序是「关闭 → 开启」
 *
 * DSH 的契约把该数组当作**展示顺序**
 *（`dsh-llm/lib/types/types.d.ts` 原文：`Supported efforts in adapter-preferred
 * display order`），而官方客户端**直接 `map`、不排序**
 *（`dsh-client-ui-model-selection/lib/client.js` 的 `effortChoices`：
 * `[…, ...reasoning.efforts.map(…)]`）。故任何「把档位数组铺成一条轴」的渲染
 * —— 官方那个纵向 `menuitemradio` 列表、以及第三方横向滑条 —— 都直接吃这个顺序。
 *
 * 原实现写成 `['on','off']`（把默认档排在最前）。那个动机在**纵向列表**里成立，
 * 一旦铺成**横向轴**就变成「左强右弱」：「开启」贴最左、「关闭」贴最右，
 * 与「左弱右强」的直觉相反。
 *
 * 强度序的**唯一权威**是本仓库的 `reasoning-ladder.ts`
 *（`REASONING_EFFORT_RANK`：`off: 0` / `on: 5`）⇒ `off` 必须在前。
 * 三处旁证同向：
 * - DSH 自家 `dsh-llm-deepseek` 声明 `[off, low, high, max]`；
 * - DSH 自家 `dsh-llm-pi-ai` 的 `THINKING_LEVELS` 是
 *   `[off, minimal, low, medium, high, xhigh, max]`；
 * - 本仓库 `zcode-upstream.ts` 的 `orderReasoningLevels` **主动**把上游的
 *   乱序（实测插入序 `low, max, high`）排成 `none → minimal → low → … → max`。
 *
 * ⚠️ **`defaultEffort` 与数组位置是两件事**：默认档由 {@link CODEARTS_DEFAULT_EFFORT}
 * 单独表达，**不**靠「排在首位」。故本顺序的调整不改变任何默认行为。
 *
 * ⚠️ **本声明的顺序不参与任何语义判断**：关闭思考靠
 * `thinkingOffEffortOf` 的 `.find(isThinkingOffEffort)`（按 rank 找，不按位置），
 * `session-title` 那条路径也只用它当集合。
 *
 * ⚠️ **本常量是这两档的唯一定义处**：同一文件里原先写了**两份**逐字相同的
 * 数组（已知模型的 `toCatalogEntry` 与未知模型的 `unknownModelReasoning`）——
 * 那正是「一文件两套同义判据」的形态，改一处必漏另一处（用户手填模型 id 时会
 * 看到与已知模型相反方向的档位轴）。现已收敛到这一份。
 *
 * ⚠️ 网关的 `openai_efforts` 是这份顺序的**机械投影**
 *（`openai-gateway/effort-view.ts` 逐个 push `canonical`），故本顺序同时决定
 * `/v1/models` 里那一列的可读性：升序 ⇒ `["none","high"]`。
 */
export declare const CODEARTS_REASONING_EFFORTS: readonly {
    id: ReturnType<typeof ReasoningEffortId>;
    name: string;
}[];
/**
 * 默认思考档 = `开启`。
 *
 * 依据（实测 2026-09-29）：不传 `thinking` 与服务端默认等价，而服务端**默认就开着**
 *（`{type:'enabled'}` 与不传的 `reasoning_tokens` 落在同一基线）⇒ 标成 `on`
 * 是**如实描述**，不是我们强行改变行为。
 *
 * ⚠️ 必须落在 {@link CODEARTS_REASONING_EFFORTS} 内：DSH 在 `normalizeModelInfo`
 * 里校验「`defaultEffort` 必须是被声明过的 id」，不在则抛 **`INVALID_MODEL_REASONING`**
 *（整轮对话起不来）。
 * ⚠️ 别与 `UNSUPPORTED_REASONING_EFFORT` 混淆 —— 那个码是**另一回事**：
 * 指「**请求**里带的档位不在该模型声明内」（`resolveCallWithInfo` 抛）。
 * 审计实测（2026-10-14，`dsh-llm/lib/index.js`）：`defaultEffort='on'` 而
 * `efforts=[low,high]` ⇒ code 为 `INVALID_MODEL_REASONING`。本行原写
 * `UNSUPPORTED_REASONING_EFFORT` 是**张冠李戴**（同型措辞在 `raccoon-adapter.ts`
 * 与 `trae-adapter.ts` 是既有问题，本次只修这一处新增注释）。
 */
export declare const CODEARTS_DEFAULT_EFFORT = "on";
export interface CodeArtsAdapterOptions {
    credentialRef: CredentialRef;
    resolveCredential: () => Promise<CodeArtsCredential | undefined>;
    refresh: () => Promise<void>;
    /** 动态拉取远端模型列表；失败时调用方回退到静态列表。 */
    fetchRemoteModels?: () => Promise<Array<{
        id: string;
        name: string;
    }>>;
    /**
     * 最近一次目录拉取的**各来源成败**（issue IKJVTF，审计 I3）。
     *
     * CodeArts 的目录来自**两个独立端点**（`opengw gateway/config` 给 benefit 模型、
     * `snap-access /v1/model/builtin` 给常规模型），而失败路径都**静默**返回
     * `undefined` ⇒ 「一个成功、一个失败」时 `models.length > 0`，旧判据会把它
     * 当成「已拿到目录」⇒ **永久缓存**（短路）⇒ 残缺目录固化，只能重启 DSH。
     *
     * ⚠️ 用**回调**而非直接读 `service` 的内部状态：适配器不该依赖 `CodeArtsAuth`
     * 的字段形状（它由 `index.ts` 接线，且单测用替身）。接线层把它桥接成
     * 「读 `service.lastCatalogOutcome`」，见 `src/index.ts`。
     *
     * 返回 `undefined` 时按「无法判定」处理 —— 与 `normalizeLoadResult` 的
     * 向后兼容口径一致（`complete = got`）。
     */
    catalogComplete?: () => boolean | undefined;
    /**
     * 时钟（注入以便单测推进目录 TTL；缺省 `Date.now`）。
     *
     * ⚠️ 只用于**目录新鲜度**（`ensureRemoteModels` 的 `isCatalogFresh`），
     *    不用于超时/退避计时 —— 那些仍走真实时钟。
     *    ⚠️ **buddy 是例外**：它的 `catalogGate` 也吃这个时钟（冷却与
     *    「距上次尝试 ≥10 秒」判定都走它），所以别把本行当成全仓库通用口径。
     */
    now?: () => number;
    fetchImpl?: typeof fetch;
    chatId?: string;
    sessionId?: string;
    /** 多账号池（用于限流时切换账号） */
    accountPool?: AccountPool;
    /**
     * 远端目录**落地后**的通知回调（issue IKJVTF）。
     *
     * 由 `registerCodeArtsLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
     * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
     *
     * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
     * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
     * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
     */
    onCatalogLoaded?: () => void;
}
/**
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；`reasoning`
 * 块折叠为 `reasoning_content` 字段（deepseek-v4 等推理模型的后端
 * 校验要求 assistant 消息必须携带该字段，缺失会报 "Missing
 * `reasoning_content` field"）；工具结果（搭载在 harness 用户消息中）
 * 展开为独立的 `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 其余非文本块（图片）被丢弃，与端点接受的格式一致。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export declare function serializeMessages(messages: readonly {
    role: string;
    content: unknown;
}[]): Array<Record<string, unknown>>;
/**
 * 判断模型是否为 deepseek-v4 系列（flash/pro）。
 *
 * deepseek-v4 对标准 OpenAI 格式的 `tool_calls.arguments` 采用一次性打包
 * 生成：模型在生成超大工具参数（如 2000 行 write content）期间 SSE 流
 * 长时间无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），
 * 且后端不会对任何请求头发送心跳保活（实测 2026-08-22：无论是否携带
 * app-id/plugin-name/x-ot-* 等 IDE 头、是否带 `accept: text/event-stream`、
 * `tool_stream`、调整 `max_tokens`，SSE 流均无 `:` 注释行，60s 静默必断）。
 *
 * 但 deepseek-v4 原生支持 DSML 工具调用格式：工具调用直接写入
 * `delta.content`（形如 `<｜DSML｜tool_calls>...`），走与 reasoning 相同的
 * 流式通道。实测（2026-08-22 e2e 探测）：1000 行 write content 的 DSML
 * 流全程最大静默仅 204ms，146s 完整结束；标准 tool_calls 模式 100 行也
 * 会在 17.7s 静默后一次性到达、300 行即 60s 断连。因此对 deepseek-v4
 * 模型将工具 schema 注入 system 消息、请求体不发送 `tools` 字段，让模型
 * 以 DSML 流式输出工具调用，从根上规避网关空闲断连。
 */
/**
 * ⚠️ **已移至共享层 `./dsml.js`**（2026-10-13）。
 *
 * OfficeAce 通道复用不到本文件的实现 ⇒ 漏注入 DSML 提示 ⇒ 模型臆造
 * `<｜DSML｜ calls>` 语法。协议定义**必须只有一份**。
 */
export { isDeepseekV4Model, needsDsmlToolMode, buildDsmlSystemPrompt } from './dsml.js';
/**
 * 工具名匹配大参数写文件类工具（content/arguments 可能达到数万 token）。
 * 仅用于对非 deepseek-v4 模型的 DSML 模式降级判定（当前全量模式不再使用此列表）。
 */
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * deepseek-v4 模型始终走 DSML 模式（不论工具列表中包含什么工具），原因：
 * - 标准 `tool_calls` 模式要求参数一次性打包生成，SSE 流在生成参数期间长时间
 *   无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），且后端不对
 *   任何请求头发送心跳保活；
 * - 除 write/file_write/apply_patch 外，`subagent` 的 `prompt` 参数也可能很长
 *   （包含详细任务描述与上下文），同样面临网关断连风险；
 * - DSML 模式使工具调用通过 `delta.content` 流式输出（全程有数据流），从根上
 *   规避网关空闲断连，实测 1000 行 write content 的 DSML 流全程最大静默仅
 *   204ms，146s 完整结束；
 * - 模型行为统一，避免不同步骤间标准/DSML 模式切换引入的不一致。
 *
 * 非 deepseek-v4 模型（如 openpangu / GLM-5.2 等）使用华为标准 IAM AK/SK 鉴权，
 * 不走 CodeArts Agent APIG 网关，无 60s 空闲断连问题，继续保持标准 tool_calls。
 */
/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export declare const QUEUE_STATUS_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status";
/**
 * 把「距重置还有多久」格式化成中文短句。
 *
 * 用户需求（2026-10-02）：「其它渠道限额到了会提示多少时间后会解除限额，
 * 这个 codearts 的也加上吧」—— 其它渠道（buddy / workbuddy）由**服务端**
 * 在错误文案里给出重置时刻，故 `parseRateLimitError` 能解析；CodeArts 的
 * benefit 额度报文里**没有**任何时间字段（实测 `InferHub.4291.200` 的
 * `details` 只有 requestId / timestamps / modelId / traceId），因此按
 * **UTC+8 自然日**自行推算（见 {@link codeartsQuotaExhaustedMessage}）。
 *
 * @param resetAtMs - 解禁时刻（UTC 毫秒）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export declare function formatResetIn(resetAtMs: number, nowMs?: number): string;
/**
 * 额度用尽时给用户看的完整说明（**含解禁时间**，这是用户明确要求的）。
 *
 * ## 为什么按「UTC+8 次日 00:00」推算
 *
 * CodeArts 的 benefit（免费额度）模型（`glm-5.3-flash` / `deepseek-v4.1-flash`）
 * 额度按**自然日**结算（IDE 模型卡标注「每日 1000 万免费 Tokens」），而
 * `InferHub.4291.200` 的报文里**不给重置时刻**。故与 `qoder` / `zcode` 的
 * 额度处理同款：复用 {@link nextUtc8DayStartMs} 取 UTC+8 当日 24:00，
 * **不能**复用 `parseRateLimitError`（它解析不到时间时退回「1 小时后」，
 * 对按日结算的额度会让标记过早失效，用户 1 小时后再撞一次同样的墙）。
 *
 * ⚠️ 措辞对「这是我们的推算」保持诚实：写「预计」，不谎称是服务端给的时间。
 *
 * @param model - 请求的模型 id（用户据此决定换哪个）。
 * @param resetAtMs - 推算出的解禁时刻。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export declare function codeartsQuotaExhaustedMessage(model: string, resetAtMs: number, nowMs?: number): string;
/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
    readonly status: 'waiting' | 'working' | 'error' | 'queue_full';
    readonly queuePosition: number;
    readonly message: string;
}
/**
 * 判断 SSE 流内返回的 error_code 是否属于**可重试**的排队/限流错误。
 *
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 *
 * ## ⚠️ 判据必须锚定「429」这个**独立数字**，不能用裸子串（真实缺陷）
 *
 * 原实现写作 `/81111|TPM|429|rate.?limit|…/`，其中 `429` 是**无边界子串**匹配，
 * 于是额度耗尽码 `InferHub.4291.200` 里的 `4291` **命中了 `429` 前缀** ——
 * 被误判成「可重试的排队限流」，进入每 10 秒重试、上限 180 次（30 分钟）的
 * 静默重试循环。
 *
 * 实测（2026-10-02，用户在本机真实凭据上的会话）：
 * ```
 * isSseQueueErrorCode('InferHub.4291.200') === true    ← 误判
 * 匹配到的子串: "429"
 * ```
 * 后果是**界面完全无输出**：`stream()` 在排队期间刻意不产出任何内容块
 * （见下方排队循环的长注释），而它误以为自己"在排队"。实测真实适配器
 * 25 秒内发出 4 次 chat 请求 + 3 次排队探测、**产出 0 个 chunk**，最终由
 * 用户手动中止（会话记录里是 `turn/end aborted` + `stream: []`，**没有任何
 * error 事件** —— 因为错误根本没被抛出）。这正是用户报障的「CodeArts Agent
 * 没反应」。
 *
 * ⇒ 现在 `429` 用 `(^|[^0-9])429([^0-9]|$)` 锚定为独立数字：`…81111.429`（结尾）
 * 与 `429 Too Many Requests`（后接空格）仍命中，而 `4291` 不再命中。
 * 额度耗尽的 `4291` 由 {@link isSseQuotaExhaustedErrorCode} 单独识别。
 *
 * 导出仅供单测直接锁定「`429` 的边界」这一判据本身 —— 若只靠调用点的先后顺序
 * （额度判据排在排队判据之前）来兜住 `4291`，那么把边界改回裸子串时**任何**
 * 端到端用例都不会变红（实测确认过），边界就成了没人守的装饰。
 */
export declare function isSseQueueErrorCode(code: string): boolean;
/**
 * 判断 SSE 流内返回的 error_code 是否表示**额度已用尽**（不可重试）。
 *
 * 实测报文（2026-10-02，真实凭据）：
 * ```
 * HTTP 200  data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",
 *                 "details":[…requestId…timestamps…modelId: deepseek-v4.1-flash…traceId…]}
 * ```
 * 同账号的 `deepseek-v4-flash`（非 benefit 通道）仍正常出流 —— 故这是
 * 「该模型 + 该账号的免费额度用尽」，不是账号欠费（同期 `statistics/plugin`
 * 显示积分余额仍有 8499.84）。
 *
 * 与「排队/限流」是**本质不同**的两件事，绝不可合并（同 `qoder` 的
 * `10605` 排队 vs `110` 额度那次教训，见 `AGENTS.md`）：
 *
 * | | 排队/TPM 限流 | 额度用尽 |
 * |---|---|---|
 * | 语义 | **暂时**受阻，等一会儿就通 | **额度真的没了**，重试无意义 |
 * | 处理 | 内部等待后重试 | **立即失败**并如实告知 |
 *
 * 判据用**子串** `4291`（而非全等）是刻意的：该码由服务端下发，本地产物里
 * 没有硬编码（同 `qoder` 的 `110`），若上游改用 `InferHub.4291.xxx` 的其它
 * 尾号表达同一语义，只认全等会漏判。`4291` 与排队族的 `81111` / 独立的
 * `429` 均不冲突。
 *
 * 文案兜底（`insufficient quota`）不可省：万一上游换了码值，序列化后的
 * detail 文本仍能命中 —— 与 `zcode` / `qoder` 的既有做法一致。
 */
export declare function isSseQuotaExhaustedErrorCode(code: string, message: string): boolean;
/**
 * HTTP **4xx** 报文里是否表示「该账号没有 benefit（免费额度）包」。
 *
 * ## 为什么需要它（Gitee issue IKLBSH A6）
 *
 * 同一个上游条件走**两条**通道下发：
 *
 * | 通道 | 形态 | 修复前 |
 * |---|---|---|
 * | SSE | HTTP 200 + `{error_code:"InferHub.4004.200", …}` | ✅ 已接（`consumeSse` 抛 `BENEFIT_NOT_FOUND_CODE`）|
 * | HTTP | **4xx** + 同一码 | ❌ **未接** ⇒ 去头重试一次也不试，直接归 `INVALID_REQUEST` 抛出 |
 *
 * 「SSE 能自愈、4xx 却硬报错」＝同一个语义两套判据，正是本仓库首条红线的形态。
 *
 * ⚠️ **该缺陷已被独立锁定**：`origin/issue/IKJOF7-benefit-diagnostics` 分支
 *（2026-10-05）用 `it.fails` 显式锁死了它（「HTTP 4xx + 正文含
 * `InferHub.4004.200` 时也应当去头重试」），当时结论是「已确认，但本分支不修」。
 *
 * ⚠️ **判据复用同一个码值常量**（`CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE`），
 * 不另写第二份 —— 与 SSE 通道的判据（`consumeSse` 的 `===` 比较）**同源**，
 * 否则两条通道会在上游改码时分别漂移（这正是本缺陷的成因形态）。
 *
 * ⚠️ 与 {@link isSseQuotaExhaustedErrorCode} 的 `4291` **刻意不同**：那条腿用
 * 子串是为了容忍 `InferHub.4291.xxx` 的其它尾号，而 `4004` 这一族里
 * **没有证据**表明其它尾号是同一语义（`4004.200` 是实测唯一的 benefit 码）。
 * 按证据收紧到**全等**：放宽成 `InferHub.4004.` 前缀会把该族里未知语义的
 * 报文也变成可重试，属行为变更。将来真抓到别的尾号**再按实测放宽**。
 *
 * ⚠️ 不解析 JSON 而直接判原文：4xx 的报文形态与 SSE 不同（字段名可能不叫
 * `error_code`），这正是上面那条注释记录的教训。
 */
export declare function isBenefitNotFoundBody(body: string): boolean;
/**
 * 从错误体提取可分类的 detail 文本（OpenAI 风格 error 或 CodeArts error_code/error_msg）。
 *
 * ⚠️ **本次只「加腿」，且如实标注证据强度**：新增顶层字符串 `error` 一条。
 *
 * 该项的**证据是「同族实现已修」+「形态确实无法解析」，不是 codearts 的线上实录**
 * （141 个真实会话里没有 codearts 的 `{"error":"<字符串>"}` 报文）——
 * `src/openai-compat.ts` 的**同名函数**早已修过这个形态，其注释写明
 * 「只认 code/message/msg 会把整个 JSON 原样返回，用户看到一坨不可读的裸 JSON」，
 * 而本文件的这份没跟上（「一文件两套同义判据」是本仓库点名的复发形态，
 * 两处改一处时**必须同时改另一处**）。
 *
 * 之所以加：该形态在本份实现里**必然**退化成整段裸 JSON（`parts` 为空 ⇒
 * `return body`），而修法是把另一份已被验证的腿搬过来，零新增取舍 ——
 * 与 `httpErrorCode` 那次「调整判据优先级」不同，这里**不改变任何已有分类**，
 * 纯属补齐漏掉的形态（codearts 的 `errorDetail` 与 OpenAI 兼容报文同源）。
 *
 * ⚠️ **绝不「减腿」**：原有的 `error.code` / `error.type` / `error.message` /
 * `error_code`+`error_msg` / 顶层 `message` 五条**必须全部保留** ——
 * OpenAI 形态常把额度语义写在 `{"error":{"code":"insufficient_quota"}}` 里，
 * 少了 code 那条腿，该报文会从额度**掉回** `AUTH`/`INVALID_REQUEST`
 * （实测：`isQuotaExceededError` 对 `insufficient_quota` 为 true，
 * 但只有在它被拼进 detail 时才生效）。改的第一版真的把几条腿一起删了。
 *
 * ⚠️ **导出仅供单测直接锁定「形态覆盖」这一判据本身**（与
 * {@link isSseQueueErrorCode} / {@link isSseQuotaExhaustedErrorCode} 同款惯例）。
 * **不要**绕道「分类结果」去测它：`{"error":"insufficient balance"}` 这种报文，
 * 即使字符串腿失效、函数退回整段 JSON，**整段 JSON 里也含该短语** ⇒
 * 额度判据照样命中 ⇒ 那是**假守卫**（实测确认过，第一版就是这么错的）。
 * 直接断言本函数的**返回值**才测得到那条腿。
 *
 * ## ⚠️⚠️ 本函数是**展示**出口；分类出口是 {@link errorDetailForClassify}
 *
 * 无条件把 `detail` 计入产物会**翻转错误码**（真实净回归，两轮审计独立确证）：
 *
 * | 报文 | 只算既有腿 | 加上 detail 腿 |
 * |---|---|---|
 * | `{"message":"bad request","detail":"insufficient quota"}` | `INVALID_REQUEST` | **`QUOTA_EXCEEDED`** |
 * | `{"message":"bad request","detail":"prompt is too long for this model"}` | `INVALID_REQUEST` | **`CONTEXT_WINDOW_EXCEEDED`** |
 *
 * 后者还会**触发 DSH 的上下文溢出压缩**。本函数是 `httpErrorCode` 与 4xx 额度判据
 * 的**唯一分类输入** ⇒ 那两处**必须**改走 {@link errorDetailForClassify}，
 * 否则一个纯展示改进会静默改变分类行为（且我加的用例只断言返回值，零分类守卫）。
 *
 * ⚠️ **本份（codearts）与 `openai-compat.ts` 那份是同名不同实现**，
 * 两条出口的语义必须两处一致。
 */
export declare function errorDetail(body: string): string;
/**
 * 从错误体提取**分类用**的可读文本 —— **不含**顶层 `detail` 字段。
 *
 * ⚠️ 分类调用点（`httpErrorCode` / `isSseQuotaExhaustedErrorCode`）**必须**走本出口：
 * 它保证分类输入与「加 detail 腿之前」**逐字节相同**（见 {@link errorDetail} 的实测表）。
 */
export declare function errorDetailForClassify(body: string): string;
/**
 * 华为 API 网关（APIG）**瞬时**签名故障的判据。
 *
 * 报文形态（用户报障 2026-10-03 的会话日志原文）：
 * `401 APIG.0301 Incorrect IAM authentication information: calc ak sk
 *  signature fail:body hash mismatch x-sdk-content-sha256 header`
 *
 * 为什么必须单独判它：这句说的是「网关收到的正文哈希 ≠ 我方
 * `x-sdk-content-sha256` 头」，**与 AK/SK、security_token 都无关**。
 * 本模块的签名实现（`sign.ts`）用**同一份字节**算哈希与发请求
 * （`signRequestHuawei(…, new TextEncoder().encode(body), …)` 的入参与
 * 传给 `fetch` 的 `body` 是同一个字符串）⇒ 本方不存在能把两者算岔的路径。
 * ⚠️ 这一点是**读码推导**，不是逐请求实测：仓库里没有对应的探针脚本。
 * 2026-10-19 审计已复核该不变量本身成立（空串 / 中文 / emoji /
 * 20 万字符 / 组合字符 5 组样本的 `sha256(body)` 与头恒等），但当时引用的
 * 「已用探针逐请求核对过」在本仓库**不存在** —— 按证据强度如实标注。
 *
 * 处置：直接重发（见 `SIGNATURE_RETRY_MAX`），**不要**刷新凭据 ——
 * 凭据与此故障无关，刷新只是白跑一次网络往返；
 * 也就不能让它落入 {@link isAuthError} 的「静默 refresh + 重发」分支。
 *
 * ⚠️ 判据刻意只认 `body hash mismatch`：`APIG.0301` 的另一半
 * （`verify ak sk signature fail`）**同时覆盖真实的 AK/SK 错误**
 * （`AGENTS.md` 记录了把 `Agent-Type` 误当签名头传入也会得到它），
 * 按它放宽会把真凭据问题误判成瞬时故障、让用户永远等不到「请重新登录」。
 */
export declare function isTransientSignatureFailure(status: number, body: string): boolean;
/**
 * DSML 工具调用格式提取器。
 *
 * 某些模型（如 deepseek-v4）在未通过 `tools` 字段告知工具模式、或工具
 * 模式与模型训练格式不匹配时，会把工具调用以原生 DSML XML 风格直接写入
 * `delta.content`，形如：
 *   `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">
 *    <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
 *    </｜DSML｜invoke></｜DSML｜tool_calls>`
 * 适配器若原样作为 text-delta 输出，原始 token 会泄漏到 web UI（表现为
 * "dump 出奇怪的一段内容后终止"）。本提取器以流式状态机从 content 增量
 * 中识别完整 DSML 块并解析为结构化 tool-call；非 DSML 文本原样放行，
 * 保持流式输出不阻塞。
 *
 * 同时支持 DeepSeek-V4 Thinking 模式：模型在工具调用前会把推理过程包裹
 * 在 `<thought>...</thought>` 标记中写入 `delta.content`。本提取器把
 * `<thought>` 内容作为 reasoning 增量流式输出（与 `delta.reasoning_content`
 * 行为一致，显示在 web 的 Think 区域而非正文），避免推理文本泄漏到用户
 * 可见区域。参考 DSML 官方介绍：
 * https://blog.csdn.net/gitblog_00855/article/details/152146045
 *
 * 设计要点：
 * - 增量友好：content 可能跨多个 SSE chunk 分片到达，提取器维护内部
 *   缓冲区与多模式状态机（normal / in-thought / in-dsml），仅对已完成
 *   的 DSML 块产出 tool-call；reasoning 增量流式输出；未完成部分保留
 *   到下次 feed；非 DSML/thought 文本立即 flush，避免延迟。
 * - 容错：若缓冲区包含开标签前缀但长时间未闭合，且后续内容不像该标签
 *   （例如只是普通文本里碰巧出现该前缀），在 flush 时把残留作为纯文本
 *   输出，避免吞掉用户可见内容。
 * - 边界：DSML 标签使用全角 `｜`（U+FF5C）而非半角 `|`，与模型实际
 *   输出一致。`<thought>` 为半角普通 XML 标签，与 DSML 官方文档一致。
 */
/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export declare class CodeArtsAdapter extends LlmAdapter {
    private readonly options;
    private readonly fetchImpl;
    private readonly chatId;
    private readonly sessionId;
    /**
     * ⚠️ **2026-10-08 Task 7b：三个方法收敛到共享骨架** `createModelCatalog`。
     * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
     * 现在只剩 `toCatalogEntry`（本家私有形状 + VL 过滤 + 静态 context 表）。
     */
    private readonly catalog;
    constructor(options: CodeArtsAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
     * 入参异常时回退到 PROVIDER 常量，避免客户端抛
     * `undefined.toUpperCase is not a function`。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /**
     * 已落缓存的目录是否**所有来源都取全**（issue IKJVTF，审计 I3）。
     *
     * ⚠️ **这是短路判据的第二半**：CodeArts 有两个目录端点，残缺目录也落
     * `remoteModels`，故只判「已定义」会让残缺永久固化（见 `ensureRemoteModels`）。
     */
    private remoteComplete;
    /**
     * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
     *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
     */
    private catalogAt;
    /**
     * 目录加载闸门：并发去重 + 失败冷却。
     *
     * ⚠ **不能省**：DSH 的 `buildModelCatalog` 对每个 provider `await listModels()`
     * 后再对每个模型 `await resolveModelInfo()`，两处都会走到这里。原实现失败
     * 直接返回（不落缓存）⇒ 一次网络故障被放大成「每模型重试一次」，每次顶着
     * 10s 超时（`src/models.ts FETCH_TIMEOUT_MS`），首屏因此长时间空转。
     */
    private readonly catalogGate;
    /**
     * 懒加载远端模型目录（**每 20 分钟**重新拉一次，用户 2026-10-18 的要求）。
     *
     * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样触发远端拉取。
     */
    private ensureRemoteModels;
    /**
     * 完整模型目录（**不应用用户黑名单**）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
     * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
     *
     * ⚠️ **2026-10-08 Task 7b**：骨架已上移到 `src/model-catalog.ts`，此处只剩委托。
     * ⚠️ 本家有一处**特有**的「可见性过滤」（VL 多模态不参与，见 `toCatalogEntry`），
     * 它在 `listModels` 与 `listAllModels` **两条路径上都要生效** ——
     * 故放在 `toCatalogEntry` 之前的取数回调里（`catalogEntries()`）。
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
     * 把本家条目转成共享骨架的中间结构。
     *
     * ⚠️ 本家三处**真实差异**（不要「顺手统一」）：
     * 1. **VL 多模态不参与目录**（`-VL-` / `-VL` 结尾的 id 被滤掉）——
     *    这是本家的可见性判据，骨架不认识；
     * 2. `contextWindow` 来自静态 `CONTEXT_WINDOWS` 表（不是远端字段）；
     * 3. `reasoning` 是**恒声明**的两档（关闭/开启，**强度序**），与 entry 无关 ——
     *    实测（2026-09-29）：本网关**唯一**真正生效的思考控制是顶层
     *    `thinking.type`，`reasoning_effort`（含 low/high/none/minimal）与嵌套
     *    `reasoning.effort` 都被服务端接受但**完全无效果**（判据为服务端上报的
     *    `reasoning_tokens`，落在基线噪声内；`none` 也照常思考）。
     *    故**不**臆造 low/high/max 强度阶梯。
     */
    private toCatalogEntry;
    /**
     * 本家全部条目（**含 VL 可见性过滤**）。
     *
     * ⚠️ `await this.ensureRemoteModels()` 是**必需**的（不是可选优化）：
     * 早期实现用 `void` 丢弃 Promise，冷缓存时远端目录尚未落地就走静态兜底表，
     * 模型选择器会短暂显示错误的模型集合（Jet Hub 的模型开关也据此渲染，
     * 会造成「关掉的模型又冒出来」）。
     */
    private catalogEntries;
    /**
     * 同步视图（`listAllModels` 用）。
     *
     * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读 `remoteModels`
     * 缓存，未落地时回退静态兜底表（这正是原实现的语义）。
     */
    private syncCatalogEntries;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
     *
     * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
     * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
     * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
     * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
     * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
     * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
     * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
     */
    private consumeSse;
    /**
     * 查询某个会话的 CodeArts 并发队列状态。该端点
     * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
     * @param credential - 用于签名请求的 AK/SK/SecurityToken。
     * @param model - 模型 id，作为 `model` 查询参数回传。
     * @param signal - 状态请求的取消信号。
     * @returns 解析后的排队状态，或当端点不可达
     *   或返回无法识别的载荷时返回 `undefined`。
     */
    private queryQueueStatus;
}
/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export declare function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter;
/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * ## 它必须与额度限流（6004）分开（真实报障，2026-10-05）
 *
 * 用户第一次用 `buddy/space-bunny` 就报「模型 space-bunny 所有账号均受限」。
 * 直连实测（`scripts/probe-buddy-error-catalog.mjs`）逼出了服务端原话：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ **它自己就说明了「这不是账号问题」**（注意 `actions` 里根本没有换号的选项，
 * 只有 `SWITCH_MODEL`）。但 `isRateLimited` 对 **429 无条件返回 true** ⇒
 * 适配器把每个账号都写上「1 小时限流」标记（报文无「将在…重置」，
 * 故取 `RATE_LIMIT_FALLBACK_MS` 兜底）⇒ 4 个独立账号在 20 秒内**全部**被锁
 * ⇒ 用户等到 1 小时也不能用，且**期间连别的模型都受影响**（同一个账号池）。
 *
 * 实测证据（同型缺陷的判据来源）：
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个不同腾讯 uid 的账号 | 20 秒内**全部**被标记 `space-bunny` |
 * | 标记解禁时刻 | 全部等于「写入 + 整 1 小时」= 兜底值，**非**服务端给的时刻 |
 * | 4 MB 输入 | 稳定逼出 `429 / 14003`（46~111 秒才返回） |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s —— 上游是**时变**背压 |
 *
 * ⇒ 「4 个互不相干的账号同时中招」在账号级限流下无法解释，**只能**是模型级。
 * 与 zcode `3009 model concurrency limit exceeded` 同型（那边结论同样是
 * 「退避重试，**不换号、不标记**」）。
 *
 * ⚠️ **不许把 14003 并进 `RATE_LIMIT_BUSINESS_CODE`**：两者的正确动作相反 ——
 * 6004 是「这个账号在这模型上的额度用完了」（换号有效、必须标记）；
 * 14003 是「这个模型此刻整体饱和」（换号**无益**、**不许**标记）。
 */
export declare const MODEL_SATURATION_BUSINESS_CODE = 14003;
/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ## 为什么这个区分是**行为分叉**而不是措辞问题
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 *
 * 实测 `actions` 字段本身就写着 `SWITCH_MODEL` 而**没有**换号选项 ——
 * 服务端与我们的结论一致。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里（这正是缺陷的成因，见常量注释）。
 *
 * @param status - HTTP 状态码。为 `undefined`（只有文案可判）时仍检查业务码；
 *   但**文案分支要求状态码 ≥ 400** —— 否则一段正常正文里出现「模型繁忙」
 *   就会被判成错误。
 * @param body - 响应体（可能为空串）。
 */
export declare function isModelSaturationError(status: number | undefined, body: string): boolean;
/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param body - 响应体（可能为空串）
 * @param status - HTTP 状态码（可选，但**手里有 Response 就必须传**）。为 `429`
 *   时无条件判为限流，即使响应体为空、不含任何可识别文案。
 *
 * ⚠️ **`status` 判据是真实缺陷的修复，不是可选便利**：本函数原先只接收响应体，
 * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 此时
 * `hasRateLimitBusinessCode` 与 `RATE_LIMIT_PATTERN` **双双不命中**，函数返回
 * `false`，于是适配器里整段「记录重置时间 + 切换账号」逻辑被**整体跳过**，
 * 把一个本可自愈的限流直接抛给用户（表现为「账号池里明明还有可用账号，插件却
 * 报错且不换号」）。
 *
 * 判据顺序刻意是「状态码优先」：429 是 HTTP 语义上**唯一**的限流信号，无需也不应
 * 再去猜文案；下面的文案 / 业务码兜底只服务于「状态码不是 429、但正文表达了限流」
 * 的场景（业务码 6004、SSE 流内错误、网关包装过的 200/400）。
 *
 * ⚠️ 反向的约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成「所有账号均受限」，
 * 用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export declare function isRateLimited(body: string, status?: number): boolean;
/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据 —— 静默跳过记录会让用户既看不到限流、也无从操作。
 *
 * ⚠️ 1 小时是**快照式**兜底（标记可被重测刷新），与 `BUDDY_POLICY_BLOCK_COOLDOWN_MS`
 * 的 30 分钟**语义不同**（那是「安全策略拦截」的本地冷却，报文里根本没有时间字段），
 * 也与 Qoder「按自然日 24:00」不同（那是按日的额度结算）。三者不要合并成一个常量。
 *
 * 导出是给 `buddy-adapter` 用的：它需要在**没拿到可解析体**时也能写出标记，
 * 且必须与这里 `parseRateLimitError` 的兜底**同值**，否则两处口径会漂。
 */
export declare const RATE_LIMIT_FALLBACK_MS = 3600000;
/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param status - HTTP 状态码（可选）。为 `429` 时即使**体为空、或无任何可识别文案**
 *   也按兜底时长返回一条，避免调用方「识别出限流却没有标记可写」（见
 *   {@link RATE_LIMIT_FALLBACK_MS} 的说明）。
 */
export declare function parseRateLimitError(body: string, currentModel: string, status?: number): {
    modelId: string;
    resetTimeMs: number;
} | null;
//# sourceMappingURL=llm-adapter.d.ts.map