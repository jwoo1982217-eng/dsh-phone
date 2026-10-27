import { type OpencodeRequestShape } from './opencode-messages.js';
type RecordValue = Record<string, unknown>;
export declare function createOpencodeFrameNormalizer(request: Pick<OpencodeRequestShape, 'toolAliases' | 'toolsDisabled'>, warn?: (message: string) => void): {
    transformFrame: (frame: RecordValue) => void;
    assertComplete: () => void;
};
/**
 * OpenCode 专用 SSE 前置流，不改共享消费器，也不缓冲整条响应。
 * 只在完整 SSE 事件边界改写 JSON；正文/思考/usage 字段仍由共享消费器原样处理。
 * pipeThrough 保留背压与取消传播，调用方停止消费时上游连接也会被取消。
 */
export declare function normalizeOpencodeResponse(response: Response, request: Pick<OpencodeRequestShape, 'toolAliases' | 'toolsDisabled'>, warn?: (message: string) => void): Response;
export {};
//# sourceMappingURL=opencode-stream.d.ts.map