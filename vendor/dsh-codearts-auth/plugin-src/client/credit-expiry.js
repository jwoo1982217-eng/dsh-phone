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
 * 分成 `{ expiring, longTerm, permanent, earliestExpiringAt, earliestExpiringAmount }`
 * **三桶**（本计费周期口径）。
 *
 * ## 三档语义（用户 2026-10-12 明确要求）
 *
 * | 桶 | 判据 | 颜色 |
 * |---|---|---|
 * | `permanent` | **服务端没给到期时间**（真·永久，如订阅套餐包） | 绿（`ok`） |
 * | `longTerm` | 有到期时间，但**超出**窗口（还早，不急） | 黄（`warn`） |
 * | `expiring` | 有到期时间且在**窗口内**（再不用就作废） | 红（`error`）+ 倒计时 |
 *
 * ⚠️ **`permanent` 与 `longTerm` 必须分开**：首版把「到期时间未知」与「到期还远」
 * 合成一个 `permanent` 桶 —— 那会让「真永久」的积分和「30 天后到期」的积分
 * 显示成同一个颜色，用户无法分辨哪些是永远不会作废的。两桶的**选号行为相同**
 *（都不算临时），但**展示语义不同**。
 *
 * ⚠️ **返回里 `expiring` 与 `earliestExpiringAmount` 是两个不同的量**（2026-10-20）：
 *   - `expiring` = 窗口内**所有**临期批次之和（「共多少会作废」）；
 *   - `earliestExpiringAmount` = **最早那批**的量（与倒计时 `earliestExpiringAt` 配对）。
 *
 *   并排显示时必须用后者，否则「临期 20856（4 天 20 小时）」会被读成
 *   「这 20856 会在 4 天 20 小时后一起掉」，而实际只有最早那批 19656 会掉
 *   （用户 2026-10-20 原话：「怎么可能全都同一天到期」）。
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
  let longTerm = 0;
  let permanent = 0;
  /** 临期桶里**最早**的作废时刻（倒计时用）；无临期包时 `null`。 */
  let earliestExpiringAt = null;
  /**
   * **最早那批到期时刻对应的量**。
   *
   * ⚠️ 为什么需要它（2026-10-20 用户报障「怎么可能全都同一天到期」）：
   *    原实现把**窗口内所有批次**累加成 `expiring`，而倒计时
   *    `earliestExpiringAt` 只指向**最早**那一批 ⇒ 显示成
   *    「临期 20856（4 天 20 小时）」会让用户以为**这 20856 会在 4 天 20 小时后
   *    一起掉**，实际最早那批只有 19656，其余 1200 分别在 6 天 / 7 天后。
   *
   *    ⇒ 临期段的数字必须与倒计时**指向同一批**才自洽：
   *      「临期 19656（4 天 20 小时）」= 这笔会在 4 天 20 小时后作废。
   *      其余更晚的临期批次仍计入 `expiring`（总量，供 tooltip 用），
   *      但**不**与倒计时并排显示 —— 那正是误导的来源。
   */
  let earliestExpiringAmount = 0;
  for (const pkg of packages) {
    // 失效包跳过：服务端仍会返回它的余额，但那部分扣不到。
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    const end = Number(pkg.deductionEndTime);
    const known = Number.isFinite(end) && end > 0;
    if (!known) {
      // 服务端没给到期时间 ⇒ 真·永久（保守方向：宁可少用，不可误烧长期积分）。
      permanent += remaining;
      continue;
    }
    if (end - at < windowMs) {
      expiring += remaining;
      // ⚠️⚠️ **必须排除已过期的包**（2026-10-13 审计修正）：这里取的是临期桶里
      //    **最早**的作废时刻用于倒计时，而 `end` 若不约束 `> at`，那么
      //    「一个已过期但 `active` 仍为 true 的包」会**恒定当选**（它比任何
      //    未来时刻都早）⇒ `expiryCountdown` 拿到过去时刻、返回空串 ⇒
      //    **整段倒计时消失**，尽管桶里还有一笔钱几天后作废。
      //    ⚠️ 可达性不是假设：TRAE 的 `active` 是**硬编码 true**
      //    （`trae-credits.ts`），压根不反映是否过期。
      //    `trae-credits.ts`），压根不反映是否过期。
      //    方向：宁可少显示倒计时，不可显示一个错的。
      if (end > at && (earliestExpiringAt === null || end < earliestExpiringAt)) {
        // ⚠️ 出现**更早**的批次 ⇒ 该量取代之前的（两批不是同一批，不能相加）。
        earliestExpiringAt = end;
        earliestExpiringAmount = remaining;
      } else if (end > at && end === earliestExpiringAt) {
        // 同一批次（同刻并列）⇒ 累加。
        earliestExpiringAmount += remaining;
      }
    } else {
      longTerm += remaining;
    }
  }
  return { expiring, longTerm, permanent, earliestExpiringAt, earliestExpiringAmount };
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
 * 账号卡片上那行「永久 Y · 长期 Z · 临期 X」的文案；无有效分类时返回 null。
 *
 * ⚠️ **三档顺序固定：永久 → 长期 → 临期**（用户 2026-10-12 定）：
 * 与「余额由远及近」的直觉一致，且临期放最后便于一眼扫到。
 *
 * ⚠️ 用词「长期」不是「永久」（用户 2026-09-29 定）：有到期日的积分即使很远
 * 也不能叫永久 —— 说「永久」是错的（用户明确纠正过）。只有**服务端没给
 * 到期时间**的才是真·永久。
 *
 * @param split - `splitCreditsByExpiry` 的返回值。
 * @param format - 数值格式化函数（按单位）。
 * @returns 单行文本；全为 0 或不可分类时返回 `null`。
 */
