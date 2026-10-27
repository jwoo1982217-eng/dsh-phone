/**
 * DSML 工具调用协议 —— 共享定义与提示构造。
 *
 * ## DSML 是什么
 *
 * 华为 CodeArts / MaaS 系模型（deepseek-v4 等）支持一种**流式**工具调用
 * 语法：工具调用以文本形式写入 `delta.content`（而非标准 `tool_calls`
 * 字段），形如：
 *
 * ```
 * <｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>
 * ```
 *
 * 竖线是 **U+FF5C 全角竖线**。开闭标签必须是 **`tool_calls`** —— 这是
 * `parseDsmlToolCalls` 唯一认的写法（见 llm-adapter.ts 的
 * `DSML_TOOL_CALLS_OPEN` / `DSML_TOOL_CALLS_CLOSE` 常量）。
 *
 * ## 为什么需要（2026-10-13 实测事故）
 *
 * OfficeAce 通道下的 `deepseek-v4.1-flash` 输出的是 `<｜DSML｜ calls>`
 * （**少了 `tool_` 前缀**）⇒ 解析器完全不认 ⇒ 整段当正文显示、工具
 * **从未执行**。根因是适配器**既没有**发送 `tools` 字段、**也没有**
 * 注入本文件的 DSML system 提示，模型在零协议指引下凭训练印象臆造了
 * `calls` 这种不存在的语法。
 *
 * 即：**不是模型把标记写坏了，是没人告诉它正确的写法**。
 * 归一化（sse.ts `fixDsmlMarkers`）只能修「双竖线」这类笔误，修不了
 * 「协议本身没下发」—— 必须先有正确的 schema 与语法说明。
 *
 * ## 抽到共享层的原因
 *
 * 最初 `buildDsmlSystemPrompt` 只在 `llm-adapter.ts`（codearts）里，
 * OfficeAce 复用不到 ⇒ 于是漏注入。协议定义**只有一份**才不会再漏。
 */
/** DSML 工具调用块的开标签（**必须**是 `tool_calls`，不是 `calls`）。 */
export declare const DSML_TOOL_CALLS_OPEN = "<\uFF5CDSML\uFF5Ctool_calls>";
/** DSML 工具调用块的闭标签。 */
export declare const DSML_TOOL_CALLS_CLOSE = "</\uFF5CDSML\uFF5Ctool_calls>";
/** 单个 invoke 块的开标签前缀（后面跟 ` name="..."`）。 */
export declare const DSML_INVOKE_OPEN_PREFIX = "<\uFF5CDSML\uFF5Cinvoke";
/** 单个 invoke 块的闭标签。 */
export declare const DSML_INVOKE_CLOSE = "</\uFF5CDSML\uFF5Cinvoke>";
/**
 * 把**一个** DSML 标签名的**两侧空白**压成规范形。
 *
 * 输入形如 `<｜DSML｜ invoke name="x">` 或 `</｜DSML｜ parameter>`，输出
 * `<｜DSML｜invoke name="x">` / `</｜DSML｜parameter>`。
 *
 * ⚠️⚠️ **这是本文件 2026-10-13 三次事故的共同病根**：模型（实测
 * `deepseek-v4.1-flash` 经 codearts 与 officeace 两家）会在 `｜DSML｜`
 * **之后**插入空白 —— `tool_calls` 之外，`invoke` / `parameter` 同样中招
 * （现场逐字：`<｜DSML｜ invoke name="pwsh">`、`<｜DSML｜ parameter
 * name="command" string="true">`）。而此前别名归一**只覆盖 `calls` /
 * `tool_calls` 一种名字**，`invoke` / `parameter` 的空白形态**从未被归一**
 * ⇒ `DSML_INVOKE_OPEN_PREFIX`（`<｜DSML｜invoke`）的 `indexOf` 恒不命中
 * ⇒ `parseDsmlToolCalls` 返回**空数组**（不是 undefined）⇒ 调用方把整块
 * 当成「解析成功但无调用」⇒ **内容凭空消失**（用户看到「模型很快就结束
 * 了，没有原因」）。
 *
 * 故此处对**任意标签名**做归一（`[a-zA-Z_][\w-]*`），名字白名单由调用方
 * 自己决定 —— 本函数不认识协议，只修「空白」这一种笔误。
 */
