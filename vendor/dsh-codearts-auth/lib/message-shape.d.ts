import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/**
 * harness 消息形状归一化。
 *
 * DSH 在 0.1.7 把「工具结果」从**包裹块**改成**一等消息**：
 *
 * | | ≤0.1.6 | 0.1.7+ |
 * |---|---|---|
 * | 承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **`role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
 * | `ContentBlockMap` | 含 `'tool-result'` | **删除** `'tool-result'` |
 * | 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
 *
 * ⚠️ **`StreamChunk`（插件产出方向）在 0.1.5→0.1.7 逐字节未变** —— 本模块只处理
 * **消费**方向（harness 传给适配器的 `options.messages`），适配器的 `stream()`
 * 产出逻辑无需任何改动。
 *
 * ## 为什么必须归一化
 *
 * 五个适配器的序列化实现都按 ≤0.1.6 形状识别工具结果（`type === 'tool-result'`）。
 * 在 0.1.7 下该判据恒不命中，于是：
 *
 * 1. 工具输出被当成**普通用户消息**下发，`tool_call_id` 关联丢失；
 * 2. `resolveToolPairing` 收集到的结果 id 集合为**空**
 *    → `usable.every(block => allResultIds.has(...))` 恒 false
 *    → **assistant 的 `tool_calls` 被整体剔除**。
 *
 * 最终 wire 上完全没有工具调用记录，模型看到的是"我说了段话，用户回了段工具
 * 输出"，表现为**提前判定对话结束**或**陷入循环思考**。
 *
 * 实证（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
 * 512 条工具调用在 0.1.7 形状下保留 **0** 条，套回 0.1.5 形状则保留 512 条。
 *
 * ## 设计取舍
 *
 * 把 0.1.7 形状**降级**为既有代码已理解的 0.1.5 形状，而不是改造五个序列化
 * 实现 —— 后者需要触碰 `buddy-adapter` / `lobsterai-adapter` 等已被大量单测
 * 与线上流量验证的代码（AGENTS.md 明确禁止顺手重构）。降级方案让改动收敛为
 * 「每个入口插一次调用」。
 *
 * 探测用**形状**而非版本号（沿用 `settings-compat.ts` 的能力探测先例）：
 * 版本号需要额外的运行时信息，而形状就在入参里，且对"升级期混合形态"天然鲁棒。
 */
/** harness 传给适配器的消息（只需 role / content / toolCallId 三个维度）。 */
export interface HarnessMessageLike {
    role: string;
    content?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
    [key: string]: unknown;
}
/** 归一化探测结果。 */
export type MessageShape = 
/** ≤0.1.6：工具结果包裹在 user 消息的 `tool-result` 块里。 */
'legacy'
/** 0.1.7+：工具结果是一等 `role:'tool'` 消息。 */
 | 'tool-role'
/** 整段历史没有任何工具结果。 */
 | 'none';
/**
 * 探测整段历史的消息形状。
 *
 * ⚠️ **同时出现两种形态时以 `tool-role` 为准**：升级期的会话可能前半段是旧
 * 形态、后半段是新形态，而 `tool` 角色是 0.1.7 的权威判据。反之若判成
 * `legacy`，新形态的工具结果会被漏掉，等于没修。
 *
 * @param messages - harness 传入的完整消息序列。
 * @returns 该历史使用的形状。
 */
export declare function detectMessageShape(messages: readonly HarnessMessageLike[]): MessageShape;
/**
 * 把 0.1.7 的一等 `tool` 消息降级为 ≤0.1.6 的包裹形状。
 *
 * 规则：
 * - `role:'tool'` → `role:'user'`，content 包成单个 `{type:'tool-result',...}` 块，
 *   `toolCallId` 取自顶层（缺失时回退 `source.callId`），`isError` **仅在存在时**携带
 *   （避免给下游造出 `isError: undefined` 的差异）；
 * - `role:'developer'` → **丢弃**。它只承载工具增删元数据（`tool-addition` /
 *   `tool-removal`），不是对话内容。插件不声明 `toolUpdate` 能力时 harness 的
 *   `projectToolUpdates` 本会自行剥离（`withoutDeveloperMessages`），此处兜底，
 *   防止它被当作普通 user 消息下发给上游；
 * - 其余消息**原样透传**（保持引用身份）。
 *
 * ⚠️ **`content` 数组整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
 * 提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。
 *
 * @param messages - harness 传入的完整消息序列。
 * @returns 归一化后的消息序列；**无需改动时返回原数组引用**（零成本透传）。
 */
export declare function normalizeHarnessMessages<T extends HarnessMessageLike>(messages: readonly T[]): readonly HarnessMessageLike[];
/** 供应商序列化层消费的内部兼容形状，不作为持久化消息写回 SDK。 */
export interface NormalizedHarnessMessage {
    role: string;
    content: readonly (ContentBlock | {
        type: 'tool-result';
        toolCallId?: string;
        content: readonly ContentBlock[];
        isError?: boolean;
    })[];
}
//# sourceMappingURL=message-shape.d.ts.map