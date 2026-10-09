/**
 * Gemini（Cloud Code Assist）**配额窗口**查询。
 *
 * 逐点移植自 `cmdc-pak-align-wb/internal/upstream/gemini/quota.go`。
 *
 * ## 端点与身份
 *
 * `POST {sandbox}/v1internal:retrieveUserQuotaSummary`，身份头与推理请求
 * **完全一致**（`geminiHeaders`），Bearer 用 `access_token`。
 *
 * ## ⚠️ 请求体**必须带 `project`**（2026-10-03 修正）
 *
 * 原版（`quota.go:25`）发的是空对象 `{}`，那是**单账号**抓包的结论。实测**另一个**
 * Google 账号（账号已脱敏）用 `{}` 会被拒：
 *
 * ```
 * 403 PERMISSION_DENIED  SUBSCRIPTION_REQUIRED (#3501)
 * "You do not have a valid license of this product."
 * ```
 *
 * 而**同一个 token、同一组身份头**，只要请求体带上 `{"project":"aicode-consumers"}`
 * 就 200 —— 唯一的变量就是 `project`。同一账号的**推理**请求本来就在信封里带
 * `project`（`gemini-messages.ts:278`），所以只有配额这条链路会 403：
 * 面板显示「凭据已失效」，而「测试」按钮照样能发请求（用户 m07113 报障）。
 *
 * 字段名是 `project`，**不是** `cloudaicompanionProject` —— 后者会 400
 * `Unknown name "cloudaicompanionProject": Cannot find field.`。值取凭据里的
 * `cloudaicompanionProject`（`loadCodeAssist` 的回报，实测恒为 `aicode-consumers`），
 * 缺失时退到 {@link GEMINI_DEFAULT_PROJECT}。
 *
 * ⚠️ 走 **sandbox** 端点而不是 daily：原版 `baseFor(path)` 把
 * `loadCodeAssistPath` / `retrieveQuotaPath` 两类路径固定路由到 sandbox，
 * 其余（含推理）才走轮换端点。忠实移植这个路由，不"顺手统一"。
 *
 * ## ⚠️ 这不是「积分余额」
 *
 * Gemini 免费线是**配额窗口**制（5 小时 / 周两个窗口的**剩余比例**），
 * 不是充值积分。面板如实显示「5 小时窗口 99% / 周窗口 99%」，
 * **不**换算成任何积分数字 —— 那会是编造。
 *
 * ## ⚠️ 桶 id 是判据，`displayName` 不是
 *
 * 响应里第三组桶（`3p-*`）属于 Claude/GPT 产品线，与本 provider 无关。
 * 只认 `gemini-5h` / `gemini-weekly` 两个 id，**不按显示名匹配** ——
 * 显示名会被上游改文案，id 不会。
 *
 * ## ⚠️ `resetTime` 解析失败 ⇒ **整条桶丢弃**
 *
 * 原版 `windowOf` 的口径：拿不到可解析的重置时间就无法表达窗口周期，
 * 编一个空串会让面板显示一个**永远不过期**的窗口。宁可少一个包，也不伪造。
 *
 * ## ⚠️ 未授权**不是错误**
 *
 * 没有 access_token 时返回 `{ balance: null, error: '尚未授权 Google 账号' }`
 * （照原版 `MessageUnauthorized`）。面板靠这条文案区分「没登录」与
 * 「查询失败」—— 把它抛成异常会让账号卡片显示成故障。
 *
 * ## 账号规格（`tier`）搭这趟车
 *
 * 面板还要显示「这是 Pro 还是 Free」。规格来自 `loadCodeAssist`，与配额是
 * **两个端点**，但**并行发在同一次调用里**（面板 30 秒刷一次，多一个独立
 * RPC 只会多一份编排）。取到的档位挂在 {@link GeminiBalanceResult.tier} 上，
 * 失败就 `undefined`（不渲染那一行），**绝不影响配额行**。
 */
import { type CreditBalance } from './credits.js';
import { type GeminiCredential, type GeminiProduct } from './gemini.js';
/** 未授权时的文案（原版 `MessageUnauthorized`，面板据此区分「没登录」）。 */
export declare const GEMINI_UNAUTHORIZED_MESSAGE = "\u5C1A\u672A\u6388\u6743 Google \u8D26\u53F7";
/** 5 小时窗口的桶 id。 */
export declare const GEMINI_BUCKET_FIVE_HOUR = "gemini-5h";
/** 周窗口的桶 id。 */
export declare const GEMINI_BUCKET_WEEKLY = "gemini-weekly";
/** 面板里两个窗口的显示名（**不是**积分，故不写「积分」二字）。 */
export declare const GEMINI_WINDOW_LABEL_FIVE_HOUR = "5 \u5C0F\u65F6\u7A97\u53E3";
export declare const GEMINI_WINDOW_LABEL_WEEKLY = "\u5468\u7A97\u53E3";
/**
 * 账号规格（Google 档位）。
 *
 * ⚠️ **判据是 `paidTier`，不是 `currentTier`**：实测两个账号的 `currentTier`
 * 都是 `{id:'free-tier',name:'Antigravity'}`，**完全一样**；真正区分「有没有
 * Google AI Pro」的是 `paidTier`（`g1-pro-tier` / `Google AI Pro` 对
 * `free-tier` / `Antigravity Starter Quota`）。原版 `project.go:25-34` 的
 * `loadCodeAssistResponse` **没有 `paidTier` 字段**，所以原版做不到这件事
 * —— 这是我们的新增能力，不要"对齐原版"把它删掉。
 *
 * ⚠️ `currentTier` 只作兜底（`paidTier` 缺席时）。
 */
