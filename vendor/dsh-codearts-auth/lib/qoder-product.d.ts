/**
 * Qoder 产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * Qoder 的协议与现有四个 provider **都不同源**：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder |
 * |------|----------|-----------------|-----------|-------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码轮询 |
 * | 续期 | refresh_token | refresh_token | refresh_token + 身份字段 | refresh_token + machine_id |
 * | 签名 | HMAC-SHA256 | 无 | 无 | 无（推理） |
 *
 * 且 `BuddyProduct.id` 是字面量联合 `'buddy' | 'workbuddy'`，加值会牵动
 * `productById` / `registerBuddyLlm` 一串调用点。故这里定义**平行**的
 * `QoderProduct` —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * 全部来自本机 Qoder 0.3.4 产物逆向 + 实测，详见
 * `docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 * 逆向目标：
 * - `C:\Users\Jet\AppData\Local\Programs\Qoder\resources\app.asar`
 * - `...\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
 *   （字符串经 `_$d = base64 → XOR("tqrRVttEZQ4G")` 编码）
 */
/** 兜底模型目录中的一个条目（字段口径见下方 `QODER_FALLBACK_MODELS` 的注释）。 */
export interface QoderFallbackModel {
    /** 模型目录 **key**（如 `qfmodel`）。
  
     * ⚠️ **必须走加密端点** `agent_chat_generation` —— 公开的
     * `/model/v1/chat/completions` 不认这些 key（见 `src/qoder-wasm.ts`）。 */
    id: string;
    /** 展示名（取自目录 `display_name`）。 */
    name: string;
    /**
     * 上下文窗口（**总上下文**，DSH 以它 × 0.8 作压缩阈值）。
     *
     * ⚠️ 取目录 `context_config` **档位表的最大档**，**不是** `max_input_tokens`。
     * 两者经常自相矛盾（CN `dmodel`：`max_input_tokens` 96000、档位表却到 1M），
     * 而官方客户端只认档位表 —— 详见 `QODER_CN_FALLBACK_MODELS` 前的长注释。
     * `auto` 这类没有档位表的条目才退回 200K。
     */
    contextWindow: number;
    /** 是否接受图片输入（远端 `is_vl`；实测 17 个全为 true）。 */
    supportsImage?: boolean;
    /** 是否支持思考档位（远端 `is_reasoning`）。 */
    supportsThinking?: boolean;
    /** 是否免费额度模型（远端 `is_free`）。 */
    isFree?: boolean;
    /**
     * 计费倍率（目录 `price_factor`）。
     *
     * ⚠️ 字段名是 **`price_factor`**，不是 `cost_multiplier`（后者不存在于
     * Qoder 目录；`cost_multiplier` 是有道 LobsterAI 的字段，别混淆）。
     *
     * ⚠️ **它是「目录下发那一刻」的生效价，会随错峰窗口变化** ——
     * 窗口内是折后价、窗口外是原价。因此本表存的是**采集时刻的值**，
     * 展示时须结合 {@link QoderModelPromotion} 的窗口**本地推算**当前价
     * （见 `qoderDisplayName`），不要把它当成恒定原价。
     *
     * 实测本机 catalog（2026-09-21，17 个 chat 模型）：
     * `qfmodel`（Qwen3.8-Flash）= **0**、`qmodel` = 0.04、`qmodel_latest`/
     * `dfmodel`/`gfmodel` = 0.1 …… `smodel`（Sonus）= 8。
     *
     * **0 是合法值**（免费），故不能用 `!== undefined && > 0` 过滤 ——
     * 那会把用户最关心的免费模型漏掉。
     */
    priceFactor?: number;
    /**
     * 促销前的原价倍率（目录 `original_price_factor` / `before_promotion_price_factor`）。
     *
     * 与 {@link priceFactor} 是**两个独立字段**：实测 `qfmodel` 的
     * `price_factor=0` 而 `original_price_factor=0.1`，即免费额度是在原价
     * 0.1 的基础上打折到 0。只在两者不同时才值得展示。
     */
    originalPriceFactor?: number;
    /**
     * 错峰折扣（目录 `promotion`）。
     *
     * ⚠️ **`active` 是「目录下发那一刻」的快照，不可作为长期判据**：
     * 用户长时间不重启客户端时它会过期。真实窗口由 `windowStart`/`windowEnd`
     * 描述且稳定，故展示时**按当前时间本地推算**是否在窗口内
     * （见 `qoderDisplayName` 的 `promotionActiveNow`），`active` 仅作回退。
     *
     * 实测三档（`qfmodel` 无 promotion；`qmodel_38max` 是 4 折、
     * `qmodel_latest` 是 2 折），窗口统一为 22:00–08:00（Asia/Singapore）。
     *
     * 关系式（实测三条全部吻合）：
     * `priceFactor === beforePromotionPriceFactor × discountFactor`
     * —— 故可据原价与折扣推算任意时刻的生效价。
     */
    promotion?: QoderModelPromotion;
    /**
     * 可选思考档位（远端 `thinking_config.enabled.efforts` 的**键**）。
     *
     * ## ⚠️ 三个必须记住的口径
     *
     * 1. **取值来源是 `efforts` 的键名，不是值**：目录形如
     *    `efforts: { xhigh: {}, low: {}, medium: { is_default: true } }`，
     *    键即档位 id。本字段按**目录原始顺序**保存（客户端也按对象键序渲染）。
     * 2. **`*`（`is_default`）是"默认选中"，不是"多选"**：
     *    IDE 里是**下拉单选**，「极高/低/中」三选一，默认落在「中」
     *    （见 {@link defaultEffort}）。
     * 3. **「关闭思考」不在这个数组里** —— 它由 `disabled` 分支决定，
     *    通过 {@link supportsDisable} 表达。客户端是在 `gU()` 里**追加** `none` 的：
     *    `gU(A){ let e=…efforts; return A.supports_disabled||A.supportsDisabled||e.includes("none") ? e : [...e,"none"] }`
     *    —— 故这里**不要**手动塞 `none`，否则会与 `supportsDisable` 语义重复。
     *
     * ⚠️ **档位必须在客户端的白名单内**才会被接受，不在的会被 `ao()`
     * **静默丢弃**。白名单（asar 常量 `Qj`）：
     * `['none','low','medium','high','xhigh','max']`；
     * 另有别名表 `_lc`：`disabled`→`none`、`off`→`none`。
     * 官方 UI 的中文名（asar i18n `settings.efforts`）：
     * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
     */
    efforts?: readonly string[];
    /**
     * 默认思考档位（目录 `efforts.<key>.is_default === true` 的那一项）。
     *
     * ⚠️ **必须落在 {@link efforts} 内**，否则 DSH 会拿一个不存在的档位发请求
     * （同 `trae-adapter.ts` 的教训：给不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`）。
     * 无 `is_default` 时不设该字段，让 DSH 显示「Default」由上游自行决定。
     */
    defaultEffort?: string;
    /**
     * 是否提供「关闭思考」（目录 `thinking_config.disabled` 分支存在即 true）。
     *
     * ⚠️ 与 {@link efforts} **相互独立**：实测 `gfmodel` / `gmodel` / `kmodel` 等
     * 有档位但**不能关闭**（目录无 `disabled`），而 CN 的 `qmodel` / `qmodel_latest`
     * **没有档位但能关闭**（目录只有 `disabled` + `enabled.is_default`，
     * 无 `efforts` 键）。两者不能用一个标志表达。
     */
    supportsDisable?: boolean;
}
/** 目录 `promotion` 字段（错峰折扣）。 */
export interface QoderModelPromotion {
    /**
     * 目录下发时是否处于折扣时段内（远端 `active`）—— **快照值，会过期**。
     *
     * 长期运行的会话里它会与真实时段脱节，故只作回退：
     * `windowStart`/`windowEnd` 齐备时以**本地时间推算**为准。
     */
    active: boolean;
    /** 折扣后倍率（远端 `discount_factor`），如 0.4 = 4 折。 */
    discountFactor?: number;
    /** 折扣前倍率（远端 `before_promotion_price_factor`）。 */
    beforePromotionPriceFactor?: number;
    /** 时段起点（远端 `window_start`，如 `22:00`）。 */
    windowStart?: string;
    /** 时段终点（远端 `window_end`，如 `08:00`）。 */
    windowEnd?: string;
    /**
     * 中文角标文案（远端 `badge.zh`，如「错峰 4 折」）。
     *
     * ⚠️ **当前不参与展示**：Qoder 的折扣已统一为「原价→折后价」箭头形态
     * （与 TRAE / buddy 一致），角标与箭头信息**冗余**（0.2/0.5 本就是 4 折）。
     * 字段保留是因为它是目录下发的原始数据，重新采集时仍可对照；
     * 若将来要恢复角标，改 `qoderDisplayName` 即可。
     */
    badgeZh?: string;
}
/**
 * Qoder 产品配置。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` 平行，字段全部为 Qoder 实际需要的。
 */
