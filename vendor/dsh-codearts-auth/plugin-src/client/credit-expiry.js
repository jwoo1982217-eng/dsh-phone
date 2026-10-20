/**
 * 积分到期相关的**纯展示函数**（面板用）：
 *
 * - 把资源包按「距扣费截止还剩多久」分成临时 / 长期两桶；
 * - 按**池名**把当日刷新池单独显示（Loomy / Raccoon）；
 * - 生成账号名 hover 的**资源包列表**（按到期时间升序）。
 *
 * ## 为什么不缓存算出来的结果
 *
 * 分类是**当前时刻的函数**：宿主长期开着、时间只向前流，一笔距到期 15 天 30 秒
 * 的余额，用户什么都不做，半分钟后就成了临时积分。所以这里刻意做成纯函数，
 * 由渲染方在**每次渲染时**传当下的 `now` 现算 —— 不存 state、不设常驻定时器
 * （面板重新挂载 / 切 provider / 点「刷新积分」时数字本身也会重拉）。
 *
 * ## 与后端的关系
 *
 * 分桶判据的权威实现是后端 `src/buddy-balance-rank.ts` 的
 * `splitBuddyCreditsByExpiry()`（选号用它）。本文件是它的**展示侧同规则复刻**
 * —— 两者必须逐条一致，否则用户会看到「面板说还有 250 临时积分，选号却说没号可用」。
 *
 * ⚠️ 一致性由 `tests/unit/credit-expiry.spec.ts` 的**对账用例**锁死（同一组
 * fixture 喂两边、断言结果相同），不是靠"看起来一样"。
 *
 * ## 窗口天数从哪来
 *
 * 只能由**后端回传**（`credits.balances` 的 `windowDays`）：它可被
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖。前端不得写死 15 —— 那会出现
 * 「提示说只烧 15 天内的、实际按 31 天筛号」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化窗口天数：不可用时返回 **null**（调用方据此不显示分类行）。
 *
 * ⚠️ 必须显式挡住 `null` / `undefined`，不能直接 `Number(...)`：
 * `Number(null) === 0`，而**不带 windowDays 的 provider**（它们的积分没有
 * "会不会作废"这个维度）会被当成"窗口 0 天"、在卡片上凭空渲染出一行
 * 假的「临时 0 · 长期 N」。
 *
 * 窗口实际由后端写死为 15 天（或经 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 放宽），
 * 这里只做防御性归一，不假设任何特定取值。
 */
