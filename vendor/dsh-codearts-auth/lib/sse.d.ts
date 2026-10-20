/**
 * SSE 流读取与工具参数归一化的共享工具。
 *
 * codearts 与 buddy 两个适配器都消费 OpenAI 风格的 SSE chat 响应，并面临
 * 同一类后端行为：网关在连接空闲一段时间后静默掐断，或模型在生成大工具
 * 参数期间长时间不 flush 任何字节。若不主动检测空闲，`reader.read()` 会
 * 无限期挂起——适配器的 generator 永不返回，harness 当前步骤既不出结果
 * 也不报错"，web 端表现为后续指令无响应。主动超时并把失败归类为可重试的
 * TIMEOUT，harness 才能重试该步骤，把控制权交还给用户。
 */
import type { FinishReason } from '@deepseek-ai/dsh-llm';
/** SSE 读取阶段：等待首 token 与已收到数据后的 chunk 间等待。 */
export type SsePhase = 'first-token' | 'chunk';
/**
 * 在空闲超时内读取一个流块。超过 {@link timeoutMs} 无数据则取消
 * reader 并抛可重试的 `LlmError('TIMEOUT')`——比被动等待网关掐断更早
 * 失败，且归类为可重试 code。尊重用户传入的 {@link signal}：若已 abort
 * 则直接抛 abort 原因，不误报超时。
 *
 * @param label - 提供者标签，仅用于错误消息前缀（如 'codearts' / 'buddy'）。
 * @param phase - 仅用于错误消息区分首 token 超时与 chunk 间超时。
 */
export declare function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, label: string, signal?: AbortSignal, phase?: SsePhase): Promise<{
    done: boolean;
    value: Uint8Array | undefined;
}>;
/**
 * 把工具调用的 arguments 文本归一化为合法的 JSON 对象字面量。
 *
 * 后端在两种情况下会给出非对象的 arguments：
 * - 无参数工具只下发一个空分片（`"arguments":""`），拼接结果为空串；
 * - SSE 流被截断（连接中断 / 网关掐断），只收到半截 JSON。
 *
 * 两者都会让 harness 解析参数时报
 * `invalid arguments: "arguments" must be an object`，并把会话卡在错误态
 * ——web 后续"继续"指令无响应。归一化为 `{}` 后，缺少必填
 * 参数的工具会走正常的 schema 校验错误并回传给模型，由模型重新发起调用，
 * 而不是让整个会话崩溃。
 */
/**
 * 工具名是否可用（非空字符串）。
 *
 * ⚠️ **不能用 `String(name).length > 0` 代替**：`undefined` / `null` 经 `String()`
 * 会变成 `"undefined"` / `"null"` 这类**非空**字符串，于是"缺名字"被误判成
 * "有名字"，原样发给上游照样 400。判据必须落在原始值上。
 */
export declare function hasUsableToolName(name: unknown): boolean;
/**
 * 判断一次响应是否为「零内容块」的退化补全，并给出 DSH 约定的 finish reason。
 *
 * ## 为什么必须有这条判据
 *
 * DSH 的 `EMPTY_RESPONSE` 契约（`dsh-llm/lib/index.js`）：
 *
 * > Providers occasionally emit a degenerate completion (a terminal stop with zero
 * > output); adapters classify it as this failure instead of yielding an empty
 * > assistant message, because **an empty message silently ends the turn with
 * > nothing for the user or the loop to act on**. The attempt produced nothing
 * > durable, so retry policy treats it as safe to repeat.
 *
 * 官方适配器 `dsh-llm-deepseek` 的写法（权威范本）：
 *
 * ```js
 * reason.kind === 'stop' && order.length === 0
 *   ? { kind: 'error', failure: { message: '…no content', code: EMPTY_RESPONSE_CODE } }
 *   : reason
 * ```
 *
 * ⚠️ **本判据是「压制纯空白思考」的必要配套**（Task 2 审查发现、控制方实测证实）：
 * 压制空块后，若该响应本来**只有**那个空白 reasoning 块（无 text、无 tool-call），
 * 就会产出「零块 + `finish: stop`」—— 正是上面契约要防的**静默结束**，
 * 与本项目已两次踩过的同族坑（空名 `tool_call`、死循环）完全同型。
 * 实测真实频率：**1 / 30404**（`scripts/quantify-empty-response-risk.ts`）。
 *
 * ## 只覆盖「否则会落到 stop」的情形
 *
 * 传入的 `reason` 若不是 `{kind:'stop'}`（例如已是 `max-tokens` / `tool-calls`），
 * **原样返回** —— 那些 reason 本身就表示「有不完整/有产出」，语义更具体，
 * 不应被泛化的零块判据覆盖（与官方范本一致：只在 `kind === 'stop'` 时才改写）。
 *
 * ## ⚠️ `code` 必须用 `EMPTY_RESPONSE_CODE` 常量，不得写字面量
 *
 * 重试资格由**字符串匹配**决定（`dsh-llm` 的 `resolveRetryPolicy` →
 * `policy.retryableCodes.includes(failure.code)`，默认集合含 `EMPTY_RESPONSE`）。
 * 硬编码 `'EMPTY_RESPONSE'` 一旦与上游常量漂移（改名、改前缀、加命名空间），
 * 匹配**静默失败** —— 于是本修复要消灭的「静默结束」会以「静默不退避重试」
 * 的形式原样回来，且编译期与测试都不会报错。
 * 根导出可用性已确认（`@deepseek-ai/dsh-llm` 的 `lib/index.js` 第 217 行
 * 即把 `EMPTY_RESPONSE_CODE` 放进 `DEFAULT_RETRYABLE_CODES`）。
 *
 * @param reason - 各适配器已算出的 finish reason。
 * @param blockCount - 本次响应**实际产出**的块数量（不含被压制的空块）。
 * @returns 零块且原为 `stop` 时返回 `error`/`EMPTY_RESPONSE`，否则原样返回。
 */
