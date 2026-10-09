<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ Loomy（讯飞）provider：五个不能凭直觉改的点

`loomy` 是第 8 个 provider，与其余七者**都不同源**。实现是独立一套
`src/loomy*.ts`（`loomy-product` / `loomy` / `loomy-sign` / `loomy-oauth` /
`loomy-onboarding` / `loomy-credits` / `loomy-auth` / `loomy-adapter`），
适配器复用 `src/openai-compat.ts`（实测是标准 OpenAI 兼容 + 标准 SSE，与 qoder 同形）。

**真实依据**：2026-09-26 用本机登录态对生产端点逐项实测。
以下五条都有实测证据，**不要按其余 provider 的直觉改**：

1. **两套认证头（最容易踩）**：`/chat/completions` 只认
   `Authorization: Bearer <session>`；`/models`、`/points/*`、
   `/onboarding/*` 只认 `token: <session>`。带错的会得到 HTTP 200 +
   `{"code":"100002","desc":"缺少 token"}` —— 看着像「登录失效」，
   实为头用错了。实测交叉矩阵：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

   `loomyChatHeaders()` 两个都发（官方 `llm-completion.js:149-151` 也如此）。
   ⚠️ `Bearer ` 前缀**必需**：无前缀同样回 `100002`。

2. **没有 refresh 端点，`isLoomyRefreshable()` 恒 `false`**。
   `session` 是登录时声明 `expire: 1209600`（14 天）得来的，凭据里**没有**
   `refresh_token`。故 `refresh()` / `refreshAccountCredential()` 是**有效性探测**
   而非续期（探测走 `GET /points/records?pageSize=1`，只读零消耗），
   `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
   ⚠️ **不要**为了让 `refreshAll` 有活干而把 `refreshable` 改成 true ——
   那会让 UI 假装能续期，实际每次探测都失败。
   ⚠️ `scheduleRefresh()` / `stop()` 是**有意为之的空实现**：`RefreshScheduler`
   的意义是「过期前 1 小时自动续期」，Loomy 无法续期，武装它只会得到
   「触发 → 探测 → 必然抛错 → 停止」的空转。保留空实现是**契约要求**
   （`index.ts` 对全部 provider 统一调用）。

3. **新手任务服务端不校验前置行为**：直接 `POST /onboarding/tasks/complete`
   （body 仅 `{"key":...}`）即可拿满 10000 分，**零 token 消耗**。
   8 个任务：`first_message` 500 / `pick_skill` 1000 / `generate_ppt` 1500 /
   `set_schedule` 1000 / `install_skill` 1500 / `configure_remote` 1000 /
   `create_soul` 1500 / `share_soul` 2000。
   这与 workbuddy2api-panel 的做法**相反**（那边要模拟真实行为、
   上报埋点事件链）。**不要**「照 workbuddy 那样」去发对话/建定时任务 ——
   那是白花积分。若将来服务端加了校验，再走「用 `qwen3.8-flash`
   （x0.8，全表最便宜）模拟真实动作」的降级路径。
   ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
   ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算
   （官方 `onboarding-service.js:177-183` 明说不信任）。

4. **倍率在 `name` 字符串里**，没有独立字段，且三种括号风格混用
   （`MiniMax M3 （x4.0）` 全角带空格 / `Qwen 3.8 Max (x12.0)` 半角 /
   `GLM 5.3 Flash(x0.8)` 半角无空格）。故用 `loomyDisplayName()` 规范化。
   ⚠️ `splitLoomyRate()` **必须同时认两种形态**：远端原值（末尾括号）
   **和**已规范化的 `{name} · x{n}` —— 兜底表（`loomy-product.ts`）存的就是后者。
   早期只认括号形态，于是 `resolveModel` 无法从兜底表名去掉倍率，
   返回 `Spark X2.5 · x0.1` 而非 `Spark X2.5`（实现时暴露的真实缺陷）。
   该函数**幂等**，单测锁死。
   ⚠️ chat 模型过滤判据是 **`type === 'chat'`**，不能看 `input_modalities`
   —— 5 个 chat 模型的输入模态含 `image`（能看图），不是生图模型。

5. **积分是两个池**：永久（`balance`）与每日赠送（`dailyBalance`）分开计算。
   每日额度由 `POST /points/first-login` 触发（官方登录后立即调用），
   语义是**触发额度重置**而非「+5000 积分」：
   实测 `dailyBalance = dailyQuota - dailyConsumed`（4992 = 5000 - 8），
   消耗后不回补。故「一键签到」用 `alreadyProcessed` 判幂等并映射成
   `already-claimed`，**不是** `claimed`。
   ⚠️ **余额查询必须走只读的 `GET /points/records`**，不能用 `first-login`
   —— 后者是**写**端点，在「打开面板」这种高频路径上调用会意外触发签到。
   ⚠️ `dailyQuota` **只在 `first-login` 响应里**，`points/records` 不返回它，
   故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。

### 短信登录：唯一没有 loginUrl 的 provider

其余 7 个都是「`account.create` 返回 `loginUrl` → 前端 `window.open` →
轮询 `login.poll`」。短信登录**没有 URL 可打开**，故扩展了登录契约：

- `RpcCreateAccountRequest` 加可选 `phone`
- `RpcCreateAccountResponse` 加可选 `loginMode: 'url' | 'sms'`
  ⚠️ **缺省必须视为 `'url'`** —— 既有 7 个 provider 不传该字段，
  行为必须逐字节不变
- 新增 `login.sendSms` / `login.submitSms` 两个端点

⚠️ **msgid 用内存暂存表**（`pendingSmsMsgid`），**不写进 `ctx.credentials`**
—— 它是一次性中间态（5 分钟有效），写凭据会污染命名空间，且它不含任何秘密。

⚠️ **短信登录失败不删占位账号条目**：用户多半只是验证码输错，保留条目让他能重试。

⚠️ **前端短信分支绝不能回退到 `window.location.href`** —— 那会把整个设置页
导航走（与 `createAccount` 的既有约定同因，见「+ 新建账号」章节）。

### 能力矩阵第三项：`onboardingTasks`

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立，不能互相推断**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

⚠️ 客户端**不调用** `onboarding.status`：`onboarding.claim` 的响应已带回
`earned`/`total`/逐任务明细，足以渲染进度，再发一次只读查询纯属多余请求。

### 账号卡片：两个积分池分开显示

`CreditBalanceRow` 对「恰好两个包且名字为 `永久积分` / `每日赠送`」的形态
显示 `永久 15000 · 每日 4992`；其余 provider 的多个同类资源包仍显示
「N/M 个资源包有效」。两种形态互斥（`isLoomyTwoPools`）。

### ⚠️ 多账号负载均衡：Loomy **不会**因积分耗尽报错，既有换号机制对它无效

**真实缺陷**（用户报障）：Loomy 会**一直消耗同一个号**，从不触发限流换号。

**根因**（实测 2026-09-26）：今日赠送额度（每天 5000）耗尽后，服务端
**继续扣永久积分且照常返回** —— 「耗尽」是**静默降级**，不是错误。
而本插件既有的换号机制（`getAvailableAccount` 按 `modelRateLimits` 排除账号）
**只在服务端返回限流错误时触发**，故对 Loomy 完全无效。

**修法**：Loomy 用**独立的按余额优先选号**（`src/loomy-balance-rank.ts`
纯函数 + `src/loomy-balance-selector.ts` 带缓存的选择器）：

| 优先级 | 判据 |
|---|---|
| 1 | `dailyBalance > 0`（今日额度每天刷新、不用会浪费） |
| 2 | `permanentBalance > 0` |
| 3 | 其余（含**查询失败**） |

三条**不能改**的约定：

1. **档内保持手动拖拽顺序**，不按余额大小重排（用户明确要求，
   与 `getAvailableAccount` 的既有语义一致）。
2. **查询失败归最后一档**（不是第一档）—— 用户明确要求：
   宁可先用能确认余额的号。
3. **候选先按「未停用 + 该模型未受限」过滤，再按余额分档** ——
   用户明确要求「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
   ⚠️ 故 `resolveCredential` **必须接住并透传 `modelId`**（限流是**按模型**记的）：
   适配器侧 `resolveCredential(modelId?)` → 宿主侧用它过滤
   `a.modelRateLimits[key]`。早期实现传空串 `''`，等于不按模型过滤。

余额查询**带 60 秒 TTL 缓存**（`LOOMY_BALANCE_CACHE_TTL_MS`）：每次选号都实时查
所有账号会显著变慢（N 个账号 = N 次网络往返）。

⚠️ **不要**把 Loomy 塞回 `getAvailableAccount` 的通用逻辑里 —— 那个函数服务
全部 8 个 provider，而「按余额分档」是 Loomy 独有的需求（其他 provider 的
积分模型不同，且多数会返回限流错误）。Loomy 的 `resolveCredential` 自己
`listAccountsByProvider` + 过滤 + 调选择器。

### ⚠️ 锁定永久积分（Loomy 全局开关，**必须持久化**）

**用户需求**：面板上一个开关，锁定后**只允许消耗今日赠送额度**，永久积分不参与
选号 —— 只剩永久积分的账号在锁定期间**等同于不可用**。用户原话：
「锁定永久积分后没有临时积分后找可用账号就是没有可用账号，解锁以后才能再没有
临时积分的时候找到有永久积分的账号」。

实现分三层，**每层都有非显然的约束**：

| 层 | 落点 | 关键约束 |
|---|---|---|
| 纯函数 | `loomy-balance-rank.ts` 的 `LoomyTierOptions.allowPermanent` | 锁定时只剩永久积分的账号落 **`none` 档**（不是降到 permanent 档） |
| 选号 | `loomy-balance-selector.ts` 的 `select(candidates, options)` | ⚠️ 只在**锁定**时把「全部不可用」判成 `undefined`；解锁时**保持既有行为**（全 0 也返回第一个，让上游报余额不足） |
| 宿主 | `index.ts` 的 `resolveCredential` | ⚠️ 锁定时**绝不可落到单凭据兜底** —— 那会绕过锁定照样烧永久积分 |

⚠️ **持久化是本改动最容易出错的地方**：`JetHubState` 由「两字段」变「三字段」，
而**所有写入点都是整体替换**（`writeAccounts` / `writeModels` /
`setLoomyPermanentLocked` / `replaceAll` / `store.save`）。漏带一处，用户的锁就会
被下一次「新增账号」「改模型开关」静默解开 —— 与 `disabledModels` 当年踩过的坑
**完全同型**。`tests/unit/account-pool.spec.ts` 的「Loomy 永久积分锁定」段专门
守着它，且已做**反向验证**（注入「新增账号漏带锁定」时用例会失败）。

⚠️ **缺省必须为「解锁」**：老文档/老备份没有该字段，读到时按 `false` 处理
（与既有行为一致），**不要**因为字段缺失就报错或让整次载入失败。
`replaceAll` 对 `undefined` 的处理是**保持当前值**而不是重置为 false ——
否则导入一份老备份会静默解锁用户的永久积分。

⚠️ **写锁定后要广播 `llm/adapters-updated`**（包 try/catch）：它改变**选号结果**，
与 `model.setDisabled` 同一判据（「这次写入会不会改变 `listModels` 的结果」→
这里换成「会不会改变选号结果」）。通知失败不能反噬已落盘的开关。

### ⚠️ Loomy 没有「模型限流」，故不渲染「重测 / 重置」

**用户报障**：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。

根因就是上一条：Loomy 积分耗尽时**静默降级**（继续扣永久积分），从不返回限流
错误，故那组按钮对它毫无意义 —— 重测永远测不出限流、还会**白烧积分**。

实现用**独立的能力矩阵** `RATE_LIMIT_CAPABILITIES`
（`plugin-src/client/credits-capabilities.js`），Loomy 显式登记 `rateLimit: false`。

⚠️ **它的默认值与积分能力矩阵相反**：积分能力是「未登记 = 不支持」（避免必然
失败的请求），而限流这里必须是「未登记 = **支持**」—— 那组按钮是**既有 UI**，
若默认关闭，将来新增 provider 忘记登记会让老用户**凭空失去**按钮（可见的功能
回退）。故判据写成 `rateLimit !== false`。

⚠️ 面板级（「重测所有 / 重置所有」）与卡片级（「重测 / 重置」）**都要门控**：
只改面板级会让卡片上仍留着两个永远无效的按钮。

### ⚠️ 思考档位：`resolveModel` **必须声明 `reasoning`**，否则选择器根本不出现

**用户报障**：「loomy ide 中可以设置思考档位，我们现在没法设置」。

**根因与 Qoder 那次完全同型**（见本文件 Qoder 的 2.2 节）：`LoomyAdapter.resolveModel()`
**只声明 `context`，从不声明 `reasoning`**。而 DSH 的思考强度选择器**只会**从
`resolveModel().reasoning` 渲染 —— 故档位选择器**从来没有出现过**，
尽管远端 `GET /models` 早就下发了 `reasoning_efforts`。

⚠️ **判据是「DSH 从哪读档位」，不是「远端有没有给」**：远端给了不等于界面有，
中间少一次声明就全丢。**加任何 provider 时都要检查 `resolveModel` 是否声明了
`reasoning`**（同理还有 `context` / `inputModalities`）。

**用户要求「如果能从远端得到配置中直接生成是最好的」—— 已照此实现**：

| 项 | 来源 | 规则 |
|---|---|---|
| `efforts` | 远端 `reasoning_efforts` | **原样取用**（服务端下发的就是展示顺序） |
| `defaultEffort` | ⚠️ **本插件自己的 `high`** | **不采信远端的 `low`**（见下） |
| 中文展示名 | 本文件 `LOOMY_EFFORT_NAMES` | `none:关闭思考 low:低 medium:中 high:高 xhigh:极高` |

实测 8 个 chat 模型**完全一致**：`['none','low','medium','high','xhigh']`。
远端还带 `reasoning_catalog_version`（catalog 哈希），故档位随服务端更新、**无需改代码**。
兜底表（`loomy-product.ts`）存同一份实测值，只在远端整体失败时顶替 ——
⚠️ **抽成 `LOOMY_EFFORTS` 常量而不是逐条写 8 遍**，避免上游变更时漏改其中几条。

⚠️⚠️ **默认档用本插件自己的 `high`，有意不采信远端的 `low`**（用户要求，2026-09-28）：
> 我们档位默认用远端的几档，默认值用自己的高

**依据是 DSH 的取值逻辑**（`dsh-client-ui-model-selection/lib/client.js:512`）：
```js
const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
```
即「用户没选时发哪个档」**完全由适配器声明的 `defaultEffort` 决定**，
沿用远端的 `low` 会让默认思考偏浅。
常量在 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT`，
兜底表的 `LOOMY_DEFAULT_EFFORT` **必须与它一致** ——
否则「远端可用 / 远端失败」两条路径的默认档会不同。

