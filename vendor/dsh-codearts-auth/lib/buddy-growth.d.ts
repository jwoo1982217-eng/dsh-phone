import { type BuddyCredential } from './buddy.js';
import type { ClaimOutcome } from './credits.js';
import type { BuddyProduct } from './product.js';
import type { ProviderAccountEntry, RpcBuddyGrowthAccountResult } from './types.js';
/** 任务列表查询端点（v2 主、v1 回退，二者都 200）。 */
export declare const GROWTH_TASKS_PATHS: readonly ["/v2/activity/growth/tasks", "/activity/growth/tasks"];
/** 任务接取端点。 */
export declare const GROWTH_TASK_ACCEPT_PATH = "/activity/growth/tasks/accept";
/** 旅行状态查询端点。 */
export declare const GROWTH_TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
/** 旅行领奖端点。 */
export declare const GROWTH_TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";
/** 首个 Buddy 解锁端点（一次性动作，默认不执行）。 */
export declare const GROWTH_FIRST_BUDDY_PATH = "/activity/growth/buddy/first";
/** 盲盒端点（消耗 energy，默认不执行）。 */
export declare const GROWTH_BLIND_BOX_PATH = "/v2/activity/growth/buddy/open";
/** 抽奖端点（消耗 lottery 次数，默认不执行）。 */
export declare const GROWTH_LOTTERY_PATH = "/v2/activity/growth/lottery/draw";
/**
 * 可自动接取的任务白名单（task_code）。
 *
 * 只接取**纯使用即可达成**、且奖励为普通 credit/energy 的任务。限定款
 * （`reward_buddy:true`、需下载桌面端/升级主题解锁的盲盒 Buddy）**不**进默认白名单，
 * 避免误触发一次性解锁动作。判据与 WorkDaddy `AUTOMATABLE_TASK_CODES` 对齐。
 */
export declare const AUTOMATABLE_TASK_CODES: Set<string>;
/**
 * 一条判据事件。`eventCode` 之后的键名由服务端判据定义，随任务族变化，
 * 故取 `Record<string, unknown>` 而非穷举。
 */