export declare function resolveEmptyResponseReason(reason: FinishReason, blockCount: number): FinishReason;
/**
 * 行首空白思考（`trim()` 为空）的累积器。
 *
 * 为什么需要它：模型偶发只输出一个空格当思考（实测 2232 次，
 * `reasoningTokens=1`），会落成空 Think 块污染 UI 与提示词。
 * 而 `BlockAssembler` 在没有 `block-end` 时会用 `partial.text` 组装出块，
 * 故**不能**只在出口过滤 —— 必须从一开始就不发 chunk。
 *
 * ⚠️ 本 helper **不产出 chunk 对象**（它不该知道 `index`），只告诉调用方
 * 「该不该发、发什么文本」。调用方负责组装 `block-start` / `reasoning-delta`
 * 并写入 `block.text`。这样 `index` 的分配仍完全由调用方的 `nextIndex++` 掌控。
 *
 * 判据落在**整块**而非单片上：只有迄今累积文本 `trim()` 为空才压制；
 * 一旦整块出现过非空白字符，后续空白片就是**普通增量**，照常发出
 * （故 `["a", " "]` 的整块 `'a '` 被完整保留）。
 */
export declare function createBlankReasoningSuppressor(): {
    /**
     * 喂入一个 reasoning 增量，返回**该发出的 delta 文本**：
     * - `undefined`：本片不产出任何 chunk（整块迄今仍是空白）；
     * - `string`：应发一个 `reasoning-delta`，文本为返回值。
     *   其中「从空白转为非空白」的那一次，返回值是**已累积的全部文本**
     *   （因为此前一片都没发过，必须补发），且调用方须**先发 `block-start`**。
     *
     * ⚠️ 参数名 `text` 与下方同名方法 `text()` **不是一回事**：函数体内 `text`
     * 指本参数（增量），要取整块累积请调 `this`/闭包外的 `text()`。接线时别混。
     */
    feed(text: string): string | undefined;
    /** 整块迄今的完整文本；`''` 或 `trim()` 为空 ⇒ 整块应丢弃（不得发 `block-end`）。 */
    text(): string;
};
/**
 * 剔除无法配对、或**名称不可用**的工具调用与工具结果。
 *
 * ## 两类必须剔除的坏数据
 *
 * ① **配对缺口**：OpenAI 兼容协议要求带 `tool_calls` 的 assistant 消息，
 * 其**每一个** tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；
 * 反之 `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
 * 400 拒绝整个请求。工具执行失败时（参数非法、超时、工具不存在……）harness
 * 会把 assistant 的 tool_calls 持久化进会话历史，却写不回结果消息。
 *
 * ② **名称为空 / 缺失的 tool_call**（2026-09-23 定位，用户报障）：
 * 会话历史里出现 `{type:'tool-call', id:'call_…', name:'', arguments:'{}'}`
 * 时，workbuddy 以 **HTTP 400 `code 11133 model_param_invalid`** 拒绝整个请求
 * （错误文案只说"请求参数不符合当前模型要求"，**不指出是哪个字段**，极难排查）。
 * 实测最小复现（`scripts/confirm-empty-tool-name.ts`）：
 *
 * | wire 上 `function.name` | 结果 |
 * |---|---|
 * | `"read"` | 200 |
 * | `"unknown_tool"`（不存在的工具名） | 200 ← **只校验"非空"，不校验存在性** |
 * | `""` / `null` / 缺失 | **400 code 11133** |
 *
 * 与配对缺口的关键差异：**空名字即使配对完整也照样 400**，且报的是
 * 11133（参数非法）而非 11148（配对不匹配），两者成因完全独立。
 *
 * 来源是 qoder 的 SSE：模型偶发吐出一个**完全没有 name 字段**的 tool-call
 * 分片（实测 seq=693 的 `{index:2, id:'call_25e9…', args:[""]}`），
 * `consumeOpenAiSse` 在 block-end 处 `name: block.name ?? ''` 把它落成空串块，
 * harness 执行得到 `unknown tool ""` 并把这条坏块**持久化进会话**。
 * 此后用户一旦切换到 workbuddy（或任何腾讯系端点），该坏块被**每次请求原样重放**
 * → 会话彻底报废（表现为"一发消息就报参数错误，怎么重试都不行"）。
 *
 * 这条坏数据**跨 provider 传染**：qoder 产生、workbuddy 受害。故防线放在
 * 本共享函数（四个适配器都调用它），而不是某个适配器内部。
 *
 * ## 为什么由适配器兜底
 *
 * 坏块已在会话里，harness 不会自愈。适配器是最后一道防线：发出请求前剔除，
 * 宁可丢失一轮工具上下文，也好过整条会话死亡。
 *
 * @param messages - harness 会话消息（按时间顺序）。
 * @returns 应当保留的 tool_call id 与 tool 结果 id 集合。
 */
