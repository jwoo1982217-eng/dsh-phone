/**
 * ZCode 的阿里云 captcha 产出（**唯一还需要浏览器的环节，但只服务 claim 路径**）。
 *
 * ## 谁还要 captcha（2026-10-01 直连上游实测，别再凭印象改）
 *
 * | 端点 | 不带验证头 | 结论 |
 * |---|---|---|
 * | `/api/v1/zcode-plan/anthropic`（**模型请求**） | **HTTP 200**（6 个采样点） | **自 3.14.4（2026-09-29）起不再索要** |
 * | `/api/v1/zcode-plan/billing/claim`（**领取**） | `400 {"code":3007}` | **始终索要**，且校验**前置于** plan 校验 |
 *
 * ⇒ 模型请求这条路现在**恒不产** param（`src/captcha-requirement.ts` 的
 * 「先探后取」使 mint 次数归零）；仍在产的是**领取**（每日一次 / 手动点「一键领取」，
 * **每个 plan 独立一个**，一次性，复用必 `3007`）。
 * ⚠ 模型请求侧的 `3007` 防御分支**故意保留**：万一上游回滚再开校验，推理请求仍能自愈，
 * 而不是把失败抛给用户。
 *
 * ## 载体：web 版必需浏览器，桌面版可用内部载体
 * captcha 是**网页 SDK**（`o.alicdn.com/.../AliyunCaptcha.js`），任何有 DOM 能跑 JS 的
 * 浏览器都能产。本文件这套外挂 chromium 路径是 **web 版的必需项**；
 * DSH Desktop 下会优先用**桌面自己的 Electron 内核**（`dshDesktop.browser` 租约 +
 * 隐藏 `<webview>` + `executeJavaScript`，见 `src/captcha-carrier.ts`），
 * 本文件退为其**兜底**（`DSH_ZCODE_INTERNAL_CARRIER=0` 可强制只用它）。
 *
 * ## 为什么能用普通浏览器而不是 ZCode 那个壳
 *
 * captcha 是**网页 SDK**，不是 Electron 专有 API：
 *
 * ```
 * script:  https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 * config:  window.AliyunCaptchaConfig = { region, prefix }
 * 调用:    initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, … })
 * 取参:    getInstance 里调 instance.startTracelessVerification()（无感验证）
 *          → success(param) 回调给出 param
 * ```
 *
 * 故任何「有 DOM + canvas + 能跑 JS」的浏览器都行。实测
 * **scoop 的 chromium（headful + 基本 stealth 补丁）** 可稳定产出。
 *
 * ## ⚠ 两个实测得到的约束（第 1 条后来**被推翻**，结论以第 2 条为准）
 *
 * ### 1. ~~同一个页面**不能**重复 mint~~ → **已推翻**（当时页面停在 `about:blank`）
 *
 * 同一 page 上连续 `initAliyunCaptcha` 三次的实测结果：
 *
 * | 次序 | 结果 | 耗时 |
 * |---|---|---|
 * | #1 | ✓ len=280 | 817ms |
 * | #2 | ✗ `F001` | 279ms |
 * | #3 | ✗ `F001` | 296ms |
 *
 * ⇒ SDK 实例状态在页面内不可重复初始化。**每次 mint 必须新建 page target**。
 * 采用该策略后实测 **4/4 成功，中位 1246ms**（浏览器冷启动仅 690ms）。
 *
 * ⚠⚠ **上面那两行是当时的结论，现在别再照着做**：真正的变量是页面 origin ——
 * 那三次是在 `about:blank`（origin 为字符串 `"null"`）上跑的。换到真实
 * `https://zcode.z.ai/` 后同一页面可**连续 mint 5/5**，中位 426ms / 平均 546ms，
 * 现行实现因此**复用常驻页面 + 每次重置 DOM**。证据与推理见
 * {@link CAPTCHA_PAGE_ORIGIN}；上面的表保留仅作原始记录（改回去会让耗时翻 2.3 倍）。
 *
 * ### 2. `--headless=new` 过不了，必须 **headful**
 *
 * | 模式 | 结果 |
 * |---|---|
 * | `--headless=new`（+ 补丁） | ✗ `fail` / `verifyCode: F001` |
 * | **headful + 补丁** | ✓ 280 字符合法 param |
 *
 * 阿里云风控会看这个差异。headful 在 Windows 上可以**不打扰用户**
 * （`--window-position=-32000,-32000` 移出屏幕）。
 */
