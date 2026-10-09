import type { CodeArtsCredential } from './types.js';
/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export declare const OPENGW_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";
/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export declare const SNAP_MODEL_BUILTIN_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin";
/**
 * 远端不可用时的 benefit 模型兜底集合。
 *
 * **为什么需要它**：benefit 模型调用必须带 `maas_type: benefit`（参与
 * SDK-HMAC-SHA256 签名），否则后端返回
 * `InferHub.002002009.404 The model is not registered`。该集合的权威来源是
 * `opengw gateway/config` 的 `result.models`（见 {@link fetchCodeArtsRemoteModels}），
 * 但首次启动、未登录或远端拉取失败时拿不到，故保留一份兜底。
 *
 * 实证（2026-09-23，对齐 deveco-code-rust fb1b4a2）：
 * 1. IDE kernel 日志的 `inferhub-provider [header-debug] full headers` 显示
 *    `deepseek-v4.1-flash` 的实际出站请求带 `"maas_type":"benefit"`；
 * 2. 逐个对照两个端点的模型：`gateway/config` 的模型（glm-5.3-flash、
 *    deepseek-v4.1-flash 等）不带该头一律 404 not registered、带上即成功；
 *    而 `/v1/model/builtin` 的模型（GLM-5.2 等）带上反而 `unsupported model`。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）**不在**此集合：
 * 它们是后端另外注册的非 benefit 模型，带上 maas_type 会报 unsupported model。
 * 尤其注意 gateway/config 返回的是它们的**带日期后缀**形态
 * （`deepseek-v4-flash-0731`），归一化后落到这两个 id —— 绝不能连带标成 benefit。
 */
export declare const CODEARTS_BENEFIT_FALLBACK: readonly string[];
/** 定时刷新远端模型列表的间隔（2 小时）。 */
export declare const MODEL_REFRESH_INTERVAL_MS: number;
export interface RemoteModel {
    id: string;
    name: string;
}
/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export declare function normalizeModelId(id: string): string;
/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 */
export declare function fetchCodeArtsRemoteModels(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<RemoteModel[]>;
/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export declare function saveModelsCache(models: RemoteModel[]): void;
/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export declare function loadModelsCache(): RemoteModel[] | undefined;
/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export declare function availableCodeArtsModels(): RemoteModel[] | undefined;
/** 设置内存缓存（由 service 拉取成功后调用）。 */
export declare function setMemoryCache(models: RemoteModel[] | undefined): void;
/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定会回退到静态兜底集合。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export declare function saveBenefitCache(ids: readonly string[]): void;
/** 加载缓存文件中的 benefit 模型 id 集合；文件不存在或解析失败时返回 undefined。 */
export declare function loadBenefitCache(): string[] | undefined;
/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export declare function setBenefitMemoryCache(ids: string[] | undefined): void;
/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`。
 *
 * 优先级：内存缓存 → 磁盘缓存（远端拉取所得）→ 静态兜底集合。
 * 远端集合优先，使后端新增 benefit 模型时**无需改代码**即可自动识别。
 *
 * ⚠️ 判定**不是**「名字里带 flash」这类猜测：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却相反。唯一权威来源是
 * gateway/config 的模型清单 + 兜底表。
 */
export declare function isCodeArtsBenefitModel(model: string): boolean;
//# sourceMappingURL=models.d.ts.map