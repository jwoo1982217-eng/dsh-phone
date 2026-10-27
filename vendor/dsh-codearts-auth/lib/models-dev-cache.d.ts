/**
 * models.dev **唯一直读点** + 本地文件缓存（用户 2026-10-17 的要求）。
 *
 * ## 需求原文与其要解决的问题
 *
 * > 「定期读取 models.dev 应该成功就保存本地文件，冷启动就读本地文件缓存，
 * > 读不到就 fallback 不会直读 models.dev（可能回卡很久）；
 * > opencode 或者 cline 等 provider 读取 models.dev 的直读操作都变成读取本地缓存，
 * > 只有 1 消失定期更新本地缓存可以直读 models.dev 的 api」
 *
 * 改前有两处**各自**直连 `https://models.dev/api.json`（`opencode-capability.ts`
 * 与 `cline-models-dev.ts`），各自带一套 TTL / 在飞去重 / ETag。那份数据
 * **解压后 5.05~5.39 MB**、首字节 ~720ms、慢则 1.4s，而本机实测三取二超时、
 * 失败时**整段挂死**（不是「慢」，见 `cline-models-dev.ts` 的超时注释）。
 *
 * ⇒ 三条硬约定（本模块存在的全部理由）：
 *
 * 1. **全仓只有本模块 `fetch` models.dev**。其余消费方只读本地缓存文件。
 *    由 `tests/unit/models-dev-cache.spec.ts` 的「唯一直读点」扫描用例守住。
 * 2. **消费方永不因 models.dev 阻塞**：`readModelsDevSync()` 只做
 *    `readFileSync`（~19 KB 量级），**永不 await 网络**。
 * 3. **只有这里能写缓存文件**，且只写**成功**的结果 ⇒ 磁盘上永远是
 *    「最近一次成功」，失败不会把好数据覆盖成空。
 *
 * ## 为什么不是「进程内 TTL 缓存」而是「文件缓存」
 *
 * 改前两处都用进程内 TTL。问题在于**首次运行**（磁盘无缓存）时，
 * `listModels` 渲染路径要么空着、要么去等网络 —— 后者就是 2026-10-02
 * 的真机事故「模型选择一直卡着」。文件缓存让「首次运行」与「每次冷启动」
 * 同形：两者都只读文件，只有**写**缓存这一条路径碰网络。
 *
 * ## 降级链（三级，逐级放宽，**绝不**回退到网络）
 *
 * ```
 *   内存（本次进程已刷新过）
 *     ↓ 冷启动 / 未刷新
 *   磁盘文件（$DSH_HOME/cache/models-dev.json）
 *     ↓ 首次运行 / 文件损坏 / 版本不符
 *   undefined（调用方各自的本地兜底表）
 * ```
 *
 * ⚠️ **磁盘文件的 TTL 只影响「是否触发后台刷新」，绝不影响「能否读到」**：
 * 陈旧的目录远好过空目录（空目录会把所有模型打回纯文本，见
 * `cline-models-dev.ts` 的模块头事故记录）。这正是 `TtlCache.peekStale()`
 * 的「陈旧兼顶」语义在本场景的用法。
 */
/**
 * 社区模型目录（公开、无需认证）。与官方 CLI、cline 侧同源。
 *
 * ## ⚠️⚠️ **唯一的目录来源**；用户提议过的 OpenRouter 备份源**已被实测否决**
 *
 * 用户 2026-10-17 提议用 `https://openrouter.ai/api/v1/models` 当备份
 * （实测**国内可达**：HTTP 200 / 2.3s / 470 条）。**实测核对后决定不接入**：
 *
 * | 问题 | 实测 |
 * |---|---|
 * | **没有 `provider.api` 字段** | 470 条里 **0 条**有 ⇒ 而它是协议可达性的**唯一权威来源** |
 * | **id 命名空间不重叠** | 前缀全是 `openai:`/`deepseek:`/`z-ai:`…；`*opencode*` / `*zen*` 匹配 **0 条** |
 *
 * ⇒ 并进来会让 `chatProtocol` 变成 `undefined` ⇒ 退回本地表 ⇒ **等于没修
 * Issue IKM9LR**，还会给未来埋一个「某些条目可达性来源不明」的坑。
 * 它能补的 `context_length` / `architecture.input_modalities` 在 models.dev
 * 也有 ⇒ 属**冗余而非补充**。
 *
 * ⚠️ 将来若要重新评估，必须先确认它**新增了** models.dev 没有的独占字段；
 * 「它更稳定」不是理由（稳定性由本模块的重试与「失败保留旧缓存」解决）。
 */
