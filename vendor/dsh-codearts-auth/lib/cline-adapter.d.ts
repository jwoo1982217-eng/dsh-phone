/**
 * Cline LLM 适配器。
 *
 * ## 与既有 provider 的差异
 *
 * Cline 的推理端点是**标准 OpenAI 兼容**的
 * （`POST {apiBase}/api/v1/chat/completions`，实测标准 SSE），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 Qoder 同做法。
 *
 * 差异只有三处：
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`**（前缀不可剥，见 `src/cline.ts`）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `delta.reasoning_content`）——
 *    已由 `consumeOpenAiSse` 同时兼容；
 * 3. **模型目录来自两个端点**（`recommended-models` 给 free 集合、
 *    `/models` 给全量 id），见 `src/cline-models.ts`。
 *
 * ## 免费标注
 *
 * 免费模型在 `name` 里拼 ` · 免费`。⚠️ **必须写进 `name` 而非 `description`**：
 * composer 的模型切换菜单只渲染 `name`（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`）。
 * 这是被用户报障纠正过的结论。
 *
 * ⚠️ 免费资格是**服务端动态下发**的（`recommended-models` 的 `free` 数组），
 * 故本适配器**不硬编码任何免费模型名** —— 与 CodeArts benefit 集合同约定。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import type { CatalogHealth } from './types.js';
import { type ClineCredential } from './cline.js';
import { type ClineModel, type ClineRemoteModels } from './cline-models.js';
import { type ClineProduct } from './cline-product.js';
import { type ImageRequestTarget } from './image-budget.js';
import { type ClineModelsDevEntry } from './cline-models-dev.js';
/** 本适配器注册的 provider 路由名（等价于 `CLINE.id`）。 */
export declare const PROVIDER = "cline";
/**
 * 清洗工具参数 schema 里的 `enum`（递归）。
 *
 * ## 为什么必须清洗（实测 400，用户报障 2026-09-25）
 *
 * harness 下发的工具集里，某些参数的 `enum` 含**空字符串**成员。Gemini 系模型
 * （经 `google` / `vertex` provider）对此**严格校验**，直接拒绝整个请求：
 *
 * ```
 * GenerateContentRequest.tools[0].function_declarations[34]
 *   .parameters.properties[permission].enum[3]: cannot be empty
 * ```
 *
 * ⚠️ 该错误**只在部分 provider 上暴露**：上游一次请求会依次尝试多个 provider，
 * 实测命中 vertex 时报「maxOutputTokens 越界」、命中 google 时报上述 enum 错误。
 * 两者是**两个独立根因**，都要修，否则路由一漂移就复发。
 *
 * ⚠️ 本适配器**从不自己造 enum** —— `stream()` 原样透传
 * `options.tools[].parameters`，故脏数据来自上游 harness。但请求是我们发的，
 * 只能在我们这一侧拦住。
 *
 * ## 三条边界（都要守）
 *
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法的数值枚举整段丢掉；
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`；
 * - **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪。
 */
