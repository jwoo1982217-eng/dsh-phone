/**
 * **Token 账本**（全 provider 的用量流水 + 渠道 × provider × 模型三维聚合）。
 *
 * ## 为什么它必须存在（issue 诉求）
 *
 * 全部适配器在流结束时都已产出 dsh-llm 的标准 `type:'usage'` chunk
 * （`TokenUsage`：`inputTokens / outputTokens / cacheReadTokens /
 * cacheWriteTokens / reasoningTokens / totalTokens`），但解析完就丢弃 ——
 * 用户无法回答「今天用了多少 token」「直连与网关各用多少」。本模块把
 * 「存下来」这一跳补上，**不改任何适配器的推理路径**。
 *
 * ## 记账点：注册收敛层（单点覆盖）
 *
 * 记账由 {@link ./llm-register-compat.ts} 的包装注册调用（每笔请求恰好一次），
 * 不碰 13 个适配器。渠道区分靠网关侧打标（`src/openai-gateway/channel.ts`）：
 * 网关请求在 `GenerateOptions` 上带 `gatewayChannelMark`，读到即 `gateway`，
 * 否则 `direct` —— **精确打标，不是差值估算**。
 *
 * ## 存储是进程内存，重启即丢（刻意，第 1 期与 cline-request-log 同决策）
 *
 * 高频写入的派生数据持久化会把每笔推理变成一次磁盘写；「本周用量」这类
 * 长周期诉求随第 2 期持久化一并做。上限 {@link TOKEN_LEDGER_LIMIT} 条，
 * 写满淘汰最旧。聚合树在读取时按需重建（条数有限，O(n) 足够快，
 * 不为省这点计算引入增量维护的双写复杂度）。
 *
 * ## ⚠️ record() **绝不抛错**：它在推理的关键路径上
 *
 * 与 `src/cline-request-log.ts` 同款约束：这里抛错会把记账失败反噬成
 * 推理失败。所有入参截断/钳制，`Object.freeze` 防止调用方修改共享对象。
 */