export function formatExpirySplitLine(split, format) {
  if (!split) return null;
  const parts = [];
  // 只显示**非零**桶：0 值进文案只会让一行变长而无信息（用户看不到「永久 0」的价值）。
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  const expiring = split.expiring > 0 ? format(split.expiring) : null;
  if (permanent !== null) parts.push(`永久 ${permanent}`);
  if (longTerm !== null) parts.push(`长期 ${longTerm}`);
  // ⚠️ 与 `expirySplitParts` 同口径：临期显示**最早那批**的量
  //    （这条字符串版本不带倒计时，故仍用窗口内总额更合适 —— 它表达的是
  //     「窗口内共有多少会作废」，不含「何时」）。
  //    ⇒ 两者语义刻意不同：字符串版是「总量」（无时间承诺），
  //      分段版是「最早那批」（与倒计时配对）。见 `expirySplitParts` 的注释。
  if (expiring !== null) parts.push(`临期 ${expiring}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 三档分桶的**带色分段**（供胶囊/卡片逐段渲染，各带各的 tone）。
 *
 * ## 为什么需要它（而不是复用 `formatExpirySplitLine` 的字符串）
 *
 * 字符串版本把三档拼成一句、只能整体一个颜色 —— 而用户要的正是
 * 「永久绿 / 长期黄 / 临期红」（2026-10-12 明确要求）。React 侧要逐段渲染
 * 才能各带 `data-tone`，故这里返回**结构化分段**。
 *
 * 临期段额外带**倒计时**（`倒计时` 字段），因为「临期 100」只说了有多少会作废，
 * 没说**还有多久** —— 而那正是要补的决策信息。
 *
 * @returns `[{ key, text, tone, countdown? }]`；无内容时 `[]`。
 *   `tone` 取值限定在 CSS 里已有的 `ok` / `warn` / `error`。
 */
export function expirySplitParts(split, format, now) {
  if (!split) return [];
  const parts = [];
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  const expiring = split.expiring > 0 ? format(split.expiring) : null;
  if (permanent !== null) parts.push({ key: 'permanent', text: `永久 ${permanent}`, tone: 'ok' });
  if (longTerm !== null) parts.push({ key: 'longTerm', text: `长期 ${longTerm}`, tone: 'warn' });
  if (expiring !== null) {
    const at = split.earliestExpiringAt;
    const countdown = typeof at === 'number' && Number.isFinite(at) && at > 0
      ? expiryCountdown(at, now)
      : '';
    // ⚠️ **数字与倒计时必须指向同一批**（2026-10-20 用户报障修正）：
    //    `split.expiring` 是窗口内**所有**临期批次之和，而倒计时指向最早那批
    //    ⇒ 并排显示会误导成「这 X 会在倒计时后一起掉」。
    //    故这里取 `earliestExpiringAmount`（最早那批的量）与倒计时配对。
    // ⚠️ 回退方向：拿不到该量（老后端没回传）时退回 `expiring`（总额），
    //    宁可数字偏大，不可不显示临期。
    const shown = Number.isFinite(split.earliestExpiringAmount) && split.earliestExpiringAmount > 0
      ? split.earliestExpiringAmount
      : expiring;
    parts.push({
      key: 'expiring',
      text: `临期 ${format(shown)}`,
      tone: 'error',
      ...(countdown.length > 0 ? { countdown } : {}),
    });
  }
  return parts;
}

/**
 * 临期积分的**粗粒度**倒计时（「3 天 4 小时」/「5 小时 20 分钟」/「9 分钟」）。
 *
 * ⚠️ 粗粒度是刻意的：这是一眼扫过的信息，秒级精度只会让面板无谓重渲染。
 * ⚠️ 已过期 / 不可解析返回**空串**（调用方不渲染倒计时，而不是显示「已过期」）。
 */
export function expiryCountdown(expiresAtMs, now) {
  const at = Number(expiresAtMs);
  if (!Number.isFinite(at) || at <= 0) return '';
  const ref = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  // ⚠️ 已过期与「还没过期」必须分道：前者返回空串（调用方不渲染）。
  if (at <= ref) return '';
  // ⚠️⚠️ **用向上取整而不是 `Math.round`**（2026-10-13 审计修正）：
  //    round 会把「剩余 0~30 秒」也归到 0，于是用户看到倒计时一路数到
  //    「1 分钟」后**整段突然消失** —— 而「马上就作废」恰恰是最该看到的信号。
  //    向上取整让「还没过期」恒定至少显示 1 分钟。
  const minutes = Math.ceil((at - ref) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
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
 * **逐命名池全列** —— 供 Accio 的三类桶使用（用户 2026-10-13 要求与 Loomy 同形）。
 *
 * ## 与 {@link formatPoolSplitLine} 的区别（为什么不能复用它）
 *
 * `formatPoolSplitLine` 是**两桶**形状：它把「当日池之外的**全部**池」求和成一个
 * `longTermLabel`（`'长期 2100 · 每日 500'`）。那对两家的形态成立：
 *
 * | provider | 池 |
 * |---|---|
 * | Loomy | `永久积分` + `每日赠送` |
 * | Raccoon | `奖励积分` / `会员积分` / `充值积分` + `每日积分` |
 *
 * 而 Accio 的桶是**三类语义并列**（`每日积分` / `每月积分` / `推荐积分`）：
 * 「每月」与「推荐」**都不该被笼统求和成「长期」** —— 它们的到期规则不同
 * （每月有 `nextBillingDate`、推荐是活动赠送），求和会让用户以为是一份东西。
 *
 * ## 为什么按**服务端下发的顺序**列出，不排序
 *
 * 池的顺序由宿主 `flattenAccioCredits` 决定（`daily` → `monthly` → `referral`，
 * 即「最先作废的在前」）。前端再排一次就是「同一语义两处判据」——排序规则
 * 一变就会与宿主的意图分叉。
 *
 * ⚠️ **不改 `formatPoolSplitLine`**：它的输出是既有契约（见 `credit-expiry.spec.ts`
 * 那组逐字断言），而 loomy / raccoon 走的正是它。
 *
 * @param packages - `balance.packages`。⚠️ 按**池名**识别，不用下标
 *   （Raccoon / Accio 的池都可能缺项）。
 * @param format - 数字格式化（与卡片总额同一个）。
 * @returns 形如 `'每日 199 · 每月 0 · 推荐 0'` 的文案；无可列池或格式化失败时
 *   返回 `null`（调用方据此不渲染该行，退回别的分桶）。
 */
export function formatNamedPoolLine(packages, format) {
  if (!Array.isArray(packages)) return null;
  const parts = [];
  for (const pkg of packages) {
    // 失效包不列出：扣不到的额度显示出来会让用户以为还有。
    if (!pkg || pkg.active !== true) continue;
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
    if (name === '') continue;
    const value = format(Number(pkg.remaining) || 0);
    // ⚠️ 任一格式化失败 ⇒ 整个函数返回 null（不产出半截文案）。
    if (value === null) return null;
    // 「每日积分 199」在版面上重复且长 ⇒ 去掉「积分」后缀做短标签。
    // ⚠️ 只在**后缀**时去掉（`'积分商城'` 这类名字不受影响）。
    const short = name.endsWith('积分') ? name.slice(0, -2) : name;
    parts.push(`${short} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
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