export declare function resolveToolPairing(messages: readonly {
    role: string;
    content?: unknown;
}[]): {
    keepCallIds: Set<string>;
    keepResultIds: Set<string>;
};
export declare function normalizeToolArguments(raw: string): string;
/**
 * 判断工具参数是否因分片丢失而残缺（区别于"该工具本就无参数"）。
 *
 * 两种"不合法"必须区分对待：
 * - **空串**：无参数工具（如 `list_dir`）只下发一个空分片，这是**合法**的，
 *   补 `{}` 即可，工具照常执行；
 * - **非空但无法解析**：说明参数分片在流式下发中丢了。后端并行下发多个工具
 *   调用时偶发——实测 session-23851745 turn1 step4，模型并行发起两个 `read`，
 *   两个调用都丢了 `{"file_path": "…` 前缀，仅剩路径中段与尾部。
 *
 * 后者绝不能补成 `{}` 了事：那等于伪造一个"看起来合法"的调用，harness 执行
 * 时报 `missing required property "file_path"`，模型收到莫名其妙的参数错误，
 * 而真正的病因（分片丢失）被掩盖。正确做法是判定为截断，报告 max-tokens，
 * 让 dsh 丢弃残缺调用并重试——实测重试一次即恢复正常。
 *
 * 注意：只把**无法解析**视为截断。能解析但类型不对（标量、数组）属于模型
 * 输出有误，交给 schema 校验回传即可，不应触发重试。
 */
export declare function isTruncatedArguments(raw: string): boolean;
/**
 * 思考死循环中止的**错误码**。
 *
 * ## 为什么不复用 `max-tokens`（真实缺陷，Gitee !IKIZNK）
 *
 * 用户报障：循环守卫中断后，UI 显示
 * 「**已达到输出 token 上限** / 回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。」
 *
 * ⚠️ **这句话是错的，且误导方向**：DSH 客户端对 `max-tokens` 只有这一句**固定
 * i18n 文案**（`dsh-client-ui-chat` 的 `message.maxTokens` / `.hint`），
 * **不读适配器的任何 message**。于是「检测到死循环并主动止损」被显示成
 * 「token 用满了」，用户既不知道真实原因，也被告知「继续就能接着输出」——
 * 而实测继续之后往往**立刻再次进入同一循环**。
 *
 * 全库取证（219 会话，`scripts/probe-max-tokens-provenance.mjs`）：
 * `finish=max-tokens` 的 35 步里 **25 步（71%）是循环守卫截断**，只有 5 步是
 * 真的烧满额度。且这 25 步**全部**在截断后被迫由用户手动补「继续」
 * （11× 「继续」、9× 「继续上面未完成的任务」，其中 2 次用户自己诊断出
 * 「你陷入思考循环了」）。
 *
 * ## 为什么必须是**独立且不可重试**的码
 *
 * - **独立**：UI 的 `failureMessage()` 只对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` /
 *   `ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED` 做文案替换，
 *   **其余码一律原样显示我们给的 message**（`dsh-client-ui-chat/lib/client.js`
 *   的 `failureMessage`）——故自定义码是「把真实原因送到用户眼前」的**唯一**通道。
 * - **不可重试**：`REASONING_LOOP` **刻意不在** harness 的
 *   `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
 *   `TIMEOUT` / `TRANSPORT`）里。死循环是**确定性**病理，白退避 5 次
 *   （500/1000/2000/4000/8000 ≈ 15.5 秒）只会再烧一轮额度。
 *   这与 `QUOTA_EXCEEDED` / `PERMISSION_DENIED` 的既有口径一致。
 */
