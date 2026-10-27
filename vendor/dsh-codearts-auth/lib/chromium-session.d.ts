/**
 * 共享的 **Chromium 会话**：起一个 chromium、接上 CDP 通道、把它（连同窗口）干净地收掉。
 *
 * ## 为什么抽出来（2026-10-08）
 *
 * 本仓库原本只有 ZCode 需要外挂 chromium（阿里云 captcha）。库库AI（百度 GenFlowPro）
 * 的登录是 **cookie 登录而非 OAuth**（见 `docs/agent-notes/providers-kukuai.md` §5.4），
 * 要把 `.baidu.com` 上的 **HttpOnly** cookie 取回来，同样只能靠「自己起浏览器 + CDP」。
 *
 * 于是「起 chromium」这件事有了第二个调用方。而下面这些**每一条都是真实缺陷换来的**，
 * 各写一份必然分叉（分叉的方向恒定是「漏修的那份」）：
 *
 * | 缺陷 | 症状 | 修法 |
 * |---|---|---|
 * | 不监听 `'error'` | spawn 失败时**未捕获异常直接杀掉整个宿主** | `child.once('error', …)` |
 * | 只杀主进程 | chromium 是多进程（实测 13 个），子进程变孤儿 | `taskkill /T` / 进程组 |
 * | 异步 `taskkill` | 调用方以为清理完了，旧实例还占着端口 | `spawnSync` |
 * | 端口纯随机 | 连到旧实例 → `child` 指向死进程 → 整棵树泄漏 | 探测空闲端口 + 校验应答端口 |
 * | 一次性 `rmSync` | 句柄未释放，残留数十个 profile 目录 | 退避重试 |
 * | 窗口进任务栏 | 每次刷新都在任务栏闪烁（用户报障） | `WS_EX_TOOLWINDOW` / EWMH / 最小化 |
 *
 * ## 与 ZCode 的关系
 *
 * `src/zcode-captcha.ts` 的 `ZcodeCaptchaBrowser` 改为**组合**本模块的
 * {@link ChromiumSession}，captcha 专属的东西（反检测补丁、页面池、DOM 重置、
 * 表达式构造）全部留在那边。本模块**不含任何 captcha 语义**。
 *
 * ⚠️ 浏览器**发现**（{@link browserCandidates} 一族）与**窗口隐藏**也在这里：
 * 它们回答的是「哪个 chromium 可用」「怎么让它别打扰用户」，同属浏览器设施。
 */
/**
 * 浏览器可执行文件的**候选链**（按优先级，`ZCODE_CHROME_PATH` 恒排第一）。
 *
 * ## 为什么抽成**纯函数**
 *
 * 候选链按平台分叉后，**macOS / Linux 分支在本仓库的 Windows CI 上一次都执行不到** ——
 * 直接写在 `findBrowserExecutable()` 里，这些路径会永远「静默通过」，
 * 直到用户报障（IKJKNT 就是 macOS 那条的先例）。
 * 抽出来后它们是纯字符串计算，可在任何平台断言。
 *
 * 三个入参都可注入，正是为了这个：`platform` 定分支、`env` 造 scoop /
 * `ZCODE_CHROME_PATH`、`home` 造 `~/Applications` 与 `~/.local/share/flatpak`。
 *
 * ## ⚠⚠ **`else` 分支是 Windows —— 别把它当「非 Win 也走这儿」
 *
 * 三个平台的分支必须**显式**列全。历史上 `linux` 落在 else 里拼出一套
 * `PROGRAMFILES` / `msedge.exe`（Linux 上全不存在 ⇒ 恒找不到浏览器），
 * 与 macOS 那条**完全同型**。**新增平台时务必在这里加一条显式分支。**
 *
 * ## ⚠ 两个必须防的坑（都实测踩过）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', …)` 返回 `Google\Chrome\…` —— 一个**相对路径**，
 * `existsSync` 会相对**当前工作目录**解析。于是「当前目录下恰好有个同名文件」
 * 会被误判成浏览器，而真正的浏览器却找不到。
 *
 * ⇒ {@link findBrowserExecutable} 只接受**绝对路径**候选（`isAbsolute` 过滤）。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 的安装位置在 `~/.scoop` 或 `~/scoop` 下，而 `~` 应当用
 * `os.homedir()` 求（它还会看 `HOME`，且在 `USERPROFILE` 被改写时仍正确）。
 * 用 `process.env.USERPROFILE` 拼路径会在「环境变量异常/被沙箱改写」时失效 ——
 * 实测：把 `USERPROFILE` 指到沙箱后，原本可用的 scoop chromium 就找不到了。
 */
