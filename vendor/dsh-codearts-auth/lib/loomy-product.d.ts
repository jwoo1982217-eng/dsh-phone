/**
 * Loomy（讯飞）产品配置。
 *
 * ## 为什么新建 `LoomyProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` 的字段全部围绕各自
 * 协议设计（归属头、refresh 载荷、WASM 签名参数…），对 Loomy 无一有意义。
 * Loomy 需要的是：两个 base URL（账号 vs 业务）、讯飞 AccessKey、
 * 以及一张兜底模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - base URL / AccessKey / appId：`C:\Program Files\Loomy\resources\.env.prod`
 *   Loomy 官方也只是「随客户端分发 + AES 混淆」，本质同样是公开的。
 * - 兜底模型表：2026-09-26 用本机登录态实测 `GET /api/v1/models` 取得
 *   （11 条中 `type==='chat'` 的 8 条）。
 *
 * ## ⚠️ AccessKey 的定位
 *
 * 它只用于**讯飞账号**端点（`account.xfinfr.com`）的 HMAC-SHA1 签名
 * （短信验证码登录）。业务与推理端点用的是用户登录后的 `session`，
 * 与 AccessKey 无关。故 AccessKey 泄露不涉及任何用户数据。
 */
/** 兜底模型目录中的一个条目。 */
export interface LoomyFallbackModel {
    /** 模型 ID（传给 `POST /chat/completions` 的 `model`）。 */
    id: string;
    /** **已规范化**的展示名（含倍率，` · x{n}` 分隔）。 */
    name: string;
    /** 上下文窗口。 */
    contextWindow: number;
    /**
     * 可选思考档位（远端 `reasoning_efforts` 的实测值）。
     *
     * ⚠️ 与远端**同名字段、同一口径**：远端可用时优先用它，兜底表只在远端整体
     * 失败时顶替。实测 8 个 chat 模型全部是
     * `['none','low','medium','high','xhigh']`、默认 `low`。
     */
    efforts?: string[];
    /** 远端声明的默认档位（`default_reasoning_effort`）。 */
    defaultEffort?: string;
}
/**
 * Loomy 产品配置。
 */
export interface LoomyProduct {
    /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
    id: 'loomy';
    /** 设置页 / 模型选择器展示名。 */
    displayName: string;
    /** 业务基址（推理 / 模型列表 / 积分 / 新手任务）。 */
    apiBase: string;
    /** 讯飞账号（CAccount）基址。 */
    accountBase: string;
    /** 讯飞账号 AccessKeyId（HMAC-SHA1 签名的 `account {ak}:{sig}` 前半）。 */
    accessKeyId: string;
    /** 讯飞账号 AccessKeySecret（HMAC-SHA1 的密钥）。 */
    accessKeySecret: string;
    /** 讯飞 appId（账号请求体 `base.appid`）。 */
    appId: string;
    /** 默认凭据 ref（无账号池时的单凭据回退）。 */
    defaultCredentialRef: string;
    /** 远端模型列表不可用时的兜底模型目录（8 个 chat 模型）。 */
    fallbackModels: readonly LoomyFallbackModel[];
}
/**
 * Loomy provider 配置。
 */
export declare const LOOMY: LoomyProduct;
/** 全部 Loomy 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export declare const ALL_LOOMY_PRODUCTS: readonly LoomyProduct[];
/**
 * 按 provider id 取 Loomy 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 等分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export declare function loomyProductById(id: string): LoomyProduct | undefined;
//# sourceMappingURL=loomy-product.d.ts.map