/** 阿里云 captcha 配置（服务端下发；此处为实测兜底值）。 */
export interface ZcodeCaptchaConfig {
    /** 区域：`cn`。 */
    region: string;
    /** 前缀：决定请求走到哪个阿里云子域。 */
    prefix: string;
    /** 场景 id。 */
    sceneId: string;
}
/**
 * 兜底 captcha 配置。
 *
 * ⚠ 这些值**实测自本机账号**（`GET /api/v1/client/configs?platform=unknown`
 * 的 `data.configs.captcha`）。理论上可能随账号/灰度变化，故
 * `ZcodeAuth.fetchCaptchaConfig()` 会优先向服务端索取，此处仅作兜底。
 */
export declare const ZCODE_CAPTCHA_FALLBACK: ZcodeCaptchaConfig;
/** 阿里云 captcha SDK 地址（与官方逐字一致）。 */
export declare const ALIYUN_CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
/** SDK 需要的 DOM 宿主 id（与官方 `zcode-aliyun-captcha-*` 一致）。 */
export declare const CAPTCHA_CONTAINER_ID = "zcode-aliyun-captcha-container";
/** 挂载点 id。 */
export declare const CAPTCHA_ELEMENT_ID = "zcode-aliyun-captcha-element";
/** 按钮 id。 */
export declare const CAPTCHA_BUTTON_ID = "zcode-aliyun-captcha-button";
/**
 * captcha 页面必须导航到的**真实 origin**。
 *
 * ⚠⚠ **这是能否重复 mint 的关键**（实测矩阵）：
 *
 * | origin | 同一页面连续 mint |
 * |---|---|
 * | `about:blank` | **1/3**（#2 起 `F001`） |
 * | **`https://zcode.z.ai/`** | **5/5，平均 546ms** |
 *
 * 阿里云 SDK 会读 `location.origin` 参与风控判定，而 `about:blank` 的
 * origin 是字符串 `"null"` —— 于是第二次起被拒。
 *
 * ⚠ 这一条此前被**误判**成「同一页面不能重复 mint，必须每次新建 page」，
 * 导致实现多付了 2.3 倍的耗时（1246ms → 546ms）。
 * 结论修正的代价是：**改一个变量、看结果**比堆假设更快。
 */
export declare const CAPTCHA_PAGE_ORIGIN = "https://zcode.z.ai/";
/**
 * 解析**载体页 origin**：注入值优先，空白/缺省一律回落实测常量。
 *
 * ## 为什么存在（以及它为什么**不是**配置项）
 * 唯一的用途是让本地探针 `scripts/probe-captcha-local-origin.mjs`（不入库）能验证
 * 「在 `http://127.0.0.1:<port>` 这种本地 origin 上，阿里云 SDK 到底产不产得出合法
 * param」—— 那是「DSH web 版能否用用户浏览器当载体」这条路线的唯一准入问题
 * （跨域 iframe 拿不到 DOM、浏览器也不给页面 CDP 权，所以载体页只能是 GUI 自己的 origin）。
 *
 * ⚠ **不许**把它接到 env / settings / UI：真实 https origin 是实测硬前提
 * （`about:blank` 的 origin 是 `"null"`，第二次 mint 必 `F001`）。
 * 默认值与空白回退由 `tests/unit/zcode-captcha-origin.spec.ts` 锁死。
 *
 * ⚠ 空白也算回落：注入空串会让导航变成 `about:blank`（即上面那条已知失败形态）。
 */
export declare function resolveCaptchaPageOrigin(options?: {
    pageOrigin?: string;
}): string;
/**
 * captcha param 的合法判据（与桥侧 `isUsableCaptchaParam` 同一套）。
 *
 * 三条全中才算合法：
 * 1. 长度 ≥ **200**（实测合法值 280；降级垃圾约 76）
 * 2. 是 base64 且能解出 JSON
 * 3. 含 `securityToken` 且长度 ≥ **50**（实测合法值 128）
 *
 * 任一条不中即判为降级 —— **不发请求**：在索要验证的窗口里那发注定 `3007`；
 * 即便上游此刻不校验这个头，把降级产物发出去也不是「成功」，故本地判据不放宽。
 */
