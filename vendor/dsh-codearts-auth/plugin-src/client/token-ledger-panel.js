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
 * 一行 token 汇总的紧凑文本，明确给出处理量及输入/输出/缓存拆分。
 *
 * ⚠️ 与 Cline 请求表同款约定：只渲染**有值**的段 —— 缓存/推理为 0 时整段
 * 省略，避免一排恒 0 的装饰性数字稀释真正有用的读数。
 */
export function tokenSummaryText(row) {
  if (!row || typeof row !== 'object') return '—';
  return '总处理 ' + formatTokenCount(totalTokensOf(row));
}

/** 统一客户端 fallback 口径：缓存命中输入计入处理量，缓存写入不重复计入。 */
export function totalTokensOf(row) {
  if (!row || typeof row !== 'object') return 0;
  const total = Number(row.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const count = (value) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return count(row.inputTokens) + count(row.cacheReadTokens) + count(row.outputTokens);
}

/** 汇总格的悬浮详情：紧凑行保留总量，悬浮窗给出完整输入/输出拆分。 */
export function tokenSummaryTooltip(row) {
  if (!row || typeof row !== 'object') return '暂无 Token 用量';
  const lines = [
    tokenSummaryText(row),
    '↓ 输入 ' + formatTokenCount(row.inputTokens ?? 0),
    '↑ 输出 ' + formatTokenCount(row.outputTokens ?? 0),
  ];
  if ((row.cacheReadTokens ?? 0) > 0) lines.push('⚡ 缓存命中 ' + formatTokenCount(row.cacheReadTokens));
  if ((row.cacheWriteTokens ?? 0) > 0) lines.push('✎ 缓存写入 ' + formatTokenCount(row.cacheWriteTokens) + '（不重复计入总处理量）');
  if ((row.reasoningTokens ?? 0) > 0) lines.push('🧠 推理 ' + formatTokenCount(row.reasoningTokens) + '（已包含在输出中）');
  lines.push('总处理量 = 输入 + 输出；缓存写入不重复计入');
  return lines.join('\n');
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
 * 性能格显示均值与稳健分位数；没有完整分布样本时只显示均值。
 *
 * ⚠️ 速率是**算术均值**，对离群样本敏感（用户 2026-10-07 报障「982.5 tok/s」）。
 * 服务端已丢弃 `decodeMs` 过短（分母塌缩）的样本，但混合分布下均值仍可能
 * 偏高/偏低；正式口径说明见 {@link avgPerfTooltip}。
 */
export function avgPerfText(row) {
  const ttft = typeof row?.avgTtftMs === 'number' && row.avgTtftMs > 0 ? formatDuration(row.avgTtftMs) : null;
  const speed = typeof row?.p50Tps === 'number' && row.p50Tps > 0
    ? 'P50 ' + row.p50Tps
    : typeof row?.avgTps === 'number' && row.avgTps > 0 ? '均值 ' + row.avgTps : null;
  if (ttft === null && speed === null) return '—';
  return (ttft === null ? '' : '首字 ' + ttft) + (speed === null ? '' : (ttft === null ? '' : ' · ') + speed + ' tok/s');
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
  return '性能统计：首字时间取可测请求的算术平均；输出速率均值对离群样本敏感。'
    + '完整样本的 P50/P90 使用对数直方图估算，桶宽约 9%。'
    + '「首字」= 首个内容 chunk 到达前的耗时；'
    + '「速率」= 全部输出 token ÷（首块之后 → 结束）的时长，'
    + '要求解码时长 ≥ 100ms（过短视为不可测、不计入）。'
    + '算术均值对离群样本敏感；旧版日账本没有分布数据，完成升级后新累计的完整日期才显示 P50/P90。';
}

/** 汇总性能悬浮详情：把均值和 P90 等次要读数收进鼠标提示。 */
export function avgPerfDetailTooltip(row) {
  return avgPerfTooltip() + '\n均值 ' + (row?.avgTps ?? '—') + ' tok/s'
    + ' · P50 ' + (row?.p50Tps ?? '—') + ' tok/s'
    + ' · P90 ' + (row?.p90Tps ?? '—') + ' tok/s';
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

/** 今日的 UTC+8 日键（与服务端 utc8DayKey 同算法；用于高亮热力图当前日）。 */
export function todayDayKey() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate());
}

/**
 * GitHub 风格的每日用量格。缺失日期补 0，按 UTC+8 日期顺序排列，
 * level 0–4 按当前窗口的最大日用量分档。
 */
export function historyHeatmapCells(historyDays, days = 30, endDay = todayDayKey()) {
  const count = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
  const [year, month, date] = String(endDay).slice(0, 10).split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, date));
  const today = todayDayKey();
  const totalsByDay = new Map((Array.isArray(historyDays) ? historyDays : [])
    .filter((row) => typeof row?.day === 'string')
    .map((row) => [row.day, row]));
  const rows = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const d = new Date(end.getTime() - offset * 86400000);
    const day = d.toISOString().slice(0, 10);
    const row = totalsByDay.get(day);
    rows.push({
      day,
      isToday: day === today,
      requests: row?.totals?.requests ?? 0,
      tokens: totalTokensOf(row?.totals),
      level: 0,
    });
  }
  const maxTokens = rows.reduce((max, row) => Math.max(max, row.tokens), 0);
  for (const row of rows) {
    if (row.tokens > 0 && maxTokens > 0) {
      row.level = Math.min(4, Math.max(1, Math.ceil((row.tokens / maxTokens) * 4)));
    }
  }
  return rows;
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