export type GrowthEvent = {
    eventCode: string;
} & Record<string, unknown>;
/** 成长端点响应信封。`code === 0` 为业务成功。 */
export interface GrowthEnvelope {
    code?: number;
    msg?: string;
    data?: unknown;
}
/** 两族任务合并后的任务项。缺 `accept_status` 即为「养虾等级」族。 */
export interface GrowthTaskItem {
    task_code?: string;
    /** 等级族的码字段。 */
    code?: string;
    accept_status?: string;
    /** 等级族的 `status`（仅 `available` 可做）。 */
    status?: string;
    progress?: {
        current?: number;
        target?: number;
    };
}
/** 成长中心返回的数据体。 */
export interface GrowthTaskData {
    tasks?: GrowthTaskItem[];
}
/** 单项进度。 */
export interface GrowthProgress {
    current: number;
    target: number;
}
/** 成长任务查询结果。 */
export interface GrowthTaskQuery {
    /** 查询是否成功（端点可达且 code 0）。 */
    ok: boolean;
    /** 白名单内且按 `includeInProgress` 筛出的任务码。 */
    codes: string[];
    /** 返回的任务总数。 */
    total: number;
    /**
     * `ok:false` 时的失败原因。
     *
     * ⚠️ 必须带上（不能只说「查询失败」）：下游 `collectBuddyGrowth` 靠
     * **消息文本**判定僵尸账号（401/403 → 「凭据已失效」），原因丢失会让
     * 「请重新登录」被显示成「没有可做任务」。
     */
    message?: string;
    /** 仅 `includeInProgress` 时给出：仍需 accept 的 task_code。 */
    toAccept?: Set<string>;
    /** 仅 `includeInProgress` 时给出：每个任务码的进度。 */
    progressByCode?: Record<string, GrowthProgress>;
}
/** {@link fetchGrowthTaskCodes} 的选项。 */
export interface GrowthTaskQueryOptions {
    /** 纳入 in_progress（未完成）任务，供 runTasks 档补发完成动作。 */
    includeInProgress?: boolean;
}
/** {@link claimAllGrowth} 的选项。 */
export interface GrowthClaimOptions {
    /**
     * 是否追加有代价/一次性动作（盲盒 / 抽奖 / 首Buddy 解锁）。
     * 默认 `false`：只做任务接取 + 旅行领奖（低副作用）。
     */
    runExotic?: boolean;
}
/** 真实专家（来自专家市场）。判据要求 `expertId` 是平台真实 id，编造不计数。 */
export interface MarketExpert {
    expertId: string;
    expertType: string;
    name: string;
    title: string;
    version?: string;
    industryId?: string;
}
/** 事件上报结果。 */
export interface ReportResult {
    ok: boolean;
    /** 实际发出的事件条数。 */
    reported: number;
    message: string;
}
/** 领奖结果。 */
export interface ClaimResult {
    ok: boolean;
    /** `false` 表示已领过或无可领。 */
    claimed: boolean;
    credit: number;
    message: string;
}
/** 完成动作的映射项。 */
export interface GrowthTaskSpec {
    /** 动作类型。 */
    kind: 'canvas' | 'chat' | 'canvasThenChat' | 'webClick' | 'appearance' | 'skillFresh';
    /** 展示名。 */
    label: string;
}
/** {@link runGrowthTaskCompletions} 的选项。 */
export interface GrowthCompletionOptions {
    /**
     * 单账号时间预算（毫秒）。缺省 10 分钟。传 0 或负数表示不限（供本地排障）。
     * 非有限值（NaN / Infinity）归为「不限」并留痕：`Number('abc')` 得 NaN，
     * 而 `NaN > 0` 为 false，若不显式区分会静默变成不限时，恰是本预算要防的情况。
     */
    budgetMs?: number;
}
/** {@link runGrowthTaskCompletions} 的单项结果。 */
export interface GrowthTaskResult {
    taskCode: string;
    ok: boolean;
    message: string;
    /** 判据在服务端推不动、如实归为「需客户端」而非「失败」。 */
    clientOnly?: boolean;
}
/** {@link runGrowthTaskCompletions} 的汇总。 */
export interface GrowthCompletionReport {
    ok: boolean;
    results: GrowthTaskResult[];
    completed: number;
    clientOnly: number;
    failed: number;
    claimedCount: number;
    claimedCredit: number;
    /** 时间预算用尽、本轮提前收住。 */
    timedOut: boolean;
    message?: string;
}
/** 完成动作构造器的额外参数。 */
export interface EventSequenceOptions {
    conversationId?: string;
    requestId?: string;
    model?: string;
    /** 真实专家；缺省时专家类回退通用对话链。 */
    expert?: MarketExpert;
    templateId?: string;
    templateName?: string;
}
/**
 * `/v2/chat/completions` 的 `X-Conversation-*` 三头（**逐请求一次性 id**）。
 *
 * ## ⚠️ 这三枚头**不是**准入必需 —— 但那是**按账号**的（2026-10-16，IKM7SG 结清）
 *
 * 原先以为「三头缺一即 400/11128 `conversation id missing`」，PR #104 据此补了
 * 主链路。复测（真实凭据、约 90 次请求）**在该账号上**推翻了它：
 * - 逐枚消融适配器构造的 **14 枚头，全部仍 200**（含这三枚）；
 * - 逐级剥到「连 UA / 鉴权头 / 身份头都不发」仍 **200**；
 * - 6 模型 × 4 请求形状 = 48 格，三头与响应状态**零关联**；
 * - `conversation id missing` 这句 msg **零次复现**（同批复现了
 *   `first message is not system prompt` 与 `Illegal API invocation from an
 *   unapproved channel` 两句，证明这批请求确实打到了能报 11128 的网关）。
 *
 * ⚠️⚠️ **但 IKM7SG 用本仓库自己的 e2e（只换 `WB_REF`）证明这是「按账号」的**：
 * 在**特定账号**（实测 `66E05E7C`）上，三头**缺任一枚即 400/11128**；
 * 在**多数账号**（实测 `D87606B1`）上则非必需。
 * ⇒ 准确表述是「**在多数账号上不是；在特定账号上是**」。
 * 完整对照表与字段级穷举见 `src/buddy-adapter.ts` 内 `send()` 的对应注释。
 *
 * 上游对这三枚头的真实用法是**回显**：实测回包 `"id"` 的前缀 3/3 命中所发值，
 * 填 `abc-123` 时上游直接回 `"id":"abc-123"`。⚠️ 但 IKM7SG 实测到**在那个账号上
 * 「回显」与「准入判据」并存** ⇒ 「只当种子、不作判据」这句**对多数账号成立、
 * 对那个账号不成立**。
 *
 * ## ⇒ 那为什么还要发（理由已按 IKM7SG 更新）
 * 1. **对「要求三头」的账号是硬需求**（三枚齐全才 200）—— 不再是「反正无害」；
 * 2. 对多数账号无害（无三头也 200）；
 * 3. 官方客户端确实带这三枚，补上让后台归因与上游行为对齐；
 * 4. **三条出站路径形态统一**，将来上游若真的收紧校验，改一处即可。
 * ⚠️ ⇒ **删任何一枚都是错的**：IKM7SG 那批 14/14 消融数据**不能**用来论证
 *「可以删」—— 它只在**不要求三头**的账号上取得。
 *
 * ⚠️ 这也**纠正了 PR #104 里「buddy-growth 早已带一枚 ⇒ 属补一致性缺口」的
 * 论证**：那条论证本身是对的，但它恰恰是「一枚就够」的反证 —— 与
 * 「缺一即 400」矛盾。结论保留（三头照发），**理由按 IKM7SG 更新为
 * 「对『要求三头』的账号是硬需求 + 形态一致」**。
 *
 * ## ⚠️ 三头是逐请求 id，不是会话身份
 * 官方 `X-Conversation-ID = context.id`（**会话稳定**），本实现逐请求新生成
 * ⇒ 语义相反。实测上游不做跨轮状态机，故当前无害。
 * 完整对照表见 `src/buddy-adapter.ts` 内 `send()` 的对应注释。
 *
 * ## ⚠️ 两条旁路的可达性（成本登记）
 * - `chatRealSession`：**活路径** —— `skill_1` / `Expert_lighthouse` /
 *   通用真实会话，经「一键领取积分」触发（`runGrowthTaskCompletions` 内）。
 * - `keepStreakActive`（保连胜）：⚠️ **零生产调用方**（2026-10-16 全仓 grep 确认，
 *   `jet-hub-rpc` / `provider-credits` 只 import `collectBuddyGrowth`）。
 *   本次给它补三头 + 加守卫是**为将来接入时形态不漂移**，不代表它当前在线上跑。
 *
 * @param conversationId 逐请求生成的 32 位无横线 uuid
 */
