/**
 * Accio（阿里 Accio Work）provider 的产品配置 —— **唯一真相源**。
 *
 * ## 与其它 product 的形态关系
 *
 * 与 `LobsteraiProduct` / `TraeProduct` / `MinimaxProduct` **平行而非继承**：
 * 那些字段全部围绕各自协议设计，对 Accio 无一有意义。
 *
 * ## 区域（`cn` / `global`）
 *
 * ⚠️ **gateway 恒同一个**（`phoenix-gw.alibaba.com`），与区域无关；
 * 只有**登录页域名**不同。区域由服务端按账号下发（`userinfo.routeRegion`，实测 `CN`）。
 * 故区域是**登录参数**，不是第二个 provider id（用户 2026-10-12 裁定）——
 * 这也避免了「两个 provider 共用同一 gateway」给用户带来的困惑。
 *
 * ## 数据来源
 *
 * 全部来自 2026-10-12 的逐字逆向（`app.asar`）与本机实测。
 * 详见 `docs/agent-notes/providers-accio.md`。
 */
/** 登录区域。 */
export type AccioRegion = 'cn' | 'global';
/** 兜底模型条目。远端目录是**动态**拉取的，本表只作离线回退。 */
export interface AccioFallbackModel {
    /** 上游 `modelCode`。⚠️ 形如 `1Drift-N8kP2Q7wR5mX`，**非人类可读**。 */
    id: string;
    /** 展示名（**不含**倍率后缀；倍率由适配器拼进 `name`）。 */
    name: string;
    contextWindow: number;
    maxTokens?: number;
    supportsImage: boolean;
    /**
     * 计费倍率（上游 `effectiveMultiple`）。
     *
     * ⚠️ 跨度 0.013 ~ 2.8（**215 倍**），是用户选型时最重要的信号 ——
     * 必须在展示名里体现（本仓库既有约定：倍率写进 `name`，不是 `description`）。
     */
    multiple?: number;
    /**
     * 思考档位（上游 `reasoningEfforts`），**原样保留**远端下发的顺序。
     *
     * ## 为什么必须声明它（2026-10-13 实测，用户要求）
     *
     * 用户原话：「accio 的模型没有档位，需要有档位即使是只有一档也要显示，
     * 使用远端真实下发的档位」。
     *
     * ⚠️ 本次**推翻**了笔记 §4.4.1 的旧结论「思考关不掉 ⇒ 目录里不声明任何档位」——
     * 那条结论来自**用非法值**（`off` / `none` / `minimal`，都不在远端声明的集合里）
     * 做的对照。本轮用**远端声明的合法档位**实测，`thoughts_token_count`
     * 中位数随档位**单调递增**（Ultimate 五档：33→40→41→43→43）⇒ 档位**真实生效**。
     *
     * ⚠️ **`null` 与 `[]` 都必须如实表达为「无档位」**（远端 38 条里 31 条是 `null`）：
     * 编造档位会让用户选了一个**服务端不认**的值。
     */
    efforts?: readonly string[];
    /**
     * 默认档位（上游 `defaultReasoningEffort`）。
     *
     * ⚠️ 实测有三种形态，**必须都如实处理**：
     * - 与 `efforts` 同时给出（如 Ultimate：`default="high"` + 5 档）⇒ 直接用；
     * - **只给 default、`efforts` 为 `null`**（如 GLM-5.3 `default="max"`、
     *   MiniMax M3 `default="adaptive"`）—— 实测**把该值发过去服务端接受**
     *   （`max` / `adaptive` 都 ✅）⇒ 它就是一个**可用的单档**；
     * - 两者都为 `null`（如 Qwen 3.8 Flash）⇒ 确实无档位信息。
     */
    defaultEffort?: string;
}
export interface AccioProduct {
    id: 'accio';
    displayName: string;
    /** API 网关（**与区域无关**）。 */
    gatewayBaseUrl: string;
    /** 登录域（**按区域**）。 */
    loginBaseUrlOf(region: AccioRegion): string;
    /** 公开客户端 id（**无 client_secret**）。 */
    clientId: string;
    defaultCredentialRef: string;
    /** 请求头里的固定 appKey（**不是产品名**）。 */
    appKey: string;
    appVersion: string;
    fallbackModels: readonly AccioFallbackModel[];
}
export declare const ACCIO_TOKEN_EXCHANGE_PATH = "/api/oauth/token";
export declare const ACCIO_REFRESH_PATH = "/api/auth/refresh_token";
export declare const ACCIO_LLM_PATH = "/api/adk/llm/generateContent";
export declare const ACCIO_CATALOG_PATH = "/api/llm/config/v2";
export declare const ACCIO_USERINFO_PATH = "/api/auth/userinfo";
export declare const ACCIO_SUBSCRIPTION_PATH = "/api/entitlement/currentSubscription";
export declare const ACCIO_QUOTA_PATH = "/api/entitlement/quota";
export declare const ACCIO_REQUEST_TIMEOUT_MS = 30000;
/** 登录等待回调的上限（10 分钟，与 trae 同量级）。 */
export declare const ACCIO_LOGIN_TIMEOUT_MS = 600000;
export declare const ACCIO_REGIONS: readonly AccioRegion[];
export declare const ACCIO: AccioProduct;
//# sourceMappingURL=accio-product.d.ts.map