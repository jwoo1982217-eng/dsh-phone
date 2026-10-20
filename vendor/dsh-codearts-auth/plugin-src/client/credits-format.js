/**
 * 积分 / token 数值的**格式化**（纯函数，不依赖 react）。
 *
 * ## 为什么单独成模块
 *
 * 这四个函数原先住在 `jet-hub.js` 里，只有 Jet Hub 设置页用得到。会话输入区
 * 那枚**用量徽标**（`usage-badge.js`）同样要显示余额，而它的「折叠态一行文案」
 * 逻辑必须可单测 —— `jet-hub.js` 顶部 `import * as React from 'react'`，而
 * 本仓库的 node_modules 里**没有 react**（它是 esbuild 的 external，由宿主注入），
 * 故任何 import 它的模块在 vitest 里都跑不起来。
 *
 * 拆出来之后：
 * - `badge-model.js`（纯逻辑）能直接 import 本模块并被单测覆盖；
 * - 数值格式化的口径只有一份 —— 徽标与设置页**不可能**显示出两个不同的数字
 *   （这正是「搬出去」而不是「再写一份」的理由）。
 *
 * ## ⚠️ 单位的唯一消费点
 *
 * {@link normalizeUnit} / {@link formatUnits} / {@link unitLabel} 是 `unit` 字段的
 * 全仓消费点。加新单位（如 `credit`）时改这里，**不要**在渲染处写
 * `if (provider === 'zcode')` 那种分支 —— 那会漏掉别的 provider，且徽标与设置页
 * 会各写一份。
 *
 * ## ⚠️ 单位必须先归一，再当**分组键**用（真实缺陷，2026-10-03）
 *
 * 用户报障：WorkBuddy 国际版有**两个账号**，胶囊却显示成
 * `WorkBuddy (国际版) • 341.78积分 · 100积分`（两个数并排），账号再多就成一长串。
 *
 * 根因不是「多账号没法合计」，而是**服务端把同一个单位拼成两种写法**。实测
 * （`probe-workbuddy-units.mjs` 逐包打印原值）：
 *
 * | 账号 | 包 | `unit` 原值 |
 * |---|---|---|
 * | `…01CC739A` | Bonus Pack 241.78 / Free Plan Subscription 100 | `credit` / `credits` |
 * | `…297957E1` | Free Plan Subscription 100 | `credits` |
 *
 * 折叠态按**原始字符串**分组（`credit` ≠ `credits`）⇒ 两个账号落进两个分组 ⇒
 * 渲染成两个「积分」。而 {@link unitLabel} 把两者都显示成「积分」——**同一句话里
 * 出现两个一模一样的单位标签**，用户只能读成「把所有号的积分都列出来了」。
 *
 * ⚠️ 口径：**分组键必须与展示名同源**。凡是 {@link unitLabel} 会显示成「积分」的
 * 单位串，就必须落进同一个分组；否则文案里必然出现 `A积分 · B积分` 这种把同一
 * 单位拆成两段的形态。故分组键一律走 {@link normalizeUnit}，**不要**用原值。
 *
 * ⚠️ `token` 与积分**不可互相折算**，故仍分成两组并列显示（ZCode 是 token，其余
 * 是积分）——归一化只收敛同义写法，不跨量纲求和。
 */

/**
 * 把积分余额格式化成一行文案。
 *
 * 保留两位小数：服务端下发的精确值就是两位（如 247.87），而整数版字段
 * 会截断成 247 —— IDE 顶部显示的 "Credits Balance 347.87" 用的是精确值，
 * 这里必须对齐，否则用户会以为插件算错了。
 */
export function formatCredits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // 整数不显示多余的小数位（100 而不是 100.00），有小数才保留两位
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * 把 **token 计数**格式化成人类可读的 `xx.yyM` / `x.yyK`。
 *
 * ## ⚠ 为什么需要它（真实缺陷）
 *
 * 用户报障：「智谱 plan 给的不是积分是 tokens，应该显示 `Token: xx.yyM` 这种格式」。
 *
 * 上游 `billing/balance` 的桶里有明确单位声明（实测）：
 * ```json
 * { "meter": "model_usage", "unit_type": "token",
 *   "total_units": 100000000, "remaining_units": 94539275 }
 * ```
 * Host 侧已如实标注 `unit: 'token'`，但客户端此前**完全不消费 `unit`** ——
 * 于是界面显示 `94539275`（无单位、看起来像 1 亿积分，量级也读不出来）。
 *
 * 规则（与常见 token 展示一致）：
 *   - `>= 1e6` → `94.54M`
 *   - `>= 1e3` → `945.39K`
 *   - 其余     → 原样整数
 *
 * ⚠ 小数位**固定两位**（`94.54M` 而不是 `94.5M`）：token 余额的百位变化
 * 对用户有意义（差 0.04M = 4 万 token），一位小数会把它们抹平。
 */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