export declare function conversationHeaders(conversationId: string): Record<string, string>;
/** 生成 `/v2/chat/completions` 用的逐请求 conversation id（32 位无横线 uuid）。 */
export declare function newConversationId(): string;
/**
 * 查询账号的成长任务列表，筛出「白名单且尚未接取/完成」的任务码。
 * 返回 `ok:false`（而非空 `codes`）表示查询失败 —— 让调用方区分「查不到」与「没有可接任务」。
 */
export declare function fetchGrowthTaskCodes(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, options?: GrowthTaskQueryOptions): Promise<GrowthTaskQuery>;
/**
 * 执行**每日成长领取**（低副作用核心）。
 *
 * 步骤（串行，防风控）：
 *   1. 拉任务列表，接取所有「白名单且 not_accepted」的任务；
 *   2. 旅行领奖 —— 无未领旅行时归类为 `already-claimed`。
 *
 * 返回单个 {@link ClaimOutcome}：`kind` 取**本次真正到账**的口径 ——
 * 只要接取或领奖**任一成功**且到账 credit/energy > 0 计 `claimed`（接取本身
 * 不加积分，credit 取旅行领奖的 `reward_credit`；接取成功但无旅行奖时 credit=0
 * 仍计 `claimed`，因为已把可完成任务推进到 in_progress）。全部无对象计
 * `already-claimed`；网络/解析失败计 `failed`。
 *
 * ⚠️ `runExotic`（默认 `false`）开启时才追加盲盒/抽奖/首Buddy 的**有代价/一次性**
 * 动作。默认路径只做接取+旅行领奖，避免误触消耗 energy / 一次性解锁。
 */
