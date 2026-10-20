/**
 * 「Token 用量」弹窗的**取值与聚合展示逻辑**（纯函数，可单测）。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-filter.js` / `tokens-per-second.js` 同理：本仓库单测环境里 react
 * 不在依赖内，组件无法渲染；聚合树的折叠/汇总/格式化判据抽成纯函数后才能
 * 用**真实断言**覆盖（组件只负责把算好的形状画出来）。
 *
 * ## 数据源
 *
 * RPC `usage.tokenLedger` → `TokenLedgerSnapshot`（`src/token-ledger.ts`）：
 * `channels[]`（渠道 → provider → 模型三级聚合）+ `totals`（全局小计）+
 * `entries[]`（最近明细，最新在前）。账本是**进程内存**，重启即丢 ——
 * 弹窗副标题必须讲清这一点，不能伪装成历史报表。
 */

/** token 数格式化：千分位；≥ 1M 用 M 单位、≥ 10K 用 K 单位（对齐 badge 口径的紧凑倾向）。 */
export function formatTokenCount(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (n >= 1_000_000) return trimZeros(n / 1_000_000) + 'M';
  if (n >= 10_000) return trimZeros(n / 1_000) + 'K';
  return n.toLocaleString('en-US');
}

/** 去掉小数尾随 0（2.50 → 2.5、2.00 → 2）。 */
function trimZeros(n) {
  return String(Math.round(n * 100) / 100);
}

/** 渠道显示名（`direct` = DSH 直连；`gateway` = OpenAI 网关）。 */
export function channelLabel(channel) {
  return channel === 'gateway' ? '网关' : '直连';
}

/** 渠道排序：直连在前（它是 DSH 用户的主路径），网关在后。 */
export function channelOrder(a, b) {
  return (a === 'direct' ? 0 : 1) - (b === 'direct' ? 0 : 1);
}

/**
 * 一行 token 汇总的**紧凑文本**（`↓1.2K ↑340 ⚡800 🧠56`）。
 *
 * ⚠️ 与 Cline 请求表同款约定：只渲染**有值**的段 —— 缓存/推理为 0 时整段
 * 省略，避免一排恒 0 的装饰性数字稀释真正有用的读数。
 */
export function tokenSummaryText(row) {
  if (!row || typeof row !== 'object') return '—';
  const parts = ['↓' + formatTokenCount(row.inputTokens ?? 0), '↑' + formatTokenCount(row.outputTokens ?? 0)];
  if ((row.cacheReadTokens ?? 0) > 0) parts.push('⚡' + formatTokenCount(row.cacheReadTokens));
  if ((row.cacheWriteTokens ?? 0) > 0) parts.push('✎' + formatTokenCount(row.cacheWriteTokens));
  if ((row.reasoningTokens ?? 0) > 0) parts.push('🧠' + formatTokenCount(row.reasoningTokens));
  return parts.join(' ');
}

/**
 * 明细行的 token 格（与汇总格同规则，但**未收到 usage 时显示 `—`**）。
 *
 * ⚠️ 「没收到 usage」与「用了 0」必须区分：失败行/中断行显示 `—`
 * （0 会被读成「瞬间完成、没花 token」，`cline-request-log` 同约定）。
 */
export function entryTokenText(entry) {
  if (entry?.usageReported !== true) return '—';
  return tokenSummaryText(entry);
}

/** 耗时格式化：<1s 显示毫秒，否则一位小数的秒。 */
export function formatDuration(ms) {
  const n = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  if (n === 0) return '—';
  if (n < 1000) return n + 'ms';
  return trimZeros(n / 1000) + 's';
}

/**
 * 首字用时（明细行）：`0.9s` / `850ms`；**缺失（字段省略）= 不可测** → `—`。
 *
 * ⚠️ 0 与「没测到」必须区分：失败/秒回空的请求 ttft 字段**省略**，
 * 显示 `—`（0ms 会被读成「模型秒回」，是误导）。
 */
export function formatTtft(entry) {
  const n = typeof entry?.ttftMs === 'number' && Number.isFinite(entry.ttftMs) && entry.ttftMs > 0
    ? Math.round(entry.ttftMs)
    : 0;
  if (n === 0) return '—';
  return formatDuration(n);
}

/**
 * 输出速率（明细行）：`52.3 tok/s`；字段省略（不可测）→ `—`。
 * 精度由记账层定（1 位小数），这里只做单位拼接。
 */