function normalizeWindowDays(windowDays) {
  if (windowDays === undefined || windowDays === null || windowDays === '') return null;
  const parsed = Number(windowDays);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 该包距扣费截止还剩多少天；`null` = 服务端没给到期时间。
 *
 * ⚠️ 用 `deductionEndTime`，**不是** `expiredTime`（有效包那字段一律是空串，
 * 只在真正失效后才回填）也不是 `cycleEndTime`（套餐是月度值，会把长期积分误判
 * 成快到期）。理由与实测对照见 `src/buddy-balance-rank.ts` 的文件头。
 */
export function daysUntilExpiry(pkg, now) {
  const end = pkg && typeof pkg.deductionEndTime === 'number' ? pkg.deductionEndTime : null;
  if (end === null || !Number.isFinite(end) || end <= 0) return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return (end - at) / DAY_MS;
}

/**
 * 分成 `{ expiring, permanent }` 两桶（本计费周期口径）。
 *
 * @param packages - `credits.balances` 带回来的 `balance.packages`。
 * @param windowDays - 后端回传的窗口天数。
 * @param now - **当前时刻**（渲染时传 `Date.now()`，不要传缓存值）。
 * @returns 窗口不可用时返回 `null`（调用方退化成不显示分类）。
 */
export function splitCreditsByExpiry(packages, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  if (days === null || !Array.isArray(packages)) return null;
  const windowMs = days * DAY_MS;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  let expiring = 0;
  let permanent = 0;
  for (const pkg of packages) {
    // 失效包跳过：服务端仍会返回它的余额，但那部分扣不到。
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    const end = Number(pkg.deductionEndTime);
    const known = Number.isFinite(end) && end > 0;
    // 到期时间未知归永久（保守方向：宁可少用，不可误烧长期积分）。
    if (known && end - at < windowMs) expiring += remaining;
    else permanent += remaining;
  }
  return { expiring, permanent };
}

/** 这个包属于哪一桶的中文标签（tooltip 前缀用）。 */
export function expiryBucketLabel(pkg, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '到期时间未知';
  if (days === null) return null;
  return left < days ? `${Math.ceil(left)} 天内到期` : `还有 ${Math.ceil(left)} 天`;
}

/**
 * tooltip 里每个包那一行的到期提示后缀。
 *
 * ⚠️ 拿不到窗口天数时也要给出「距到期 N 天」—— 它本身就解释了分类依据，
 * 比只显示一个 `CycleEndTime` 更可读（套餐的周期结束时间与积分有效期不是一回事）。
 */
export function formatExpiryHint(pkg, windowDays, now) {
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '';
  const days = Math.ceil(left);
  const label = expiryBucketLabel(pkg, windowDays, now);
  return label ? `距到期 ${days} 天（${label}）` : `距到期 ${days} 天`;
}

/**
 * 账号卡片上那行「长期 Y · 临时 X」的文案；无有效分类时返回 null。
 *
 * ⚠️ **长期在前、临时在后**（用户 2026-09-29 定）：与 Loomy 那行的
 * 「永久 … · 每日 …」同一顺序，两个 provider 的卡片读起来才对齐。
 * ⚠️ 用词是「长期」不是「永久」（用户 2026-09-29 定）：buddy / TRAE 的积分
 * 都有到期日，只是距现在较远 —— 说「永久」是错的（用户明确纠正过）。
 */
export function formatExpirySplitLine(split, format) {
  if (!split) return null;
  const expiring = format(split.expiring);
  const permanent = format(split.permanent);
  if (expiring === null || permanent === null) return null;
  return `长期 ${permanent} · 临时 ${expiring}`;
}

/**
 * **当日刷新池**的已知池名（服务端下发或我们合成的）。
 *
 * ## 为什么需要这份名单
 *
 * Loomy 与 Raccoon 的积分都由**多个语义不同的池**构成，其中有一个是
 * **当日刷新**的（今天不用就没了）：
 *
 * | provider | 当日池 | 其余池 |
 * |---|---|---|
 * | Loomy | `每日赠送`（每天 5000，消耗后不回补） | `永久积分`（注册奖励 + 新手任务） |
 * | Raccoon | `每日积分`（`daily_points`） | `奖励积分` / `会员积分` / `充值积分` |
 *
 * 只显示合计会丢掉最关键的信息：**今天有多少会作废**。用户明确要求
 * 「有当日积分，那应该按照 loomy 那样显示」（2026-09-29）。
 *
 * ⚠️ 用**名字**识别而不是下标：Raccoon 的池是按「服务端给了哪个字段」动态
 * push 的（`daily_points` 缺失时就没有这一项），下标会错位。
 */
export const DAILY_POOL_NAMES = ['每日赠送', '每日积分'];

/**
 * 找出当日刷新池；没有则返回 null（调用方据此不渲染分池行）。
 *
 * @param packages - `balance.packages`。
 */
export function findDailyPool(packages) {
  if (!Array.isArray(packages)) return null;
  return packages.find(pkg => pkg && DAILY_POOL_NAMES.includes(pkg.name)) ?? null;
}

/**
 * 「长期 Y · 每日 X」—— 当日池单独显示，其余池求和。
 *
 * 与 {@link formatExpirySplitLine} 的区别：那个按**到期时间**分桶（buddy / TRAE
 * 的包带 `deductionEndTime`），这个按**池名**分（Loomy / Raccoon 的池没有到期
 * 字段，是服务端按语义分开下发的）。两者互斥：一个 provider 只走其中一条。
 *
 * ⚠️ 当日池用**自己的** remaining，不用求和 —— 它就是单独一池。
 * ⚠️ 其余池求和时跳过失效包（那部分扣不到），与 `splitCreditsByExpiry` 同口径。
 *
 * @param packages - `balance.packages`。
 * @param format - 数字格式化（与卡片总额同一个 `formatCredits`）。
 * @param longTermLabel - 非当日池的标签。Loomy 用「永久」（它的池就叫永久积分），
 *   Raccoon 用「长期」（奖励/会员/充值三种池的到期规则各不相同，不能统称永久）。
 * @returns 文案；没有当日池时返回 null。
 */
export function formatPoolSplitLine(packages, format, longTermLabel = '长期') {
  const daily = findDailyPool(packages);
  if (daily === null) return null;
  const restSum = packages.reduce((sum, pkg) => {
    if (!pkg || pkg === daily) return sum;
    if (pkg.active !== true) return sum;
    const remaining = Number(pkg.remaining);
    return Number.isFinite(remaining) && remaining > 0 ? sum + remaining : sum;
  }, 0);
  const dailyValue = format(Number(daily.remaining) || 0);
  const restValue = format(restSum);
  if (dailyValue === null || restValue === null) return null;
  return `${longTermLabel} ${restValue} · 每日 ${dailyValue}`;
}

/**
 * 取出包的到期时刻（毫秒）；**拿不到返回 null**（= 没有到期概念）。
 *
 * ⚠️ 这是 `formatPackageExpiry` 与包列表**排序**共用的唯一判据来源 ——
 * 两处必须用同一个值，否则会出现「显示说 9/30 到期、排序却按别的字段排」。
 *
 * 来源优先序：`deductionEndTime`（毫秒，各 provider 后端已归一化）>
 * `expiredTime`（字符串，如 "2026-11-01 00:00:00"，给未归一化的包兜底）。
 *
 * @param pkg - 资源包。
 * @returns 毫秒时间戳；`null` = 没有到期时间（显示「长期」）。
 */
export function packageExpiryMs(pkg) {
  const dedEnd = Number(pkg && pkg.deductionEndTime);
  if (Number.isFinite(dedEnd) && dedEnd > 0) return dedEnd;
  const exp = pkg && pkg.expiredTime ? String(pkg.expiredTime) : '';
  if (exp.length > 0) {
    const ms = Date.parse(exp.replace(' ', 'T'));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/**
 * 单个包的到期时间展示：**绝对日期 + 相对天数**，拿不到到期时间显示「长期」。
 *
 * ⚠️ 到期时间取自 {@link packageExpiryMs}（与排序同一判据）。
 *
 * ⚠️ 「长期」的判据是**服务端没给任何到期字段**。Qoder 的套餐额度/资源包
 * 就没有独立到期（统一"领取后 30 天"是活动规则而非包字段），显示"长期"
 * 比编造一个错误日期好。
 */
export function formatPackageExpiry(pkg, now) {
  const end = packageExpiryMs(pkg);
  if (end === null) return '长期';
  const at = Number.isFinite(now) ? now : Date.now();
  const date = new Date(end).toISOString().slice(0, 10);
  const days = Math.ceil((end - at) / DAY_MS);
  if (days <= 0) return `${date}（已过期）`;
  return `${date}（${days} 天后）`;
}

/**
 * 资源包列表的多行文本（账号名 hover 用）。
 *
 * ## 只列**还能用**的包（用户 2026-09-29 要求）
 *
 * > 已经消耗为0的过滤掉，已经过期的过滤掉
 *
 * 三条过滤规则（命中任一即不显示）：
 *
 * | 规则 | 判据 | 为什么 |
 * |---|---|---|
 * | **已消耗完** | `remaining <= 0` | 剩余 0 的包扣不到，列出来只是噪音 |
 * | **已过期** | `packageExpiryMs(pkg) <= now` | 到期时刻已过 —— 同样扣不到 |
 * | **已失效** | `active === false` | 服务端标记失效（如退款/撤销） |
 *
 * ⚠️ **过滤必须在 `now` 上现算**，不能依赖 `active` 一个字段：
 * 实测各 provider 的 `active` 口径不一致 —— buddy 系按服务端 `Status` 字段，
 * LobsterAI 只在 `expiresAt` 已过时才算失效，而 TRAE / Qoder 的
 * `active` **恒为 true**（压根没有这个维度）。只判 `active` 会让已过期的包
 * 继续显示成"（已过期）"。
 *
 * ⚠️ **全部被过滤掉时返回 null**（调用方据此不挂 title）。若返回空串，
 * 用户 hover 会看到一个空的浮层；返回 null 则与"这个 provider 没有包列表"
 * 同一表现，干净。
 *
 * ## 排序：**最快到期的排最上面**（用户 2026-09-29 要求）
 *
 * > hover积分显示列表应该按照到期时间排序，最快到期的排到最上面，
 * > 最晚到期的排到最下面
 *
 * 这是**主排序键**。本函数是所有挂了包列表的 provider（buddy / workbuddy /
 * lobsterai / qoder / qodercn / trae）共用的，故一处改动全部生效。
 *
 * 两条配套规则：
 * - **到期时间未知的沉底**（`null` 视为 `Infinity`）。它们是「长期」那一档，
 *   语义上就是"最晚到期"；若按 0 处理会跑到最上面，恰好说反。
 * - **同一到期时刻内按剩余量降序**（次级键）。既保留"先看还有钱的包"这个
 *   原有价值，又让结果确定（不依赖引擎的稳定排序）。
 *
 * ## 截断
 *
 * 实测 CodeBuddy 中国版一个账号有 **105 个资源包**（多数是 30 天的运营裂变包），
 * 全列出来 tooltip 会长到无法阅读 ⇒ 取前 `maxRows` 个，其余汇总成一行给出
 * **合计剩余**（不丢总量信息）。
 * ⚠️ 截断发生在**过滤 + 排序之后**，故被截掉的是"最晚到期"的那批 ——
 * 用户最该关心的"快过期了"永远在最上面。
 *
 * @param packages - `balance.packages`。
 * @param options.format - 数字格式化（按包单位取 `formatUnits`）。
 * @param options.now - **渲染时**的当前时刻（过滤与排序都是时间的函数）。
 * @param options.maxRows - 最多列几个包。默认 12。
 * @returns 多行文本；无可用包时返回 null（调用方据此不挂 title）。
 */
export function formatPackageTooltip(packages, options = {}) {
  const { format, now = Date.now(), maxRows = 12 } = options;
  if (!Array.isArray(packages) || packages.length === 0) return null;
  const at = Number.isFinite(now) ? now : Date.now();

  // 只留还能用的包：剩余 > 0、未过期、未被标记失效。
  const usable = packages.filter(pkg => {
    if (!pkg || pkg.active === false) return false;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return false;
    const end = packageExpiryMs(pkg);
    // 到期时刻已过 → 扣不到，不显示（`end === null` = 长期，保留）。
    if (end !== null && end <= at) return false;
    return true;
  });
  if (usable.length === 0) return null;

  // 主键：到期时刻升序（最快到期在上）；未知到期 = Infinity（沉底）。
  // 次键：剩余量降序（同一到期时刻内先看还有钱的包）。
  const sorted = [...usable].sort((a, b) => {
    const endA = packageExpiryMs(a);
    const endB = packageExpiryMs(b);
    const keyA = endA === null ? Infinity : endA;
    const keyB = endB === null ? Infinity : endB;
    if (keyA !== keyB) return keyA - keyB;
    return (Number(b && b.remaining) || 0) - (Number(a && a.remaining) || 0);
  });
  const lines = sorted.slice(0, maxRows).map(pkg => {
    const name = (pkg && pkg.name) || '未命名';
    const remaining = format ? format(Number(pkg && pkg.remaining) || 0) : String(pkg && pkg.remaining);
    const total = format ? format(Number(pkg && pkg.total) || 0) : String(pkg && pkg.total);
    // 走到这里必然 active !== false 且未过期，故不再需要 [已失效] 标记 ——
    // 那种包已被过滤掉。保留 formatPackageExpiry 的日期与天数展示。
    return `${name}  ${remaining} / ${total}  ${formatPackageExpiry(pkg, at)}`;
  });

  const rest = sorted.slice(maxRows);
  if (rest.length > 0) {
    // 汇总行只统计能用的包（此时它们全部可用，无需再判 active）。
    const sum = rest.reduce((acc, p) => acc + (Number(p && p.remaining) || 0), 0);
    lines.push(`…另有 ${rest.length} 个包${sum > 0 ? `，合计剩余 ${format ? format(sum) : sum}` : ''}`);
  }
  return lines.join('\n');
}