export declare function sanitizeClineToolParameters(value: unknown): unknown;
/** `ClineAdapter` 的构造选项。 */
export interface ClineAdapterOptions {
    /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
    credentialRef: CredentialRef;
    /** 从凭据存储解析凭据。 */
    resolveCredential: (modelId?: string) => Promise<ClineCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 多账号池（用于限流时切换账号与模型黑名单）。 */
    accountPool?: AccountPool;
    /**
     * 「本次实际使用的是哪个**账号池账号**」（池 id，如 `cline-bb211a53`）。
     *
     * ⚠️ **请求记录的「账号」列必须用池 id，不能用凭据里的 `account_id`**：
     * 面板拿 `cline.quota` 下发的**池 id** 去过滤记录，两个 id 空间不一致时
     * 过滤恒为空 → 表格**永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
     *
     * ⚠️ 回调**只用于首次确定起点**（与 `QoderAdapterOptions.currentAccountId` 同因）：
     * 它返回「池当前会给出的那个账号」，适配器内部换号后**不会跟着变**，
     * 故换号后必须用局部变量跟进。
     */
    currentAccountId?: () => string | undefined;
    /**
     * 读取图片附件的原始字节（内联为 data URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
     * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
     *
     * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
     * 而不是抛错。判据与回退都在共享的 `projectRequestImage` 里。
     *
     * 背景（issue !IKITT9）：Cline 撞的是**请求体体积**（实测 24 张原图全过、
     * 32 张 ≈122 MiB 才 `TRANSPORT`），不是腾讯那道图片 token 预算 ——
     * 但解法同样是缩放，且阈值余量最小，所以配一个宽松的字节目标。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link CLINE}。 */
    product?: ClineProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 模型目录加载器覆盖（测试用）。
     *
     * 默认走 `loadClineModels`（两次远端请求）。注入后单测可完全离线。
     */
    loadModels?: (options: {
        credential?: ClineCredential;
    }) => Promise<{
        models: ClineModel[];
        warnings: string[];
        /**
         * 远端原始结果（判「这次到底拿到目录没有」用）。
         *
         * ⚠ 注入式加载器（单测）可以不传：此时退回用 `models.length > 0` 判断，
         * 而默认的 `loadClineModels` **一定**会传（因为 `models` 里永远并着兜底表，
         * 用长度判断是死代码 —— 见 `hasClineRemoteModels` 的注释）。
         */
        remote?: ClineRemoteModels;
    }>;
    /**
     * models.dev 目录加载器覆盖（测试用）。
     *
     * 默认走 `makeClineModelsDevLoader`（拉 models.dev，带 TTL 缓存）。
     * 它同时补**名字/上下文窗口/图片能力**，见 `src/cline-models-dev.ts`。
     * ⚠️ 注入后单测可完全离线 —— 与 `loadModels` 同款理由。
     */
    loadModelsDev?: () => Promise<Map<string, ClineModelsDevEntry>>;
    /**
     * 远端目录**落地后**的通知回调（issue IKJVTF）。
     *
     * 由 `registerClineLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
     * 拿不到 `ctx`（它只被注册进 `ctx.llm`），故必须由接线层桥接 —— 这与
     * `readImage` 等回调同一模式。
     *
     * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
     * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
     * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
     */
    onCatalogLoaded?: () => void;
}
/**
 * Cline 模型适配器。
 *
 * 使用 `Bearer workos:<jwt>` 鉴权，仅支持 SSE（与官方客户端一致）。
 */