export function formatTps(entry) {
  const v = entry?.tps;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '—';
  return v + ' tok/s';
}

/**
 * 均值格（汇总行）：`avg 0.9s · 48 tok/s`；两边都不可测 → `—`。
 *
 * ⚠️ 速率是**算术均值**，对离群样本敏感（用户 2026-10-07 报障「982.5 tok/s」）。
 * 服务端已丢弃 `decodeMs` 过短（分母塌缩）的样本，但混合分布下均值仍可能
 * 偏高/偏低；正式口径说明见 {@link avgPerfTooltip}。
 */
export function avgPerfText(row) {
  const ttft = typeof row?.avgTtftMs === 'number' && row.avgTtftMs > 0 ? formatDuration(row.avgTtftMs) : null;
  const tps = typeof row?.avgTps === 'number' && row.avgTps > 0 ? row.avgTps + ' tok/s' : null;
  if (ttft === null && tps === null) return '—';
  return '首字 ' + (ttft ?? '—') + ' · ' + (tps ?? '—');
}

/**
 * 均值格的**口径说明**（tooltip）。
 *
 * ⚠️ 必须显式说明「均值对离群样本敏感」：用户看到 lobsterai「982.5 tok/s」
 * 时合理怀疑是算错了，而不给口径说明就无从判断。分成两条：
 * 首字用时可测条件较宽；速率额外要求「解码时长 ≥ 100ms」——
 * 否则首块与结束贴在一起时分母塌缩，会算出几十万 tok/s 的假值
 * （已实测：单笔 decode=1ms 的样本能把均值从 184 拉到 634592）。
 */
export function avgPerfTooltip() {
  return '均值口径：对有实测值的请求取算术平均。'
    + '「首字」= 首个 chunk 到达前的耗时；'
    + '「速率」= 全部输出 token ÷（首块之后 → 结束）的时长，'
    + '要求解码时长 ≥ 100ms（过短视为不可测、不计入）。'
    + '算术均值对离群样本敏感：个别极快/极慢的请求会明显拉高或拉低该值。';
}

// ───────────────────── 历史视图（第 4 期）─────────────────────

/** 历史窗口选项（与服务端 RPC 约定一致；0 = 全部）。 */
export const HISTORY_RANGES = [
  { key: 'today', label: '今日', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部', days: 0 },
];

/** 窗口 key → sinceDays（0 = 全部历史）。未知 key 回退全部。 */
export function rangeDaysOf(key) {
  const hit = HISTORY_RANGES.find((r) => r.key === key);
  return hit === undefined ? 0 : hit.days;
}

/** 今日的 UTC+8 日键（与服务端 utc8DayKey 同算法；用于高亮柱状图当前日）。 */
export function todayDayKey() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate());
}

/**
 * 趋势图数据：每日一行（日键 + token 合计 + 请求数），新在前，最多 maxBars 根。
 *
 * ⚠️ 缺数据的天**不补零**（历史里没有键就是没用过）—— 补零需要造日历序列，
 * 会让「最近 30 天」在数据稀疏时出现一长排空柱，观感差且信息量为零。
 */
export function trendBars(historyDays, maxBars = 30) {
  const list = Array.isArray(historyDays) ? historyDays : [];
  const today = todayDayKey();
  return list.slice(0, maxBars).map((d) => ({
    day: d?.day ?? '',
    isToday: d?.day === today,
    requests: d?.totals?.requests ?? 0,
    tokens: (d?.totals?.inputTokens ?? 0) + (d?.totals?.outputTokens ?? 0),
  }));
}

/** 柱高下限：极小值也能看见柱子（否则只在最大值那根可见）。 */
export const BAR_HEIGHT_MIN_PERCENT = 4;
/** 柱高上限：留出顶部空白，描边与圆角才不会被容器裁掉。 */
export const BAR_HEIGHT_MAX_PERCENT = 88;
/** 相对区间宽度：非最大柱能落在 [MIN, MIN+SPAN] 内，最大柱封顶 MAX。 */
export const BAR_HEIGHT_SPAN_PERCENT = 84;
/** 孤柱高度：单日窗口下唯一那根（相对比较无意义，给固定值更像「一根柱子」）。 */
export const BAR_HEIGHT_SINGLE_PERCENT = 72;

