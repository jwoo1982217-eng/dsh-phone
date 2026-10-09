/**
 * 桌面版「内部 captcha 载体」的 **client 贡献循环**（二期 Task 4）。
 *
 * ## 这一层在整条链路里的位置
 * 载体页由 server 渲染（`src/zcode-carrier-page.ts`），结果挂在 `window.__zcodeCaptcha`；
 * server 侧只有一只供给槽（`src/captcha-supply.ts`）和三条 RPC
 * （`captcha.demand` / **`captcha.carrierUrl`** / `captcha.contribute`）。
 * **中间这段「开 guest → 导航 → 读数 → 回传」只能由 GUI 来做**，
 * 因为 `connection.fetch` 是单向的，server 没法反过来要求页面干活。
 *
 * ## ★★ 导航目标为什么必须**问** server（评审 C1/C2，本轮修掉的致命缺陷）
 * 初版把载体页挂在插件自己的 `/api/jet-hub/captcha-carrier`，理由是「与 GUI 同源」。
 * 真机证据（DSH Desktop 0.2.0-rc.2，`resources/app.asar/lib/main.js`）推翻了它：
 * - `allowedNavigation(v)` = http(s) + 无账号密码 + `!isApplicationHost(url)`；
 * - `isApplicationHost(u)` = **`u.port === host.port` 且（主机相同或回环）**；
 * - `onBeforeRequest` 对命中 `isApplicationHost` 的请求直接 `cancel`；
 * - guest 的 partition 是 `dsh-sidebar-browser-<uuid>`（**无 `persist:`**），
 *   没有 Host 的会话 cookie。
 *
 * ⇒ 挂在应用自己 host 上的载体页，**每一轮都在第一个判断退出，guest 都不建**，
 * 收益恒为 0，而失败被 `preventDefault` 吞掉，日志一切正常。
 * ✅ **换端口即绕开**（`isApplicationHost` 的判定要求端口相同）—— 所以 server 侧
 * 懒起一个只监听 `127.0.0.1` 的小服务（`src/captcha-carrier-server.ts`），
 * client 每轮问 `captcha.carrierUrl` 要那条地址。
 * ⚠ 因此本文件**不再有任何硬编码的载体页路径**（那是「两处漂移即静默失效」的根源）。
 *
 * ## 五条硬规则（每条都有对应用例，改代码前先读）
 * 1. **web 版零动作**：`dshDesktop` 的协议版本不是 1、或拿不到 `browser`，
 *    就**整体 return** —— 不查 demand、不问地址、不建 webview、连日志都不打一行
 *    （web 版今天的行为就是「没有这码事」，多一行日志都算改变它）。
 * 2. **不主动预产**：每轮先 `captcha.demand`，`active !== true` 就什么都不做。
 *    上游不校验的窗口里 mint 次数必须仍是 0（预取池那条已因白烧配额默认关闭，
 *    见 `src/captcha-supply.ts` 文件头「与预取池的区别」）。
 * 3. **一行 captcha 逻辑都不写**：只用 `executeJavaScript` 读 `window.__zcodeCaptcha`，
 *    表达式里连那个 SDK 的名字都不出现 —— 「这条 param 算不算合格」的判据只在 server
 *    那一份里（`src/zcode-captcha.ts` 的校验 + `src/captcha-supply.ts` 的收货口），
 *    这里再写一遍必然漂移（本仓库反复吃过同型缺陷）。
 * 4. **导航判据用注入读回的 `location.origin`**，不用 guest 的 URL getter：
 *    ⚠ 实测 `did-finish-load` 那一刻 `about:blank#<lease>` 这个初始 src 还挂在
 *    guest 上（官方 sidebar-browser 就是这么建元素的），拿 URL getter 判导航成败
 *    会**静默失效** —— 表现是「一次都没产过 param」，而日志看着一切正常。
 *    ⚠ 期望值也**跟着地址变**：载体页现在在**独立端口**上，比对的必须是
 *    `captcha.carrierUrl` 给的那条 origin，不是 GUI 自己的 origin。
 * 5. **每次贡献都重新导航**：载体页只自动产一次（`stage` 进终态后不再动），
 *    所以 guest 可以复用，但**每一轮都要重新 loadURL**（不重新导航 = 反复读到同一个
 *    已用过的 param，而 param 一次性，复用必被上游拒）。
 *
 * ## 失败必须能自我诊断
 * 判据全在 `classifyCarrierOutcome()`（纯函数 ⇒ 可单测真跑），人话在
 * `CARRIER_FAILURE_LABELS`，日志里同时带**分类码** `reason=<code>`，
 * 这样线上抓一条日志就能直接分流，不用猜。
 * ⚠ `no-carrier-url` 是**安静**的一类：server 说「现在没有可用地址」
 *   （env 关掉 / 候选端口全被占）⇒ 本轮什么都不做，这不是故障。
 *
 * ## `elapsedMs` 的语义（钉住，别改）
 * `elapsedMs = 贡献那一刻 − 本轮开始产的时刻`，而「开始产」= **导航之前**那一刻。
 * ⇒ 它包含**导航 + 页面里 SDK 跑完 + 我们轮询等待**的全部时间（不含后面那一跳 RPC）。
 * server 侧用「自己的到达时刻 − elapsedMs」反推产出时刻来判时效
 * （见 `src/jet-hub-rpc.ts` 的 `captcha.contribute`）：这个值**偏大只会更早判过期**
 * （保守、安全），把锚点往后挪到「导航之后」才会出事 —— 那会低估年龄、把超龄 param 发出去。
 *
 * ## `options` 里的注入点
 * `desktop` / `doc` / `timing` / `log` 只为了把「环境」与「节奏」从代码里隔开
 * （真实 `<webview>` 只能在 DSH Desktop 里存在，单测环境是 node）。
 * 生产调用点（`index.js`）只传 `rpcCall`，其余走 `globalThis` 与默认节奏；
 * **别把这里的口子当扩展位用**，也别在测试之外传第二份 `desktop`。
 */