export declare function browserCandidates(input?: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    home?: string;
}): string[];
/** 在候选链里挑第一个**存在**的绝对路径。 */
export declare function findBrowserExecutable(): string | undefined;
/**
 * 找不到浏览器时的**用户可执行提示**（按平台说人话）。
 *
 * ## 为什么必须分平台（Gitee issue IKJKNT）
 *
 * 修复前是单一口径：「已尝试 scoop chromium / Chrome / Chromium / Edge；
 * 可用 ZCODE_CHROME_PATH 显式指定 **chrome.exe** 路径。」
 * —— macOS 上 **scoop 根本不存在**、`chrome.exe` 也不是那个文件名
 * （见 {@link MAC_BROWSER_BUNDLES}），用户照着提示做只会更懵。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts`。
 *
 * ⚠ 第二个参数（环境变量名）是抽到共享模块时加的，**默认值保持 zcode 的
 * 原样文案**；库库AI 传自己的变量名，用户看到的出路才不会指错。
 */
export declare function browserNotFoundMessage(platform?: NodeJS.Platform, overrideEnvName?: string): string;
/**
 * 该可执行文件是否是**系统 Edge**（候选链的最后几档）。
 *
 * ## 为什么单独抽成纯函数
 * 「实际用了哪个浏览器」需要被**告警**（issue IKJLB1 的期望行为 2：
 * 用户不知道系统在拿 Edge 兜底）。告警条件必须可测，故不留在启动流程里。
 *
 * ⚠️ 判据是**文件名**（不区分大小写），而不是路径里搜 `Edge`：
 * 前者对 `…\Microsoft\Edge\Application\msedge.exe`、scoop 布局、
 * macOS 的 `…/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` 以及
 * 用户经 `ZCODE_CHROME_PATH` 指向的 Edge 副本都成立；
 * 后者会把路径中恰好含 "Edge" 字样的第三方 chromium 误报成系统 Edge。
 *
 * ⚠⚠ **macOS 那个名字是同型缺陷的修复**（2026-10-03，issue IKJKNT）：
 * 原判据只认 `msedge.exe`，而 macOS 包内二进制叫 **`Microsoft Edge`**
 * （无扩展名）⇒ Mac 用户落到 Edge 兜底时**一声不吭**，与 IKJLB1
 * 的期望行为 2 直接冲突。补这个别名时别把判据改成 `includes('edge')`
 * —— 那会把 `Brave Browser` 之类的路径误伤。
 */