⚠️ **仍必须做 `efforts.includes(high)` 校验**：DSH 会拿 `defaultEffort`
**直接发请求**，某模型若不提供 `high`（远端目录变化时真会发生），
必须**不下发默认档**（退回 DSH 的「服务商默认」语义），而不是发一个非法值
（会抛 `UNSUPPORTED_REASONING_EFFORT`）。

⚠️ **`defaultEffort` 不落在 `efforts` 内时不能下发**：DSH 会拿它**直接发请求**，
给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。

⚠️ **请求体字段名是 `reasoning_effort`**（与远端声明的复数形式同源，也与 OpenAI 标准
及本插件其余适配器一致）。⚠️ **不能靠 HTTP 状态码判断字段是否生效**：实测传
`reasoning_effort` / `reasoningEffort` / `thinking` **三种都返回 200** —— 服务端对
未知字段**静默忽略**（与「无效模型名回退默认模型」同一模式）。故字段名的依据是
**远端自己的命名**，而非「试出来能通」。

⚠️ **下发前必须校验档位在该模型的 `efforts` 内**（DSH 会把用户选的值直接透传）：
越界时**静默不下发**（退回服务端默认档），而不是发一个可能被拒的值。

⚠️ **实测「关闭思考」并不会真的消除思考内容**（`reasoning_effort:'none'` 仍返回
`reasoning_content`，`reasoning_tokens` 与基准相当）。**这是服务端行为，不是我们的
bug** —— 用户已明确接受（「设置关闭思考实际思考了可以接受」）。
同理 `xhigh` 也**不会**显著增加思考量，但**它是安全的**：实测 HTTP 200、
无流内错误帧、`finish_reason=stop` 未截断（用户关注点：「设置 xhigh 最大思考
如果出问题就不好了」）。

