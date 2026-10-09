/**
 * 各 provider 的积分能力矩阵 —— Jet Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧积分端点对**三套互不相同的协议**分派（见 `src/jet-hub-rpc.ts`）：
 * CodeBuddy 系经 `productById(provider)` 取产品配置，LobsterAI 与 CodeArts
 * 各自提前分支。未登记的 provider 仍会落到 `bad-request`，因此客户端必须
 * 在发请求之前按本表门控 —— 历史缺陷正是「对不支持的 provider 无条件发请求」：
 * 早期 CodeArts 两项能力皆无，客户端却在面板挂载时对所有 provider 调用
 * `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[jet-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy' || provider === 'workbuddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider    | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-------------|---------------------|------------------------------|
 * | `codearts`  | ✓ 华为签名          | ✓ 华为签名                   |
 * | `buddy`     | ✓                   | ✓                            |
 * | `workbuddy` | ✓                   | ✗ 国际版后端无签到接口        |
 * | `lobsterai` | ✓                   | ✓ `client-activities` 三步流程 |
 * | `qoder`     | ✓ `sash/api/v2/me/usage` | ✗ 未见签到接口            |
 * | `trae`      | ✓                   | ✓ `checkin_credits/*`        |
 * | `cline`     | ✓ `/api/v1/users/{id}/balance` | ✗ 后端无签到接口  |
 *
 * - `balance`：CodeBuddy 系用 `POST /v2/billing/meter/get-user-resource`
 *   （CodeBuddy 与 WorkBuddy 国际版**通用**，仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 用 `GET /api/user/profile-summary`；CodeArts 用
 *   `GET /snap-manager/v1/statistics/plugin`（与账户类型检测同一响应）；
 *   Qoder 用 `GET /sash/api/v2/me/usage`（见 `src/qoder-credits.ts`）。
 *   见 README「积分余额」。
 * - `dailyCheckin`：CodeBuddy 系用 `checkin-activity-status` + `daily-checkin`
 *   （**仅 CodeBuddy 中国版**有；WorkBuddy 国际版内核里只有
 *   `get-dosage-notify` 用量通知）；LobsterAI 用 `client-activities` 的
 *   slot → context → check_in 三步（见 `src/lobsterai-credits.ts`）；
 *   CodeArts 用 `/v1/ops/delivery` + `/v1/ops/claim`(+`confirm`)
 *   （见 `src/codearts-credits.ts`）；Qoder 用
 *   `/sash/api/v1/me/campaigns` 列出活动再逐个
 *   `POST …/{campaignId}/claim`（见 `src/qoder-credits.ts`）。
 * - `qoder` **两项都有**。⚠️ 早期误判为「两项皆无」，原因有二：
 *   ① 只按 `/api/` 前缀搜索端点，而它挂在 **`/sash/`** 下、且只需
 *   Bearer + `Cosy-ClientType`（不需要 WASM 签名，实测返回
 *   `addOnQuota.remaining: 100`）；
 *   ② 随后又误判「无签到」—— 依据是 `/sash/api/v1/me/campaigns` 返回
 *   `claimable:false, campaigns:[]`，但那是**当天已领**的正常表现
 *   （活动每日 10:00（UTC+8）刷新）。2026-09-21 用 keylog 解密抓包
 *   拿到了领取端点与幂等证据（`replayed:true`）。
 *   **教训**：「某次实测没看到」不能推广成「不存在」。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 */