export declare function validateCaptchaParam(param: unknown): {
    ok: boolean;
    reason?: string;
};
/**
 * 浏览器可执行文件的**候选链**（按优先级，`ZCODE_CHROME_PATH` 恒排第一）。
 *
 * ## 为什么抽成**纯函数**
 *
 * 候选链按平台分叉后，**macOS / Linux 分支在本仓库的 Windows CI 上一次都执行不到** ——
 * 直接写在 `findBrowserExecutable()` 里，这些路径会永远「静默通过」，
 * 直到用户报障（IKJKNT 就是 macOS 的 macOS 那条的先例）。
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
 */
export declare function browserNotFoundMessage(platform?: NodeJS.Platform): string;
/**
 * 该可执行文件是否是**系统 Edge**（候选链的最后几档）。
 *
 * ## 为什么单独抽成纯函数
 * 「实际用了哪个浏览器」需要被**告警**（issue IKJLB1 的期望行为 2：
 * 用户不知道系统在拿 Edge 兜底）。告警条件必须可测，故不留在 `launch()` 里。
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
 * 构造请求体里那段「建 DOM + 注入 SDK」的表达式。
 *
 * ## ⚠⚠ 这里的 DOM 重置与下面的 SDK 注入**必须配对**（真实缺陷，2026-10-01）
 *
 * 本函数把 `document.body.innerHTML` **整体替换** —— 于是旧的
 * `#captcha-element` / `#captcha-button` 元素**被销毁**。
 *
 * 而 `buildSdkInjectExpression()` 原本在「SDK 已加载」时**早退**（返回
 * `'already'`），**不重建 SDK 实例**。两者叠加的后果：
 *
 * ```
 * 第 1 次 mint：注入 SDK → initAliyunCaptcha 绑定 #captcha-element → ✓ 成功
 * 第 2 次 mint：DOM 被替换（旧元素销毁）→ SDK 早退（实例仍指向旧元素）
 *              → 用失配的实例发起验证 → ✗ F001
 * ```
 *
 * **实测取证**（同一页面、跨轮、每次先空闲 20 秒）：
 *
 * | 场景 | `inject` 返回 | 结果 |
 * |---|---|---|
 * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001** ×3（471/454/591ms） |
 * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
 *
 * ⇒ **`F001` 与"空闲时长"无关** —— 真正的变量是「DOM 是否被重置而 SDK 未重建」。
 * 这一条纠正了 2026-09-29 的误判（当时把现象归给空闲，并据此加了
 * 「空闲 8 秒就换页」的预测式重建，白付约 2.7 秒/次）。
 *
 * ⚠ 与之配套的修法在 {@link buildSdkInitExpression}：**DOM 重建后必须
 * 重新 `initAliyunCaptcha`**（销毁旧实例、用新元素重新初始化）。
 */
export declare function buildDomExpression(): string;
/**
 * 构造注入 SDK 的表达式（用 `<script src>`，简单可靠）。
 *
 * ⚠ **无参**：SDK 地址是常量，`region`/`prefix`/`SceneId` 由 {@link buildMintExpression}
 * 在 `initAliyunCaptcha` 那一刻才用 —— 别在这里塞 config，那会多出一条无人读的形参。
 */
export declare function buildSdkInjectExpression(): string;
/**
 * 一次 captcha 产出的**结果 + 观测**。
 *
 * `interactive` 的语义（对齐官方 `mnn` 的 `interactive_displayed`）：
 * - `false` = **无感验证**直接通过（正常路径）
 * - `true`  = 被要求**交互式验证**（滑块/拼图）⇒ **设备信誉可能已下降**
 *
 * ⚠ 判据是「曾经观察到交互元素」——因为阿里云的这一层**不对外透出**
 *（官方文档 Q9 原文：「该安全策略逻辑不支持自定义，不对外透出」），
 * 只能靠看 DOM。
 */
