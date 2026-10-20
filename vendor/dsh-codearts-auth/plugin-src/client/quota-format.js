/**
 * 订阅额度窗口的**标签 / 排序 / 百分比 / 倒计时**（纯函数，不依赖 react）。
 *
 * ## 为什么单独成模块
 *
 * 这些函数原先住在 `jet-hub.js`（Jet Hub 设置页的「订阅额度」面板用），而
 * 会话输入区的**用量徽标**（`usage-badge.js`）要显示同一份读数。`jet-hub.js`
 * 顶部 `import * as React from 'react'`，react 是宿主注入的 external
 * （node_modules 里没有），任何 import 它的模块在 vitest 里都跑不起来 ——
 * 徽标的折叠态文案必须可单测，故把这些纯函数搬出来。
 *
 * ⚠️ **不要**在徽标里另写一套窗口顺序 / 百分比夹取：两个界面显示同一个网关读数，
 * 口径必须逐字一致（同一份读数在两个界面里不能给出不同结论）。
 */

/**
 * 已知额度窗口及其**固定顺序**。
 *
 * ⚠️ 已知窗口按此顺序排在前，网关下发的**未知窗口追加在后** ——
 * 纯按网关原序会让新窗口插到中间，同一账号两次读数的排列可能不同。
 */
export const QUOTA_WINDOWS = Object.freeze([
  ['five_hour', '5 小时'],
  ['weekly', '本周'],
  ['monthly', '本月'],
]);

/**
 * 额度窗口类型 → 中文标签。
 *
 * ⚠️ **未识别的类型原样显示**，而不是丢弃或归入「其它」：网关新增窗口
 * （例如将来的 `daily`）时，面板立刻就能显示出新窗口，不必等插件发版 ——
 * 这与后端「窗口按网关原序透传、不映射到固定形状」是同一个设计。
 */
export function quotaWindowLabel(type) {
  const known = QUOTA_WINDOWS.find(([id]) => id === type);
  return known === undefined ? type : known[1];
}

/**
 * 窗口排序：**已知窗口按固定顺序在前，未知窗口追加在后**。
 * 这样网关新增窗口（如 `daily`）时面板立刻多一行，不必为它发插件版本。
 * @returns `[type, label, window]` 三元组数组。
 */
export function quotaWindowsOf(windows) {
  const known = new Map(windows.map((win) => [String(win.type), win]));
  const ordered = QUOTA_WINDOWS
    .filter(([type]) => known.has(type))
    .map(([type, label]) => [type, label, known.get(type)]);
  const extra = windows
    .filter((win) => !QUOTA_WINDOWS.some(([type]) => type === String(win.type)))
    .map((win) => [String(win.type), String(win.type), win]);
  return [...ordered, ...extra];
}

/**
 * 额度重置的**粗粒度**倒计时：
 * 「3 天 4 小时」/「4 小时 5 分钟」/「5 分钟」。
 *
 * ⚠️ 粗粒度是刻意的：额度重置是一眼扫过去的信息，秒级精度只会让面板
 * 无谓重渲染，对用户也没有意义。
 * 已过期 / 缺失 / 不可解析一律返回**空串**（不显示「已过期」这类噪音）。
 */
export function quotaCountdown(resetsAt) {
  const at = Date.parse(String(resetsAt ?? ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return '';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${Math.max(1, mins)} 分钟`;
}

/** 「{倒计时}后重置」；没有可读倒计时时返回空串（那一行不渲染）。 */
export function quotaResetsIn(resetsAt) {
  const left = quotaCountdown(resetsAt);
  return left === '' ? '' : `${left}后重置`;
}

/**
 * 额度百分比 → 色调（三档）：≥90 红 / ≥70 黄 / 其余绿。
 *
 * ⚠️ 只给「值得反应」的两档染色，正常读数保持绿色 —— 全部染成品牌蓝会让
 * 「用掉九成」和「用掉一成」看起来一样，额度条就失去了警示作用。
 */
export function quotaTone(percent) {
  if (!Number.isFinite(percent)) return 'ok';
  if (percent >= 90) return 'error';
  if (percent >= 70) return 'warn';
  return 'ok';
}

/**
 * 百分比取值：**先夹取到 0–100**。
 * 进度条宽度与百分比文案共用这一个值，两者口径必须一致。
 */
export function quotaPercentValue(percent) {
  const n = Number(percent ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** 百分比文案：夹取后**四舍五入到整数**。 */
export function formatQuotaPercent(percent) {
  return `${Math.round(quotaPercentValue(percent))}%`;
}