/** 单个 provider 的积分能力。 */
export const CREDITS_CAPABILITIES = Object.freeze({
  autoclaw: Object.freeze({ balance: true, dailyCheckin: false }),
  codearts: Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: true }),
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder：余额（`sash/api/v2/me/usage`）+ 每日领取
  // （`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`，
  // 2026-09-21 由 keylog 解密抓包解出）。
  // 显式登记而非省略 —— 单测要求本表与 PROVIDERS 同步。
  qoder: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder **中国版**（`qodercn`）：两项都有，与国际版同形。
  //
  // 依据（设计文档 E7/E10）：CN 的 `/sash/api/v2/me/usage` 与
  // `/sash/api/v1/me/campaigns` 零凭据实测返回 `401 {"code":"TOKEN_INVALID",
  // "message":"missing authorization token"}`，与国际版**逐字节同形**；
  // CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`，
  // 即桌面 app 身份这个值两站共用。
  //
  // ⚠️ 「端点存在」不等于「活动一定下发」—— 真实领取由
  // `pnpm test:e2e:qodercn-credits` 验证。若将来确认 CN 无签到，改这里时
  // 必须换成强证据（扫 CN asar 无 claim 端点），不要写「某次没看到」：
  // 国际版正是凭一次 `campaigns:[]` 误判成「无签到」，而真相是那天已领
  //（活动每日 10:00 UTC+8 刷新）。
  qodercn: Object.freeze({ balance: true, dailyCheckin: true }),
  // TRAE：余额与签到都有（`/trae/api/v2/pay/ide_user_ent_usage` +
  // `checkin_credits/status` → `checkin_credits/claim`，见 `src/trae-credits.ts`）。
  trae: Object.freeze({ balance: true, dailyCheckin: true }),
  // Cline：**只有余额**，没有签到。
  //
  // 余额：`GET /api/v1/users/{accountId}/balance`
  // （实测 `{data:{userId, balance:500000}, success:true}`，见 `src/cline-credits.ts`）。
  //
  // ⚠️ `dailyCheckin: false` 的依据是**对整个 sidecar 二进制做字符串扫描**：
  // `checkin` / `check-in` / `daily` / `campaign` 均无任何 Cline 业务端点命中
  // （`campaign` 的命中是 PostHog 的 UTM 参数与 feature-flag 事件属性；
  // `daily` 是 YAML cron 别名与 Blob 导出频率枚举）。
  // 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来 Cline 增加
  // 签到，需按 Qoder 那次教训重新采集（见 AGENTS.md 的对应章节）。
  //
  // `subscriptionQuota`：**订阅额度窗口 + 请求记录**（官方端点，见
  // `src/cline-quota.ts`）。这是**本表唯一**具备该项的渠道 —— 另外九家的
  // 订阅计量形状未知（多为按积分余额计费，没有「5 小时 / 周 / 月窗口」这一层），
  // 故不登记；未登记即不支持，面板也就不渲染按钮、不发请求。
  cline: Object.freeze({ balance: true, dailyCheckin: false, subscriptionQuota: true }),
  // Loomy（讯飞）：三项能力齐全，且是**唯一**有第三项（新手任务）的渠道。
  //
  // 余额：`GET /api/v1/points/records`（**只读**）—— 刻意不用 `first-login`，
  //   那是写端点，在面板挂载这种高频路径上调用会意外触发签到。
  // 每日签到：`POST /api/v1/points/first-login`。⚠️ 语义是「触发每日赠送额度」
  //   而不是「+5000 积分」：实测 `dailyBalance = dailyQuota - dailyConsumed`
  //   （4992 = 5000 - 8），消耗后不回补。
  // 新手任务：`GET/POST /api/v1/onboarding/tasks*`，8 个任务合计 **10000 分**，
  //   **一次性**（每号只能领一次），故必须与每日签到分开成一个独立按钮 ——
  //   混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
  loomy: Object.freeze({ balance: true, dailyCheckin: true, onboardingTasks: true }),
  // Raccoon Work（商汤小浣熊）：余额 + **一次性**登录奖励。
  //
  // 余额：`GET /api/web/points/v1/balance`（**只读**，实测返回
  //   `{available_points, daily_points, reward_points, topup_points}`）。
  //
  // ⚠️ **不登记 `dailyCheckin`，且这不是遗漏** —— 实测「每日 300 积分」是
  //   **服务端按日自动发放**的（账单里 `biz_type: 'daily_grant'`，
  //   该账号 13:30 注册、13:31 即到账），**没有可调用的签到端点**。
  //   把它实现成签到按钮会让用户每次点击都必然失败 ——
  //   与 CodeArts 早期「对不支持的 provider 无条件发请求」是同一类缺陷。
  //
  // 登录奖励：`POST /api/web/desktop/v1/login/points/grant`，3000 分，
  //   **幂等一次性**（已领过返回 `granted:false` 且账单里能看到上一次记录）。
  //   语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
  //   `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
  //   ⚠️ 该端点**需要** `X-Client-Platform` 头（值见 RaccoonProduct.clientPlatform）。
  raccoon: Object.freeze({ balance: true, onboardingTasks: true }),
  // MiniMax Code（中国版）：余额 + 每日签到**都有**（与 raccoon 不同）。
  //
  // 余额：`GET /minimax-cloud/api/v1/credit/details`（**只读**，实测返回
  //   `{total_count, base_resp}`；⚠️ **空明细时 `details` 字段整个缺失**，
  //   故解析必须容忍缺失 —— 见 `src/minimax-credits.ts` 的 `unwrapEnvelopeData`）。
  //   ⚠️ 该端点是**平铺响应**（`total_count` 与 `base_resp` 同级、没有 `data` 键），
  //   与签到端点的信封结构不同。
  //
  // 每日签到：`GET /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>` +
  //   `POST …/signin/claim?timezone_id=<IANA>`（body `{}`）。
  //   ⚠️ **`timezone_id` 是 query 参数且必填** —— 实测放请求头会回
  //   `1406010011 invalid timezone_id`，且**那也是 HTTP 200**（只看状态码会误判成功）。
  //   ⚠️ **`points` 是总数，`bonus_points` 是其中的「额外」部分，不得相加**：
  //   实测第 1 天 `points: 800` / `bonus_points: 400`，截图按钮即「签到得 800」
  //   + 右上角「额外 400」角标。相加会虚高一倍（用户 2026-09-28 纠正）。
  //   ⚠️ 幂等判据是响应体的 `claim_result`（`1`=真领取、`2`=已领过），
  //   **不是 HTTP 状态码**（重复领取同样返回 200）。
  minimax: Object.freeze({ balance: true, dailyCheckin: true }),
  /**
   * ZCode（智谱）：余额与每日领取**都有**。
   *
   * - **余额**：`GET /api/v1/zcode-plan/billing/balance`
   *   （需 `Authorization: Bearer <zcodejwt>` + `X-Device-Mid`；实测返回
   *   `{total_units, used_units, remaining_units, period}`）。
   * - **每日领取**：`event/report`(补活跃信号) → `billing/preview` → `billing/claim`。
   *   ⚠️ 领取**需要阿里云 captcha**（由本插件的常驻 chromium 产出）。
   *
   * ⚠️ 这里如实登记为 `balance: true, dailyCheckin: true`，**尽管 ZCode 的
   * 额度单位是 token 而不是积分** —— 能力矩阵回答的是「有没有这项能力」，
   * 不是「量纲是否一致」。量纲差异在面板与 RPC 层如实标注（见
   * `src/jet-hub-rpc.ts` 里 zcode 的 balances 分支与
   * `src/zcode-auth.ts` 的 `claimDaily`）。
   */
  zcode: Object.freeze({ balance: true, dailyCheckin: true }),
  /**
   * OpenCode：**显示**额度行，但语义不是「余额」而是「**通道可用性**」。
   *
   * ## 为什么不是 `balance: false`（2026-10-02 改，用户报障「只有 opencode 没有显示」）
   *
   * 我曾登记 `balance: false`，理由是「Zen 是按量计费的网关，没有可查询的
   * 余额数字」。但那个登记**把整个徽标挡死了** —— 组件第一件事就是
   * `supportsCreditBalance(provider)`，为 false 直接 `return null`，
   * 用户看到的就是「opencode 没有用量」，而 Zen 明明有额度（余额耗尽会回
   * `402 Insufficient account funds`）。
   *
   * ## 改后的口径
   *
   * Zen **没有公开的余额 API**（实测 15 个候选路径全 404，见
   * `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`），
   * 所以徽标展示**我们真正测得到的东西**：每个通道（账号槽 / 匿名通道）
   * 当前是否可用、是否处于限额冷却。数据来自本地 `modelRateLimits`，
   * **零网络请求**。宿主侧见 `jet-hub-rpc.ts` 的 `OPENCODE.id` 分支。
   *
   * ⚠️ 徽标会显示「N 通道」而非「N 积分」——这是**如实**的，不要改成
   * 假装有余额数字（那会在用户充值后显示错误的数字）。
   */
  opencode: Object.freeze({ balance: true, dailyCheckin: false }),
  /**
   * Gemini Code Assist（Google Cloud Code 免费线）：**只有余额**，没有签到。
   *
   * - **余额**：`POST /v1internal:retrieveUserQuotaSummary`（**只读**），
   *   返回 `{groups:[{displayName, buckets:[…]}]}`，我们只取两个桶：
   *   `gemini-5h`（5 小时窗口）与 `gemini-weekly`（周窗口）。
   *   ⚠️ 量纲是**剩余比例**（`remainingFraction`，0~1）而不是积分 ——
   *   面板按百分比展示，与 ZCode 的 token 量纲同理，能力矩阵只回答
   *   「有没有这项能力」，量纲差异在卡片上如实标注。
   *
   * - ⚠️ **不登记 `dailyCheckin`，且这不是遗漏** —— Cloud Code 免费线是
   *   纯配额制，**没有可调用的签到/领取端点**。登记它会让用户每次点击都
   *   必然失败（与 Raccoon 那条同因：签到是服务端按日自动发放的）。
   *
   * - ⚠️ 未授权时后端返回 `{balance: null, error: '尚未授权 Google 账号'}`，
   *   卡片显示原因而不是 0 —— 与「配额真的用完了」是**两回事**。
   */
  gemini: Object.freeze({ balance: true, dailyCheckin: false }),
  /**
   * 聚合 provider（跨渠道临期优先）。
   *
   * ⚠️ **如实登记为 `false`**：它**没有自己的账号与余额** —— 它复用各渠道的账号，
   * 积分与限流由各渠道自己管理（见 `aggregate-panel-logic.js` + `jet-hub.js` 的 `AggregatePanel` 的说明区）。
   *
   * ⚠️ 这一项**不影响**用量徽标能否工作：徽标对聚合的处理是「重定向到实际选中的
   * 渠道」（P3），重定向发生在 `supportsCreditBalance` 门控**之前**，门控看到的
   * `provider` 已是真实渠道。故这里填 `false` 是**诚实**的，不是「为了绕过门控」。
   *
   * ⚠️ 它也顺带保证聚合面板**不长出**「刷新积分 / 一键领取」按钮 ——
   * 那两处的门控（`canLoadCredits` / `supportsCredits`）读同一张表。
   */
  aggregate: Object.freeze({ balance: false, dailyCheckin: false }),
});

