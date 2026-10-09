/**
 * 从网关响应帧里读出**真正服务这笔请求的上游渠道**。
 *
 * ## 为什么需要（真实缺陷，用户报障 2026-09-30）
 *
 * 用户报障：「上游显示的不正确」。
 *
 * 原先「请求记录」的「上游」列取的是**模型 id 的 `/` 前缀**
 * （`clineUpstreamOf(model)`）—— 那其实是**模型命名空间/订阅通道**
 * （`cline-pass` / `cline-free`），甚至可能是**厂商名**
 * （`deepseek/deepseek-v4.1-flash` → `deepseek`），**不是**服务这笔请求的渠道。
 * 参考实现（`github.com/codeOct/dsh-cline-pass`）的同一列显示的是
 * `alibaba` / `baseten` 这类**真实 serving channel**，取自网关下发的路由元数据。
 *
 * ## 四种实测形态
 *
 * | 形态 | 路径 | 例 |
 * |---|---|---|
 * | **流式（真实链路就是这个）** | `choices[0].delta.provider_metadata.gateway.routing.finalProvider` | `deepseek` |
 * | 非流式 / planner | `choices[0].message.provider_metadata.gateway.routing.finalProvider` | `alibaba` |
 * | 帧顶层 | `provider_metadata.gateway.routing.finalProvider` | `alibaba` |
 * | direct 管线 | `delta.provider` / 顶层 `provider` | `GMICloud` |
 *
 * ⚠️⚠️ **第一版读漏了 `delta` 这一层，导致修复完全没生效（真实缺陷，2026-10-01）**：
 * 当时按「非流式挂 `message`、流式挂**帧顶层**」实现，而**实测的流式帧把它挂在
 * `choices[0].delta` 上** —— 于是每帧都读不到、`upstream` 一直是空串，
 * 展示层回落到模型命名空间（`cline-pass`），用户看到的仍是「修复前」的值
 * （用户报障：「上游显示的还是错误的」）。
 * 复盘：这条**只能靠一次真实流式请求**才能定案 —— 参考实现的样例只说了
 * 「出现在携带它的那一帧上」，并没有说是挂在 `delta` 还是帧顶层，我当时
 * **按猜测填了帧顶层**。凡「外部载荷的确切层级」，要么实测，要么在注释里
 * 明确标注为未验证的假设。现由 `scripts/probe-cline-routing-live.mjs`
 * （一次性真实流式请求）逐帧打印命中路径。
 *
 * ⚠️ 参考实现注释原文：*"in a stream it appears on whichever frame carries it,
 * so every frame is inspected and the last non-null reading wins"* ——
 * 故调用方必须**逐帧**喂进来，且**以最后一次非空读数为准**。
 *
 * ⚠️ **大小写两种拼写都要认**：错误体实测用的是 camelCase
 * （`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
 * 见 AGENTS.md 的 Gemini-400 段），成功路径的样例是 snake_case
 * （`provider_metadata`）。只认一种会在另一种形态下静默读不到。
 *
 * ⚠️ **`finalProvider` 既可能是基础设施商也可能是模型厂商自己的 API**：
 * 实测 `cline-pass/deepseek-v4.1-flash` → `deepseek`，而参考实现抓到的样例是
 * `alibaba` / `baseten`。两者都是「网关最终决定由谁服务」，故**原样展示**，
 * 不要试图把它归类成一种。
 *
 * ⚠️ **读不到就返回空串**（调用方回落到模型命名空间）——绝不编造渠道名。
 */
/**
 * 从**一帧**已解析的响应 JSON 里读出上游渠道（读不到返回空串）。
 *
 * 调用方应逐帧调用并保留最后一个非空结果。
 */
export declare function parseClineRouting(frame: unknown): string;
//# sourceMappingURL=cline-routing.d.ts.map