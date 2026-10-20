/**
 * ZCode 上游 HTTP 客户端（额度 / 签到 / 模型目录）。
 *
 * ## 这一层与其它 provider 的差异
 *
 * 其它 provider 的「额度 / 签到」是各家私有协议；ZCode 这套的**特点**是
 * 同一组请求头要在三处复用，且**鉴权要求按端点不同**（实测）：
 *
 * | 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
 * |---|---|---|
 * | `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
 * | `GET /zcode-plan/billing/preview` | 否 | 是 |
 * | `POST /api/v1/event/report` | 否 | 是 |
 * | `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
 * | `GET /api/v1/client/configs` | **是** | 是 |
 *
 * ⚠ 这两条都踩过：不带 `Authorization` 查额度得 **401**；
 * 不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 *
 * ## 签到为什么要「补激活上报」
 *
 * 服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：
 *
 * ```
 * 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}          ← 空
 * 补之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
 * ```
 *
 * **⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以要领额度必须**先补两条事件**，再查 preview，再 claim。
 */
import type { ZcodeCredential } from './zcode.js';
import type { ZcodeRemoteModelLike } from './zcode-product.js';
/** ZCode 平台 origin（官方默认）。 */
export declare const ZCODE_ORIGIN = "https://zcode.z.ai";
/** 免费额度通道的 Anthropic 端点。 */
export declare const ZCODE_PLAN_MESSAGES_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
/**
 * 按通道返回「Messages」端点。
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都走 `zcode.z.ai`**
 * —— 官方分派表（`resources/config/provider/zcode-builtin.json`）的规则 2/5
 * 明确如此，2026-10-03 实测复核。**不要**因为账号是国际版就改域名。
 *
 * ⚠ 订阅制（`coding-plan`）才走 `api.z.ai`（官方规则 0/1，2026-10-03 实测
 * `GET https://api.z.ai/api/anthropic/v1/models` 返回 200 + 11 个模型）。
 */
export declare function zcodeMessagesUrl(channel: 'start-plan' | 'coding-plan'): string;
/** 额度余额端点（**需要 Authorization**）。 */
export declare const ZCODE_BILLING_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
/** 可领活动预览端点（**不需要 Authorization**）。 */
export declare const ZCODE_BILLING_PREVIEW_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
/** 领取端点（**需要 Authorization + captcha**）。 */
export declare const ZCODE_BILLING_CLAIM_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";
/** 客户端活跃上报端点（**不需要 Authorization**）。 */
export declare const ZCODE_EVENT_REPORT_URL = "https://zcode.z.ai/api/v1/event/report";
/** 客户端配置端点（captcha 配置与模型池都从这里来）。 */
export declare const ZCODE_CLIENT_CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs";
/**
 * 构造 ZCode 的「来源标识」请求头。
 *
 * ⚠ 这些头是官方客户端在真实流量里发的。实测**它们不是 3012 的判据**
 * （判据是请求体里的 system 内容），但它们仍是「像官方客户端」的一部分，
 * 且 `X-Device-Mid` **是硬需求**（缺它 billing 全家桶回 400）。
 */