⚠️ **验证这类字段必须用流式**：第一版用**非流式 + 难题**，结果**连基准都 504**
（非流式长思考撞网关超时）—— 那是超时，不是档位问题。DSH 走流式，故探针也须流式。
且**不能用「思考字数」当唯一判据**：简单题目的思考量本来就小，各档差异淹没在噪声里。

排查脚本与取证命令**见不入库的 `docs/loomy-protocol-notes.md`**
（本文档不放脚本清单）。回归用例在 `tests/unit/loomy-adapter.spec.ts` 的
「LoomyAdapter 思考档位」段（9 条）与「请求体里的 reasoning_effort」段（4 条）。
⚠️ 已做**反向验证**：去掉 `resolveModel` 里那两行声明 → **5 条变红**。

### ⚠️ AccessKey 明文入库（用户明确同意）

`src/loomy-product.ts` 内含从 Loomy 客户端解密得到的讯飞账号 AccessKey。
它**只用于讯飞账号端点**（`account.xfinfr.com` 的登录签名），与业务/推理端点无关
（后者用用户登录后的 `session`），故泄露不涉及任何用户数据。

⚠️ **具体值、解密算法与口令、脚本清单见不入库的
`docs/loomy-protocol-notes.md`** —— 不要把它们写进 README / AGENTS.md。

### 新增 provider 时的位置参数陷阱（本次踩过）

`registerJetHubRpc` 与 `registerJetHubEndpoints` 的 auth 实例是**位置参数**。
新增 Loomy 时，三个既有测试因把参数列表写死而假失败：

- `tests/unit/qoder-wiring.spec.ts`（正则只允许一个 provider 插在 trae 后）
- `tests/unit/cline-adapter.spec.ts`（`toContain` 写死整串）
- `tests/unit/jet-hub-rpc.spec.ts`（9 个 `{}` 占位，新签名要 10 个 →
  `modelAdapters` 错位落到 `loomy` 形参上）

三处已改为**对 provider 数量中立**的断言（`[\w, ]*` / 显式补占位并注明原因）。
**再加 provider 时请沿用这种写法**，不要写死整串。

⚠️ 加 Raccoon（第 9 个）时**又踩了一次**：`tests/unit/jet-hub-rpc.spec.ts` 里
三处 `registerJetHubRpc(...)` 调用只补到 `loomy`，于是 `raccoon` 形参收到
`undefined`、`modelAdapters` **错位**落到 `raccoon` 上 → `model.list` 的
「关闭的模型仍显示倍率」用例假失败（表现为「展示名退化成裸 id」）。
`tests/unit/loomy-wiring.spec.ts` 的正则也因写死 `cline, loomy, modelAdapters`
而假失败。两处都已改为对 provider 数量中立的写法。
**教训**：新增 provider 后，`grep -n 'registerJetHubRpc(' tests/` 把**每一处**
调用点都补上占位，别只改报错的那一处。

---

## ⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的点

`raccoon` 是第 9 个 provider。实现是独立一套 `src/raccoon*.ts`
（`raccoon-product` / `raccoon` / `raccoon-oauth` / `raccoon-qr` /
`raccoon-login-page` / `raccoon-credits` / `raccoon-auth` / `raccoon-adapter`），
适配器复用 `src/openai-compat.ts`（与 qoder / loomy 同形）。

**真实依据**：2026-09-26 对生产端点逐项实测 + 客户端 `app.asar` 逆向
（工具 `scripts/raccoon-asar.mjs`）。

### 1. 官方登录链路**不可复用**，微信扫码才是可行路径

官方桌面端（`build/electron/main/desktopLogin.js`）走
「网页授权 → `office-raccoon://auth/callback?code=` →
`POST /login_with_authorization_code`」。

⚠️ **本插件收不到那个自定义协议回调**（宿主侧 Node 进程），
且 `/code/authorize` 页面的回调地址**写死在 Web bundle 里**
（`hl()` 直接 `new URL("office-raccoon://auth/callback")`），改不成 localhost。

**可行路径**：二维码的 `code` 由**客户端本地随机生成**
（`CryptoJS.lib.WordArray.random(16)` → 32 位 hex），服务端只做轮询查询。
⚠️ **实测任意自造 code 都被接受**并进入 `pending`：

```
POST /api/web/auth/v1/login_with_qrcode_code  {"qrcode_code":"1790405291292abcdef123456"}
→ 200 {"code":0,"message":"success","data":{"status":"pending"}}
```

状态机：`pending` → `logging`（带 `expired_at`）→ `success`（带
`access_token`/`refresh_token`）/ `canceled`。轮询间隔 **2000ms**。

### 2. 手机号必须 AES-128-CFB 加密；短信强制阿里云滑块

算法（渲染层模块 68284 的 `yv()`）：

```
key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
iv    = 随机 16 字节
mode  = CFB, padding = NoPadding
输出  = Base64(iv ‖ ciphertext)
```

⚠️ 必须**显式**写 `aes-128-cfb`：密钥 16 字节，写成 `aes-256-cfb` 会因长度
不足而抛错（不会自动补齐）。
⚠️ 填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
（11 字节手机号两种设置下密文都是 11 字节）—— 不必纠结。
⚠️ 错误码区分：明文/加密错 → `100003 params_encryted_error`；
加密格式对但号码非法 → `100002 params_invalid_error`。
⚠️ **`send_sms` 强制阿里云滑块**（`100006 captcha_verify_error`，
`SceneId=1pkmy0x3`、`prefix=hk1r5l`，脚本
`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`）。
已核实该脚本**无域名白名单校验**（扫 `document.domain`/`referer`/`origin`/
`whitelist` 均无命中，唯一 `document.domain` 命中是 core-js 的 iframe polyfill），
故本地页可以真实加载它。

### 2.5 ⚠️ **1 倍倍率也必须显示**（不要省略成无后缀）

**真实缺陷**（用户报障）：「为什么 Kimi-K3 没有倍率，ide 是 1 倍，1 倍也要显示倍率」。

`raccoonDisplayName` 早期有一条 `if (effective === 1) return name` ——
按「1 倍是默认，显示属噪声」省略了它。后果是**用户无法区分两种情形**：

- 该模型**本来就是 1 倍**（`billing_effective_multiplier === 1`）；
- 我们**没取到它的倍率**（字段缺失 → `Number.NaN` → 不加后缀）。

两者在列表里看起来一模一样（都只有模型名）。IDE 的模型选择器对 `Kimi-K3`
显示「1 倍」，故本插件对齐：**一律显示 `x生效价`**。

⚠️ **`NaN` / 负数仍然不加后缀**（那才是真正「取不到」的情形）——
不要把这两条合并成一条「1 倍或缺失都不显示」。

⚠️ 同理适用于**兜底表**：`raccoon-product.ts` 里 `sn-kimi-k3` 的
`name` 必须写 `'Kimi-K3 · x1'`，不能写 `'Kimi-K3'`
（兜底表与 `raccoonDisplayName` 的输出形态必须一致，否则远端/回退两条路径
显示不同）。

回归用例：`tests/unit/raccoon.spec.ts` 的「倍率恒为 1 时也要显示」、
`tests/unit/raccoon-product.spec.ts` 的兜底表断言、
`tests/e2e/raccoon-probe.e2e.spec.ts` 的远端实测断言。

