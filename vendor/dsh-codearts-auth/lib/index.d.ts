import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type ImageRequestTarget } from './image-budget.js';
import { type ProviderRuntime } from './provider-runtime.js';
export declare const name = "codearts-auth";
export declare const inject: string[];
/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 Jet Hub 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    providers: Schema<NoInfer<import("@deepseek-ai/cosmokit").Dict<any, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<any, string>>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    providers: Schema<NoInfer<import("@deepseek-ai/cosmokit").Dict<any, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<any, string>>, "volatile-defined">;
}>>, "plain">;
/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export declare function makeReadImage(ctx: Context): (attachment: unknown) => Promise<{
    data: Uint8Array;
    mediaType: string;
}>;
/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export declare function makeReadImageRequest(ctx: Context): (attachment: unknown, target: ImageRequestTarget) => Promise<{
    data: Uint8Array;
    mediaType: string;
} | undefined>;
/**
 * 「重测」用的**探测适配器工厂**（Task 8）。
 *
 * ⚠️ 各家代码**逐字**从 `src/account-probe.ts` 的 `else if` 链搬来（含各自的
 * 注释）；那条链已删除，改为查本表（**未登记 ⇒ 抛可读错误**）。
 *
 * ## 谁必须在这里
 *
 * 判据是「该 provider 的适配器会不会写 `modelRateLimits`」（写了才有重测语义）。
 * 核对方式机械、不要靠记忆：
 *
 *     grep -n 'updateModelRateLimit(' src/*.ts        # 写点（池侧定义 + 各适配器直调）
 *     grep -n 'markLimited' src/*.ts                  # 适配器侧经回调注入的写点
 *
 * ⚠️ **两条都要跑**：实测多数适配器是**直调** `pool.updateModelRateLimit(...)`
 * （只有 `cline` / `opencode` 用 `markLimited` 这个名字），只看第二条会把
 * 大部分家漏掉。
 *
 * ⚠️ **不要在这里抄名单、也不要写「几家」**：本段曾写「会写标记的 provider 共
 * **13 家**」并紧跟 13 个名字，2026-10-11 加入 `minimax`（issue IKJW32）后当场过期
 * —— 这正是本文件自己记的「同一条事实的多份抄写必然漂移」的又一次实证。
 * 权威判据是上面那两条 grep；权威清单是 `tests/helpers/provider-sets.ts` 的
 * `WRITES_RATE_LIMIT_PROVIDERS`（守卫把它与源码写点**双向**比对，
 * 漏一家 / 多一家都点名变红）。本表必须**恰好**登记那份清单里的家。
 *
 * 登记史（只记形态、不记数字）：
 *
 * - **第 5 次** `loomy` / `raccoon`：旧 `else if` 链里**没有它们的分支** ⇒ 落入
 *   `else` 被交给「华为云 HMAC 签名」的 `CodeArtsAdapter`，而它们的限流标记
 *   （UTC+8 当日 24:00）**永远清不掉**。
 * - **第 6 次** `opencode`：不是漏项，而是「登记表刻意豁免了它」且**理由被证伪**。
 * - **第 7 次** `minimax`：它先前**确实**不写标记（14 家里唯一），故曾被判
 *   「不需要 probe」；2026-10-11 接上请求级换号 + 冷却后该前提作废。
 *   ⇒ 判据永远是「**现在**写不写标记」，不是「曾经写不写」。
 *
 * ⚠️⚠️ **不要再写「`opencode` 不写标记」**（2026-10-08 原注释如此，独立复审
 * 实测证伪）：它与「余额是本地派生的通道可用性、零网络」说的是**两件事** ——
 * 后者是它不进积分表的理由（见 `provider-credits.ts`），前者是它进不进出本表的
 * 判据。把前者当成后者的推论，恰好把一个**真实的漏挂**说成了「不需要」。
 *
 * ⚠️ **UI 入口**：`jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」
 * 都由 `supportsRateLimit(provider)` 门控（缺省 **true**），**不是**
 * `accountTest`（那是另一个「测试」按钮的位）。原注释称「`accountTest` 只有
 * `gemini` 为 true ⇒ 其余渠道没有入口」—— **该推论是错的**：`opencode` 没有
 * `rateLimit: false` 豁免 ⇒ 这些按钮**会渲染**。
 * ⇒ 本表的完整性**已经是用户可见功能**，不是「将来才复发」的内部契约
 * （只有「测试」那一个按钮仍限 `gemini`）。
 *
 * ⚠️ 一致性与「漏一家」由 `tests/unit/provider-runtime-wiring.spec.ts` 的 probe
 * 域守卫从硬编码清单 + {@link PROBE_EXEMPT} 派生锁死（漏挂会让它**点名**变红）。
 */
export declare const probeById: Record<string, NonNullable<ProviderRuntime['probe']>>;
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map