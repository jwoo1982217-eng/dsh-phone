import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import type { ProviderAccountEntry } from './types.js';
import type { ZcodeCredential } from './zcode.js';
export interface ZcodeSourceProjection {
    id: string;
    kind: 'start-plan' | 'individual' | 'organization-flow' | 'team';
    url: string;
    key?: string;
    organizationId?: string;
    projectId?: string;
}
export interface ZcodeSourceInfo {
    id: string;
    label: string;
    kind: ZcodeSourceProjection['kind'];
    available: boolean;
    reason?: string;
    quota?: string;
}
export declare function zcodeSources(ctx: Context, pool: AccountPool): ZcodeSources;
export declare class ZcodeSources {
    private ctx;
    private pool;
    private fetchImpl;
    private cache;
    constructor(ctx: Context, pool: AccountPool, fetchImpl?: typeof fetch);
    private read;
    private get;
    private projectKey;
    private quota;
    private discover;
    private load;
    list(accountId: string, refresh?: boolean): Promise<{
        accountId: string;
        selected: string;
        sources: {
            id: string;
            label: string;
            kind: ZcodeSourceProjection["kind"];
            available: boolean;
            reason?: string;
            quota?: string;
        }[];
    }>;
    select(accountId: string, sourceId: string): Promise<void>;
    resolve(entry: ProviderAccountEntry, c: ZcodeCredential): Promise<ZcodeCredential>;
}
//# sourceMappingURL=zcode-sources.d.ts.map