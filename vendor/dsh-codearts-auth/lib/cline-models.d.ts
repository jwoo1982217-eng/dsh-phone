/**
 * Cline 模型目录：远端拉取 + 兜底合并 + **免费判定**。
 *
 * ## 两个来源，必须都取
 *
 * | 端点 | 内容 | 认证 |
 * |---|---|---|
 * | `GET {apiBase}/api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
 * | `GET {apiBase}/api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id** | 需要 |
 *
 * ⚠️ **远端 `/models` 的 460 个 id 里根本没有 `cline-free/*`**
 * （实测 `Select-String 'cline-free/'` 零命中）。免费模型**只**由
 * `recommended-models` 下发 —— 这正是「只调 `/models` 会看不到任何免费模型」
 * 的原因，也是本模块必须同时打两个端点的理由。
 *
 * ⚠️ **内嵌目录**（`BUILTIN_MODEL_CATALOG`）与远端 `free` 数组**不完全重合**：
 * `stealth/space-bunny-alpha` 与 `cline-free/*` 不在内嵌目录里、只由远端 `free` 下发，
 * 反之 `/models` 有大量内嵌目录没有的付费模型。
 * ⚠️ 「内嵌目录」与 `cline-product.ts` 的**兜底表**（`CLINE_FALLBACK_MODELS`）是两个
 * 东西：后者**已经含有** `cline-free/*` 条目，说的只是它不来自内嵌目录。
 * 故正确做法是**合并**，而不是「远端失败就用兜底」的简单回退。
 * （2026-10-03 复测：`free` 只剩 4 条，`cline-free/gemini-3.8-flash` 已被上游下线。）
 *
 * ## 免费判定（不硬编码模型名）
 *
 * ```
 * isFree(id) = remoteFreeIds.has(id)        // recommended-models 的 free 数组
 *           || id.endsWith(':free')         // 内嵌目录里的 :free 条目
 *           || id.startsWith('cline-free/') // 命名约定兜底（远端未响应时）
 *           || fallbackEntry.isFree === true // 静态兜底表
 * ```
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
 * `deepseek/deepseek-v4.1-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 deepseek」之类的模糊匹配 —— 那会把付费条目误标为免费，
 * 用户按免费预期使用却被计费。
 *
 * 这一「集合动态判定、不硬编码」的做法与 CodeArts 的 benefit 集合同源
 * （见 `src/models.ts` 的 `isCodeArtsBenefitModel` 与 AGENTS.md 的对应章节）。
 */
import type { ClineCredential } from './cline.js';
import { type ClineFallbackModel, type ClineProduct } from './cline-product.js';
/** 单次模型目录请求超时（毫秒）。 */
export declare const CLINE_MODELS_TIMEOUT_MS = 20000;
/** 归一化后的模型条目。 */
export interface ClineModel {
    /** 模型 id（远端原样）。 */
    id: string;
    /** 展示名（**不含** `· 免费` 后缀，由 `clineDisplayName` 统一拼）。 */
    name: string;
    /** 上下文窗口；未知时不编造（`undefined`）。 */
    contextWindow?: number;
    /** 单次输出上限。 */
    maxTokens?: number;
    /** 是否接受图片输入。 */
    supportsImage?: boolean;
    /** 是否免费额度模型。 */
    isFree: boolean;
    /** 简介（远端 `free` 数组或兜底表下发）。 */
    description?: string;
}
/**
 * 判定某 id 是否免费。
 *
 * 判定顺序无关（是并集），但保留短路以省掉集合查找。
 * `remoteFreeIds` 为远端 `free` 数组的 id 集合（**最权威**）。
 */
export declare function isClineFreeModel(id: string, remoteFreeIds?: ReadonlySet<string>, fallback?: ClineFallbackModel): boolean;
/**
 * 展示名：免费模型拼 ` · 免费`。
 *
 * ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（`dsh-client-ui-model-selection` 的 ModelSelect 里只有
 * `title: model.name` 与 `children: model.name`，**完全不读 `description`**）。
 * `description` 只在 `/model` 弹窗里用。这是被用户报障纠正过的结论
 * （「消耗倍率没有显示在切换模型列表的后面」）。
 *
 * `name` 纯属展示：DSH 的选择与持久化只用 `id`，故附加标记不会污染会话历史。
 */
