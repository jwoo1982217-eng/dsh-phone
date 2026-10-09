/**
 * 限流标记重测（retest）与重置（reset）。
 *
 * 背景：账号卡片上的「限额重置」只是**一次 429 事件的快照**——它记录的是
 * 服务端当时给出的"预计恢复时间"，而不是该账号此刻的真实可用性。服务端
 * 常在重置时间到达前提前放行，于是出现「显示超额使用但发消息正常回复」。
 * 本模块让用户能主动验证并清理这些过期标记。
 *
 * 两个动作，语义严格区分：
 *
 * - **重测（retest）**：对每个带限流标记的模型**真实发一次最小对话请求**。
 *   只有请求正常完成才清除该模型的标记；仍被拒绝（限流）则保留标记，并把
 *   原因回传给 UI。这样标记始终反映"最近一次实测结果"。
 * - **重置（reset）**：不做任何网络请求，直接清除标记。用于用户已知额度
 *   已恢复、只想清掉显示的情况。
 *
 * 与 e2e 探针（tests/e2e/buddy-ratelimit-probe.e2e.spec.ts）的关系：两者都
 * 发真实请求判定限流，但 e2e 用于人工排查、本模块供设置页按钮调用。为避免
 * 逻辑漂移，这里直接复用**真实适配器**（BuddyAdapter / CodeArtsAdapter）走
 * 完整请求链路，而不是各自手写 HTTP。
 *
 * 两点关键设计：
 *
 * 1. **不传 accountPool 给适配器**。适配器只在拿到 accountPool 时才会切换
 *    账号、写限流标记；探测必须只针对**指定账号**、且不能产生副作用，否则
 *    "重测 A 账号"会顺带污染其他账号的标记。
 * 2. **停用账号也要能重测**。用户明确要求这一点，因此凭据解析走
 *    `resolveCredentialForAccount`（按 id，不检查 enabled），而非
 *    `getAvailableAccount`（自动选择，只认启用账号）。
 */
import type { BuddyCredential } from './buddy.js';
import type { LobsteraiCredential } from './lobsterai.js';
import type { QoderCredential } from './qoder.js';
import type { ClineCredential } from './cline.js';
import type { ZcodeCredential } from './zcode.js';
import type { TraeCredential } from './trae.js';
import type { GeminiCredential } from './gemini.js';
import type { CodeArtsCredential, ProbeAccountResult, ProbeModelResult, ProviderAccountEntry, RpcResetResponse, RpcRetestResponse, RpcTestAccountResponse } from './types.js';
/**
 * 探测可能涉及的凭据联合类型。
 *
 * 提为具名别名而非在各处重复多元联合：新增 provider 时只需改这一处，
 * 避免签名与实现漂移（本文件已**四次**因「分派表没跟上新增 provider」出缺陷）。
 */
type ProbeCredential = CodeArtsCredential | BuddyCredential | LobsteraiCredential | QoderCredential | ClineCredential | ZcodeCredential | TraeCredential | GeminiCredential;
/**
 * 重测/重置所需的最小账号池接口。
 *
 * 只声明实际用到的方法，使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface ProbePool {
    /** 按 id 查找账号（含已停用）。 */
    findAccount(id: string): ProviderAccountEntry | undefined;
    /** 列出某 provider 的全部账号（含已停用）。 */
    listAccountsByProvider(provider: string): ProviderAccountEntry[];
    /** 按 id 解析凭据（不检查 enabled）。 */
    resolveCredentialForAccount(id: string): Promise<ProbeCredential | undefined>;
    /** 清除限流标记；modelIds 省略时清除全部。返回清除条数。 */
    clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number>;
    /**
     * 写入/更新某账号某模型的限流重置时刻。
     *
     * [patch-codearts-probe-ratelimit] 重测发现「仍受限」时需要它把上游给的
     * **新**时刻写回，否则存储停在旧值、UI 不再显示限流。
     */
    updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void>;
}
/** 探测依赖注入点（测试可覆盖）。 */
export interface ProbeDeps {
    /** 发起探测请求的函数；默认使用真实适配器。 */
    probe?: (entry: ProviderAccountEntry, modelId: string) => Promise<ProbeModelResult>;
    /** 单次探测超时；默认 {@link PROBE_TIMEOUT_MS}。 */
    timeoutMs?: number;
}
/**
 * 重测单个账号：对该账号每个带限流标记的模型发一次真实请求，
 * 正常返回的模型清除标记。
 */