/**
 * 配额窗口的单位标记：**剩余百分比**（Gemini 的 Cloud Code 免费线）。
 *
 * 它不是积分也不是 token，而是「这个时间窗还剩百分之几」。目前只有
 * Gemini 一个 provider 用它，故这里是**唯一的** `%` 判定点。
 */
export const QUOTA_UNIT = '%';

/**
 * 把**配额百分比**格式化成 `95%`。
 *
 * ## ⚠️ 为什么不能复用 `formatCredits`
 *
 * 用户报障原文：「95 积分；为什么显示的是积分不是额度，计划里应该说了会显示额度」。
 *
 * 成因之一就在这里：配额窗口的读数是 `94.5`（两窗口剩余比例的均值），
 * `formatCredits` 见它不是整数就补两位小数 ⇒ 面板显示 `94.50`。
 * 百分比语境下那个小数位是**假精度**（上游只给整数百分比），
 * 而用户会把它读成「94.5 个积分」——数字与标签一起把人带偏。
 *
 * 取整后加 `%`：`95%`。四舍五入与 `quota-format.js` 的
 * `formatQuotaPercent` 同口径（同一份上游读数，两个界面不能显示出两个数）。
 */
export function formatQuota(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value)}%`;
}

/**
 * 把单位串归一到**展示口径**，返回 `'token'` 或 `'credit'`。
 *
 * ⚠️ 这不是「格式化偏好」，而是**语义等价类的代表元**：服务端对同一个单位有多种
 * 拼法（实测 `credit` / `credits` / 空串；`USD`、`积分` 等历史写法同理），而
 * {@link unitLabel} 只认 `token` 一个特例 —— 其余**全部**显示成「积分」。
 * 于是「展示口径」天然只有两类，故这里也只返回两类。
 *
 * ⚠️ **分组键（`creditGroupsOf` / `planGroupsOf`）必须用它**，不能用原值：
 * 用原值会让 `credit` 与 `credits` 各成一组，渲染出两个「积分」（见文件头表）。
 * 归一化之后，胶囊对**任意账号数**都只有一个数字 —— 这正是用户要的「一共能用」。
 *
 * ⚠️ **配额单位（{@link QUOTA_UNIT}）不参与归一**：它既不是 token 也不是积分，
 * 归成 credit 会把 Gemini 的窗口百分比混进积分合计里求和。调用方（分组键）必须
 * 先判 `QUOTA_UNIT` 再落到这里 —— 见 `badge-model.js` 的 `groupKeyOf`。
 *
 * ⚠️ 与宿主侧 `src/credits.ts` 的 `normalizeCreditUnit` **必须逐字等价**
 * （宿主算套餐读数、客户端算余额分组，两边不一致会出现「套餐一个单位、余额另一个」
 * 这种自相矛盾）。一致性由 `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
 */
export function normalizeUnit(unit) {
  return unit === 'token' ? 'token' : 'credit';
}

/**
 * 按**单位**选择格式化函数。
 *
 * ⚠ 这是 `unit` 字段的唯一消费点 —— 加新单位（如 `credit`）时改这里，
 * 不要在渲染处写 `if (provider === 'zcode')` 那种分支（会漏掉别的 provider）。
 */
export function formatUnits(value, unit) {
  if (unit === 'token') return formatTokens(value);
  if (unit === QUOTA_UNIT) return formatQuota(value);
  return formatCredits(value);
}

/**
 * 单位的展示名（账号卡片与徽标上的标签）。
 *
 * ⚠️ 用词是**「额度」不是「积分」**：配额窗口答的是「还剩多少百分比」，
 * 说成积分就是**撒谎**（计划 §3.3 明确要求「不要假装成积分数字」）。
 * 其余单位（含空串/未登记）保持「积分」——那才是它们的真实语义。
 */
export function unitLabel(unit) {
  if (unit === 'token') return 'Token';
  if (unit === QUOTA_UNIT) return '额度';
  return '积分';
}