export declare function normalizeDsmlLabel(tag: string): string;
/**
 * 对**整段文本**做 DSML 协议级归一：双竖线、别名（`calls` → `tool_calls`）
 * 与标签空白（`<｜DSML｜ invoke` → `<｜DSML｜invoke`）一次做完。
 *
 * 三种笔误都来自实测（2026-10-13）：
 *
 * | 形态 | 受害模型 | 不修的后果 |
 * |---|---|---|
 * | `<｜｜DSML｜｜` 双竖线 | deepseek-v4.1-flash / step-5-preview | 宿主解析器不认 ⇒ 标签当正文 |
 * | `<｜DSML｜ calls>` 缺 `tool_` | deepseek-v4.1-flash | 开闭标签不匹配 ⇒ 永不进 in-dsml |
 * | `<｜DSML｜ invoke` / `parameter` 带空白 | deepseek-v4.1-flash | `indexOf(invoke)` 不命中 ⇒ **内容凭空消失** |
 *
 * ⚠️ **顺序有意为之**：先双竖线、再别名、最后空白。双竖线必须先修
 * （否则 `<｜｜DSML｜｜ calls>` 里的双竖线会让后续 `｜DSML｜` 定位失败）；
 * 别名与空白互相独立，交换顺序结果相同（均幂等）。
 *
 * 用于 `feed()` 的整段入口；**流式增量**不能用它（模式会跨帧），那是
 * `createDsmlMarkerNormalizer` 的职责。
 *
 * ⚠️⚠️ **本函数的双竖线规则与 `sse.ts` 的 `fixDsmlMarkers` 逐字同源**
 * （同两条正则、同一条 `DSML` 后边界前视）。**两份实现是不得已的分叉**：
 * `feed()` 拿到的 buffer 是**累积后的完整片段**（不是流式增量），而
 * `sse.ts` 那份要服务 8 个适配器的逐帧路径。判据分叉的代价由
 * `dsml-label-forms.spec.ts` ⑦ 的「两份判据必须一致」对拍锁死 ——
 * 改任一条正则时**必须同步另一条**，否则「教得会、解不开」会以另一种
 * 形态复发（正是本文件四次事故的共同病根）。
 */
export declare function normalizeDsmlText(text: string): string;
/** OpenAI function 形态的工具定义（构造提示用）。 */
export interface DsmlToolSpec {
    type: string;
    function: {
        name: string;
        description?: string;
        parameters?: unknown;
    };
}
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * ## 为什么 deepseek-v4 必须走 DSML
 *
 * 标准 `tool_calls` 模式要求参数**一次性打包**生成，SSE 流在生成参数期间
 * 长时间无数据 —— APIG 网关 ~60s 空闲超时必然掐断（`terminated`），且后端
 * 不对任何请求头发心跳保活。实测（2026-08-22 e2e）：标准模式 100 行也要
 * 17.7s 静默后一次性到达、300 行即 60s 断连；而 DSML 模式使调用经
 * `delta.content` 流式输出（全程有数据流），1000 行 write content 全程
 * 最大静默仅 204ms、146s 完整结束。
 *
 * 非 deepseek-v4 模型无此网关问题，继续保持标准 `tool_calls`。
 */
export declare function isDeepseekV4Model(model: string): boolean;
/**
 * 判断模型是否应使用 DSML 工具调用模式。
 *
 * ⚠️ OfficeAce 通道的模型 id 带 `-flash` 变体（如 `deepseek-v4.1-flash`），
 * 需一并纳入 —— 该通道同样经网关，断连风险一致（2026-10-13）。
 */