export declare function isEdgeExecutable(executable: string): boolean;
/**
 * 把窗口从**任务栏**移除（按平台分派；整体失败静默）。
 *
 * ## 为什么需要（用户报障，2026-09-29）
 *
 * > captcha 的 chromium 每次刷新页面完成都会在任务栏**闪烁提示**；
 * > 任务栏自动隐藏时会不停浮出，挡住屏幕最下面一排。
 *
 * 根因（Win32 实测）：主窗口缺 `WS_EX_TOOLWINDOW`（`0x80`），
 * 而 `--window-position=-32000,-32000`（移出屏幕）**不足以**让它不进任务栏 ——
 * 页面一渲染就获得任务栏按钮，有按钮就有东西可闪。
 *
 * ## 实测取证（Windows，13 个窗口）
 *
 * | 项 | 结果 |
 * |---|---|
 * | 打上后 `inTaskbar` | 13 个窗口**全部 false** |
 * | 连续 3 次 mint 后样式是否被重置 | **全部保持**（不会被 chromium 重置） |
 * | 对 captcha 功能的影响 | mint 仍成功（1802~1950ms） |
 * | 成本 | 约 1.2 秒（**这是这一步 PowerShell 自身的耗时，不是 mint 的耗时**）；**只需在启动时做一次**，可与约 3.7 秒的启动并行 ⇒ 几乎免费 |
 *
 * ⚠ **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。
 * 借外部工具都有失败可能（策略限制/无权限/未安装），此时最坏结果是回到
 * 修复前的行为（窗口在任务栏），**绝不能让 captcha 因此不可用**。
 *
 * ⚠ 调用**时机**由 {@link ChromiumSession} 保证：必须在页面渲染**之前**
 * （否则窗口已获得任务栏按钮）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选）。macOS 藏窗失败时用它告警一次，原因见
 *   {@link hideWindowMacos}：失败被静默吞掉，用户报「窗口还是弹出来」时
 *   没有这条日志就只能猜。
 */
export declare function hideWindowFromTaskbar(pid: number, log?: (message: string) => void): void;
/**
 * macOS：把该 pid 的 chrome 窗口**最小化**（`set miniaturized of every window to true`）。
 *
 * ## 为什么是最小化（而非 osascript 移屏 / 1x1）
 *
 * 真机（macOS，主屏 0,0 1470×956）对 4 种藏法逐一验证了「窗口是否仍挂在
 * 屏幕可见区」与「captcha 是否仍能 mint」：
 *
 * | 藏法 | 命令 | captcha 实测 |
 * |---|---|---|
 * | 最小化 | `set miniaturized … to true` | **稳**（10/10 mint OK，paramLen 280） |
 * | 移到 -32000 | `set position … to {-32000,-32000}` | **偶发 `F001`**（窗口离屏时 SDK 取证帧偶尔拿到空 canvas） |
 * | 1×1 缩到角 | `set size … to {2,2}` | 偶发 F001（同上，渲染尺寸过小触发 SDK 重试） |
 * | `--headless=new` | （启动参数） | 一律 `F001`，**不可用** |
 *
 * 结论：macOS 上**最小化是唯一同时满足「不挡屏幕」与「mint 稳定」**的做法。
 * 最小化后窗口缩到屏幕右下角（Dock 区），肉眼几乎不可见，且不破坏 captcha。
 *
 * ## 为什么不用 osascript `set position`（移屏）
 *
 * `--window-position=-32000,-32000` 已经传给了 chromium，但
 * **macOS 的 WindowServer 会把离屏窗口钳回屏幕内**（与 `--headless` 相反，
 * 这是系统行为，不是 chromium 行为）。所以「移屏」这条在 macOS 上等于没移。
 * 最小化则不受该钳制影响（窗口仍在屏幕坐标系内，只是缩到角上）。
 *
 * ## ⚠⚠ 依赖：宿主必须已授予 macOS「辅助功能」权限（与 Linux 的 wmctrl 不同）
 *
 * | | Linux | macOS |
 * |---|---|---|
 * | 机制 | WM 协议（EWMH 客户端消息） | `osascript` 驱动 System Events 的 UI 脚本 |
 * | 依赖 | 外部工具 `wmctrl` | 系统自带 `osascript`，**但 UI 脚本需宿主被授予「辅助功能」权限** |
 * | 缺了怎么办 | `apt install wmctrl`，一条命令 | 系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主，**通常还要重启应用** |
 * | 用户知道吗 | 报错会说「没装 wmctrl」 | **大多数人不知道这个权限存在**，且授权可能随应用升级被重置 |
 *
 * ⇒ 未授权时 `osascript` 非零退出，被本函数的静默语义吞掉，**窗口照常弹出**。
 * 这是「减少打扰」的优化失效，不是功能故障；用户报「窗口还是弹出来」时先查这一项。
 *
 * ## 接入与失败语义（与 Windows/Linux 侧对称）
 *
 * - **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。`spawn` 的
 *   `error`/非零退出都直接吞掉，最坏结果回到修复前的行为（窗口正常弹出），
 *   **绝不能让 captcha 因此不可用**。
 * - 与 Windows 侧一样用 `windowsHide: true` + `stdio: 'ignore'` 异步 fire-and-forget。
 * - **只按 pid 匹配**（`unix id`），刻意没有「按进程名兜底」—— 理由与代价见
 *   {@link hideWindowMacos} 的函数头。
 * - ⚠ 本函数是**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
 *   没有字符串插值 ⇒ 没有引号/反斜杠转义问题（初版的进程名兜底栽在这里）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @returns `osascript` 参数数组（`-e <script>`），纯函数便于单测锁死。
 */