export interface CaptchaMintOutcome {
    /** 产出的 param。 */
    param: string;
    /** 本次是否被降级为交互式验证（`true` = 信誉预警信号）。 */
    interactive: boolean;
}
/**
 * 构造「触发无感验证并等 param」的表达式。
 *
 * ## 为什么这三个表达式构造函数现在**导出**（二期 Task 3）
 * 内部载体的**载体页**（`src/zcode-carrier-page.ts`）必须由 server 渲染，
 * 才守得住「captcha 表达式只在 server 侧一份」这条约束 ——
 * client 里再写一遍 SDK 调用必然与本文件漂移（本仓库反复吃过同型缺陷）。
 * 除载体页外**不得**有第二个消费方。
 *
 * ⚠ 与 {@link STEALTH_PATCH} 的区别刻意为之：那份反检测补丁是**外挂 chromium**
 * 为了遮 `--headless` 痕迹才需要的，内部载体是 Electron 真实 guest，
 * 实测 `webdriver=false`、UA 带 `Electron/44.0.0` 时 4/4 产出合法 param
 * ⇒ 补丁**既不导出也不使用**（搬进载体页属于无据扩面）。
 */
export declare function buildMintExpression(config: ZcodeCaptchaConfig): string;
/** 常驻浏览器的启动选项。 */
export interface ZcodeCaptchaBrowserOptions {
    /** 可执行文件；缺省自动探测。 */
    executablePath?: string;
    /** 调试端口；缺省随机（9300-9799）。 */
    debugPort?: number;
    /** 是否隐藏窗口（默认 true —— 用户不应被打扰）。 */
    hideWindow?: boolean;
    /**
     * 载体页 origin（缺省 `CAPTCHA_PAGE_ORIGIN` = `https://zcode.z.ai/`）。
     *
     * ⚠ 仅供本地探针验证「本地 origin 行不行」，**不是生产配置**；
     * 取值规则与红线见 {@link resolveCaptchaPageOrigin}。
     */
    pageOrigin?: string;
    /** 就绪等待上限（毫秒）。 */
    readyTimeoutMs?: number;
    /**
     * 页面导航后的等待（毫秒）。
     *
     * ⚠ 真实 origin 的页面需要等 `domcontentloaded` 才有 `body`
     * （实测约 1.5 秒足够；`about:blank` 只需几百毫秒）。
     */
    navigationWaitMs?: number;
    /**
     * 页面**空闲多久后主动换页**（毫秒）。
     *
     * ## ⚠ 默认已改为「**不因空闲换页**」（`Number.POSITIVE_INFINITY`）
     *
     * ### 为什么会改（原设计基于一个**未能复现**的前提）
     *
     * 原默认 `8_000`（8 秒）的依据是一条实测：*「同一页面空闲 15 秒后 mint
     * 必然 `F001`」*。但 2026-10-01 用更严格的变量分离**复测时无法复现**：
     *
     * | 场景（同一页面、零换页） | 结果 | 耗时 |
     * |---|---|---|
     * | 空闲 20 秒后**什么都不做**直接 mint | ✓ 3/3 | **467ms** |
     * | 空闲 20 秒后**重置 DOM** 再 mint（= 原生产行为） | ✓ 3/3 | 479ms |
     * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
     *
     * 而**走生产 `mint()` 路径**时空闲 20 秒后：成功但**每次都换页**，
     * 耗时 **2.6–3.5 秒**。
     *
     * ⇒ 结论：**「空闲必然失效」不成立**；那个阈值让每次空闲后都白付一次
     * 建页成本（约 2.7 秒）。这正是用户报障「一键签到里 ZCode 很久」的成因
     * —— 而不是 captcha 本身慢（**失败时**的自愈能力仍然保留：`mint()` 里
     * `attempt > 1` 会 `forceFresh` 换页重试）。
     *
     * ### 现在的策略：**复用优先，失败才换页**
     *
     * ```
     * 默认（Infinity）           → 只要页面还在就复用（约 0.5 秒）
     * mint 失败（F001 等）        → 丢弃该页 + 换新页重试一次（原有的自愈链）
     * ```
     *
     * ⚠ 这**不增加 captcha 调用次数**：失败那次本就发了请求，且它是恢复所必需的。
     * 最坏情况（真遇到 F001）比原来多花约 0.5 秒，而**常态下省掉约 2.7 秒**。
     *
     * ⚠ 若将来又观测到「空闲后必失败」，把这里设成一个有限值即可回到
     * 「预测式换页」——但请**先复现证据**，别只看单次现象（本参数就是这么来的）。
     *
     * 设成 `0` 等于「每次新建」（慢，仅在排查时用）。
     */
    idleReuseMs?: number;
    /**
     * 等**别的 mint** 让出页面时的上限（毫秒，默认 30000）。
     *
     * ⚠ 这不是「性能参数」而是**防死锁参数**（真实缺陷，2026-09-29）：
     * 取页是 `while (pageBusy) await sleep(50)` 的自旋，一旦某个持有者没能
     * 复位标志，这里就是**永久自旋** —— 而它既不看 signal 也没有上限，
     * 表现为「请求根本不发出、UI 永远深度求索中、点停止也无反应」。
     * 有界失败远好于永久挂起（失败会被上报成错误，挂起只能重启宿主）。
     */
    pageWaitTimeoutMs?: number;
    /**
     * 新建页面时等待 CDP WebSocket `open` 的上限（毫秒，默认 10000）。
     *
     * ⚠ 同理是防死锁：旧实现只等 `open` / `error` 两个事件，Chromium 僵死时
     * **两个都不来**，于是永久挂起（且因为不抛错，`pageBusy` 也不会复位）。
     */
    connectTimeoutMs?: number;
    /**
     * 诊断输出（可选，缺省静默）。
     *
     * ⚠ 只用于**说明性**信息，目前只有一条：实际落到系统 Edge 兜底时告警
     * （Gitee issue IKJLB1 的期望行为 2 —— 此前 Edge 是被静默选中的，
     * 用户既不知道用了哪个浏览器，也不知道该去哪换）。
     *
     * ⚠ 形参与 `src/captcha-carrier.ts` 的 `CaptchaCarrierDeps.log` 一致，
     * 由 `zcode-auth.ts` 传 `ctx.logger` 进来；**不给也不影响功能**。
     */
    log?: (message: string) => void;
}
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
 * `--window-position=-32000,-32000` 已经由 `launch()` 传给了 chromium，但
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
 * - ⚠ 本函数是本文件**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
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
/**
 * 常驻浏览器会话。
 *
 * ## 为什么常驻
 *
 * 冷启动实测约 690ms，但**每次请求都冷启动**会让首字延迟凭空多一秒。
 * 而 mint 只在**上游索要验证时**才发生：复用常驻页面的稳态约 0.4–0.5 秒
 * （中位 426ms / 平均 546ms，见 `CAPTCHA_PAGE_ORIGIN` 的矩阵），含 chromium
 * 冷启动的首发实测 4.2 秒；至于「每次新建 page」那个 1246ms，是 origin 修正
 * **之前**的历史值，别当现行口径（数字汇总见 README 的 ZCode 章节）。
 * （上游不要验证的窗口里这条路**一次都不走**，见文件头的「按需」段。）
 *
 * ## 生命周期
 *
 * `dispose()` 必须被调用（`ZcodeAuth.stop()` 里做），否则会留下
 * 一个孤儿 chromium 进程（约 200-400MB）。此外还注册了进程退出钩子兜底。
 */