export interface QoderProduct {
    /**
     * provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。
     *
     * ⚠️ 两个取值**共用同一套协议实现**（`qoder.ts` / `qoder-oauth.ts` /
     * `qoder-credits.ts` / `qoder-adapter.ts` / `qoder-wasm.ts`）—— 中国版与国际版
     * 的差异全部是本配置里的字段值，不存在「CN 要另写一份协议」的情况。
     * 新增同族产品时只加本联合类型的值与一份配置，**不要**复制实现文件。
     */
    id: 'qoder' | 'qodercn';
    /** 设置页 / 模型选择器展示名。 */
    displayName: string;
    /** 登录与 OAuth 基址。 */
    authBase: string;
    /** OpenAPI 基址（轮询、续期、userinfo 都走它）。 */
    openApiBase: string;
    /**
     * 推理基址（**公开的 OpenAI 兼容端点**）。
     *
     * ⚠️ **不是** `environments.prod.inferBaseUrl`（那是 `https://api2.qoder.sh`）。
     * 推理实际走独立的 model server host `api2-v2.qoder.sh`
     * （源码 `Sja = { prod: "api2-v2.qoder.sh", ... }`）。
     *
     * ⚠️ 该端点只认**通用模型名**（`qwen-flash` 等），**不认目录 key**
     * （`qfmodel` → `Unsupported model`）。要按目录 key 推理必须走
     * `encryptedInferBase`。
     */
    inferBase: string;
    /**
     * **加密推理**基址（`agent_chat_generation` 端点所在 host）。
     *
     * ⚠️ 与 `inferBase` **不是同一个 host**：加密端点走 `api2.qoder.sh`
     * （即源码里的 `environments.prod.inferBaseUrl`），实测写错会 404。
     * 请求体由 `src/qoder-wasm.ts` 加密，该端点**认模型目录 key**。
     */
    encryptedInferBase: string;
    /**
     * OAuth client id —— **prod 环境用的那一个**（源码 `J_a` 解码值）。
     *
     * ⚠️ 两个 client id 的对应关系**容易读反**，这里记录正确语义：
     *
     * ```js
     * async function __a(A, e, t, i = true, n, r) {   // i 是第 4 参
     *   ...client_id: i ? J_a : G_a
     * }
     * // 调用点（loginWithDeviceFlow）：
     * ({authUrl, pollForCompletion} = await A(o, s, i, n(), r.signal, a))
     * //                                          ↑ n() = isProd()
     * // $Oa(){return "prod"===db()}
     * ```
     *
     * 即第 4 参是 **`isProd()`（布尔）**：prod → `true` → **`J_a`**；
     * 非 prod（daily/test）→ `false` → `G_a`。
     *
     * **真实缺陷**（用户报障）：早期把第 4 参误读成「useIdeClientId」，
     * 于是 prod 用了 `G_a`，GitHub 授权回调后被服务端拒绝，页面报
     * 「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」。
     */
    clientId: string;
    /**
     * 非 prod 环境（daily / test）用的 client id（源码 `G_a`）。
     *
     * 仅作记录 —— 本插件只支持 prod，**不要**拿它当 prod 的 client id。
     */
    testClientId: string;
    /** 请求体 `metadata.context` 的客户端标识（源码 `Fp()` 的 CLI 默认值）。 */
    clientMetadata: {
        client_type: string;
        business_product: string;
        business_type: string;
        scene: string;
    };
    /**
     * `/sash/` 端点（用量、活动）的 `Cosy-ClientType` 头取值。
     *
     * ⚠️ **与 `clientMetadata.client_type` 不是同一个身份，不要合并**：
     *
     * - `clientMetadata.client_type`（`'5'` + `business_product:'cli'`）对应源码
     *   `Fp()` 的 **CLI** 默认值，用于**推理请求体**的加密信封 `metadata`；
     * - 本值（`'10'`）对应官方**桌面客户端**身份 —— 源码里是一个冻结常量
     *   `Mh = Object.freeze({ clientType: 10, businessProduct: 'app', sessionType: 'app' })`，
     *   官方拿它请求 `/sash/api/v1/me/campaigns`。
     *
     * 服务端按这个头进入活动下发分支（真实缺陷，2026-09-25 定位）：
     *
     * | `Cosy-ClientType` | `/sash/api/v1/me/campaigns` 响应 |
     * |---|---|
     * | `'5'`（旧值） | `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}` |
     * | `'10'`（本值） | `{"showCampaign":true,…,"campaigns":[1 条 VIEW_DETAILS]}` |
     *
     * ⚠️ **`'10'` 只是必要前提，不足以拿到「可领取」的活动**。要让服务端下发
     * `CLAIM_BENEFIT/CLAIMABLE`，还必须同时带 `Cosy-MachineToken` +
     * `Cosy-MachineType`（成对，见 `src/qoder-machine.ts`）。同一账号对照：
     *
     * | 头 | 结果 |
     * |---|---|
     * | 仅 `'10'` | 1 条 `VIEW_DETAILS`，`claimable:false` |
     * | `'10'` ＋ MachineToken ＋ MachineType | **2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/100` |
     *
     * 该结论由 2026-09-21 抓包（`qoder积分.pcapng` + `SSLKEYLOGFILE` 解密）
     * 与逐项消融实验共同证实，详见 `qoder-machine.ts`。
     */
    sashClientType: string;
    /** `User-Agent` 头取值前缀（源码拼 `qoder/{version}`）。 */
    userAgentPrefix: string;
    /** 默认凭据 ref（无账号池时的单凭据回退）。 */
    defaultCredentialRef: string;
    /**
     * 单张请求图片的像素预算（issue !IKITT9）。
     *
     * ⚠️ qoder 撞的**不是**腾讯那道「图片视觉 token 预算」，而是**请求体体积**：
     * 实测 8 张 2560×1600 原图能过、15 张（≈57 MiB）直接 `TRANSPORT: fetch failed`。
     * 两种约束只有「缩放图片」这一个共同解法，所以这里同样要配预算。
     * 未配置时适配器用 `DEFAULT_IMAGE_PIXEL_BUDGET`。
     */
    imagePixelBudget?: number;
    /**
     * 单张请求图片的编码字节目标。
     *
     * 未配置时用 `DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES`（1 MiB）——
     * 取值的算术依据记在 `src/image-budget.ts`。
     * ⚠️ 与 raccoon 的 512 KB 不同值是**有意的**（那家硬限 10 MB），别合并。
     */
    imageMaxBytes?: number;
    /**
     * 模型列表不可用时的兜底模型目录（本插件不发远端请求，恒用它）。
     *
     * ⚠️ **只有模型列表需要 WASM 签名**，不要据此推断其它端点：
     * 推理（`model/v1/chat/completions`）、用户信息（`api/v1/userinfo`）、
     * **积分余额（`sash/api/v2/me/usage`）** 都只需 Bearer。
     * 早期因「模型列表要签名」而误以为余额也要，把积分能力误登记为 false
     * （见 `src/qoder-credits.ts` 的模块注释）。
     */
    fallbackModels: readonly QoderFallbackModel[];
}
/** Qoder provider 配置（国际版）。 */
export declare const QODER: QoderProduct;
/** Qoder provider 配置（**中国版**）。 */
export declare const QODER_CN: QoderProduct;
/**
 * 全部 Qoder 产品配置（国际版 + 中国版）。
 *
 * 顺序即 `qoderProductById()` 的查找顺序，也是续期调度遍历的顺序。
 * 新增同族产品（如将来的其它区域版本）只在此追加一项 + 一份配置，
 * **不要**复制 `src/qoder*.ts` 的任何实现文件。
 */
export declare const ALL_QODER_PRODUCTS: readonly QoderProduct[];
/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 分开：
 * 三者返回**不同类型**，合并会让调用方拿到联合类型后不得不做类型收窄。
 */
export declare function qoderProductById(id: string): QoderProduct | undefined;
//# sourceMappingURL=qoder-product.d.ts.map