/**
 * ⚠ **这里不再有载体页路径常量**（评审 C1/C2）。
 *
 * 初版这里是 `CARRIER_PATH = '/api/jet-hub/captcha-carrier'`，与宿主侧那条同源路由
 * 靠一条「两边必须相等」的断言兜漂移。
 * 现在那条地址**根本不能被 guest 加载**（主进程 `isApplicationHost` 要求端口相同，
 * 见文件头取证）⇒ 真正的地址由 server 在**独立回环端口**上运行时挑出来，
 * client 每轮问 `captcha.carrierUrl`（`resolveCarrierTarget()`）。
 * ⇒ 少一份重复定义，也少一个「忘了同步就静默失效」的坑。
 */

/** 「本轮还没结束，继续等」的哨兵：与下面任何失败码都不会撞值。 */
export const CARRIER_PENDING = '__pending__'

/**
 * 失败分类码（写进日志的 `reason=<code>`）。
 * ⚠ 每一项都要在 `CARRIER_FAILURE_LABELS` 里有一句人话 —— 只有码没有话，
 * 线上看到的人还是不知道该往哪查。
 */
export const CARRIER_FAILURE = Object.freeze({
  /** 载体页回的不是 200/401/403（被反代改写、端口上跑的是别的东西……）。 */
  unauthenticated: 'unauthenticated',
  /** 注入读回的 `location.origin` 与**载体页那条地址**的 origin 不一致。 */
  originMismatch: 'origin-mismatch',
  /** 页面挂载了但 `stage` 一直 pending 到预算用尽。 */
  mintTimeout: 'mint-timeout',
  /** 页面自己上报了终态失败（`stage` 非 pending/success，带 `error`）。 */
  mintFailed: 'mint-failed',
  /** 同源、也加载完了，但文档里没有那个挂载位（被反代改写/返回了别的 HTML）。 */
  notCarrierPage: 'not-carrier-page',
  /** 导航层失败（`did-fail-load`）。 */
  loadFailed: 'load-failed',
  /** 我们发的状态探针自己都失败了（离线/被拦截）⇒ 与「服务器回了 401」是两回事。 */
  probeFailed: 'probe-failed',
  /** 产出来了但供给槽没收（`accepted !== true`：垃圾产物 / 空串 / 异常短）。 */
  slotRejected: 'slot-rejected',
  /** 读 guest 表达式这条路整个抛了（guest 失联、被主进程回收、RPC 通道断了）。 */
  roundCrashed: 'round-crashed',
  /**
   * ★ server 说「现在没有载体页地址」（`captcha.carrierUrl` 回 `null`）。
   *
   * 两种成因：`DSH_ZCODE_INTERNAL_CARRIER=0`，或候选端口全被占。
   * ⇒ **安静**的一类：这不是故障，不建 guest、不导航、不重试同一轮。
   * 取代了原先那条 `noGuiOrigin`（同源拼地址的那条路已经不存在了）。
   */
  noCarrierUrl: 'no-carrier-url',
  /** 租约能拿到但发不出去（主进程不认、配额满）。 */
  acquireFailed: 'acquire-failed',
})

/** 分类码 ⇒ 人话（日志用）。**排查方向**写在这里，不是重复码名。 */
const CARRIER_FAILURE_LABELS = Object.freeze({
  [CARRIER_FAILURE.unauthenticated]: '载体页回了 401/403（guest 自己探到的状态码）'
    + ' ⇒ 那条独立端口上的小服务被别的东西占了、或被加了认证；本窗口照旧走外挂 chromium',
  [CARRIER_FAILURE.originMismatch]: '导航后读回的 origin 与载体页地址的 origin 不一致（被重定向出去了）'
    + ' ⇒ 先确认那条回环端口上的服务还是我们起的那一个（有人抢占 / 端口被复用）',
  [CARRIER_FAILURE.mintTimeout]: '载体页一直在 pending ⇒ SDK 那段没跑完（网络拉不到 JS、被 CSP 拦、或页面被降级成人工验证）',
  [CARRIER_FAILURE.mintFailed]: '载体页自己报了终态失败（下面带 stage 与 error）',
  [CARRIER_FAILURE.notCarrierPage]: '同源也加载完了，但文档里没有载体页的挂载位 ⇒ 返回的不是那一页 HTML',
  [CARRIER_FAILURE.loadFailed]: '导航本身失败（did-fail-load，下面带 errorCode/description）',
  [CARRIER_FAILURE.probeFailed]: '状态码探针自己发不出去（服务已关 / 被拦）⇒ 与「服务器明确回了状态码」不是一回事',
  [CARRIER_FAILURE.slotRejected]: 'param 已产出但供给槽没收（server 判不合格：垃圾产物 / 空串 / 异常短）',
  [CARRIER_FAILURE.roundCrashed]: '这一轮整条路抛了（guest 失联 / RPC 通道断）⇒ 已回收 guest，下轮重建',
  [CARRIER_FAILURE.noCarrierUrl]: 'server 说现在没有载体页地址（DSH_ZCODE_INTERNAL_CARRIER=0 或候选端口全被占）'
    + ' ⇒ 这是「安静」的一类，不是故障；本窗口照旧走外挂 chromium',
  [CARRIER_FAILURE.acquireFailed]: '主进程没给出租约（acquire 抛错或形状不对）⇒ 内部载体在此桌面壳不可用',
})