export declare function claimAllGrowth(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, options?: GrowthClaimOptions): Promise<ClaimOutcome>;
/** 保连胜：向 buddy-adapter 同款 chat completions 端点发一条「你好」，
 * 触发一次「活跃」记录以维持 `streak_days`（签到积分倍数基数）。
 *
 * 不新建通道 —— 复用 buddy 既有 `POST ${product.endpoint}/v2/chat/completions`
 * 端点与 `product.userAgent`（归因账单用），只改 body。连胜断一天签到基数归零，
 * 故这是本机唯一还能 API 化的积分相关动作（做任务本身必须客户端真操作）。
 * 幂等：重复调用只是多发一次对话，不重复计积分（活跃按天去重，服务端保证）。
 * 低频：串行 + 单账号单条，避免触发风控。
 *
 * ⚠️ **本文件是第三条直连腾讯端点的旁路，不经 `BuddyAdapter`，因此不过
 * `tencent-fingerprint` 的内容级风控改写**（同一文件里另一处发 chat 的
 * `fetchRealRequestId` 同理）。当前**安全**，因为两处的请求体都是**写死的短消息**
 * （「你好」/「1+1等于几」），既不含风控指纹、也没有 assistant 历史。
 * ⚠️ 但这条安全性**依赖「请求体写死」这个易碎前提**：一旦将来改成携带会话历史
 * 或把用户内容拼进来，就必须同时接上 `rewriteTencentContentFingerprints`
 * （见 `src/openai-gateway/tencent-fingerprint.ts`），否则会静默变成一个
 * 未改写的入口 —— 而那种失败的表象是「整轮 400/11128」，极难归因。
 */
