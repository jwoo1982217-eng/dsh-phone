/**
 * OfficeAce 适配器：把 DSH 的 `LlmAdapter` 调用转发到华为 ModelArts MaaS。
 *
 * ## 与 AutoClaw 适配器的差异
 *
 * - **直连云端**（无本地网关）；凭据从本机 Redis 读（见 `officeace-auth.ts`）
 * - `listModels` 静态（`OFFICEACE_MODELS`）+ 探测门控（凭据读不到 = 隐藏分组）
 * - 响应含 `reasoning_content`，`consumeOpenAiSse` 已兼容 OpenAI 协议
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { type OfficeAceCredential } from './officeace-auth.js';
/**
 * 推理/探测该用哪个 host —— **必须优先用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## ⚠️⚠️ 这是一个阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 症状：Jet Hub 里 provider 列表**有** OfficeAce、账号也在，但**对话的模型选择器里
 * 一个 OfficeAce 模型都看不到**。
 *
 * 根因：适配器原先一律打硬编码的 `OFFICEACE.defaultBaseUrl`
 *（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 * 而华为**按账号下发专属网关** `modelgw-0004.officeace.cn-southwest-2...`。
 * 同一个 Basic 凭据实测：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 模型选择器**空分组**；
 * 且 `listModels` 的空返回与「无账号」**同形**，故「目录门控」会把整个
 * provider 隐藏 —— 用户看到的就是「加了账号却没有模型」。
 *
 * ⚠️ 字段其实早就写进了凭据（`fetchModelInfo` 从云侧 `model_api_url_base` 取），
 *    只是**从没被读过** —— 属「写了不读的死字段」，我在此前审计中已登记为
 *    已知缺口并**低估了它**（判为影响有限），真机证明它是主路径。
 *
 * ⚠️ **只用于 Basic 鉴权的推理/探测路径**。V11 签名那套（`/v1/subscription`、
 *    `/v1/model-token-rates`）实测**两个 host 都存在且都要求签名**，
 *    属管理面 API，**不要**一起改。
 *
 * @returns 规范化（去尾斜杠）后的 base URL；凭据没带时回退默认域（零行为变化）。
 */