/**
 * 节奏。⚠ **这一组数字是被 `PARAM_MAX_AGE_MS`（`src/captcha-supply.ts`，20s）反推出来的**，
 * 不是凭手感填的：`elapsedMs` 从「本轮开始产」起算，server 用「到达时刻 − elapsedMs」记产出时刻
 * ⇒ **一轮走多久，param 一到手就先老多久**。所以一轮预算只要接近 20s，产出就等于
 * 「投放即超龄」：白烧一次设备配额（阿里云按同设备限 150 次/小时），而日志全绿，
 * 只表现为「槽一直没货」。下面几个预算全部压在 20s 以内，
 * 并由 `tests/unit/zcode-carrier-client-wiring.spec.ts` G 组那条不变式锁住。
 *
 * **为什么贡献成功后还要冷却 25s**：需求位只说「要不要」，不说「槽里有没有」
 * —— 一步一产会把上一发还新鲜的 param 直接覆盖掉。冷却刻意取「必然 > `PARAM_MAX_AGE_MS`」：
 * 等上一发自己过期才产下一发，槽里永远最多一个（与 `src/captcha-supply.ts` 的「绝不囤」同一条约束）。
 */
export const DEFAULT_CARRIER_TIMING = Object.freeze({
  /** 需求位心跳。必须明显小于 server 侧 `DEFAULT_CARRIER_WAIT_MS`（1.5s），否则那趟有界等待总是先超时。 */
  demandPollMs: 700,
  /** 读 `stage` 的间隔。 */
  mintPollMs: 400,
  /**
   * 一轮产出的预算：12s，**故意压在 20s 时效之下**（再算上下面读数超时的最坏余量共 16s）。
   * 载体页自己那两层超时（SDK 注入 ≤25s、无感验证 ≤60s）都比这里大 —— 等它们跑完只会得到
   * 一发登记时就已超龄的 param，所以到 12s 就判 mint-timeout、换 guest 重来。
   * ⚠ 连带后果（别当成可调参数）：param 的**可用窗口 ≈ 20s − 本轮耗时**。
   *   将来实测出真实时效，该动的是 `PARAM_MAX_AGE_MS`（server 那一份），不是放大这里的预算
   *   —— 放大只会让更多「到手即超龄」的轮次白跑一遍。
   */
  mintTimeoutMs: 12_000,
  /** 导航与起 guest 的超时也算在 `mintTimeoutMs` 之内（锚点在导航之前）⇒ 必须更小才有意义。 */
  navigateTimeoutMs: 8_000,
  domReadyTimeoutMs: 8_000,
  /**
   * 单次 `executeJavaScript` 的兜底（guest 卡住时不能把整轮钉死 —— 这条链历史上挂死过一次）。
   * ⚠ 取 4s：它构成超时判定的**最坏余量**（真正不能越过 `PARAM_MAX_AGE_MS` 的是
   *   `mintTimeoutMs + evaluateTimeoutMs`），由 G 组那条不变式锁着。
   */
  evaluateTimeoutMs: 4_000,
  successCooldownMs: 25_000,
  failureCooldownMs: 3_000,
})

/**
 * `<webview>` 的存储账户键（传给 `dshDesktop.browser.acquire(workspace)`）。
 *
 * ## ⚠ 别随机化，但**别把它当「持久化信誉」**（评审 I4 纠正的错误认知）
 * 主进程 `acquire(owner, workspace)` 的实现（DSH Desktop 0.2.0-rc.2，
 * `app.asar/lib/main.js`）是：
 * ```js
 * let partition = this.partitions.get(workspace)
 * if (partition === undefined) {
 *   partition = `dsh-sidebar-browser-${randomUUID()}`   // ← 注意：没有 persist: 前缀
 *   this.configureSession(session.fromPartition(partition))
 *   this.partitions.set(workspace, partition)
 * }
 * ```
 * 由此得到**两条**必须写准的事实：
 * 1. **同一次运行内**：同一个 workspace 键 ⇒ 同一个 partition ⇒ 阿里云看到的是**同一台设备**。
 *    这就是常量化的理由（键一变 = 换设备，已攒的信誉当场作废）。
 * 2. **跨启动不保留**：那张 `partitions` 表在**进程内存**里，且 partition 名**没有 `persist:`**
 *    ⇒ 内存 session ⇒ **DSH 一关，下次启动就是一台全新设备**。
 *    ⚠ 早期这里写着「主进程持久化，释放 guest 不会丢信誉」—— 那是错的：
 *    释放 guest 确实不丢（同一 partition 还在），但**跨启动一定丢**。
 *    这条事实抬高降级概率（无感验证更容易被降级成交互式），排查时别误判成「代码有问题」。
 */
const CARRIER_WORKSPACE_KEY = 'zcode-captcha-carrier'

const LOG_PREFIX = '[jet-hub] zcode 内部载体'

/** 同类失败重复到第几次才再打一行（长期坏环境时别把控制台刷满）。 */
const LOG_EVERY_REPEAT = 10

/**
 * guest 里读载体页状态的表达式。
 * ⚠ **只读挂载位**：判 stage 是不是终态可以，判 param 合不合格不行（那在 server）。
 * ⚠ 里面**不能**出现 `fetch(` —— 单测靠这个特征把「状态读数」与「状态码探针」分开。
 */