/**
 * 各 provider 是否具备「**模型限流**」这一机制（即服务端会因限流而拒绝请求）。
 *
 * ## 为什么需要它（真实发现）
 *
 * Loomy **不会返回限流错误**：实测今日赠送额度（每天 5000）用完后，服务端
 * 继续扣永久积分且照常返回（静默降级）。因此「重测 / 重置」这组按钮对它
 * **毫无意义** —— 重测永远测不出限流，重置也没有标记可清。
 * 用户报障：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。
 *
 * ## 为什么「未登记 = 视为有限流」（与上面的积分能力约定**相反**）
 *
 * 积分能力的约定是「默认关闭」（未登记就不发请求，避免必然失败的请求）。
 * 但限流按钮**是既有 UI**：若这里也默认关闭，将来新增 provider 时忘记登记，
 * 会让老用户**凭空失去**「重测 / 重置」按钮 —— 那是可见的功能回退。
 * 故这里默认**开启**。
 *
 * ## 登记 `false` 的判据（2026-10-03 纳入 Gemini 后重写）
 *
 * 不是「该渠道不会限流」，而是「**该渠道的限流不由这组按钮的语义管辖**」。
 * 目前两个子类都登记 `false`：
 * - Loomy：**根本不返回限流错误** —— 重测永远测不出东西，重置没有标记可清；
 * - Gemini：**限流是服务端配额窗口制** —— 本地标记与重测都不改变配额本身，
 *   按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用。
 *
 * 落地问法：「这个按钮点下去，能不能让用户**少**受限一次？」答否即 `false`。
 */