/** 一条请求记录。 */
export interface TokenLedgerEntry {
    /** 请求**发起**时刻（毫秒时间戳）。 */
    ts: number;
    /** 流量来自哪条通道：DSH 宿主对话 = `direct`；OpenAI 兼容网关 = `gateway`。 */
    channel: 'direct' | 'gateway';
    /** provider id（如 `codearts` / `qoder`）。 */
    provider: string;
    /** 模型 id（wire 上的 `model`）。 */
    model: string;
    /**
     * **服务本笔请求的账号**（账号池条目 id）。
     *
     * ⚠️ 第 2 期（账号维度）加入。归属口径与 cline-request-log 相同：
     * 以**实际解析出凭据的账号**为准（`resolveCredential` / 池查询回报）。
     * 取不到时为空串 —— 未知账号与「没有账号体系」不能混成一个假 id，
     * 展示层对空串整段不渲染（或归入「未归属」）。
     */
    accountId?: string;
    /**
     * 是否收到过 usage chunk。
     *
     * ⚠️ 与「token 为 0」**不是一回事**：没收到 usage（abort / 上游提前断开 /
     * 请求失败）时表格必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」
     * （`cline-request-log` 同约定）。
     */
    usageReported: boolean;
    /** 输入 token（未命中缓存的部分，dsh-llm 口径）。 */
    inputTokens: number;
    /** 输出 token（含思考 token）。 */
    outputTokens: number;
    /** 缓存命中的输入 token（缺失时省略）。 */
    cacheReadTokens?: number;
    /** 缓存写入的 token（缺失时省略）。 */
    cacheWriteTokens?: number;
    /** 思考 token（缺失时省略；已含在 outputTokens 内）。 */
    reasoningTokens?: number;
    /**
     * **首个内容块耗时**（毫秒）—— 用户口中的「首字用时」。
     *
     * 口径 = 收到**内容帧**（文本 / 思考 / 图片 / 工具调用，含各自的 delta 形态）的
     * 时刻 − 请求发起。⚠️ **刻意忽略 `block-start` / `block-end` / `usage` / `finish`
     * 等结构帧与元数据帧**：它们不代表「模型开始说话」，算进去会把首字用时记成
     * 「适配器建流的时刻」（真实缺陷，本次修复；见 `llm-register-compat.ts` 的
     * `isContentChunk`）。
     *
     * ⚠️ **与 `cline-request-log.ttftMs` 有已知分叉**（不要照着这里的措辞去断言两者
     * 一致）：Cline 那一份（`src/cline-adapter.ts` 的 `if (ttftMs === 0) ttftMs = …`）
     * 仍是「**任何** chunk 到达即计时」的旧口径，故「只有结构帧 / 只有 usage 的
     * 空响应」在两处的读数不同（本处省字段、展示为 `—`；Cline 处给出一个非 0 值）。
     * 分叉方向是**本处更严**（更贴近「首字」语义）；Cline 那份的同步属于独立改动，
     * 需连带核对其请求表的展示，本次未动。
     *
     * 0 = 整个流没有产出任何内容帧（失败 / 秒回空），展示层按「不可测」处理
     * （显示 `—`），不显示 0。
     */
    ttftMs?: number;
    /**
     * 全程耗时里**扣除首块之后**的输出速率（tok/s）。
     *
     * 口径对齐官方（`tokens-per-second.js` 抄的 DeepSeek 口径）：分子是
     * **全部输出 token（含思考）**，分母 = `durationMs − ttftMs`（首块之后
     * → 结束）。任一前提缺失（无 usage / 无首块 / 分母 ≤ 0）时**省略字段** ——
     * 不可测与 0 tok/s 是两回事。
     */
    tps?: number;
    /** 全程耗时（毫秒）。 */
    durationMs: number;
    /** 失败原因；成功行省略。 */
    error?: string;
}
/** 渠道 → provider → 账号 → 模型 聚合里模型粒度的一行。 */
export interface TokenLedgerModelRow {
    model: string;
    /** 请求数（含失败）。 */
    requests: number;
    /** 收到过 usage 的请求数（usageReported = true 的子集）。 */
    reportedRequests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /** 总处理量 = 未命中缓存的输入 + 缓存命中输入 + 输出；缓存写入不重复计入。 */
    totalTokens: number;
    /** 失败请求数。 */
    errors: number;
    /**
     * 平均首字用时（毫秒）—— **只对有实测值（ttftMs > 0）的请求取均值**。
     * 失败/秒回空（ttftMs 缺省）的请求不摊薄均值；无任何可测请求时为
     * `undefined`（显示 `—`，与「平均 0ms」严格区分）。
     */
    avgTtftMs?: number;
    /**
     * 平均输出速率（tok/s）—— 对**有 tps 实测值**的请求取均值（不加权，
     * 「每笔请求的速率」的算术平均，口径与用户直觉一致）。无可测请求时
     * `undefined`。
     *
     * ⚠️ **是算术均值，对离群样本敏感**：保留该字段以兼容既有口径；同时提供
     * 基于持久化直方图估算的 P50/P90，便于观察典型速度和慢速尾部。
     *
     * ⚠️ 已落盘的 `tpsSum/tpsCount` 仍可能含早期离群样本；P50/P90 从直方图完整
     * 覆盖样本后才显示，避免把不完整的分布误当成完整统计。
     */
    avgTps?: number;
    /** 日志 TPS 直方图估算的中位数与 P90；旧账本没有样本时省略。 */
    p50Tps?: number;
    p90Tps?: number;
}
/** 一个 provider 下、某个账号的聚合（模型行 + 自身小计）。 */
export interface TokenLedgerAccountRow {
    /** 账号池条目 id；空串 = 未归属（凭据解析没回报的请求）。 */
    accountId: string;
    models: TokenLedgerModelRow[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
}
/** 一个 provider 下的聚合（账号行 + 自身小计）。 */
export interface TokenLedgerProviderRow {
    provider: string;
    accounts: TokenLedgerAccountRow[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
}
/** 一个渠道下的聚合（provider 行 + 自身小计）。 */
export interface TokenLedgerChannelRow {
    channel: 'direct' | 'gateway';
    providers: TokenLedgerProviderRow[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
}
/** 读侧返回：三维聚合树 + 全局小计 + 最近明细。 */
export interface TokenLedgerSnapshot {
    channels: TokenLedgerChannelRow[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
    /** 最近明细（最新在前），`entries` 的条数即 `limit`（不超上限）。 */
    entries: TokenLedgerEntry[];
}
/** 流水上限。500 条足够回溯近期活动，内存占用可忽略。 */
export declare const TOKEN_LEDGER_LIMIT = 500;
/**
 * TPS 计算的**最小解码时长**（毫秒）：短于此值 ⇒ 该笔不可测，不计入均值。
 *
 * ⚠️ 为什么是 100 而不是 0（用户 2026-10-07 报障「982.5 tok/s」）：`decodeMs`
 * 是「首块之后 → 结束」，当这两个时刻几乎贴在一起时它会塌缩到个位数毫秒，
 * 除出来的速率高达数十万 tok/s。100ms 的门槛覆盖了「至少出了一小段正文」的
 * 情形 —— 单流文本生成的正常首段就远超 100ms，故此门槛**不会**误伤真实样本。
 *
 * ⚠️ 该门槛只影响**新增**记账；已落盘的 `tpsSum/tpsCount` 仍是污染值
 * （见 `flush`/迁移说明）。
 */
export declare const MIN_DECODE_MS_FOR_TPS = 100;
/**
 * 关闭上游流时的**等待上限**（毫秒），见 {@link withTokenLedgerAccountContext}。
 *
 * ⚠️ 为什么必须有：关闭动作挂起时，`finally` 永不返回，会把「本层已捕获的错误」
 * 一起吞掉 —— 消费方永久卡在 `for await` 里（与「停止按钮无效」同型的症状）。
 *
 * ⚠️⚠️ **超时的确切语义（实测，勿再写错）**：它是**放弃等待**，**不是取消动作**。
 * 实测时间线（上游关闭耗时 3s）：
 * ```
 * return() 开始      @1ms     ← break 后本层立刻转发了关闭信号
 * 消费方 break 返回   @2004ms  ← 2s 超时到，不再等
 * 上游清理完成        @3009ms  ← 被"放弃"等待的那个 promise 仍在后台跑完
 * ```
 * ⇒ 上游清理（`releaseLock()` / `removeEventListener()` / `sigStore.flush()`）
 * **最终仍会执行**，只是消费方不再阻塞等它。
 * ⚠️ **本注释曾错误地写成「清理永不执行 / 永久停在 await 上」**（首版实现 + 两轮
 * 审计都这么写，属未经验证的推断）；实测推翻了它，故按事实更正。
 *
 * ⚠️ 真实代价因此是**有界**的：清理完成前上游资源（连接 / reader / 监听器）仍占着，
 * 且高频取消时会有若干个清理在后台并发堆积 —— 但不会永久泄漏。
 * ⚠️ 也**不要**因为「偶尔超时也不报错」就忽略它：若日志里频繁出现，说明某些适配器
 * 的清理动作确实很慢甚至挂起，应去修那个适配器，而不是调大这个值。
 */
export declare const CLOSE_STREAM_TIMEOUT_MS = 2000;
/** 稀疏对数直方图：每八分之一倍频程一个桶，覆盖 0.1 到约 1.5M tok/s。 */
export declare const TPS_HISTOGRAM_BINS = 192;
/** 为一次调用创建可跨 prepareCall 与 stream 传递的账号上下文。 */
export declare function createTokenLedgerAccountContext(): {
    accountId: string;
};
/** 在指定调用上下文中执行同步或异步工作。 */
export declare function runWithTokenLedgerAccountContext<T>(context: {
    accountId: string;
}, action: () => T): T;
/**
 * 回报本请求解析出的账号（凭据解析点调用）。
 *
 * ⚠️ 绝不抛错：它与 {@link recordTokenUsage} 同在推理关键路径上。
 * 空串 / 非串入参直接忽略（不清空旧值 —— 清空语义属于 {@link clearLedgerAccount}）。
 */
export declare function reportLedgerAccount(provider: string, accountId: string): void;
/**
 * 读取该 provider 当前记录的账号。
 *
 * ⚠️ **生产路径已不再调用本函数**（`recordThroughStream` 改为只读 ALS 上下文的
 * `accountContext`）—— 它现在只服务单测，以及「上下文外回报」的防御性回退读
 * （见 {@link reportedAccounts} 的长注释）。保留理由与代价写在那里，**不要**
 * 因为「只有测试用」就删掉：删了会让上下文外的回报彻底无处可读。
 */
export declare function peekLedgerAccount(provider: string): string;
/**
 * 每次推进异步流时绑定独立上下文，避免并发请求串用账号归属。
 *
 * ⚠️⚠️ **必须转发 `return()` / `throw()` 到内层迭代器**（真实缺陷，本包装器首版
 * 漏了这一层）。手写 `while + yield` 的生成器**不会**自动把消费方的关闭信号传给
 * 它包着的迭代器 —— V8 在 `yield` 处收到 `return()` 时只关闭**本**生成器，`finally`
 * 之后的 `iterator.return()`（如果没写）根本不存在。后果：消费方提前关流时，
 * 上游适配器的 `finally` **永不执行** ⇒ SSE `reader.releaseLock()` 不执行、
 * zcode 的 `clearTimeout` / `removeEventListener` 不执行 ⇒ 用户点「停止」后连接与
 * 定时器一齐泄漏（与 `providers-zcode` 的「卡住 + 停止按钮无效」同型）。
 *
 * ⚠️ 消费侧确实会调它：`dsh-llm` 在流未读完时 `finally { await iterator.return() }`；
 * `dsh-agent-loop` 的取消路径是 `signal.throwIfAborted()` 在循环体内**抛错**。
 * 两条路径都要求这里转发 —— 只转发 `return()` 挡不住 `throw()`，故用 `try/finally`
 * 兜住「未正常结束」的所有情形（正常 `done` 时 `return()` 是 no-op）。
 *
 * ⚠️ 转发动作本身**也要在 ALS 上下文内**执行：清理期间若有 `reportLedgerAccount`
 * 回报，落回全局表会污染其他并发请求的归属。
 *
 * ⚠️⚠️ **关闭阶段必须有超时**：`finally` 里若直接 `await iterator.return()`，而上游的
 * 关闭动作**迟迟不 resolve**（例如适配器 `finally` 里 `await reader.cancel()` 卡在一个
 * 已经断开的连接上），那么 `finally` 永不返回 ⇒ **本层已经捕获到的错误永远传不出去**，
 * 消费方（`dsh-agent-loop`）会卡在 `for await` 里。实测：上游 `next()` 抛
 * `upstream-500` + `return()` 挂起时，无超时版本判为 `HUNG`（错误被吞），加超时后
 * 原始错误照常上抛。这与 `providers-zcode` 的「卡住 + 停止按钮无效」同型，故不能省。
 *
 * ⚠️ 超时是**放弃等待**而非**取消动作**（实测语义，详见 {@link CLOSE_STREAM_TIMEOUT_MS}
 * 的注释）：转发出去的关闭 promise 仍在后台跑完，上游清理最终仍会发生。故本层
 * 只保证「消费方不被关流拖住 + 原始错误不被吞」，**不保证**清理此刻已完成。
 */
export declare function withTokenLedgerAccountContext<T>(iterable: AsyncIterable<T>, context: {
    accountId: string;
}): AsyncIterable<T>;
/** 诊断用：注册表当前条数。 */
export declare function ledgerAccountCount(): number;
/** 测试专用：清空回报表。 */
export declare function resetLedgerAccountsForTests(): void;
/**
 * 日聚合存储后端的**最小契约**（`token-ledger-store.ts` 的实现满足它）。
 *
 * 只声明记账侧真正用到的两个方法 —— 账本模块刻意不 import store 的实现，
 * 以免把 `node:fs` 拖进纯逻辑模块（该模块要能在无盘环境被单测）。
 */
export interface TokenLedgerBackend {
    /** 把一笔请求并入日聚合（内存即时、落盘节流）。 */
    append(entry: TokenLedgerEntry): void;
    /** 读取日聚合表（**纯内存读**，不碰磁盘 —— 见 store 的注释）。 */
    load(): TokenLedgerDayMap;
    /** 删除单个 UTC+8 日期的历史累计。 */
    deleteDay?(day: string): boolean;
}
/**
 * 注入日聚合后端，返回**该次挂载专属的 disposer**。
 *
 * ⚠️ 返回的 disposer 只在「当前挂载的仍是我自己」时才清空 —— 这样 fiber 重启
 * 交错时，旧实例的 dispose 不会摘掉新实例的挂载（见 {@link backend} 的说明）。
 *
 * ⚠️ **幂等性由令牌判据单独提供，不再另设 `disposed` 标志**（审计发现）：
 * 曾经有一个 `if (disposed) return` 守卫，但它是**不可观测的冗余** —— 令牌每次
 * 挂载都新生成且永不复用，故 disposes 重入时 `backendToken === token` 必然为假、
 * 必然让位；删掉守卫行为完全相同（变异测试：删掉后 24 条用例仍全绿，证明它
 * 无法被任何时序观测到）。与其保留一段无用例覆盖、只在注释里声称"幂等"的代码，
 * 不如把它删掉，让"幂等来自令牌判据"成为**唯一**且可被用例锁定的事实。
 *
 * @param next - 后端实现；传 `undefined` = 卸载（测试隔离用）。
 */
export declare function attachTokenLedgerStore(next: TokenLedgerBackend | undefined): () => void;
/** RPC 侧读取日聚合表；未挂载（headless 等）返回空表。 */
export declare function readTokenLedgerDayMap(): TokenLedgerDayMap;
/** 日期键必须是真实日历日期，避免把任意值传入持久化删除接口。 */
export declare function isValidTokenLedgerDayKey(day: unknown): day is string;
/**
 * 删除历史日累计，不改进程内实时流水（`entries`）及其他任何状态。
 * 持久化后端同步完成删除；没有可删除能力或日期无效时返回 false。
 */
export declare function deleteTokenLedgerDay(day: string): boolean;
/**
 * **UTC+8 日键**（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术**换算（+8h 后取 UTC 日期），绝不能用 `Date.setHours` 等
 * 本机时区方法 —— 与 `qoder-adapter.ts` 的 `nextUtc8DayStartMs` 同一条纪律：
 * 各渠道的每日额度都按 UTC+8 结算，本机时区不同（出差/改设置）会算错日界。
 */
export declare function utc8DayKey(ts: number): string;
/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**（见模块头）。字段全部截断/钳制，写满即淘汰最旧。
 */
export declare function recordTokenUsage(entry: Omit<TokenLedgerEntry, 'ts'>): void;
/** 聚合行的内部形态：均值以 Σ/份数 累加，最终快照前收尾成 `avgXxx`。 */
export interface AccumulatingTotals extends Omit<TokenLedgerModelRow, 'model' | 'totalTokens' | 'p50Tps' | 'p90Tps'> {
    ttftSumMs: number;
    ttftCount: number;
    tpsSum: number;
    tpsCount: number;
    tpsHistogram: Record<string, number>;
}
/**
 * 读取账本快照（聚合树 + 全局小计 + 最近明细）。
 *
 * 纯读取、不改状态；每次按需重建聚合树（见模块头「不为 O(n) 引入双写」）。
 * 聚合与明细都来自同一份 `ledger`，**天然同源**——不存在「树与小计各算一遍」
 * 的口径漂移。各级排序：渠道按 `direct → gateway`、provider/账号/模型按 token
 * 合计降序（谁烧得多谁在前）。
 */
export declare function readTokenLedger(options?: {
    limit?: number;
}): TokenLedgerSnapshot;
/**
 * 测试与 dispose 专用：清空账本。
 *
 * ⚠️ 不导出给 RPC/UI —— 正常运行时账本不该被外部清空（用户看到「突然归零」
 * 会以为丢了数据）；只有单测需要隔离状态。
 */
export declare function resetTokenLedgerForTests(): void;
/** 当前保留的流水条数（诊断用）。 */
export declare function tokenLedgerSize(): number;
/**
 * **每日聚合**的落盘负载（第 2 期持久化）。
 *
 * 键结构：`日键 → 渠道|provider|账号|模型 → 累计值`。与「明细不持久化」的
 * 决策一致：明细在 UI 已有内存版（500 条），落盘只解决「重启后还能看历史
 * 总量」的诉求，而这个诉求的天然粒度就是**日**。
 */
export interface TokenLedgerDayKey {
    channel: 'direct' | 'gateway';
    provider: string;
    /** 空串 = 未归属。 */
    accountId: string;
    model: string;
}
/** 一个日聚合桶的累计值。 */
export interface TokenLedgerDayBucket {
    requests: number;
    reportedRequests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    errors: number;
    /** Σ(首字用时) 与样本数 —— 均值由读取方计算（Σ/份数，避免存小数漂移）。 */
    ttftSumMs: number;
    ttftCount: number;
    /** Σ(TPS) 与样本数（同上）。 */
    tpsSum: number;
    tpsCount: number;
    /** 稀疏对数直方图；v1 历史桶缺此字段时保留均值、分位数从升级后开始累计。 */
    tpsHistogram?: Record<string, number>;
}
/** 每日聚合表：`日键 → (桶键 → 桶)`。序列化形态由 store 负责。 */
export type TokenLedgerDayMap = Map<string, Map<string, TokenLedgerDayBucket>>;
/** 桶键（同进程内用 `|` 拼；含转义，见 `dayBucketKeyOf`）。 */
export declare function dayBucketKeyOf(key: TokenLedgerDayKey): string;
/** 把一笔记录累加进日聚合表（store 的 load/merge 共用）。 */
export declare function mergeDayEntry(days: TokenLedgerDayMap, entry: TokenLedgerEntry): void;
/**
 * 解析日聚合桶键（`channel|provider|account|model`）为结构化键。
 *
 * ⚠️⚠️ **这是「桶键是否合法」的唯一定义**，`token-ledger-store.ts` 的落盘读取
 * 必须调用它、**不得**再写一份自己的校验（真实缺陷：store 首版另写了一个
 * 要求 model 非空的 `isValidBucketKey`，与这里分叉 ⇒ `model` 为空串的桶写盘后
 * 重启读不回，该日用量静默消失）。
 *
 * ⚠️ **`model` 允许为空串**：写入侧的 `options.model` 可能缺失/垃圾值，仓库既有
 * 用例 `token-ledger-wiring.spec.ts` 的「model 缺失/垃圾值记空串不抛错」把该行为
 * 锁为**既定语义**。故这里不能要求它非空 —— 单方面加严会让**已经写进盘**的数据
 * 读不回来。`accountId` 同理允许为空（单账号 provider 的合法取值）。
 *
 * 判据只保证「段数与 channel 取值合法」，不保证各段内容可信 —— 那是调用方
 * （store 的字段钳制）的事。
 */
export declare function parseDayBucketKey(key: string): TokenLedgerDayKey | undefined;
/** 一天的历史用量行（`readTokenLedgerHistory` 的返回元素）。 */
export interface TokenLedgerHistoryDay {
    /** UTC+8 日键（`YYYY-MM-DD`）。 */
    day: string;
    channels: TokenLedgerChannelRow[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
}
/**
 * 从日聚合表读取**历史视图**（可按日期范围过滤）。
 *
 * ⚠️ 数据源是**落盘的日聚合**（重启保留），与内存明细（500 条、重启清空）
 * 是**两份独立数据**：历史视图答「本周/本月用了多少」，明细答「每一笔
 * 长什么样」。读取是纯计算（Map 树 → 数组），不碰磁盘。
 *
 * @param days - 日聚合表（store 的 `load()` 结果，含启动时从盘上加载的历史）。
 * @param options.sinceDays - 只看最近 N 天（**含今天**，UTC+8 日界）；
 *   省略 = 全部历史（上限 {@link TOKEN_LEDGER_HISTORY_MAX_DAYS}）。
 * @param options.fromDay / options.toDay - 按 UTC+8 日键筛选闭区间。
 */
export declare function readTokenLedgerHistory(days: TokenLedgerDayMap, options?: {
    sinceDays?: number;
    fromDay?: string;
    toDay?: string;
}): {
    days: TokenLedgerHistoryDay[];
    totals: Omit<TokenLedgerModelRow, 'model'>;
};
/** 历史视图的最大回看天数（防一次下发过大；落盘本身已有 90 天淘汰）。 */
export declare const TOKEN_LEDGER_HISTORY_MAX_DAYS = 90;
//# sourceMappingURL=token-ledger.d.ts.map