export declare const REASONING_LOOP_CODE = "REASONING_LOOP";
/** {@link createReasoningLoopDetector} 命中时的诊断快照。 */
export interface ReasoningLoopDiagnostics {
    /** 该通道累计观察到的字符数。 */
    readonly observedChars: number;
    /** 命中时**连续循环段**的持续体量（字符）。 */
    readonly runChars: number;
    /** 命中时尾部窗口内的非空行数。 */
    readonly lines: number;
    /** 命中时尾部窗口内的去重行数。 */
    readonly distinctLines: number;
    /** 命中时尾部窗口去重率（`distinctLines / lines`），判据为 `< 0.35`。 */
    readonly distinctLineRatio: number;
}
/** {@link createReasoningLoopDetector} 的可调参数。 */
export interface ReasoningLoopDetectorOptions {
    /** 判定窗口大小（字符）。默认 3000。 */
    windowChars?: number;
    /** 窗口内去重行比例低于此值视为局部循环。默认 0.35。 */
    maxDistinctLineRatio?: number;
    /** 窗口内至少这么多非空行才参与判定。默认 40。 */
    minLines?: number;
    /** 循环状态须持续这么多字符才确认中断。默认 2000。 */
    minLoopChars?: number;
    /**
     * 内部切片大小（字符）。默认 64；**<1 会被钳到 1**，非有限值（`NaN` /
     * `Infinity`）回退默认 64 —— 归一化见 {@link resolveSliceChars}。
     *
     * 它使**触发结论**与 `cutAt > 0` 与调用方粒度无关；`cutAt` 数值精度受切片
     * 大小限制（调用方粒度小于切片大小时更精确：实测粒度 3 → 1614、
     * 10 → 1610、≥64 → 1600），触发时机也会随 delta 边界略有推迟。
     */
    sliceChars?: number;
}
/** 思考死循环检测器。 */
export interface ReasoningLoopDetector {
    /**
     * 喂入一个 reasoning 增量；返回 true 表示**本次调用首次**确认死循环。
     * 确认后恒返回 false（幂等），调用方据此只处理一次。
     */
    observe(delta: string): boolean;
    /** 是否已确认死循环。 */
    readonly detected: boolean;
    /**
     * 截断点（字符偏移）：只保留 `[0, cutAt)` 的干净前缀。
     * 未检测到时为 undefined。
     */
    readonly cutAt: number | undefined;
    /**
     * 命中时的诊断快照（供错误文案使用）。
     *
     * ⚠️ **必须由检测器自己给出，不能由调用方估算**：判据的输入是**内部固定切片**
     * 的状态机（`text` / `runChars` / 尾部窗口行集），调用方只有原始 delta，
     * 自行复算会与真实判据漂移（`cutAt` 的数值精度也已证明依赖切片而非调用方粒度）。
     * 未检测到时为 undefined。
     */
    readonly diagnostics: ReasoningLoopDiagnostics | undefined;
}
/**
 * 归一化 `sliceChars`：非有限值（NaN / Infinity）回退默认值，并钳到 ≥1。
 *
 * ⚠️ **必须钳下限**：`observe` 用 `offset += sliceChars` 推进切片循环，
 * 步长为 0 或负数会让循环永不推进 → **同步死循环、进程挂死**。
 * 而同步死循环**无法被测试框架的超时打断**（超时由事件循环 timer 实现），
 * 表现为整个测试进程永久挂住且零诊断 —— 故这里必须兜住，不能只靠调用方自觉。
 *
 * `NaN` 也必须兜：`Math.max(1, NaN)` 仍是 `NaN`，会让 `offset < delta.length`
 * 恒为 false → 判据**静默失效**（fail-open，不检测任何循环）。
 */
export declare function resolveSliceChars(raw: number | undefined): number;
/**
 * 创建思考死循环检测器。
 *
 * ## 真实缺陷（用户报障，2026-09-23）
 *
 * `workbuddy/deepseek-v4.1-flash` 报「已达到输出 token 上限，回答被截断」。
 * 排查确认**不是**参数沿用上一个模型（DSH 按当前模型解析 `maxTokens`；
 * 且同一会话 turn 1 未做任何切换就爆额度），而是模型思考陷入病态重复：
 *
 * ```
 * Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
 * ```
 *
 * `reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出，
 * 最终 `reasoningTokens == outputTokens == 128000`、`finish_reason: length`。
 * 该模型只声明 `reasoningEfforts: ['high']`（仅一档），用户无法靠降档缓解。
 *
 * ## 判据为什么是这两个（实测依据）
 *
 * 评估了三种判据（正常 109 条 / 死循环 6 条真实样本）：
 *
 * | 判据 | 正常误报 | 死循环命中 |
 * |---|---|---|
 * | n-gram 重复占比 | 0/109 | 2/3 |
 * | **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
 * | 尾部行周期 | 0/109 | 1/3 |
 *
 * 故取第二种。**「持续体量」这一层不可省**：实测 seq=401 在 14848/15795
 * （94%）处被判局部循环，但它随即自愈并产出了工具调用 —— 它的持续体量
 * 仅 1024 字符，被 `minLoopChars=2000` 正确排除；而三个真死循环的持续体量
 * 是 435,968 ~ 509,184。区分度极高。
 *
 * 正常样本窗口去重率最低 0.149、死循环 0.017~0.031，**5 倍余量**。
 *
 * ⚠️ 只应喂 **reasoning** 增量：正文里的重复（代码块、列表）是正常输出。
 */
