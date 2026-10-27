/**
 * OpenCode V2 chat 请求：read 门禁 + 客户端工具双向别名。
 * 上游只把内置 `read`（名字 + 参数 schema）当必需门禁；描述不参与校验。
 * 客户端工具（包括 read/shell/edit/write）全部走别名隔离，参数、调用 ID、正文与结果不改写。
 */
export interface OpencodeHarnessTool {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}
export interface OpencodeWireTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}
/**
 * 门禁工具名。
 *
 * ⚠️ **只保留 `read`**：实测「只带 read」必定放行，而只带 shell/edit/write/glob
 * 一律 403。少注入一个门禁就少一个与客户端工具重名的干扰源 —— 模型偶发选中
 * 注入的 shell 桩会让整轮退化/被上游限流。
 */
export declare const FREE_LANE_GATE_TOOLS: readonly ["read"];
/**
 * 门禁桩工具。名字与参数 schema 必须保持上游 read 的形态（改名或空 properties 都会 403）。
 * 描述**不参与校验**（空描述同样放行），故用最直白的禁止调用文案，不再拼业务原句，
 * 也就不会与客户端自己的工具描述混淆。
 */
export declare function gateTool(name: typeof FREE_LANE_GATE_TOOLS[number]): OpencodeWireTool;
/** 只做 DSH → OpenAI 格式转换，别名统一在请求边界分配。 */
export declare function buildOpencodeTools(tools: readonly OpencodeHarnessTool[] | undefined): OpencodeWireTool[];
type RecordValue = Record<string, unknown>;
export interface OpencodeRequestShape {
    payload: RecordValue;
    /** 上游别名 → DSH 原名，仅存在于本次请求，绝不写入会话。 */
    toolAliases: ReadonlyMap<string, string>;
    toolsDisabled: boolean;
}
/**
 * 客户端工具的上游别名前缀。
 *
 * ⚠️ **唯一定义处**：响应层的剔除判据要用它区分「我们自己的产物」（`dsh_` 开头 ⇒
 * 别名表或历史重命名可能有缺陷）与「模型幻觉的名字」—— 两处各写一份字面量
 * 会在改前缀时静默漂移（本仓库已登记「一文件两套同义判据」这条判据）。
 */
export declare const ALIAS_PREFIX = "dsh_";
/** 兼容既有纯 payload 调用；生产链路用 buildOpencodeRequest 同时取回响应映射。 */
export declare function ensureFreeLaneShape(payload: RecordValue): RecordValue;
export interface OpencodePayloadInput {
    model: string;
    messages: ReadonlyArray<RecordValue>;
    system?: string;
    tools?: readonly OpencodeHarnessTool[];
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
}
export declare function buildOpencodeRequest(input: OpencodePayloadInput): OpencodeRequestShape;
export declare function buildOpencodePayload(input: OpencodePayloadInput): RecordValue;
export {};
//# sourceMappingURL=opencode-messages.d.ts.map