export declare function buildMacosMiniaturizeArgs(pid: number): string[];
/**
 * 构造「把窗口加入 `_NET_WM_STATE_SKIP_TASKBAR`」的 `wmctrl` 参数。
 *
 * ⚠ `-i` 必带：让 `-r` 按**窗口 id** 匹配（`0x...`），而不是按标题 ——
 * 标题里有空格/括号（chromium 的标题是「新标签页 - Chromium」）会被误解析。
 *
 * ⚠ **只加 `skip_taskbar`，不加 `skip_pager`**：前者即「不出现在任务栏」
 * （这正是要的）。`skip_pager` 是「不出现在工作区切换器」，与本次目的无关，
 * 多加会改变用户对窗口的既有预期（用户没要求隐藏工作区条目）。
 *
 * ⚠ 也**不**用 `-b add,hidden`（最小化）：chromium 已经用
 * `--window-position=-32000,-32000` 移出屏幕，再改最小化状态会与
 * captcha 流程的窗口假设冲突（那些流程依赖窗口"存在且可渲染"）。
 */
export declare function buildLinuxSkipTaskbarArgs(windowId: string): string[];
/**
 * 从 `wmctrl -lp` 的输出里筛出**属于指定 pid** 的窗口 id。
 *
 * 输出格式（每行，字段以空白分隔）：
 * ```
 * 0x0320000a  0 12345  hostname  Window Title
 * └─ 窗口 id  │  └─ pid
 *            └─ 桌面号
 * ```
 *
 * ⚠ **标题可能含任意空白**，故只能按「前 4 个字段」切分，**不能**整体
 * `split(/\s+/)` 后取全部 —— 那样标题会被拆散（对本用途无害，但会让人
 * 误以为解析"完全正确"）。
 *
 * ⚠ 只取**前 4 个字段**：第 4 列（hostname）之后全是标题。
 * 用 `split(/\s+/, 5)`（限 5 段）恰好把标题保留为最后一段。
 *
 * @returns 属于该 pid 的窗口 id（形如 `0x0320000a`）；解析不到就返回空数组。
 */