export declare function needsDsmlToolMode(model: string, _toolNames: readonly string[]): boolean;
export declare const DSML_PARAM_OPEN_PREFIX = "<\uFF5CDSML\uFF5Cparameter";
export declare const DSML_PARAM_CLOSE = "</\uFF5CDSML\uFF5Cparameter>";
export declare const THOUGHT_OPEN = "<thought>";
export declare const THOUGHT_CLOSE = "</thought>";
/**
 * 从一段已闭合的 DSML tool_calls 块中解析所有 invoke，返回结构化
 * tool-call 列表。返回 undefined 表示解析失败（调用方应回退为纯文本）。
 *
 * ⚠️⚠️ **空数组 ≠ 解析失败，但它必须被调用方区别对待**（2026-10-13 真缺陷）。
 *
 * 旧语义把 `[]` 当「解析成功、只是没有调用」，而 `feed()` 的 `in-dsml`
 * 分支据此**静默丢弃整块** —— 实测现场：模型输出
 * `<｜DSML｜ invoke …>`（`｜DSML｜` 后带空白）时，归一只覆盖
 * `tool_calls`/`calls`，`indexOf(DSML_INVOKE_OPEN_PREFIX)` 恒不命中
 * ⇒ 循环一次都不进 ⇒ 返回 `[]` ⇒ 整段工具调用**凭空消失**，
 * 用户看到「模型很快就结束了，没有原因」（reasoning 在、正文只剩一句、
 * `finish=stop`、零 tool-call）。
 *
 * 归一化修好后 `invoke` 空白形态能进循环，但**空块仍是合法输入**
 * （模型写了 `<｜DSML｜tool_calls></｜DSML｜tool_calls>` 却什么都没调）
 * —— 故这里保持返回 `[]`，由 `feed()` 按下方规则分流：
 * **一个 invoke 都没解析到时整块作为正文放行**，绝不静默吞掉。
 */
export declare function parseDsmlToolCalls(block: string): Array<{
    name: string;
    arguments: string;
}> | undefined;
/**
 * 流式 DSML 提取器。feed() 接收 content delta，返回：
 * - `text`：应作为 text-delta 输出的纯文本（可能为空串）
 * - `reasoning`：应作为 reasoning-delta 输出的推理增量（可能为空串）
 * - `toolCalls`：已完整解析的 DSML tool-call 列表（可能为空数组）
 * flush() 在流结束时把残留缓冲区按状态放行。
 *
 * 状态机三态：
 * - normal：寻找 `<thought>` 或 `<｜DSML｜tool_calls>` 开标签
 * - in-thought：寻找 `</thought>`，期间内容作为 reasoning 流式输出
 * - in-dsml：寻找 `</｜DSML｜tool_calls>`，完整后解析为 tool-call
 */
export declare class DsmlContentExtractor {
    private buffer;
    private state;
    feed(chunk: string): {
        text: string;
        reasoning: string;
        toolCalls: Array<{
            name: string;
            arguments: string;
        }>;
    };
    flush(): {
        text: string;
        reasoning: string;
    };
}
/**
 * 构造让模型以原生 DSML 格式调用工具的 system 提示。
 *
 * 用法：适配器**不**发送 `tools` 字段（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，并明确
 * 要求模型使用 {@link DSML_TOOL_CALLS_OPEN} 语法。
 *
 * ⚠️ **必须与解析侧（{@link DsmlContentExtractor}）成对启用**：本函数只
 *    负责「教模型怎么写」，`DsmlContentExtractor` 负责「把它读回来」。
 *    只教不解 ⇒ 模型写出的 DSML 整段当正文显示、工具永不执行。
 *
 * ⚠️ **注入位置有讲究**（实测 2026-08-22）：应置于 system 之后、user 之前
 *    （与 CodeArts Agent IDE 实际请求体一致）。push 到 messages 末尾时，
 *    deepseek-v4 倾向把思考写入正文而非 `reasoning_content`；unshift 到
 *    user 之前后恢复走 reasoning 通道，思考不再泄漏到正文。
 */
export declare function buildDsmlSystemPrompt(tools: DsmlToolSpec[]): string;
//# sourceMappingURL=dsml.d.ts.map