const CARRIER_STATE_EXPRESSION = [
  '(() => {',
  '  const carrier = globalThis.__zcodeCaptcha;',
  '  const mounted = carrier !== null && typeof carrier === "object";',
  '  return JSON.stringify({',
  '    origin: location.origin,',
  '    href: String(location.href).slice(0, 240),',
  '    title: String(document.title).slice(0, 80),',
  '    mounted,',
  '    stage: mounted ? String(carrier.stage === undefined ? "" : carrier.stage) : "",',
  '    param: mounted && typeof carrier.param === "string" ? carrier.param : "",',
  '    error: mounted && typeof carrier.error === "string" ? carrier.error.slice(0, 400) : "",',
  '    interactive: mounted && carrier.interactive === true,',
  '  });',
  '})()',
].join('\n')

/**
 * guest 侧的**状态码探针**：只在「文档不是载体页」时才发（成功路径不付这个开销）。
 * 为什么要从 guest 里发：宿主自己 fetch 永远是 200（它有 Host 的会话 cookie，
 * 而 guest 那个 partition 没有），拿宿主的视角去判状态码会得出「页面没问题啊」的假结论。
 * ⚠ 探的是**这一轮那条载体页地址**（由 `buildProbeExpression(target)` 现拼），
 *   不是 `location.href` —— 被重定向时 `href` 已经不是载体页了，探它会拿到重定向目标的 200，
 *   把「401」误报成「返回的不是那一页 HTML」（两个分类的排查方向完全不同）。
 * 它只是把同一个 URL 再 GET 一次读 `status` ⇒ fetch **不执行脚本**，
 * 所以不会多产一个 param、也不碰上游配额。
 */
function buildProbeExpression (target) {
  return [
    '(async () => {',
    '  try {',
    `    const response = await fetch(${JSON.stringify(target)}, { credentials: "omit", cache: "no-store" });`,
    '    return String(response.status);',
    '  } catch (error) {',
    '    return "-1";',
    '  }',
    '})()',
  ].join('\n')
}

/** 桌面版内部载体的入口判据：只有 `protocolVersion === 1` 且带可用 `browser` 才认。 */
export function readDesktopBridge (carrier) {
  const browser = carrier?.protocolVersion === 1 ? carrier?.browser : undefined
  if (browser === null || typeof browser !== 'object') return undefined
  if (typeof browser.acquire !== 'function') return undefined
  return browser
}

/**
 * 一轮读数的**唯一判据处**（纯函数 ⇒ 真跑真断言，不依赖 DOM）。
 * 返回 `null`（成功）/ `CARRIER_PENDING`（继续等）/ `CARRIER_FAILURE` 里的某个码。
 *
 * 顺序是有意的：
 * ① 导航层失败先判（这时文档是 `about:blank`，origin 读数是 `'null'`，
 *    不先挡会把「DNS 都没解析」误报成 origin 不符）；
 * ② origin 排在一切内容判断之前 —— **不同源的文档里读到的东西一律不可信**；
 * ③ 「不是载体页」要区分认证 401 与别的 4xx/200，因为**只有 401 那条指向认证**。
 */
export function classifyCarrierOutcome (observed = {}) {
  const {
    expectedOrigin, origin, mounted, stage, loadFailed, probeStatus, timedOut,
  } = observed
  if (loadFailed === true) return CARRIER_FAILURE.loadFailed
  // 读数还没拿到（表达式刚发出去、文档正在换）⇒ 还定不了罪，继续等。
  if (typeof origin !== 'string' || origin.length === 0) {
    return timedOut === true ? CARRIER_FAILURE.mintTimeout : CARRIER_PENDING
  }
  if (origin !== expectedOrigin) return CARRIER_FAILURE.originMismatch
  if (stage === 'success') return null
  if (mounted !== true) {
    // ⚠ 这一支放在「stage 非 pending」之前：401 页面上根本没有挂载位，stage 会是空串，
    // 先判 stage 会把它误分类成 mint-failed（那就彻底查不到认证这条线索了）。
    if (probeStatus === 401 || probeStatus === 403) return CARRIER_FAILURE.unauthenticated
    if (typeof probeStatus !== 'number' || probeStatus === 0) {
      // 还没探到（或探针本身没回话）⇒ 定不了罪，等到预算用尽再报 probe-failed。
      return timedOut === true ? CARRIER_FAILURE.probeFailed : CARRIER_PENDING
    }
    // 负数 = 探针自己的 fetch 抛了（离线 / 被拦截）⇒ 与「服务器明确回了状态码」是两回事。
    if (probeStatus < 0) return CARRIER_FAILURE.probeFailed
    // 明确回了状态码（200 的登录页、500 的错误页都算）⇒ 同源、可访问，但不是载体页。
    return CARRIER_FAILURE.notCarrierPage
  }
  if (typeof stage === 'string' && stage.length > 0 && stage !== 'pending') {
    return CARRIER_FAILURE.mintFailed
  }
  return timedOut === true ? CARRIER_FAILURE.mintTimeout : CARRIER_PENDING
}

/**
 * 组装 `captcha.contribute` 的载荷（纯函数，`now` 可注入）。
 * ⚠ 只带 `param` + **相对耗时**：绝不带绝对时间戳（那会把跨端时钟漂移引进时效闸，
 * 理由见 `src/jet-hub-rpc.ts` 同名 case 的注释）。
 * ⚠ `elapsedMs` 必须是**整数**：server 侧用 `Number.isSafeInteger` 判合法，
 * 给了小数会被整条丢掉耗时 ⇒ 年龄被低估。
 *
 * ★ `interactive`（评审 I2）：这一发是不是被 SDK 降级成了**交互式验证**。
 * 它是内部载体**唯一**的设备信誉预警 —— 此前只打进 client 控制台，
 * host 侧一个字都看不到。⚠ 缺省一律当 `false`（别把「没读到」说成「有」）。
 */
