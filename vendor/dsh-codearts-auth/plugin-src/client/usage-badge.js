/**
 * 用量徽标 —— 会话输入区（模型选择器旁）那枚读数。
 *
 * ## 形态
 *
 * 挂在 `conversation.input.right` 插槽：折叠态是一枚胶囊（`Cline · 5 小时 6% ·
 * 本周 2%`），点击展开完整浮层。三条基本做法：**只在选中本插件渠道时渲染**、
 * **60 秒轮询且隐藏页跳过**、**读取失败保留上一次成功读数**；在此之上按 jet-hub
 * 的多渠道与「签到领积分」定位扩展成：订阅优先 / 积分兜底 + 逐账号明细 + 一键签到。
 *
 * ## 渲染门控（三道，全部在**发请求之前**）
 *
 * 1. 目录快照里必须有当前模型（`current.provider`）；没有就整体不渲染；
 * 2. 该 provider 必须在**能力表**里具备余额能力（`supportsCreditBalance`，
 *    12 个渠道全为真）—— 判定来自能力表而不是 `PROVIDERS.includes()`，
 *    与设置页同一真相源；
 * 3. 其余（有没有账号、账号是否启用）由宿主返回后决定显示成「未配置启用账号」，
 *    此时宿主**不会**产生任何上游请求（账号列表为空 ⇒ 余额分支空转）。
 *
 * 非本插件的模型（如 DeepSeek 官方）在第 2 道就被挡掉：**不渲染、不发请求**。
 *
 * ## 与设置页的分工
 *
 * 徽标只回答「现在还剩多少、要不要现在用」；账号增删改、模型开关、备份等仍在
 * Jet Hub 设置页。弹窗因此刻意做得很薄：读 + 刷新 + 签到 + 切换显示偏好。
 */

import * as React from 'react';

import { supportsCreditBalance, supportsDailyCheckin, checkinProviders } from './credits-capabilities.js';
import { AGGREGATE_PROVIDER_ID, resolveBadgeProvider } from './badge-model.js';
import {
  badgeView,
  creditSectionLabel,
  describeBadgeError,
  formatUpdatedAt,
  orderCreditRows,
  BADGE_PREFERENCES,
  BADGE_PREFERENCE_LABELS,
} from './badge-model.js';
import {
  quotaWindowsOf,
  quotaResetsIn,
  quotaTone,
  quotaPercentValue,
  formatQuotaPercent,
} from './quota-format.js';
import { formatUnits, formatQuotaLine, formatClaimGains, unitLabel, QUOTA_UNIT } from './credits-format.js';
import {
  formatExpirySplitLine,
  formatPoolSplitLine,
  splitCreditsByExpiry,
} from './credit-expiry.js';

/**
 * 轮询间隔：60 秒。宿主侧还有 TTL 缓存（成功 120s / 全部失败 15s），故真实的
 * 上游余额请求最多每两分钟一轮，60 秒足以让读数不长期停在过期值上。
 *
 * ⚠️ 它与宿主侧 TTL 是**两层**：这里决定「多久问一次宿主」，宿主那边决定
 * 「多久问一次上游」。宿主默认 120s，故真实的账号余额请求最多每两分钟一轮。
 * 隐藏的标签页会被跳过（见下面的 `visibilityState` 判定）。
 */
export const BADGE_POLL_MS = 60_000;

/**
 * 「聚合上次选中的渠道」的查询节奏（**独立于** {@link BADGE_POLL_MS}）。
 *
 * ## ⚠️ 为什么必须比 60 秒快得多
 *
 * 那个查询是**纯内存读**（宿主 `aggregate.activeProvider` 不碰网络、不查余额），
 * 成本可忽略；而它决定的是「徽标显不显示、显示哪个渠道」——
 *
 * - **首次**：聚合下第一次转发成功之前没有历史 ⇒ 徽标不渲染。若沿用 60 秒，
 *   用户发完消息后**最多要等 60 秒**才看到徽标出现，观感就是「徽标坏了」。
 * - **切换**：聚合层换了候选之后，渠道要跟着变。规格 §6.4 正是**因为
 *   「最长 60 秒才更新，观感是『徽标不跟着变』」而否决了「只靠轮询」那个方案**
 *   —— 所以这里不能沿用 60 秒。
 *
 * ⚠️ **不要**把这个值合并进 `BADGE_POLL_MS`：那个常量管的是**余额读数**
 * （要经宿主打上游，宿主 TTL 120s），缩短它会让上游请求变密；
 * 本常量管的只是**一次内存读**。两者成本差几个数量级，节奏理应不同。
 */
export const ACTIVE_PROVIDER_POLL_MS = 5_000;

/**
 * 签到结果摘要的**自动消失**时长。
 *
 * 用户报障（2026-10-02）：「签到后下方显示的文字久久都不消失」—— 摘要原先会一直
 * 留在弹窗里，直到下一次签到或切换渠道才被替换，等于常驻噪音。
 *
 * 两档而不是一档：成功摘要一眼扫完即可；**警告与「需要你操作」的提示**（凭证失效、
 * 「请先用官方客户端登录一次」之类）要留出阅读与照做的时间，故给 20 秒。
 */
export const CLAIM_NOTICE_MS = 8_000;
export const CLAIM_NOTICE_WARN_MS = 20_000;

/**
 * 弹窗里积分列表**折叠前**显示的账号数（用户 2026-10-03 要求）。
 *
 * 取 5 而不是 3：普通用户手里多是 2–3 个号，5 行以内不折；而 6 个号原本是
 * **十二行**（每个号两行：数值 + 分桶说明），足够把弹窗撑得比窗口还高。
 *
 * ⚠️ 折叠**不隐藏任何结论**：合计在节标题、读取失败数在脚注，两者都在折叠之外。
 * 收起来的只是逐账号明细 —— 那份明细本来就是「要核对时才看」的东西。
 */
export const CREDITS_COLLAPSED_LIMIT = 5;

/**
 * 目录解析失败后的重试退避（毫秒）。
 *
 * ⚠️ 覆盖「宿主在该槽位注入期还没接上 `remote.session`」这一实际情形
 * （桌面版）：挂载时抛错，几秒后可能就绪。共 5 次、总计约 4.6 秒，
 * 之后安静放弃 —— 再长就变成用户可感知的「徽标迟迟不出来」。
 */
const RESOLVE_RETRY_DELAYS = [300, 700, 1500, 2000];

/**
 * 徽标本体：只做门控，真正的工作在 {@link UsageBadgeActive}。
 *
 * ## ⚠️⚠️ 目录必须**惰性解析且容错**（真机事故 2026-10-02）
 *
 * 宿主侧的槽位 inject 传下来的是 `resolveDirectory()`（**函数**）而非
 * `directory`（对象）—— 因为 `ctx.modelDirectories.directoryFor(sessionId)`
 * 是**惰性 getter**，在 inject 期求值时，桌面版会抛
 * `cannot get property "remote.session" without inject`。
 * 那个异常发生在**会话输入区的同步渲染路径**上，会让模型选择器整个点不动
 * （用户报障），比「徽标不显示」严重得多。
 *
 * ⇒ 这里在 effect 里解析目录，任何失败都只让**徽标**不渲染：
 * `useSyncExternalStore` 的三个回调因此不会把异常抛回宿主渲染树。
 */