### 3. ⚠️ 每日 300 积分**没有端点**，不要实现签到按钮

实测「每日积分发放」是**服务端按日自动发放**的（账单
`biz_type: 'daily_grant'`；该账号 13:30 注册、13:31 即到账）。
**不存在可调用的签到接口**。

故能力矩阵是 `{ balance: true, onboardingTasks: true }`，
**不登记 `dailyCheckin`** —— 登记了会让「一键签到」按钮每次点击都必然失败
（与 CodeArts 早期「对不支持的 provider 无条件发请求」同类）。

⚠️ 同时**不要**把 `login/points/grant` 当作每日签到：它是**幂等一次性**的
（已领过返回 `granted:false`，账单里能看到上一次记录），
第二天再点只会继续拿到 `granted:false`，与「签到」文案不符。

⚠️ 三个来源必须分清：

| 来源 | 金额 | 触发 |
|---|---|---|
| 新人注册礼包 | 3000 | 注册时服务端自动发放（`biz_type: reward_grant`） |
| **桌面端登录奖励** | 3000 | `POST /api/web/desktop/v1/login/points/grant` |
| 每日积分发放 | 300 | **服务端按日自动发放** |

⚠️ 判定「登录奖励是否已领」**不能只按 `biz_type === 'reward_grant'`**
（注册礼包也是它），必须同时匹配 `event_name === '桌面端登录奖励'`。
服务端**没有单独的奖励状态端点**，只能查 `GET /points/v1/bills` 明细
（`fetchRaccoonOnboardingStatus`）。

### 4. 零客户端依赖（硬约束，有测试守住）

⚠️ **运行时绝不读客户端数据**。理由（均为实测）：

1. 客户端**退出时删除** `~/.box-agent/config/auth.json`；
2. 客户端**每次重启都轮换整组凭据** —— 实测从
   `%APPDATA%\office-raccoon\Local Storage\leveldb` 提取的 `access_token`
   在 `exp` **尚未到期**（剩余 5859s）时就被 `401 200003` 拒绝，
   对照进程启动时间可确认是重启导致的轮换；
3. 用户可能**根本没装客户端**。

由 `tests/unit/raccoon-client-independence.spec.ts`（**源码扫描式**回归防线）
守住：禁止 `src/raccoon*.ts` 出现客户端路径（`raccoon-ai` / `office-raccoon` /
`box-agent`）、环境变量（`APPDATA`/`LOCALAPPDATA`）、文件读取
（`readFileSync`/`node:fs`）、以及 `leveldb`/`sqlite` 引用。

⚠️ **为什么用源码扫描而不是 mock**：这类约束的失效方式恰恰是
「某次改动悄悄加了一个 `readFileSync` 兜底」，mock 测不出来。

⚠️ 注释里解释「为何不这么做」是允许且鼓励的（扫描前会剥掉注释行）。

客户端安装目录仅用于**逆向取证**与**构建期图标提取**，都不是运行时依赖：

- `scripts/raccoon-asar.mjs`（只读探查，协议升级时用它重新核对）
- `scripts/extract-raccoon-icon.mjs`（**不入库**，见下）

### 5. 二维码是自己实现的，且**必须编码成真 PNG**

仓库**没有任何 QR 依赖**（已核实 `node_modules` 与 DSH 的 `node_modules`），
故 `src/raccoon-qr.ts` 自行实现（byte 模式 + 纠错等级 M + 版本 1–10，
约 550 行，含 GF(256) RS 纠错、zigzag 放置、8 掩码评分）。

⚠️ **两条真实教训**：

1. **结构测试全过 ≠ 二维码可用**。早期 14 个用例（finder 位置、尺寸、
   确定性）全部通过，但实际扫不出来。**判据必须是「与独立实现交叉验证」
   或「真实解码器能解出」** —— 本次用 Python `qrcode` + `segno` 双实现
   交叉确认，再用 **OpenCV `QRCodeDetector` 真实解码**验证
   （4 个用例含 144 字节登录 URL 全部还原正确）。
2. **登录页内联 SVG 时绝不能转义引号**。`renderRaccoonLoginPage` 早期把
   SVG 的 `"` 转成 `&quot;` 再注入 HTML，浏览器把它当**文本节点**而不渲染
   —— 用户报障「弹出页面二维码没显示出来」。
   ⚠️ 而当时的断言 `toContain('viewBox')` 在**有 bug 时也通过**
   （`viewBox=&quot;0 0 …&quot;` 同样含子串 `viewBox`），故缺陷从未被抓住。
   现断言要求「无 `&quot;`」+「合法 `<svg …>` 标签」+「path 段数 > 100」。

⚠️ `buildQrMatrix` 的 `options.mask` 参数**仅用于诊断与交叉验证**
（生产路径不传，走自动评分）—— 但它必须真的生效，
`tests/unit/raccoon-qr.spec.ts` 锁死了「8 个掩码产出各不相同」。

### 6. 过期判定必须回退解析 JWT（修过的真实缺陷）

`raccoonCredentialExpiresAtMs` 取值优先级是
**`expires_at` → JWT 的 `exp`**。

⚠️ 早期只读 `expires_at`，而它是**可选字段**（老凭据/手工导入可能没有）
→ 过期判定**恒为 false** → `refreshAll` 永远跳过这些账号
→ 表现为「凭据悄悄过期、续期从不触发」，与「续期按 `enabled` 过滤」
那次缺陷是同一类（**静默失效，无任何报错**）。
`tests/unit/raccoon.spec.ts` 有针对性回归。

### 7. 图标：从官方 1024×1024 提取，且**必须编码成 PNG**

来源 `C:\Program Files\raccoon-ai\resources\assets\icon.png`（1024×1024）。

⚠️ **不用 exe 内嵌图标**：实测 `ExtractAssociatedIcon` 与
`new Icon(exe, 64, 64)` 都只拿到 **32×32**（资源组里没有更大尺寸），
缩到 20×20 会糊。

⚠️ **真实缺陷**：`scripts/extract-raccoon-icon.mjs` 起初把**裸 RGBA 缓冲**
直接 base64 当 PNG 用 —— 产出字符串长度正常（12310 字符）、
`toContain('data:image/png;base64')` 也通过，但**不是合法 PNG**，
浏览器渲染不出来（图标位置一片空白）。改用 `encodePng()` 编码
（base64 从 12310 降到 2978）。
判据见 `tests/unit/raccoon-client-panel.spec.ts`：
**PNG 签名 `89504e470d0a1a0a` + IHDR 尺寸 + 非全透明**。
⚠️ 注意：该图标的 base64 **以大片 `AAAA` 开头**（顶部透明行全 0 字节），
目视很像空图但**数据正常** —— 故判据不能靠目视。

### 8. Raccoon-Auto 不是远端模型，**不要暴露**

它是客户端 i18n 条目（`modelPicker.auto` = `"Raccoon-Auto"`，
`modelPicker.autoMultiplier` = `"1 倍"`）渲染的**「自动选模」入口**，
**不在 `model_catalog` 里** —— 直接发给 `chat/completions` 会 404。

其真实语义由客户端 `resolveAutoCatalogModel()` 实现：按消息内容正则打标
（`TASK_TAG_PATTERNS` 识别 vision/code/analysis/office…）后按
`ability_level` 与 `context_window` 从候选池选真实模型；
候选池判据 `isTemporaryAutoRoutingModel()` 认 `raccoon-*` 前缀
或**含 `deepseek`**，故 `sn-deepseek-v4-1-flash` 也在其中。

**不实现的三条理由**：① DSH 的模型选择是**会话级固定**的，而 IDE 是
**按每条消息动态**选模，语义不匹配；② 复现需移植整张正则表，且选出的模型
**不可预测**、难排查；③ `ability_level`/`tags` 是客户端 UI 偏好，
不构成服务端契约，随时可能变。

**替代**：用户可直接选 `sn-deepseek-v4-1-flash`（`ability_level: 3`、
带 `auto` 标签，即复杂任务下自动选模最可能选中的那个）。