export declare function createReasoningLoopDetector(options?: ReasoningLoopDetectorOptions): ReasoningLoopDetector;
/**
 * 构造思考死循环中止的**失败原因**（`finish` 报 `error`）。
 *
 * ## 文案要回答用户三个问题
 *
 * 用户要求（Gitee !IKIZNK）：
 * > 如果只是陷入思考循环的出错，就要给出**有分辨力**的错误提示，
 * > 现在用「达到输出 token 上限」是不对的
 * > 提示中要加上**当前窗口还有多少可用**，没有真的占满可以尝试继续任务
 *
 * 故文案必须含：
 * 1. **真实原因**：模型思考陷入病态重复，**不是** token 上限；
 * 2. **额度实况**：本次只烧掉多少、还剩多少（证明"没有真的占满"）；
 * 3. **可执行建议**：直接继续即可（因为额度还在），并提示若再次循环可降思考档位。
 *
 * ⚠️ **额度是估算**，必须如实标注：`observedChars` 是**字符数**、不是 token 数，
 * 只有 `usage` 才给权威 token 数；而守卫命中时 `reader.cancel()` 已中止上游，
 * `usage` 帧**往往根本没到达**（实测 25 例中 0 例带 usage）。
 * 故用「按经验约 1 token ≈ 3.5 字符」估算，并明确写成「约」。
 * 这个系数的选取依据：中文为主的思考文本实测 token/字符比约 1:1.5~1:2，
 * 英文短句（`OK.` / `Hmm.` / `Let me write.` 这类循环体）约 1:4~1:5，
 * 取 **3.5** 作为两者之间的保守中值 —— 宁可低估剩余额度，也不要让用户
 * 以为还有很多而反复撞墙。
 *
 * @param diagnostics - 检测器给出的命中快照；**允许 undefined**（见下）。
 * @param maxTokens - 本次请求的输出额度；undefined 表示上游未声明。
 * @param channel - 命中通道（思考 / 正文），用于文案区分。
 *
 * ⚠️ `diagnostics` 允许 undefined 是**刻意的防御**：调用点写的是
 * `loopGuard!.diagnostics!`，虽然当前实现下「`loopDetected === true` ⇒
 * `diagnostics !== undefined`」恒成立（`loopDetected` 只在 `observe()` 返回 true
 * 时置位），但**这里抛错会发生在 `finish` 路径上** —— 那是收尾的最后一步，
 * 抛错会把「有分辨力的错误」变成「连 finish 都没有」的更糟故障。
 * 故缺诊断信息时**降级成不带数值的文案**，而不是崩。
 */
export declare function reasoningLoopFailure(diagnostics: ReasoningLoopDiagnostics | undefined, maxTokens: number | undefined, channel: 'reasoning' | 'text'): {
    message: string;
    code: string;
};
/**
 * 解析 `DSH_REASONING_LOOP_GUARD`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反（对齐 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` /
 * `DSH_TRAE_MAX_MODE`），故单列一个函数，**不要混用**。
 */
export declare function resolveReasoningLoopGuardFlag(raw: string | undefined): boolean;
/** 思考死循环检测是否启用（读环境变量）。 */
export declare function isReasoningLoopGuardEnabled(): boolean;
/** {@link splitThinkTaggedContent} 的结果。 */
export interface ThinkTaggedSplit {
    /** 闭标签**之前**的文本（思考），已剔除其中出现的全部标签。 */
    reasoning: string;
    /** 闭标签**之后**的文本（真正文）。 */
    text: string;
    /** 真正文在**原始字符串**中的起点偏移（即最后一个闭标签的结束位置）。 */
    textStart: number;
}
/**
 * 按 **think 闭标签**把正文块拆成「思考 + 真正文」。
 *
 * ## 真实缺陷（用户报障，2026-09-25 / 2026-09-27 两次）
 *
 * **第一次**：`workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，
 * 只在思考段末尾留一个 `</think:6124c78e>` 闭标签。实测该会话 93 步里只有 9 步
 * 的 reasoning 通道非空 —— 思考 9563 字符 vs 正文 64043 字符。后果：
 * ① 思考落在正文块里 → 思考死循环守卫（只喂 reasoning 增量）**完全看不见**
 * → 正文出现真循环（去重率 0.0412，实测 seq 34752/34768/34823，最长 34406 字符）；
 * ② 用户看到「模型把内心独白当正文输出」。
 *
 * **第二次**（用户报障，同一函数）：qoder/qfmodel 吐**裸** `</think>`（无 hex）。
 * 旧判据只认 `</think:hex>` → 解析失败 → 标签原样落盘。
 *
 * ## 覆盖率（41 会话全量普查，`scripts/probe-think-forms.mjs`）
 *
 * | 形态 | 块数 | 旧判据 | 现判据 |
 * |---|---|---|---|
 * | `close-only-bare`（裸闭标签）| **38** | ❌ | ✅ |
 * | `close-only-hex` | 4 | ✅ | ✅ |
 * | `mixed-hex-and-bare` | 2 | ❌ | ✅ |
 * | **`paired`（开+闭）** | 2 | ❌ | ✅ |
 *
 * ⇒ 旧判据漏 **42** 处（占 46 处中的 91%）。**这就是「解析做对」的价值** ——
 * 若只靠事后过滤，这 42 处全都会把标签泄漏给用户。
 *
 * ## 设计取舍（三条，都有实测依据）
 *
 * 1. ⚠️ **以最后一个闭标签为界**，且**剔除全部 think 标签**（开+闭）。
 *    「最后一个」保证正文完整（以第一个为界会把后续标签留在正文里）；
 *    「剔除全部」使**配对形态无需单独分支** ——
 *    `<think>思考</think>正文` 定界于闭标签 ⇒ 思考段 = `<think>思考`
 *    ⇒ 剔除标签 ⇒ `思考`。这正是「配对格式也能正确解析」的实现方式。
 * 2. ⚠️ **开标签不参与定界、只被剔除**：实测**开标签常缺失**（28 处仅闭标签），
 *    仅见开标签时无法判定「思考到哪结束」—— 此时**返回 undefined**（保持原样，
 *    比猜错安全）。
 * 3. ⚠️ **无闭标签时返回 `undefined`**（而非空切分结果）：调用方据此走原路径，
 *    保证绝大多数普通响应**逐字节不受影响**。
 *
 * ⚠️ **引用语境必须排除**（`isQuotedThinkTag`）：模型**讨论**标签时（如
 * `'</think>无 hex</think>'`）若被当分界，会把正文前半段误当思考移走。
 * 实测 46 处标签里 **39 处处于引用语境**（反引号/单双引号/围栏），只有 7 处裸露。
 *
 * @returns 命中闭标签时返回切分结果；无闭标签时返回 `undefined`。
 */