export declare function parseWmctrlList(output: string, pid: number): string[];
/** 极简 CDP 客户端（用 Node 内置 WebSocket，**零第三方依赖**）。 */
export declare class CdpConnection {
    private readonly ws;
    private nextId;
    private readonly pending;
    constructor(ws: WebSocket);
    /**
     * 发送一条 CDP 命令并等结果。
     *
     * ⚠️ **`sessionId` 是给页面级命令用的**（2026-10-08 实测踩到）：
     * 浏览器级端点只认 `Target.*` / `Storage.*` / `Browser.*` 这类命令；
     * 一旦用 `Target.attachToTarget { flatten: true }` 拿到 `sessionId`，
     * **此后每条页面级命令都必须带上它**，否则命令落在**浏览器端点**上，
     * 回报的是一句含糊的 `-32601 'XXX' wasn't found`
     * —— 看起来像「API 不存在」，实际是「你没说要发给哪个页面」。
     *
     * ⚠️ 同一条实测还纠正了两个流传的说法：**浏览器级没有**
     * `Network.getAllCookies`，也**没有**浏览器级 `Network.getCookies`
     * （都回 `-32601`）。要读 cookie，浏览器级的唯一可用命令是
     * `Storage.getCookies`，且**不需要 `sessionId`**。
     */
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<unknown>;
    close(): void;
}
/** 可被 `unref` 的 sleep（生产由 HTTP server 撑着 event loop）。 */
export declare const sleep: (ms: number) => Promise<void>;
/** {@link ChromiumSession} 的启动选项。 */
export interface ChromiumSessionOptions {
    /** 可执行文件；缺省用 {@link findBrowserExecutable} 自动探测。 */
    executablePath?: string;
    /** 调试端口；缺省挑一个空闲的。 */
    debugPort?: number;
    /**
     * 是否把窗口藏起来（默认 **true** —— 不打扰用户）。
     *
     * ⚠️ 库库AI 的登录**必须可见**（用户要自己操作），故它传 `false`。
     */
    hideWindow?: boolean;
    /** 临时 profile 目录的前缀（便于在 `%TEMP%` 里认领）。 */
    profilePrefix?: string;
    /** 就绪等待上限（毫秒，默认 30000）。 */
    readyTimeoutMs?: number;
    /** 窗口尺寸（`宽,高`）。 */
    windowSize?: string;
    /** 启动后要打开的地址（缺省不开页面，由调用方用 CDP 建 target）。 */
    initialUrl?: string;
    /** 追加的命令行开关。 */
    extraArgs?: string[];
    /**
     * 错误文案的**产品前缀**（如 `zcode`）。
     *
     * ⚠️ 抽成参数是为了让既有产品的报错**逐字不变** —— 那些文案有回归用例锁着。
     */
    label?: string;
    /**
     * 「找不到浏览器」文案里紧跟其后的括注（默认空）。
     *
     * ⚠️ 同样是为了**逐字保持**既有产品的报错（zcode 原句带
     * 「（用于产出阿里云 captcha）」）。新调用方不需要就留空。
     */
    notFoundHint?: string;
    /**
     * Edge 兜底告警里的产品名（默认取 {@link label}）。
     *
     * ⚠️ 也是**逐字保持**用的：zcode 原句写的是 `zcode captcha`，
     * 而它的错误码前缀是 `zcode` —— 两个口径不同，故必须能分开给。
     */
    edgeLabel?: string;
    /** 提示用户「换浏览器」时用的环境变量名（默认 `ZCODE_CHROME_PATH`）。 */
    overrideEnvName?: string;
    /** 诊断输出（缺省静默）。 */
    log?: (message: string) => void;
}
/**
 * 一个常驻的 chromium 会话：进程 + 调试端口 + CDP 通道。
 *
 * 生命周期：`start()` → 用 `cdp.send(…)` → `kill()`（只杀进程树 + 关通道）
 * 或 `dispose()`（再删临时 profile）。
 *
 * ⚠️ **`dispose()` 必须被调用**，否则会留下一个孤儿 chromium
 * （约 200-400MB）；`kill()` 与 `dispose()` 的分工见各自注释。
 */