export function buildContributePayload ({ param, mintStartedAt, now, interactive }) {
  const elapsed = Math.round(Number(now()) - Number(mintStartedAt))
  const elapsedMs = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0
  return { param, elapsedMs, interactive: interactive === true }
}

function textOf (error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

function defaultLog (level, message) {
  const sink = typeof console !== 'undefined' ? console[level] ?? console.log : undefined
  if (typeof sink === 'function') sink.call(console, message)
}

/**
 * 启动贡献循环。
 *
 * @returns **停止函数**（交给 `ctx.effect` 的清理路径）。幂等：重复调用不会重复 release，
 *   也不会再起第二条心跳。
 */
export function startCarrierContribution (options = {}) {
  const log = typeof options.log === 'function' ? options.log : defaultLog
  const desktop = options.desktop === undefined ? globalThis.dshDesktop : options.desktop
  // ★ 规则 1：拿不到 bridge 就整体退出。**在这行之前不做任何事**（不发 RPC、不碰 document），
  //   且一行日志都不打 —— web 版每次开 GUI 都冒一条「内部载体不可用」属于行为变化。
  const bridge = readDesktopBridge(desktop)
  if (bridge === undefined) return () => {}

  const rpcCall = options.rpcCall
  if (typeof rpcCall !== 'function') {
    log('warn', `${LOG_PREFIX} 未启动：没有 rpcCall（demand 问不到，产了也没人收）`)
    return () => {}
  }
  const doc = options.doc === undefined ? globalThis.document : options.doc
  if (doc === null || typeof doc !== 'object') {
    log('warn', `${LOG_PREFIX} 未启动：没有 document（webview 元素挂不上去）`)
    return () => {}
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timing = { ...DEFAULT_CARRIER_TIMING, ...(options.timing ?? {}) }

  let stopped = false
  let timer = null
  let running = false
  /** 常驻 guest：复用元素，但**每轮都重新导航**（规则 5）。 */
  let guest = null
  let lease = null
  let lastReason = null
  let repeat = 0

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  function schedule (delayMs) {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, delayMs)
  }

  /** 同类失败只在「换了原因」或「每 10 次」时打一行：长期坏环境别把控制台刷满。 */
  function reportFailure (reason, detail) {
    if (lastReason === reason) repeat += 1
    else { lastReason = reason; repeat = 1 }
    if (repeat > 1 && repeat % LOG_EVERY_REPEAT !== 0) return
    const label = CARRIER_FAILURE_LABELS[reason] ?? '未登记的失败分类（这本身就是个缺陷）'
    const tail = repeat > 1 ? `（同类第 ${String(repeat)} 次）` : ''
    log('warn', `${LOG_PREFIX} 本轮未产出：${label} [reason=${reason}]${detail === undefined || detail === '' ? '' : ` ${detail}`}${tail}`)
  }

  function resetFailureStreak () {
    lastReason = null
    repeat = 0
  }

  /**
   * ★ 向 server 问「载体页这一轮该导航到哪」（评审 C1/C2）。
   *
   * 返回 `{ origin, target }`；拿不到可用地址时返回 `null`
   * （`captcha.carrierUrl` 回 `null` = env 关掉 / 候选端口全被占）。
   *
   * ## 为什么必须问、且必须**每轮**问
   * - 端口是 server **运行时**挑的（避开 0 与已占用端口，见 `src/captcha-carrier-server.ts`），
   *   client 侧拼不出来；
   * - 每轮问一次（而不是缓存）是为了**跟着端口变化**：服务重启后会换端口，
   *   缓存下来的地址会变成「导航到没人监听的端口」，表现是每轮 `load-failed`。
   * 一次 RPC 的开销与一次导航相比可以忽略。
   *
   * ⚠ 只认 `http:`（`allowedNavigation` 放行 http/https；我们起的就是 http 回环），
   *   其它协议一律当「没有地址」。
   */
  async function resolveCarrierTarget () {
    const answer = await rpcCall('captcha.carrierUrl', {})
    const raw = answer?.url
    if (typeof raw !== 'string' || raw.length === 0) return null
    let url
    try {
      url = new URL(raw)
    } catch (error) {
      return null
    }
    if (url.protocol !== 'http:') return null
    return { origin: url.origin, target: url.toString() }
  }

  function destroyGuest (note) {
    const element = guest
    const id = lease
    // ⚠ **必须先把 guest/lease 置空，再碰元素**：真 Electron 在元素被摘掉时会补发 `destroyed`
    //   ⇒ 事件处理器会重入本函数。顺序写反（先 remove 再置空）就是无限递归，
    //   实测 `RangeError: Maximum call stack size exceeded` 一路炸穿整条循环（变异 M10 就是它）。
    guest = null
    lease = null
    if (element !== null) {
      try {
        element.remove()
      } catch (error) { /* 已经不在了就是达到了目的 */ }
      if (typeof note === 'string' && note.length > 0) {
        log('info', `${LOG_PREFIX} ${note}`)
      }
    }
    if (id !== null && id !== undefined && typeof bridge.release === 'function') {
      try {
        // 主进程在 releaseAll 时会兜底，所以这里失败只说明「已经不需要我们操心了」。
        Promise.resolve(bridge.release(id)).catch(() => {})
      } catch (error) { /* 同上 */ }
    }
  }

  function onGuestReclaimed () {
    // 主窗口非 in-place 导航会 releaseAll ⇒ 被收走的 guest 不能留原地（下轮重建）。
    destroyGuest('guest 被主进程回收（render-process-gone / destroyed）⇒ 下一轮重建')
  }

  async function ensureGuest () {
    if (stopped) throw new Error('循环已停止')
    if (guest !== null && doc.body?.contains?.(guest) === true) return guest
    if (guest !== null) destroyGuest()
    let reservation
    try {
      // 第一个实参是**存储账户键**（官方 sidebar-browser 传的是 Workspace 的 CWD）。
      // ⚠ 常量是刻意的：**同一次运行内**键不变 ⇒ partition 不变 ⇒ 阿里云看到同一台设备；
      //   键一变就等于当场换设备。注意 partition **没有 `persist:` 前缀**（内存 session），
      //   所以它**不跨启动**（见 `CARRIER_WORKSPACE_KEY` 上面的完整说明，评审 I4）。
      reservation = await bridge.acquire(CARRIER_WORKSPACE_KEY)
    } catch (error) {
      reportFailure(CARRIER_FAILURE.acquireFailed, textOf(error))
      return null
    }
    const id = reservation?.lease
    const partition = reservation?.partition
    if (typeof id !== 'string' || id.length === 0 || typeof partition !== 'string' || partition.length === 0) {
      reportFailure(CARRIER_FAILURE.acquireFailed, `租约形状异常：lease=${String(id)} partition=${String(partition)}`)
      // ★ 评审 I6：这条早退原先**没有** release ⇒ 主进程 `leases` map 里那条永久残留
      //   （主进程只在 `releaseAll` 与显式 `release` 时清），每撞一次坏形状就漏一条。
      //   写法照下面另两条早退（`Promise.resolve(...).catch()`，不 await、不外抛）。
      //   ⚠ 只有 `lease` 像个租约号时才 release：`undefined`/`''` 调过去等于拿空气换空气。
      if (typeof id === 'string' && id.length > 0) {
        Promise.resolve(bridge.release?.(id)).catch(() => {})
      }
      return null
    }
    if (stopped) {
      Promise.resolve(bridge.release?.(id)).catch(() => {})
      return null
    }
    if (doc.body === null || doc.body === undefined) {
      // GUI 文档还没出 body ⇒ 挂不上去。**这是可等的**，所以报失败而不是留一个孤儿租约。
      reportFailure(CARRIER_FAILURE.roundCrashed, 'GUI 文档还没有 body ⇒ webview 挂不上去')
      Promise.resolve(bridge.release?.(id)).catch(() => {})
      return null
    }
    lease = id
    const element = doc.createElement('webview')
    // 属性形状与官方 `ElectronWebviewPresentation.createElement` 一致：
    // 主进程的 `will-attach-webview` 治理按 name 里的**租约号**放行，形状不对会被 preventDefault。
    element.setAttribute('name', id)
    element.setAttribute('partition', partition)
    element.setAttribute('src', `about:blank#${id}`)
    // 离屏但**参与渲染**：`display:none` 没实测过「隐藏页面里 SDK 还跑不跑」，不敢用。
    if (element.style !== undefined && element.style !== null) {
      Object.assign(element.style, {
        position: 'fixed', left: '-99999px', top: '0',
        width: '420px', height: '320px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1',
      })
    }
    // 先挂监听再入 DOM：主进程回收可能就在 attach 那一刻发生。
    element.addEventListener('render-process-gone', onGuestReclaimed)
    element.addEventListener('destroyed', onGuestReclaimed)
    guest = element
    // ⚠ 先挂 dom-ready 的等待、再入 DOM：append 之后事件可能在同一个宏任务里就发完，
    //   反过来写会偶发「事件已过、等到超时」的假失败（官方实现也是先挂监听再 present）。
    const readySignal = waitForEvent(element, 'dom-ready', timing.domReadyTimeoutMs)
    doc.body.append(element)
    const ready = await readySignal
    if (ready !== true) {
      reportFailure(CARRIER_FAILURE.roundCrashed, `等 dom-ready 超时（${String(timing.domReadyTimeoutMs)}ms 内 guest 没起来）`)
      destroyGuest()
      return null
    }
    return element
  }

  /** 事件版的一等公民：真 webview 的导航完成是**事件**，不是 `loadURL` 的返回值。 */
  function waitForEvent (element, name, timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const cleanup = () => {
        clearTimeout(timerHandle)
        element.removeEventListener(name, onEvent)
      }
      const onEvent = () => {
        if (done) return
        done = true
        cleanup()
        resolve(true)
      }
      const timerHandle = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        resolve(null)
      }, timeoutMs)
      element.addEventListener(name, onEvent)
    })
  }

  /**
   * 重新导航到载体页，等它落定。⚠ 判成败**不**看 guest 的 URL getter（见文件头规则 4）——
   * 这里只等事件，真正的「到哪了」由调用方注入读回 `location.origin` 判。
   */
  async function navigateGuest (element, url) {
    const outcome = new Promise((resolve) => {
      let done = false
      const cleanup = () => {
        clearTimeout(timerHandle)
        element.removeEventListener('did-finish-load', onFinish)
        element.removeEventListener('did-fail-load', onFail)
      }
      const finish = (value) => {
        if (done) return
        done = true
        cleanup()
        resolve(value)
      }
      const onFinish = () => { finish({ ok: true }) }
      const onFail = (event) => {
        if (event?.isMainFrame === false) return
        // -3 = ERR_ABORTED：重定向途中会发，不是失败（与官方 sidebar-browser 同一判据）。
        if (event?.errorCode === -3) return
        finish({
          ok: false,
          errorCode: event?.errorCode,
          errorDescription: String(event?.errorDescription ?? ''),
        })
      }
      const timerHandle = setTimeout(() => {
        finish({ ok: false, errorDescription: `导航超时 ${String(timing.navigateTimeoutMs)}ms` })
      }, timing.navigateTimeoutMs)
      element.addEventListener('did-finish-load', onFinish)
      element.addEventListener('did-fail-load', onFail)
    })
    try {
      if (typeof element.loadURL === 'function') {
        // 成败交给上面的事件判；这里的 reject 只当成「没完成」，异常不外抛。
        Promise.resolve(element.loadURL(url)).catch(() => {})
      } else {
        element.setAttribute('src', url)
      }
    } catch (error) {
      return { ok: false, errorDescription: textOf(error) }
    }
    return outcome
  }

  /**
   * 在 guest 里求值并**原样**返回（带超时）。
   * ⚠ 超时用 race 而不是让 `executeJavaScript` 自己等：guest 卡住时不能把整轮钉死
   *   （这条链历史上出过「无界等待把请求钉住、点停止也没反应」的缺陷，
   *   见 `src/captcha-supply.ts` 文件头约束 3）。
   */
  async function evaluateRaw (element, expression, what) {
    if (typeof element.executeJavaScript !== 'function') {
      throw new Error(`${what}：这个 guest 不支持 executeJavaScript`)
    }
    const running$ = Promise.resolve(element.executeJavaScript(expression))
      .then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error }))
    const settled = await Promise.race([running$, sleep(timing.evaluateTimeoutMs).then(() => ({ kind: 'timeout' }))])
    if (settled.kind === 'error') throw settled.error instanceof Error ? settled.error : new Error(textOf(settled.error))
    if (settled.kind === 'timeout') throw new Error(`${what} 超时（${String(timing.evaluateTimeoutMs)}ms）`)
    return settled.value
  }

  /** {@link evaluateRaw} 的 JSON 版（状态读数用；表达式自己负责 `JSON.stringify`）。 */
  async function evaluateJson (element, expression, what) {
    const raw = await evaluateRaw(element, expression, what)
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  }

  function detailOf (state, probeStatus, waitedMs, load) {
    const bits = []
    if (load?.ok === false) bits.push(`load=${String(load.errorCode ?? '')} ${load.errorDescription || '未知导航失败'}`)
    if (typeof probeStatus === 'number' && probeStatus !== 0) bits.push(`status=${String(probeStatus)}`)
    bits.push(`origin=${String(state.origin ?? '')}`)
    // href 是这类排查里最有用的一件事：它直接说明「到底跳哪儿去了」。
    if (typeof state.href === 'string' && state.href.length > 0) bits.push(`href=${state.href}`)
    if (typeof state.title === 'string' && state.title.length > 0) bits.push(`title="${state.title}"`)
    bits.push(`mounted=${String(state.mounted === true)}`)
    bits.push(`stage=${String(state.stage ?? '')}`)
    if (typeof state.error === 'string' && state.error.length > 0) bits.push(`pageError=${state.error}`)
    bits.push(`waitedMs=${String(waitedMs)}`)
    return bits.join(' ')
  }

  /**
   * 一轮：建/复用 guest → **重新导航** → 轮询注入读数 → 到终态则回传。
   *
   * @returns 本轮是否产出一个「已被供给槽接受」的 param。
   */
  async function produceOnce () {
    // ★ 先问地址，**再建 guest**：没有地址就不该去占一个 renderer 进程
    //   （`no-carrier-url` 期间建 guest 是纯浪费：需求位为真就每轮都建）。
    const carrier = await resolveCarrierTarget()
    if (carrier === null) {
      // 安静的一类：不是故障。仍然记一行（首次 + 每 10 次），否则「内部载体为什么一直
      // 不产出」就彻底没有线索了。
      reportFailure(CARRIER_FAILURE.noCarrierUrl, 'captcha.carrierUrl 回 null（本轮不建 guest、不导航）')
      return false
    }
    const { origin, target } = carrier
    const element = await ensureGuest()
    if (element === null || element === undefined) return false
    /**
     * ★ `elapsedMs` 的锚点：**本轮开始产的时刻**，取在导航之前。
     * 于是它包含「导航 + 页面里 SDK 跑完 + 我们轮询到终态」的**全部时间**
     * （不含回传那一跳 RPC）。server 用「到达时刻 − elapsedMs」反推产出时刻判时效
     * （见 `src/jet-hub-rpc.ts` 的 `captcha.contribute`）：锚点取早只会**高估耗时 ⇒ 更早判过期**
     * （保守、宁丢不发）；把锚点挪到导航之后才会出事 —— 那低估年龄，把超龄 param 发出去吃 `3007`。
     */
    const mintStartedAt = now()
    const probeExpression = buildProbeExpression(target)
    const load = await navigateGuest(element, target)
    if (stopped) return false
    /** 状态码探针：一轮最多发一次（它比读数贵，且答案不会在轮询里变）。 */
    let probeStatus
    for (;;) {
      // 主进程把 guest 收走了 ⇒ 手里这个元素已经是死的，本轮作废（下轮 ensureGuest 重建）。
      if (stopped || guest !== element) return false
      // 导航失败时文档还是 about:blank ⇒ 不去读它（读出的 origin 只会误判成不同源）。
      const state = load.ok === true
        ? await evaluateJson(element, CARRIER_STATE_EXPRESSION, '读载体页状态')
        : {}
      if (state.mounted !== true && state.origin === origin && probeStatus === undefined) {
        // ⚠ 探针走 `evaluateRaw` 而不是 JSON 版：它回的就是一个裸状态码，
        //   而**页面被改写时回的可能是任何文本**（HTML 片段、扩展塞进来的字符串…）。
        //   拿 JSON.parse 去解它会让这一轮直接崩成 `round-crashed` ——
        //   那正好把「401 未认证」这条最需要看见的线索藏起来（本轮实测踩过）。
        const probed = Number(await evaluateRaw(element, probeExpression, '读载体页状态码'))
        // ⚠ 归一是必需的：探针回的不是数字时 `Number()` 得 NaN，而 NaN 既不 <0 也不 ===0
        //   ⇒ 会掉进「不是载体页」，把「探针没回话」误报成「服务器回了个别的页面」。
        probeStatus = Number.isFinite(probed) ? probed : -1
      }
      const waitedMs = Math.max(0, now() - mintStartedAt)
      const reason = classifyCarrierOutcome({
        expectedOrigin: origin,
        origin: state.origin,
        mounted: state.mounted,
        stage: state.stage,
        loadFailed: load.ok !== true,
        probeStatus,
        timedOut: waitedMs > timing.mintTimeoutMs,
      })
      if (reason === CARRIER_PENDING) {
        await sleep(timing.mintPollMs)
        continue
      }
      if (reason === null) return await contribute(element, state, mintStartedAt)
      reportFailure(reason, detailOf(state, probeStatus, waitedMs, load))
      // **只有「这个文档/guest 本身不可信」才换 guest**：认证与 origin 那两类换它也没用
      // （问题不在 guest），留着还能省一次租约往返；而 pending 到超时的页面是**真卡住了**，
      // 不换掉它下一轮只会继续读同一个死文档。
      if (reason === CARRIER_FAILURE.loadFailed
        || reason === CARRIER_FAILURE.mintTimeout
        || reason === CARRIER_FAILURE.mintFailed
        || reason === CARRIER_FAILURE.notCarrierPage
        || reason === CARRIER_FAILURE.probeFailed) destroyGuest()
      return false
    }
  }

  /** 把产出的 param 送进供给槽。⚠ 日志只报长度，绝不报 param 原文（一次性凭据）。 */
  async function contribute (element, state, mintStartedAt) {
    // ★ `interactive` 一并回传（评审 I2）：它是内部载体**唯一**的设备信誉预警，
    //   留在 client 控制台就等于没有 —— host 侧要靠它告警并计入趋势。
    const payload = buildContributePayload({
      param: state.param ?? '', mintStartedAt, now, interactive: state.interactive === true,
    })
    if (stopped || guest !== element) return false
    const result = await rpcCall('captcha.contribute', payload)
    if (result?.accepted === true) {
      resetFailureStreak()
      log('info', `${LOG_PREFIX} 已贡献一个 param：elapsedMs=${String(payload.elapsedMs)}ms`
        + '（从「本轮开始产」起算，含导航 + SDK + 等待 ⇒ server 拿它反推产出时刻）、'
        + `paramLen=${String(payload.param.length)} 字符`
        + `${payload.interactive ? '、已被降级成交互式验证（设备信誉预警，已回传 host）' : ''}`)
      return true
    }
    reportFailure(CARRIER_FAILURE.slotRejected,
      `accepted=${String(result?.accepted)} 耗时=${String(payload.elapsedMs)}ms paramLen=${String(payload.param.length)}`
      + `${payload.interactive ? ' interactive=true' : ''}`)
    // 槽不收 = server 判它不合格（垃圾产物 / 空串 / 异常短；收货口那道本地判据在
    // `src/captcha-supply.ts` 与 `src/zcode-captcha.ts`）⇒ 这个文档已经不可信，换掉。
    destroyGuest()
    return false
  }

  async function tick () {
    if (stopped || running) return
    running = true
    let nextDelay = timing.demandPollMs
    try {
      const demand = await rpcCall('captcha.demand', {})
      // ★ 规则 2：需求位不是真值 ⇒ 这一轮**什么都不做**（不建 guest、不导航、不产 param）。
      if (!stopped && demand?.active === true) {
        nextDelay = (await produceOnce()) ? timing.successCooldownMs : timing.failureCooldownMs
      } else if (guest !== null) {
        // 需求位落下来就把 guest 还掉。⚠ 不是洁癖：一个 `<webview>` 是一个**真的 renderer 进程**，
        //   没有需求时白占着它，就成了本期限定「不主动预产」时最反对的那种常驻产物。
        //   ⚠ 设备信誉的说法要写准（评审 I4）：**同一次运行内**释放 guest 不丢信誉
        //   （partition 还在那张内存表里）；但 partition **没有 `persist:`** ⇒
        //   **DSH 一关，下次启动就是一台新设备**。所以别把「释放了」写成「信誉没了」，
        //   也别把它当成「信誉能攒着」——跨启动不保留，这会抬高降级概率。
        destroyGuest('需求位已落下 ⇒ 归还 webview 租约（不留常驻离屏 renderer）')
      }
    } catch (error) {
      // 任何异常都不留坏 guest：主进程可能已经把它收了，留在原地只会轮轮失败。
      destroyGuest()
      // ⚠ 停止流程自己触发的「循环已停止」不是故障 —— 卸载时报一条 round-crashed 会误导排障。
      if (!stopped) reportFailure(CARRIER_FAILURE.roundCrashed, textOf(error))
      nextDelay = timing.failureCooldownMs
    } finally {
      running = false
    }
    if (!stopped) schedule(nextDelay)
  }

  schedule(timing.demandPollMs)

  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    destroyGuest()
  }
}