export declare function keepStreakActive(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<{
    ok: boolean;
    message: string;
}>;
/** 查询当前连胜天数与今日是否已活跃。端点基址随 `product.endpoint`。 */
export declare function fetchStreakStatus(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<{
    ok: boolean;
    days: number;
    activeToday: boolean;
}>;
/**
 * 建一次画布会话（`create_canvas` 的前置动作，副作用最小档）。
 *
 * ⚠️ **只带极简头**（Authorization + Content-Type + User-Agent，与 curl 实证
 * 200 的那套一致）。`/console/as/` 会话族端点对 `growthHeaders` 的多余身份头
 * （`X-Client-Platform:web` / `X-Domain` / `X-Product` / `X-Product-Code`）做
 * 鉴权收紧会回 401，故不能复用 `growthHeaders`——这与成长中心族端点要全套头
 * 的特性相反。
 */
export declare function createCanvasTask(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<{
    ok: boolean;
    conversationId?: string;
    message: string;
}>;
/**
 * 各「API 可达」成长任务的**完成动作**映射。
 *
 * 与 {@link AUTOMATABLE_TASK_CODES}（可接取）区分：接取把任务置 `in_progress`，
 * **积分在完成动作后由服务端发放**。本表只列能纯 API 完成的 task_code；
 * 微信服务号订阅（wb_wechat_oa_subscribe_task）等仅客户端可完成的不在这里（CLIENT_ONLY 降级）。
 *
 * 动作类型（按副作用递增）：
 * - `canvas`：建一条画布会话（`create_canvas`）。
 * - `chat`：发对话/事件链（`playbook_prompt`/`chat_5`/`expert_5`/`template_5`…）。
 * - `canvasThenChat`：先建画布再发首条消息（`create_canvas` 的完整闭环）。
 * - `webClick`：web 域浏览器指纹单事件（`Library_read` 判据）。
 * - `appearance`：主题设置 API + 皮肤生效事件（`Hp_Appearance` 判据）。
 * - `skillFresh`：真实会话（服务端 id）+ skill_info 事件（`skill_1` 判据）。
 *
 * 每项的完成动作**可重复**（服务端按天去重/幂等），重复触发不重复计积分；
 * 风控纪律靠**串行单账号单动作 + 白名单限定**兜住。
 */
export declare const GROWTH_TASK_COMPLETION: Record<string, GrowthTaskSpec>;
/** 拉取专家市场真实专家列表（`POST /portal/operation-platform/market/expert/list`）。
 * `expert_5` / `Expert_team_use_3` 的完成判据要求 `expert_id` 是平台**真实**专家
 * （编造 id 不计数），故完成动作前必须先取真 id。
 * `expertType`：`agent`=单专家（expert_5），`team`=专家团（Expert_team_use_3）。
 */
export declare function fetchMarketExpertList(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, expertType?: 'agent' | 'team'): Promise<{
    ok: boolean;
    experts: MarketExpert[];
    message: string;
}>;
/**
 * 领取单个成长任务奖励。
 *
 * 端点实测口径（对齐网页「领取」按钮真实请求）：
 * **`POST {claimBase}/activity/growth/tasks/<task_code>/claim`** ——
 * `task_code` 放 URL 路径、**不带 `/v2` 前缀**、打 **web 域**（不是任务列表走的
 * `product.endpoint`，也不存在 `/v2/.../reward/claim` 这个路径——打它恒 400
 * `task not completed`）。响应体 `{ code:0, data:{ already_claimed, credit, energy } }`。
 * 重复领取返回 `already_claimed:true`（幂等终态，不报错）。
 */
export declare function claimGrowthTaskReward(credential: BuddyCredential, product: BuddyProduct, fetcher: typeof fetch | undefined, taskCode: string): Promise<ClaimResult>;
/**
 * 执行**全量任务完成动作**（默认路径的完整档）。
 *
 * 编排（串行，防风控）：
 *   1. 拉任务列表，筛「白名单 ∩ not_accepted ∩ GROWTH_TASK_COMPLETION 可达」；
 *   2. 接取这些任务（`accept`）；
 *   3. 逐项执行完成动作（`canvas` 建会话 / `chat` 发消息 / `canvasThenChat` 两者）；
 *   4. 扫尾补领所有「已达标未领取」的任务。
 *
 * ⚠️ 与 {@link claimAllGrowth}（只接取 + 旅行领奖，副作用最小）的区别：本函数
 * **真正执行完成动作**，会建会话 / 发消息（消耗少量 token 与活跃记录）。
 * 串行 + 单账号 + 白名单限定控制风控。
 */
export declare function runGrowthTaskCompletions(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, options?: GrowthCompletionOptions): Promise<GrowthCompletionReport>;
/**
 * 单账号的成长中心任务执行，转成 RPC 明细。
 *
 * ## ⚠️ 为什么在**本文件**而不是 `jet-hub-rpc.ts`（2026-10-08 Task 4 搬迁）
 *
 * 它是 `credits.afterClaim` 的实现，而 `afterClaim` 由 `src/provider-credits.ts`
 * 的能力表提供。留在 `jet-hub-rpc.ts` 会让那张表必须 import 它 ⇒
 * `provider-credits.ts ⇄ jet-hub-rpc.ts` **循环 import**（后者已经 import 前者）。
 * 搬到本文件后依赖是单向的：`jet-hub-rpc.ts` → `provider-credits.ts` → `buddy-growth.ts`。
 *
 * ⚠️ 搬迁是**逐字**的（函数体一行未改），只有 import 来源变了。
 *
 * 僵尸账号（凭据被外部删除 ⇒ 上游回 401/403）归 `error` 提示但**不计入 failed**：
 * 它的处置是「重新登录」，与「任务真的推不动」完全不同。签到侧已把这类账号归
 * `inactive`（`collectClaimResults` 的 `凭据未配置` 分支同义），成长侧须一致 ——
 * 否则同一个僵尸条目在两处会给出互相矛盾的判定。
 *
 * @param budgetMs 透传给 `runGrowthTaskCompletions`；`undefined` 由其取缺省 10 分钟。
 */
export declare function collectBuddyGrowth(credential: BuddyCredential, product: BuddyProduct, entry: ProviderAccountEntry, budgetMs: number | undefined, roundDeadlineAt: number | undefined): Promise<RpcBuddyGrowthAccountResult>;
//# sourceMappingURL=buddy-growth.d.ts.map