export const RATE_LIMIT_CAPABILITIES = Object.freeze({
  // Loomy（讯飞）：**不返回限流错误** —— 积分耗尽时静默降级为扣永久积分，
  // 故「重测 / 重置」这组按钮对它无意义（重测还会白烧积分）。
  loomy: Object.freeze({ rateLimit: false }),
  // Gemini（Google Cloud Code）：**理由与 Loomy 不同** —— 它确实会回 429，
  // `gemini-adapter.ts` 也确实会写 `modelRateLimits`（60s 冷却 / 401 时 300s）。
  // 但它的限流是**服务端配额窗口制**（5 小时窗口 + 周窗口），不是「等一会儿
  // 就好」的临时冷却：本地标记清掉、重测通过，配额本身一点没恢复，下一次
  // 请求立刻又是 429。于是这组按钮对 Gemini 只剩副作用：
  //   - 「重测」会对每个被标记的模型**真发一条消息**，白烧本就紧张的窗口配额，
  //     且结论恒为「仍然受限」（判据见 `src/account-probe.ts` 的 `retestAccount`）；
  //   - 「重置」只清本地标记，把账号重新放回可选用池，随即再撞 429 再写回来。
  // 真正能改变状态的动作是**换账号**或**等窗口 resetTime**，两者都不在这组按钮里。
  // 用户报障原文：「重测按钮你确认过会发请求吗，为什么响应这么快？可以移除吗」
  // （响应快是因为当时该账号没有 `modelRateLimits` 标记，`retestAccount` 在
  // `modelIds.length === 0` 处提前返回，一次请求都没发）。
  gemini: Object.freeze({ rateLimit: false }),
});