export declare function buildZcodeHeaders(credential: Pick<ZcodeCredential, 'device_mid' | 'app_version'>, options?: {
    authorization?: string;
    json?: boolean;
    captcha?: {
        param: string;
        region: string;
    };
}): Record<string, string>;
/** 一次额度桶（`balances[]` 的一项）。 */
export interface ZcodeBalanceBucket {
    planId?: string;
    /** 展示名（实测为模型名，如 `GLM-5.3-Flash`）。 */
    showName?: string;
    /**
     * ★ **计量单位** —— 上游明确下发，实测为 `"token"`。
     *
     * ⚠ **真实缺陷**（用户报障）：「智谱 plan 给的不是积分是 tokens，
     * 应该显示 `Token: xx.yyM` 这种格式」。
     *
     * 上游 `billing/balance` 的桶里有两个字段直接说明单位：
     * ```json
     * { "meter": "model_usage", "unit_type": "token",
     *   "total_units": 100000000, "used_units": 5460725,
     *   "remaining_units": 94539275 }
     * ```
     * 此前我们把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、
     * 且量级看起来像积分），而正确形态是 **`94.54M` tokens**。
     */
    unitType?: string;
    /** 计量口径（实测 `model_usage`）。 */
    meter?: string;
    totalUnits?: number;
    usedUnits?: number;
    remainingUnits?: number;
    availableUnits?: number;
    /** 到期时间（Unix 秒）。 */
    expiresAt?: number;
}
/** 余额查询结果。 */
export interface ZcodeBalanceResult {
    /** 是否为「企业版」等不下发额度数字的形态（此时 buckets 为空）。 */
    enterprise?: boolean;
    buckets: readonly ZcodeBalanceBucket[];
    /** 汇总剩余额度（所有桶累加）。 */
    remaining: number;
    /** 汇总总量。 */
    total: number;
    /** 最早到期时间（Unix 秒），用于展示解禁时刻。 */
    expiresAt?: number;
    /** 显示名（首个桶的模型名）。 */
    planName?: string;
    /**
     * ★ 可领活动摘要（来自 `billing/preview`）。
     *
     * ⚠ **必需存在的原因**（2026-10-03 实测）：每日赠送的 start-plan 额度
     * **不在 `buckets` 里**，只在 `preview.plans` 里 ——
     * 同一账号 `balances` 返回 0 个桶、`preview` 返回 `…start-plan-trust-1003`。
     * 只读 `buckets` 会让面板显示 0，而用户实际能领 1 亿 tokens。
     *
     * ⚠ 取不到时是**空数组**（不 undefined）：preview 失败属降级，
     * 绝不能让它影响 `remaining`/`total` 本身。
     */
    claimablePlans: ZcodeClaimablePlanSummary[];
    /** preview 查询成功；失败不能推断为已领取。 */
    claimablePlansKnown?: boolean;
    /** 已领取且未过期的活动，包括待生效权益。 */
    ownedPlanIds?: readonly string[];
    /** 已领取但尚未生效；不计入当前可用余额。 */
    pendingGrants?: readonly ZcodePendingGrant[];
}
export interface ZcodePendingGrant {
    planId: string;
    name: string;
    amount: number;
    unit: string;
    effectiveAt: number;
}
export declare function describeZcodePendingGrants(grants?: readonly ZcodePendingGrant[]): string;
/** 一次可领活动。 */
export interface ZcodeClaimablePlan {
    planId: string;
    priority: number;
    name?: string;
    /**
     * ★ 本次领取能拿到的**额度数值**（实测自 `plan.entitlements[].grant_units`）。
     *
     * ⚠ 上游**不在** plan 顶层给额度，只在 `entitlements[]` 里。拿不到时
     *   留 undefined —— 此时 `toClaimOutcome` 退回 0（不谎报）。
     */
    grantUnits?: number;
    /**
     * ★ 额度单位（`'token'` / 缺省按积分）。
     *
     * ⚠ ZCode 下发 `unit_type: "token"`，**不是**积分 —— 展示必须走
     *   `formatUnits`/`unitLabel`（`plugin-src/client/credits-format.js`）。
     */
    unitType?: string;
}
/** 领取结果。 */
export interface ZcodeClaimOutcome {
    planId: string;
    /** 上游业务码：`0` 成功、`1003` 已领取（幂等成功）。 */
    code?: number;
    ok: boolean;
    /** 已领取过（幂等，视为成功）。 */
    alreadyClaimed?: boolean;
    httpStatus?: number;
    message?: string;
}
/**
 * 查余额。
 *
 * ⚠ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。
 *
 * 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 ——
 * 此时返回 `{enterprise:true, buckets:[]}`，**不要**显示成 0
 * （0 是「已用光」的语义）。
 */