export function UsageBadge(props) {
  const resolveDirectory = props.resolveDirectory;
  // 已解析的目录对象；null = 还没解析出来（首帧必然如此）。
  const [directory, setDirectory] = React.useState(null);
  // ⚠️ 已解析出目录就不再重跑：若宿主每次渲染都重建 inject 的返回对象，
  // `resolveDirectory` 的函数身份就会变 → effect 反复重启 →
  // 重试计时器被无限清除、永远解析不出来（比不重试还糟）。
  // 「非 null 就跳过」既省了重复解析，也天然挡住了这个循环。
  const resolvedRef = React.useRef(false);
  /** 快照读取异常只记一次（见 safe() 处说明）。 */
  const snapshotErrorRef = React.useRef(false);

  // 惰性解析 + **有限重试**。
  //
  // ## 为什么必须重试（真机事故 2026-10-02 的第二次）
  //
  // 桌面版上 `ctx.modelDirectories.directoryFor(sessionId)` 会抛
  // `cannot get property "remote.session" without inject`（宿主在该槽位
  // 注入期还没把 `remote.session` 接上）。我第一版修法是「try/catch 吞掉」，
  // 结果**异常没了、徽章也永远不显示** —— 把崩溃换成了静默失败，
  // 比原问题更难发现（用户报障：d8405aa 之前徽标是好的，之后就没了）。
  //
  // ⇒ 解析失败**不等于永远不可用**：宿主可能在挂载之后才补齐注入。
  // 故按退避序列重试若干次，每次成功即停止；全失败才安静放弃
  // （此时徽标不显示，但**不影响**会话输入区与模型选择器）。
  //
  // ⚠️ **只保留失败路径的 console.warn，不再有定位用的 console.info**
  // （2026-10-02 清理）。那批 info 是为追 desktop 徽标问题临时加的，
  // 问题已修好，留着只会污染用户控制台。它们唯一留下的价值已经写进本注释
  // 与回归断言 —— 教训（别静默吞异常）不该靠刷屏来保存。
  React.useEffect(() => {
    if (typeof resolveDirectory !== 'function') return undefined;
    if (resolvedRef.current) return undefined;
    let alive = true;
    const timers = [];
    let attempt = 0;
    const tryResolve = () => {
      if (!alive || resolvedRef.current) return;
      let resolved = null;
      try {
        resolved = resolveDirectory();
      } catch {
        // 失败不在此处上报 —— 重试全用尽时统一 warn 一次（避免刷屏）。
        resolved = null;
      }
      if (!alive) return;
      if (resolved !== null && resolved !== undefined && resolved.store !== undefined) {
        resolvedRef.current = true;
        const store = resolved.store;
        setDirectory(store);
        // ⚠️⚠️ **必须自己调 `load()`**（真机事故 2026-10-02 的真正根因）：
        // `ModelDirectory` 的 store 初值是 `{ current: null, status: 'idle' }`，
        // 只有 `await load()` 之后 `syncInputs()` 才把真实 `current` 填进去。
        // 徽标自己不发模型目录请求（`usage.badge` 是按 provider 查的），
        // 所以若不调 load()，`current` 永远是 null ⇒ provider 空 ⇒ 徽标不显示。
        if (typeof resolved.load === 'function') {
          Promise.resolve(resolved.load()).catch((error) => {
            // eslint-disable-next-line no-console
            console.warn('[jet-hub usage] 目录 load() 失败，徽标将不显示：', error);
          });
        }
        return;
      }
      attempt += 1;
      if (attempt >= RESOLVE_RETRY_DELAYS.length) {
        // eslint-disable-next-line no-console
        console.warn('[jet-hub usage] 目录解析最终失败，徽标不显示');
        return;
      }
      timers.push(setTimeout(tryResolve, RESOLVE_RETRY_DELAYS[attempt - 1]));
    };
    tryResolve();
    return () => {
      alive = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [resolveDirectory]);

  // ⚠️ 没有目录就到此为止：`useSyncExternalStore` 的回调必须始终是函数，
  // 直接在 directory 为 null 时调用会抛 TypeError 并把异常带回宿主渲染树。
  // ⚠️ 三个回调都再包一层 try/catch：`directoryFor` 求值成功**不等于**
  // `subscribe` / `getSnapshot` 不抛 —— 惰性 getter 的真正求值可能推迟到
  // 订阅时（那正是桌面版的实际行为）。这里必须假设它们**会**抛，
  // 否则同一个故障换个时机复发，又是一次「模型选择器点不动」。
  // ⚠️ 静默吞异常是本次排查最大的阻碍（`directory.getSnapshot is not a
  // function` 被这里吞掉，表现为「徽标不显示且毫无线索」）。故失败**只记一次**
  // 关键信息，仍不抛出 —— 抛出仍会打崩宿主渲染树。
  const safe = (fn) => () => {
    try {
      return directory ? fn(directory) : undefined;
    } catch (error) {
      if (!snapshotErrorRef.current) {
        snapshotErrorRef.current = true;
        // eslint-disable-next-line no-console
        console.warn('[jet-hub usage] 读目录快照失败（store 上应有 getSnapshot）:', error);
      }
      return undefined;
    }
  };
  const state = React.useSyncExternalStore(
    // ⚠️ 订阅要**真的转发 onChange**（用户切模型时徽标跟着更新）；
    // try/catch 只为把「订阅时才发现抛错」这一类也收进徽标内部。
    (onChange) => {
      if (!directory) return () => {};
      try {
        return directory.subscribe(onChange);
      } catch {
        return () => {};
      }
    },
    safe((d) => d.getSnapshot()),
    safe((d) => d.getSnapshot()),
  );
  // ⚠️ `let` 而非 `const`：聚合重定向会把 `aggregate` **就地替换**成真实渠道
  //    （见下），而下面那两行门控是**既有断言逐字钉住的**，必须继续用 `provider`
  //    这个名字 —— 换名（如 `resolved`）会让 `usage-badge-client.spec.ts` 的正则
  //    `typeof provider !== 'string' || provider.length === 0` 失配而变红（实测撞过）。
  let provider = state?.current?.provider;
  /**
   * 聚合 provider 的**重定向**（P3）：把 `aggregate` 解析成它上次**实际**转发成功的渠道。
   *
   * ## ⚠️⚠️ 为什么必须在门控**之前**
   *
   * 下面那行 `if (!supportsCreditBalance(provider)) return null;` 是**既有断言逐字
   * 钉住的**（`tests/unit/usage-badge-client.spec.ts`），不得修改。而 `aggregate`
   * 在能力表里**如实**登记为 `balance:false`（它确实没有自己的账号与余额）⇒
   * 若直接把它交给门控，徽标**永不渲染**。
   * ⇒ 正确做法是**先**把 `aggregate` 解析成真实渠道，门控看到的就是真实渠道，
   *   那行一个字都不用动（规格 §6.3 的 P2）。
   *
   * ## ⚠️ 异步取数 vs 同步渲染
   *
   * 宿主端点 `aggregate.activeProvider` 是**纯内存读**（零网络零余额查询），
   * 但它仍是 async（走 RPC 通道）。而渲染是同步的 ⇒ 首帧拿不到值。
   * 处理方式与既有的「目录惰性解析」**同一模式**：首帧按「无历史」处理
   * （`active` 为 null ⇒ 重定向得 null ⇒ 走下面既有的空 provider 门控 ⇒ 不渲染），
   * effect 取到后再 setState 触发重渲染。
   * ⚠️ **不阻塞渲染**：RPC 失败也只是不渲染徽标（徽标是可选装饰），
   * 与既有目录解析失败的取向一致。
   *
   * ## ⚠️ 语义是**真实历史**，不是预测
   *
   * 用宿主记录的「上次实际转发成功的渠道」；无历史 ⇒ 不渲染（规格 §6.3 的 P4）。
   * **不做预测**，也不用 `pickCurrentAutoProvider`（预测语义 + 有网络成本）。
   */
  const readActiveProvider = props.readActiveProvider;
  const [activeProvider, setActiveProvider] = React.useState(null);
  const isAggregate = provider === AGGREGATE_PROVIDER_ID;
  /**
   * 取「上次实际选中的渠道」，并**周期性重试**。
   *
   * ## ⚠️⚠️ 为什么必须重试（真实缺陷，用户报障 2026-10-07）
   *
   * 用户：「用聚合模型发送信息前后都没有流量徽标显示」。
   *
   * 我第一版的依赖数组是 `[isAggregate, readActiveProvider]` —— 这两个值在
   * 「**无历史**」时都**稳定不变**（`isAggregate` 由 `provider === 'aggregate'`
   * 决定，而 `provider` 正是**等着这次取数才能变**的那一个）⇒ effect **只跑一次**，
   * 取到 `null` 之后**永不重取** ⇒ 即使随后转发成功、宿主已记录渠道，
   * 徽标也永远不显示。
   *
   * ⚠️ 这是一个**循环依赖**：规格 §6.4 的 X1 说「渠道变化 ⇒ `provider` 变 ⇒
   * `UsageBadgeActive` 的 `useEffect([provider])` 重挂载」。但 X1 只在
   * **已经有过历史之后**成立；**首次**拿到渠道之前，`provider` 恒为 `aggregate`、
   * 永远不会变。我照抄 X1 而没有验证它在这个环节成立。
   *
   * ⇒ 修法：取数**周期性重试**，节奏用 {@link ACTIVE_PROVIDER_POLL_MS}
   *（**不是** `BADGE_POLL_MS` —— 那个是余额轮询、要打网络；本查询是纯内存读，
   * 必须快得多，否则用户发完消息要等一分钟才看到徽标出现）。
   *
   * ## ⚠️ 必须**一直**轮询，不能「取到值就停」
   *
   * 我一度想在取到渠道后 `clearInterval`（想省一个空转的定时器）—— **那是错的**：
   * 「随切换更新」这条需求正需要它。聚合层换了候选之后，宿主记录变了，
   * 而**外层只有重新取数才会拿到新的 `provider`**；停了定时器，
   * 渠道就永远停在第一次那个值上（用户看到的会是「徽标不跟着变」）。
   * ⇒ 定时器**常驻**（与 `UsageBadgeActive` 自己的 60 秒轮询同节奏、同生命周期）。
   */
  React.useEffect(() => {
    if (!isAggregate || typeof readActiveProvider !== 'function') return undefined;
    let alive = true;
    let timer = null;
    const refresh = () => {
      Promise.resolve()
        .then(() => readActiveProvider())
        .then((value) => {
          if (!alive) return;
          setActiveProvider(value?.provider ?? null);
        })
        .catch(() => {
          // ⚠️ 安静降级：读不到「上次渠道」只是不渲染徽标，不影响会话输入区。
          //    保留重试（可能只是宿主那一次读失败）。
          if (alive) setActiveProvider(null);
        });
    };
    refresh();
    timer = setInterval(refresh, ACTIVE_PROVIDER_POLL_MS);
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
    };
    // ⚠️ 依赖 `isAggregate`：非聚合时不该发这个请求（其余 15 家的行为逐字不变）。
  }, [isAggregate, readActiveProvider]);

  // ⚠️ 重定向结果可能是 `null`（聚合且无历史）⇒ 下面**既有的**空 provider 门控
  //    天然拦掉它 —— 复用同一形态，不另造判据（规格 §6.6）。
  // ⚠️ 就地赋回 `provider`（不新造变量名）：那两行门控必须逐字不变，见上方 `let` 的注释。
  if (isAggregate) {
    provider = resolveBadgeProvider(provider, activeProvider === null ? null : { provider: activeProvider });
  }
  // 没有选中模型（新会话尚未选择 / 已寻址的 subagent 会话）→ 不渲染。
  if (typeof provider !== 'string' || provider.length === 0) return null;
  // 不是本插件的渠道 → 不渲染，且**不会**发任何请求。
  if (!supportsCreditBalance(provider)) return null;
  return React.createElement(UsageBadgeActive, { ...props, provider });
}

/** 展开态的完整实现（数据、轮询、弹窗）。 */
function UsageBadgeActive(props) {
  const { provider, providerLabel, readBadge, writePreference, setAutoCheckin, dismissAutoCheckin, claimCredits } = props;
  const label = providerLabel(provider);

  /** `{ value, at }`：宿主返回的读数 + **到达**本地的时刻（兜底显示用）。 */
  const [snapshot, setSnapshot] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  /**
   * 最近一次读数失败的原因（已翻译成可行动文案）。
   *
   * ⚠️ 为什么要单独存而不是只置 `failed`：真实故障（2026-10-02 用户报障）里，
   * 宿主进程跑的是旧代码、页面却拿到了新 bundle，于是弹窗里赫然写着裸的
   * `unknown method: usage.badgePreference` —— 用户完全不知道该做什么。
   * 存下来后由 `describeBadgeError` 统一翻译（判据与文案见 `badge-model.js`）。
   */
  const [readError, setReadError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  /** 本地偏好镜像：写入后立刻生效，不等待下一轮轮询（否则像「点了没反应」）。 */
  const [preference, setPreference] = React.useState(null);
  const [prefError, setPrefError] = React.useState('');
  /** 自动签到开关的写入错误（与偏好分开：两者是不同的设置项，别互相顶掉）。 */
  const [autoError, setAutoError] = React.useState('');
  /**
   * 领取状态。`claiming` 用**字符串**而不是布尔：
   * `'current'` = 只签当前渠道（单次请求）；`'all'` = 遍历全部支持签到的渠道
   * （串行多次请求，要显示 `done/total` 进度，否则用户以为卡住了）。
   */
  const [claiming, setClaiming] = React.useState(null);
  const [claimProgress, setClaimProgress] = React.useState(null);
  /** 领取结果：`{ tone, text, notes }`；`notes` 是**需要用户操作**的提示（后端显式字段）。 */
  const [claimNotice, setClaimNotice] = React.useState(null);
  /**
   * 弹窗里积分列表是否已展开（超过 {@link CREDITS_COLLAPSED_LIMIT} 个账号时才有意义）。
   *
   * ⚠️ 会随渠道切换重置（见下面那个 `[provider]` 副作用）：不重置的话，在 A 渠道
   * 点过「展开」，切到 B 渠道时会直接看到全量列表 —— 用户会以为折叠功能时灵时不灵。
   */
  const [creditsExpanded, setCreditsExpanded] = React.useState(false);
  const root = React.useRef(null);
  /** 供定时器与按钮调用的「读一次」入口（每次渲染替换，避免闭包过期）。 */
  const read = React.useRef(() => {});

  // 换渠道时先清空旧读数：否则会短暂把上一个渠道的余额画到新渠道的名字下。
  React.useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setClaimNotice(null);
    setPrefError('');
    setAutoError('');
    // 「展开其余 N 个」是**本渠道**的一次操作，换渠道即失效（理由见它的声明处）。
    setCreditsExpanded(false);
  }, [provider]);

  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    /**
     * 读一次。三种调用形态（**语义不同，不要合并**）：
     *
     * | 形态 | force | 隐藏页 | 用途 |
     * |---|---|---|---|
     * | `load()` | ✗ | **不跳过** | 挂载（含切渠道后）：走宿主缓存，**有缓存就立刻出数** |
     * | `load({ poll: true })` | ✗ | 跳过 | 60s 轮询与「切回前台」 |
     * | `load({ force: true })` | ✓ | 不跳过 | 用户点「刷新」/ 签到之后：必须拿最新 |
     *
     * ⚠️ 挂载时**不 force** 是用户报障的修复（2026-10-02「反应有点慢」）：
     * force 会绕过宿主 120s 缓存，于是每次挂载都要重新逐账号打上游（顺序
     * HTTP，几个账号就是几秒），首屏只能一直空着。走缓存后，同一渠道 120s 内
     * 的第二次挂载（切回来、新开会话）**立刻**出数。
     *
     * ⚠️ 挂载也不做「隐藏页跳过」：那是为**轮询**设计的节流，若挂载也跳过，
     * 后台标签页里新建的会话会一直停在「读取中…」。
     */
    const load = async (options = {}) => {
      if (inFlight) return;
      const force = options.force === true;
      // 隐藏的标签页跳过**轮询**（值不值得为一个没人看的数字保持请求）。
      if (options.poll === true && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      if (force) setBusy(true);
      try {
        const value = await readBadge(provider, force ? { force: true } : {});
        if (!alive) return;
        // 响应里带回了 provider：并发/切渠道时只认领属于自己的那一份读数。
        if (value?.provider !== undefined && value.provider !== provider) return;
        setSnapshot({ value, at: Date.now() });
        setFailed(false);
        setReadError('');
      } catch (error) {
        // ⚠️ 保留上一次成功读数：一分钟前为真的数字，比一片空白有用得多。
        if (alive) {
          setFailed(true);
          setReadError(describeBadgeError(error));
        }
      } finally {
        inFlight = false;
        if (alive && force) setBusy(false);
      }
    };
    read.current = () => { void load({ force: true }); };
    void load();
    const timer = setInterval(() => { void load({ poll: true }); }, BADGE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load({ poll: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      read.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [provider, readBadge]);

  // 点弹窗外面 / 按 Esc 关闭（仅在展开时挂监听）。
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * 签到摘要**自动消失**（用户报障 2026-10-02：「签到后下方显示的文字久久都不消失」）。
   *
   * ⚠️ 计时器必须随 `claimNotice` 的每次变化重建并 `clearTimeout`：否则「连续两次
   * 签到」时，第一次那支计时器会把第二次的摘要提前清掉（表现为「刚签完就消失」）。
   * ⚠️ 依赖里不能放 `open`：关掉弹窗后摘要仍应按时消失，而不是等下次打开时还在。
   */
  React.useEffect(() => {
    if (claimNotice === null) return undefined;
    const ms = claimNotice.tone === 'warn' ? CLAIM_NOTICE_WARN_MS : CLAIM_NOTICE_MS;
    const timer = setTimeout(() => setClaimNotice(null), ms);
    return () => clearTimeout(timer);
  }, [claimNotice]);

  const value = snapshot?.value;
  const effectivePreference = preference ?? value?.preference ?? 'auto';
  /**
   * 「首次读数还没到」与「首次读数就失败」都要**显式**告诉展示层。
   *
   * ⚠️ 不能靠「账号列表为空」推断：那会把「还没读到」显示成「未配置启用账号」
   *（用户报障，2026-10-02）。`snapshot === null` 才代表没有任何数据，
   * 有数据时刷新失败要保留旧数字（不降级成空态）。
   */
  const view = badgeView({
    providerLabel: label,
    preference: effectivePreference,
    subscription: value?.subscription,
    accounts: value?.accounts ?? [],
    loading: snapshot === null && !failed,
    failed: failed && snapshot === null,
  });

  /**
   * 自动签到状态灯 —— 数据来自读数响应里的 `autoCheckin`（**不进宿主缓存**的
   * 实时字段，所以每轮读都能拿到最新的 `running` / `ranToday`）。
   */
  const auto = value?.autoCheckin;

  /**
   * 切换自动签到开关。
   *
   * ⚠️ 宿主在「打开」时会**立刻跑一轮**（今天已跑过则由它内部拦住），所以这里：
   * 1. 写完立刻 `read.current()` —— 拿回实时状态（`running` 会立刻是 true）；
   * 2. 若这一轮正在跑，**12 秒后再读一次** —— 一轮是串行打十几个上游，通常十几秒
   *    内结束；不补这一次，状态灯要等满 60 秒轮询才从「进行中」变成「今天已完成」，
   *    用户会以为卡住了。只补一次，不做轮询循环（组件卸载后 `read.current` 已被置空）。
   */
  const onToggleAutoCheckin = async () => {
    if (auto === undefined) return;
    const next = auto.enabled !== true;
    setAutoError('');
    try {
      await setAutoCheckin(next);
      read.current();
      if (next) setTimeout(() => read.current(), 12_000);
    } catch (error) {
      setAutoError(describeBadgeError(error, '自动签到开关保存失败'));
    }
  };

  /** 关闭那行常驻的自动签到状态文字（只关当前这一轮；下一轮结果会重新出现）。 */
  const onDismissAuto = async () => {
    setAutoError('');
    try {
      await dismissAutoCheckin();
      read.current();
    } catch (error) {
      setAutoError(describeBadgeError(error, '关闭自动签到状态失败'));
    }
  };

  /**
   * 状态灯的**悬停提示**（用户 2026-10-02：「鼠标放上去增加文字提示，这个按钮是
   * 干什么的」）。故第一句就说清「这是个开关」，再给当前状态与点击后果。
   *
   * 四态：关闭（空心灰环）/ 已开·今天未跑（实心绿点）/ 已开·今天已跑（绿点带外环）/
   * 进行中（省略号）。文字里必须说清**作用范围（全部渠道）与日界**，否则用户
   * 无法判断「为什么今天没动静」。
   */
  const autoTitle = (() => {
    const what = '自动签到开关';
    if (auto === undefined) return `${what}：状态读取中…`;
    if (auto.enabled !== true) {
      return `${what}（当前：关闭）—— 点击开启后，每天首次启动 DSH 时会自动为全部渠道签到一次`;
    }
    if (auto.running === true) return `${what}（当前：开启，正在执行）—— 串行遍历有账号的渠道，请稍候`;
    const last = auto.lastResult === '' ? '' : `；上次：${auto.lastResult}`;
    if (auto.ranToday === true) return `${what}（当前：开启，今天已完成）${last} —— 点击关闭`;
    return `${what}（当前：开启，今天尚未执行）—— 每天首次启动 DSH 时自动签到${last}；点击关闭`;
  })();
  const autoState = auto === undefined || auto.enabled !== true
    ? 'off'
    : (auto.ranToday === true ? 'done' : 'on');

  /**
   * 签到按钮上的「（自动）」后缀。
   *
   * 用户 2026-10-02 的两次要求：
   * ① 「在全部签到按钮右上方标是否有自动的小标识」→ 先做成了按钮上方的小胶囊；
   * ② 随后改成：「直接在原有的全渠道签到后面加一个括号，添加自动二字。如果没有，
   *    只有单渠道，也在后方加一个自动二字。如果自动签到关闭，则不显示这个自动二字。」
   *    ⇒ **去掉那枚小胶囊**（用户觉得不够好看），改成按钮文案后缀；**只在开关打开时**
   *    才加，关闭时按钮保持原样。
   *
   * ⚠️ 只加在**实际会渲染的那个**按钮上，不是两个都加：弹窗里 `全部渠道签到`
   * 是**无条件**渲染的（它不依赖本渠道能力），故后缀恒落在它身上；`签到（本渠道）`
   * 只在能力表允许时出现，此时它与「全部渠道」并存 —— 按用户的口径
   *（「直接在原有的全渠道签到后面加…如果没有，只有单渠道，也在后方加」）**不再重复标**。
   * 若将来出现「只有单渠道按钮」的形态，把 `withAutoSuffix` 用在那一个上即可。
   */
  const withAutoSuffix = (label) => (auto?.enabled === true ? `${label}（自动）` : label);

  /** 切换显示偏好：本地先生效，宿主写入失败时提示并回滚下一次渲染。 */
  const onPickPreference = async (next) => {
    setPreference(next);
    setPrefError('');
    try {
      await writePreference(next);
    } catch (error) {
      setPreference(null);
      setPrefError(describeBadgeError(error, '偏好保存失败'));
    }
  };

  /**
   * 一键签到 —— **只签当前渠道**（单次 `credits.claimAll({ provider })`）。
   *
   * 按钮只在能力表允许的渠道渲染（`supportsDailyCheckin`）。
   */
  const onClaim = async () => {
    setClaiming('current');
    setClaimNotice(null);
    try {
      const result = await claimCredits(provider);
      setClaimNotice(summarizeClaim(result));
      // 签到会改变余额 → 立刻强制重读（否则要等下一轮轮询才看到新数字）。
      read.current();
    } catch (error) {
      setClaimNotice({ tone: 'warn', text: error?.message || '签到失败', notes: [] });
    } finally {
      setClaiming(null);
    }
  };

  /**
   * 签到**所有支持签到的渠道**（用户 2026-10-02 要求放进弹窗）。
   *
   * 与 Jet Hub 设置页页头那个「一键签到」**同一套语义**（见 `jet-hub.js` 的
   * `checkinAll`），差别只是结果渲染成弹窗里的紧凑版：
   *
   * - **必须串行** `await`，不能 `Promise.all`：这是**真实领积分**的写操作，
   *   跨渠道并发会同时发出多路领取请求，触发风控的代价是用户当天领不到
   *  （单渠道内部本就是「逐账号顺序执行」，见 `src/jet-hub-rpc.ts`）。
   * - 渠道集合由能力表推导（`checkinProviders()`）：WorkBuddy 国际版 / Cline /
   *   Raccoon 后端没有签到接口，**绝不能**出现在请求列表里。
   * - 单渠道失败只计入失败数，**不中断后续渠道**。
   * - 每个**非零**计数都要出现在结果里（否则「暂无活动」的渠道会整条消失，
   *   用户以为它没执行）；一个渠道可能同时有成功与失败，不用 else-if 短路。
   * - `actionRequired` 的提示单独列出（后端显式字段，不靠文案匹配）。
   */
  const onClaimAll = async () => {
    const providers = checkinProviders();
    setClaiming('all');
    setClaimNotice(null);
    setClaimProgress({ done: 0, total: providers.length });
    const parts = [];
    const notes = [];
    // ★ 按单位分组的合计（2026-10-04，真实缺陷）：见下方累加处的说明。
    // ⚠️ 刻意不设 `totalCredit` 标量（跨单位求和的数，展示路径不得使用）；
    //   旧宿主兜底发生在逐渠道的 `summary.totalByUnit || {...}` 那一跳。详见
    //   `jet-hub.js` 同处的说明（本 PR 首版那个三元分支永远走不到）。
    const totalByUnit = { token: 0, credit: 0 };
    let failed = 0;
    for (let index = 0; index < providers.length; index += 1) {
      const id = providers[index];
      try {
        const result = await claimCredits(id);
        const summary = result?.summary || {};
        const bits = [];
        if (summary.claimed > 0) {
          // ★ 按单位分别累加（2026-10-04，真实缺陷）：`summary.totalCredit` 是
          //   **跨单位求和**，会把 ZCode 的 1 亿 token 与积分加成一个数并标成
          //   「积分」（用户报障原文：`（共 +100000100）`）。单位必须一路带着走。
          const byUnit = summary.totalByUnit || { credit: summary.totalCredit, token: 0 };
          totalByUnit.credit += Number(byUnit.credit) || 0;
          totalByUnit.token += Number(byUnit.token) || 0;
          // ⚠️ **不要在这里再拼 `+`**：`formatClaimGains` 的返回值**自带**每个单位
          //   的 `+`（`+100.00MToken, +100积分`），再拼一次会渲染成 `++100.00MToken`。
          //   与 `jet-hub.js` 同因（2026-10-05 复审实测），详见该处注释。
          const amount = formatClaimGains(byUnit);
          if (amount !== null) bits.push(amount);
        }
        if (summary.alreadyClaimed > 0) bits.push(`${summary.alreadyClaimed} 个今日已领`);
        if (summary.inactive > 0) bits.push(`${summary.inactive} 个暂无活动`);
        if (summary.failed > 0) {
          failed += summary.failed;
          const reason = (result?.results || [])
            .map((item) => item?.outcome?.message)
            .find((message) => typeof message === 'string' && message.length > 0);
          bits.push(`${summary.failed} 个失败${reason ? `（${reason}）` : ''}`);
        }
        parts.push(`${providerLabel(id)} ${bits.length > 0 ? bits.join('，') : '无账号'}`);
        for (const item of result?.results || []) {
          const outcome = item?.outcome || {};
          if (outcome.actionRequired !== true) continue;
          const message = outcome.message;
          if (typeof message !== 'string' || message.length === 0) continue;
          if (!notes.includes(message)) notes.push(message);
        }
      } catch (error) {
        failed += 1;
        parts.push(`${providerLabel(id)} 失败（${error?.message || '未知原因'}）`);
      }
      setClaimProgress({ done: index + 1, total: providers.length });
    }
    // ★ 汇总行按单位分别报（2026-10-04，真实缺陷）：原先写 `（共 +${totalCredit} 积分）`，
    //   而 `totalCredit` 是跨单位求和 —— 用户报障的 `（共 +100000100）` 就是它。
    //
    // ⚠️ **不能再拼 `+`**：`formatClaimGains` 已自带每个单位的 `+`，本行原写作
    //   `（共 +${totalAmount}）` ⇒ 渲染出 `（共 ++100.00MToken, +100积分）`
    //   （2026-10-05 复审实测，与 `jet-hub.js` 同因）。
    // ⚠️ 兜底只在逐渠道累加处做一次，这里直接用 `totalByUnit`（见该处注释）。
    const totalAmount = formatClaimGains(totalByUnit);
    setClaimNotice({
      tone: failed > 0 || notes.length > 0 ? 'warn' : 'ok',
      text: parts.length > 0
        ? `全部渠道：${parts.join('；')}${totalAmount === null ? '' : `（共 ${totalAmount}）`}`
        : '全部渠道：没有可领取的渠道',
      notes,
    });
    setClaimProgress(null);
    setClaiming(null);
    read.current();
  };

  const tone = failed && snapshot === null ? 'error' : view.tone;
  // 悬浮提示按「读数 → 不完整说明 → 失败原因」三段拼，空串全部跳过（不留空行）。
  // ⚠️ 不完整说明（`incompleteNote`）与失败原因（`failureReason`）**都要留**：
  // 前者说「这个数不完整」，后者说「为什么」—— 只说前者用户不知道该去修什么。
  const title = [view.text, view.incompleteNote, view.failureReason]
    .filter((part) => part !== '')
    .join('\n');
  // 读屏用户看不到那个警示标记，故把同一句话并进 aria-label。
  const ariaLabel = `${label} 用量：${view.text}${view.incompleteNote === '' ? '' : `（${view.incompleteNote}）`}`;

  /**
   * 折叠态那一行：**按三段渲染，而不是一个字符串**（真实报障，2026-10-03）。
   *
   * ## 报障与根因
   *
   * 用户看到 `LobsterAI (有道) · 合计 …` —— 数字被截掉了。根因不是宽度不够，
   * 而是原先**整句**塞进一个 `overflow: hidden` 的 span：省略号从右往左吃，
   * 被吃掉的恰好是用户唯一想看的那个数（还剩多少），渠道名反而完整。
   *
   * ## 三段的让位顺序
   *
   * ```
   * [渠道名（先让位）] • [包名（更先让位）] [读数（最后才动）]
   * ```
   *
   * 由 CSS 的 flex 权重决定（见 jet-hub-styles.js 的 .dim-jh-badgeName /
   * .dim-jh-badgeDetail 的 flex-shrink 注释）：空间不足时**先**截渠道名，
   * 再次截包名，**数字最后**才出省略号。
   *
   * ⚠️ 分隔符单独成 span 且用 CSS margin 给间距，**不要**把间距写成
   * `' • '` 里的空格：flex 容器会丢弃 span 之间只含空白的文本节点，空格会消失
   * （实测：三段的 DOM textContent 拼出来是 `名字•读数`，没有空格）。
   * 带空格的那份整句仍由 `view.text` 提供给 title / aria-label。
   *
   * ⚠️ `key` 必须稳定：这里用固定的字符串键（同一组 span 每轮只换文本），
   * 否则每次读数到达都会重建 DOM 节点，胶囊会出现一次性闪烁。
   */
  const collapsed = React.createElement('span', { key: 'text', className: 'dim-jh-badgeText' }, [
    React.createElement('span', { key: 'name', className: 'dim-jh-badgeName' }, view.name),
    React.createElement('span', { key: 'sep', className: 'dim-jh-badgeSep' }, '•'),
    // 空串时**不渲染**该节点：留一个空 span 会白吃一个 5px 的 gap
    //（.dim-jh-badgeText 用的是 .dim-jh-badgeBtn 的 gap）。只有套餐模式有中段。
    view.detail === ''
      ? null
      : React.createElement('span', { key: 'detail', className: 'dim-jh-badgeDetail' }, view.detail),
    // ⚠️ 类名是 Reading 而**不是** Value：.dim-jh-badgeValue 已被弹窗里的读数占用
    //（那条规则带 font-weight:600，且排在样式表更后面 —— 同名会让胶囊里的数字
    // 被静默加粗、并拿到 flex:none 而无法收缩）。
    React.createElement('span', { key: 'value', className: 'dim-jh-badgeReading' }, view.reading),
    /**
     * 「这个数字不完整」的标记（用户 2026-10-03 要求）。
     *
     * 合计少算了几个账号时，数字本身**看不出任何异常**，故必须有个可见标记 ——
     * 但它是**补语而不是读数**，故：
     * - 单独成 span，`flex: none`（与读数同级）：被省略号吃掉就等于没标；
     * - 排在读数**之后**：不干扰「先看数字」的阅读顺序；
     * - 不参与 `view.text`：那句话是 `title` / `aria-label` 用的纯读数。
     *
     * ⚠️ `aria-hidden` 是**故意**的：同一句话已经并进按钮的 `aria-label`，
     * 不隐藏会被读屏念两遍。鼠标用户的解释走 `title`。
     */
    view.incompleteNote === ''
      ? null
      : React.createElement('span', {
        key: 'incomplete',
        className: 'dim-jh-badgeWarn',
        title: view.incompleteNote,
        'aria-hidden': 'true',
      }, '⚠'),
  ]);

  return React.createElement('div', { className: 'dim-jh-badge', ref: root }, [
    React.createElement('button', {
      key: 'btn',
      type: 'button',
      className: 'dim-jh-badgeBtn',
      'aria-expanded': open,
      'aria-label': ariaLabel,
      title,
      onClick: () => setOpen((was) => !was),
    }, [
      React.createElement('span', { key: 'dot', className: 'dim-jh-badgeDot', 'data-tone': tone }),
      collapsed,
    ]),
    open ? renderPopover() : null,
  ]);

  /**
   * 弹窗内容。
   *
   * ## 布局取舍（用户 2026-10-02：「小巧、美观，但信息不能缺失」）
   *
   * 全部信息都在，但把**行数**压到最少：
   * - 头部一行：色调圆点 + 渠道名 + 更新时间（含「缓存」标记）+ 图标刷新按钮；
   * - 偏好做成分段控件（三个标签自带含义，故不再单占一行写「显示偏好」）；
   * - 节标题右侧直接带合计（省掉「合计…」那一行）；
   * - 每个账号一行：名字左、数值右，分桶/资源包说明作为**灰色小字**跟在后面
   *   （存在时才换到第二行，不存在就是单行）；
   * - 窗口两行：`名称 … 重置倒计时` / `进度条 + 百分比`；
   * - 两个签到按钮并排一行，结果摘要与「需要你操作」的提示在下方。
   */
  function renderPopover() {
    // `formatUpdatedAt` 对缺失时刻返回空串（不显示 1970），故这里也要处理空值。
    const stamp = snapshot === null ? '' : formatUpdatedAt(value?.generatedAt ?? snapshot.at);
    const children = [
      React.createElement('div', { key: 'head', className: 'dim-jh-badgeHead' }, [
        React.createElement('span', { key: 'dot', className: 'dim-jh-badgeDot', 'data-tone': tone }),
        React.createElement('span', { key: 'title', className: 'dim-jh-badgeTitle' }, label),
        React.createElement('span', { key: 'at', className: 'dim-jh-badgeAt' },
          snapshot === null
            ? '读取中…'
            : `${stamp === '' ? '已读取' : stamp}${value?.cached === true ? ' · 缓存' : ''}`),
        React.createElement('button', {
          key: 'auto',
          type: 'button',
          className: 'dim-jh-badgeAuto',
          'data-state': autoState,
          'data-running': auto?.running === true,
          'aria-pressed': auto?.enabled === true,
          title: autoTitle,
          'aria-label': autoTitle,
          onClick: () => { void onToggleAutoCheckin(); },
        }, auto?.running === true
          ? '…'
          : React.createElement('span', { className: 'dim-jh-badgeAutoDot' })),
        React.createElement('button', {
          key: 'refresh',
          type: 'button',
          className: 'dim-jh-badgeRefresh',
          disabled: busy,
          title: '刷新（绕过宿主缓存）',
          'aria-label': '刷新用量',
          onClick: () => read.current(),
        }, busy ? '…' : '↻'),
      ]),
      // 开关写入失败时单独一行说明：它属于设置写入，混进偏好那行会让人以为
      // 是「显示偏好」没保存。
      autoError === ''
        ? null
        : React.createElement('div', { key: 'autoErr', className: 'dim-jh-badgeFail', role: 'alert' }, autoError),
      renderPreference(),
    ];

    // 首屏：读数未到 / 首次就失败 —— 说明白，但**不**渲染会说出
    // 「该渠道还没有账号」的明细区（用户报障：那是把「还没读到」说成「没有账号」）。
    if (snapshot === null) {
      // ⚠️ 失败时把**原因**摆出来：最常见的一种（宿主未重启）有确定解法，
      // 只说「可点 ↻ 重试」会让用户反复点一个不可能成功的按钮。
      children.push(React.createElement('div', {
        key: 'placeholder',
        className: failed ? 'dim-jh-badgeFail' : 'dim-jh-badgeNote',
        role: failed ? 'alert' : undefined,
      }, failed
        ? (readError === ''
          ? '用量不可用，可点右上角 ↻ 重试'
          : `${readError}（可点右上角 ↻ 重试）`)
        : '正在读取用量…（首次要逐账号查询，可能要几秒）'));
      // 签到不依赖本渠道的读数，故首屏也放出来（用户可能就是想先签到）。
      children.push(renderClaim());
      return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
    }

    children.push(renderSubscription());
    children.push(renderCredits());
    children.push(renderClaim());
    children.push(renderFoot());
    return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
  }

  /**
   * 显示偏好：分段控件（本仓库无 `<select>` 先例，故用按钮组 + `aria-pressed`）。
   *
   * 不再单占一行写「显示偏好」：三个标签（自动 / 优先订阅 / 只看积分）自带含义，
   * 容器的 title 里给出完整解释 —— 省一行而信息不丢。
   *
   * ⚠️ 三档不是「同一个轴的强弱」，而是**两条不同的轴**（2026-10-03 语义反转后）：
   * `auto` 与 `credits` 都显示余额，但**只有 auto 会在没有余额读数时回落**到
   * 窗口/套餐；`subscription` 干脆不看余额。标签名因此必须让用户看出
   * 「只看积分」比「自动」更**强制**（旧名「优先积分」读起来像 auto 的同义词）。
   */
  function renderPreference() {
    return React.createElement('div', {
      key: 'pref',
      className: 'dim-jh-badgePref',
      // ⚠️ 三档的差别必须写清：auto 与 credits 在**有订阅时**表现不同
      //（auto 会回落，credits 不回落到订阅）—— 只说「优先显示哪个」会让人以为两档一样。
      title: '显示偏好：「自动」= 优先显示一共能用的余额（没有余额读数才显示订阅窗口/套餐）；「优先订阅」= 只看窗口与套餐；「只看积分」= 强制只显示余额，也是套餐判定不准时的兜底',
    }, [
      ...BADGE_PREFERENCES.map((item) => React.createElement('button', {
        key: item,
        type: 'button',
        className: 'dim-jh-badgePrefBtn',
        'aria-pressed': effectivePreference === item,
        onClick: () => { void onPickPreference(item); },
      }, BADGE_PREFERENCE_LABELS[item])),
      prefError === '' ? null : React.createElement('span', { key: 'err', className: 'dim-jh-badgeFail' }, prefError),
    ]);
  }

  /** 订阅区：窗口（Cline）或套餐包（Qoder / ZCode / 两个 buddy）。 */
  function renderSubscription() {
    const subscription = value?.subscription;
    if (subscription === undefined) return null;
    if (subscription.kind === 'windows') {
      const rows = Array.isArray(subscription.accounts) ? subscription.accounts : [];
      const account = rows.find((row) => row?.ok === true) ?? rows[0];
      const windows = account === undefined ? [] : quotaWindowsOf(account.windows ?? []);
      return React.createElement('div', { key: 'sub', className: 'dim-jh-badgeSection' }, [
        React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, '订阅额度'),
        ...(windows.length === 0
          ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' },
            account?.ok === true ? '该账号没有额度窗口' : (account?.error || '订阅额度不可用'))]
          /**
           * ⚠️ 窗口行外包一层 `.dim-jh-badgeWins`：它才是 **grid 容器**，四条列宽由
           * CSS 定义（标签 max-content / 进度条 minmax(60px,1fr) / 百分比 max-content /
           * 倒计时固定 100px 右对齐）。每行用 `display: contents` 把四个单元格交给
           * 这个 grid，于是**三行共享同一套列**——这是用户 2026-10-02 明确的口径：
           * 「像两边对齐，但进度条要一样长，文字部分左右分别对齐」。
           * （先前试过「整块居中 + 固定 64px 条」，被否掉：那样两侧不对齐。）
           */
          : [React.createElement('div', { key: 'wins', className: 'dim-jh-badgeWins' },
            windows.map(([type, windowLabel, win]) => {
              const percent = quotaPercentValue(win?.percentUsed);
              const left = quotaResetsIn(win?.resetsAt);
              // **一行**放下四样：名称 / 进度条 / 百分比 / 重置倒计时（用户要求更小巧）。
              // ⚠️ 倒计时允许被省略号截断（窄窗时最后一点空间给它），完整文本在 title 里
              // —— 这是唯一「可能看不见」的信息，故必须留 title 兜底。
              return React.createElement('div', { key: type, className: 'dim-jh-badgeWin' }, [
                React.createElement('span', { key: 'l', className: 'dim-jh-badgeWinLabel' }, windowLabel),
                React.createElement('div', { key: 'bar', className: 'dim-jh-quotaBar' },
                  React.createElement('div', {
                    key: 'fill',
                    className: 'dim-jh-quotaBarFill',
                    'data-tone': quotaTone(percent),
                    style: { width: `${percent}%` },
                  })),
                React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' }, formatQuotaPercent(percent)),
                left === ''
                  ? null
                  : React.createElement('span', { key: 'r', className: 'dim-jh-badgeWinReset', title: left }, left),
              ]);
            }))]),
      ]);
    }

    const groups = view.planGroups;
    return React.createElement('div', { key: 'sub', className: 'dim-jh-badgeSection' }, [
      React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, '订阅套餐'),
      ...(groups.length === 0
        ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' }, '没有可用的套餐包')]
        : groups.map((group) => React.createElement('div', {
          key: `${group.name}\u0000${group.unit}`,
          className: 'dim-jh-badgeRow',
        }, [
          React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
            React.createElement('span', { key: 'l', className: 'dim-jh-badgeRowName', title: group.name }, group.name),
            React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' },
              // ⚠️ 数值与单位之间**不留空格**（`100.00M / 200.00MToken`）：
              //   与本弹窗积分区（`usage-badge.js:894` / `badge-model.js:474`）、
              //   设置页账号卡片是同一口径。本行原为 `... ?? '?'} ${group.label}`
              //   （**带空格**）—— 它渲染的正是 `94.54M Token` 形态，与积分区的
              //   `94.54MToken` 在同一弹窗里并列，像两种单位
              //   （2026-10-05 复审补修；这是该批次最后一处空格漏网，见
              //    `tests/unit/claim-unit-callsites.spec.ts` 的穷举断言）。
              `${formatUnits(group.remaining, group.unit) ?? '?'} / ${formatUnits(group.total, group.unit) ?? '?'}${group.label}`),
          ]),
          React.createElement('div', { key: 'note', className: 'dim-jh-badgeRowNote' },
            [
              group.accountCount > 1 ? `${group.accountCount} 个账号合计` : null,
              group.deductionEndTime === undefined ? null : `扣费截止 ${formatUpdatedAt(group.deductionEndTime)}`,
            ].filter(Boolean).join(' · ')),
        ]))),
    ]);
  }

  /**
   * 积分区：逐账号余额（含失败原因与分桶文案）。
   *
   * ## 账号多了以后的两条整理（用户 2026-10-03 要求）
   *
   * 1. **按余额降序**：账号是「用完一个换下一个」的资源，用户要先看到的正是
   *    「还有哪个号能用」。原来的顺序是池的插入顺序，与余额无关。
   *    ⚠️ 读取失败的账号**排在最后**（`balance === null`）—— 它们没有数字可比，
   *    混在中间只会把有用的行往下挤；且失败行的数值位写的是错误原因，插在
   *    数字序列里会让人误读成「这个号余额很小」。
   * 2. **超过 {@link CREDITS_COLLAPSED_LIMIT} 个就折叠**：六个号原本是十二行
   *    （每号两行），弹窗被撑得比窗口还高。折叠后固定 5 行 + 一行「展开其余 N 个」。
   *    ⚠️ 合计与失败账号数**不受折叠影响**（合计在节标题、失败数在脚注），
   *    折叠只是把明细收起来，不隐藏结论。
   *    ⚠️ 因为失败行排在最后，**被收起的通常正是读不到数的那些**（6 个号里有 1 个
   *    失败 ⇒ 恰好收它一个）。这是有意的：明细区优先给「能用的号」，而失败这件事
   *    已经由脚注与胶囊上的警示角标说了；要排查时点一下展开即可。
   */
  function renderCredits() {
    const accounts = value?.accounts ?? [];
    const windowDays = value?.windowDays;
    /**
     * ⚠️ 配额单位（Gemini）**不求和、也不算均值**：窗口是并行的百分比，
     * 累加没有语义（两个账号各 50% 加起来是 100%？），而宿主侧的 `total`
     * 本身已经是两个窗口剩余比例的平均值 —— 上游根本没有那个数。
     * 这类单位改为逐账号列出窗口行（见 {@link balanceLine}）。
     */
    const quotaGroup = view.groups.find((group) => group.unit === QUOTA_UNIT || group.unit === 'source-quota');
    const sum = quotaGroup !== undefined
      ? (quotaGroup.sourceLines ?? quotaGroup.quotaLines ?? []).join(' · ')
      : view.groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'}${group.label}`).join(' · ');
    // 排序与折叠是**纯逻辑**（含「读不到数的排最后」「稳定排序」两条不变量），
    // 放在 badge-model.js 里由单测锁死 —— 组件里看不见 react 的测试跑不起来。
    const { shown, hidden } = orderCreditRows(accounts, {
      limit: CREDITS_COLLAPSED_LIMIT,
      expanded: creditsExpanded,
    });
    return React.createElement('div', { key: 'credits', className: 'dim-jh-badgeSection' }, [
      // 合计放进节标题右侧，省掉一整行
      React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, [
        // ⚠️ 节标题的单位标签走**纯函数**（`creditSectionLabel`），不在这里写三元：
        //   原写法是 `quotaGroup === undefined ? '积分' : unitLabel(...)` —— 那个
        //   兜底分支把 **ZCode 的 token** 冒充成了积分（真实缺陷，2026-10-05 复审
        //   PR !56 时发现），渲染成「积分 … 94.54MToken」自相矛盾的一屏。
        //   判据收进 `badge-model.js` 是为了能被单测锁死（组件里没法测 —— 本仓库
        //   node_modules 没有 react）。
        React.createElement('span', { key: 'l' }, creditSectionLabel(view.groups)),
        accounts.length === 0 || sum === ''
          ? null
          : React.createElement('span', { key: 'sum', className: 'dim-jh-badgeSectionSum' },
            // ⚠️ 「合计」二字只对**可累加的余额**成立。配额窗口是并行百分比，
            //   没有「一共」的语义（上游也没给过那个数），故配额下只给逐窗口读数。
            //   token / 积分都是余额口径，加「合计」无误。
            quotaGroup === undefined ? `合计 ${sum}` : sum),
      ]),
      ...(accounts.length === 0
        ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' },
          value?.disabledCount > 0 ? '该渠道的账号全部已停用' : '该渠道还没有账号（可在 Jet Hub 设置页添加）')]
        : shown.map((row) => React.createElement('div', { key: row.accountId, className: 'dim-jh-badgeRow' }, [
          React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
            React.createElement('span', {
              key: 'l',
              className: 'dim-jh-badgeRowName',
              title: row.nickname || row.accountId,
            }, row.nickname || row.accountId),
            React.createElement('span', {
              key: 'v',
              className: 'dim-jh-badgeValue',
              'data-tone': row.balance === null ? 'warn' : 'ok',
              title: row.error || undefined,
            }, row.balance === null ? (row.error || '查询失败') : balanceLine(row.balance)),
          ]),
          // 分桶/资源包说明：灰色小字，存在时才占一行
          row.balance === null
            ? null
            : renderNote(splitLine(row.balance, windowDays, provider)),
        ]))),
      hidden === 0
        ? null
        : React.createElement('button', {
          key: 'more',
          type: 'button',
          className: 'dim-jh-badgeMore',
          'aria-expanded': creditsExpanded,
          onClick: () => setCreditsExpanded((was) => !was),
        }, creditsExpanded ? '收起' : `展开其余 ${hidden} 个账号`),
    ]);
  }

  /** 一行灰色小字；空串返回 `null`（不占位）。 */
  function renderNote(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    return React.createElement('div', { key: 'note', className: 'dim-jh-badgeRowNote' }, text);
  }

  /**
   * 签到：两个按钮并排（**都放在弹窗里**，用户 2026-10-02 选 B）。
   *
   * - `签到（仅 <渠道>）`：只在能力表允许的渠道渲染（`supportsDailyCheckin`）；
   * - `全部渠道签到`：与设置页页头同款语义，串行遍历 `checkinProviders()`
   *   （WorkBuddy 国际版 / Cline / Raccoon 没有签到接口，不在列表里）。
   *   它**不依赖本渠道的读数**，故首屏/失败态也渲染。
   */
  function renderClaim() {
    const canClaimCurrent = supportsDailyCheckin(provider);
    const allBusy = claiming === 'all';
    return React.createElement('div', { key: 'claim', className: 'dim-jh-badgeSection dim-jh-badgeClaim' }, [
      React.createElement('div', { key: 'row', className: 'dim-jh-badgeClaimRow' }, [
        canClaimCurrent
          ? React.createElement('button', {
            key: 'cur',
            type: 'button',
            className: 'dim-jh-badgeAction',
            disabled: claiming !== null,
            // ⚠️ 按钮文案**不写渠道名**：`签到（仅 CodeBuddy (腾讯)）` 在 300px 弹窗里
            // 会被 text-overflow 截成 `签到（仅 CodeBuddy (…`（截图核验发现）。渠道名
            // 已经在弹窗头部与 title 里，按钮只要说清「范围＝本渠道」即可。
            // ⚠️ 自动签到开着时加「（自动）」后缀 —— 只在**只有这一个按钮**的形态下
            // 才轮到它承载该标识（见 `withAutoSuffix` 的注释）。
            title: `只签到当前渠道（${label}）的全部账号`,
            onClick: () => { void onClaim(); },
          }, claiming === 'current' ? '领取中…' : '签到（本渠道）')
          : null,
        React.createElement('button', {
          key: 'all',
          type: 'button',
          className: 'dim-jh-badgeAction',
          disabled: claiming !== null,
          title: `串行签到全部支持签到的渠道（9 个；WorkBuddy 国际版 / Cline / Raccoon 后端没有签到接口）${auto?.enabled === true ? '；自动签到已开启，每天首次启动 DSH 时会自动执行一次' : ''}`,
          onClick: () => { void onClaimAll(); },
        }, allBusy
          ? (claimProgress === null ? '签到中…' : `签到中 ${claimProgress.done}/${claimProgress.total}…`)
          : withAutoSuffix('全部渠道签到')),
      ]),
      /**
       * 本渠道没有签到接口时**明说原因**。
       *
       * ⚠️ 用户 2026-10-02 报障：「单渠道签到哪里去了」—— 他在 Cline 上打开弹窗只看到
       * 「全部渠道签到」，以为按钮丢了。真相是能力表里 `dailyCheckin: false`
       * （WorkBuddy 国际版 / Cline / Raccoon 后端没有签到接口，Raccoon 的每日积分由
       * 服务端自动发放）。少了这一句，用户只能靠猜。
       */
      canClaimCurrent
        ? null
        : React.createElement('div', { key: 'nocount', className: 'dim-jh-badgeNote' },
          '该渠道没有签到接口，签到请用「全部渠道签到」'),
      claimNotice === null
        ? null
        : React.createElement('div', {
          key: 'notice',
          className: 'dim-jh-badgeNotice',
          'data-tone': claimNotice.tone,
        }, claimNotice.text),
      // 「需要用户操作」的提示单独列出（后端显式字段 actionRequired），
      // 混进计数行会被读漏，而它的价值就在于被看到。
      ...(claimNotice?.notes || []).map((message, index) => React.createElement('div', {
        key: `note-${index}`,
        className: 'dim-jh-badgeNotice',
        'data-tone': 'warn',
      }, message)),
      renderAutoStatus(),
    ]);
  }

  /**
   * **常驻**的自动签到状态文字（用户 2026-10-02 的第三轮要求）。
   *
   * 与上面那条手动签到结果的区别（**两者语义不同，别合并**）：
   * - 手动签到结果：按时**自动消失**（成功 8s / 警告 20s），因为它是「刚做完这件事」的回执；
   * - 自动签到状态：**不自动消失**，由用户点上方那个小按钮手动关闭 —— 用户要能随时
   *   「知道各个渠道的签到状态」，自动消失会让它永远看不到。
   *
   * 显示条件：开关打开、用户没关掉**这一轮**、且有内容可显示（跑过一轮，或正在跑）。
   * 逐渠道明细由宿主记录（`state.channels`），这里只做展示与渠道名映射。
   */
  function renderAutoStatus() {
    if (auto?.enabled !== true || auto.dismissed === true) return null;
    const channels = Array.isArray(auto.channels) ? auto.channels : [];
    const running = auto.running === true;
    if (!running && channels.length === 0) return null;
    const stamp = running ? '' : formatUpdatedAt(auto.lastAt);
    return React.createElement('div', { key: 'autostatus', className: 'dim-jh-badgeAutoStatus' }, [
      // 小关闭按钮在**文字上方**（用户：「在文字上方放个小按钮，点击直接关闭」）。
      React.createElement('div', { key: 'closerow', className: 'dim-jh-badgeAutoCloseRow' },
        React.createElement('button', {
          key: 'close',
          type: 'button',
          className: 'dim-jh-badgeAutoClose',
          title: '关闭这行自动签到状态（下一轮自动签到后会重新出现）',
          'aria-label': '关闭自动签到状态文字',
          onClick: () => { void onDismissAuto(); },
        }, '×')),
      React.createElement('div', { key: 'head', className: 'dim-jh-badgeAutoStatusHead' },
        running
          ? '自动签到 · 进行中…'
          : `自动签到${stamp === '' ? '' : ` · ${stamp}`}：${auto.lastResult}`),
      channels.length === 0
        ? null
        : React.createElement('div', { key: 'channels', className: 'dim-jh-badgeAutoChannels' },
          channels.map((entry, index) => React.createElement('span', {
            key: `${entry.provider}-${index}`,
            className: 'dim-jh-badgeAutoChannel',
          }, `${providerLabel(entry.provider)} ${entry.text}`))),
    ]);
  }

  /** 脚注：停用账号数、失败账号数与「显示的是旧读数」提示。 */
  function renderFoot() {
    const parts = [];
    if (value?.disabledCount > 0) parts.push(`另有 ${value.disabledCount} 个账号已停用，未计入`);
    // ⚠️ 优先复用 `incompleteNote` 那句话：同一个事实（有几个账号没读到）在两个
    // 界面各写一份措辞，改一处就会出现「胶囊说A、弹窗说B」的偏差。
    // 只有积分模式才有那句话（窗口/套餐不是合计），故其余模式保留简写。
    if (view.failedCount > 0) parts.push(view.incompleteNote === '' ? `${view.failedCount} 个账号读取失败` : view.incompleteNote);
    if (failed && snapshot !== null) parts.push('本次刷新失败，显示的是上一次读数');
    if (parts.length === 0) return null;
    return React.createElement('div', { key: 'foot', className: 'dim-jh-badgeFoot' }, parts.join(' · '));
  }
}

