/**
 * 聚合 provider：**一个规范模型名，多渠道候选**，按临期积分自动选渠道。
 *
 * ## 与 `jet-hub-auto` 的分工
 *
 * | | `jet-hub-auto/auto` | `aggregate/auto` | `aggregate/<规范模型>` |
 * |---|---|---|---|
 * | 候选来源 | 5 个渠道的所有模型 | 所有渠道的所有模型 | **该虚拟模型**的候选表 |
 * | 渠道内选模型 | 按倍率挑最便宜 | 同左 | 固定 realId，无选择 |
 * | 用途 | 不挑模型，谁临期烧谁 | 同左 | 锁定模型质量，渠道间轮询 |
 *
 * 两者**共用** `aggregate-core` 的排序与哨兵口径（见该模块头：两份实现必然漂移）。
 *
 * ## 目录是**动态**的
 *
 * 虚拟模型表由各渠道的**当前**目录推导（`buildVirtualModels`）⇒ 用户新增/关闭
 * 渠道模型后，下次 `listModels` 自动反映，无需重启。⚠️ 故**不缓存**目录，
 * 只缓存「一次选型」的结果（见 {@link AggregateAdapterOptions.ttlMs}）。
 *
 * ## DSH 的两条硬约束（违反即报错）
 *
 * 1. `listModels` 每条必须 `provider === 注册路由`、id/name 非空且**id 不重复**
 *    （否则 `INVALID_CATALOG`）；
 * 2. `resolveModel` 返回的 `provider`/`id` 必须与请求**逐字相符**
 *    （否则 `INVALID_MODEL_INFO`）—— 这是「多虚拟模型」必须按入参回填的原因。
 *
 * @module src/aggregate-adapter.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountPool } from './account-pool.js';
import type { AggregateRejectionMap } from './jet-hub-store.js';
import { type VirtualModel } from './aggregate-catalog.js';
import { type ExpiryProbe } from './aggregate-core.js';
/** 注册到 `ctx.llm` 的路由，也是 `providerInfo().id`（DSH 校验二者相等）。 */
export declare const AGGREGATE_PROVIDER = "aggregate";
/** 「不挑模型」的虚拟模型 id。 */
export declare const AGGREGATE_AUTO_MODEL = "auto";
/**
 * 临期探针的类型 `ExpiryProbe` 定义在 **`aggregate-core.ts`**（纯类型、零 IO）——
 * 实现是 `aggregate-expiry.ts` 的 `createExpiryProbe`，`auto-adapter.ts` 的
 * `expiryOf` 也复用它（薄委托）。
 *
 * ⚠️ **未接入的 provider 必须返回 `UNUSABLE`** —— 返回 `NEVER` 会让一个我们对其
 * 余额一无所知的渠道以「永久积分」身份参与轮换（见 `aggregate-expiry.ts` 的
 * 逐渠道判据表与长注释）。
 */
/** 聚合层的选型缓存时长（与 auto 同量级）。 */
export declare const AGGREGATE_TTL_MS = 60000;
/** 目录推导的缓存时长。
 *
 * ⚠️ **必须有这个缓存**：`refreshCatalog` 要向**每一个**渠道调 `listModels`，
 * 而其中数家会**发网络请求**取远端目录（buddy / workbuddy / lobsterai / trae /
 * cline / zcode）。而模型选择器会频繁问目录 ⇒ 没有缓存时，每打开一次选择器都会
 * 扇出十几次上游请求。
 *
 * ⚠️ 但**不能缓存太久**：用户新增/关闭渠道模型后，聚合目录要跟着变（这正是
 * 「目录是动态的」那条设计）。60 秒与各家自己的目录缓存同量级。
 */