export declare function fetchZcodeBalance(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeBalanceResult | undefined>;
/** `ZcodeBalanceResult` 里由 `preview` 带出的可领活动。 */
export interface ZcodeClaimablePlanSummary {
    planId: string;
    showName?: string;
    amount?: number;
}
/**
 * 补客户端活跃信号。
 *
 * ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []` ——
 * 于是「今天可领」永远是「没有可领」，用户以为签到坏了。
 *
 * 幂等（服务端按 device_mid + 日期去重），故每次查 preview 前都可以补。
 */
export declare function reportZcodeActivation(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<void>;
/** 查当前可领的活动。 */
export declare function fetchZcodeClaimablePlans(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<readonly ZcodeClaimablePlan[]>;
/**
 * 领取一个 plan。
 *
 * ⚠ **captcha 是一次性的**：每个 plan 都必须**重新 mint** 一个新 param。
 * 复用同一个 param 在索要验证的窗口里会得到 `3007`（captcha 校验失败）；
 * 本路径**每个 plan 都现产一个新的**，不去赌上游这一次校不校验。
 *
 * 业务码语义（桥侧实测记录）：
 *
 * | code | 含义 | 处理 |
 * |---|---|---|
 * | `0` | 成功领取 | ok |
 * | `1003` | **已领取过（幂等，不是错误）** | 视为成功 |
 * | `1001` | plan 不存在 | 失败 |
 * | `1002` | 活动已结束 | 失败 |
 * | `1004` | 不符合条件 | 失败 |
 * | `1005` | 名额用完 | 失败 |
 * | `3007` | captcha 失败（需换新 param） | 失败 |
 * | 401 | 未登录 | 失败 |
 */
export declare function claimZcodePlan(credential: ZcodeCredential, planId: string, captcha: {
    param: string;
    region: string;
}, fetchImpl?: typeof fetch): Promise<ZcodeClaimOutcome>;
/**
 * 拉服务端下发的 captcha 配置。
 *
 * ⚠ `platform` 必须是 **`unknown`** —— 实测 `win32` / `win64` / `windows` /
 * `electron` / `desktop` / `linux` 一律 `400 {"code":3001}`。
 * `unknown` 正是官方在非 Electron 上下文的取值。
 *
 * 失败返回 `undefined`，由调用方回退到内置兜底值
 * （{@link ZCODE_CAPTCHA_FALLBACK}）—— **不让配置拉取失败阻塞推理**。
 */
export declare function fetchZcodeCaptchaConfig(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<{
    region: string;
    prefix: string;
    sceneId: string;
} | undefined>;
/**
 * 从上游拉**模型目录**（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ## ⚠ 为什么要真拉，不能照抄兜底表
 *
 * **真实缺陷**（用户报障）：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而思考档位选择器**根本没出现** —— 尽管 ZCode IDE
 * 里可以设置。
 *
 * 兜底表当时填的是 `200_000` / `32_768`（**凭空估的**），且模型都标了
 * `supportsImage: true`（但上游说只有 Flash 有 `capabilities.vision`）。
 * ⇒ 这类「能力字段」必须**抄上游**，不能按「同族应该一样」推断。
 *
 * ## 上游形状（`GET /api/v1/client/configs` 的 `data.builtinModels`）
 *
 * ⚠ `builtinModels` 是**对象**（key 不是模型 id，实测为序号字串），
 * 故必须 `Object.values(...)` 而不是数组下标。实测两条：
 *
 * ```json
 * { "modelId": "GLM-5.3-Flash", "contextWindow": 1000000,
 *   "maxCompletionTokens": 128000,
 *   "capabilities": { "vision": true },
 *   "modalities": { "input": ["text","image","video"], "output": ["text"] },
 *   "reasoning": { "levels": { "low": {...}, "max": {...}, "high": {...} },
 *                  "defaultLevel": "max" } }
 * ```
 *
 * ⚠ `reasoning.levels` 的**键序**就是官方展示顺序（实测 low → max → high
 * 的插入序，但客户端按 `low/high/max` 渲染 —— 故我们**显式排序**为
 * `low → high → max`，与 IDE 截图一致；未知档位排在后面保持原序）。
 *
 * 失败返回 `undefined`，由调用方回退兜底表（**不让目录拉取失败让 provider 不可用**）。
 */
export declare function fetchZcodeModels(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeRemoteModelLike[] | undefined>;
//# sourceMappingURL=zcode-upstream.d.ts.map