/** 一个账号的余额行（数值 + 单位）。 */
function balanceLine(balance) {
  if (balance.sourceQuota) return balance.sourceQuota.text;
  const packages = balance.packages || [];
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit;
  /**
   * ⚠️ 配额窗口（Gemini）**不显示均值 + 「额度」**，而是逐窗口百分比。
   *
   * 「94.50 额度」这个形状是错的：94.50 是两个窗口剩余比例的均值，
   * 上游根本没有这个数，而「额度」这个标签下它会被读成 94.5 个额度。
   * 逐窗口列出来才是这份读数本来的形状（与设置页账号卡片同一函数）。
   */
  const quota = formatQuotaLine(packages, unit);
  if (quota !== null) return quota;
  const text = formatUnits(balance.total, unit) ?? '0';
  // ⚠️ 数值与单位之间**不留空格**（`94.54MToken` / `441.78积分`）：与
  //   `badge-model.js` 的折叠态读数、`formatClaimGains` 的领取文案统一
  //   （2026-10-05 复审：本行原为 `${text} ${unitLabel(unit)}`，带空格）。
  return `${text}${unitLabel(unit)}`;
}

/**
 * 分桶文案（当日池优先，其次按到期分桶）。
 *
 * ⚠️ 与设置页账号卡片**同一套口径、同一批函数**（`credit-expiry.js`）：
 * 两处若各算各的，用户会看到「卡片说临时 55、徽标说长期 55」这种无法解释的偏差。
 * `now` 在渲染这一刻现取 —— 分桶是时间的函数，缓存它会让越线的包继续算长期。
 */