### 9. 工具调用：`tools` 必须真下发（Qoder/TRAE 的同型坑）

⚠️ 适配器把 `options.tools` 映射成 OpenAI 的
`{type:'function', function:{name, description?, parameters?}}`
写入请求体**顶层 `tools`**。

⚠️ **判据是「响应里有结构化 `tool_calls`」**，不是「模型在正文里说它想调用
工具」—— 后者正是 Qoder（WASM 把 `tools` 硬编码 `[]`）与 TRAE 踩过的形态：
模型拿不到函数 schema，只能用**正文里的 XML 文本**臆造，harness 认不出 → 任务终止。

⚠️ **间接证据（不是直接验证）**：桌面端 `model-profiles.json` 指向本端点，
且其背后的 agent 运行时 `box-agent-acp.exe` 内含 `tool_choice`（37 次命中）与
`function_call`（15 次命中）及完整 `openai.types.*` 类型表
—— 说明它构造的是带 tools 的 OpenAI 请求体。

⚠️ **本项的正式判据在 `pnpm test:e2e:raccoon-tools`**（双重闸门，
发真实请求验证）。实现期因客户端凭据被轮换而**未能完成真机实测**
（见设计文档 §12）—— 若该探针报「未返回 tool_calls」，
**不要**改用「system prompt 注入 + 正文 XML 解析」的回退方案。

### 10. 短信登录的 `nation_code` 初版只做 86

客户端下拉有 86/852/853/81。插件初版**只做 86（大陆）**，
因为 `100002 params_invalid_error: param phone invalid` **无法区分**
「号码格式错」与「该区号不支持」，不做未验证的猜测。

### 11. ⚠️ `tags` 里的 `vision` **不是**图片能力契约（真实缺陷，用户 2026-10-03 报障）

**症状**：给 `sn-deepseek-v4-1-flash`（DeepSeek-V4.1-Flash）发图，模型回
「无法读取图片 / 不支持图片」。

⚠️ **根因不是配置写错，而是「信息在源头就不存在」** —— 远端**从未下发**模态字段：

穷举 `model_catalog` 9 个条目的**键并集**：顶层 14 个键、`params` **只有**
`context_window` 与 `max_tokens`；用
`/modal|vision|image|img|multimodal|media|type|capab|support|input|output/i`
扫描，**命中 0 个**。⇒ 唯一的信号是 `tags`，而它被实测证伪。

**根因链（每一步都是「静默」）：**

1. `normalizeRemoteModel` 把「`tags` 含 `vision`」当成服务端能力声明；
2. `sn-deepseek-v4-1-flash` 的 `tags` 是
   `["general","code","html","analysis","reasoning","auto"]` —— **没有** `vision`
   （`display_description` 也只写「通用对话、代码开发、复杂分析」，不提图像识别）；
3. ⇒ `inputModalities` 播报 `['text']`；
4. ⇒ ⚠️ **DSH 在 `LlmRuntime` 里把图片替换成文本占位符**
   （`dsh-llm/lib/index.js` 的 `projectImagesForTextModel`，产出
   `[image omitted because this model accepts text only; attachment sha256:…]`）
   —— **图片根本没发出去**，请求体里压根没有图片；
5. ⇒ 用户看到模型说「读不到图」，而端点其实完全正常。

⚠️ **判据是「模型真的读得出来吗」，不是「远端怎么说」**（同 Qoder 那条
「IDE 能否用同一模型」）。实测：同一张**随机 6 位数字**图（模型无法猜）打
`POST /api/web/llm/v2/chat/completions`：

| 模型 | 远端 tags 含 vision | 实测读图 |
|---|---|---|
| `sn-deepseek-v4-1-flash` | ❌ | ✅ **5/5**（208063/942977/999889/123015/478368） |
| `sn-glm-5-3-flash` | ❌ | ✅ 1/1 |
| `sn-sensenova-6-8-flash` | ✅ | ✅ 2/2 |
| `sn-sensenova-6-8-flash-lite` | ✅ | ✅ 1/1 |
| `sn-kimi-k3` | ✅ | ✅ 1/1 |
| `sn-glm-5-3` | ✅ | ⚠️ **1/3**（provider 侧节点不一致，见下） |

⇒ **6 个可见模型全部能读图**。`tags` 的真实用途是**客户端「Raccoon-Auto 选模」的
偏好标签**（`TASK_TAG_PATTERNS` 给消息打 vision 标记后挑一个带 `vision` 的模型），
它回答的是「该模型适不适合处理这类任务」，**不是**「能不能吃图」。

**修法**（与 `buddy-adapter.ts` 的 `IMAGE_CAPABILITY_OVERRIDES` 同构）：
`RACCOON_IMAGE_CAPABILITY_OVERRIDES` 白名单 + `raccoonSupportsImage(id, tags)`，
**两条路径都要改** —— 远端解析（`raccoon-auth.ts`）与本地兜底表（`raccoon-product.ts`）。
⚠️ 兜底表与远端判定是**两个真相源**，用单测「兜底表的图片能力与远端实测 tags 判定
逐条一致」锁死，防它们悄悄分叉（同 Qoder「两处等待逻辑必须共用同一实现」的教训）。

⚠️ **别改成「该家恒支持图片」**：白名单只覆盖**实测确认**的个案，将来上架纯文本
模型时，恒 true 会把图放行、让上游回一个更难懂的 400 —— 错误更晚、更难排查。

⚠️ **实测时的两个坑**（否则会得到假的「不支持」）：

1. **必须关思考**，否则 `reasoning_tokens` 吃光 `max_tokens`、正文恒为空
   （首轮 64 token 全被 `reasoning_tokens: 64` 吃掉 → 6 个模型全部「失败」）。
   唯一有效通道是 `extra_body.thinking:{type:'disabled'}`（见本文档
   `RACCOON_EFFORT_*` 段）；
2. **`sn-glm-5-3-flash` 会 400 拒绝该参数**（「该模型始终思考，不支持关闭思考；
   请使用 low、high 或 max」）—— 测它时**不能**发 `thinking`，需另跑一轮。

⚠️ **`sn-glm-5-3` 节点不一致是 provider 侧缺陷，不归我们**：3 次只对 1 次，两次回
「当前模型不支持图片或视频输入」/「未收到任何图片」。错误体暴露网关有 3 个
fallback 组（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），
**部分节点是纯文本的**。它本来就带 `vision` 标签、我们一直在发图，
**本次修复不改变它的行为** —— 遇到时换模型即可，别改我们的声明。

排查脚本（只读、gitignored）：`scripts/probe-raccoon-vision.mjs`（打远端原始
条目）、`scripts/probe-raccoon-vision-real.mjs`（真实发图，支持 `PROBE_MODELS`
与 `NO_THINKING=1`）、`scripts/probe-raccoon-catalog-fields.mjs`（穷举键并集）。
回归用例在 `tests/unit/raccoon-product.spec.ts` 的「图片能力判定（tags 不是能力
契约）」段与 `tests/unit/raccoon-adapter.spec.ts` 的两条 ⚠️ 用例。
⚠️ 已做**反向验证**：白名单清空 → 4 条变红；兜底表改回 `false` → 2 条变红。

### e2e 探针

```
pnpm test:e2e:raccoon        # 只读：凭据/模型目录/倍率/积分余额/账单，零消耗
pnpm test:e2e:raccoon-chat   # ⚠️ 发推理：标准 OpenAI SSE + reasoning_content 形态
pnpm test:e2e:raccoon-tools  # ⚠️ 发推理：**tools 是否被接受**（第 9 条的正式判据）
```

### ⚠️ 报错文案：`400` 与 `401` 的语义

- `401 200003 authorization_verify_error` —— 凭据失效。
  ⚠️ 排查时**先确认客户端是否刚重启过**：那会轮换 leveldb 里的凭据，
  让人误以为是端点或协议问题。
