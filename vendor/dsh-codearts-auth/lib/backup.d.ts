import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { JetHubState, ModelDisableMap, PermanentLockMap } from './jet-hub-store.js';
import type { ProviderAccountEntry } from './types.js';
import { type BackupImportMode, type BackupPayload } from './types.js';
/**
 * 备份操作所需的账号池最小接口。
 *
 * 只声明实际用到的方法（结构化类型），使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface BackupPool {
    /** 读取完整状态快照（账号列表 + 模型黑名单 + Loomy 镜像字段）。 */
    getStateSnapshot(): JetHubState;
    /**
     * 读取「锁定永久积分」表（权威值）。
     *
     * ⚠️ 它**不在**状态快照里：那份文档是同机多 profile 共享的，旧版本代码
     * 全量重写时不会携带自己不认识的键，所以锁定表住在独立文档
     * （`$DSH_HOME/jet-hub/permanent-locks.json`），备份时单独取。
     */
    permanentLocksSnapshot(): PermanentLockMap;
    /** 整体替换账号列表、模型黑名单与各 provider 的永久积分锁定表。 */
    replaceAll(accounts: readonly ProviderAccountEntry[], disabledModels: ModelDisableMap, permanentLocks?: PermanentLockMap): Promise<void>;
    /**
     * **只追加**账号（合并导入用）：已有的账号一律不动，返回实际新增的 id。
     *
     * ⚠️ 与 {@link replaceAll} 的语义差别是本质的：合并导入**绝不**删除或覆盖
     * 任何现有账号，也不碰模型黑名单与锁定表 —— 用户从别人的备份里挑一个账号
     * 加进来的场景下，任何"顺手覆盖"都是数据损失。
     */
    mergeAccounts(accounts: readonly ProviderAccountEntry[]): Promise<string[]>;
}
/** 备份操作所需的凭据服务最小接口（`ctx.credentials` 结构上满足）。 */
export interface BackupCredentials {
    resolve(ref: CredentialRef): Promise<{
        value: string;
    } | undefined>;
    set(ref: CredentialRef, value: string): Promise<void>;
}
/**
 * 导出结果。
 *
 * `accountIds` 为空数组时与未传等价：导出全部账号。
 */
export interface BackupExportOptions {
    /**
     * 只导出这些账号 id（**单账号 / 多选导出**用）。
     *
     * ⚠️ 与「导出全部」的差别刻意收窄到**只影响 accounts 与 credentials 两个
     * 字段**：模型黑名单与永久积分锁定表仍按**全量**写出。理由是这样导出的文件
     * 仍是一份**自包含的完整快照**（可以当普通全量备份做整体还原），而
     * 「只挑一个账号合并导入」由导入侧的 `mode: 'merge'` 负责 —— 让过滤只承担
     * 一种语义，两条路径就不会互相污染。
     */
    accountIds?: readonly string[];
}
/** 导出结果。 */
export interface BackupExportResult {
    payload: BackupPayload;
    /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
    warnings: string[];
}
/** 导入结果。 */
export interface BackupImportResult {
    /** 写入的凭据条数。 */
    credentialsImported: number;
    /** 写入的账号数（合并模式下 = **实际新增**的账号数）。 */
    accountsImported: number;
    /**
     * 合并模式下**跳过**的账号 id：该 id 在当前池里已存在（按 id 判重）。
     *
     * ⚠️ 只在 `mode: 'merge'` 时有意义；`replace` 模式恒为空数组
     * （整体替换没有「跳过」这个概念）。
     */
    accountsSkipped: string[];
    /** 跳过的凭据 ref（非法 ref、值非字符串等）。 */
    skipped: string[];
    /**
     * 导入的账号中「凭据已过期」的条数（账号条目 `expiresAt <= 当前时刻`）。
     * 供前端提示：过期凭据若 refresh_token 仍有效会在请求时静默续期；
     * 若 refresh_token 也已失效则需重新登录。
     */
    expiredAccounts: number;
    /**
     * 导入的账号中「凭据缺失」的条数：账号条目的 credentialRef 不在备份的
     * credentials 字典里。这类账号导入后无凭据，对应 provider 目录会被门控
     * 隐藏（像未登录一样），供前端提示重新登录。
     */
    missingCredentials: number;
}
/** 备份文件格式校验失败。 */
export declare class BackupFormatError extends Error {
}
/** 导入选项。 */
export interface BackupImportOptions {
    /**
     * 导入模式，缺省 `replace`（整体替换，保持既有行为）。
     *
     * `merge` = 只追加、按 id 跳过已存在的账号，不碰黑名单与锁定表。
     */
    mode?: BackupImportMode;
}
/**
 * 导出账号 + 凭据 + 模型黑名单。
 *
 * 逐账号读取凭据；单个账号凭据缺失/损坏只记入 {@link BackupExportResult.warnings}，
 * 不中断整体导出 —— 换版本迁移场景下宁可先导出能导出的，也不要让一个坏账号
 * 挡住整份备份。
 *
 * `options.accountIds` 给出时只打包这些账号（及其凭据），用于「单独导出某个
 * 账号」；模型黑名单与锁定表**仍是全量**（见 {@link BackupExportOptions}）。
 */
export declare function exportBackup(pool: BackupPool, credentials: BackupCredentials, options?: BackupExportOptions): Promise<BackupExportResult>;
/**
 * 校验备份载荷的格式与版本；不合法时抛 {@link BackupFormatError}。
 *
 * 校验在前、写入在后：凭据与账号池都不可被错误格式的备份文件覆盖。
 */
export declare function assertBackupPayload(value: unknown): asserts value is BackupPayload;
/**
 * 导入备份。
 *
 * ## 两种模式（`options.mode`）
 *
 * | 模式 | 语义 | 用于 |
 * |---|---|---|
 * | `replace`（默认） | **整体替换**账号池与模型黑名单，还原快照 | 「恢复」按钮，换 DSH 版本后整体迁移 |
 * | `merge` | **只追加**：按 id 判重，已存在的账号一律跳过；**不碰**模型黑名单与锁定表 | 「单独导入一个账号」，从别人的备份里挑账号加进来 |
 *
 * ## 与写入顺序有关的约定
 *
 * - **先写凭据、后写账号池**：账号池写入成功后门控（`hasLoggedInAccount`）
 *   与黑名单立即反映新状态；凭据写入中途失败（非法 ref 等）只跳过该条、
 *   不中断整体。
 * - ⚠️ **`merge` 模式只写「确实要新增的账号」所引用的凭据**。它绝不回写
 *   备份里其余凭据（含各 provider 的默认单凭据 ref）—— 那些 ref 可能已被
 *   当前机器上的账号使用，回写等于**覆盖现有账号的凭据**，与「只增加」矛盾。
 * - 非法/值类型错误的凭据 ref 会被跳过并记录 —— `credentialRef()` 对非法
 *   POSIX 标识符抛错，`set` 也可能因存储后端拒绝而失败，都不应中断整体导入。
 * - 账号条目由 `replaceAll` / `mergeAccounts` 内部归一化（丢弃坏条目），
 *   保证坏数据不会进池。
 */
export declare function importBackup(credentials: BackupCredentials, pool: BackupPool, raw: unknown, options?: BackupImportOptions): Promise<BackupImportResult>;
//# sourceMappingURL=backup.d.ts.map