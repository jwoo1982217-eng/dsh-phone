/** 对照 ZCode aac4755666d 的 BigModelUsageQuotaProvider；只使用本人 DSH 登录态。 */
import type { ZcodeCredential } from './zcode.js';
export type ResetType = 'FIVE_HOUR' | 'WEEK';
export interface ResetScope {
    credential: ZcodeCredential;
    organizationId?: string;
    projectId?: string;
    assertCurrent(): void | Promise<void>;
}
export interface ResetStatus {
    availableFiveHourResets: {
        expireAt: number;
    }[];
    availableWeekResets: {
        expireAt: number;
    }[];
    latestFiveHourResetHistory: {
        usedAt: number;
    } | null;
    latestWeekResetHistory: {
        usedAt: number;
    } | null;
    hasUnreadHistory: boolean;
}
export declare function resetCodingPlan(scope: ResetScope, action: 'status' | 'opportunity' | 'use', options?: {
    idempotencyKey?: string;
    resetType?: ResetType;
    confirmed?: boolean;
}, fetchImpl?: typeof fetch): Promise<ResetStatus | {
    granted: boolean;
    nextTryAt: number | null;
} | {
    used: true;
}>;
//# sourceMappingURL=zcode-plan-reset.d.ts.map