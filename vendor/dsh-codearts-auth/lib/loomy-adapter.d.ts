/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * 实测（2026-09-26）`POST {apiBase}/chat/completions` 是**标准 OpenAI 兼容
 * + 标准 SSE**：`data:` 帧 + 空 `data:` 终止帧，思考在 `delta.reasoning_content`，
 * **无加密、无信封、无格式转换**。与 qoder 同形，故消息序列化与 SSE 消费
 * 直接复用 `src/openai-compat.ts` —— 那是为这种形态抽的共享层，
 * **新增** provider 用它正是其设计意图（AGENTS.md 只禁止拿它去重构
 * buddy/lobsterai 的既有实现）。
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type LoomyCredential } from './loomy.js';
import { type LoomyProduct } from './loomy-product.js';
/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export declare const PROVIDER = "loomy";
/** 远端模型条目（已归一）。 */
export interface LoomyRemoteModel {
    id: string;
    /** **已规范化**的展示名（含倍率）。 */
    name: string;
    contextWindow: number;
    supportsImage: boolean;
    supportsThinking: boolean;
    /**
     * 可选思考档位（远端 `reasoning_efforts`，如 `['none','low','medium','high','xhigh']`）。
     *
     * ⚠️ **取自远端而非硬编码** —— 服务端 `GET /models` 直接下发了这两个字段，
     * 且带 `reasoning_catalog_version`（catalog 版本哈希），故档位随服务端更新，
     * 无需改代码。
     *
     * 缺失（`undefined`）表示**该模型不提供档位选择**，此时不声明 `reasoning`，
     * UI 显示「当前模型未提供推理等级」—— 而不是给一个发了也没用的档位。
     */
    efforts?: string[];
    /** 远端声明的默认档位（`default_reasoning_effort`）。 */
    defaultEffort?: string;
}
/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export declare function parseLoomyRemoteModels(payload: unknown): LoomyRemoteModel[];
/** {@link LoomyAdapter} 的构造选项。 */
export interface LoomyAdapterOptions {
    /** 单凭据回退 ref（无账号池时）。 */
    credentialRef: CredentialRef;
    /**
     * 解析当前可用凭据。
     *
     * ⚠️ 入参是**本轮要用的模型 id**：Loomy 的选号策略要按「该模型是否受限」
     * 先过滤账号（限流是**按模型**记的），再按余额分档。实现**必须**把它透传给
     * `AccountPool.getAvailableAccount` 的 `modelId` —— 早期实现传空串
     * （等于不按模型过滤），会让模型级限流失效。
     */
    resolveCredential: (modelId?: string) => Promise<LoomyCredential | undefined>;
    /**
     * 凭据失效时的处理。
     *
     * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
     * 不会（也无法）续期。
     *
     * ## ⚠️⚠️ `forCredential` 是**可选**但强烈建议实现（2026-10-20 审计 E-2）
     *
     * 不带参数时，接线层的实现探测的是**池当前默认账号**
     * （`pool.getAvailableAccount(LOOMY.id, '')`），而热路径拿它来裁决
     * 「**本轮要用的那份**凭据还能不能用」—— **二者可能不是同一个号**。
     *
     * 实测（基线 `b5dab83` 同样）：本轮要用的号完全可用，仅因**另一个号**报终态
     * ⇒ 整轮失败、业务请求 0 次。这与 `401` 分支注释里自己写过的
     * 「二者可能不是同一个号」是同一个坑，只是那处讨论的是**标记记错号**，
     * 这处是**裁决打死错的人**。
     *
     * ⇒ 实现方收到 `forCredential` 时应只探测**那一份凭据**（按 access_token 反查
     *   其 ref 后调 `refreshAccountCredential`）；无法反查时退回原行为
     *   （探测默认号）—— 「宁可退化成旧行为，也不要凭空跳过探测」。
     */
    refresh: (forCredential?: LoomyCredential) => Promise<void>;
    /**
     * 非终态告警出口（可选）。
     *
     * ⚠️ 目前只有一处消费：请求热路径上「凭据探测失败但按非终态处理」时留痕。
     * 缺省静默 —— 但接线层**必须**注入，否则本渠道会退化成本仓库反复记录的
     * 「静默失败」（用户看到整轮成功、实际探测一直在失败）。
     */
    warn?: (message: string) => void;
    /** 拉取远端模型目录；失败时适配器回退兜底表。 */
    fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>;
    /**
     * 「现在」的注入点（**只供单测**推进 TTL；生产缺省 `Date.now()`）。
     *
     * ⚠️ 为何要注入：TTL 是本 Task 的核心判据，而真实时间无法在用例里推进 ——
     *    只能靠 `sleep` 的用例会 flaky 且慢。既有同形态先例：`auto-adapter` 的 `now`。
     */
    now?(): number;
    /** 读取图片附件的原始字节（内联为 data URL 用）。 */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 账号池（目录门控与黑名单）。 */
    accountPool?: AccountPool;
    /** 产品配置；默认 {@link LOOMY}。 */
    product?: LoomyProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 远端目录**落地后**的通知回调（issue IKJVTF）。
     *
     * 由 `registerLoomyLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
     * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
     *
     * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
     * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
     * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
     */
    onCatalogLoaded?: () => void;
}
/**
 * 探测**非终态**失败后的退避窗口（毫秒）。
 *
 * ## 为什么需要它（2026-10-20 审计的 E-3）
 *
 * `isLoomyExpired` 读本地 `expires_at`（登录时刻 +14 天推算**写下**，服务端不下发，
 * 本插件**永不改写**）⇒ 本地判过期后，前置探测分支**每一轮**都会进。
 * 而探测的超时上限是 `LOOMY_REQUEST_TIMEOUT_MS` = **60 秒**，且
 * `probeCredential` 用的是**独立**的 `AbortSignal.timeout`、不联动调用方 `signal`
 * ⇒ 最坏情况是「每轮首 token 前白等 60 秒」，用户点停止也打断不了。
 *
 * 实测（审计沙箱）：`refresh` 永挂 ⇒ `stream()` 8 秒后仍未返回、业务请求 0 次；
 * 缩短到 250ms 后 `perTurnMs=[316,315,310]`（≈3× 串行叠加，**每轮各等一次**）。
 *
 * ## 为什么取 5 分钟
 *
 * 探测的**唯一产出**是「要不要提示用户重新登录」，而真失效会由业务请求自己
 * 以 401/403 或 `100002` 暴露。拿「一次上游抖动」惩罚之后每轮的首 token 延迟，
 * 是拿用户可感的延迟换一个不急用的信息。
 * 5 分钟与 `REMOTE_CATALOG_COOLDOWN_MS`（30 秒）相比更宽 —— 因为那条冷却的是
 * **目录**（影响可用模型集），这条冷却的是一次**只读探测**（不影响任何判定）。
 *
 * ⚠️ 与「失败短缓存」的区别：本退避**不改写任何判定**，窗口内用的仍是本轮
 * 刚解析出的凭据；它只决定「这次要不要去问探测端点」。
 * ⚠️ 探测**成功**时立刻清掉退避（上游已恢复，没理由继续跳过）。
 */
export declare const LOOMY_PROBE_BACKOFF_MS: number;
/**
 * Loomy 的失败类别。**「要不要换号」与「要不要写冷却」是两件事**——
 * 认证类（401/403）只换号、**绝不写冷却**。
 *
 * ⚠️ 真实事故（2026-10-06 凌晨，raccoon 同型实现上暴露）：上游网关对**全池**
 * 回 `401 + authorization_verify_error`（网关侧授权校验故障）。当时把 401 也算
 * 「可换号」且在换号前写冷却、时长取 `status === 429 ? 1h : 24h` ⇒ 一个请求内
 * 连试 6 个号、每个写 24h ⇒ 池内候选筛空 ⇒ **整个 provider 被封一天**
 * （下一次请求报 `no usable credential; log in first`）。
 * buddy 的既有实现是分开的：只有限流类写标记，认证类只 `continue`。
 */
export type LoomyFailureClass = 'quota' | 'rate' | 'auth' | 'other';
/**
 * 判定失败类别（与 {@link RaccoonFailureClass} 同构——raccoon 与 loomy 的额度
 * 错误形态同族：`14018 Credits exhausted`，HTTP 层无专用状态码，文案是主通道；
 * 词表限「积分/额度/余额 + 不足/耗尽」的确定性组合，避免误伤正文里恰好讨论
 * 「余额」的 4xx）。
 *
 * ## ⚠️ 401/403 **必须先判**（同型复发，2026-10-06）
 *
 * 本函数初版与 raccoon 的**修复前**版本逐字同形：文案先判、且 `insufficient`
 * **单独出现**即算额度。raccoon 已在 `7b524ff` 收窄，loomy 未同步 ⇒ 同一报文
 * 在两个 provider 上被判成**不同类别**，且危险方向恒定朝 loomy（多写冷却）：
 *
 * | 报文（实测，见 tests 的「与 raccoon 对拍」段） | loomy 修复前 | raccoon 已修 |
 * |---|---|---|
 * | `403 + insufficient permissions to access this resource` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `403 + 积分不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 余额不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 14018 Credits exhausted`（网关故障通常带余额提示） | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `400 + the context window is insufficient for this model` | `quota` ⇒ 写 24h | `other` ⇒ 不换号 |
 *
 * 前四行正是 {@link LoomyFailureClass} 记的 2026-10-06「全池被封」事故形态
 * （那次触发词是 `authorization_verify_error`，这次是 `insufficient permissions`
 * / 「不足」类文案）：**认证类是账号态、不是模型冷却**，写标记会把网关侧的
 * 授权故障放大成「整个 provider 被封 24h」。
 *
 * 两处修法（与 raccoon 逐字一致，方向都是「宁可漏判不可误伤」）：
 * 1. **401/403 优先**按认证类处理 —— 状态码与额度文案并存时以状态码为准；
 * 2. `insufficient` 须与邻近的「钱」义词（point/credit/balance/quota/token）
 *    **共现**才算额度；上下文超长 / 数据不足等与额度无关。
 *
 * ⚠️ 两家的判据必须**逐格同构**：`classifyLoomyFailure` 与
 * `classifyRaccoonFailure` 是同一张表的两个实现，任一侧单方面改动都会造成
 * 本文件记的这起「同型复发」。回归用例用同一批真实报文喂两个分类器对拍。
 */
export declare function classifyLoomyFailure(errorText: string, status: number): LoomyFailureClass;
/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * 导出仅供单测锁定判据本身——只靠调用点顺序兜不住边界（`isRateLimited`
 * 的 429 边界那次已验证过）。
 */
export declare function shouldRotateLoomyAccount(errorText: string, status: number): boolean;
/**
 * **Loomy 专属**：`HTTP 200 + 业务码 100002` 是否该按「认证失败、值得换号」处理。
 *
 * ## 为什么它是一条**独立**判据，而不是加进 {@link classifyLoomyFailure}
 *
 * `classifyLoomyFailure` 与 `classifyRaccoonFailure` 在本仓库明文规定
 * 「必须**逐格同构**」，并由 `loomy-adapter.spec.ts` 的
 * 「与 raccoon 对拍：同一报文集逐条同结论」逐条守着。
 * 而 `100002` 是 **Loomy 独有**的业务码（raccoon 没有等价码，见
 * `src/loomy.ts` 的 `LOOMY_AUTH_ERROR_CODE`）⇒ 塞进共享分类器会让那条对拍用例
 * 当场变红，或者逼着给 raccoon 编一个它并不存在的码 —— 两条路都不对。
 * ⇒ 业务码这一腿留在**本家自己的**判据里，共享分类器保持逐格同构。
 *
 * ## 缺陷形态（2026-10-20 审计 E-1，**既有缺陷、非 PR !124 引入**）
 *
 * Loomy 的业务失败**恒 HTTP 200**（`src/loomy.ts` 的协议说明：
 * 「带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`」），
 * 而请求级换号循环写在 `if (!response.ok)` 里面 ⇒ 200 的认证失败
 * **一次都不换号**。实测（基线 `b5dab83` 同样）：
 *
 * ```
 * classifyLoomyFailure('100002', 200)   ⇒ 'other'  rotate=false
 * classifyLoomyFailure('100002', 401)   ⇒ 'auth'   rotate=true   ← 只有状态码是 401 才算
 * ```
 *
 * 而 `100002` 才是 Loomy 表达「token 缺失/失效」的**主通道**。
 *
 * ⚠️ 与 `classifyLoomyFailure` 的职责边界：本函数**只回答**「这个响应体是不是
 * 认证失败」，不参与额度/限流的分类，也**不写冷却标记**（认证类一律不写，
 * 见 2026-10-06 的全池被封事故）。
 */
export declare function isLoomyAuthBusinessCode(envelope: {
    ok: boolean;
    code: string;
}): boolean;
/**
 * 该类别是否要写冷却标记（`auth` 不在其中，见 {@link LoomyFailureClass}）。
 *
 * ⚠️ 返回**类型谓词**而不是 `boolean`：{@link loomyCooldownResetAtMs} 只接受这两个
 * 类别，于是「先判类别、再算时长」这条顺序由**编译器**保证 —— 少了谓词，
 * 调用点忘了守卫时 `auth` 会静默拿到一个冷却时长（旧实现正是那个形状：
 * `status === 429 ? 1h : 24h` 的三元表达式对认证类也返回 24h）。
 */
export declare function recordsLoomyRateLimit(cls: LoomyFailureClass): cls is 'quota' | 'rate';
/**
 * 撞墙后把冷却标记写到**哪一刻**（UTC 毫秒）。
 *
 * | 类别 | 冷却终点 | 依据 |
 * |---|---|---|
 * | `quota` | **UTC+8 当日 24:00**（`nextUtc8DayStartMs`） | 每日赠送额度按自然日重置 |
 * | `rate` | 撞墙时刻 + 1 小时 | 频率类分钟级恢复，与 trae soft-rate 同档 |
 *
 * ## ⚠️⚠️ `quota` 原先记的是「撞墙时刻 + 24h」—— 真实缺陷（Gitee IKL80H）
 *
 * 用户真机报障（2026-10-13）：**0 点后上游已经放行（用户自己的账号实测能用），
 * 插件仍说该模型没到重置时间、不给用**。根因就是这个**滑动窗口**：Loomy 的每日赠送
 * 额度（每日 5000 / `dailyBalance = dailyQuota - dailyConsumed`）按 **UTC+8 自然日**
 * 重置，而旧实现从失败那一刻起算 24 小时。用户在 23:50 烧光 ⇒ 标记落到**次日 23:50**，
 * 于是白等将近一整天。
 *
 * 实测取证（注入时钟，失败时刻 `2026-10-13 23:50 UTC+8`）：
 *
 * | | 时刻 |
 * |---|---|
 * | 修复前写下的标记 | `2026-10-14 23:50`（**+24h**） |
 * | 正确的自然日终点 | `2026-10-14 00:00`（只差 10 分钟） |
 * | 0 点后 10 分钟的判定 | 仍判「全部账号限流」，距解禁 **23.67 h** |
 *
 * 症状出口两处（都读同一个 `modelRateLimits`）：选号侧
 * `allAccountsRateLimitedForModel` → `throwIfAllAccountsRateLimited` 报
 * 「可用账号均在限流中，最近一个将于 <次日 23:50> 解禁」；面板侧的「限额中」徽章
 * 与「限额重置」行。
 *
 * ⚠️ 这同时违反本仓库红线「**同一 provider 内不得有两套同义判据**」：
 * `aggregate-expiry.ts` 的 `loomyExpiry` 对**同一件事**（Loomy 的每日赠送何时失效）
 * 用的是 `nextUtc8DayStartMs()`，与适配器这里的 +24h 结论不同。现统一到自然日，
 * 与 qoder / zcode / codearts 三家同口径。
 *
 * ## ⚠️ 与 raccoon 的**冷却时长**不再同档（刻意的，已登记）
 *
 * 两家的**失败分类表**（`classifyLoomyFailure` / `classifyRaccoonFailure`）仍必须
 * 逐格同构（有对拍用例守着），但**冷却时长**由各自的额度结算周期决定：loomy 有
 * 明确的每日赠送池（自然日），raccoon 侧的 24h 兜底尚未同批核对 ⇒ 本次**只改 loomy**。
 * 这处不对称已记进 `docs/agent-notes/providers-loomy-raccoon-minimax.md`。
 *
 * ## ⚠️ 代价（如实登记）
 *
 * `classifyLoomyFailure` 判 `quota` 时**分不清**「每日赠送用尽」与「连永久积分也空了」
 * ——报文只有 `14018 Credits exhausted`。改用自然日后标记**严格变短**（最多差近 24h）
 * ⇒ 若某个号永久积分也空，0 点后会被重试一发再重新标记。这是刻意的取舍：
 * 宁可多发一发失败请求，也不要让用户白等一整天（旧值让**每一个**配额耗尽的号都白等）。
 *
 * @param cls - 失败类别；只接受会写标记的两类（由类型谓词保证）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export declare function loomyCooldownResetAtMs(cls: 'quota' | 'rate', nowMs?: number): number;
/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export declare class LoomyAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 兜底模型索引（id → 条目）。 */
    private readonly fallbackIndex;
    /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
    private remoteModels;
    /**
     * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
     *    本字段存「何时读到的」。两者缺一都会坏：只有 `remoteModels` 则目录永不更新
     *    （现状）；只有 `catalogAt` 则无内容可展示。
     */
    private catalogAt;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
    private readonly catalogGate;
    constructor(options: LoomyAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * ⚠️ **2026-10-08 Task 7a：三个方法收敛到共享骨架** `createModelCatalog`。
     *
     * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架（实测与
     * `minimax` / `raccoon` **归一化后逐字相同**）。现在只剩 `toCatalogEntry`
     * 这一个**本家私有**的转换，骨架（门控 → 读目录 → 黑名单 → 回填 → 三态）
     * 由 `src/model-catalog.ts` 统一持有。
     */
    private readonly catalog;
    /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
    /**
     * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog`（`model-catalog.ts`）
     *    上的这个成员**不会**自动变成适配器的成员 —— `pruned()` 的 Proxy 只透传
     *    **适配器自己的**成员（`dead-model-store.ts:748-749`）。
     *    漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且**零日志**（`refreshOf` 返回
     *    `undefined` 时静默跳过 —— `index.ts` 的装配注释写着这件事）。
     *    ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**重取）**不是同一件事**，
     *    两者同名纯属巧合，**不得合并**。
     */
    refresh(): Promise<void>;
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 取远端模型目录；**失败时不把兜底表写进缓存**。
     *
     * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
     * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
     * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
     * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
     * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
     */
    private loadModels;
    /**
     * 把本家私有的远端/兜底条目转成共享骨架的中间结构。
     *
     * ⚠️ 这里是**唯一**还认识「倍率格式」与「supportsImage」的地方 ——
     * 骨架不认识它们（各家格式不同）。
     */
    private toCatalogEntry;
    /** 本家全部条目（远端缓存 ?? 兜底表），已转成中间结构。 */
    private loadCatalogEntries;
    /** 同步视图（`listAllModels` 用，见 `ModelCatalogConfig.syncCatalog` 的说明）。 */
    private syncCatalogEntries;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 该模型的思考档位（`resolveModel` 的 `reasoning` 字段）。
     *
     * ⚠️ **此前根本不声明** —— DSH 的思考强度选择器**只会**从
     * `resolveModel().reasoning` 渲染，故两个站点从来没出现过档位选择器，
     * 尽管远端早就下发了 `reasoning_efforts`。这与 Qoder 那次（AGENTS.md 2.2 节）
     * 是**完全同型**的缺陷。
     *
     * 三条口径：
     * 1. `efforts` **原样取远端顺序**（服务端下发的就是展示顺序）；
     * 2. `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
     *    给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟；
     * 3. 远端未下发档位时不声明 `reasoning`（UI 显示「当前模型未提供推理等级」）。
     */
    private reasoningFor;
    /**
     * 探测退避表（`modelId` → 退避到期时刻）。
     *
     * ⚠️ 按 **modelId** 分桶而不是全局一个值：探测本身与模型无关，但热路径的
     * 前置分支是**按模型**进来的（`isLoomyExpired` 与 `resolveCredential(model)`），
     * 用全局值会让「A 模型抖动一次 ⇒ B 模型也跳过探测」——那是不必要的耦合，
     * 而按模型分桶没有额外代价（`Map` 只有几十条）。
     *
     * ⚠️ **只增不减**在此处是可接受的：条目数 = 用户用过的模型数（个位到几十），
     * 每次写都是覆盖同一个键。不做定期清理，避免再引入一个需要调度的东西。
     */
    private readonly probeBackoffUntil;
    /** 「现在」的统一取法（与 `options.now` 注入点同源，单测可推进）。 */
    private nowMs;
    /** 该模型当前是否处于探测退避窗口内。 */
    private probeBackedOff;
    /** 记一次退避（探测非终态失败后调用）。 */
    private armProbeBackoff;
    /** 清掉退避（探测成功，或终态已抛之后）。 */
    private clearProbeBackoff;
    /**
     * 把 `HTTP 200 + 业务码 100002` 的响应**重建**成一个 `401` 响应，交给既有换号循环。
     *
     * 返回 `undefined` 表示「不是这种形态，原样继续」。
     *
     * ## ⚠️ 三条边界（都是刻意收窄，避免制造新缺陷）
     *
     * 1. **只处理 `content-type: application/json`**：SSE 流**不能**在这里 `text()`
     *    读干——那会把正文吃掉，用户看到空回复。SSE 内嵌错误帧仍归
     *    `consumeOpenAiSse`。
     * 2. **只有 `code` 恰为 `LOOMY_AUTH_ERROR_CODE` 才转**：别的业务码（额度、参数）
     *    形态各异，一律不碰 —— 那是分类器与 `!response.ok` 分支的职责。
     * 3. **转换后仍带原始报文**：把原 JSON 原文塞回新响应的 body，于是下游
     *    `errorDetail()` 与日志拿到的仍是上游原话（不编造、不丢信息）。
     *    ⚠️ `normalize` 出来的 `status` 是 **401**（而不是编一个 4xx），
     *    因为下游 `classifyLoomyFailure` 对 401 判 `auth`、且认证类**不写冷却**
     *    （2026-10-06 全池被封事故的铁律）。
     */
    private rebuildAuthBusinessFailure;
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export declare function registerLoomyLlm(ctx: Context, options: LoomyAdapterOptions): LoomyAdapter;
//# sourceMappingURL=loomy-adapter.d.ts.map