export declare class ClineAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 远端模型目录缓存（首次成功后填充）。 */
    private remoteModels;
    /**
     * 已落缓存的目录是否**两个来源都取全**（issue IKJVTF）。
     *
     * ⚠️ **这是短路判据的第二半，绝不能省**：残缺目录**也**要落 `remoteModels`
     * （展示需要 —— 目录服务抖动时用户的模型列表不该整个消失），但那时**不能**
     * 短路，否则永远补不齐。修复前只判 `remoteModels !== undefined`，而残缺目录
     * 同样赋值 ⇒ `RemoteCatalogGate` 的冷却（`retryAt`）**永远读不到**
     * （`cooling()` 在生产里只有闸门自己那一处调用点，而它排在短路之后）
     * ⇒ 那 466 条按量计费模型再也拉不回来，只能重启 DSH。
     *
     * 判据用「已完整」而非「已定义」：残缺时放行到闸门，由冷却控制重试节奏
     * （30 秒一轮，不会打风暴）。
     *
     * ⚠️⚠️ **「完整」必须包含 models.dev**（issue IKKZUG，2026-10-12）。
     *
     * 修复前它只反映**两个 Cline 端点**（`remote.complete`），**不含 models.dev**
     * ⇒ models.dev 超时后 `remoteComplete` 仍是 `true` ⇒ 上面这个短路把闸门
     * 彻底旁路 ⇒ 闸门的冷却永远读不到 ⇒ models.dev 在整个进程生命周期内
     * 只被调 1 次。而 `cline-pass/*` 的模型条目与图片能力**只由 models.dev 提供**
     * ⇒ 它们会「明确不支持图片」到进程结束，**只能重启才能恢复**。
     *
     * 用户实测：桌面端 10-11 23:02 启动 → 10-12 00:30 仍稳定拒图。
     *
     * ⇒ 现在的口径是「**两个端点 + models.dev 都就绪**」。⚠️ 方向是「宁可多试
     * 一次」：多试的代价只是多发一次 models.dev 请求（自带 TTL 与闸门冷却），
     * 而漏判的代价是整个 provider 的图片能力永久失效。
     */
    private remoteComplete;
    /**
     * 兜底目录的**记忆化**结果（issue IKL3YH）。
     *
     * ⚠️ 不是为了省那点构造开销，而是为了**数组身份稳定**：下面的
     * `entriesCache` / `catalogIndexCache` 都以「来源数组的 `===`」为失效判据，
     * 若 `fallbackCatalog()` 每次返回新数组，离线路径会**每调用一次就重建一份**
     * 缓存（先是白建，接着被下一次覆盖）—— 缓存等于没有，且**症状静默**。
     *
     * 它的取值只来自 `this.product.fallbackModels`（静态产品配置），故记忆化安全。
     */
    private fallbackModelsCache;
    /**
     * 已构建好的 `CatalogEntry[]`，按**来源数组身份**失效（issue IKL3YH）。
     *
     * ⚠️⚠️ 这是本次性能缺陷的**主因**修复点。DSH 的 `buildModelCatalog` 形状是
     * 「1 次 `listModels` + **每模型一次** `resolveModelInfo`」，而 `dsh-llm` 的
     * `resolveModelInfo` 会**直连适配器、不做任何缓存**。共享骨架
     * `model-catalog.ts` 的 `resolveModel` 每次都 `await config.loadCatalog()`
     * ⇒ 整份目录被重建 N 次，叠加每个条目的模态查找就是 O(N²)。
     *
     * 实测（本仓产物，N=471 的宿主调用形状）：原实现 **293 ms/次**；
     * 只修模态查找是 121 ms；**再补上本缓存是 1.2 ms**。
     *
     * 失效判据用**身份**而不是长度：`ensureRemoteModels` 每次补齐都赋一个
     * **新数组**（`this.remoteModels = merged`），故「补齐 / 登录后重拉」都能
     * 自然失效；用长度会在「换了模型但条数相同」时读到陈旧目录。
     */
    private entriesCache;
    /**
     * `模型 id → 条目` 的 O(1) 索引，同样按来源数组身份失效。
     *
     * ⚠️ 只服务 `stream()` 的门禁（`inputModalitiesFor`）。`toCatalogEntry`
     * **不再走它** —— 它手上就有条目本体，直接读字段即可（见 `toCatalogEntry`）。
     */
    private catalogIndexCache;
    /**
   * models.dev 目录（`模型 id → 条目`，含名字/窗口/图片能力）。
   *
   * ⚠️ `undefined` = **还没读到**（不是「空目录」）：读不到时目录照常工作，
   * 只是少了它补的那几条。这条区分是整个模块的要点 ——
   * 把「没读到」当「不支持」正是「支持图片的模型发不了图」那个缺陷的形态。
   */
    private modelsDev;
    /** 正在进行中的 models.dev 加载（并发去重）。 */
    private modelsDevLoading;
    /** models.dev 加载器。 */
    private readonly loadModelsDev;
    /**
     * 目录加载闸门：并发去重 + 失败/空结果冷却。
     *
     * 此前这里只有 in-flight 去重（`private loading`），失败后立刻允许重试 ⇒
     * `buildModelCatalog` 的「每模型一次 resolveModel」会把一次失败放大成 N 次。
     * 详见 `src/remote-catalog-gate.ts` 的实测依据。
     */
    private readonly catalogGate;
    /**
     * ⚠️ **2026-10-08 Task 7d：三个方法收敛到共享骨架** `createModelCatalog`。
     * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
     * 现在只剩 `toCatalogEntry`（本家私有形状 + 免费集合 + 统一思考档位）。
     */
    private readonly catalog;
    constructor(options: ClineAdapterOptions);
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
     * 模型接受的输入模态；`undefined` = **能力未知**。
     *
     * ## 两级判据（**顺序不能颠倒**）
     *
     * 判据是**目录条目上的 `supportsImage`**，而它有两个来源（优先级即顺序）：
     * 1. **本地兜底表/内嵌目录**（`product.fallbackModels` 的策展条目）——
     *    从官方客户端内嵌目录提取的，比社区目录权威；显式 `false` 也照样赢。
     * 2. **models.dev**（`src/cline-models-dev.ts` 补进目录）—— 补前者覆盖不到的
     *    模型（`cline-pass/*` 等）。
     *
     * ## ⚠️⚠️ 三态：为什么 `undefined` 是**必需**的第三态（issue IKKZUG）
     *
     * 修复前恒返回两态，而这两态把**语义相反**的两种状态压成了同一个结果：
     * - 目录条目**明确** `supportsImage: false`（**确认不支持**）；
     * - 目录里**压根没有该 id**（**不知道**）。
     *
     * 而 cline 的「不知道」是**真实高频**的：`cline-pass/*` 的条目**只由
     * models.dev 提供**（网关 `recommended-models` 实测只下发 14 条，models.dev
     * 有 18 条），而 models.dev 是一个 5.39 MB 的外部站点、超时 20~60 秒
     * （用户实测直连三次：超时/超时/1.9 秒成功）。
     *
     * 报 `['text']` 的代价有二，第二个更隐蔽：
     * 1. 门禁文案说「模型不支持图片输入」，而真实原因是「目录还没拉到」——
     *    用户会去换模型、查文档，而解法只是**等目录就绪**；
     * 2. `['text']` 报给宿主后，DSH 见到「不含 image」的声明会按
     *    「**确认是纯文本模型**」把图片**静默投影成占位文本**
     *    （dsh-llm 的 `projectImagesForTextModel`）⇒ 图片既没进请求体、
     *    用户也拿不到任何原因。
     *
     * ✅ 宿主契约明写 `absent means unknown`（dsh-llm `types.d.ts` 的
     * `inputModalities`），故「不知道」必须表达为**省略该字段**。
     *
     * ⚠️ 与 `buddy-adapter.ts` 同构，但**判据的来源不同**：buddy 查四个来源
     * （远端 / 产品兜底表 / `IMAGE_MODELS` / 覆盖白名单），cline 只需查**目录
     * 条目这一个字段** —— 因为合并阶段已把两个来源都归一进条目了。
     *
     * ⚠️ **方向仍是保守**：未知**不放行**图片（见 `stream()` 的门禁），
     * 只是不再谎报「不支持」。
     */
    private inputModalitiesFor;
    /**
     * 目录健康快照（issue IKKZUG 第 5 点：可观测性）。
     *
     * ## 为什么需要
     *
     * 本家的目录来自**三个来源**，其中 `models.dev` 是 5.39 MB 的外部站点、
     * **经常拉不到**（用户实测直连三次：超时 / 超时 / 1.9 秒成功）。而失败时
     * 只有一行 `console.warn`，**宿主不落盘** ⇒ 用户与排障者看到的只是
     * 「贴不了图」，**无从判断**是「这个模型不支持图片」还是「目录还没拉到」。
     *
     * 用户正是靠手工推演才定位到这一层 —— 那不该是排障的常规成本。
     *
     * ## 三条纪律
     *
     * 1. ⚠️ **零 IO**：设置页挂载时对每个供应商都会调它，一旦触发网络请求
     *    就会拖慢首屏（本端点全程只用同步内存副本正是为此）。故只读内存字段。
     * 2. ⚠️ `note` **只在异常时给**：完整时不写该字段 —— 一句「一切正常」
     *    对排障毫无价值，真正需要看的正是异常时（也省掉前端一处渲染分支）。
     * 3. ⚠️ `complete: false` **不等于故障**：插件会按闸门冷却**自动重试**
     *    （见 `remoteComplete`），用户无需做任何事。它只说明「现在看到的
     *    列表与能力可能不全，但会自愈」—— 故文案里必须写明这一点，
     *    否则用户会以为要自己去修。
     */
    describeCatalogHealth(): CatalogHealth;
    /**
     * 取（或建）`模型 id → 条目` 的 O(1) 索引，按来源数组身份失效。
     *
     * ⚠️ **原实现在这里做的是 `remoteModels.find(...)`**（issue IKL3YH 的热点）：
     * 每个模型一次全表线性扫描 ⇒ 整表 O(N²)。实测该形态**全仓只有这一处**
     * （其余家是 `remoteMeta.get()` / `fallbackIndex.get()` 或直接吃已解析的条目）。
     *
     * ⚠️ 判据必须是「来源数组身份变了」而**不是**「长度变了」：目录补齐会换上
     * 一个条数可能相同的新数组，只看长度会读到陈旧索引。
     */
    private catalogIndexFor;
    /**
     * 懒加载远端模型目录。
     *
     * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
     * 此时同样触发远端拉取。
     *
     * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
     * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
     */
    private ensureRemoteModels;
    /**
     * 懒加载 models.dev 目录，并发去重。
     *
     * ⚠️ **失败只记日志、返回空表**：拿不到就相当于「这一层没有补充」，
     * 目录与图片能力都退回本地兜底表；下一次调用会重试（`TtlCache` 不缓存失败）。
     * 它是**补充**信息，不能因为一次抖动就让整个 provider 不可用。
     *
     * @returns 读到的条目；失败返回空 Map（调用方无需区分）。
     */
    private ensureModelsDev;
    /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
    private fallbackCatalog;
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     *
     * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
     * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
     * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
     * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
     * 故实际使用中不会读到空目录。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    /**
     * 把本家条目转成共享骨架的中间结构。
     *
     * ⚠️ 本家四处**真实差异**：
     * 1. **`isFree` 必须透出**：Jet Hub 的模型列表要按「计费/来源」分组
     *    （订阅 / 免费 / Cloud / 按量计费），而**免费集合是远端动态下发的**
     *    （见 `cline-models.ts` 的并集规则）—— 让客户端按前缀猜会漂移。
     *    ⚠️ 原声明把 `isFree` 写成**必填**（全仓唯一），而契约
     *    （`jet-hub-rpc.ts` 的 `ModelCatalogSource`）是**可选** ⇒ 此处按契约放宽
     *    （纯类型放宽，运行时行为不变：本家恒有值）。
     * 2. `description` 透传（`cline-models.ts` 的 `models.dev` 补缺）。
     * 3. `maxTokens` 过 `clampClineMaxTokens`（**必须声明**，否则上限永久退回网关默认）。
     * 4. `reasoning` 对**所有**模型统一声明（远端不下发档位，见产品配置注释）——
     *    这是 composer 里「思考强度」选择器的唯一入口。
     *
     * ⚠️⚠️ **`inputModalities` 直接读条目自己的 `supportsImage`**（issue IKL3YH）。
     * 原实现是 `this.inputModalitiesFor(model.id)`，即拿 id 回 `remoteModels` 里
     * **全表线性查找**一次 —— 而这里手上**就是那条条目**，查找纯属多余，且
     * 整表累积成 O(N²)。更糟的是它**掩盖了一个真缺陷**：搜索源只有
     * `remoteModels`，离线 / 首拉失败时它是 `undefined` ⇒ 兜底表里
     * `supportsImage: true` 的策划条目（`stealth/space-bunny-alpha` 等）
     * 被误报成**纯文本**，DSH 于是把图片静默投影成占位符。
     */
    private toCatalogEntry;
    /**
     * 把一份来源目录转成 `CatalogEntry[]`，**按来源数组身份缓存**（issue IKL3YH）。
     *
     * ⚠️ 必须缓存：`resolveModel` 会**每个模型**调用一次 `loadCatalog`，
     * 而 DSH 的 `buildModelCatalog` 恰好是「1 次 `listModels` + 每模型一次
     * `resolveModelInfo`」，且 `dsh-llm` 的 `resolveModelInfo` **不做缓存**。
     * 不缓存就是 N² 次条目构造 —— 实测 N=471 时 293 ms/次 对 1.2 ms/次。
     *
     * ⚠️ 失效判据用**身份**（`ensureRemoteModels` 每次落目录都赋新数组）
     * 而不是长度：补齐后的目录条数可能不变，只看长度会读到陈旧条目。
     */
    private catalogEntries;
    private loadCatalogEntries;
    /**
     * 同步视图（`listAllModels` 用）。
     *
     * ⚠️ 原实现的语义：读已缓存目录，**首次调用若缓存为空会触发一次后台加载**
     * （`void this.ensureRemoteModels()`），由下一次调用拿到结果 ——
     * 而 `model.list` 端点之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
     * 故实际使用中不会读到空目录。此处**逐字保留**该 fire-and-forget。
     */
    private syncCatalogEntries;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 解析模型元信息。
     *
     * ⚠️ 原实现里的四处判据（context / maxTokens / reasoning / modalities）现已
     * 收敛到 `toCatalogEntry`；骨架的 `resolveModel` 只做回填与「不声明未知」。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
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
    /**
     * 消费 OpenAI 兼容 SSE 并**记录请求流水**（「订阅额度」面板的请求记录，
     * 见 `src/cline-request-log.ts`）。
     *
     * 记录字段对齐参考实现（`github.com/codeOct/dsh-cline-pass` 的请求记录部分）：
     * 总延迟、**首个内容块耗时（ttft）**、token 用量（含**思考 token** ——
     * 它是解释「为什么等了这么久才出字」的关键数字：这个网关不流式输出思考内容，
     * 思考量只出现在 usage 里）、失败原因。
     *
     * ⚠️ 与参考实现的**差异及理由**：
     * - 不记 `ttfb`（响应体首字节）：本适配器只有单一网关、无 upstream 路由，
     *   响应头到达与首块之间没有独立的「选路」阶段，展示位只剩两个 ——
     *   表格显示「首块 / 总延迟」两个数即可。
     * - 换号过程**不逐笔记**：只记**最终结果**一笔。参考实现会把 AUTH/QUOTA
     *   的每次 attempt 都记成失败行；本适配器的 429 换号风暴（最多 3 轮）
     *   会把 100 条上限刷满，而用户真正要看的是「这笔请求成了没、花了多少」，
     *   「所有账号均不可用」这行已包含换号语义。
     *
     * ⚠️ **失败也必须记**：失败的请求是排查「为什么没回复」的第一线索
     * （429 / 11140 安全策略 / 网络错误各是不同的原因）。记录本身绝不抛错
     * （`recordClineRequest` 已兜底），记账失败不得反噬推理。
     *
     * @param meta - `accountId` 是**最终服务的那笔**账号（换号后即最后一个）。
     */
    private consumeWithLog;
    /** 消费 OpenAI 兼容 SSE（共享实现）。 */
    private consume;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
}
/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy 系一致：429（频率限制）与 402（额度耗尽）。
 * 其余错误（400 请求格式错、5xx 服务端故障）换号也无用 ——
 * 5xx 是所有账号共用的服务端问题，400 是请求本身的问题。
 *
 * ⚠️ 限流标记该写多长、以及给用户什么建议，都在 `src/cline-rate-limit.ts`
 * （那里有 Cline 专属的等待时长解析：它把时长写在**英文句子**里，
 * 既没有 `retry-after` 头、也没有绝对时刻）。
 */
