import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { ImageRequestTarget } from './image-budget.js';
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
/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map