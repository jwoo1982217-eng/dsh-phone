/**
 * 「+ 新建账号」这条链路的**分支判定**（纯逻辑，不碰 React）。
 *
 * ## 背景：为什么这两个判定值得单独成文件
 *
 * 「+ 新建账号」按钮在**每一个** provider 的面板里都有（同一个 `ProviderPanel`
 * 组件按 `provider` prop 复用），而**弹窗内容是 zCode 专用的**（登录渠道下拉）。
 * 二者原本没有按 provider 分支，于是：
 *
 * - 在 CodeArts / Qoder / Loomy 等面板点「+ 新建账号」，弹出的仍是
 *   「添加 ZCode 账号」（Gitee issue IKJLK3 A1）；
 * - 弹窗里的下拉在非 zcode 面板**不往下发**（`account.create` 的载荷里没有
 *   `zcodeProvider`），用户的选择没有任何落点，UI 却像「选了就生效」（A2）；
 * - opencode 更绕：点按钮先弹 ZCode 渠道窗，点「确定」才弹出 API key 表单
 *   （`createAccount` 内部才改道到 `setKeyModal`）—— 双重弹窗（A3）。
 *
 * ## 为什么用「只对 zcode 弹窗」而不是「给每个 provider 各写一套弹窗」
 *
 * 除 zcode 外，**其余 provider 的登录入口本来就没有任何需要用户选择的东西**：
 * 后端立刻返回官方授权 URL（codearts / qoder / trae …）或本地扫码页
 * （loomy），opencode 则是 API key 表单（`OpencodeKeyModal`，自带渠道选择）。
 * 为它们保留一个**内容相同、只是标题换了个名字**的空弹窗，只会多一次点击。
 *
 * ⇒ 语义定为：**`zcode` 走「先选渠道、再登录」；其余 provider 点按钮即登录。**
 * 这也顺带消灭了 A2/A3 —— 没有弹窗就没有「被丢弃的选择」和「第二层弹窗」。
 *
 * ## 为什么不写在 `jet-hub.js` 里直接断言
 *
 * 与 `account-model-link.js` / `model-bulk.js` 同理：单测环境是 `node`
 * （见 `vitest.config.ts`），`react` 不在依赖内，`jet-hub.js` 根本 import 不了。
 * 抽成不依赖 React 的纯模块，判据才能被**真跑**覆盖，而不是退化成
 * 「一段 `readFileSync` 断言」—— 后者改个写法就假红，一段注释就能喂绿。
 */

/**
 * 该 provider 的「新建账号」是否**需要先问一句**（即是否弹登录渠道选择窗）。
 *
 * ⚠ 目前**只有 `zcode` 为真**。zCode 服务端支持两个 OAuth provider
 * （`bigmodel` 国内 / `zai` 国际），授权页与凭据落点都不同，必须由用户选。
 *
 * 判据写成「**白名单**」而不是 `provider !== 'zcode'`：将来若新增某个同样需要
 * 预选渠道的 provider，只改这一处即可；反过来，**任何漏判的 provider 都会
 * 被放行到「无弹窗」这条默认路径**——那是**降级**（少一次确认）而非**破坏**
 * （错误的渠道参数根本不会被发出去，见 `buildCreateAccountPayload`），
 * 失败方向是安全的。
 *
 * @param {string} provider 当前面板的 provider id
 * @returns {boolean}
 */
export function newAccountAsksChannel(provider) {
  return provider === 'zcode';
}

/**
 * `account.create` 的**请求载荷**。
 *
 * ⚠ `zcodeProvider` **只对 zcode 下发**：其余 provider 的载荷必须与接入弹窗前
 * **逐字节相同**（后端对它是可选字段，带一个它不认的值没有意义，
 * 且会让「非 zcode 面板也传了渠道」这种回归重新长出来）。
 *
 * ## ⚠⚠ 本文件最重要的一条：将来新增 provider，**两个函数都要看**
 *
 * 提单人在 review 里指出（且我同意）：本函数用**排除法**
 * （`provider !== 'zcode'` 才早退），而 `newAccountAsksChannel` 用**白名单**
 * —— **两处判据方向是相反的**，容易只改一处。
 *
 * | 只改了这处 | 症状 |
 * |---|---|
 * | 只改 `newAccountAsksChannel` | UI 弹了渠道窗，但 `account.create` 不下发渠道 ⇒ **选择被静默丢弃**（issue IKJLK3 A2 原状） |
 * | 只改 `buildCreateAccountPayload` | UI 不弹窗，但请求里带着一个后端不认的渠道值 ⇒ 后端拿它去打开错误的授权端点 |
 *
 * 两种症状都**不在同一个文件里**，单看任一处都发现不了另一处没跟上。
 * ⇒ 改任何一个，都要回到这里把另一个一起看。回归用例
 * `tests/unit/new-account-dialog.spec.ts` 的 A 组有一条不变式
 * （弹窗判据 ⟺ 载荷带渠道），样本是「真实 PROVIDERS ∪ 合成探针 id」——
 * ⚠ 它**抓不到**叫 `tencent-hunyuan` 这类探针外的名字，**别把它当保证**：
 * 「测试 + 注释」各挡一层，两层都不完备。
 *
 * ⚠ **不要**为了「同源」把它写成 `if (!newAccountAsksChannel(provider)) return { provider }`：
 *   那会让载荷与弹窗判据**耦合** —— 弹窗判据一改（比如将来某个 provider 改成
 *   「有渠道但默认已选好，无需弹窗」），载荷会跟着改变行为，
 *   失去「载荷独立、即使 UI 判据被改坏也不会乱发渠道」这层独立性。
 *   提单人对这点与我一致：**保留方向不同，各守一层**。
 *
 * @param {string} provider 当前面板的 provider id
 * @param {string} [zcodeProvider] 弹窗里选的 ZCode 登录渠道
 * @returns {{ provider: string, zcodeProvider?: string }}
 */
export function buildCreateAccountPayload(provider, zcodeProvider) {
  if (provider !== 'zcode') return { provider };
  return { provider, zcodeProvider };
}