export declare const MODELS_DEV_URL = "https://models.dev/api.json";
/**
 * 单次尝试的超时（毫秒）。
 *
 * ## ⚠️ 实测依据（2026-10-17，10 次采样）
 *
 * models.dev 在本机是**「要么很快、要么整段挂死」**，不是普通的「慢」：
 *
 * | 样本 | 结果 |
 * |---|---|
 * | 成功 | **1.9s / 2.3s**（多次复现） |
 * | 失败 | `20010ms 超时`（两连）、`fetch failed`、挂到 600s 未返回 |
 *
 * 成功只需约 2 秒，失败却能挂满整个超时窗口 ⇒ 超时值**几乎不影响成功请求
 * 的耗时**，只决定「挂死的请求何时被放弃」。⇒ 该值可以放心调大。
 *
 * ## 为什么从 60s 加长到 90s（用户要求「有超时要加长点」）
 *
 * 加长的收益不是「成功的那 2 秒需要更久」，而是**跨过一部分慢链路**：
 * 上游 5.5 MB 的响应在弱网下可能被拆成很多段，60s 卡住但 90s 能读完的情形
 * 是真实存在的（`Invoke-WebRequest` 45s 那次就是卡在传输中）。
 *
 * ⚠️ **代价被严格框住**，不会外溢到用户：
 * ① 刷新全程在**后台**且 fire-and-forget（见 {@link refreshModelsDev}），
 *    渲染路径只读磁盘缓存，**永远不等这个超时**；
 * ② 有重试上限（3 次）⇒ 单轮最坏 270s，而它跑在 3 小时的周期定时器里，
 *    且 {@link runRefresh} 的在途去重保证任何时刻至多一个请求在飞；
 * ③ 死锁检测阈值（{@link MODELS_DEV_DEADLOCK_MS}）已按新上限定标。
 *
 * ⇒ 调大超时**不会**让「模型选择器一直卡着」复发：那次事故的成因是
 * **渲染路径 await**，不是超时值。
 */
export declare const MODELS_DEV_TIMEOUT_MS = 90000;
/**
 * 单轮刷新的最大尝试次数（用户要求「重试 3 次都失败才完全放弃」）。
 *
 * ⚠️ **是「总次数」而不是「首次 + 3 次重试」**：用户原话是「重试 3 次都失败
 * 才完全放弃」，按 3 次总尝试实现（即 2 次重试）。差别在最后一次的语义上：
 * 3 次总尝试已经足够覆盖「瞬时抖动」，再多只是拉长放弃前的等待。
 *
 * ## 为什么值得重试（实测依据）
 *
 * models.dev 的失败**高度间歇**：同一台机、同一分钟内实测
 * `HTTP 200` / `45s 超时` / `HTTP 200` 交替出现。而失败时**缓存保持旧值继续用**
 * （本模块的核心不变式）⇒ 重试的收益只是「尽快追上上游」，代价是一次后台
 * 请求。方向是安全的。
 */
export declare const MODELS_DEV_MAX_ATTEMPTS = 3;
/**
 * ⚠️ 「上一次刷新已死」的判定阈值。
 *
 * 必须 **> 单轮最坏耗时**（3 次 × 90s + 6s 退避 ≈ 276s），否则**重试本身
 * 会被误判成卡死**：一个正在正常重试的刷新会被后来的调用当成「上一次已死」
 * 而**再起一个**，于是并发请求翻倍 —— 恰好加剧了我们想避免的上游压力。
 *
 * ⚠️ 这是加长超时 + 加重试**必须同改**的耦合点：任何一方单独变大都够不到
 * 对方。两个常量都写死在这里，便于对照。
 */