export declare function maasBaseUrlOf(credential: OfficeAceCredential): string;
export interface OfficeAceAdapterOptions {
    /** 凭据（测试注入）；缺省每次从本机读取。 */
    credentialProvider?: () => Promise<OfficeAceCredential | undefined>;
    /**
     * **只读目录探测**专用凭据（`listModels` 的 `/v2/models` 探测与倍率读取）。
     *
     * ⚠️⚠️ **它刻意不走 `credentialProvider`**（Gitee issue IKLTHB 第 ① 条的连带
     *    缺陷，2026-10-15 自查发现）：`credentialProvider` 在「锁定永久积分且只剩
     *    永久桶」时**抛错**，而 `listModels` 的调用方**全都不接**这个错 ——
     *    `dsh-llm` 的 `llm.listModels()` 直接 `await` 适配器方法（无 try/catch），
     *    后果是一串与「锁定」毫不相干的症状：
     *
     *    | 调用方 | 症状 |
     *    |---|---|
     *    | `jet-hub-rpc.ts` 的 `model.list` | 面板报「读取模型列表失败：…锁定…」|
     *    | `jet-hub-rpc.ts` 的 `readableCatalogIds` | 「关闭供应商 / 关闭全部」被拒（`remoteError`）|
     *    | `aggregate-adapter.refreshCatalog` | 记一条 warn 后**跳过该渠道**（静默少一个候选）|
     *    | DSH 模型选择器 | 分组消失（与「目录门控」的空分组同形）|
     *
     *    ⇒ 判定写得很清楚：**锁定约束的是「推理取号」，不是「能不能读目录」**。
     *    `/v2/models` 与 `/v1/model-token-rates` 都是**只读、不扣积分**的，
     *    没有理由因为锁定而把它们也一起关掉（buddy 系就是这样的：锁定后模型
     *    照常列在目录里，发消息才报「没有可用账号」）。
     *
     * 缺省（未注入）时回落到 `credentialProvider` —— 保持既有嵌入方与单测行为不变。
     */
    probeCredential?: () => Promise<OfficeAceCredential | undefined>;
    /** 覆盖默认的 fetch（测试注入）。 */
    fetchImpl?: typeof fetch;
    /**
     * 凭据续期（宿主在「登录 / 点刷新积分」等时机调用）。
     *
     * ⚠️ **必须由接线层注入**：漏接的症状是该渠道的账号永不过期 —— 用户重新登录后
     *    旧凭据仍被继续用，且日志里一个字都没有（守卫用例断言
     *    `ctx.llm.adapterByProvider.get(id).options.refresh` 是函数）。
     */
    refresh?: () => Promise<void>;
    /**
     * 图片读取桥（宿主 `makeReadImage(ctx)`）—— **图片输入的必要条件**。
     *
     * 未提供时收到图片消息会报 `UNSUPPORTED_CONTENT`（与 trae 同约定）：
     * 静默丢图会让用户以为模型看到了图，实际它什么都没看见。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 黑名单模型 id（面板「显示列表」开关）。 */
    disabledModels?: () => ReadonlySet<string>;
    /**
     * 「该供应商**整体关闭**」探测（Gitee issue IKP8OF）。
     *
     * ⚠️ **与 {@link disabledModels} 是两条腿，不可互相替代**：
     * 后者是「这些具体 id 被关着」（有界集合），而本回调回答的是
     * 「用户要求整个供应商关着吗」—— 它能覆盖**关闭之后才出现的模型**，
     * 那些 id 从未进过黑名单，`disabledModels` 永远看不到它们。
     *
     * 本家不走共享骨架（`model-catalog.ts`），故必须在这里显式判一次；
     * 缺失时按「未整体关闭」处理（老接线 / 单测替身的行为逐字不变）。
     */
    providerClosed?: () => boolean;
    /**
     * 目录新鲜度用的时钟（**只**用于 `isCatalogFresh`，不参与任何业务判定）。
     *
     * ⚠️ 缺省 `Date.now()`；注入它只是为了让「20 分钟 TTL」在单测里可推进，
     *    业务语义（多久算新鲜）由 `model-catalog.ts` 的 `isCatalogFresh` **唯一**持有，
     *    本家不得自己写第二份判据。
     */
    now?: () => number;
    /** 目录可用后回调 —— 接线层注入 `broadcastCatalogChanged(ctx)`。 */
    onCatalogLoaded?: () => void;
}
/**
 * 收集消息中的图片附件引用（含工具结果内层，任意深度），按 attachmentId 去重。
 *
 * ⚠️ **已改为复用共享实现**（Issue IKLSB8）。原先这里是一份与
 * `openai-compat.ts` 逐字同义的私有副本，看似无害，实际是缺陷的一半：
 * 收集侧递归进 `tool-result` 内层，而**注入侧不递归** ⇒ 深层图片被收进 refs、
 * 读出了字节、却在序列化阶段被静默丢弃（连 `[image unavailable]` 占位符都没有）。
 * 判据：**收集与注入必须同源同深度**，两份实现分处两文件时没有任何东西保证它们
 * 同步 —— 共享一份才让这类分叉不可能发生（同 `buddy-adapter.ts` 的注释所警告）。
 */
