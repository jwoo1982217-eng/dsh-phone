/**
 * ZCode 的**通道传输层**：只回答「这个模型走哪条腿、用什么凭据」。
 *
 * ## 为什么单独一个文件
 *
 * ZCode 的两条通道（`start-plan` 积分 / `coding-plan` 订阅）**响应格式完全相同**
 * —— 官方配置 `resources/config/provider/zcode-builtin.json` 里两条
 * `providerRules` 的 `api.type` 都是 `anthropic-messages`（2026-10-03 实测）。
 * 只有**端点与凭据**不同。
 *
 * ⇒ 本文件只管选路与组装；SSE 解析复用 `zcode-anthropic.ts`（**不改动它**）。
 *
 * ## 通道定义（全部来自 2026-10-03 的实测与官方配置逆向）
 *
 * | 通道 | 端点 | 凭据 |
 * |---|---|---|
 * | `start-plan` | `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | `zcode_jwt` |
 * | `coding-plan` | `api.z.ai/api/anthropic/v1/messages` | `coding_plan_key_zai` / `_bigmodel` |
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都发 `zcode.z.ai`**
 * （官方分派表规则 2/5）—— **不要**因为账号是国际版就改域名。
 *
 * ⚠ `coding-plan` 的 api-key **不是登录时下发的**，是用 OAuth access_token 换取的
 * （逆向官方 `AccountProviderApiKeyResolver`），见 {@link fetchCodingPlanApiKey}。
 */
import type { ZcodeCredential } from './zcode.js';
/** ZCode 的两条上游通道。 */
export type ZcodeChannel = 'start-plan' | 'coding-plan';
/** 一条通道的可用性与它承载的模型。 */
export interface ZcodeChannelInfo {
    readonly channel: ZcodeChannel;
    /** 凭据是否具备该通道所需的字段。 */
    readonly available: boolean;
    /** 该通道承载的模型（小写 model id）。 */
    readonly models: readonly string[];
}
/**
 * 换取 coding-plan api-key 时用的 biz origin。
 *
 * ⚠ 2026-10-03 实测：两个候选里只有它通（`chat.z.ai` 的
 * `/api/biz/customer/getCustomerInfo` 回 404）。
 */
export declare const ZCODE_BIZ_ORIGIN = "https://api.z.ai";
/** 列出两条通道的可用性与模型。 */
export declare function describeChannels(credential: ZcodeCredential): ZcodeChannelInfo[];
/**
 * 这个模型优先走哪条通道。
 *
 * ⚠ **start-plan 优先**（用户 2026-10-03 决定）：积分是白给的，
 * 不该被「订阅额度」先消耗掉。失败时的换腿重试由调用方（适配器）负责。
 *
 * ⚠ 判据是**模型是否属于该通道**；凭据缺失时退回 `start-plan`
 * （保守：那是已验证可用的一条腿），**不抛错**。
 */
export declare function resolveChannelFor(credential: ZcodeCredential, model: string): ZcodeChannel;
/**
 * 组装一条通道的请求（URL + 头 + 凭据）。
 *
 * ## 凭据按通道取
 * | 通道 | Authorization |
 * |---|---|
 * | `start-plan` | `Bearer <zcode_jwt>` |
 * | `coding-plan` | `Bearer <coding_plan_key_zai ?? coding_plan_key_bigmodel>` |
 *
 * ⚠ **缺 key 时不返回 `Authorization`，而不是抛错** —— 调用方据此判定
 * 「该通道不可用」并换腿，不该在这里炸掉整条请求。
 * `describeChannels` 已经能提前判，这里是最后一道。
 *
 * ⚠ **coding-plan 不带 `HTTP-Referer`** —— 那是 `zcode.z.ai` 专属头，
 * 发到 `api.z.ai` 上没有意义（2026-10-03 实测该网关只认
 * `Authorization` + `anthropic-version`）。
 *
 * @param body 请求体。**仅供将来加通道专属头时用**，当前两条通道都用
 *   调用方自己带上的 body，故不参与组装。
 */
export declare function buildChannelRequest(credential: ZcodeCredential, channel: ZcodeChannel, body: string): {
    url: string;
    headers: Record<string, string>;
};
/** 换取结果；`key` 为 undefined 时 `reason` 说明卡在哪一步。 */
export interface ZcodeApiKeyResult {
    readonly key: string | undefined;
    readonly reason?: 'no-oauth-token' | 'no-org' | 'no-key' | 'no-secret' | 'http-error';
}
/**
 * 用 OAuth access_token 换取 coding-plan 的 api-key（**三步，只 GET**）。
 *
 * ## 链路来源（逆向官方 `app.asar` 的 `AccountProviderApiKeyResolver`）
 * ```
 * ① GET {origin}/api/biz/customer/getCustomerInfo                    → org + project
 * ② GET {origin}/api/biz/v1/organization/{o}/projects/{p}/api_keys  → 找名为 zcode-api-key 的
 * ③ GET {origin}/…/api_keys/copy/{apiKey}                           → secretKey
 * ④ key = `{apiKey}.{secretKey}`
 * ```
 *
 * ⚠ **api-key 不是登录时下发的** —— 官方用 OAuth access_token 现换
 * （`loadCodingPlanApiKey` → `resolveProviderApiKey`）。这也正是
 * 「装了 IDE 的用户走 ② 路径有 key、纯插件登录用户需要自己换」的原因。
 *
 * ⚠ **只用 GET**（用户 2026-10-03 决定："不在云上建 key"）。
 * 官方实现在 ② 找不到时会 `POST` 建一个 —— **本实现不复刻那一支**。
 * 代价：从未建过 key 的账号拿不到（`reason='no-key'`），
 * 该账号的 coding-plan 通道标记为不可用，**不影响 start-plan**。
 */
export declare function fetchCodingPlanApiKey(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeApiKeyResult>;
/**
 * 是否因「额度/资源包用尽」而换另一条通道重试。
 *
 * ## 只认这两个业务码（且必须配 429）
 * - `1005` 余额不足
 * - `1113` 无可用资源包（ultra/coding-plan 侧的余额不足）
 *
 * ⚠ **必须连状态码一起判**：这两个码只在 429 里表示「额度用尽」；
 * 别的端点复用同一码时语义不同，无脑换腿会白烧另一条通道的额度。
 *
 * ⚠ **不认**：
 * - `401` / `1002`（凭据失效）—— 换通道也是**同一份凭据**，救不了；
 * - `3012`（风控）—— 重试会**加重账号冷却惩罚**：30 分钟 → 24 小时 → 停用；
 * - `3009`（并发限流）—— 走既有退避即可，换腿治不了并发。
 *
 * ⚠⚠ **也不认边缘/CDN 的 HTML 错误页**（2026-10-07 实测）：本函数同样是
 * `body.includes('1005')` 裸子串，而边缘页里出现 `1005` 完全正常
 * （`<title>1005</title>`、`width:1005px`）。换腿对边缘拦截**必然也失败**
 * （两条通道走同一个边缘节点），代价是白烧一次请求并把错误归因到额度。
 */
export declare function shouldFallbackToOtherChannel(status: number, body: string): boolean;
//# sourceMappingURL=zcode-transport.d.ts.map