export declare const MODELS_DEV_DEADLOCK_MS = 480000;
/** 一轮刷新（含全部重试）的最坏耗时估算（毫秒）—— 仅用于文档与死锁阈值对照。 */
export declare const MODELS_DEV_WORST_CASE_MS: number;
/**
 * 缓存有效期（毫秒）：决定「是否触发一次后台刷新」。
 *
 * ⚠️ 这份目录是**发布节奏**的数据（新模型上线才变），按小时级刷新足够。
 * 与 `CLINE_MODELS_DEV_TTL_MS` 同为 6 小时，别让它俩漂移。
 */
export declare const MODELS_DEV_TTL_MS: number;
/**
 * ⚠️⚠️ **只缓存这些 provider 的块**（实测数据规模：全站 8993 条 / 2.6 MB）。
 *
 * ## 为什么必须白名单，而不是整份落盘
 *
 * models.dev 的 `api.json` 覆盖**全站** provider（实测 8993 个模型条目，
 * 落盘后 **2.6 MB**），而本插件只消费其中两个块：`opencode`（实测 127 条）与
 * `cline-pass`（实测 18 条）—— 合计 145 条、约 **40 KB**。
 *
 * 落盘全站的后果不是「磁盘浪费」，而是**启动路径上多读 2.6 MB**：
 * `loadDiskCacheSync()` 是 `readFileSync`，跑在插件加载与每次
 * `getOpencodeCapabilitiesSync()` 的前置路径上 ⇒ 与本模块自己写的
 * 「代价可忽略」直接矛盾，也与 2026-10-02「模型选择器一直卡着」的事故
 * 精神相悖（那次事故正是渲染路径上多等了一次 IO）。
 *
 * ## ⚠️ 新增消费方时**必须**往这里加一条
 *
 * 漏加的症状：那个消费方永远读到空块 ⇒ 它以为「上游没有这个 provider」。
 * `tests/unit/models-dev-cache.spec.ts` 的「白名单覆盖当前消费方」那条
 * 扫描用例会红 —— 判据是「消费方读过的 provider 名必须在白名单里」。
 */
export declare const MODELS_DEV_CACHED_PROVIDERS: readonly ["opencode", "cline-pass"];
/**
 * 一个模型的**精简投影**（原样条目有好几 KB）。
 *
 * ⚠️ **投影必须无损到「够用」**：字段少一个，消费方就少一条判据。
 * 当前覆盖：`name` / `cost` / `limit` / `modalities` / `reasoning` /
 * `reasoning_options` / `tool_call` / `provider.api`。
 *
 * ⚠️ 全部字段**可选** —— models.dev 的条目形态并不齐一（实测 `jev-1.13-free`
 * 连 models.dev 条目都没有），**缺字段一律是「不知道」而非「否」**。
 */
export interface ModelRecord {
    name?: string;
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
    limit?: {
        context?: number;
        input?: number;
        output?: number;
    };
    modalities?: {
        input?: string[];
        output?: string[];
    };
    reasoning?: boolean;
    reasoning_options?: unknown;
    tool_call?: boolean;
    /** 该模型所属的**协议端点**（如 `…/inference/openai/v1`）。 */
    provider?: {
        api?: string;
    };
}
/** 缓存文件路径。`DSH_HOME` 未设时回落 `~/.dsh`（与 opencode 能力表同型）。 */
export declare function modelsDevCacheFile(): string;
/**
 * 把 models.dev 的原始响应解析成 `provider → 模型 id → 投影条目`。
 *
 * ⚠️ provider 块的位置有**两种**实测形态：`json['cline-pass']`（顶层直挂）
 * 与 `json.providers['cline-pass']`（嵌在 `providers` 下）。**两者都认** ——
 * 与 `parseClineModelsDev` 的既有口径一致；只认一种会让整份目录静默变空。
 *
 * ## ⚠️⚠️ **只解析白名单里的 provider**（见 {@link MODELS_DEV_CACHED_PROVIDERS}）
 *
 * 不做这一步就会把全站 8993 条 / 2.6 MB 落进磁盘缓存，而 `loadDiskCacheSync`
 * 是**同步**读 —— 它跑在插件加载与每次能力表读取的前置路径上。
 * 实测踩过：整份落盘后文件 2.6 MB，与本模块自己写的「代价可忽略」矛盾。
 *
 * ⚠️ 白名单**不匹配**的 provider 一律丢弃（不是「解析但不用」）：那会让
 * 内存里也留着全站数据，每次冷启动多分配几 MB 对象图。
 */