/**
 * 该 provider 的请求是否会因**模型限流**被拒（决定是否渲染「重测 / 重置」）。
 *
 * ⚠️ 默认 `true`（未登记即视为有限流），理由与登记判据见
 * {@link RATE_LIMIT_CAPABILITIES}。
 */
export function supportsRateLimit(provider) {
  return RATE_LIMIT_CAPABILITIES[provider]?.rateLimit !== false;
}

/**
 * 各 provider 是否支持账号卡片上的「**测试**」按钮（无条件真发一次请求探活）。
 *
 * ## 与「重测」的区别（这是它存在的全部理由）
 *
 * 「重测」的触发条件是**该账号已有 `modelRateLimits` 标记**：没有标记时
 * `retestAccount` 在 `modelIds.length === 0` 处提前返回、**一次请求都不发**。
 * 于是「这个账号到底还能不能用」在**没有历史 429** 时没有任何手动探活入口 ——
 * 用户点「重测」看到瞬间返回，会以为按钮失灵（真实报障：
 * 「重测按钮你确认过会发请求吗，为什么响应这么快？」）。
 * 「测试」不看标记，直接挑一个模型真发出去，且**不写任何存储**。
 *
 * ## 为什么默认**关闭**（与上面的限流表相反）
 *
 * 限流按钮是**既有 UI**，默认关闭会让老用户凭空失去按钮（可见的功能回退）。
 * 「测试」是**全新按钮**，没有存量用户，故遵循积分能力表的约定：默认关闭，
 * 只在明确验证过「这个渠道真的能探活」时才登记。未登记 ⇒ 不渲染。
 *
 * 目前只登记 Gemini —— 本窗口只验证过它（`src/account-probe.ts` 的
 * `testAccount` 走的就是 gemini 的分派支），其余 provider 未验证前不铺开。
 */