- `400 100006 captcha_verify_error` —— 滑块过期，需重新过验证。
- `400 100002 params_invalid_error` —— 手机号格式或验证码错。
- `400 100003 params_encryted_error` —— 手机号**未加密**或加密格式不对。

### ⚠️ 失败分类：loomy 与 raccoon 的判据是**同一张表**（2026-10-06 同型复发）

`classifyLoomyFailure`（`src/loomy-adapter.ts`）与 `classifyRaccoonFailure`
（`src/raccoon-adapter.ts`）**逐格同构**：接口形态同族（额度错误没有专用 HTTP
状态码，文案是主通道）、四个类别同义（`quota` / `rate` / `auth` / `other`）、
冷却时长同档（`quota` 24h、`rate` 1h）。

**真实缺陷（同型复发）**：raccoon 在 `7b524ff` 把判据收窄了两处，loomy **未同步**，
于是同一报文在两个 provider 上被判成**不同类别**，危险方向恒定朝 loomy
（它多写冷却 ⇒ 封可用账号 24h）。本机实测（临时探针，已删）：

| 报文 | loomy（未同步时） | raccoon（已修） |
|---|---|---|
| `403 + insufficient permissions to access this resource` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `403 + 积分不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `401 + 余额不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `401 + 14018 Credits exhausted`（网关故障常带余额提示） | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `400 + the context window is insufficient for this model` | `quota` ⇒ **写 24h** | `other` ⇒ 不换号 |

前四行正是 AGENTS.md 记的 **2026-10-06「全池被封」事故形态**（那次触发词是
`authorization_verify_error`，这次是 `insufficient permissions` / 「不足」类文案）：
**认证类是账号态、不是模型冷却**，写标记会把网关侧授权故障放大成
「整个 provider 被封 24h」。

**两条不变式**（改任一侧都必须同步另一侧）：

1. **401/403 先判**，恒归 `auth`。状态码与额度文案并存时（网关侧故障常在报文里
   捎带余额提示）**以状态码为准** —— 这正是「先按某字段判门禁、再解析」类写法的
   反面（同 AGENTS.md 记的 Qoder 嵌套深度坑）。
2. `insufficient` **单独出现过宽**，必须与邻近的「钱」义词
   （`point` / `credit` / `balance` / `quota` / `token`）**共现**才算额度。
   中文三词（积分 / 额度 / 余额）**不要**收紧 —— 它们的方向是「宁可漏判不可误伤」。
   漏判只是不换号，误判会封可用账号 24h。

**防复发的真正闸门是「对拍」而不是各写一份用例**：单方面把一侧「改严」时，
两侧各自的用例**都能过**（本次的 loomy 侧就是这样漏掉的）。
`tests/unit/loomy-adapter.spec.ts` 的「与 raccoon 对拍」段把**同一批真实报文
喂两个分类器、断言逐条同结论**，分叉即红。
⚠️ 已做**反向验证**：把 loomy 的顺序与 `insufficient` 判据改回修复前 →
3 条变红（含对拍那条）；恢复后 44/44 绿。

### ⚠️ 401 续期后必须**重新反查账号 id**（loomy 与 raccoon 同款，2026-10-06）

`options.resolveCredential` 是**池优先**的（loomy 还叠加余额分档：
`src/index.ts` 先 `loomyBalanceSelector.select()` 再解析该号的 ref），
而 `refresh()` 续期/探测的是**池当前默认账号** —— 二者可能不是同一个号。
⇒ **续期后取回的凭据可能属于另一个账号**，若 `activeAccountId` 不跟着更新，
冷却标记就记在**没发这次请求的号**头上：没耗尽的号被封 24h，而真该封的号
下次仍被选中（「卡死在一个号上」照旧）。

raccoon 在 `51ded6a` 修了这处，**loomy 当时未同步**（同一次审计里已发现
`markCurrentAccount` 的末号漏记，却漏了这一处）。现两家都在续期后按
`refreshed.access_token` 调 `findAccountIdByCredential` 重新反查。
⚠️ 与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
⚠️ 已做**反向验证**：去掉 loomy 的反查块 → 对应用例变红；恢复后全绿。

---

## ⚠️ MiniMax Code（中国版）provider：不能凭直觉改的点

`minimax` 是**第 10 个、也是首个 `Anthropic Messages` 协议族**的 provider
（其余九个都是 OpenAI 兼容族或各自的自定义协议）。生产环境
`https://agent.minimax.cn`。实现是独立一套 `src/minimax*.ts`。

### 1. ⚠️ `pending` 是 **HTTP 200**，不是 OAuth 标准的 400

设备码轮询里，服务端用 **HTTP 200 + `status: "pending"`** 表达「用户还没完成授权」；
而标准 OAuth 是「非 200 + `error=authorization_pending`」。**两种形态都要认**。

⚠️ **只看 HTTP 状态码会把「还在等你点授权」误判成「拿到 token 了」** ——
实测表现为 `令牌响应缺少 access_token`。这与 Qoder「404 表示尚未授权、
必须继续轮询」是同类坑（**别把非标准形态当错误**）。

### 2. ⚠️ 模型目录**必须走远端**，不能照抄客户端内置表