export declare class OfficeAceAdapter extends LlmAdapter {
    private readonly options;
    /** 目录是否已广播过（只广播一次）。 */
    private announced;
    /** 倍率缓存（listModels 时填充，resolveModel 复用——保持两处名字一致）。 */
    private rateCache;
    /**
     * 上次**成功**刷新目录的时刻（毫秒）；`0` = 从未成功读过。
     *
     * ⚠️ 它同时覆盖**两个独立端点**：`/v2/models` 探测与 `/v1/model-token-rates`
     *    倍率。二者任一单独缓存都会让另一半每轮照旧打上游（倍率尤其致命 ——
     *    用户原话就是「不更新就拿不到实际倍率」），故**共用同一个时刻**。
     *
     * ⚠️ 判据只有一份：`model-catalog.ts` 的 `isCatalogFresh`（周期 20 分钟）。
     */
    private catalogAt;
    constructor(options?: OfficeAceAdapterOptions);
    /**
     * 取当前可用凭据；STS 临期（10 分钟内）先静默刷新。
     *
     * ⚠️ 刷新失败（refresh_token 已消费）返回旧凭据 —— 推理可能仍可用
     *（MaaS Basic 凭据与 STS 生命周期不同步）；真正失效由 stream 的 401 报错兜底。
     */
    private resolveCredential;
    /**
     * 目录专用凭据：**锁定永久积分也必须能读目录**（见 `probeCredential` 的注释）。
     *
     * ⚠️ 未注入 `probeCredential` 时回落 `resolveCredential()`：既有嵌入方与单测
     *    的行为逐字不变（只有宿主装配层会注入它）。
     */
    private probeCredential;
    providerInfo(provider: string): LlmProviderInfo;
    /** ⚠️ 必须同步（Jet Hub `ModelCatalogSource` 不 await，同 minimax 教训）。 */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    /**
     * 目录：凭据可读 + `/v2/models` 可达才暴露（隐藏不可恢复的分组，
     * 与 AutoClaw 同一约定：空目录 = 隐藏，而不是报错）。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    private announceLater;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 探测：模型端点 200 且 JSON（凭据有效即通过）。 */
    private probe;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>;
    }>;
    /** ⚠️ 单参数 `stream(options)`（`LlmAdapter` 基类契约）。 */
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
    /**
     * 把 HTTP 失败翻译成「用户下一步该做什么」。
     *
     * ## ⚠️ 401 那一格曾经**写死了被证伪的指引**（Gitee issue IKLTHB 第 ② 条）
     *
     * 改前的实现是一句无条件的断言：
     *
     * > `Basic 凭据失效：OfficeAce 会话已过期，请重新登录 OfficeAce 客户端`
     *
     * 那句在真实报障里**是错的**，而且**有反证**：用户按它去重新登录，
     * 结果 `modelAppKey`/`modelAppSecret` **逐字节不变**（取证见 `stream()` 里
     * `basicAuthFingerprint` 的注释）⇒ 重新登录在结构上就不可能修好这个 401，
     * 却被指引去做了一遍又一遍（264+ 次失败里有相当一部分是这么来的）。
     *
     * 现在改为**按报文与续期结果分派**：
     *
     * | 情形 | 文案指向 |
     * |---|---|
     * | 报文是 `APIG.1009` 且**续期没换掉 Basic 三元组** | 华为侧认定的 key 与本地不一致，**重新登录改变不了**；去华为云控制台/订阅处核对 |
     * | 报文是 `APIG.1009` 且**刚换过**凭据 | 新凭据也被拒 ⇒ 权限/订阅面 |
     * | 其它 401 形状 | 形状未知 ⇒ 如实说「不是已知的凭据失效形状」，提示核对 endpoint 与出口 |
     *
     * ⚠️ **分派必须先判形状、再判状态码**：`APIG.1009` 那几行的条件里**不得**出现
     *    `status === 401` —— 华为官方文档把它定义为 **400**、真机回 **401**，
     *    钉死 401 会让「文档那一侧」的报障彻底拿不到归因（第二轮审计实测缺口）。
     *    状态码只用于**兜底文案**（403 未订阅 / 404 / 429 / 5xx）。
     *
     * ⚠️ 与 `diagnose` 的调用方约定：本方法的返回值会被**拼进错误 message**，
     *    故错误本身**不得**带 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 这类会被 DSH 客户端
     *    整段替换的码（`stream()` 抛的是**裸 `Error`**，无 `code`）。
     *
     * @param status - 终态 HTTP 状态（重发过的话是重发的那个）。
     * @param body - 终态响应正文。
     * @param refreshedUnchanged - 本次已续期，但 Basic 三元组**一个字节都没变**。
     */
    private diagnose;
}
/** 在 `ctx.llm` 上注册 OfficeAce provider 路由（幂等，返回**原始适配器实例**）。 */
export declare function registerOfficeAceLlm(ctx: Context, options?: OfficeAceAdapterOptions): OfficeAceAdapter;
//# sourceMappingURL=officeace-adapter.d.ts.map