function splitLine(balance, windowDays, provider) {
  if (balance.sourceQuota) return balance.sourceQuota.label;
  if (balance.pendingNote) return balance.pendingNote;
  const packages = balance.packages || [];
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit;
  /**
   * 配额窗口（Gemini）：灰色小字显示**各窗口的重置倒计时**。
   *
   * 它替代了本行的原职责（「长期 / 临时」分桶）：配额包没有 `deductionEndTime`，
   * 也不是「每日池」，两条分桶路径都不命中 ⇒ 原先这一行恒为空。
   * 而对配额读数来说，用户唯一需要补的信息正是「这个窗口什么时候回来」——
   * 剩下的百分比本身已经在主行里逐窗口列出来了。
   */
  if (unit === QUOTA_UNIT) {
    const parts = [];
    for (const pkg of packages) {
      if (!pkg) continue;
      const left = quotaResetsIn(pkg.cycleEndTime);
      if (left.length > 0) parts.push(`${pkg.name || '未命名'} ${left}`);
    }
    return parts.join(' · ');
  }
  const format = (value) => formatUnits(value, unit);
  const poolText = formatPoolSplitLine(packages, format, provider === 'loomy' ? '永久' : '长期');
  if (poolText !== null) return poolText;
  const expiryText = formatExpirySplitLine(splitCreditsByExpiry(packages, windowDays, Date.now()), format);
  return expiryText ?? '';
}

