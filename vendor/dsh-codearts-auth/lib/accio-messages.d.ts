import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/**
 * 该帧是否是**流内错误帧**（布尔判据）。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. **对象且带非空 `error_code`**（或 `error_message`）—— Accio 的错误帧
 *    `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`；
 * 2. ⚠️ **`error_code === '200'` 是成功哨兵，绝不可抛** —— 实测正常帧也会带它
 *    （`{"error_code":"200","content":{…}}`）。故必须先判 `'200'` 再判错误；
 * 3. 其余非 `200` 码 ⇒ 错误（归类见 {@link accioErrorFrame}）。
 *
 * ## ⚠️⚠️ 为什么必须**导出**成独立的布尔判据（2026-10-13 审计修正）
 *
 * 合并层 `accioToolCallMergeTransform`（`src/accio-adapter.ts`）跑在
 * `consumeAccioSse` **之前**，而本判据只在后者的 `processLine` 里生效。若合并层把
 * 「错误码与工具 part **同帧**」的帧吸收进 pending 缓冲，flush 时只吐工具 part
 * ⇒ `error_code` / `error_message` 被吞 ⇒ 本判据再也看不到它 ⇒
 * **额度/认证失败被反转成「工具调用成功」**（本仓库铁律「流内错误必须抛出」
 * 「绝不丢服务端原文」同时被违反）。
 *
 * ⇒ 合并层必须能问一句「这是不是错误帧」，对错误帧**原样透传、绝不吸收**。
 *
 * ⚠️ **判据只此一处**（{@link accioErrorFrame} 复用它）—— 两处各写一份必然漂移，
 * 漂移的后果是「同一个帧，一层认作错误、另一层认作正常」。
 */
export declare function isAccioErrorFrame(frame: unknown): boolean;
/**
 * 图片像素预算（本轮**不发送**图片）。
 *
 * ⚠️ 实测 `multimodal: true` 的模型**声明**支持图片，但本 provider 的图片通路
 * **尚未实测**（见 agent-notes §10 U-D）。按本仓库铁律「输入形态三态」：
 * 未验证 ⇒ 该在 `resolveModel` 里**省略** `inputModalities`（= 未知），
 * 本适配器因此不走图片路径。保留该常量是为了让 `readImage` 的接入点显式可见，
 * 而不是被静默省略。
 */
export declare const ACCIO_IMAGE_PIXEL_BUDGET = 1150000;
/**
 * 把一帧 Accio 报文归一化成 `consumeGeminiSse` 认得的形状。
 *
 * ⚠️ 已经是标准形状（含 `candidates`）时**原样返回同一引用** ——
 * 容忍上游某天改成标准形状，也便于测试断言。
 *
 * ## ⚠️⚠️ 「无 `content`」≠「无用帧」（2026-10-13 真实缺陷，用户报障
 * 「accio 思考一下就中断」的根因之一）
 *
 * 旧判据「无 `content` 一律 `return undefined`」把三类**有语义**的帧整帧丢弃：
 *
 * 1. **顶层 `function_call`**（agent-notes §4.2 的 task-6-report 逐字记录的
 *    真实形状 `{"function_call":{"id":…,"name":…}}`，**不带** `content`）——
 *    丢弃它 = 模型的工具调用凭空消失，流里只剩思考 ⇒ 兜底 `stop` ⇒
 *    「思考一下就中断、无正文无工具调用、轮次显示正常完成」；
 * 2. **终帧的 `usage_metadata` / `finish_reason`**（与 `content` 同为顶层字段，
 *    工具轮次的终帧只有它们、没有正文）—— 丢弃它 = `MAX_TOKENS` 截断被
 *    伪装成正常 `stop`，usage 恒归零；
 * 3. 纯 usage 帧（无 finish）—— 丢弃它 = 计量丢失。
 *
 * 实测证据（session `35b01df3`，accio/deepseek-v4-1-flash 13 轮静默 stop）：
 * 每轮思考结尾都是工具意图（"Let me call get_goal."），然后流里再无任何内容；
 * 唯一拿到真实 usage 的轮次恰好是纯文本轮次（终帧带 `content`，usage 搭车存活）。
 *
 * ## 产出形状的取舍
 *
 * - 仅 usage（无 finish）⇒ `{candidates:[], usageMetadata}`：消费侧对空
 *   `candidates` 只记用量、不算内容、继续读（见 `consumeGeminiSse` 的
 *   `processFrame`），**不会**触发「模型未返回任何内容块」；
 * - 有 finish ⇒ `candidates:[{finishReason}]`（**不带** `content`）：
 *   `finishReason` 只有挂在**非空** candidate 上才会被读到（空 candidates
 *   在读 finishReason 之前就 return 了）；
 * - 顶层 `function_call` ⇒ 包成 `candidates[0].content.parts[].functionCall`，
 *   复用 {@link normalizeAccioPart} 做 snake → camel 换名。
 */
