/**
 * 从各渠道目录**推导**虚拟模型表：`虚拟模型(规范键) → 候选条目[]`。
 *
 * ## 输入从哪来
 *
 * 装配层把每个 provider 的 `ctx.llm.listModels(provider)` 结果传进来。⚠️ 该结果
 * **已被各适配器按用户黑名单过滤**（每个 `listModels` 内部都套了
 * `disabledModelsFor`）⇒ 被用户关闭的模型**天然不会**成为候选，无需在本层再筛。
 *
 * ## 两条不变的输出约定
 *
 * 1. **候选条目保留真实 id 与真实展示名**：面板子列表要逐行显示「哪个渠道的哪个
 *    modelId」，用户据此核查合并是否正确并逐条拒绝（设计文档 §7.1）；
 * 2. **虚拟模型按候选数降序、候选按渠道名升序**：降序让冗余度高的模型在前
 *    （渠道多 = 更不容易挂）；升序让面板与日志的顺序可比对。
 *
 * @module src/aggregate-catalog.ts
 */
/** 一条候选：某个渠道下承载该虚拟模型的那个真实模型。 */
export interface CandidateEntry {
    /** 渠道 id。 */
    provider: string;
    /** 该渠道的**真实** modelId（转发时用它，不是规范键）。 */
    realId: string;
    /** 该渠道的展示名（含倍率等运行时信息，原样保留）。 */
    realName: string;
    /** 倍率（`priceFactorFromName` 的结果，`Infinity` = 无标注）。 */
    price: number;
    /** 归属来源：`patch` 的条目应在面板上标 `⚠️补丁` 供人工核查。 */
    via: 'id' | 'name' | 'patch';
}
/** 一个虚拟模型：对外暴露的规范条目 + 它的候选表。 */
export interface VirtualModel {
    /** 规范键（= 对外 modelId）。 */
    key: string;
    /** 规范展示名。 */
    name: string;
    /** 候选表（按渠道名升序）。 */
    candidates: CandidateEntry[];
}
/** 目录条目形状（与 `LlmModelInfo` 的最小交集）。 */
export interface CatalogModel {
    id: string;
    name?: string;
}
/**
 * 构建虚拟模型表。
 *
 * @param catalogs - `provider → 该渠道的目录`（应已按用户黑名单过滤）。
 * @returns 虚拟模型数组：候选数降序，同数按 key 升序（结果稳定、可断言）。
 */
export declare function buildVirtualModels(catalogs: Readonly<Record<string, readonly CatalogModel[]>>): VirtualModel[];
//# sourceMappingURL=aggregate-catalog.d.ts.map