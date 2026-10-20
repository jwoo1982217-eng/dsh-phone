/** 只处理明确的账号额度/限流；内容拒绝、模型饱和、取消与网络错误不换号。 */
export declare function accountQuotaError(error: unknown): boolean;
export declare function streamError(chunk: unknown): unknown;
export declare function hasStreamOutput(chunk: unknown): boolean;
//# sourceMappingURL=account-failover.d.ts.map