export declare function clineDisplayName(model: {
    name: string;
    isFree: boolean;
}): string;
/** 解析远端 `recommended-models` 响应，取出三个数组的条目。 */
export interface ClineRecommendedModels {
    /** `free` 数组（免费模型，**最权威**）。 */
    free: Array<{
        id: string;
        name?: string;
        description?: string;
    }>;
    /** `recommended` 数组。 */
    recommended: Array<{
        id: string;
        name?: string;
        description?: string;
    }>;
    /** `clinePass` 数组（订阅制模型，**不属于免费集合**）。 */
    clinePass: Array<{
        id: string;
        name?: string;
        description?: string;
    }>;
}
/**
 * 解析 `recommended-models` 响应。
 *
 * ⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型
 * （`cline-pass/*`），按订阅额度计费而非免费。把它当免费会误导用户。
 */
export declare function parseClineRecommendedModels(value: unknown): ClineRecommendedModels;
/** 解析 `/api/v1/models` 响应，取出 id 列表。 */
export declare function parseClineRemoteModelIds(value: unknown): string[];
/**
 * 合并三个来源为最终目录。
 *
 * 顺序（决定列表展示顺序）：
 * 1. **免费模型在前**（用户最关心；且远端 `free` 数组本身就有序）；
 * 2. 兜底表里其余条目（保持表内顺序，提供元数据）；
 * 3. 远端 `/models` 的其余 id（**放最后**，它们只有裸 id、无元数据，
 *    且数量达 460 个 —— 放前面会把免费模型挤到看不见）。
 *
 * ⚠️ **兜底表不是无条件并入的**：远端成功下发目录时，兜底表里「远端已不认识」
 * 的条目会被丢弃（那是上游下架的模型），只在远端不可用时才整表保底。
 * 判据与理由见下面第 2 步的注释。
 *
 * 元数据优先级：兜底表（有 `contextWindow` / `maxTokens` / `capabilities`）
 * > 远端 `free`/`recommended` 的 `description`/`name` > 由 id 派生的名字。
 */
export declare function mergeClineModels(product: ClineProduct, remote: {
    freeIds: readonly string[];
    remoteIds: readonly string[];
    entries: readonly {
        id: string;
        name?: string;
        description?: string;
    }[];
}): ClineModel[];
/** 远端拉取的原始结果（任一失败都返回空数组，不影响另一个）。 */
export interface ClineRemoteModels {
    freeIds: string[];
    remoteIds: string[];
    entries: Array<{
        id: string;
        name?: string;
        description?: string;
    }>;
    /** 各来源的失败原因（供日志与探针诊断；成功时为空）。 */
    warnings: string[];
}
/**
 * 拉取远端模型数据。
 *
 * **两个端点独立容错**：`recommended-models` 失败不应让 `/models` 的结果作废
 * （反之亦然）。任一端点挂掉时只记 warning，由 `mergeClineModels` 用兜底表
 * 补齐 —— 这样「目录服务抖动」不会让用户的模型列表整个消失。
 *
 * `recommended-models` **不需要认证**（实测匿名 200），故它可以在凭据缺失时
 * 单独调用（供只读探针与首启场景使用）。
 */
export declare function fetchClineRemoteModels(product: ClineProduct, options?: {
    credential?: ClineCredential;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<ClineRemoteModels>;
/**
 * 完整目录：远端 + 兜底合并。
 *
 * 供适配器的 `listAllModels()`（设置页）与 `listModels()`（选择器）共用，
 * 保证两处看到同一份数据。
 */
export declare function loadClineModels(product: ClineProduct, options?: {
    credential?: ClineCredential;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<{
    models: ClineModel[];
    warnings: string[];
    remote: ClineRemoteModels;
}>;
/**
 * 这次是否**真的拿到了远端条目**。
 *
 * ⚠ 不能用 `models.length === 0` 判断：{@link mergeClineModels} 会**无条件**
 * 把兜底表并进结果（这是展示需要），实测两个端点全挂时 `models.length` 仍是 5。
 * 用长度判「没拿到目录」是死代码，冷却永不触发 ⇒ 兜底被当成远端结果永久缓存。
 */
export declare function hasClineRemoteModels(remote: ClineRemoteModels): boolean;
//# sourceMappingURL=cline-models.d.ts.map