export declare function splitThinkTaggedContent(raw: string): ThinkTaggedSplit | undefined;
/**
 * 清洗**行首**的 `course` / `课` 泄漏 token。
 *
 * ## 真实缺陷（用户报障，2026-09-23）
 *
 * 用户观察：`deepseek-v4.1-flash` 的输出与思考中，**经常一行开头带一个中文「课」
 * 或英文「course」**，会污染提示词。
 *
 * ## 实测形态（全库核实：295 会话 / 307 万行）
 *
 * | 事实 | 数据 |
 * |---|---|
 * | `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
 * | `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
 * | 位置分布 | 行首 **2347**、行中 28（后者全是我们分析此现象的会话文字） |
 * | 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |
 *
 * 100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
 * 被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源 —— 都是 "course" 的字面义）。
 *
 * 用户的补充（已证实）：「`课查` / `课修` 都是泄漏，只不过是**泄漏 + 模型循环**
 * 两个问题叠加」—— 泄漏 token 后面直接跟模型正文/循环短句（`课查。` 895 次、
 * `课跑。` 308、`课修。` 307…）。这也解释了为何量极大：模型进入循环后每轮迭代
 * 都带一个泄漏前缀。
 *
 * ## 为什么判据是「行首一律删」，而不是白名单
 *
 * 泄漏就是**单个 `课` 字**，后面接任意正文 —— 故「`课` + 某字」永远可能是
 * 「泄漏 + 正文」的偶然组合，**任何白名单都会被绕过**。实测反证：
 *
 * | 曾以为要保护的词 | 数据真相 |
 * |---|---|
 * | `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
 * | `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
 * | `课程`(23) | **全在中部**，且全是分析此现象的会话文字，非模型输出 |
 *
 * 故判据为：
 *
 * ```
 * 行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
 *   且后接 ∉ {ASCII 字母}                      → 删掉 `course`
 * 行首（同上）的 `课`                            → 删掉 `课`
 * ```
 *
 * `course` 唯一保留的保护面是**后接 ASCII 字母时不删**：避免误删 `courseware` /
 * `coursework` 这类真实英文词。
 *
 * ⚠️ **判据曾在 2026-09-23 定得过窄，2026-09-25 修正** —— 初版要求后接**空白**
 * （` ` / `\t` / `\r` / 行尾），依据是当时实测「行首 `course` 后接非空白出现 0 次」。
 * 该实测**是错的**：在 lilishop-go 的 `session-d0ec32df` 里实测出 75 处行首
 * `course`，后接字符为 `注`(14) `关`(14) `这`(7) `核`(5) `，`(4) `先`(3) …，
 * **75/75 全部后接中文、无一处后接空白**，故初版判据命中率 **0%**（全部漏放）。
 * 用户报障「偶尔还是有泄露」即此 —— 且构建之后仍在复现（实测 10 处），
 * 不是旧产物问题。
 *
 * 根因：`course` 泄漏在中文语境里**后面直接接中文**（无空格），而初版按
 * 「英文词后面该有空格」设计，恰好把真实语境整个排除。放宽后对上述 75 处
 * 命中 **100%**、误删 **0**。
 *
 * 实测效果：初版命中 **2346** 处、行首未命中 **0** 处；中部 28 处（真正的正常用法
 * `研讨课` / `重要的一课` / `of course` / `recourse`）**完全不受影响**。
 *
 * ⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
 * 这样的句子开头，会变成「程设计已完成。」。实测 0/2346，但原理上非零 ——
 * 因为泄漏后接的正文可能偶然拼成正常词。可用 `DSH_COURSE_LEAK_STRIP=0` 关闭。
 *
 * ⚠️ **不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删。实测数据里
 * 泄漏都出现在自然语言段落、围栏内无此形态，故接受该简化。
 *
 * @param text - 待清洗文本（reasoning 块或 text 块）。
 * @returns 清洗后的文本；无泄漏时**原样返回同一字符串**。
 */
