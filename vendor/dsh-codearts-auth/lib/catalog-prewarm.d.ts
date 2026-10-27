/**
 * 冷启动的**有界目录预热**（issue IKJVTF）。
 *
 * ## 为什么需要它
 *
 * 冷启动时凭据可能还没就绪、或本机到目录端点的**首次**连接不稳定 ——
 * 首拉失败后 `remoteModels` 保持 `undefined`，适配器回落到**静态兜底表**。
 * 此后：
 *
 * - 客户端 `ModelCatalogDirectory` 把这份**兜底目录**缓存成 `status: 'ready'`
 *   （它只认宿主事件，见 `catalog-broadcast.ts`）；
 * - 适配器侧虽有闸门冷却，但**没有任何东西会在冷却到期后再试一次** ——
 *   只有用户主动操作（打开设置页、切换模型）才可能触发下一次 `listModels`。
 *
 * 于是「远端目录其实早就拿到了，只是没人再问一次」会一直持续到用户碰巧
 * 触发重读为止。本模块补的就是这条**自愈**路径。
 *
 * ## 为什么是「有界」而不是定时轮询
 *
 * 目录是**启动期**问题：稳态下 `remoteModels` 已落地，各适配器在
 * `remoteModels !== undefined` 处直接短路，预热调用是零成本的本地判断。
 * 但若做成无限轮询，一个**真的**拿不到目录的 provider（未登录 / 上游长期故障）
 * 会被每 30 秒唤醒一次，永远打无谓请求。故只排固定的几轮就停手。
 *
 * ## ⚠️ 间隔必须大于闸门的失败冷却
 *
 * `RemoteCatalogGate` 失败后冷却 {@link REMOTE_CATALOG_COOLDOWN_MS}（30 秒）。
 * 若预热间隔**小于**它，重试会被闸门**原样挡回**、什么也不做 ——
 * 那等于没有预热。故默认间隔是 35s（> 30，留 5 秒余量）。
 *
 * ⚠️ **光有「间隔 > 冷却」还不够**（对抗审计实测证伪）：闸门的 `retryAt` 是
 * 「**失败那一刻** + 30s」，而固定排程是「**启动那一刻** + 35s / 75s」——
 * 首拉耗时 `d` 落在 `(5s, 35s]` 时 35s 轮被挡回，落在 `(45s, 75s]` 时 75s 轮
 * 也被挡回（`d=60s` 实测：`retryAt=90s`，75s 轮时仍在冷却）。
 * ⇒ 排程改为**链式**（上一轮**结束**后再排下一轮），见 `runChain`。
 *
 * 这条约束由 `tests/unit/catalog-prewarm.spec.ts` 用
 * `isPrewarmSpacingValid()` 直接守着 —— 谁把间隔改小，那条用例就变红。
 */
/**
 * 预热轮次的间隔（毫秒，**相对上一轮结束**，见 `runChain`）。
 *
 * - `0` —— 首次立即执行（凭据往往已就绪，能一把拿到目录）；
 * - `35_000` / `75_000` —— 两段补拉间隔，覆盖「首拉时凭据未就绪 / 网络抖动」。
 *
 * ⚠️ 非零项必须**大于** {@link REMOTE_CATALOG_COOLDOWN_MS}，否则被闸门挡回。
 */
export declare const CATALOG_PREWARM_DELAYS_MS: readonly number[];
/** 日志出口（两级可选链，与仓库既有约定一致：日志不该成为功能的单点故障）。 */
export interface CatalogPrewarmLogger {
    warn?: (message: string) => void;
    info?: (message: string) => void;
}
export interface CatalogPrewarmOptions {
    /** 要预热的 provider 列表（通常取 `modelAdapters` 的键）。 */
    providers: readonly string[];
    /**
     * 触发一轮目录读取。
     *
     * 生产形态是 `(provider) => ctx.llm.listModels(provider)` —— 它会走完整路径
     * （账号门控 → `ensureRemoteModels` → 闸门），故目录已就绪时是**零网络**的。
     */
    warm: (provider: string) => Promise<unknown>;
    /** 预热时刻，默认 {@link CATALOG_PREWARM_DELAYS_MS}。 */
    delaysMs?: readonly number[];
    logger?: CatalogPrewarmLogger;
    /**
     * 定时器注入（测试用）。
     *
     * 默认 `setTimeout`；返回一个取消函数。注入它可让用例**同步**推进时间，
     * 不必真的等 35 秒（也不必用 `vi.useFakeTimers` 污染同文件其余用例 ——
     * 与 `BuddyAdapterOptions.now` 同款理由）。
     */
    schedule?: (fn: () => void, ms: number) => () => void;
}
/**
 * 启动有界预热，返回**停止函数**（须挂到 `ctx.effect` 上）。
 *
 * 每轮对每个 provider 各调一次 {@link CatalogPrewarmOptions.warm}。
 * 单个 provider 失败**不影响**其余（`Promise.allSettled` 语义）——
 * 一个未登录的 provider 不该让其它 provider 的预热一起消失。
 */
export declare function startCatalogPrewarm(options: CatalogPrewarmOptions): () => void;
/**
 * 预热间隔是否满足「大于闸门冷却」这条硬约束。
 *
 * 抽成函数是为了让**接线层**也能断言（不止单测）：间隔小于冷却时预热等于没做，
 * 且症状是「静默无效」（没有任何报错，只是目录一直补不回来）。
 */
export declare function isPrewarmSpacingValid(delays?: readonly number[]): boolean;
//# sourceMappingURL=catalog-prewarm.d.ts.map