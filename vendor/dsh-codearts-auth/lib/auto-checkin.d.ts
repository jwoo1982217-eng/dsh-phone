/**
 * 「每日首次启动自动签到」—— 开关、当日记录与执行体。
 *
 * ## 它做什么
 *
 * DSH 启动后延迟一小段（默认 30 秒，见下），若这个开关开着、且**今天（UTC+8）
 * 还没跑过**，就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与**逐渠道结果**写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ⚠️ **开关默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开状态」）。
 * 这与「这是代用户打上游的写操作」相权：该特性本身是用户要的，默认开启才符合
 * 「每日第一次打开 DSH 就自动签到」的预期；用户随时可以在状态灯上关掉。
 * 判据是**只有显式 `false` 才算关闭**（与本仓库账号的 `enabled !== false` 同惯例）。
 *
 * ## 为什么延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：整轮跑完**没有任何一条能证明「今天已被处理」**时**不记日期**，
 * 下次启动会重试（见 `shouldMarkToday`）。延迟可用
 * `DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS` 覆盖，`0` 合法（表示立刻跑，单测用它）。
 *
 * ## 什么算「今天已被处理」
 *
 * ⚠️ **不是** `claimed + alreadyClaimed`，而是各渠道用
 * `ClaimOutcome.coversToday` 声明出来的 `summary.coversToday`
 * （真实缺陷，2026-10-02 审查 PR !33 定位：Qoder 活动每日 10:00（UTC+8）才刷新，
 * 上午那轮看到的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**）。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 *
 * ## ⚠️「调用即判定」管不到的一类：签到**有代价**的渠道
 *
 * zcode 有签到，但每次领取都要现场产阿里云 captcha（web 版会拉起 headful
 * Chromium，且阿里云按设备限流 150 次/小时）。「等它返回错误再判定」来不及 ——
 * 代价发生在**调用期间**。故另有一张**排除表** `isAutoCheckinExcluded()`，
 * 在调 `claim` **之前**生效（详见那里的说明与维护口径）。用户仍可手动签到。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BadgeRpcResult } from './usage-badge.js';
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinState } from './types.js';
/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export declare const AUTO_CHECKIN_FILE = "auto-checkin.json";
/**
 * 文档内容。
 *
 * `lastDate` / `lastResult` 既是「当天不重复触发」的判据，也是状态灯提示的来源
 * （用户要求「记录签到状态，不多次重复触发」）。`channels` 是**逐渠道**结果，
 * 供面板上那行常驻的自动签到状态文字使用（用户 2026-10-02：「自动签到状态下，
 * 下方应该也显示文字状态，这样才能够知道各个渠道的签到状态」）。
 */
export interface AutoCheckinDoc {
    /**
     * 自动签到开关。**默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开
     * 状态」）—— 故判据是「只有显式 `false` 才算关闭」，与本仓库账号的
     * `enabled !== false` 惯例一致。
     */
    enabled: boolean;
    /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
    lastDate: string;
    /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
    lastResult: string;
    /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
    lastAt: number;
    /** 逐渠道结果（顺序即遍历顺序）；空数组 = 没有可展示的逐渠道信息。 */
    channels: Array<{
        provider: string;
        text: string;
    }>;
    /**
     * 用户点过「关闭」的那一轮（存的是那一刻的 `lastAt`）。
     *
     * ⚠️ 存 `lastAt` 而不是布尔：新一轮跑出来 `lastAt` 变了，状态文字就会**重新出现**
     *（否则用户关过一次以后就再也看不到新的结果）。0 = 未曾关闭过。
     */
    dismissedRunAt: number;
}
/** 默认：打开 + 无记录。 */
export declare const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc;
/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 * ⚠️ 缺新字段的**旧文档**（没有 `channels` / `lastAt` / `enabled`）必须照常读出来：
 * 前两个是本功能上线后追加的，而 `enabled` 缺失要按**默认打开**处理（不是关闭）。
 */