export declare function stripCourseLeak(text: string): string;
/**
 * 解析 `DSH_COURSE_LEAK_STRIP`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反（对齐 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` /
 * `DSH_REASONING_LOOP_GUARD`），故单列一个函数，**不要混用**。
 *
 * ⚠️ 提供开关是因为判据有**已知边界**：若模型真的以「课程设计…」开头，
 * 「课」会被误删。实测 0/2346，但原理上非零。
 */
export declare function resolveCourseLeakStripFlag(raw: string | undefined): boolean;
/** 行首泄漏清洗是否启用（读环境变量）。 */
export declare function isCourseLeakStripEnabled(): boolean;
/**
 * 按开关决定是否清洗；**供适配器的 `block-end` 收尾处调用**。
 *
 * 清洗放在**组装后**（而非流式增量）有两个理由：
 * 1. 判据需要「行首」这个上下文，而增量里 `course` 可能跨 chunk 到达
 *    （`cou` + `rse`），流式层无法判定；
 * 2. 只改 `block-end` 的 `block.text` 不必引入缓冲，不影响首 token 延迟。
 *
 * 实测 `BlockAssembler` 的 `block-end` 是**权威覆盖**，故此处改文本即可生效
 * （与死循环截断同一机制）。
 */
export declare function stripCourseLeakIfEnabled(text: string): string;
/**
 * 清洗**历史消息**里已持久化的行首泄漏；**供各适配器的序列化前调用**。
 *
 * ## 为什么还需要这一层（`block-end` 清洗不够）
 *
 * `block-end` 清洗只管**本次新生成**的文本。但泄漏早在本次修复之前就已
 * **持久化进会话历史**（实测全库 2771 行），此后每轮请求都会把这段脏历史
 * 原样重放给模型 —— 正是用户报障的「污染提示词」。
 *
 * 故必须在**发给模型之前**再清一道，让**存量坏会话自愈**、无需用户重开会话。
 * 这与「名称为空的 tool_call」那次的思路一致（消费侧修源头 + 序列化侧治存量）。
 *
 * ## 只清 assistant，不碰 user / system / tool 结果
 *
 * ⚠️ **判据只对模型自己的输出成立**（泄漏 token 由模型产生）。
 * 用户消息是**人的输入** —— 里面出现的「课」/「course」可能是用户真的在
 * 讨论这个词（本次排查期间我自己的分析文字就大量含 `课查。`）。
 * 清洗用户输入会**篡改用户的话**，绝不可为。
 *
 * 故：
 * - `role === 'assistant'` 的 `text` / `reasoning` 块 → 清洗；
 * - `tool-call` 的 `arguments` → **不清洗**（是 JSON，改了会破坏解析）；
 * - 其余角色的所有内容 → **不清洗**。
 *
 * @param message - 一条 harness 原生消息。
 * @returns 清洗后的 content 数组；无改动时返回**原数组**（保持引用相等）。
 */
export declare function stripCourseLeakFromHistoryContent(role: string, content: readonly unknown[]): readonly unknown[];
/**
 * 解析 `DSH_THINK_LEAK_STRIP`；**默认关闭**（与上文两个开关语义**相反**）。
 *
 * ## 为什么默认关（用户决定，2026-09-27）
 *
 * > 我们现在暂时不需要泄露过滤，代码可以保留，文档和注释记明白，后续再实际
 * > 使用中看是否还有泄露问题。**加了过滤可能有思考解析失败但是被过滤我们
 * > 发现不了。**
 *
 * 即：过滤是**兜底**，而兜底会**掩盖解析层的失败**。当前阶段的首要目标是
 * 观测「解析是否真的做对了」—— 若把泄漏静默删掉，就永远不知道解析是否漏了。
 * 故默认**不剥**，让泄漏**如实呈现**；确需应急时用 `DSH_THINK_LEAK_STRIP=1` 打开。
 *
 * ⚠️ **本开关只管「过滤」，不管「解析」**：
 * - **解析**（`splitThinkTaggedContent` 认配对/hex/裸闭标签）**恒开**，不可关 ——
 *   那是「把格式做对」，不是兜底。关掉它才是真缺陷（标签会进正文）。
 * - **过滤**（`stripBareThinkCloseTag` 删纯标签块）默认关 —— 它只是兜底。
 *
 * ⚠️ 取值语义与 `resolveCourseLeakStripFlag` / `resolveReasoningLoopGuardFlag`
 * **完全相反**（那两个默认开、显式假值才关）。故**必须**用独立的
 * `isTruthyFlag`，绝不能混用 —— 混了会让本开关「默认开」，正好与意图相反。
 */