export const ACCOUNT_TEST_CAPABILITIES = Object.freeze({
  gemini: Object.freeze({ test: true }),
});

/**
 * 该 provider 的账号卡片是否渲染「测试」按钮。
 *
 * ⚠️ 默认 `false`（未登记即不渲染），理由与登记判据见
 * {@link ACCOUNT_TEST_CAPABILITIES}。
 */
export function supportsAccountTest(provider) {
  return ACCOUNT_TEST_CAPABILITIES[provider]?.test === true;
}

/**
 * 「锁定永久积分」窗口：距**扣费截止**不足 15 天的积分算临时（会很快作废，优先烧掉），
 * 其余算永久。
 *
 * ⚠️ 必须与后端 `src/buddy-balance-rank.ts` 的 `BUDDY_EXPIRING_WINDOW_DAYS` 一致 ——
 * 前端只做展示，判据在后端；这里写的数字若与后端不同，用户会看到「提示说只烧
 * 8 天内的，实际按 15 天筛号」这种无法解释的偏差。
 */
export const PERMANENT_LOCK_EXPIRING_WINDOW_DAYS = 15;

/**
 * 该 provider 是否支持「锁定永久积分」（只消耗会近期作废的积分）。
 *
 * ⚠️ 目前五家具备，**依据分两类**：
 *
 * **服务端直接给两个命名池**：
 * - `loomy`：`dailyBalance`（**当日**到期，次日重发）与 `balance`（注册奖励 + 新手任务，不过期）。
 *
 * **按逐包到期时间现算**（同一个 `splitBuddyCreditsByExpiry`，与 provider 无关）：
 * - `buddy` / `workbuddy`：一个账号常同时有多个资源包，按包的 `DeductionEndTime`
 *   距今是否满 {@link PERMANENT_LOCK_EXPIRING_WINDOW_DAYS} 天现算（实测国际版是
 *   「Bonus Pack 14 天 + Free Plan 扣费截止 8 年后」，中国版是「体验版套餐 +
 *   30/365 天的拉新与裂变包」）。
 * - `trae`：条目级 `expire_time`（秒级 Unix 时间戳，见 `src/trae-credits.ts` 的取证注释）。
 * - `lobsterai`：`expiresAt`（ISO 8601，已归一化到 `deductionEndTime`）。
 *
 * ⚠️ 后两家**没有「每日额度 / 永久积分」两个命名池**，但同样能按到期时间分桶 ——
 * 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。它们的余额面板
 * 也早已用同一个窗口分「长期 / 临时」（见 `src/jet-hub-rpc.ts` 的 `credits.balances`）。
 *
 * 其余渠道的积分模型里没有逐包到期时间（或根本没有资源包列表），
 * 分不出两桶，登记进来只会多一个无效按钮。
 *
 * ⚠️ 必须与后端 `src/jet-hub-rpc.ts` 的 `PERMANENT_LOCK_PROVIDERS` 一致：
 * 不一致会出现「按钮渲染出来了，点了却报 bad-request」。
 *
 * 为 false 时面板**不得**渲染该按钮，也不得发起 `credits.permanentLock`。
 */
export function supportsPermanentLock(provider) {
  return provider === 'loomy' || provider === 'buddy' || provider === 'workbuddy'
    || provider === 'trae' || provider === 'lobsterai'
}

/**
 * 该 provider 的余额是否**真的由多个资源包构成且有到期信息**（决定账号名 hover 要不要列包）。
 *
 * ⚠️ 只有 `buddy` / `workbuddy` / `lobsterai` 具备。这不是"避免冗余"，而是**防止显示错误信息**：
 * - `loomy` 的 `packages` 是我们自己合成的两个条目（`makePackage('永久积分'…)` /
 *   `makePackage('每日赠送'…)`），它们**没有** `deductionEndTime` → 按降级规则会被标成「永久」。
 *   若不加这道门控，loomy 卡片上会出现「每日赠送 4992 / 4992 永久」——而那笔恰恰**当天就作废**，说反了。
 * - `trae` 的有效期为 **31 天**（从起始日期算起）。服务端不返回独立的到期字段，
 *   但规则明确 ⇒ 可以挂（后端已按"起始日期 + 31 天"计算 deductionEndTime）。
 * - `qoder` / `qodercn`：套餐额度/资源包没有独立到期（统一"领取后 30 天"），但专用资源包有
 *   `expiresAt` 字段 ⇒ 可挂（有到期信息的包显示日期，没有的显示"永久"）。
 * - LobsterAI：有 `expiresAt` 字段（ISO 日期字符串），已明确过期判据。
 */
