/**
 * 「用量徽标显示偏好」的**独立**持久化文档。
 *
 * ## 存的是什么
 *
 * 模型选择器旁那枚徽标在折叠态只显示一个读数：订阅（窗口百分比 / 套餐剩余）
 * 或积分余额。偏好就是「先显示哪个」：
 *
 * - `auto`（默认）：有订阅读数就显示订阅，否则显示积分；
 * - `subscription`：始终先试订阅（没有订阅数据的渠道自然回落到积分）；
 * - `credits`：始终显示积分（**也是套餐判定误判时的兜底开关**）。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `permanent-lock-store.ts` 同因：`$DSH_HOME/jet-hub/state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉。偏好被抹掉的后果只是「显示回落到默认」，
 * 远没有锁定表那么危险，但**没有理由把注定会被抹掉的字段放进去** ——
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 与 state.json 不同，这里没有「迁移」问题
 *
 * 本文件是新增能力，磁盘上不存在历史字段，故不需要 `permanent-lock-store.ts`
 * 那套「文档不存在时读老字段」的单向迁移。文档损坏 / 字段非法一律回落到
 * 默认值 `auto` 并留一条 warn —— 偏好是展示层设置，配置写坏不该让插件起不来。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 独立文档的文件名（与 state.json 同目录）。 */
export declare const BADGE_PREFERENCES_FILE = "ui-preferences.json";
/**
 * 三态偏好的**唯一权威枚举**。
 *
 * ⚠️ 前端（`plugin-src/client/badge-model.js`）与 RPC 校验都必须以它为准：
 * 客户端另写一份字面量数组会在将来加档位时静默漂移 —— 表现为「UI 能选、
 * 服务端一律 bad-request」。
 */
export declare const BADGE_PREFERENCES: readonly ["auto", "subscription", "credits"];
/** 偏好取值。 */
export type BadgePreference = (typeof BADGE_PREFERENCES)[number];
/** 默认偏好：自动（有订阅显示订阅，否则积分）。 */
export declare const DEFAULT_BADGE_PREFERENCE: BadgePreference;
/**
 * 归一化偏好：非法值（缺省 / null / 数字 / 大小写不同的串 / 未知档位）
 * 一律回落默认值。
 *
 * ⚠️ 刻意**不做**「宽松匹配」（如 `'Auto'` 判成 `auto`）：RPC 写入路径要求
 * 严格取值并拒绝非法输入（见 `usage.badgePreference`），若这里又悄悄接受
 * 变体，两处判据就会不一致。
 */
export declare function sanitizeBadgePreference(raw: unknown): BadgePreference;
/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type BadgePreferenceStoreKind = 'file' | 'memory';
/** 偏好文档的读写接口（同步读、异步写，与 `JetHubStore` 同款约定）。 */
export interface BadgePreferenceStore {
    readonly kind: BadgePreferenceStoreKind;
    /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值。 */
    load(): BadgePreference;
    /** 写入偏好（原子写）。 */
    save(preference: BadgePreference): Promise<void>;
}
/**
 * 创建偏好后端。
 *
 * home 的解析与账号池 / 锁定表**同一个函数**（`resolveJetHubHome`），保证三份
 * 文档永远落在同一目录 —— 否则会出现「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export declare function createBadgePreferenceStore(ctx: Context): BadgePreferenceStore;
//# sourceMappingURL=badge-preferences.d.ts.map