客户端 `config.js` 的内置表**只有 3 个**（`MiniMax-M3` /
`MiniMax-M2.7-highspeed` / `MiniMax-M2.7`），而远端
`GET /mavis/api/v1/models?region=cn&buildEnv=prod` 有 **4 个** ——
**照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`**，而它正是客户端界面上
被选中的那个（用户截图证据）。

**判据**：目录走远端；远端失败时才回退兜底表（`minimaxFallbackEntries`）。

### 3. ⚠️ 只有 `MiniMax-M3.1-Flash-Preview` 有思考档位

其余三个远端条目**没有 `effort_options` 字段** —— 这是**远端事实，不是我们漏解析**。
故 `resolveModel` 对它们**不声明 `reasoning`**（`minimaxReasoningInfo` 返回
`undefined`）。与 Qoder 的 `qmodel`「只有关闭思考」是同一类事实：
**远端没给就是没有，不要补猜测的默认值。**

⚠️ 档位展示名直接用**远端原文**（`name === id`），不做本地化。
⚠️ 窗口口径是**档位表最大档**（M3.1 / M3 → 1M；M2.7 系 → 200K），
**不是**目录里的 `max_input_tokens`（Qoder 那条已证伪的口径，别再犯）。

### 4. ⚠️ `timezone_id` 是 **query 参数**，且放错位置**也是 HTTP 200**

签到端点：
```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   # body {}
```
⚠️ 放到**请求头**会回 `1406010011 invalid timezone_id` —— 而且**那也是 HTTP 200**。
故「HTTP 200 = 成功」在这里**不成立**，必须查业务码
（`base_resp.status_code`，**不是** `code`）。

### 5. ⚠️ `points` 是**总数**，`bonus_points` **含在其中**，**不得相加**

实测第 1 天 `points: 800` / `bonus_points: 400`：客户端按钮显示「签到得 **800**」、
右上角另有「额外 400」角标 —— 即 `bonus_points` 是 `points` 的**子集**，
不是额外加量。

⇒ `dailyCredit === points`（**800**），**不是** `points + bonus_points`（1200）。
相加会让展示金额**虚高一倍**（用户 2026-09-28 亲自纠正）。

### 6. ⚠️ 幂等判据是 `claim_result`，**不是 HTTP 状态码**

`claim_result`：`1` = 真领取、`2` = 已领过。**重复领取同样返回 200**。
故 `claim_result` 缺失 / `null` / 越界 / 字符串时一律判 `failed`，
**绝不虚报成功**（虚报会让用户以为 +了积分，实际 +0 ——
与 TRAE「显示成功但 +0」是同一类报障）。

⚠️ 另：**今日已领的判据是 `is_today && status === 3`**，**不是**「没有 Claimable」
—— 后者会把「服务端没下发数据」误报成「今天已领」（Qoder 踩过同款）。

### 7. ⚠️ 积分余额端点是**平铺响应**，且 `details` 会整个缺失

`GET /minimax-cloud/api/v1/credit/details` 的 `total_count` 与 `base_resp` **同级、
没有 `data` 键** —— 与签到端点的信封结构**不同**。实现用 `unwrapEnvelopeData`
兼容两种形状（否则会撞上「缺 `data` 即判失败」的守卫，把**「余额为 0」
报成「查询失败」**）。

⚠️ **空明细时 `details` 字段整个缺失**；解析必须容忍。本机实测
`total_count: 0` 且无 `details` —— 那是**有效结果**（「真的为 0」），
与「查询失败」（`null`）是两回事，**不要合并**。

### 7.1 ⚠️⚠️ 余额取 `details[].remaining_amount`，**`total_count` 是记录条数**（2026-09-29 修复的真实缺陷）

初版写成 `total = total_count` —— **错的**。`total_count` 是 `details[]` 的
**记录条数**，真实余额是各包 `remaining_amount` 之和。

实测原始响应（本机领取 800 积分后，2026-09-29）：
```json
{"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
             "granted_amount":"800.00","credit_type":2,
             "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
```
余额是 **800**，`total_count` 是 **1** —— 用户界面会显示「1 积分」。

⚠️⚠️ **为什么初版与单测都没发现（这个坑的形态值得记住）**：
账号余额为 0 时 `details` **整个缺失**、`total_count` 恰好也是 **0**
—— 「条数 0」与「余额 0」在数值上**偶然重合**。于是
「`total_count: 0` → `total: 0`」那条单测是**同义反复**，
它**只能证明「0 还是 0」**，无法区分两个语义。
⇒ **领取积分后才分叉**（条数 1 / 余额 800），缺陷才暴露。

**教训具有普遍性**：当「错误的字段」与「正确的字段」在**已知样本上取值相同**时，
任何断言都是同义反复。⇒ **必须构造让两者分叉的样本**
（本例：一条 800 的记录 ⇒ 期望 800 而非 1）。这正是 Task 8「反向验证」要解决的
问题，但反向验证**只能证明既有用例有判别力**，证明不了「用例覆盖了正确的语义」
—— 后者需要**让错误实现产生不同数值**的样本。

⚠️ **`remaining_amount` 是字符串**（`"800.00"`），而 `finiteNumber` 只认 number
⇒ 必须用宽容解析（数字与字符串都接受，见 `looseAmount`）。
⚠️ `Number('')` **是 0** ⇒ 空串必须**先挡掉**，否则「缺字段」会被误读成
「0 积分」（与「不编造 0」的既有铁律冲突）。
⚠️ `expiredTotal` 仍为 0、`packages` 留空：`details[]` 没有区分「本周期有效」的
标志（`credit_type` 语义**未实测**），**不凭猜测分类**。

### 8. 推理：**Anthropic Messages** 协议（已实测启用，2026-09-29）

`POST {apiHost}/mavis/api/v1/llm/v1/messages`（`stream: true`）。
实现分两块：`src/minimax-messages.ts`（请求体构造 + SSE 消费）与
`src/minimax-adapter.ts` 的 `stream()`。

⚠️ **不要复用 `openai-compat.ts`**：那是 OpenAI 形状，硬套会把
`tools` / `tool_calls` / `input_json_delta` 全部翻译错。
⚠️ 也**不做**「通用 Anthropic 层」抽象 —— 只有一个消费者，
抽象是凭空多一层间接（Qoder 的教训是「同族第二个产品出现时再抽」）。

#### 8.1 ⚠️⚠️ 思考档位：**两种能力**，M3.1 与 M3 完全不同

远端 `thinking_config.mode` 有三种值（**不是**只看 `effort_options`）：

| 模型 | mode | effort_options | 实测行为 | 我方声明 |
|---|---|---|---|---|
| M3.1-Flash-Preview | `forced_on` | ✅ `default/low/medium/high/xhigh/max` | 传 disabled ⇒ **硬 400** | 6 档（默认 `default`） |
| **M3** | **`switchable`** | ❌ 无 | **不发 ⇒ 不思考**；adaptive ⇒ 2785+ 字符 | `on` + `none` |
| M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 disabled ⇒ **静默忽略** | 不声明 |

**M3.1 必须 adaptive**（服务端原话，实测 HTTP 400）：
```
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, model \"MiniMax-M3.1-Flash-Preview\" requires
  adaptive thinking; thinking.type=\"disabled\" (including
  reasoning.effort=none) is not allowed (2013)"}}