export function supportsCreditPackageList(provider) {
  return provider === 'buddy' || provider === 'workbuddy' || provider === 'lobsterai'
    || provider === 'qoder' || provider === 'qodercn' || provider === 'trae';
}

/**
 * 「锁定 / 解锁永久积分」按钮与提示的**按 provider 文案**。
 *
 * ## 为什么不能让三个 provider 共用一句
 *
 * 「临时积分」在三家的含义不同：Loomy 是**当天**发放的赠送额度，两个 buddy 是
 * **N 天内会作废**的资源包。共用「只消耗每日赠送额度」这句话，buddy 用户会以为
 * 锁上后每天刷新的额度还在优先消耗 —— 而它每天根本拿不到新额度（签到得来的也是
 * 14/30 天后到期的包）。文案必须说清「保住的是什么、先烧的是什么、什么时候会
 * 没有可用账号」。
 *
 * @param provider - provider id。
 * @param windowDays - 后端回传的**当前生效窗口**（`credits.permanentLock` 的
 *   `windowDays`）。⚠️ 必须用它渲染，不能用本文件的默认常量：窗口可被
 *   `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，写死会出现「提示说 15 天、实际按
 *   31 天筛号」。缺省（未读到 / Loomy）时回落到默认常量。
 * @returns 四个文案位：未锁定态的按钮标题 / 已锁定态的按钮标题 /
 *          锁定成功提示 / 解锁成功提示。
 */
export function permanentLockCopy(provider, windowDays) {
  // ⚠️ 判据是「**是否按到期时间分桶**」，不是「是不是 buddy」：trae / lobsterai 与
  // buddy 系走同一套 `splitBuddyCreditsByExpiry`，窗口天数对它们同样有意义，
  // 故必须共用这套带天数的文案（否则会错误地落到下面 Loomy 那套「每日赠送额度」文案，
  // 而它们根本没有「每日额度」这个概念）。
  if (provider === 'buddy' || provider === 'workbuddy'
    || provider === 'trae' || provider === 'lobsterai') {
    const days = normalizeWindowDays(windowDays);
    return Object.freeze({
      days,
      lockTitle: `锁定永久积分后只消耗「${days} 天内到期」的积分包（那部分再不用就作废）。这类积分用尽后将没有可用账号。点此锁定。`,
      lockedTitle: `当前已锁定永久积分：只消耗「${days} 天内到期」的积分包。这类积分用尽后将没有可用账号。点此解锁。`,
      lockedNotice: `已锁定永久积分：只消耗 ${days} 天内到期的积分包。这类积分用尽后将无可用账号。`,
      unlockedNotice: `已解锁永久积分：${days} 天内到期的积分用尽后，会继续使用更晚到期的积分。`,
    });
  }
  return Object.freeze({
    days: null,
    lockTitle: '锁定永久积分后只消耗每日赠送额度（今日额度用尽即无可用账号），可保住永久积分。点此锁定。',
    lockedTitle: '当前已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将没有可用账号。点此解锁。',
    lockedNotice: '已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将无可用账号。',
    unlockedNotice: '已解锁永久积分：今日额度用尽后会继续使用永久积分。',
  });
}