export declare function normalizeAccioFrame(frame: unknown): unknown | undefined;
/**
 * 工具定义 → Accio 的 `{ name, description, parametersJson }`（**扁平**形态）。
 *
 * ## ⚠️⚠️ 形状是**实测**的扁平形态，不是 Gemini 的 `{function_declarations:[…]}`
 *
 * 经 `accioToSnake` 后落成 `tools[].parameters_json`。真机证据见
 * `docs/agent-notes/providers-accio.md` §4.1.2（Task 6 的 `probe-tool-shards.mjs` /
 * `probe-tool-merge.mjs` 用的就是这个形态，上游回了真实 `function_call` 帧）。
 *
 * ⚠️ **`parametersJson` 必须是字符串**（`JSON.stringify` 整份 schema）：
 * `accioToSnake` **不下钻字符串** ⇒ 工具参数名（`filePath` / `oldString` …）作为
 * **数据**原样送达。若改成对象形态，递归 snake 化会**静默改写参数名**。
 * 详见 `src/accio.ts` 的 `buildAccioBody` tools 区域那段警告。
 */
export declare function toAccioTools(tools: readonly unknown[]): unknown[] | undefined;
/**
 * 把一条 user 消息的 content 转成 Accio 的 `parts`（**含图片**）。
 *
 * ## 上游形状（2026-10-14 真机实测，issue IKLR7V）
 *
 * 图片放在 **Gemini 风格的 `parts[].inline_data = { mime_type, data }`** ——
 * 与既有 `contents` 信封**同构**，且实测四象限色块图**四色全对**。
 * 本函数产出 camelCase 形态，由 `buildAccioBody` 的 `accioToSnake` 转成上游认的
 * `inline_data`（⚠️ **不要**改走 `properties` 子树 —— 那棵子树刻意不参与 snake 转换）。
 *
 * ## 三态判据（缺一不可）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 无图 | 返回 `undefined` ⇒ 调用方走**原来的纯文本路径**（线上格式逐字节不变，不破坏前缀缓存） |
 * | 有图、字节已内联 | 产出 `{ inlineData: { mimeType, data } }` |
 * | 有图、拿不到字节 | **抛错**（绝不静默丢弃；静默丢弃会让用户以为模型看到了图） |
 *
 * ⚠️ **`tool-result` 分支必须递归**，与 `collectImages`（`src/openai-compat.ts`）
 * 的递归深度**对称**：收集侧是任意深度，序列化侧只走一层的话，深层图片会被
 * 收进 refs 却在序列化时**静默丢弃**（连占位符都没有）。本仓库其余适配器
 * （buddy / trae / lobsterai）都按同一口径递归。
 *
 * @param content - 消息的 content（数组形状）。
 * @param images - `attachmentId → 已内联字节`。`undefined` 表示**本请求无图**
 *   （调用方未接线或未收集到）；此时不产出图片 part。
 */
export declare function accioUserParts(content: readonly unknown[], images: ReadonlyMap<string, {
    mediaType: string;
    data: string;
}> | undefined): Array<Record<string, unknown>> | undefined;
/**
 * 把 harness 消息序列化成 Accio 的 `contents` + `systemInstruction`。
 *
 * ⚠️ 调用方**必须**先走 `normalizeHarnessMessages(...)`（DSH 0.1.7 的一等
 * `role:'tool'` 消息）—— 本函数按 0.1.5 形状实现，与其余适配器同口径。
 *
 * ## 图片（`images`）
 *
 * `images` 为 `undefined` 表示**本请求没有图片**（未接线 / 未收集到）⇒ user 消息
 * 走**原来的纯文本路径**，线上格式逐字节不变（不破坏前缀缓存）。
 * 非 `undefined`（**含空 Map**）时才可能把带图的 user 消息升级为多模态 `parts`。
 *
 * ⚠️ 图片的实际提取由 {@link accioUserParts} 负责（含 `tool-result` 递归）；
 * 本函数只决定「哪条消息要用它」。
 */
export declare function serializeAccioMessages(messages: readonly unknown[], images?: ReadonlyMap<string, {
    mediaType: string;
    data: string;
}>): {
    contents: unknown[];
    systemInstruction: string;
};
/**
 * 消费 Accio 的 SSE。
 *
 * ⚠️ **必须用 `TransformStream` 在中间改写帧**：`consumeGeminiSse` 内部对每帧做
 * `JSON.parse` 且**不接受「帧变换」回调**，而 Accio 的帧需要先归一化它才认得。
 * 故这里先流式改写，再把改写后的流交给共享消费器。
 *
 * ⚠️ 改写的五条纪律：
 * 1. **非 `data:` 行原样透传**（`event:` / 注释心跳 / 空行都要保留）；
 * 2. **`[DONE]` 原样透传**（消费器认它）；
 * 3. 归一化返回 `undefined` 的帧**整帧丢弃**（不能产出空 `candidates`）；
 * 4. **流内错误帧必须抛出**（`error_code` 非 `'200'`）—— 见
 *    {@link accioErrorFrame}；漏掉它会把「额度/认证失败」误判成「模型没返回内容」；
 * 5. **结束时 flush 解码器**（与共享消费器同一条教训）—— 否则跨 chunk 的
 *    最后一个多字节字符会丢。
 */
export declare function consumeAccioSse(options: {
    body: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    idleTimeoutMs?: number;
}): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=accio-messages.d.ts.map