export declare function resolveThinkLeakStripFlag(raw: string | undefined): boolean;
/** 裸标签泄漏过滤是否启用（读环境变量）。**默认 false**。 */
export declare function isThinkLeakStripEnabled(): boolean;
/**
 * 按开关决定是否剥离纯裸标签块；**供适配器的 `block-end` 收尾处调用**。
 *
 * ⚠️ **默认不剥**（见 `resolveThinkLeakStripFlag` 的说明）：过滤会掩盖解析失败，
 * 当前阶段需要让泄漏如实呈现以便观测。确需应急时设 `DSH_THINK_LEAK_STRIP=1`。
 *
 * ⚠️ 调用位置必须在 `splitThinkTaggedContent` **之后**：切分才负责「解析」，
 * 本函数只负责「兜底删掉切分没处理掉的纯标签块」。
 */
export declare function stripBareThinkCloseTagIfEnabled(text: string): string;
/**
 * 剥离**纯裸 `</think>` 闭标签**的整块内容。
 *
 * ## 根因（2026-09-27）
 *
 * 模型单独吐出一个 **`\n</think>\n\n`** 的独立 text 块，既有逻辑只认
 * `</think:hex>` → 漏网之鱼，把闭标签字面量当正文发回 Web。
 *
 * ## 判据设计
 *
 * - **纯裸闭标签**（去掉首尾空白与**全部裸标签**后为空）→ 返回**空串**；
 * - **含正文的块**、引用语境、hex 标签 → **原样返回**（不做处理）。
 *   原因：① 正文明确时保留原样由下游决定；② hex 标签交给
 *   `splitThinkTaggedContent` 切分；③ 引用语境不能动（3/3 分离度）。
 *
 * ⚠️ **本函数是兜底，默认不启用**（见 `stripBareThinkCloseTagIfEnabled`）。
 * 真正负责「把标签格式解析对」的是 `splitThinkTaggedContent`。
 *
 * @returns 纯裸闭标签块 → 空串；其余 → 原样返回。
 */
export declare function stripBareThinkCloseTag(text: string): string;
/**
 * 判定正文是否被**上游停止串**截断 —— 即「正文引用 `</think>` 导致对话中断」。
 *
 * ## 真实缺陷（用户报障，2026-09-27，本会话实时复现）
 *
 * 上游（Qwen 系，实测 `qoder/qfmodel`）把 **`</think>` 当停止串**。当模型在
 * **正文里引用**这个标签（例如讨论它、写 `` `</think>` ``）时，服务端在
 * `</think>` 处**掐断生成**，随后仍报 `finish_reason:"stop"` ——
 * 我们据此判成「模型正常答完」，harness 认为本轮已完成 → **静默中断**。
 *
 * 三条实测证据（同一会话，`outputTokens` 极小 + 正文止于半句）：
 *
 * | 行 | 正文尾部 | outTok | 正要写 |
 * |---|---|---|---|
 * | 5378 | ``…清洗器只认 ` `` | 369 | `` `</think:hex>` `` |
 * | 5412 | ``…多吐了一个孤立的裸 ` `` | 643 | `` `</think>` `` |
 * | 5600 | `` 找到了，`trae-adapter.ts` 还没补 ` `` | **37** | `` `</think>` `` |
 *
 * ## 判据（为什么是「反引号奇数 + 以反引号收尾」）
 *
 * 模型写 `` `</think>` `` 时会**先输出开引号**，服务端在标签处掐断，
 * 于是我们收到的正文**恰好止于一个未闭合的开引号**。两步判定：
 *
 * 1. **反引号总数为奇数** → 存在未闭合的行内代码；
 * 2. **以反引号收尾** → 该未闭合的正是**最后一个**开引号。
 *
 * ⚠️ 第 2 步不可省：只有「奇数」时，未闭合的开引号可能在**中间**
 * （`` `a` b ` `` 的反引号在末尾仍成立，但 `a\`b\` c\`` 这种更乱）；
 * 而「奇数 **且** 以反引号收尾」可**证明**末字符是未配对的开引号
 * （若末字符是闭引号，则它之前必然两两配对 ⇒ 总数为偶数，矛盾）。
 *
 * ⚠️ **不能用「以反引号结尾」单独判定**：正常的行内代码
 * （`` 运行 `pnpm test` ``）也以反引号结尾，但配对完整。实测该粗判据
 * 命中 9 处，其中 6 处是正常正文；本判据命中 3 处，**全部**是真截断。
 *
 * ⚠️ 本函数只管**文本形态**，是否据此上报「不完整」由调用方决定
 * （还需结合 `finish_reason === 'stop'` 与本步**没有工具调用**）。
 *
 * @returns 疑似被停止串截断时返回 `true`。
 */
export declare function isProseTruncatedByStopString(text: string): boolean;
//# sourceMappingURL=sse.d.ts.map