/**
 * 柱高百分比（相对窗口内最大值）。
 *
 * ⚠️ **必须有上限**（真实缺陷，用户 2026-10-07 报障）：单日窗口（`today`）下
 * 「今日」既是最大值又是它自己，比值恒为 `t/max = 1` ⇒ 高度 100% ⇒ 唯一那根柱
 * 撑满 64px 容器；`flex: 1 0 14px` 又把它横向拉满整行，于是**一柱独占成
 * 一整条白块**，点开展开后又被卡片挤成竖条 —— 看着像「点击后尺寸突变」，
 * 实则是同一根柱在两种容器宽度下的两种表现。
 *
 * 上限的另一层用意：全等高时不许「一根顶天、其余贴地」的观感。最大值那根
 * 给 {@link BAR_HEIGHT_MAX_PERCENT}（留白让描边与圆角可见），其余按比例缩放
 * 到 {@link BAR_HEIGHT_SPAN_PERCENT} 的区间里 —— 保持相对关系不失真。
 *
 * @param tokens - 该柱的 token 合计。
 * @param maxTokens - 窗口内最大 token 合计（0/垃圾值按 0 处理）。
 * @param barCount - 窗口内的柱子**根数**；只有一根时用固定孤柱高（避免孤柱独占）。
 */
export function barHeightPercent(tokens, maxTokens, barCount = 0) {
  const max = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 0;
  const t = typeof tokens === 'number' && tokens > 0 ? tokens : 0;
  if (max === 0 || t === 0) return 0;
  const ratio = t / max;
  // ⚠️ 孤柱（单日窗口）不参与满量程比较：恒 100% 的那根就是「白块」本体。
  if (barCount <= 1) return BAR_HEIGHT_SINGLE_PERCENT;
  // 最大值那根给满量程上限，其余按比例压进 [保底, 满量程上限] 区间。
  const scaled = BAR_HEIGHT_MIN_PERCENT + ratio * BAR_HEIGHT_SPAN_PERCENT;
  return Math.round(Math.min(BAR_HEIGHT_MAX_PERCENT, Math.max(BAR_HEIGHT_MIN_PERCENT, scaled)));
}

/** 柱子的日期短标签（`MM-DD`；非法日键 → 空串，由调用方降级为不渲染）。 */
export function barDayLabel(day) {
  if (typeof day !== 'string' || day.length < 10) return '';
  const m = day.slice(5, 7);
  const d = day.slice(8, 10);
  return /^\d{2}-\d{2}$/.test(m + '-' + d) ? m + '-' + d : '';
}

/** 历史窗口标题（弹窗内小节标题）。 */
export function historyTitle(rangeKey) {
  const hit = HISTORY_RANGES.find((r) => r.key === rangeKey);
  return '历史用量 · ' + (hit === undefined ? '全部' : hit.label);
}

/** 时间格式化（HH:MM:SS）：明细表不需要日期（流水只覆盖最近 500 笔）。 */
export function formatEntryTime(ts) {
  const d = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : null;
  if (d === null || Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 弹窗副标题：说明账本的存在形态。
 *
 * ⚠️ 第 2 期起**日聚合已落盘**（`token-ledger.json`）——「重启后清空」只对
 * **明细表**成立。副标题必须把两者说清，不能笼统说「重启清空」误导用户
 * 以为历史总量也丢了。
 */
export function ledgerSubtitle() {
  return '本机流水 · 明细重启清空 · 日累计已存盘';
}

/** 账号显示名：空串（未归属）给中性占位，其余原样。 */
export function accountLabel(accountId) {
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : '未归属';
}

/**
 * 汇总卡片头：渠道名 + 请求计数。
 *
 * 0 请求的渠道不显示卡片（空状态由调用方整体处理，见 `hasAnyData`）。
 */
export function channelCardTitle(channelRow) {
  const requests = channelRow?.totals?.requests ?? 0;
  return channelLabel(channelRow?.channel) + ' · ' + requests + ' 次请求';
}

/** 全账本是否没有任何数据（空状态判据：一条明细都没有）。 */
export function hasAnyData(snapshot) {
  return (snapshot?.entries?.length ?? 0) > 0;
}

/**
 * 按当前选择的渠道过滤聚合树。
 *
 * `selected` 为 `null`（= 「全部」）时原样返回；否则只留匹配的渠道。
 * ⚠️ 过滤在**渠道级**进行（provider/模型树保持完整），弹窗的第二层浏览
 * 就是聚合树本身，不需要更细的筛选器。
 */
export function filterChannelsBySelection(channels, selected) {
  if (selected === null) return channels ?? [];
  return (channels ?? []).filter((c) => c?.channel === selected);
}
