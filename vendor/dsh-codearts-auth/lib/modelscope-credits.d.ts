/**
 * ModelScope（魔搭）**魔粒余额**查询。
 *
 * ## 数据来源
 *
 *     GET https://www.modelscope.cn/openapi/v1/magicubes/balance
 *     Authorization: Bearer <ms-…>
 *     → {"success":true,"data":{"total_balance":281,"available_balance":281,"frozen_amount":0}}
 *
 * ## ⚠️⚠️ 这个端点是怎么找到的（务必留档，否则会被当成「已穷尽探测」）
 *
 * 本仓库与 PR 作者都曾判定「魔搭没有额度查询 API」，并把 `credits.balance`
 * 登记为 `false`。**那个结论是错的**，错在两处：
 *
 * 1. **前缀漏了**：那批探测只试过 `/api/v1/*` 与 `/v1/*`，而真端点在
 *    **`/openapi/v1/*`**。⇒ 用错前缀时它落在 SPA 的 catch-all 路由上，
 *    对**任何**路径都回 `200 text/html`（本仓库在 accio 记过同款「假 200」）
 *    或 404，两种都会让人误判成「不存在」。
 * 2. **静态扫 bundle 找不到**：前端主 bundle（`umi.js`，10MB）里 179 条
 *    `/v1/` 路径中**没有**它，「魔粒」二字也只出现 1 次（在 i18n 文案里）。
 *    它藏在按需加载的 chunk 中 ⇒ **只能靠抓真实网络请求定位**。
 *
 * 定位过程（可复现）：CDP 监听 `/my/overview` 的 XHR → 首页页头有个
 * `<button>` 显示余额 → React fiber 上组件名是 `MagicCubeButton`、
 * props 是 `{isLogin, balance}` → 硬刷新并在全部响应体里搜字段名，
 * 命中 `/openapi/v1/magicubes/balance`。
 *
 * ## ⚠️ 为什么 `balance` **可以**用 API Key（推翻了「必须网页会话」的中间结论）
 *
 * 曾一度以为账户体系只认网页登录会话（`/api/v1/users/info` 在 API Key 下报
 * `400 获取用户信息失败`）。但**魔粒这个端点不同** —— 实测三种认证：
 *
 * | 认证 | 结果 |
 * |---|---|
 * | `Authorization: Bearer <ms-key>` | **200，返回真实余额** |
 * | 网页会话 cookie | 200，同一数值 |
 * | 无凭据 | **401 `InvalidAuthentication`** |
 *
 * ⇒ 它**确实在校验凭据**（不是公开端点，这一条符合仓库「目录能读 ≠ 凭据有效」
 * 的纪律要求），且**API Key 就够** ⇒ 因此**不需要**网页登录态、**不需要**
 * 采集 cookie、**不需要**起浏览器。
 *
 * ## ⚠️ 「它是真余额」的判据是**实测会随消耗下降**，不是字段名像余额
 *
 * 实测：读数 281 → 发 2 次推理（旗舰档每次扣 2 魔粒）→ 再读 277，**恰好 -4**。
 * ⚠️ 对照组：`/api/v1/quota/status` 虽然也带 `Quota` 字样且 API Key 能读，
 * 但它是**任务奖励**（点赞/分享/绑定云账号），发 3 次推理后数值**逐字节不变**
 * ⇒ 字段名像余额**不等于**是余额。这类判据必须用「会不会随消耗变化」来分。
 *
 * @module src/modelscope-credits.ts
 */
import type { ModelscopeCredential } from './modelscope.js';
import type { CreditBalance } from './credits.js';
import { type ModelscopeProduct } from './modelscope-product.js';
/**
 * 拉取魔粒余额。
 *
 * ## ⚠️ 为什么用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * 三种失败的**用户动作完全不同**，压成笼统的「余额查询失败」会误导：
 *
 * - `401` ⇒ **Key 无效 / 没配凭据** ⇒ 用户该去控制台重新生成；
 * - `200 + success:false` ⇒ **Key 有效但该端点拒绝**（如账号未实名）⇒ 换 Key 没用；
 * - `200 + 缺 total_balance` ⇒ **上游改版** ⇒ 该报「读数格式变了」，而不是「余额 0」。
 *
 * ⚠️ 「魔粒需完善个人信息后才可用」是魔搭的真实规则（前端 i18n 原文：
 * 「重要提示：为保障账号正常使用，请完善个人信息（包括验证邮箱），平台魔粒需在
 * 个人信息完善后方可使用」）⇒ 未实名账号读不到是**预期**，不是故障。
 */
export declare function fetchModelscopeBalanceDetailed(credential: ModelscopeCredential, product?: ModelscopeProduct): Promise<{
    balance: CreditBalance | null;
    error?: string;
}>;
//# sourceMappingURL=modelscope-credits.d.ts.map