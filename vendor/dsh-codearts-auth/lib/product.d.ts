/**
 * CodeBuddy 系产品配置。
 *
 * 这些产品同源：共用同一 CLI 内核、同一认证协议（cli-external-link）与同一套
 * ProductProvider 机制，差异全部收敛到这里，使多个 provider 共用一套实现。
 *
 * 实测依据（2026-09-14，逆向各产品 cli/product.json + 真实请求）：
 *
 * | 产品              | endpoint                    | platform       | genieVersion |
 * |-------------------|-----------------------------|----------------|--------------|
 * | CodeBuddy（中国） | https://copilot.tencent.com | ide            | —            |
 * | WorkBuddy（国际） | https://www.workbuddy.ai    | workbuddy-ai   | 5.5.2        |
 *
 * 关于「模型列表为何不能共用」：两者的**路径与响应解析完全相同**
 * （`GET /v3/config` → `data.data.models` / `data.data.agents`），
 * 差异只来自 endpoint —— 不同区域的后端返回不同的模型池
 * （中国版含 glm/hy/deepseek 系，国际版含 claude/gpt/gemini/kimi 系）。
 * 因此 endpoint 必须随产品切换，不能被当成全局常量。
 *
 * 迁移关系（重要）：
 * 本模块中与 `src/buddy.ts` / `src/buddy-auth.ts` 重名的取值，将从后者**迁移**到
 * 本模块，由本模块作为唯一真相源（single source of truth）。在后续参数化任务完成、
 * 旧常量被删除之前，本模块的这些字面量必须与 `src/buddy.ts` / `src/buddy-auth.ts`
 * 中的对应常量**保持完全一致**：任何一处取值变更都必须同步另一处，否则各产品的
 * 认证/请求行为会分叉。
 *
 * 之所以此处仍写死字面量而不 import 常量：`buddy-auth.ts` 后续任务将改为
 * `import product.ts`，若本模块反向 import `buddy-auth.ts` 会形成循环依赖；
 * 为保持一致性，这些字段全部维持字面量写法。
 */
