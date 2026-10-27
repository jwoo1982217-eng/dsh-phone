/**
 * `usage.badge` 对 `jet-hub-auto` 的**改写判定**（纯逻辑，便于单测行为断言）。
 *
 * ## 为什么单独一个模块
 *
 * 这段判定原先内联在 `jet-hub-rpc.ts` 的 `case 'usage.badge'` 里。那个文件有
 * 4500+ 行且大量 import，单测**无法 import 它的内部函数**，于是既有测试只能对
 * 源码做**字符串/正则断言**（`expect(RPC).toMatch(/lastDecision/)`）。
 *
 * ⚠️ 我实测发现那类断言是**恒真的假用例**：把实现改成 `if (false && …)` 之后，
 * 正则**照样命中**，用例依然全绿 —— 而功能已经完全失效。这是「测试全绿但功能
 * 是死的」里最难发现的一种（本仓库 AGENTS.md 首条判据记的正是这类静默失效）。
 *
 * ⇒ 把判定搬到这里，测试可以直接 `import` 并**行为断言**：
 *   喂入不同的 `autoState`，断言返回的改写结果。这符合本仓库既有做法
 *   （`badge-model.js` / `aggregate-panel-logic.js` 都是「逻辑与渲染分离」的纯模块）。
 *
 * ## 为什么判定要分三档（真实缺陷，用户报障 2026-10-06 / 2026-10-08）
 *
 * | 情形 | 行为 | 理由 |
 * |---|---|---|
 * | 非 auto | 原样透传 | 其余 15 家的行为**逐字不变** |
 * | auto 且有真实历史 | 用 `lastDecision` | 那是**实际发出**的目标，零成本零误差 |
 * | auto 且无历史 | 回退到**预测** | 否则插件刚重启时徽标是空的，用户以为它坏了 |
 * | auto 但适配器没挂上 | 报错 | 拿 auto 去查余额必然失败，不如给出可行动文案 |
 *
 * ⚠️ 「有历史」必须**优先于**预测：预测可能因上游失败切换 / 带图改道而错，
 *    而徽标是**止损工具**（用户原话「以为在用 A，实际在烧 B，等发现时积分
 *    已经没了」）—— 显示错人比不显示更危险。
 *
 * @module src/auto-badge.ts
 */
/** auto 适配器经 `modelAdapters` 表交给 RPC 层的最小接口（见 `ModelCatalogSource`）。 */
export interface AutoBadgeState {
    /** 最近一次**实际**发出的目标；未发过请求时为 `null`。 */
    lastDecision: {
        provider: string;
        model: string;
        viaImageFallback: boolean;
        expiryAt?: number;
    } | null;
    /** 最近一次选型胜者的失效时刻（未选过型时 `undefined`）。 */
    lastWinnerExpiryAt?: number;
    /** 按临期判据选一次（**预测**，仅供「尚无真实历史」时兜底）。 */
    selectProvider(): Promise<{
        provider: string;
        model: string;
    } | undefined>;
    /** 查已记下的倍率（`undefined` = 没记过，**不得编造**）。 */
    priceOf(provider: string, model: string): number | undefined;
}
/** 改写结果（判别联合，测试可逐字段断言）。 */
export type AutoBadgeRewrite = {
    kind: 'passthrough';
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'rewrite';
    /** 真正去查余额的渠道（auto 时是胜者，其余情况是原 provider）。 */
    effectiveProvider: string;
    /** 供客户端显示「实际在用谁」；非 auto 时缺席。 */
    autoActual?: {
        provider: string;
        model: string;
        viaImageFallback: boolean;
    };
    /** 胜者额度失效时刻；**只有有限值**才带（`Infinity` 会被 JSON 序列化成 `null`）。 */
    autoExpiryAt?: number;
    /** 计费倍率；**只有有限值**才带（`Infinity` 是「无标注」哨兵）。 */
    autoPrice?: number;
};
/**
 * 判定 `usage.badge` 该把请求改写成谁。
 *
 * @param provider - 请求里的 provider（**调用方已 `trim`**）。
 * @param autoProviderId - auto 的路由 id（由调用方传 `AUTO_PROVIDER_ID`，
 *   避免本模块反向依赖 `auto-adapter.js` 而拖进一堆运行时依赖）。
 * @param autoState - auto 适配器的状态入口；未挂载时 `undefined`。
 * @returns 改写判定。
 */
export declare function resolveAutoBadgeRewrite(provider: string, autoProviderId: string, autoState: AutoBadgeState | undefined): Promise<AutoBadgeRewrite>;
/**
 * `aggregate-core.ts` 的 `UNUSABLE` 哨兵值 —— **此处刻意重复字面量**。
 *
 * ⚠️ 本模块刻意**零 import**（它被宿主 RPC 层与单测直接使用，注释见模块头：
 * 不反向依赖 `auto-adapter.js` 以免拖进一堆运行时依赖）。故这里复刻 `-1`，
 * 一致性由 `tests/unit/auto-badge-rpc.spec.ts` **与 `aggregate-core` 对拍**锁死
 * —— 那条用例会直接 `import { UNUSABLE }` 并断言本常量与它相等，改一侧即红。
 */
export declare const UNUSABLE_EXPIRY = -1;
//# sourceMappingURL=auto-badge.d.ts.map