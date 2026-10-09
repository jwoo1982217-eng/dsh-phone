/**
 * 把信封 SSE 转成标准 OpenAI SSE。
 *
 * 逐帧处理 `data:` 行；非 `data:` 行（如 `event:finish`）原样保留，
 * `[DONE]` 原样传递。
 */
export declare function unwrapQoderEnvelopePayload(payload: string): string | null;
/**
 * 把 Qoder 信封 SSE 流转成标准 OpenAI SSE 流。
 *
 * @param response 原始响应（`body` 必须是可读流）。
 * @returns 新的 `Response`，其 body 为标准 OpenAI SSE 文本流。
 */
export declare function unwrapQoderEnvelopeStream(response: Response, label: string): Response;
//# sourceMappingURL=qoder-envelope.d.ts.map