/**
 * 把**按单位分组的领取所得**拼成一段文案：`+100.00MToken, +100积分`。
 *
 * ## ⚠️ 为什么需要它（真实缺陷，用户报障 2026-10-04）
 *
 * 用户报障原文：
 * > 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
 * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
 * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
 *
 * 根因是宿主 `summary.totalCredit` 把不同量纲**加成了一个标量**：ZCode 的
 * 1 亿 token 与其余渠道的 100 积分相加得 `100000100`，客户端拿到时已经无从
 * 分辨单位。修法是宿主新增 `totalByUnit`（见 `src/types.ts`），客户端改用它。
 *
 * ⚠️ **每个单位各带一个 `+`**（不是整段共用一个）：这是用户给出的期望文案的
 * 形态（`+100Mtoken, +100积分`）。整段共用会渲染成 `+100Mtoken, 100积分`，
 * 第二个单位看起来像「不是本次领到的」。
 *
 * ⚠️ 函数名带 **Gains**：`+` 是「本次获得」的语义，**不要**拿它渲染余额
 *（余额没有 `+`）。把 `+` 放进本函数而不是留给调用方拼，是为了两处界面
 * 不漂移 —— 本仓库已有多次「各拼各的」先例。
 *
 * ⚠️ **顺序固定 token → credit**（不是字母序）：用户给出的期望文案就是
 * token 在前。顺序固定也让渲染稳定，不因对象键序变化而抖动。
 *
 * ⚠️ 只列**非零**单位：给「本次没有 token 领取」的渠道渲染 `+0Token` 是噪音。
 * 全为零 / 无该字段时返回 `null`，调用方据此**整段不渲染**。
 *
 * ⚠️ **`totalByUnit` 缺失时的兜底不在这里**：那是调用方的事（旧宿主响应只有
 * `totalCredit`，调用方按 `{ credit: totalCredit }` 补）。本函数只认它拿到的
 * 结构，不做跨字段猜测 —— 猜错会把 token 报成积分，正是本次缺陷。
 *
 * ⚠️ 与宿主 `src/credits.ts` 的 `formatClaimGains` **必须逐字等价**：自动签到的
 * 逐渠道文字由宿主产出并落盘，手动签到的文字由客户端现场拼 —— 同一件事在两个
 * 界面里不能出现两种写法。一致性由 `tests/unit/claim-unit-parity.spec.ts` 锁死。
 *
 * @param totals - `{ token?, credit? }`（缺失的键按 0 处理）。
 * @returns 形如 `+100.00MToken, +100积分`；全为零 / 入参非法时 `null`。
 */
export function formatClaimGains(totals) {
  if (totals === null || typeof totals !== 'object') return null;
  const parts = [];
  // ⚠️ 固定顺序：token 在前（与用户给出的期望文案一致），不依赖对象键序。
  for (const unit of ['token', 'credit']) {
    const value = Number(totals[unit]);
    if (!Number.isFinite(value) || value <= 0) continue;
    parts.push(`+${formatUnits(value, unit)}${unitLabel(unit)}`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * 把**配额窗口包**渲染成一行：「5 小时窗口 95% · 周窗口 99%」。
 *
 * 这是计划 §3.3 承诺的面板形状（「面板会显示『5 小时窗口 99% / 周窗口 99%』
 * 而非『N 积分』」）。只在单位是 {@link QUOTA_UNIT} 时生效，其余单位返回
 * `null` ⇒ 调用方原样走积分 / token 的老分支，**零影响**。
 *
 * ⚠️ 与徽标共用本函数（见 `usage-badge.js` 的 `splitLine`）：同一份上游读数
 * 在两个界面里必须逐字一致，这是本文件头那条铁律的延伸。
 *
 * ⚠️ 逐窗口用**各自的** remaining，不做求和：窗口是并行的配额，不是可累加的
 * 余额（求和的含义是「一共还剩多少」——百分比没有那个语义）。
 *
 * @param packages - `balance.packages`。
 * @param unit - 已判定的单位（调用方从包上取，避免两处判定漂移）。
 * @returns 一行文案；非配额单位 / 无有效包时返回 `null`。
 */
export function formatQuotaLine(packages, unit) {
  if (unit !== QUOTA_UNIT || !Array.isArray(packages)) return null;
  const parts = [];
  for (const pkg of packages) {
    if (!pkg) continue;
    const value = formatQuota(pkg.remaining);
    if (value === null) continue;
    parts.push(`${pkg.name || '未命名'} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 配额窗口包的 hover 明细（每包一行）。
 *
 * ⚠️ **不能复用 `formatPackageLine`**：那条渲染的是 `剩余 / 总额`（`95 / 100`），
 * 在配额语境下会被读成「95 个积分，一共 100 个」——而真相是「还剩 95%」。
 * 窗口的重置时刻用「重置于」而不是「本周期至」：配额是滚动重置的额度，
 * 不是按月结算的套餐周期。
 */
export function formatQuotaDetail(packages) {
  if (!Array.isArray(packages)) return null;
  const lines = [];
  for (const pkg of packages) {
    if (!pkg) continue;
    const value = formatQuota(pkg.remaining);
    if (value === null) continue;
    const reset = typeof pkg.cycleEndTime === 'string' && pkg.cycleEndTime.length > 0
      ? ` · 重置于 ${pkg.cycleEndTime}`
      : '';
    lines.push(`${pkg.name || '未命名'}：剩余 ${value}${reset}`);
  }
  return lines.length === 0 ? null : lines.join('\n');
}