export declare const AGGREGATE_CATALOG_TTL_MS = 60000;
export interface AggregateAdapterOptions {
    accountPool: AccountPool;
    /** 注入的当前时刻（测试用）。 */
    now?: () => number;
    /** 选型缓存时长（测试用）。 */
    ttlMs?: number;
    /** 目录推导缓存时长（测试用；生产用 {@link AGGREGATE_CATALOG_TTL_MS}）。 */
    catalogTtlMs?: number;
    /** 临期探针（省略时用 `createExpiryProbe`；单测注入替身）。 */
    expiryProbe?: ExpiryProbe;
    /**
     * 读取「拒绝轮换」表（虚拟模型 id → provider → realId → true）。
     *
     * ⚠️ 必须是**函数**而不是快照：设置面板上的开关改完后，**下一次请求**就要生效。
     * 传快照会让用户以为开关坏了（要重启插件才生效）。
     * 省略时视为「没有任何拒绝」（全部候选参与轮换）。
     *
     * ⚠️ 与 `choiceCache` 的耦合：改了拒绝表必须调
     * {@link AggregateAdapter.clearChoiceCache}，否则 60 秒 TTL 内仍会用旧的候选序
     *（RPC 端点负责这件事，见 `aggregate.setRejected`）。
     */
    rejections?: () => AggregateRejectionMap;
}
/** 聚合适配器。 */
export declare class AggregateAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /** 上次目录读取结果（面板与 listModels 共用一次推导）。 */
    private catalog;
    /** 上次推导时刻（目录缓存的判据）。 */
    private catalogAt;
    /**
     * **按虚拟模型**缓存的候选序（键 = 虚拟模型 id）。
     *
     * ## 为什么需要它（规格 §9 要求，初版漏实现 ⇒ 死配置）
     *
     * `candidatesFor` 会对每个候选渠道 `await probe(...)` —— 那是一次**上游余额
     * GET**。而 `prepareCall` 是**每请求一次**（`dsh-llm/lib/index.js:1667`），
     * 于是 `auto` 最坏每轮要打十几次余额查询；而**旧的 `auto` 有 60 秒缓存**
     * （`auto-adapter.ts` 的 `AUTO_CHOICE_TTL_MS`）⇒ 新主路径反而**严格劣于**旧路径。
     *
     * ⚠️ 必须**按模型分别缓存**（规格 §9）：不同虚拟模型的候选表不同，共用一条会让
     * A 模型的候选序被 B 模型的请求覆盖。
     * ⚠️ 缓存的是**候选序**，不是「最终选中的渠道」—— 失败切换仍在同一次请求内
     * 逐个尝试（那是 `dispatch` 的事，与本缓存无关）。
     * ⚠️ 一分钟内临期时刻不会显著变化，故 60 秒 TTL 不破坏「临期优先」的语义。
     */
    private readonly choiceCache;
    /**
     * 「上次**实际**转发成功的渠道」——按虚拟模型分别记录（P3，供用量徽标显示）。
     *
     * ## ⚠️ 语义是**真实历史**，不是预测
     *
     * 只在**产出可见内容时**写入（= 这个候选真的成功了）。**不做预测**：
     * 预测的胜者可能因失败切换而实际未被使用，徽标显示一个错的渠道比不显示更误导。
     *
     * ## ⚠️ 纯内存、进程内
     *
     * 插件重启即清空 ⇒ 徽标「无历史 ⇒ 不渲染」（规格 §6.3 的 P4）。
     * ⚠️ **不落盘**：这是展示用的瞬时状态，写盘只会带来无谓的 IO 与陈旧值
     *（重启后显示一个早已不用的渠道，反而误导）。
     *
     * ⚠️ 与 `choiceCache` 的区别：那个缓存的是**候选序**（可预测），
     * 本表记录的是**实际结果**（已发生）——两者不可互相推导。
     */
    private readonly activeProviderByModel;
    constructor(ctx: Context, options: AggregateAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 该虚拟模型下被**拒绝轮换**的候选集合，键是 `` `${provider}\u0000${realId}` ``。
     *
     * ⚠️ 用 `\u0000` 作分隔符（不是 `:` 或 `/`）：provider id 与 realId 里都可能含
     * 冒号或斜杠（如 `cline-free/deepseek-v4.1-flash`），用它们会**误判**（把
     * `a/b` + `c` 与 `a` + `b/c` 拼成同一个键）。NUL 在两者里都不可能出现。
     */
    rejectedIn(canonicalId: string): ReadonlySet<string>;
    /**
     * 该虚拟模型下**实际应被拒绝**的候选集合（**含 D4 的 id 漂移降级**）。
     *
     * ## ⚠️ 为什么需要它（规格 §0.3 D4 + §1.9 + §5.1 的成文要求）
     *
     * 规格 §5.1 的判据表：
     * ```
     * 查 (虚拟模型, provider, realId) 是否有拒绝记录
     * ├─ 有精确匹配 → 拒绝该候选
     * ├─ 无精确匹配，但该 (虚拟模型, provider) 下有**任何**拒绝记录
     * │     且该记录对应的 realId **已不在当前候选中**（id 漂移）
     * │     → 降级为渠道级拒绝（该虚拟模型下该渠道全部候选都被拒），并记一条 warn
     * └─ 无记录 → 参与轮换
     * ```
     *
     * ## ⚠️ 不实现它的**真实后果**（规格 §1.9 记录的静默失效）
     *
     * `lobsterai` 的候选 id 会随「远端可用 / 兜底」切换：远端是 `deepseek-flash`
     *（真 V4.1 Flash），兜底表是 `deepseek-v4-flash`（更旧的型号）。
     * 若拒绝记录只锁 `realId`，**状态一翻转就匹配不上、静默失效** ——
     * 用户明确拒绝过的候选**悄悄复活**，而他以为还拒着。
     *
     * ⚠️ 降级判据是「该记录对应的 realId **已不在当前候选中**」——
     *    **不是**「没有精确匹配」（那样会把「同渠道的另一个候选没被拒」也降级掉，
     *    那是过度拒绝，方向相反的错误）。
     *
     * @param virtual - 当前的虚拟模型（用来知道该渠道眼下有哪些 realId）
     * @returns 应拒绝的 `provider\u0000realId` 集合（**已展开为渠道级**，若降级发生）
     */
    rejectedFor(virtual: {
        key: string;
        candidates: readonly {
            provider: string;
            realId: string;
        }[];
    }): ReadonlySet<string>;
    /**
     * 清空选型缓存。
     *
     * ⚠️ **改了拒绝表之后必须调它**：`choiceCache` 的 TTL 是 60 秒，而面板上的开关
     * 是「立刻生效」的语义 —— 不清缓存的话，用户在面板上关掉的候选在 60 秒内仍会被
     * 尝试（用户会以为开关坏了）。RPC 的 `aggregate.setRejected` / `clearRejected`
     * 负责调用。
     */
    clearChoiceCache(): void;
    /**
     * 「上次**实际**转发成功的渠道」（P3，供用量徽标）。
     *
     * ⚠️ **纯内存读、零网络零余额查询** —— 徽标在**门控阶段**就要拿到它
     *（规格 §6.3 的 P2：重定向必须发生在门控之前），查网络会让外层渲染抖动。
     *
     * @param canonicalId - 虚拟模型 id。**省略时返回「最近一次任意虚拟模型的转发渠道」**
     *   （规格 §8.4：徽标只关心「当前在跑的是哪个渠道」，不必区分模型）。
     *   实现上「最近一次」取 `Map` 的**最后一个插入项** —— 但 `Map` 的迭代顺序是
     *   **插入顺序**而非「最近写入顺序」（覆盖已存在的键**不改变**其位置）。
     *   ⚠️ 故这里**显式维护一个「最近写入」指针**，而不是依赖迭代顺序
     *   （否则「切回一个之前用过的渠道」时顺序会错，徽标显示旧渠道）。
     * @returns 渠道 id；无历史时 `null`（调用方据此**不渲染**徽标）。
     */
    activeProvider(canonicalId?: string): string | null;
    /** 最近一次（任意虚拟模型）实际转发成功的渠道；无历史时 `null`。 */
    private lastActiveProvider;
    /**
     * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定方案 C）。
     *
     * ## ⚠️⚠️ 这是**唯一**会做余额探测的面板端点 —— 且**只在用户显式点击时**调用
     *
     * 为什么必须单独一个方法而不是给 `describeCatalog` 加参数：那个方法的契约是
     * **零余额查询**（规格 §8.3，且有专门用例断言 `expiryProbe` 零调用）。
     * 面板一打开就打十几次上游请求是不可接受的；而「按临期排序」**必须**探测才知道顺序。
     * ⇒ 两者分开：默认零探测，用户点按钮才走这里。
     *
     * ## 为什么需要它（用户报障）
     *
     * 面板标题写「临期优先」，但候选列表来自 `aggregate-catalog.ts` 的
     * `candidates.sort(...)` —— 那是按 `provider` **字母序**
     * （用户原话：「codearts 的 4.1 flash 没有显示在最后」）。
     * ⇒ 标题与列表**矛盾**（面板没说真话）。
     *
     * ## 返回形状
     *
     * `{ <provider>: expiry }` —— 按渠道去重（同一渠道的多个候选共享一次探测，
     * 与 `candidatesFor` 的 `seen` 表同一口径，避免重复打上游）。
     * ⚠️ 探测失败（`UNUSABLE`）也如实返回该值，由客户端决定怎么显示/排序
     *（`sortCandidatesByExpiry` 把非有限值排最后）。
     *
     * ⚠️ **只读**：不改拒绝表、不写缓存、不落盘。
     */
    describeExpiryOrder(signal?: AbortSignal): Promise<Record<string, number>>;
    /**
     * 组装给设置面板的目录（**只读、零余额查询**，规格 §8.3）。
     *
     * ⚠️⚠️ **不得调用 `expiryProbe` / `resolveModelInfo`** —— 面板一打开就会对每个
     * 渠道打一次上游请求；而本端点只回答「有哪些虚拟模型、各自有哪些候选、哪些被拒」，
     * 与余额无关。实时余额仍由各渠道自己的面板负责。
     *
     * ⚠️ 「按临期排序」需要探测 ⇒ 它走**单独的** {@link describeExpiryOrder}，
     * 不在这里加参数（那会破坏本方法的零查询契约，且有专门用例断言）。
     *
     * ⚠️ 也**不得**改动拒绝表（纯读）。
     *
     * @param force - **绕过目录 TTL 缓存**（面板的「刷新」按钮用）。
     *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**不传 force**，而 `refreshCatalog` 有
     *   60 秒缓存 ⇒ 面板的「刷新」按钮实际是「读缓存」，用户在渠道侧新增/关闭模型后
     *   点刷新**看不到任何变化**，会以为聚合坏了。同时 `refreshCatalog` 的 `force`
     *   参数在**全仓零调用点**（死参数）—— 两处都是这条缺陷的一部分。
     *   ⚠️ 只有**用户显式点刷新**时才传 `true`：`listModels` 等高频路径必须继续走缓存，
     *   否则每次打开模型选择器都会重推整个目录。
     */
    describeCatalog(force?: boolean, signal?: AbortSignal): Promise<Array<{
        canonicalId: string;
        name: string;
        candidates: Array<{
            provider: string;
            realId: string;
            realName: string;
            price: number;
            viaPatch: boolean;
            rejected: boolean;
        }>;
    }>>;
    /**
     * 拒绝表的**内容指纹**（参与缓存键，见 `candidatesFor`）。
     *
     * 只对「哪些候选被拒」这件事取指纹 —— 与键的**顺序**无关（同一集合的不同书写
     * 顺序是同一张表，不该导致缓存失效）。用排序后的拼接而非 JSON.stringify，
     * 正是为了避开键顺序的影响。
     */
    private rejectionFingerprint;
    /**
     * 重新推导虚拟模型表（**带 TTL 缓存**，理由见 {@link AGGREGATE_CATALOG_TTL_MS}）。
     *
     * ⚠️ 逐个渠道 `try/catch`：某一个渠道目录读取失败**不得**让整个聚合目录变空
     * （那会让用户在别的渠道都正常时突然看不到任何模型）。
     *
     * @param force - 绕过缓存（设置页手动刷新用）。
     */
    refreshCatalog(force?: boolean, signal?: AbortSignal): Promise<VirtualModel[]>;
    /**
     * 若聚合 provider 处于「整个已关闭」态，则把**新增的**虚拟模型补进黑名单。
     *
     * ⚠️ 详见 {@link refreshCatalog} 末尾的长注释：这是为了弥补宿主
     * 「一键关闭写快照」与「聚合目录动态推导」之间的语义缺口。
     *
     * @param previousIds - **上一次**推导出的全量目录（含 `auto`）——
     *   用它判断「用户关的是整个 provider」而不是逐个关了某几个模型。
     */
    private maintainProviderClosedState;
    /**
     * 参与聚合的渠道 id 白名单 —— **只含本插件注册的渠道**。
     *
     * ## ⚠️ 为什么必须是白名单，不能用 `listProviders()`
     *
     * 初版直接 `ctx.llm.listProviders()` 并注释成「本插件注册的全部渠道」，但那个 API
     * 返回的是**宿主全部**存活路由 —— 它会纳入 `deepseek-account`、`pi-ai` 等
     * **别的插件**的 provider（真实缺陷，全分支终审 I1）。后果：
     *
     * 1. **广告出无法路由的虚拟模型**：那些渠道的临期折算没接入（`createExpiryProbe`
     *    只接了 buddy / workbuddy / loomy / codearts / zcode），一律折算成 `UNUSABLE`
     *    ⇒ 它们的虚拟模型**永远没有可用候选**。用户选中后拿到的是
     *    「没有任何可用候选（渠道被关闭、模型被关、或所有渠道都无可用账号）」——
     *    把「该渠道尚未接入」**谎报成「你没登录」**，正是本仓库反复修的误导性报错。
     * 2. **跨渠道归一被污染**：宿主自带 provider 的模型会被并进聚合目录
     *    （实测 `deepseek-account:deepseek-flash` 与 `qoder:dfmodel` 会被合并成同一个
     *    虚拟模型），使「跨渠道归一」把**非本插件渠道**也算成候选。
     *
     * ⚠️ 用字面量而非 import 各 `product.ts` 的常量：那要引入 12 个模块，显著加重本文件
     * 的依赖；而这些 id 是**稳定契约**（`index.ts` 的 `modelAdapters` 表同样用字面量）。
     * 新增 provider 时**两处都要加**（与 `modelAdapters` 同一约定）。
     */
    private static readonly AGGREGATE_CHANNELS;
    /**
     * 本插件注册的渠道 id（`aggregate` 与 `jet-hub-auto` 自身除外）。
     *
     * ⚠️ 先取 `listProviders()` 的**存活路由**再与白名单取交集：这样宿主没装载的渠道
     * 不会进目录（否则会广告出连适配器都没有的模型），同时**排除**别的插件的 provider。
     */
    private providerIds;
    /** 对外播报虚拟模型（含 `auto`），**套用户黑名单**。 */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套黑名单**的全量目录 —— 设置页要用它渲染开关。
     *
     * ⚠️ 与其余 14 个适配器的同名方法同约定：被用户关闭的模型也必须出现在这里，
     * 否则用户在设置页**连开关都摸不着**（`jet-hub-rpc.ts` 对 `model.list` 的
     * 注释记录了该缺陷）。
     * ⚠️ 必须是**同步**方法（`jet-hub-rpc.ts` 的 `ModelCatalogSource` 契约要求），
     * 故只读上一次推导结果（由 {@link listModels} 刷新）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /** `auto` 的元数据。 */
    private autoModelInfo;
    /** 虚拟模型的展示名。
     *
     * ⚠️ **不加「（单渠道）」之类的后缀**（与 brief 初版的 `nameOf` 不同）：
     * 设计文档 §12.1（`2026-10-06-aggregate-provider-design.md:669-673`）把新 provider
     * 定成「目录展示规范名 + 运行期渠道后缀」**单一形态**，并逐字写死三处的名字都是
     * 规范名（`listModels` / `resolveModel` → `DeepSeek V4.1 Flash`；`prepareCall`
     * → `DeepSeek V4.1 Flash · buddy`）。加后缀会让选择器与服务端目录名不一致，
     * 且 `prepareCall` 会拼出 `…（单渠道） · buddy` 这类双重后缀。
     * 「有没有冗余渠道」是**设置页**的信息（§7.3：按厂商分组、组内按候选渠道数降序、
     * 展开看逐条候选），不该混进模型展示名。
     */
    private nameOf;
    /**
     * 解析某个虚拟模型的能力元数据。
     *
     * ⚠️ `provider`/`id` 必须**按入参回填**（多虚拟模型下不能硬编码）：DSH 的
     * `normalizeModelInfo` 逐字校验，不符即 `INVALID_MODEL_INFO`。
     * ⚠️ `inputModalities` 恒含 `image`：聚合是整池，池里有能看图的渠道，如实声明；
     * 「这次选中的渠道收不收得了图」由分发阶段改道保证。
     * ⚠️ **档位声明规范化档位的并集**（不是候选集交集）—— 理由见下方
     * {@link aggregateReasoningInfo} 的注释。
     */
    /**
     * 解析一个虚拟模型。
     *
     * ⚠️ `signal` 是**本适配器自己加的可选第三参**（`LlmAdapter` 契约只要求前两个）——
     *    `prepareCall` 拿得到 signal（它是第三参），把它透传到目录读取，
     *    否则真实请求路径的取消**不生效**（见 `ensureCatalog` 的长注释）。
     *    ⚠️ DSH 运行时直接调本方法时**不传**第三参，那是正常的（缓存命中时无需取消）。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 目录为空时先推导一次（避免 resolveModel 在 listModels 之前被调用时找不到模型）。
     *
     * ⚠️⚠️ **必须接收并透传 `signal`**（真实缺陷，独立审计实测证伪）：
     *   本方法原先调 `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**
     *  （`prepareCall` → `resolveModel` → 本方法）的中止**不生效** ——
     *   实测「取消于 50ms 仍跑满 312ms 的 `listModels` 才抛错」。
     *   此前只有 `describeCatalog`（面板路径）串了 signal，故 `refreshCatalog`
     *   自己的中止逃逸是对的，但**调用它的真实路径拿不到取消信号**。
     */
    private ensureCatalog;
    /** 当前的临期探针：注入优先，否则保守返回 UNUSABLE。 */
    private expiryProbe;
    /**
     * 绑定「本次候选序」到一次分发。
     *
     * ⚠️ 候选序必须在**这里**算好（`prepareCall` 是异步的）：返回的 `stream` 闭包
     * 契约是**同步返回 AsyncIterable**（`PreparedAdapterCall`），闭包里拿不到
     * `await` 的机会 ⇒ 临期折算、档位表都得在这之前备齐。
     */
    prepareCall(_provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 构造本次请求的候选序（临期升序 → 倍率升序），并备好每条的档位表。
     *
     * ⚠️ **带按虚拟模型的 TTL 缓存**（规格 §9）—— 否则每次 `prepareCall` 都要对每个
     * 候选渠道重跑一次上游余额查询（见 {@link choiceCache} 的长注释）。
     */
    private candidatesFor;
    /**
     * 取目标模型的两项能力：**思考档位 id** 与**是否收得了图片**。
     *
     * ⚠️ 两项**共用同一次 `resolveModelInfo` 调用** —— 不额外发请求。这是把图片
     * 能力做成「顺带取回」而不是「另查一遍」的原因（选型路径上每次请求都会走这里，
     * 多一次解析就是多一次上游交互）。
     *
     * ⚠️ 失败时按**保守**方向回落：档位为空（不下发该字段）、图片为 `false`
     * （不把它当带图候选）。理由见 {@link DispatchTarget.imageCapable}。
     */
    private capabilityOf;
    /**
     * 按候选序**逐个尝试**，成功即返回；全部失败则抛最后一个错误。
     *
     * ## 为什么必须自己实现失败切换
     *
     * DSH 层没有跨 provider 重试：`dsh-llm-retry` 的 `retryStateKey(provider, policyKey)`
     * 只重试**同一** provider/model。故跨渠道切换只能在这里做。
     *
     * ## 为什么 `catch` 要包在**迭代过程**外层
     *
     * 生产路径只走 `prepareCall` 返回的 `call.stream`，而真实错误发生在**迭代
     * 过程中**（dsh-llm 的 `iterator.next()`），不是 `prepareCall` 自己抛的
     * ⇒ `try` 必须包住 `for await`。
     *
     * ## ⚠️⚠️ 只在「一个 chunk 都还没产出」时才能切换（本实现的关键约束）
     *
     * 已 `yield` 出去的内容**收不回来**。若某个候选先吐了「答案是……」然后中途失败，
     * 我们再切到下一个候选，用户看到的是：
     *
     * ```
     * 答案是……答案是 42。
     *      ↑ A 的半截        ↑ B 的完整答案
     * ```
     *
     * 这是**两段拼接的畸形回答**，比「半截 + 报错」严重得多 —— 前者看起来像一句
     * 正常但奇怪的话，用户会当成模型的问题；后者至少明确告诉用户失败了。
     * 本仓库对「静默降级」有明确红线（反复修过的那类缺陷），而拼接畸形内容更甚。
     *
     * ⇒ 规则：**该候选只要产出过「可见内容」，其后任何失败都直接向上抛**，不再尝试下一个。
     * 「切换」只发生在「尚未产出任何可见内容」的失败上（连接失败、认证失败、上游立刻
     * 返回错误 —— 这些恰好是跨渠道切换真正有价值的情形）。
     *
     * ## ⚠️ 为什么判据是「可见内容」而不是「任何 chunk」（Task 6 复审 M23）
     *
     * 初版用「产出过任何 chunk」作判据，于是候选**只吐了 `block-start` / `usage`
     * 这类元数据帧**就失败时，也会放弃切换 —— 那是**过度保守**，白白丢掉一次
     * 本可成功的切换机会。
     *
     * 而只产出元数据帧时切换是**安全**的（实测 `BlockAssembler` 的语义）：
     * - `block-start` 是**幂等**的（`if (!this.partials.has(chunk.index))`）——
     *   下一个候选重发同 index 的 `block-start` 不会产生重复块；
     * - `usage` 是**覆盖**语义（`this._usage = chunk.usage`）—— 后到的会顶掉前一个；
     * - 两者都**不含用户可见的正文**。
     *
     * ⇒ 判据：只有 `text` / `reasoning` / `image` / `tool-call` / `tool-result`
     * 以及 `*-delta` / `block-end` 算「可见内容」；`block-start` 与 `usage` 不算。
     * ⚠️ 未知类型一律**算可见内容**（保守方向：宁可少切换，不可拼接畸形回答）。
     *
     * ## 档位必须逐候选翻译
     *
     * 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
     * （如给只声明 `enabled` 的模型发 `xhigh`）。原样转发会被 DSH 按 id 严格校验
     * 拦下 `UNSUPPORTED_REASONING_EFFORT`。故复用仓库既有的
     * {@link translateReasoningEffort}：不可表达时**不下发该字段**而非抛错。
     */
    private dispatch;
    /** 把请求转发给一个候选，按目标档位表翻译 `reasoningEffort`。 */
    private streamThrough;
    /** 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
    stream(): AsyncIterable<StreamChunk>;
}
/**
 * 候选循环的**尝试上限**。
 *
 * ⚠️ **不得写死常量**（issue 明确记录：那个参数在 contributor 的实现里调整过 4 次
 * 才固化）。写死一个偏小的值会让**末位候选永远轮不到** —— 等于「加了渠道但没生效」。
 */
export declare function maxAttemptsFor(models: readonly VirtualModel[]): number;
/**
 * 聚合模型的**档位声明** —— 规范化档位的**并集**（不是候选集交集）。
 *
 * ## 为什么是并集而不是交集（真实数据修正）
 *
 * 初版设计写的是「取候选集的能力交集」。**该口径在真实数据下是错的**：各渠道的
 * 档位命名空间彼此几乎不相交 ——
 *
 * | 渠道 | 档位 id |
 * |---|---|
 * | codearts | `on` / `off`（只有开关，注释明确「不臆造强度阶梯」） |
 * | buddy / workbuddy | `low` / `high` / `max`（**逐模型不同**） |
 * | zcode | `low` / `high` / `max` |
 * | loomy | `none` / `low` / `medium` / `high` / `xhigh` |
 * | trae | `light` / `high` / `extra_high`（**私有名**） |
 * | lobsterai | `off` / `high` / `xhigh` |
 * | raccoon | `on` / `off` |
 *
 * `deepseek-v4.1-flash` 跨 buddy + codearts + cline ⇒ **交集为空**。而空档位的后果
 * 本仓库有明确记录（`opencode-adapter.ts`：「档位为空时**不声明**本字段，声明空数组
 * 会让 UI 出现一个没有任何档位的空选择器」）⇒ 取交集会让**聚合模型的档位选择器
 * 全部消失**，与本功能目标相反。
 *
 * ⇒ 声明规范化并集，转发时由 `translateReasoningEffort` 逐候选翻译（Task 6）：
 * `exact` 原样、`mapped` 就近同族（同距取更强）、`unexpressible`/`unknown` 时
 * **不下发该字段**让上游走自己的默认。
 *
 * ## 展示名用官方中文
 *
 * DSH 客户端**直接渲染 `efforts[].name`**（不本地化、不查字典）⇒ 必须给中文。
 * 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）：
 * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
 *
 * ⚠️ `unknown` 档位（`CANONICAL_REASONING_EFFORTS` 里没有的）**回退为 id 本身** ——
 * 宁可显示英文原值，也不猜一个可能错译的中文（与 `opencode-adapter` 同取向）。
 */
export declare function aggregateReasoningInfo(): LlmModelReasoningInfo;
/** 在 `ctx.llm` 上注册聚合路由（幂等）。 */
export declare function registerAggregateLlm(ctx: Context, options: AggregateAdapterOptions): AggregateAdapter;
//# sourceMappingURL=aggregate-adapter.d.ts.map