/**
 * 内部载体的**载体页**（由 server 渲染，guest 里自己跑阿里云 SDK）。
 *
 * ## 为什么 captcha 逻辑留在 server 侧这一份
 * 「在 client 里再写一遍 SDK 调用」必然与 `src/zcode-captcha.ts` 漂移 ——
 * 本仓库反复吃过同型缺陷（同一份 wire 逻辑两处实现，改一处漏一处）。
 * 所以页面由 **server 渲染**（路由见 `src/jet-hub-rpc.ts` 的载体页 GET），
 * 客户端只做两件事：导航过来、`executeJavaScript` 读 `window.__zcodeCaptcha`。
 * 这也是本文件**只搬表达式、不写任何 captcha 判定**的原因。
 *
 * ## 结果契约（Task 5 的 client 依赖它，形状别改）
 * ```
 * window.__zcodeCaptcha = { stage, param, interactive, updatedAt, error? }
 * ```
 * `stage` 取值：`'pending'`（还没出结果）→ `'success'`，或失败形态
 * `'fail'` / `'onError'` / `'timeout'` / `'cfg-throw'` / `'call-throw'` /
 * `'init-throw'`（这六种是 mint 表达式自己上报的）+ `'throw'`（页面兜住的未预期异常）。
 *
 * ⚠ `updatedAt` 只是「这一轮什么时候完成的」的**观测值**（guest 与 server 同机），
 * **不参与**过期决策 —— 时效判定的唯一那道闸在 `src/captcha-supply.ts` 的
 * `takeFreshParam`，口径是 server 时钟。两处都判会互相矛盾。
 *
 * ## 三段表达式的顺序不是排版问题（真实缺陷 2026-10-01）
 * 容器 → SDK → `initAliyunCaptcha` + 无感验证，**必须配对且一次配齐**：
 * `src/zcode-captcha.ts` 的 `buildDomExpression` 注释记着「DOM 被重置而 SDK 未重建
 * ⇒ `F001`」那条实测。载体页是**一次性文档**（导航即全新），所以这里天然走的是
 * 「首次完整准备」那条路径 —— 不复用、不二次重置 DOM。
 * 又因 param 一次性（复用必 `3007`，见 `src/captcha-requirement.ts`），
 * 页面**只自动产一次**；要下一个必须重新导航。
 *
 * ⚠ 刻意**不带** `STEALTH_PATCH`：那是外挂 chromium 遮 `--headless` 痕迹用的，
 * 内部载体（Electron 真实 guest）实测 `webdriver=false`、UA 带 `Electron/44.0.0`
 * 时 4/4 产出合法 param ⇒ 搬进来属于无据扩面。
 */
import { type ZcodeCaptchaConfig } from './zcode-captcha.js';
/** 结果挂载位（Task 5 的 `executeJavaScript` 读的就是这个名字，改名要两边同步）。 */
export declare const CAPTCHA_CARRIER_RESULT_KEY = "__zcodeCaptcha";
/**
 * 构造载体页 HTML。
 *
 * **纯函数**：同一个 `config` 恒定输出同一份字符串（单测据此逐条断言）；
 * 页面里的 `Date.now()` 由 guest 在**运行时**求值，不参与本函数的输出。
 *
 * ⚠ 输出里**不含任何凭据**。`region` / `prefix` / `SceneId` 是阿里云 SDK 的公开
 * 初始化参数（本来就要发给阿里云，不是秘密）；JWT / token / cookie 一个都不许出现 ——
 * 这整页会被写进 guest 的文档，而 guest 与 GUI 同源。
 */
export declare function buildCarrierPageHtml(config: ZcodeCaptchaConfig): string;
//# sourceMappingURL=zcode-carrier-page.d.ts.map