export interface GeminiAccountTier {
    /** 上游档位 id（`g1-pro-tier` / `free-tier`），hover 里原样展示。 */
    readonly id: string;
    /** 上游档位名（`Google AI Pro`），hover 里原样展示。 */
    readonly name: string;
    /** 面板上的短标签：`Pro` / `Free` / `Ultra`。 */
    readonly label: string;
}
/**
 * 从 `loadCodeAssist` 响应里解出账号规格。
 *
 * ⚠️ 只读 `paidTier` / `currentTier` 的 `id` / `name`。响应里还有
 * `description`、`privacyNotice.noticeText`（一大段英文隐私说明）、
 * `allowedTiers` —— **一个都不要展示**。
 */
export declare function parseGeminiAccountTier(payload: unknown): GeminiAccountTier | undefined;
/** 归一后的一个配额窗口。 */
export interface GeminiQuotaWindow {
    readonly bucketId: string;
    /** 上游自报的窗口名（`5h` / `weekly`），仅诊断用。 */
    readonly window: string;
    /** 窗口重置时刻（原样透传给面板的 `cycleEndTime`）。 */
    readonly resetTime: string;
    /** 剩余比例 0..1（上游原值，未取整）。 */
    readonly remainingFraction: number;
}
/** 一次配额查询的结果（**不抛错**，失败用 `error` 表达）。 */
export interface GeminiBalanceResult {
    balance: CreditBalance | null;
    error?: string;
    /**
     * 账号规格（`loadCodeAssist` 顺带取的档位）。
     *
     * ⚠️ **可选且与 `error` 无关**：档位查询失败（网络/上游改协议）绝不能让
     * 配额行跟着报错 —— 它只是一栏附注信息。拿不到就不渲染那一行。
     */
    tier?: GeminiAccountTier;
}
/** {@link fetchGeminiCreditBalance} 的可选参数。 */
export interface GeminiCreditOptions {
    /** 跳过缓存（面板「刷新」按钮）。 */
    force?: boolean;
    /** 时钟注入（测试用）。 */
    now?: () => number;
    /** fetch 注入（测试用）。 */
    fetcher?: typeof fetch;
}
/** 清空缓存（测试与「重置限流标记」用）。 */
export declare function clearGeminiCreditCache(): void;
/** 解析单个桶；任何硬约束不满足即返回 `undefined`（**不编造**）。 */
export declare function parseGeminiQuotaWindow(raw: unknown): GeminiQuotaWindow | undefined;
/**
 * 从响应体里挑出两个 Gemini 桶。
 *
 * 形状（原版注释里的实测结论，**普通 JSON 不是 protobuf**）：
 * ```json
 * {"groups":[{"displayName":"Gemini Models","buckets":[
 *   {"bucketId":"gemini-weekly","window":"weekly","resetTime":"…","remainingFraction":0.99},
 *   {"bucketId":"gemini-5h","window":"5h","resetTime":"…","remainingFraction":0.99}]},
 *  {"displayName":"Claude and GPT models","buckets":[…]}]}
 * ```
 *
 * ⚠️ 按 `bucketId` 匹配，**不按 `displayName` / `window`**：显示名是文案、
 * 会变；`window` 字段在实测里出现过缺失。id 是唯一稳定判据。
 */
export declare function parseGeminiQuotaWindows(payload: unknown): {
    fiveHour?: GeminiQuotaWindow;
    weekly?: GeminiQuotaWindow;
};
/**
 * 两个窗口 → 插件统一的 {@link CreditBalance}。
 *
 * ⚠️ `total` 取两窗口剩余百分比的**平均**（面板顶部的汇总数字）——
 * 对照 `src/cline-credits.ts:110` 的 `toClineCreditBalance` 口径：
 * 它那里只有一个数字可用，这里有两个，取平均是最不误导的汇总
 * （取 min 会把「周窗口 99% / 5 小时窗口 20%」显示成 20%，
 * 让用户以为整条线快用完了）。
 *
 * ⚠️ `expiredTotal` 恒 0：配额窗口没有"过期积分"这个概念。
 */
export declare function toGeminiCreditBalance(fiveHour?: GeminiQuotaWindow, weekly?: GeminiQuotaWindow): CreditBalance;
/**
 * 查询配额窗口。
 *
 * ⚠️ **本函数不抛错**（与 `fetchClineCreditBalance` / `fetchMinimaxCreditBalance`
 * 同契约）：批量查询时单账号失败不得中断其余账号。
 *
 * @param credential - 目标账号凭据。
 * @param _product - 为与其余 provider 的 `fetch*CreditBalance(credential, product)`
 *   签名保持一致而保留（配额端点是全局固定的，不需要产品配置）。
 */
export declare function fetchGeminiCreditBalance(credential: GeminiCredential, _product?: GeminiProduct, options?: GeminiCreditOptions): Promise<GeminiBalanceResult>;
//# sourceMappingURL=gemini-credits.d.ts.map