export declare function parseModelsDev(raw: unknown): Record<string, Record<string, ModelRecord>>;
/** 渲染路径唯一入口：**同步**读，永不 await。 */
export declare function readModelsDevSync(): Record<string, Record<string, ModelRecord>>;
/** 缓存文件的写入时刻（0 = 从未成功写入），供 TTL 与可观测性判定。 */
export declare function modelsDevCacheAt(): number;
/** 是否已成功拿到过目录（内存或磁盘任一）。 */
export declare function hasModelsDev(): boolean;
/** 某 provider 块的**同步**读（`opencode` / `cline-pass` 等）。 */
export declare function readProviderModelsSync(provider: string): Record<string, ModelRecord>;
/** 构造选项（测试可注入时钟与 fetcher）。 */
export interface RefreshModelsDevOptions {
    fetcher?: typeof fetch;
    now?: () => number;
    /** 忽略 TTL 强制刷新（面板「刷新目录」用）。 */
    force?: boolean;
    /** 日志出口。 */
    warn?: (message: string) => void;
    /**
     * 刷新成功后的**次级**回调（在 {@link refreshModelsDev} 的 `onUpdated` 之后跑）。
     *
     * ⚠️ 存在的理由：主回调通常广播目录变更（对外可见），
     * 而消费方（`opencode-capability.ts`）需要作废自己的归一缓存（纯内部）。
     * 合成一个回调会迫使消费方在广播路径上做内存管理，出错时症状极难定位。
     */
    onUpdated?: () => void;
    /**
     * 覆盖退避 sleep（**单测用**）。
     *
     * ⚠️ 为什么需要：真实退避是 2s → 4s，「三次全败」那条用例要真等 6 秒，
     * 会撞上 vitest 的 5s 单测超时。注入一个立即 resolve 的替身后，
     * 用例可以在**毫秒级**验证「恰好 3 次」与退避**次数**，且不必真的睡。
     *
     * ⚠️ 缺省时用真实 setTimeout（生产路径唯一形态）。注入点只影响等待，
     *   不影响尝试次数与成功判定 —— 那才是这条用例真正要锁的东西。
     */
    sleep?: (ms: number) => Promise<void>;
}
/**
 * 后台刷新缓存（**永不阻塞**调用方，fire-and-forget）。
 *
 * @param onUpdated 刷新成功后的回调（接线层广播 `llm/adapters-updated`）。
 */
export declare function refreshModelsDev(onUpdated?: () => void, options?: RefreshModelsDevOptions): void;
/**
 * **可 await** 的刷新（供「必须拿到结果才能继续」的调用方，如 cline 目录闸门）。
 *
 * ## ⚠️ 与 {@link refreshModelsDev} 共用**同一个在途槽**
 *
 * 两者若各写一套，插件启动瞬间 opencode 与 cline 会各发一次 5 MB 请求 ——
 * 而 models.dev 的实测表现是「要么 ~2 秒、要么整段挂死」，并发两份只会把
 * 慢链路的代价翻倍。这里让 fire-and-forget 那条**转调**本函数，
 * 保证全仓**任何时刻至多一个** models.dev 请求在飞。
 *
 * @returns 是否成功。失败时**保留旧缓存**（`readModelsDevSync` 仍可用）。
 */
export declare function refreshModelsDevAsync(options?: RefreshModelsDevOptions): Promise<boolean>;
/**
 * 启动期预热：**同步**读一次磁盘缓存，然后**后台**补一次刷新。
 *
 * ⚠️ `ensureDiskLoaded` 那条 async 链是**刻意去掉**的：它只会「读到就返回、
 *   没读到就后台拉」，而 `loadDiskCacheSync()` 已经在同步路径上做了同一件事。
 *   多一条 async 链既不增加能力，又让「是否读到缓存」有两个判据。
 */
export declare function primeModelsDev(): void;
/** 清空内存与磁盘缓存（单测用）。 */
export declare function clearModelsDevCache(): Promise<void>;
/** 测试用：直接塞一份内存目录（不碰磁盘）。 */
export declare function setModelsDevForTest(providers: Record<string, Record<string, ModelRecord>>): void;
//# sourceMappingURL=models-dev-cache.d.ts.map