/** 兜底模型目录中的一个条目（字段对齐远端 `/v3/config` 的 `data.models[]`）。 */
export interface BuddyFallbackModel {
    id: string;
    name: string;
    /** 上下文窗口（对应远端 `maxInputTokens`）。 */
    contextWindow?: number;
    /**
     * 单次请求输出上限（对应远端 `maxOutputTokens`）。
     *
     * 远端可达时以远端为准；本字段只在远端不可用或未覆盖该模型时补位。
     * 取值依据见 `deepseek-v4.1-flash` 条目的注释。
     */
    maxOutputTokens?: number;
    /** 是否接受图片输入（对应远端 `supportsImages`）。 */
    supportsImages?: boolean;
    /** 可选思考等级（对应远端 `reasoning.supportedEfforts`）。 */
    reasoningEfforts?: readonly string[];
    /** 默认思考等级（对应远端 `reasoning.defaultEffort`）。 */
    defaultReasoningEffort?: string;
}
/** 一条「模型族 → User-Agent」覆盖规则。 */
export interface BuddyUserAgentRule {
    /** 模型 id 前缀；命中即采用本规则的 ua。 */
    match: string;
    /** 命中后使用的 User-Agent。 */
    ua: string;
}
/** 一个 CodeBuddy 系产品的全部差异配置。 */
export interface BuddyProduct {
    /** provider 标识：注册到 ctx.llm 的路由名，也是账号列表的 provider 字段值 */
    id: 'buddy' | 'workbuddy';
    /** auth/state 的 platform 查询参数 */
    platform: string;
    /**
     * API endpoint（含协议），所有 `/v2/plugin/*`、`/v3/config` 与 chat 请求
     * 都以此为基址。**这是不同区域产品之间最关键的差异**：模型池由它决定。
     */
    endpoint: string;
    /**
     * 用于 `X-Domain` 请求头的域名（通常等于 endpoint 的主机名）。
     * 注意与 `endpoint` 分开：历史实现里该头传的是不带协议的域名。
     */
    apiDomain: string;
    /**
     * 成长中心领奖端点的基址（含协议，无尾斜杠），成长任务 claim 与 web 域上报
     * 以此为基址。
     *
     * 与 `endpoint` 分开的原因：API 域名与网页域名不是同一个站。buddy 中国版的
     * `endpoint` 是 `copilot.tencent.com`，而成长中心领奖与 web 域遥测在另一个站。
     *
     * 证据状态：`www.workbuddy.cn` 是实测可达的中国区成长中心站（2026-10-05，
     * 两个真实账号领奖成功）；它与登录站 `www.codebuddy.cn`（见 buddy.ts
     * WEBSITE_HOME）的关系未经核实，两者都返回 HTTP 200，故此处填实测值而非推断值。
     * 国际版未实测，暂按 `endpoint` 同域填写。
     */
    claimBase: string;
    /**
     * web 域遥测上报的 Origin（含协议，无尾斜杠），资料库点击一类判据只认
     * web 域事件，桌面域不计分。
     *
     * 与 `claimBase` 分开的原因：领奖走产品 API 站，web 遥测走网页站，两者
     * 的 `Origin` / `Referer` 需要各自独立配置，不能共用一个回退值。
     *
     * 证据状态：与 `claimBase` 同为实测可达站点（2026-10-05，Library_read判据
     * 在两个真实账号上领奖成功）。
     */
    webBase: string;
    /** 设置页展示名 */
    displayName: string;
    /** X-Product-Code 请求头值 */
    productCode: string;
    /**
     * 默认 User-Agent（无按模型分档命中时使用）。
     *
     * 腾讯后台的「使用端」列按出站 UA 归因，故该值必须**含对应产品品牌字样**
     * （`WorkBuddy/...` 或 `CodeBuddyIDE/...`），否则账单显示为 `-`。
     */
    userAgent: string;
    /**
     * 按模型族覆盖 User-Agent 的规则表（先命中先返回）。
     *
     * 为什么需要按模型分档：国际版与国内版共用同一后端协议，但模型池分属不同
     * 产品线 —— 实测同一账号下，走 `gpt-*` 系与走 `glm-*` 系时官方客户端形态
     * 并不一致，后台按 UA 归因的「使用端」也随之不同。仅用一个全局 UA 无法让
     * 两类模型都归因正确。
     *
     * 匹配规则：`match` 为模型 id 前缀（大小写敏感，与模型 id 一致）；
     * 空数组或未提供时全部回退到 {@link BuddyProduct.userAgent}。
     */
    userAgentByModelFamily?: readonly BuddyUserAgentRule[];
    /**
     * 归属头名（`X-IDE-Name` / `X-IDE-Type` / `X-Product` 三头共用同一取值）。
     *
     * 注意语义：`X-Product` 是**用量归属名**，不是部署类型 —— 历史实现把它发成
     * `SaaS`（部署类型语义）导致后台归因不到产品，故此处按产品名下发。
     */
    attributionName: string;
    /** `X-IDE-Version` 头取值（客户端形态版本号） */
    clientVersion: string;
    /** User-Agent 第三段 `CLI/<ver>` 的版本号 */
    cliVersion: string;
    /** 默认凭据 ref（无账号池时的单凭据回退） */
    defaultCredentialRef: string;
    /**
     * 远端模型列表不可用时的**兜底模型目录**。
     *
     * 为什么需要它：各产品的模型池只由服务端按认证上下文下发，而插件的
     * CLI token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能
     * 拿到 13 个别名，拿不到 GPT 系列）。此表是 IDE 自身也在用的机制 ——
     * IDE 的 `product.json` 内置静态模型表，远端配置只是覆盖层。
     *
     * 取值来自 IDE 的本地缓存（`~/.workbuddy-ai/local_storage/*.info`，
     * 由 `WorkbuddyAuthProductCoordinator` 写入），即 IDE 输入框实际使用的清单。
     */
    fallbackModels?: readonly BuddyFallbackModel[];
    /**
     * 登录 URL 是否需要追加 `version` 与 `loginSessionId`。
     * CodeBuddy 不需要；WorkBuddy 需要（对齐 workbuddy-desktop 认证配置）。
     */
    appendSessionParams: boolean;
    /** 追加到登录 URL 的版本号（appendSessionParams 为 true 时使用） */
    pluginVersion?: string;
    /**
     * 单张请求图片的像素预算（issue !IKITT9）。
     *
     * 适配器据此把附件派生成**缩放后的请求版本**再内联，而不是直接发原图。
     * 背景：网关对「单次请求的图片视觉 token 总量」另有约 100,000 的限制，
     * 与模型上下文窗口（这里声明的是 1,000,000）是两回事 —— 一张 1721×997
     * 的截图就值 ≈2,781 token，攒到 36 张顶穿后整个会话每轮都失败且不可恢复。
     *
     * 取值口径与「为什么是每张固定预算而非按张数分摊」记在 `src/image-budget.ts`。
     * 未配置时适配器使用 `DEFAULT_IMAGE_PIXEL_BUDGET`（640,000 px）。
     */
    imagePixelBudget?: number;
}
export declare const CODEBUDDY: BuddyProduct;
/**
 * WorkBuddy 国际版（腾讯 WorkBuddy AI），platform = workbuddy-ai。
 *
 * 逆向自 `C:\Users\Jet\AppData\Local\Programs\WorkBuddyAI`（5.5.2）的 cli/product.json：
 * - `applicationName` = "workbuddy-ai"
 * - `endpoint` = "https://www.workbuddy.ai"（**与中国版不同**，模型池随区域变化）
 * - `authentication.attributes.platform` = "workbuddy-ai"
 * - `prefixPath` = "/plugin"（与中国版相同）
 *
 * 该产品**没有**每日签到积分接口（内核中只有 `/v2/billing/meter/get-dosage-notify`），
 * 因此 Jet Hub 不为其渲染「一键领取积分」按钮；积分领取在 CodeBuddy 侧完成。
 *
 * ⚠️ 下面的 `claimBase` / `webBase` 是**占位值**（为满足 `BuddyProduct` 的必填形状），
 * 本产品**没有任何代码路径会读取它们** —— 原因有两层：
 *
 * 1. 成长任务的唯一入口是「一键领取积分」按钮，而该按钮由
 *    `supportsCredits = supportsDailyCheckin(provider)` 门控，`workbuddy` 在能力表里
 *    登记为 `dailyCheckin: false` ⇒ 按钮不渲染 ⇒ `runTasks: true` 传不进来；
 * 2. **更根本的是**：contributor 在 !62 复审中实测确认 `www.workbuddy.ai` 后端
 *    **根本没有成长中心**（无任务列表、无 claim 端点）。故这不是「等将来开放」，
 *    而是「该产品没有这个功能」。`GROWTH_CAPABLE_PROVIDERS` 与客户端的
 *    `GROWTH_TASK_PROVIDERS` 都已据此**移除** `workbuddy`。
 *
 * 两个字段保留是因为 `BuddyProduct` 把它们声明为必填；若将来类型放宽为可选，
 * 这里可以删掉（`claimBaseOf` / `webBaseOf` 已能正确处理空值并给出可读错误）。
 */
export declare const WORKBUDDY: BuddyProduct;
/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export declare const ALL_PRODUCTS: readonly BuddyProduct[];
/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export declare function productById(id: string): BuddyProduct | undefined;
/**
 * 按模型 id 解析该产品应使用的 User-Agent（按模型族分档）。
 *
 * 命中规则：`userAgentByModelFamily` 中**先命中先返回**（`match` 为前缀）。
 * 未命中任何规则时回退到 `product.userAgent`。这条回退链保证新模型上线时
 * 仍有一个确定的、含产品品牌字样的 UA，不会退化成框架默认的 harness UA。
 *
 * @param product - 产品配置
 * @param model - 模型 id（如 `gpt-5.6-sol` / `glm-5.2`）
 */
export declare function resolveUserAgent(product: BuddyProduct, model: string): string;
//# sourceMappingURL=product.d.ts.map