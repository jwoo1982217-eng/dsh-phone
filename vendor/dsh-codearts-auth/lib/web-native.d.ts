/**
 * 让 DSH 官方的 `web_search` 在 **buddy 系渠道**下走腾讯原生后端。
 *
 * ## 这个模块解决什么
 *
 * DSH 的搜索走 Host 的 `ctx.web` seam，默认 provider 是 `deepseek-official`
 * （`web-search-deepseek`）：它只认 DeepSeek 账号令牌与 `DEEPSEEK_API_KEY`，
 * 而账号令牌分支写死了 `provider === 'deepseek-account'`。于是 buddy / workbuddy
 * 路由下搜索必然落到 API Key 路径，没有 key 就报
 * `WEB_PROVIDER_CREDENTIAL_MISSING`。
 *
 * 而腾讯客户端**自带**原生搜索（`/agenttool/v1/search`），与聊天同源、同账号。
 * 本模块把那个端点接到官方工具上。
 *
 * ## ⚠️ 只管 `web_search`，**刻意不管** `web_fetch`（2026-10-14 修正）
 *
 * 本模块早期同时接管了 `web_fetch`（`/agenttool/v1/webfetch`），**那是净损失**，
 * 现已整体剔除。理由（三条，均有实测依据）：
 *
 * 1. **官方 fetch 根本不需要凭据**：宿主 `cordis.yml` 里
 *    `web.fetchProvider: http` → `@deepseek-ai/dsh-web-fetch-http`，官方文档原话
 *    「**不发送凭据**」，零配置、自带 SSRF 防护与明确响应上限（5 MB / 100k 字符）。
 *    实测：本机删掉 `DEEPSEEK_API_KEY` 后它照样 200。
 *    ⇒ 接管它**没有换来任何能力**（不像 search —— 那个官方**要** key）。
 * 2. **复杂表格塌陷**：同一份 `api-docs.deepseek.com/.../pricing` 页面，官方保留
 *    `| a | b |` 的行列结构，腾讯原生把整表挤成一行 ⇒ 模型读不出「哪个数字对应
 *    哪个模型」。而查文档/查价格恰是 fetch 最常被用的场景。
 * 3. **依赖账号有效**：账号过期时腾讯 fetch 直接失败；官方永远可用。
 *
 * （腾讯 fetch 确有独到之处：返回页面 `标题` 与多语言全文。但代价是表格结构丢失，
 *  用户 2026-10-14 权衡后决定撤回。）
 *
 * ## 设计约束（用户明确要求）
 *
 * 1. **替换，不新增**：不注册新工具、不加提示词、不改 schema —— 模型无感。
 * 2. **跟随渠道**：当前会话用什么渠道，就用那个渠道的原生搜索。
 * 3. **只做 buddy 系**：`buddy` + `workbuddy` 两条，其余一概不碰。
 * 4. **不回退、不路由**：判断不通过就 `return next()`，官方链路逐字节不变。
 *
 * ## 为什么挂在 `tools/execute`
 *
 * `tools/execute` 是 Cordis 的 **waterfall**：`next()` 就是「执行原工具体」。
 * 不调 `next()` 直接返回 `{ value }` ⇒ 官方工具体不执行，但返回值仍会被
 * `createSuccessResult(exec, 原工具, value)` 用**原工具自己的** `output.schema`
 * 校验、用它的 `render` 渲染 ⇒ 模型看到的结果与官方**同构**。
 *
 * 实测（cordis 4.0.2）：不调 `next()` 时内层工具体确实不执行，故**必须**返回
 * `{ value }` 形状。若返回 `undefined`，宿主会在 `normalizeDispatchResult` 里
 * 读 `result.isError` 而抛 `TypeError`，被外层 catch 转成一句无意义的
 * `Error: Cannot read properties of undefined (reading 'isError')` ——
 * 模型拿不到任何有用信息。（此条为**宿主源码推断**，未在真实宿主实跑。）
 *
 * ## 与插件既有行为的一致性
 *
 * 选号复用适配器自己的 `resolveCredentialFor()`（转发到聊天链路用的同一个
 * `resolveCredential`），因此「哪些号可用、选哪个号」与聊天完全一致。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import { type NativeSearchAdapter } from './native-search-contract.js';
/** `tools/execute` 事件里本模块用到的那部分 exec。 */
export interface WebNativeToolExecution {
    /** 工具名（本模块只处理 `web_search`）。 */
    readonly name: string;
    /**
     * 工具入参（**未经官方 schema 校验**）。
     *
     * ⚠️ 短路跳过了 `defineTool` 包装的 `execute`，而官方 schema 校验就在那里面
     *（见 `readQueries` 的说明）⇒ 这里拿到的入参**可能是任意形状**，本模块必须
     * 自己逐项校验，不能假设它已经是 `{ queries: string[] }`。
     */
    readonly arguments: unknown;
    /** 本次调用的取消信号（外层超时策略可能已替换为带 deadline 的版本）。 */
    readonly signal: AbortSignal;
    /** 发起本次调用的 agent；缺席表示非会话发起的调用。 */
    readonly agent?: {
        readonly session: {
            /**
             * 折叠后的 `request/header` 事件：当前会话最新解析出的路由配置。
             * 官方 `read_image` 的 `assertImageCapableRoute` 用的就是它。
             */
            requestHeader(): {
                readonly config?: {
                    readonly provider?: string;
                    readonly model?: string;
                };
            } | undefined;
        };
    };
}
/**
 * 把原生搜索挂到官方 web 工具上。
 *
 * @param ctx - 插件上下文（`tools/execute` 由它派发）。
 * @param adapters - 两个 buddy 系渠道的适配器；**必须是聊天链路用的那两个实例**。
 * @param isEnabled - 「渠道原生搜索」总开关。返回 `false` 时**所有渠道**（含 buddy 系）
 *   一律 `next()` 回官方搜索。⚠️ **每次调用都会求值**，调用方不要在这里做缓存 ——
 *   用户随时可能在 Jet Hub 面板里切换它。
 */
export declare function installWebNative(ctx: Context, adapters: Readonly<Record<string, NativeSearchAdapter>>, isEnabled: () => boolean): void;
//# sourceMappingURL=web-native.d.ts.map