```

⚠️⚠️ **M3 必须给「开启」档，不能只给「关闭」**（真实功能缺口，2026-09-29 修复）：
实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
而 `adaptive` 有 **2785 / 2797** 字符。初版只看了 `effort_options`（M3 没有）
⇒ 声明成「无推理等级」⇒ 用户**既不能开也不能关**；
我第二版只加 `none` ⇒ **只能关、无法开**（把模型强项藏起来了）。

⇒ 取客户端**权威词汇**（`thinking.js` 的 `isMiniMaxM3ThinkingMode`：
`value === 'on' || value === 'off'`）声明 **`['on','none']`**
（`on`→`adaptive`、`none`→`disabled`；`off` 在 DSH 侧的惯用名是 `none`）。
⚠️ **不设 `defaultEffort`**（M3 无 `default_effort`）⇒ 保持服务端默认（=不思考），
**不擅自**设成 `on`（那会改变用户既有行为）。

⚠️ **`forced_on` 的模型绝不追加开关**：M3.1 会硬 400、M2.7 被静默忽略
—— 「给了选项却空转」比「不给」更糟（用户以为关掉了、实际没关）。

⚠️ **展示名**：远端档位用原文（官方 IDE 就是 `default`/`low`/…），
但 `on`/`none` 是**我们追加**的，给中文「开启思考」/「关闭思考」。

⚠️ **档位真的生效**（实测同一难题）：M3.1 `low`=572 / `medium`=1181 /
`max`=1297 字符 ⇒ **不是空转**。故断言必须比较**不同档位的思考量**，
不能只断言「HTTP 200」。

⚠️ **测档位要用需要推理的问题**：问「只回复两个字：收到」时
adaptive 与 none **都是 0 思考字符**（模型根本不思考）⇒ 断言退化成同义反复
（我第一版探针就这么假红过）。

⚠️ **`readImage` / contextWindow 与用户 IDE 截图的对应**：
IDE 的「上下文窗口 512K / 1M」是 **IDE 自己的**多档选择；
DSH 的 `LlmModelContext` **只有单一 `contextWindow` 字段**，本身不支持多档
⇒ 按用户 2026-09-29 的指示「不用档位直接用最大的」取 **1M**。
⚠️ 用户「看不到档位」的**真实原因**是**插件未登录**（凭据里无 `MINIMAX_*`
⇒ `providerCatalogVisible` 为假 ⇒ `listModels` 返回空 ⇒ DSH 隐藏整个 provider），
**不是档位没实现**。排障时先查登录态。

#### 8.2 ⚠️ 图片：**必须** Anthropic 形状（真机实测）

```json
{ "type":"image", "source":{"type":"base64","media_type":"image/png","data":"<裸base64>"} }
```
- ⚠️ OpenAI 的 `image_url` 被服务端**明确拒绝**：
  `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`
- ⚠️ `data` 是**裸 base64**（无 `data:` 前缀）
- ⚠️ 实测：**1×1 的 PNG 会被拒**（`400 invalid params`，**无细节**）；
  40×40 起正常。真实截图远大于此，不影响使用 ——
  但**排障时别用 1×1 图**（会得到一个毫无线索的 400）
- ⚠️ 可与 `thinking:{type:'adaptive'}` 共存、`text` 在 `image` 前后均可
- 实测：M3.1 / M3 都能识图（自造纯红 PNG ⇒ 答「红色」）

⚠️ **判据是「模型真的看到了图」，不是「HTTP 200」**（后者在静默丢图时也通过）。
⚠️ **但不要断言精确颜色**：实测同一张纯色图 M3.1 答过「灰色和暗红色」、
M3 答过「绿色」/「红色」—— 那是**模型自身识图质量**，与序列化无关；
硬匹配会让探针随机假红。断言应取「**不是**拒答」+「含颜色词」。
⚠️ **消息体的图读不到 ⇒ 抛错**（用户显式意图）；**工具结果里的图读不到 ⇒ 跳过**
（工具结果本身仍有价值）—— 有意区别对待。
⚠️ 声明不支持图片的模型收到图片 ⇒ **报错**，不能发出去让服务端 400。

#### 8.3 SSE 帧形状与三个必须保留的细节

`message_start` → `ping` → `content_block_start` → `content_block_delta` →
`content_block_stop` → `message_delta` → `message_stop`。

- ⚠️ **`signature_delta` 必须忽略**（thinking 块的签名）。当正文处理会往回答里
  注入一串十六进制。
- ⚠️ **`thinking` 块映射成 `reasoning` 块**，否则思考内容污染正文。
- ⚠️ **`thinking_tokens` 是 `output_tokens` 的「子集」**（实测两者都可能是 64），
  映射到 `reasoningTokens`，**不累加**到 outputTokens。
- ⚠️ **错误走 `event: error`**（`{type:'error', error:{type,message}}`），
  不是 OpenAI 的 `{error:{message}}` —— **必须抛错**，否则重演 Qoder
  「干净地停止、无任何报错」。

#### 8.3 ⚠️ 工具调用是 Anthropic 形状，**没有 `role:'tool'`**

- assistant 的 `tool-call` → `tool_use`（**`input` 是对象**，不是 JSON 字符串）；
- 工具结果 → **user 消息**里的 `tool_result` 块（`tool_use_id`）。
- ⚠️ 参数是残缺 JSON 时退化 `{}`，但**块必须保留** —— 丢了会让后续
  `tool_result` 变孤儿块、服务端 400。
- ⚠️ 历史里的 `reasoning` 块**不回传**：Anthropic 要求 thinking 带签名，
  我们不持久化签名 ⇒ 回传会被拒。丢弃思考历史是安全的。
- ⚠️ **判据是「结构化 `tool-call` 块」**，不是「模型在正文里说它想调工具」
  —— 后者正是 Qoder/TRAE 踩过的缺陷形态（插件没发 `tools`，
  模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。

#### 8.4 ⚠️ 402 必须归 `QUOTA_EXCEEDED`，不能归 `SERVER`/`AUTH`

余额不足是最常见的真实失败，归错会让用户看不到「去充值」这个**唯一有效动作**。

#### 8.5 ⚠️ 未实现：图片（**显式抛错**，不静默丢弃）

`M3.1` / `M3` 目录条目声明 `supportsImage`（用于 `inputModalities` 播报），
但**带图请求未实测**，故序列化遇到 image 块**显式抛错**。
静默丢弃会让用户以为图片被模型看到了。

#### 8.6 ⚠️ 单测抓到的真实缺陷：截断流丢失最后一帧

原 `consumeMinimaxSse` 只在 `while (!done)` 里按行处理，`split('\n')` 后
`pop()` 的尾巴留在 `buffer` 等下一轮 —— 但**流结束时没有下一轮**，
于是最后一条事件（正是携带 `stop_reason` 与 `usage` 的 `message_delta`）
**永远被丢弃**。

真实 SSE 大多以空行结尾，恰好掩盖了它；**截断的流**才暴露，且症状极隐蔽：
`max_tokens` 被误报成 `stop`、`usage` 永远是 0 —— **不报错、不中断，只是数字错**。

⇒ 修法：把行处理抽成嵌套生成器 `processLine`，收尾时先 `decoder.decode()`
刷出残留多字节，再把 `buffer` 余量**按整行**走一遍同一套逻辑。
⚠️ 同时**空行要重置 `eventName`**（它是 SSE 的事件终止符；提到循环外后
不重置会让上一条事件的 `event:` 名残留到下一条 `data:` 上）。
回归用例 4 条，反向验证过（去掉收尾冲刷 ⇒ 4 条变红）。

### 9. 能力矩阵与 e2e

```js
minimax: { balance: true, dailyCheckin: true }
```
余额与每日签到**都有**（与 raccoon 只有 `onboardingTasks` 不同）。

```
pnpm test:e2e:minimax        # 只读：目录/签到状态/余额；**绝不领取**
pnpm test:e2e:minimax-claim  # ⚠️ **真实领取**当日积分（消耗当天唯一一次机会）
pnpm test:e2e:minimax-chat   # ⚠️ 发推理（真实适配器；默认 M2.7，会消耗额度）
```

⚠️ `minimax-chat` 的断言是「**取到非空文本 + finish 正确**」与
「工具调用返回**结构化** `tool-call` 块」—— 不是「请求返回 200」。
后者在「模型什么都没说」时也会通过（那正是要防的形态）。
⚠️ 默认只测 **M2.7**（用户 2026-09-29 指定：每天有免费额度）；
`DSH_MINIMAX_CHAT_E2E_ALL=1` 才测全部四个模型。

⚠️ 只读/领取探针读的是 **MiniMax Code 客户端自己的登录态**
（`~/.minimax/auth/prod/cn/mcode-public/auth.json`），**不是**本插件的凭据存储
—— 该 provider 尚未在任何机器上完成过插件登录。

⚠️ **token 过期时探针自动 skip，绝不代客户端续期**：MiniMax 的 refresh
可能轮换 `refresh_token`，若我们刷一次却不写回客户端文件，用户的客户端登录态
就会被弄坏。实测过期 token 打只读端点返回 **HTTP 401 `invalid access token`**。

### 10. ⚠️ `registerJetHubRpc` 的位置参数陷阱（**第 5 次复发**）

`registerJetHubRpc` 是长**位置**参数列表（**12 个 auth** + `modelAdapters`，
顺序：`codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline,
loomy, raccoon, minimax, zcode`）。
新增 provider 时**必须**在 `tests/unit/jet-hub-rpc.spec.ts` 的调用点补占位，
否则 `modelAdapters` 会**错位**落到最后一个 auth 形参上。

**已复发五次**：加 Loomy、加 Raccoon、加 QoderCN、加 MiniMax、**加 ZCode
（2026-09-30 合并上游时一次插了两个 provider，第 5 次）**。
测试注释里逐字预言过这个坑。

⚠️⚠️ **第 5 次的关键差别：这是「合并」引发的，`git` 全程不报冲突。**
上游把 `minimax` / `zcode` 插在 `raccoon` 之后，`jet-hub-rpc.spec.ts` 的
`provider.status` 那处调用点没跟上 → `modelAdapters` 落到 `minimax` 形参上、
真正的位置收到 `undefined` → 实现退化成套黑名单的 `ctx.llm.listModels()`。
症状与第 4 次**同型但报错位置不同**：三条用例断言
`{ total, disabled }` 时实际拿到 **`{ total: 0, disabled: 0 }`**
（不是渲染问题，是**目录读不到**）。
⇒ **合并任何新增 provider 的上游改动后，必须重跑 `jet-hub-rpc.spec.ts` 的
`provider.status` 组，不能以「git 没报冲突」判定合并没有语义问题。**
排查脚本可离线复查全部调用点的实参对齐（剥注释后逐个数形参，
本机实践：Windows 下别用内联 `node -e`，PowerShell 会吃掉引号/反引号，
写成 `.mjs` 文件再跑）。

⚠️ **另一个格式陷阱**：`registerJetHubRpc` 的**调用**必须保持**单行**
（`... raccoon, minimax, zcode, modelAdapters)`）。拆成多行（哪怕只加尾随逗号）
会让 `qoder-wiring.spec.ts` / `raccoon-wiring.spec.ts` 的正则失配而失败。

⚠️ **根治方向**（尚未做）：把它改成**具名参数对象**（`{ auth: {...}, modelAdapters }`）。
已复发五次说明「靠注释提醒补占位」不足以防住 —— 但那是独立重构，
需要同时改 `src/index.ts` 与全部测试调用点，不要顺手做。