/**
 * 归一化后端回传的窗口天数：非法值（缺省 / null / 空串 / 非数字 / 负数）
 * 回落到默认常量。
 *
 * ⚠️ 三条边界都要顾：
 * 1. **`undefined` / `null` 必须回落默认**，不能走 `Number(null) === 0` 这条路 ——
 *    面板挂载初期或 Loomy（没有窗口概念）都会给到 null，若当成 0 就渲染出
 *    「只消耗 0 天内到期的积分」这种荒谬提示。
 * 2. ⚠️ 但**数字 `0` 是合法值**（表示「没有临时积分」），不能被 `||` 静默换成
 *    默认 —— 与本仓库 `DSH_QODER_QUEUE_TIMEOUT_MS` 那条同一个坑。
 * 3. 小数按四舍五入显示（`15.6 → 16`），避免出现「15.6 天内到期」这种读不顺的文案。
 */
function normalizeWindowDays(value) {
  if (value === undefined || value === null || value === '') {
    return PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
}

/**
 * 该 provider 是否能查询积分余额。
 *
 * 为 false 时调用方**不得**发起 `credits.balances`，也不应渲染账号卡片的
 * 「积分」行与面板的「刷新积分」按钮 —— 否则卡片会永远停在「查询失败」。
 */
export function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}

/**
 * 该 provider 是否能执行每日签到领取（一键领取积分）。
 *
 * 为 false 时面板不渲染该按钮（WorkBuddy 国际版后端无接口）。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}

/**
 * 全部**支持每日签到**的渠道 id 列表，顺序固定（= 本表声明顺序）。
 *
 * 供 Jet Hub 页头的「一键签到」遍历使用。
 *
 * ⚠️ **必须从本表推导，不要另写一份渠道字面量**：
 * 本表已是能力判定的唯一真相源，且 `credits-capabilities.spec.ts` 守着它与
 * `PROVIDERS` 同步。硬编码 `['codearts','buddy',…]` 会在将来某渠道开放或
 * 下线签到时**静默漂移** —— 表现为「新渠道永远不被签到」或
 * 「对已下线渠道发必然失败的请求」（后者正是 CodeArts 历史缺陷的形态）。
 *
 * 顺序即执行顺序（调用方串行执行），故它同时决定了请求的先后；
 * 保持本表声明顺序即可，不额外排序。
 */
export function checkinProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsDailyCheckin);
}

/**
 * 该 provider 是否支持「新手任务」一次性领取。
 *
 * ⚠️ 与 {@link supportsDailyCheckin} **语义独立，不能互相推断**：
 * - `dailyCheckin`：**每天**有收益（每日额度刷新）
 * - `onboardingTasks`：**一次性**（每号只能领一次固定总额）
 *
 * 目前只有 Loomy 具备后者。为 false 时面板**不得**渲染「领取新手任务」按钮，
 * 也不得发起 `onboarding.status` / `onboarding.claim`。
 */
export function supportsOnboardingTasks(provider) {
  return CREDITS_CAPABILITIES[provider]?.onboardingTasks === true;
}

/**
 * 全部**支持新手任务**的渠道 id 列表。
 *
 * 供「一键领取全部渠道新手任务」之类的批量入口使用（当前未实现，
 * 保留以便扩展）。**必须从能力表推导**，理由同 {@link checkinProviders}。
 */
export function onboardingTaskProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsOnboardingTasks);
}

/**
 * 该 provider 是否支持「订阅额度」（官方额度窗口 + 请求记录）。
 *
 * 目前**只有 Cline**：它的网关提供按时间窗（5 小时 / 周 / 月）的订阅计量
 * 与逐笔请求流水（见 `src/cline-quota.ts`）。其余渠道是积分余额制，
 * 没有这一层窗口。
 *
 * 为 false 时面板**不得**渲染「订阅额度」按钮，也不得发起
 * `cline.quota` / `cline.requestLog` —— 服务端对非 Cline 一律 `bad-request`，
 * 无条件发请求就会在控制台留下必然失败的报错（与 CodeArts 早期
 * 「对不支持的 provider 无条件调 credits.balances」是同一类缺陷）。
 */
export function supportsSubscriptionQuota(provider) {
  return CREDITS_CAPABILITIES[provider]?.subscriptionQuota === true;
}
