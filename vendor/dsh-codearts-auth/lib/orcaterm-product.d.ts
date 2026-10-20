/**
 * 腾讯 OrcaTerm（遨驰终端）provider 定义。
 *
 * ## 为什么单列一个 provider
 *
 * OrcaTerm 的服务端是腾讯云自研的 ligai 网关（`lightai.cloud.tencent.com`），
 * 与仓库里任何一个现有 provider 都不同源：
 *
 * - 认证不是 bearer token，而是腾讯云网页登录态 cookie（`uin` + `skey`）；
 * - 请求体是 ACP 信封（`input.input` 为 `{"_format":"acp-prompt",...}` 字符串），
 *   不是 OpenAI 的 `messages` 数组；
 * - 模型 id 必须是上游全名（`TokenHub/deepseek-v4-flash`、`Hunyuan3/hy3`），
 *   短名会被上游静默吞掉、返回空结果。
 *
 * ## 凭据形态（实测 2026-10-14）
 *
 * 两条鉴权路，行为不同，不能混用：
 *
 * | 形态 | 请求头 | 结果 |
 * |---|---|---|
 * | 网页 `uin`/`skey` | **只带** `Cookie` | HTTP 200 正常出字 |
 * | 桌面 `ot_session` | `Authorization: Bearer` + `Cookie` | HTTP 200 正常出字 |
 * | 网页 cookie + Bearer | `Cookie` 与 `Authorization` 同时给 | `code=10050000` 被拒 |
 *
 * 第三行是**唯一的硬约束**：给网页 cookie 补一个 Bearer 头会让上游按
 * ot_session 校验并失败，所以两条路必须由 adapter 分开走。
 *
 * ## 免登录态
 *
 * 没有凭据时上游返回 HTTP 500 `{"code":500,"message":"NEED_UIN_AND_SKEY"}`，
 * 据此判定「未登录」，而不是当成网络错误重试。
 *
 * @module orcaterm-product
 */
/** OrcaTerm provider 配置。id 用于 `registerAdapter` 路由名与账号池 provider 键。 */
export declare const ORCATerm: {
    readonly id: "orcaterm";
    /**
     * 展示名。
     *
     * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里那条
     * `label` **逐字一致** —— rail 宽度算式与客户端 provider 面板都按它取显示文案，
     * 不一致会出现面板标题与侧栏两处不同名。
     */
    readonly displayName: "腾讯 OrcaTerm (腾讯云)";
    /** 上游 ACP 对话端点（stream 与 structured 同一个 URL，靠 body 的 stream 字段区分）。 */
    readonly chatUrl: "https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true";
    /** 浏览器登录入口：Jet Hub 面板「登录」按钮打开它，用户微信扫码。 */
    readonly loginUrl: "https://orcaterm.cloud.tencent.com/terminal";
    /**
     * 登录态 cookie 所在域。
     *
     * 内置浏览器登录窗口开的是 `orcaterm.cloud.tencent.com`，cookie 落在该域；
     * 而请求要打到 `lightai.cloud.tencent.com`。两者同属 `tencent.com`，
     * 凭据以 Cookie 头显式携带，不依赖浏览器自动带 cookie。
     */
    readonly cookieDomains: readonly ["orcaterm.cloud.tencent.com", "lightai.cloud.tencent.com"];
    /**
     * 账号池里的凭据 ref 前缀：`ORCATERM_ACCOUNT_{HEX}`。
     *
     * ⚠️ 必须是 **provider id 的大写**，与其余 14 个 provider 同规。恢复表
     * （`src/jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER`）与
     * `tests/unit/jet-hub-store.spec.ts` 都按 `id.toUpperCase()` 推导，
     * 写成驼峰会让账号在 `state.json` 缺失时恢复不出来。
     */
    readonly credentialPrefix: "ORCATERM";
    /**
     * 登录态不是可续期的 token，而是随腾讯云会话过期的 cookie，
     * 且没有 refresh 端点 —— 过期只能重新扫码。
     */
    readonly refreshable: false;
    /** 请求头里的产品标识；上游按它选择模型池。 */
    readonly product: "orcaterm";
    /** 桌面 ot_session 形态要求同时带 Bearer 与 Cookie；网页形态只带 Cookie。 */
    readonly webCredentialNeedsBearer: false;
    readonly desktopCredentialNeedsBearer: true;
};
export type OrcaTermProduct = typeof ORCATerm;
/** 全部上游模型 id（**必须全名**，短名会被上游静默吞掉）。 */
export declare const ORCATerm_FALLBACK_MODELS: readonly [{
    readonly id: "Hunyuan3/hy3";
    readonly name: "Hunyuan 3";
}, {
    readonly id: "Hunyuan3/hy4-preview";
    readonly name: "Hunyuan 4 Preview";
}, {
    readonly id: "TokenHub/deepseek-v4-flash";
    readonly name: "DeepSeek V4 Flash";
}, {
    readonly id: "TokenHub/deepseek-v4-pro";
    readonly name: "DeepSeek V4 Pro";
}, {
    readonly id: "TokenHub/kimi-k3";
    readonly name: "Kimi K3";
}, {
    readonly id: "TokenHub/glm-5.2";
    readonly name: "GLM 5.2";
}, {
    readonly id: "TokenHub/glm-5.3";
    readonly name: "GLM 5.3";
}, {
    readonly id: "TokenHub/glm-5.3-flash";
    readonly name: "GLM 5.3 Flash";
}, {
    readonly id: "hunyuan-t1";
    readonly name: "Hunyuan T1（旧版）";
}, {
    readonly id: "hunyuan-turbos";
    readonly name: "Hunyuan TurboS（旧版）";
}];
/** 模型 id → 显示名。 */
export declare function orcaTermModelName(id: string): string;
/** 该 id 是否是上游认识的全名。 */
export declare function isKnownOrcaTermModel(id: string): boolean;
//# sourceMappingURL=orcaterm-product.d.ts.map