export declare class ChromiumSession {
    private readonly options;
    private child;
    private ws;
    /**
     * 浏览器级 CDP 通道。
     *
     * ⚠️ 是**公开可写字段**（不是私有 + getter）：既有回归用例直接注入桩
     * （`tests/unit/zcode-page-prepared.spec.ts`），换成访问器会改变它们的写法。
     */
    cdp: CdpConnection | undefined;
    private profileDir;
    private port;
    private starting;
    /**
     * 浏览器**起不来 / 自己没了**的可读原因（由启动流程里的
     * `'error'` / `'exit'` 监听写入，见该处注释）。
     *
     * `undefined` = 一切正常。轮询循环每轮检查它，命中即立刻失败 ——
     * 否则「浏览器秒退」要白等满 `readyTimeoutMs`（默认 30 秒）才报错。
     */
    private spawnFailure;
    private readonly log;
    constructor(options?: ChromiumSessionOptions);
    /** 浏览器是否已就绪。 */
    get ready(): boolean;
    /** 调试端口（诊断与 `/json/list` 用）。 */
    get debugPort(): number;
    /** 浏览器主进程 pid（清理与诊断用）。 */
    get pid(): number | undefined;
    /**
     * 浏览器级 WebSocket。
     *
     * ⚠️ 与 {@link cdp} 同理：公开可写，供既有用例注入桩。
     */
    get socket(): WebSocket | undefined;
    set socket(value: WebSocket | undefined);
    /** 启动（幂等：并发调用共享同一次启动）。 */
    start(): Promise<void>;
    private launch;
    /**
     * 终止浏览器进程**树**并清理所有 CDP 连接（**保留**临时 profile）。
     *
     * ⚠ 与 {@link dispose} 的分工：`kill()` 用于「还要重来一次」的场景
     * （captcha 轮询超时后会重新 `start()`），故不能删 profile。
     *
     * ## ⚠ 为什么必须杀**整棵树**（真实缺陷）
     *
     * 早期只写 `child.kill()` —— 那只杀**主进程**。而 Chromium 是
     * **多进程架构**（browser / gpu / renderer / utility 各一个进程），
     * 主进程被 `SIGTERM` 后**子进程会变成孤儿继续运行**。
     *
     * 实测证据（一次被中断的测试后）：
     *   - **12 个** 残留 `chrome.exe` 全指向同一个 `--user-data-dir`
     *   - **28 个**残留的临时 profile 目录
     *
     * 生产影响：**每次会话泄漏约 200MB**（一个 Chromium 实例），
     * 且残留进程占着调试端口，会干扰后续启动（曾让一次 `max` 档位测试
     * 表现得像「卡住 80 秒」，实为旧实例干扰）。
     *
     * 修法：POSIX 用进程组（`detached: true` + `kill(-pid)`），
     * Windows 用 `taskkill /T /F`（`/T` = 含子进程树）。
     */
    kill(): void;
    /**
     * 终止浏览器及其**全部子进程**。
     *
     * ⚠ 不能退回成 `child.kill()`（见 {@link kill} 的说明：会留下孤儿）。
     *
     * ⚠⚠ **必须同步等它做完**（真实缺陷）：早期用异步 `spawn('taskkill', …)`
     * 后立即返回 —— 调用方以为清理完了、紧接着启动下一轮，而旧实例**还活着
     * 占着端口**。若下一轮随机撞到同一端口就会串成：
     * 连到旧实例 → `child` 指向已退出的新进程 → `dispose()` 打空 →
     * **旧实例整棵树泄漏**（实测 10~14 个进程）。
     *
     * 实测对照：`dispose()` 后**立即**下一轮会偶发泄漏；
     * 每轮间隔 2.5 秒则 5/5 干净 —— 正是「没等它退完」的特征。
     *
     * 故改用 `spawnSync`：清理路径阻塞几十毫秒是可接受的，
     * 换来确定性的「返回即已终止」。
     */
    private killProcessTree;
    /**
     * 关闭浏览器并清理临时 profile。
     *
     * ⚠ 删除要**重试几次**：chromium 的子进程刚被 taskkill 掉，
     * 句柄释放有延迟 —— 一次性 `rmSync` 实测会留下 28 个残留目录。
     * 用退避重试（100/500/1500ms），全部失败就交给系统回收临时目录。
     */
    dispose(): void;
}
//# sourceMappingURL=chromium-session.d.ts.map