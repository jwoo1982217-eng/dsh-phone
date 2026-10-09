/** 每个实际模型请求独立选号；目录查询、续期与设置页不会另占顺位。 */
export interface RotationRequest {
    provider: string;
    model: string;
    signal?: AbortSignal;
    accounts: Map<object, string>;
    excluded?: Map<object, Set<string>>;
    failover?: Map<object, (error: unknown) => Promise<boolean>>;
    sources?: Map<object, Map<string, string>>;
}
export declare function rotationRequest(provider: string): RotationRequest | undefined;
/** 在迭代器的每一步恢复上下文，覆盖准备后的 stream、异常与取消清理。 */
export declare function rotatingStream<T>(provider: string, model: string, create: () => AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T>;
/** 按稳定 ID 续接用户排列；已删除的上次账号不参与，新增账号自然进入环。 */
export declare function afterAccount<T extends {
    id: string;
}>(accounts: readonly T[], last?: string): T[];
//# sourceMappingURL=account-rotation.d.ts.map