export declare function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc;
/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export declare function utc8DateString(nowMs?: number): string;
/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export declare const DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS = "DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS";
/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export declare const AUTO_CHECKIN_DELAY_MS = 30000;
/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_JET_HUB_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export declare function autoCheckinDelayMs(env?: NodeJS.ProcessEnv): number;
/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory';
/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
    readonly kind: AutoCheckinStoreKind;
    /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
    load(): AutoCheckinDoc;
    /** 整份写入（原子写）。 */
    save(doc: AutoCheckinDoc): Promise<void>;
}
/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveJetHubHome`）。 */
export declare function createAutoCheckinStore(ctx: Context): AutoCheckinStore;
/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
    /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
    providers: number;
    claimed: number;
    totalCredit: number;
    /**
     * ★ **按单位分组**的合计（2026-10-04）。
     *
     * ⚠️ 展示路径**必须**用它而不是 {@link totalCredit}：后者跨单位求和，
     * 会把 ZCode 的 token 与其余渠道的积分加成一个数（真实缺陷，见
     * `RpcCreditsClaimSummary.totalByUnit`）。
     */
    totalByUnit: Record<'token' | 'credit', number>;
    alreadyClaimed: number;
    inactive: number;
    failed: number;
    /**
     * 其中**能证明「今天这一轮已被处理」**的账号数（来自 `summary.coversToday`）。
     *
     * ⚠️ 这是 {@link shouldMarkToday} **唯一**该看的口径 —— 不能用
     * `claimed + alreadyClaimed`：那两项里混着「刷新前那一轮」的痕迹
     * （Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会让当天新额度整天漏领。
     * 字段语义见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
     */
    coversToday: number;
    /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
    skipped: number;
    /** 渠道级：其它错误（凭据、网络……）。 */
    errors: number;
}
/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export declare function isUnsupportedCheckin(message: string): boolean;
/**
 * ⚠️ **自动签到不适合**的渠道：领取过程需要**用户在场 / 外部程序**。
 *
 * ## 为什么不靠「错误文案」判（真实缺陷，2026-10-02 审查 PR !33 定位）
 *
 * 本文件原先的规则是「判据交给 `credits.claimAll` 自己：不支持的渠道会
 * **不发上游请求**就返回错误」。那对 cline / raccoon / workbuddy 成立 ——
 * 它们的守卫在 `claimAll` 里，返回前一个请求都没发。
 *
 * 但**漏了一类**：zcode **有**签到，只是每次领取都要现场产一个阿里云
 * captcha param（`jet-hub-rpc.ts` 的 zcode 分支无条件调 `zcode.mintCaptcha`）。
 * web 版下它会**拉起 headful Chromium**（约 200–400MB），而阿里云按**设备**
 * 限流「同设备每小时 150 次」。默认开启的自动签到等于：用户什么都没点，
 * 开 DSH 就起一棵浏览器进程树、白耗设备级配额；一旦这轮失败又不写 `lastDate`
 * ⇒ **每次启动都重来**，一天开十次就是十轮 captcha。
 *
 * ## 判据与维护口径
 *
 * - 这张表是**第二份名单**，但它记的不是「谁有签到接口」（那仍由
 *   `claimAll` 的守卫 + 客户端能力表负责），而是「谁有签到**代价**」——
 *   后者无处可查，只能显式登记。**新增带 captcha / 外部浏览器的 provider 时，
 *   必须同时登记到这里**（`tests/unit/auto-checkin.spec.ts` 有反向守护用例：
 *   一旦 zcode 的 claim 分支又开始调 `mintCaptcha`，而本表没登记，用例会红）。
 * - 用户仍可在面板里**手动**点 zcode 的「一键领取积分」—— 那是有意行为，
 *   浏览器弹出来是用户自己能理解的交互。
 */
export declare function isAutoCheckinExcluded(provider: string): boolean;
/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export declare function describeRun(totals: RunTotals): string;
/**
 * 这一轮该不该把「今天」记为已跑。
 *
 * 判据：**至少有一个账号能证明「今天这一轮已被处理」**（`coversToday > 0`）才记。
 *
 * ⚠️⚠️ **为什么不能看 `claimed + alreadyClaimed`**（真实缺陷，2026-10-02 审查
 * PR !33 定位）：那两项里混着「**刷新前那一轮**」的痕迹。Qoder 的活动每日
 * 10:00（UTC+8）才刷新，于是上午 9 点跑的那一轮看到的是**昨天**那条 `CLAIMED`
 * —— 记成「今天已跑」之后，当天 10 点刷新出来的新额度**整天不会再被领**，
 * 而且界面还显示「1 个今天已领」，用户毫无提示。渠道自己用
 * `ClaimOutcome.coversToday` 标出「这条不算今天」，本函数只负责数。
 *
 * 反例（不记、下次启动重试）：
 * - 整轮零成功零已领（凭据全过期 / 网络不通 / 启动太早抢在续期之前）——
 *   若记了，用户当天就再也不会自动签到，且界面只说「上次：N 个失败」；
 * - 跑完但**没有一条能证明今天**（例如只有 Qoder 且赶在 10:00 之前）——
 *   同理不记，当天稍后还有机会；
 * - 一个渠道都没跑（全被跳过）：没有意义，不记。
 * 反之「有成功也有失败」要记：否则一个坏账号会让插件每次启动都把好账号再领一遍
 * （虽然幂等，但白白多发请求）。
 */
export declare function shouldMarkToday(totals: RunTotals): boolean;
/**
 * 单个渠道的短状态（面板上那行常驻文字用它逐渠道列出，用户要求「这样才能够知道
 * **各个渠道**的签到状态」）。
 *
 * ⚠️ 必须**短**：9 个渠道要挤在 280px 的面板里一行一个片段，长文案会撑成好几屏。
 * 故只给「几个账号 + 什么结果」，不带渠道名（渠道名由展示层补）。
 */
export declare function describeChannel(summary: {
    claimed: number;
    totalCredit: number;
    alreadyClaimed: number;
    inactive: number;
    failed: number;
    /** 见 `RpcCreditsClaimSummary.coversToday`；缺省按 `claimed+alreadyClaimed` 兜底。 */
    coversToday?: number;
    /**
     * ★ 按单位分组的合计（2026-10-04）。**缺省回落到「全部按积分」**，
     * 以兼容尚未上报该字段的旧响应（与 `coversToday` 的兜底同思路）。
     */
    totalByUnit?: Partial<Record<'token' | 'credit', number>>;
}): string;
/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
    store: AutoCheckinStore;
    /**
     * 列出**账号池里有账号**的渠道 id。
     * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
     * 12 条分支。
     */
    listProviderIds(): Promise<string[]>;
    /**
     * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
     * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
     */
    claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>;
    now?(): number;
    /** 延迟毫秒数；默认读环境变量。 */
    delayMs?: number;
    /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
    schedule?(fn: () => void, ms: number): {
        cancel(): void;
    };
    warn?(message: string): void;
}
/** 自动签到执行体。 */
export interface AutoCheckin {
    /** 实时状态（供 RPC 与状态灯；`enabled` 等取自内存，不重新读盘）。 */
    state(): RpcUsageAutoCheckinState;
    /** 写开关；**打开时若今天还没跑过，立刻跑一轮**（否则用户会以为开关没生效）。 */
    setEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>;
    /**
     * 关闭面板上那行**常驻的**自动签到状态文字（用户点它上方的小按钮时调用）。
     *
     * ⚠️ 与手动签到的结果提示不同：那条是**按时自动消失**；这一条是用户要求
     * 「不要自动取消、给我开放手动关闭」。关闭记的是**这一轮**（当前的 `lastAt`），
     * 故下一轮跑出新结果时它会重新出现。
     */
    dismiss(): Promise<RpcUsageAutoCheckinState>;
    /** 启动时调用一次：延迟后排定一轮（内部自己判开关与当天是否已跑）。 */
    start(): void;
    /** 立刻按判据跑一轮（供「刚打开开关」与单测用）。 */
    runIfDue(): Promise<void>;
    /** 取消尚未执行的延迟任务（不打断已开始的一轮）。 */
    stop(): void;
}
/** 创建自动签到执行体。 */
export declare function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin;
export {};
//# sourceMappingURL=auto-checkin.d.ts.map