export declare function retestAccount(pool: ProbePool, accountId: string, deps?: ProbeDeps): Promise<ProbeAccountResult>;
/**
 * 重测某 provider 下的**全部**账号（含已停用账号）。
 *
 * 顺序执行而非并发：探测会真实消耗模型额度，并发发起容易触发真正想验证的
 * 限流，反而得到假阳性。
 */
export declare function retestAllAccounts(pool: ProbePool, provider: string, deps?: ProbeDeps): Promise<RpcRetestResponse>;
/**
 * 挑一个「测试」要用的模型 id（纯函数，无 IO —— 便于单测覆盖优先级）。
 *
 * 优先级：调用方显式指定 > 已有的限流标记 > 全量目录第一个。
 *
 * ## 为什么标记优先于目录
 *
 * 用户点「测试」最常见的动机是「这个账号显示着限流标记，它到底恢复了没有」，
 * 而那个标记指向的模型正是他关心的。取目录第一个（如 CodeBuddy 的
 * `glm-5.2`）会测一个与标记无关的模型 —— 结果既不能清标记、也不能解释标记。
 *
 * ## 为什么没有目录时返回空串而不是猜一个
 *
 * 猜错的模型名会得到 404，把「账号不可用」与「模型名不对」两件事混成同一条
 * 报错，用户据此会去做完全错误的动作（重新登录）。故调用方拿到空串时应
 * **如实报错**，而不是发出去。
 *
 * @param catalogIds 该 provider 的全量模型目录（调用方按需读取，可为空数组）。
 */
export declare function pickTestModel(entry: ProviderAccountEntry, catalogIds: readonly string[], requested?: string): string;
/**
 * 「测试」单个账号：**无条件**真发一次请求，且不做任何存储写入。
 *
 * ## 与 {@link retestAccount} 的区别（这是本函数存在的全部理由）
 *
 * `retestAccount` 的触发条件是 `Object.keys(entry.modelRateLimits ?? {})`：
 * 账号没有限流标记时它在 `modelIds.length === 0` 处**提前返回，一次请求都不发**。
 * 于是「这个账号到底还能不能用」在**没有历史 429** 时没有任何手动探活入口 ——
 * 用户点「重测」看到瞬间返回，会以为按钮失灵（真实报障：
 * 「重测按钮你确认过会发请求吗，为什么响应这么快？」）。
 *
 * `testAccount` 不看标记、不下发清除指令、不写回重置时刻：它只回答
 * 「这一发请求成功了吗」。故它**不需要** `modelRateLimits` 存在，
 * 也不改变任何存储状态 —— 这一点与重测是硬性区别，不可为了复用而合并。
 *
 * @param modelId 要测的模型 id，由 {@link pickTestModel} 决定。
 */
export declare function testAccount(pool: ProbePool, accountId: string, modelId: string, deps?: ProbeDeps): Promise<RpcTestAccountResponse>;
/**
 * 重置单个账号：不测试，直接清除该账号的全部限流标记。
 * @returns 清除的标记条数与涉及的账号数（此处恒为 0 或 1）。
 */
export declare function resetAccount(pool: ProbePool, accountId: string): Promise<RpcResetResponse>;
/** 重置某 provider 下全部账号（含已停用账号）的限流标记。 */
export declare function resetAllAccounts(pool: ProbePool, provider: string): Promise<RpcResetResponse>;
export {};
//# sourceMappingURL=account-probe.d.ts.map