export declare class ZcodeCaptchaBrowser {
    private readonly options;
    private child;
    private browserWs;
    private browserCdp;
    private profileDir;
    private port;
    private starting;
    /**
     * 复用的 captcha 页面（停在 {@link CAPTCHA_PAGE_ORIGIN} 上）。
     *
     * ⚠ 复用而非每次新建：实测 546ms vs 1246ms（快 2.3 倍）。
     * 前提是 origin 必须真实 —— 见 `mint()` 的说明。
     */
    private reusablePage;
    /**
     * 页面是否正被某次 mint 占用。
     *
     * captcha param 是**一次性**的，两个并发 mint 共用同一页面会互相踩状态。
     * 故用该标志把取页串行化（并发调用排队，而不是拿到同一个页面）。
     */
    private pageBusy;
    /** 诊断输出（见 {@link ZcodeCaptchaBrowserOptions.log}），缺省 undefined = 静默。 */
    private readonly log;
    /**
     * 浏览器**起不来 / 自己没了**的可读原因（由 `launch()` 里的
     * `'error'` / `'exit'` 监听写入，见该处注释）。
     *
     * `undefined` = 一切正常。轮询循环每轮检查它，命中即立刻失败 ——
     * 否则「浏览器秒退」要白等满 `readyTimeoutMs`（默认 30 秒）才报错。
     */
    private spawnFailure;
    constructor(options?: ZcodeCaptchaBrowserOptions);
    /** 浏览器是否已就绪。 */
    get ready(): boolean;
    /** 启动（幂等；并发调用共享同一次启动）。 */
    start(): Promise<void>;
    private launch;
    /**
     * 产出**一个新鲜**的 captcha param。
     *
     * ## ⚠⚠ 实测约束（第 2 条曾在 2026-10-01 被**推翻并修正**，务必读完）
     *
     * ### 1. 页面 origin 必须是**真实 https**，不能用 `about:blank`
     *
     * | origin | 同页连续 mint |
     * |---|---|
     * | `about:blank` | **1/3**（#2 起 `F001`） |
     * | `https://zcode.z.ai/` | 连续 5/5 |
     *
     * 阿里云 SDK 会检查 origin（`about:blank` 的是 `"null"`），风控据此拒绝。
     *
     * ### 2. ~~空闲约 15 秒后同一页面必然失效~~ → **已推翻**
     *
     * 曾经（2026-09-29）观测到下面这张表，据此加了「空闲 8 秒就换页」：
     *
     * | 用例 | 当时的结果 |
     * |---|---|
     * | 立即 mint | ✓ 3786ms |
     * | **间隔 15s**（复用页面） | ✗ `F001` 416ms |
     * | 间隔 45s / 90s（复用页面） | ✗ `F001` |
     * | 全新浏览器 + 新页面 | ✓ 3692ms |
     *
     * ⚠ 但 2026-10-01 用**变量分离**复测（同一页面、零换页、每组都先预热成功）
     * **无法复现**：
     *
     * | 场景 | 结果 | 耗时 |
     * |---|---|---|
     * | 空闲 20 秒后**什么都不做**直接 mint | ✓ **3/3** | **467ms** |
     * | 空闲 20 秒后**重置 DOM** 再 mint（= 当时的生产行为） | ✓ 3/3 | 479ms |
     * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
     *
     * ⇒ **`F001` 与"空闲时长"没有稳定因果关系**（当时那次更可能是环境/风控
     * 的瞬时状态，或与实验方法有关 —— 我早期两个实验分别在 baseline 前
     * 跑了注入、以及误用了私有 `acquirePage`，两者都污染过结论）。
     *
     * ### 3. 因此现在的策略：**复用优先，失败才换页**
     *
     * ```
     * 默认（idleReuseMs = Infinity）  → 只要页面还在就复用（约 0.5 秒）
     * 任一次 mint 失败（F001 等）      → 丢弃该页、换新页重试一次（自愈链）
     * ```
     *
     * ⚠ 原来的「预测式换页」让**每次空闲后都白付约 2.7 秒**建页成本 ——
     * 这正是用户报障「一键签到里 ZCode 很久」的成因（而不是 captcha 慢）。
     * 改成失败兜底后：**常态省约 2.7 秒、不增加 captcha 调用次数**，
     * 真遇到 `F001` 时的自愈能力与原来一致（甚至更快：
     * 原来"先换页"是必然付费，现在只在真失败时才付）。
     */
    /**
     * 产出 captcha param，**并报告本次是否被降级为交互式验证**。
     *
     * ## 为什么需要（对齐官方 ZCode 的观测，2026-10-01）
     *
     * 官方闭源版对每次产出结果都会区分并上报（`out/renderer/assets/styles-*.js`）：
     *
     * ```js
     * mnn({ result: e ? 'interactive_displayed' : 'traceless_passed', … })
     * // pnn() 里维护 traceless_passed_count / captcha_displayed_count
     * ```
     *
     * 那是它判断**设备信誉是否在恶化**的手段 —— 而此前我们没有任何这个数，
     * 排查「为什么突然 502 mint failed」时只能靠猜（这正是本次最缺的东西）。
     *
     * ⚠ 与 {@link mint} 的关系：那个是「只要 param」的既有签名（多处调用），
     * 这个是它的**超集**，内部复用同一条产出路径 —— 不要各写一份。
     */
    mintWithOutcome(config?: ZcodeCaptchaConfig, options?: {
        signal?: AbortSignal;
    }): Promise<CaptchaMintOutcome>;
    /**
     * 产出 captcha param。
     *
     * ## 复用策略（⚠ 空闲失效，见本方法上方的实测表）
     *
     * ```
     * 默认（idleReuseMs = Infinity）→ 复用（约 0.5 秒）
     * 任一次 mint 失败（F001 等）    → 丢弃页面、换新重试一次
     * ```
     *
     * ⚠ **不再按空闲时长预测式换页**（2026-10-01 修正）：原「空闲 15 秒必然
     * 失效」的推论在变量分离复测中**无法复现**，详见 `mintInternal` 上方的
     * 完整对照表。预测式换页让每次空闲后白付约 2.7 秒。
     */
    mint(config?: ZcodeCaptchaConfig, options?: {
        signal?: AbortSignal;
    }): Promise<string>;
    /** `mint` / `mintWithOutcome` 的共用实现（**唯一**的产出路径）。 */
    private mintInternal;
    /** 在**指定页面**上跑一次 captcha（不含页面获取/重试逻辑）。 */
    private mintOnPage;
    /**
     * 取一个可用的页面。
     *
     * ## 复用策略：**复用优先，失败才换页**
     *
     * ```
     * forceFresh = true            → 丢弃旧页、建新页（`mint()` 第一次失败后的重试）
     * 空闲 > idleReuseMs           → 丢弃旧页、建新页（默认 Infinity ⇒ 不触发）
     * 否则                          → 复用（约 0.5 秒）
     * ```
     *
     * ⚠ **默认不再按空闲时长换页**（2026-10-01 修正）：原「空闲 15 秒必然
     * `F001`」的推论在变量分离复测中**无法复现**（空闲 20 秒后直接复用
     * 仍 3/3 成功、约 0.47 秒），而每次换页要付约 2.7 秒。
     * 详见 `ZcodeCaptchaBrowserOptions.idleReuseMs` 的完整说明。
     *
     * ⚠ 串行化：captcha 是**一次性**的，两个并发 mint 共用同一页面会互相
     * 踩状态。故用 `busy` 标志把取页串起来 —— 并发调用会排队，
     * 而不是拿到同一个页面。
     */
    private acquirePage;
    /**
     * 作废一个页面：关掉它、从池里摘掉。
     *
     * ⚠ **必须真的关闭 target**（不只是清引用）—— 否则页面会累积，
     * 且每个坏页面都占着一份 SDK 实例。
     *
     * ⚠ 关不掉也不抛错：这是清理路径，不该因为清理失败而让 mint 报错。
     */
    private discardPage;
    /** 归还页面（保留复用）。 */
    private releasePage;
    /**
     * 终止浏览器进程**树**并清理所有 CDP 连接。
     *
     * ## ⚠ 为什么必须杀**整棵树**（真实缺陷）
     *
     * 早期只写 `this.child?.kill()` —— 那只杀**主进程**。而 Chromium 是
     * **多进程架构**（browser / gpu / renderer / utility 各一个进程），
     * 主进程被 `SIGTERM` 后**子进程会变成孤儿继续运行**。
     *
     * 实测证据（一次被中断的测试后）：
     *   - **12 个** 残留 `chrome.exe` 全指向同一个 `--user-data-dir`
     *   - **28 个**残留的 `zcode-captcha-*` 临时 profile 目录
     *
     * 生产影响：**每次会话泄漏约 200MB**（一个 Chromium 实例），
     * 且残留进程占着调试端口，会干扰后续启动（曾让一次 `max` 档位测试
     * 表现得像「卡住 80 秒」，实为旧实例干扰）。
     *
     * 修法：POSIX 用进程组（`detached: true` + `kill(-pid)`），
     * Windows 用 `taskkill /T /F`（`/T` = 含子进程树）。
     */
    private kill;
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
    /** 关闭浏览器并清理临时 profile。 */
    dispose(): void;
}
/**
 * 用户主目录（导出给测试注入用；避免测试真的去碰 `~/.zcode`）。
 *
 * 目前仅用于文档目的 —— 实际路径解析在 `zcode.ts` 的候选表里。
 */
export declare const ZCODE_HOME: string;
//# sourceMappingURL=zcode-captcha.d.ts.map