export declare function isClineRotatableFailure(status: number, body: string): boolean;
/**
 * 额度/限流文案标记。
 *
 * 中英双通道：Cline 是国际产品，但用户账号可能是中文界面，
 * 且网关在不同层可能给出不同文案。
 */
export declare const CLINE_CREDIT_MARKERS: readonly string[];
/**
 * 该失败是否是**与凭据无关的访问限制**（地域封锁 / 模型未开通）。
 *
 * ## 为什么必须单独识别（真实缺陷，用户报障 2026-09-25）
 *
 * Cline 对「该地区不可用」的模型返回 **403**，而 401/403 在本适配器里原本一律
 * 被当作「凭据过期」：触发续期 → 重试 → 仍 403 → 最终 `httpErrorCode(403)`
 * 归成 `AUTH` → DSH 渲染成「**API 密钥无效**」。
 *
 * 实测 `cline-free/muse-spark-1.3-contributor`：
 *
 * ```
 * 403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
 *       is not available in your region","success":false}
 * ```
 *
 * 后果有两个：① 真实原因（地域限制）被完全掩盖，用户以为要去重新登录；
 * ② 每次请求都白跑一次续期（续期还会成功，所以不会提前报错，纯属浪费）。
 *
 * ⚠️ **不能按状态码一刀切**：同一批 403 里既有真的凭据问题，也有地域限制，
 * 只能靠**响应体文案**区分。认三种表述（上游措辞可能微调，故取特征词）：
 * `not available in your region` / `access forbidden` / `region not supported`。
 *
 * ⚠️ 命中时**跳过续期**，并让错误文案带出真实原因 —— 续期在这里永远无用，
 * 反而拖慢失败反馈。
 */
export declare function isClineRegionForbidden(status: number, body: string): boolean;
/**
 * 在 `ctx.llm` 上注册 Cline provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `cline`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export declare function registerClineLlm(ctx: Context, options: ClineAdapterOptions): ClineAdapter;
//# sourceMappingURL=cline-adapter.d.ts.map