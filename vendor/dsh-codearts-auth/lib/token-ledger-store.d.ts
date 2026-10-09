/**
 * Token 账本**每日聚合**的持久化文档（第 2 期）。
 *
 * ## 形态与取舍
 *
 * - **只落日聚合，不落明细**：明细（每笔请求一行）在 UI 已有内存版（500 条，
 *   重启即丢是**既定行为**）；持久化要回答的是「本周/这个月用了多少」，
 *   天然粒度就是**日**。日聚合把每笔请求摊平成「UTC+8 日 × 渠道 × provider ×
 *   账号 × 模型」一格，写入量与请求量解耦（同一格只加数，不增行）。
 * - **独立文档**（`token-ledger.json`），不进 state.json —— 理由与
 *   `permanent-lock-store.ts` 完全同源：state.json 被**另一条工作区的旧代码**
 *   整体重写时会静默抹掉它不认识的键。
 * - **节流落盘**（2 秒防抖）：记账在推理关键路径上，每笔都同步写盘会把
 *   「一次推理」变成「一次磁盘写」。防抖窗口内崩溃最多丢最近 2 秒的计数 ——
 *   对统计型数据是可接受的精度损失（换取零阻塞）。
 * - **落盘是「增量合并写」，不是整体覆盖**（真实缺陷，审计发现并原样复现）：
 *   两个实例并存时（fiber 重启交错；或同机多 profile 共享同一 home——见上条
 *   与 `permanent-lock-store.ts`）各自内存视图独立，整体覆盖会**互相抹掉**。
 *   详见 `FileLedgerStore.flush` 的注释。
 *
 * ## ⚠️ 已知限制一：跨进程并发仍非原子（审计实测，未修）
 *
 * `flush()` 是 `readFile → 合并 → writeFile(tmp) → rename`，**不是原子
 * read-modify-write**：`rename` 本身原子，但「读」与「写」之间存在窗口，两个
 * **真实进程**密集并发写时，后写者可能基于陈旧快照覆盖。
 *
 * 实测（4 进程 × 60 轮密集 append+flush，期望 240）：实得 209 / 220 / 232 / 224。
 * ⚠️ 如实说明：该场景在**首轮的整体覆盖实现上同样丢**（同压测丢 8 条），故本轮
 * 合并写**不是纯回归** —— 它另修好了一个首轮才有的「跨实例可见性」缺陷。但窗口
 * 确实从「写」扩大到「读+写」。
 *
 * **影响面有限**：真实规模下日桶数受 provider × model 数量限制，且 DSH 通常
 * 单进程使用同一 profile。**根治**需文件锁（advisory lock）或改追加日志形态
 * ——超出本次范围，在此显式记录以免被当成"已解决"。
 *
 * ## ⚠️ 已知限制二：「外部删除某日键 + 该日之后又有增量」⇒ 本次运行内读数偏高
 *
 * `flush()` 只写**增量**，而增量的基线是**本实例内存里的值**。若盘上某日键被
 * 外部删除（手工编辑 / 另一工作区的旧版本整体覆盖 / 从备份恢复），而该日随后
 * **又产生了新的真增量**，则只写该增量、不写被删掉的那部分：
 *
 * ```
 * 昨日记 20 落盘 → 外部删掉昨日 → 昨日又产生增量 5 → flush
 * 运行中（内存 / UI）昨日 = 25
 * 重启后（盘上）    昨日 = 5     ← 被外部删掉的 20 不会回来
 * ```
 *
 * ⚠️ **这是有意的取舍，不是缺陷**：盘上那一格是被**外部权威地删除**的，把它
 * 「复活」等于无视用户的删除意图（本仓库 `permanent-lock-store.ts` 的迁移判据
 * 「文档存在则它是唯一权威」是同款思路）。代价是**本次运行内**的读数会高于
 * 重启后的读数 —— 触发前提是外部干预；无外部删除时两者恒等。
 *
 * ⚠️ 与上一节**不同源**：那条是两进程同时写，本条是外部删除后本地继续写。
 *
 * ## 日界
 *
 * UTC+8（各渠道每日额度的结算时区），见 `utc8DayKey`。**保留天数**
 * {@link TOKEN_LEDGER_DAYS}：默认 90 天，更早的日桶在落盘时淘汰 ——
 * 用户「看看历史」的诉求远小于无限增长的文件。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type TokenLedgerDayMap } from './token-ledger.js';
/** 独立文档的文件名（与 state.json 同目录）。 */
export declare const TOKEN_LEDGER_FILE = "token-ledger.json";
/** 日聚合保留天数（落盘时淘汰更早的日键）。 */
export declare const TOKEN_LEDGER_DAYS = 90;
/** 落盘节流窗口（毫秒）。 */
export declare const TOKEN_LEDGER_FLUSH_MS = 2000;
/** 日聚合的持久化后端接口（同步读、节流异步写）。 */
export interface TokenLedgerStore {
    /**
     * 读取日聚合表 —— **纯内存读，不碰磁盘**。
     *
     * ⚠️ 磁盘**只在构造时读一次**（见 {@link FileLedgerStore} 的 `hydrate`）。
     * RPC 的历史视图会**频繁**调用本方法（每次打开弹窗、每次切窗口）。若在这里
     * 重新读盘，会把防抖窗口内**尚未落盘**的计数打回盘上的旧值，并被随后的自动
     * flush **固化到磁盘**（实测：内存 60 → 读一次 → 30 → 落盘 30）。
     */
    load(): TokenLedgerDayMap;
    /** 把一笔请求并入日聚合（内存即时、落盘节流）。 */
    append(entry: import('./token-ledger.js').TokenLedgerEntry): void;
    /** 立即落盘（dispose / 测试用；正常路径靠节流自动刷）。 */
    flush(): void;
}
/**
 * 创建日聚合后端。
 *
 * home 解析与账号池**同一个函数**（`resolveJetHubHome`），保证文档落在同一目录
 * —— 否则会出现「账号池在 A 处、用量在 B 处」的分裂。
 */
export declare function createTokenLedgerStore(ctx: Context): TokenLedgerStore;
//# sourceMappingURL=token-ledger-store.d.ts.map