/**
 * 单渠道签到结果 → `{ tone, text, notes }`。
 *
 * 宿主返回的是 `{ results, summary }`（逐账号四态 `ClaimOutcome` + 汇总），
 * 这里按用户最关心的顺序给一句话：本次领到多少 → 已领过几个 → 活动未开启 → 几个失败。
 *
 * ⚠️ **每个非零计数都要出现**：早期只判 claimed / alreadyClaimed / failed，
 * 于是「活动未开启」（`inactive > 0`）整条消失，用户以为那个渠道没执行。
 * ⚠️ 幂等判据在各渠道的响应体里（不是 HTTP 状态码），故「已领过」是**成功**语义，
 * 不能与失败混为一谈。
 */
function summarizeClaim(result) {
  const summary = result?.summary;
  if (summary === undefined) return { tone: 'ok', text: '签到完成', notes: [] };
  const parts = [];
  if (summary.claimed > 0) {
    // ★ 单位感知（2026-10-04，真实缺陷）：原先写 `共 +${summary.totalCredit} 积分`，
    //   把 ZCode 的 token 标成了积分。`totalByUnit` 缺省时回落到「按积分」，
    //   以兼容旧宿主响应（与 `coversToday` 的兜底同思路）。
    const amount = formatClaimGains(
      summary.totalByUnit || { credit: Number(summary.totalCredit) || 0, token: 0 },
    );
    parts.push(amount === null
      ? `${summary.claimed} 个账号领取成功`
      : `${summary.claimed} 个账号领取成功，共 ${amount}`);
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
  if (summary.failed > 0) {
    const reason = (result.results || []).find((row) => row?.outcome?.kind === 'failed')?.outcome?.message;
    parts.push(`${summary.failed} 个失败${reason ? `：${reason}` : ''}`);
  }
  const notes = (result?.results || [])
    .map((row) => row?.outcome)
    .filter((outcome) => outcome?.actionRequired === true && typeof outcome.message === 'string' && outcome.message.length > 0)
    .map((outcome) => outcome.message)
    .filter((message, index, all) => all.indexOf(message) === index);
  return {
    tone: summary.failed > 0 || notes.length > 0 ? 'warn' : 'ok',
    text: parts.length === 0 ? '签到完成（无可领取的账号）' : parts.join('；'),
    notes,
  };
}
