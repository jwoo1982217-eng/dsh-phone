/** 判断一个 content 块是否为 ≤0.1.6 的 `tool-result` 包裹块。 */
function isWrappedToolResult(block) {
    return typeof block === 'object' && block !== null
        && block.type === 'tool-result';
}
/** 判断一条消息是否为 0.1.7 的一等工具结果消息。 */
function isToolRoleMessage(message) {
    return message.role === 'tool';
}
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
export function detectMessageShape(messages) {
    let sawLegacy = false;
    for (const message of messages) {
        if (isToolRoleMessage(message))
            return 'tool-role';
        const content = message.content;
        if (Array.isArray(content) && content.some(isWrappedToolResult))
            sawLegacy = true;
    }
    return sawLegacy ? 'legacy' : 'none';
}
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
export function normalizeHarnessMessages(messages) {
    // `detectMessageShape` 只回答"工具结果长什么样"；`developer` 是 0.1.7 专有角色
    // （0.1.5 的 role 联合类型只有 system/user/assistant），无论有没有工具结果都
    // 必须剥离。两个判据相互独立，故在此分别求值。
    const shape = detectMessageShape(messages);
    const hasDeveloper = messages.some(message => message.role === 'developer');
    if (shape !== 'tool-role' && !hasDeveloper) {
        // 0.1.5 路径：连数组身份都不变，确保既有行为逐字节不受影响。
        return messages;
    }
    const normalized = [];
    for (const message of messages) {
        if (message.role === 'developer')
            continue;
        if (!isToolRoleMessage(message)) {
            normalized.push(message);
            continue;
        }
        // `source.callId` 是 0.1.7 的伴随字段；顶层缺失时回退它，
        // 两者都缺则保持 undefined（下游按"无 id"处理，与旧行为一致）。
        const source = message['source'];
        const sourceCallId = typeof source === 'object' && source !== null
            ? source.callId
            : undefined;
        const toolCallId = message.toolCallId ?? sourceCallId;
        const block = {
            type: 'tool-result',
            toolCallId,
            content: message.content,
        };
        if (message.isError !== undefined)
            block.isError = message.isError;
        normalized.push({ role: 'user', content: [block] });
    }
    return normalized;
}
//# sourceMappingURL=message-shape.js.map