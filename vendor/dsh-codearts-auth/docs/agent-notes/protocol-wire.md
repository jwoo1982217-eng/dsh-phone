<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IKITT9）

**真实缺陷**（用户报障）：带截图的会话攒到 **36 张**后**每轮都失败且不可恢复**，
自动压缩试 3 次全灭，只能新建会话：

```
buddy: 内容过长，请精简或新建任务 prompt is too long: 100001 tokens > 100000 maximum
```

⚠️ **这个 `100000` 不是上下文窗口**（`src/product.ts` 给 `deepseek-v4.1-flash`
声明的是 **1,000,000**）。报障者同一会话**纯文本 prompt 到 345,687 仍被正常接受**，
且本机 11,351 次成功请求的图片 token **无一越过 10 万**（最大 96,537 = 35 张，
36 张正好顶穿）。它是网关对**单次请求图片视觉 token 总量**的另一道限制，
计价 ≈ **617 px / token**（1721×997 ≈ 2,781 token/张）。

⇒ **排查这类"内容过长"先看数字对不对得上上下文窗口**：对不上就是别的预算，
别去改 `contextWindow`（那只会让 DSH 更早触发压缩，反而更糟）。

### 三条修复与其理由

1. **按预算缩放**（`src/image-budget.ts`）：每张固定 **640,000 px**（≈1,037 token，
   约 96 张才撞墙，且 1051×608 上 UI 小字仍可辨认 —— **不要调更小**）。
   ⚠️ **为什么是"每张固定"而不是"按本次张数分摊"**：附件服务的请求版本
   **按目标尺寸缓存**（`readImageRequest` 的缓存身份含附件 id、变换版本、
   目标尺寸、字节目标）。尺寸若随"这条会话现在有几张图"浮动，
   同一附件每次派生不同 `variantId` → 缓存反复击穿、每轮重编码，
   而且用户无法预测一张图被缩成多大。
2. **桥接 `ctx.attachments.readImageRequest(ref, target)`**（`src/index.ts` 的
   `makeReadImageRequest`）：缩放/编码交给附件服务（alpha→WebP、不透明→JPEG、
   85/75/60 质量阶梯），插件只选目标。
   ⚠️ **不可用一律返回 `undefined` 而不是抛错**，适配器据此**回退原图**：
   服务没装、老宿主没有该方法、后端拒绝投影
   （`ATTACHMENT_PROJECTION_UNSUPPORTED`）、附件引用缺 `width`/`height` ——
   四种都必须发原图。缩放是优化，**绝不能变成新的故障源**。
   ⚠️ **两层都要兜异常**：写用例时实测到"只靠桥接层吞异常"不够
   （桥接是运行时约定、类型系统不保证），适配器的 `projectRequestImage`
   自己也 `try/catch` 返回 `undefined`。
   ⚠️ 但**不得削弱原有护栏**：`readImage` 读不到字节仍必须抛
   `UNSUPPORTED_CONTENT`（那是"静默丢图"回归防线）。
3. **11115 的分类不得依赖 `extError` 是否存在**：harness 的
   `isContextWindowExceededError` 五个分支都要求出现 `context` / `for this model`
   之类字样，实测对以下三种形态**全部返回 false**（只有带
   `extError.code=context_length_exceeded` 的那份才命中）：
   `prompt is too long: N tokens > M maximum`／拼上中文文案的整行／
   `{code,msg,displayMsg}` 三件套。于是报障者同一会话里逐字相同的错误
   一会儿 `CONTEXT_WINDOW_EXCEEDED`、一会儿 `INVALID_REQUEST`。

   ⚠️ **漏判的代价是不对称的**，所以方向取"宁可多判一次溢出"：
   `INVALID_REQUEST` **不在** `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
   更关键的是 `dsh-compaction-basic` 的 request-error listener
   **第一行就是** `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
   → 连"试一次压缩"的机会都没有，会话每轮直接报废。归成溢出的最坏结果
   只是一次无效的压缩尝试。
   ⚠️ 补的判据必须**窄**：同时要求「prompt is too long」与「N tokens > M」，
   只认前者会把别的内容类 400 误判成溢出（有用例锁着）。

### 范围与**有意未做**项（别当成漏改）

**实测过的九家**（2026-09-28，用 `tests/fixtures/test.png` 2560×1600 = 4.10M px/张
≈6,639 token/张，逐级加张数、每次只加图片、文本固定）：

| provider | 边界 | 失败形态 | 撞的是什么 |
|---|---|---|---|
| **buddy / workbuddy** | **15 张** | `prompt is too long: 100001 tokens > 100000 maximum` | **图片视觉 token 预算** |
| **raccoon** | **4 张** | `HTTP_413: request body exceeds 10MB` | **请求体字节**（10 MB 硬限）→ 缩放后 **24 张全过** ✅ |
| **qoder** | 8 张过 / **15 张** | `TRANSPORT: fetch failed`（≈57 MiB） | **请求体体积** → 缩放后 **24 张全过** ✅ |
| **lobsterai** | 12 张过 / **13 张** | `SERVER code=500`（≈50 MiB） | **请求体体积**（不是预算 —— 500 不是准入报文）→ 缩放后 **24 张全过** ✅ |
| **cline** | 24 张（≈159K token）全过 / **32 张** | `TRANSPORT` | **请求体体积** → 缩放后 **32 张全过** ✅ |
| **loomy** | **24 张全过** | — | 未撞墙（本 fixture 下），故未接缩放 |
| **trae** | **未探到边界**（本轮只测了 1 张，通过） | — | ⚠️ **上一轮的「1 张即 4001 仅可见但不可调用」已被推翻**，见下 |
| codearts | 未测 | — | 其 `deepseek-v4` 系是华为云免费福利额度，非用户候选模型 |

⚠️ **trae 那格是本轮最该记住的教训**：上一轮同一账号对
`deepseek-v4.1-flash` 与 `glm-5.3-flash` 都回 `4001 param is invalid`
（适配器诊断「仅可见但不可调用」），据此登记成「探测无效、拿不到阈值就不定值」。
**本轮同一账号、同一模型，1 张直接成功，缩放后 24 张也全过** ——
说明那是**账号/服务端的临时状态**，不是模型的固有属性。
⇒ 与 Qoder「无签到」（!IKIRTT 之前的误判）同型：**「某次实测没看到」不能推广成
「不存在」**。引用一条否定性结论时，必须带上「何时、哪个账号、什么形态」，
并在下次探测时**先重验这条否定结论本身**，而不是把它当前提。
⚠️ 但**也不要因此就给 trae 定预算值**：它的原图边界仍未探（本轮只测 1 张原图），
**拿不到阈值就不定值**这条规矩不变。

⇒ **只有腾讯系真有「图片 token 预算」这道约束**，其余各家撞的都是
**请求体体积**（各家阈值不同：raccoon 10 MB、lobsterai ≈50 MiB、
qoder ≈57 MiB、cline ≈122 MiB）。两种约束**只有缩放图片这一个共同解法**，
但**旋钮不同**：token 预算看**像素**，体积限制看**编码字节**。所以：

- **已接缩放的七处**：buddy / workbuddy（像素 640,000，字节默认 2 MiB）、
  raccoon（像素 + **字节 512 KB**，因它硬限 10 MB）、
  qoder 与 qodercn（**同一个 `QoderAdapter` 类**，像素 + 字节 1 MiB —— 改一处两站同时受益）、
  lobsterai、cline（各 像素 + 1 MiB）。
- ⚠️ **字节目标各不相同是有意的**：raccoon 512 KB（10 MB 配额要撑到 14 张）、
  qoder / lobsterai / cline 1 MiB、buddy 2 MiB。**别合并成一个常量**，
  也别把 buddy 的 640,000 当全局像素预算推给别家 ——
  这正是本仓库 `endpoint` 那条教训的形状。
- **未接的两家**：loomy（实测 24 张全过，无证据说明它有约束）、
  trae（⚠️ **理由已变**：原来说「探测被『仅可见但不可调用』挡住」，
  而本轮该账号同一模型已能正常收图 —— 旧理由失效，但**新理由仍然成立**：
  它的**原图边界从未探过**（本轮只测了 1 张原图就通过），
  **拿不到阈值就不定值**这条规矩不变）。
  ⚠️ 别"为了统一"给它们塞一个猜出来的预算。
- ⚠️ **接线漏改的教训**：本轮先改了适配器**却没在宿主桥接**，
  结果 qoder / qodercn / lobsterai / cline 四家的修复**静默不生效**
  （适配器有 `readImageRequest` 选项但 `index.ts` 没传 = 永远走原图路径）。
  是 `tests/unit/image-budget.spec.ts` 里那条「宿主侧桥接计数」断言抓出来的。
  ⇒ 接新 provider 时**适配器 + 宿主桥接两处都要改**，用例两处都锁。
- ⚠️ **探针自身的接线错误会被「回退原图」掩盖**（本轮真踩到，代价是一轮 90 秒的
  真机探测得出**错误结论**）：e2e 里把 `makeScaleBridge(fixture)`（一个
  `{bridge, stats}` 包装对象）误当函数注入 `readImageRequest`，适配器调用它必然抛错，
  而 `projectRequestImage` 的 `try/catch` 把异常兜成「**回退原图**」——
  症状于是是「**缩放后照样 413**」，看起来像字节目标定小了，实际是根本没缩放。
  ⇒ 因此 `makeScaleBridge` 返回 `stats` 记录每次派生，
  **用例必须先断言 `stats.length > 0` 再断言结果**。
  推而广之：**任何"回退到旧行为"的兜底都会把接线错误伪装成产品缺陷**，
  这类兜底旁边必须有一条「兜底是否被触发」的可观测证据。

⚠️ **探测方法论**（这轮踩出来的，重测时必须保持）：
- **必须先跑 0 张基线**。第一版探针直接上 15 张，qoder 报 `TRANSPORT`、
  raccoon 报 `AUTH 200003` —— 两个都不是图片问题（raccoon 那个账号缺
  `office_identity`，qoder 是凭据过期），却被读成「撞墙了」。
- **只有 `prompt is too long: N tokens > M maximum` 这种报文才算图片预算**；
  `413` / `TRANSPORT` / `500` 都是体积或稳定性问题（`classifyFailure` 已分类）。
- **要逐个账号验号**：实测本机 8 个 qoder 账号里 4 个 refresh_token 已失效、
  3 个当日额度耗尽，只有 1 个可用 —— 拿 `[0]` 就用会得到假的「探测失败」。
- **0 张基线的结论必须驱动「跳过」而不是「失败」**（`assertBaselineUsable`）。
  本轮为省额度把几个用例改造成「只测缩放后」，**顺手把 0 张基线删了** ——
  于是 cline 的当日免费额度耗尽（`429 Daily free limit reached … 19h 55m`）
  被记成「缩放后仍被拒」，看起来像产品缺陷。基线一条请求几乎不花额度，
  却能把「账号不可用」与「图片链路有问题」彻底分开。
  ⚠️ 判据**只看基线**：基线通过后任何失败都算真失败，不许「一失败就跳过」
  （那就成了静默空测，比误报更糟）。
- ⚠️ **「失败就回退到旧行为」的兜底会把接线错误伪装成产品缺陷**（本轮真踩到）：
  e2e 里把 `makeScaleBridge(fixture)`（`{bridge, stats}` 包装对象）误当函数注入
  `readImageRequest`，适配器一调用就抛错，`projectRequestImage` 的 `try/catch`
  把异常兜成「回退原图」→ 症状是「**缩放后照样 413**」，看着像字节目标定小了，
  实际是**根本没缩放**，白跑一轮 90 秒真机探测并得出错误结论。
  ⇒ 探针必须先断言 `stats.length > 0`（缩放真被调用），再断言结果。

### ⚠️ 待观察：`cline-auth.spec.ts` 的一次无法复现的失败（别忽略，也别当成已修）

本轮某次 `pnpm test` 出现过 2 条失败，都在
`tests/unit/cline-auth.spec.ts > ClineAuth refreshAll`：

- 「只按 refreshable 过滤，**不看 enabled**」
- 「按需续期（账号卡片「刷新」）成功后把新 expiresAt 写回账号池」

**当时的现场**：同一轮我正在并发跑真机图片 e2e（长跑、重负载）。
**之后的验证**：单独跑该文件 26 条全过；全量连跑 3 次均 2833 全过；
`--no-file-parallelism` 连跑 5 次全过。**未能复现**。

**已排除的解释**（都查过，不成立）：
- 不是本轮改动引起 —— `git status` 显示未触碰 `cline-auth.ts` 及其 spec；
- 不是「5 分钟凭据到期」—— `shouldRefreshNow` 对 `now+300_000` 恒为「该刷」，
  该值不会随墙钟翻转；且 `isClineRefreshable` 只看 `refresh_token` 存在性；
- 不是文件系统/环境依赖 —— 该用例用全内存 `Context` + `FakeCredentials`
  + `AccountPool`（`store.kind === 'memory'`）；
- 不是 `services` 数组泄漏 —— 已有 `afterEach` 的 `splice(0)` 清理。

**下次复现时要看的东西**（别再从零猜）：
① 失败时 `fetcher` 的**实际调用次数**（期望 2，推测会得到 0）；
② 两条失败是否**同时**出现（若是，指向 `refreshAll` 早退而非断言问题）；
③ `pool.listAccounts('cline')` 返回的条目数；
④ 当时是否在并发跑 e2e —— 若只在重负载下出现，方向是**测试的时序假设**
   而非产品逻辑（该 spec 的 `AccountPool` 用 `void credentials.set(...)`
   预热，见 `makeCtx`，这是目前唯一可疑但未证实的点）。

⚠️ **不要因为"跑几次都过"就删掉这条记录**，也不要假装修好了 ——
它可能是重负载下才暴露的真实竞态，记着现场比假装干净更有价值。
  ⚠️ 且**不能强制续期才肯用**（第一版的 bug）：刚登录的新号续期反被拒，
  于是被跳过，最后落到一个签名有效但额度耗尽的旧号上。判据是
  「**先看是否过期**，未过期直接用；再用一次无图请求验号」。
- **张数必须互不相同的 `attachmentId`**：`collectImages` 按 id 去重，
  复用同一 id 会把 15 张压成 1 张，探针「顺利跑完」却一点压力没造出来。

⚠️ **未实现 `imageRequestPricing`**（issue 建议的第 4 步，仍然不做）：
它需要「网关每张图的视觉 token 计价公式」，而我们**只有从失败点反推的
≈617 px/token**（buddy 15 张撞 100,000 时估算 99,579，差 0.4% —— 已足够
用来定预算，但**不足以**用来喂压缩器：猜错方向会让压缩过早或过晚触发）。
缩放已让 15 张从 100,038 降到约 46,903，触发条件本身消失了。
⚠️ 顺带记一条已核实的机制：不实现它时 `dsh-token-meter` 对图片走
`estimateStructuralBlock`（**只按引用 JSON 的字符数**计价，一张大图 ≈56 token），
而压缩阈值是 `min(contextWindow×0.8, …)` = 800,000 —— 所以「图片压力」
在 token meter 眼里几乎不可见，**指望自动压缩兜底是不成立的**
（这正是报障会话里"压缩试了 3 次全失败"的机制解释）。

测试：`tests/unit/image-budget.spec.ts`（29 条：几何含"小图不放大/细长图/非法输入"、
四种回退路径、产品级预算、三条分类护栏、`projectRequestImage` 共用投影、
raccoon 用**自己的** 512 KB 而非 buddy 的 2 MiB、**七处接线断言**）。
⚠️ 已做**反向验证**：去掉 cline 缩放 → 接线断言变红（报「未走共享投影」）；
去掉新增分类判据 → 1 条变红（报 `expected 'INVALID_REQUEST' to be
'CONTEXT_WINDOW_EXCEEDED'`，非同义反复）。
e2e：`tests/e2e/image-burst-cross-provider.e2e.spec.ts`（跨家探测 + 腾讯两站的
复现/修复/可辨认性验证），**消耗真实积分**；闸门与 fixture 说明见
`tests/e2e/README.md`。
⚠️ 曾有一个 `image-request-probe.e2e.spec.ts` 专测腾讯系，已**并入**上面那个文件 ——
它的 fixture 加载、YAML 凭据解析、缩放桥接与张数序列与后者**完全重复**
（两份实现必然漂移，是本仓库反复告诫的形状），而它两条独特断言
（buddy 的 `CONTEXT_WINDOW_EXCEEDED` 归类、缩放后仍可辨认）都已搬过去，
且现在两站都覆盖（原来只测 buddy，**workbuddy 从未被端到端验证过**）。

## 单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤

腾讯系两个端点（scoped `/console/enterprises/personal/models` 与 `/v3/config`）
**都下发 `data.models[].maxOutputTokens`**。它是权威的单次请求输出额度，适配器
**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`（DSH 只在调用方未显式给值时用声明的默认值兜底）。

**真实缺陷**（用户报障）：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被
截断，`turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。
根因不是「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当作
`isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关
默认值，而网关默认恰好就是 **32000**（远端 `auto` / `glm-4.6` 等声明的即为此值）。
远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。

要点：

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值（编大被上游拒、编小无谓截断）
- ⚠️ **远端是外部输入，非法值必须过滤**：`positiveMaxTokens` 只放行安全正整数。
  DSH 对 `defaultMaxTokens` 有硬校验，`0` / 负数 / `NaN` 会直接抛
  `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）
- 实测（2026-09-19）各端点值不完全一致：`deepseek-v4.1-flash` 在 scoped 端点
  为 128000、`/v3/config` 为 131072。与 `maxInputTokens` 同策略 —— 采信实际
  命中的那个端点，**不做跨端点取大**
- 网关**确实接受且精确生效**：`max_tokens: 64` 会精确截断在 64
  （`finish_reason=length`、`completion_tokens=64`）。验证脚本
  `scripts/verify-max-tokens.mjs`（用国际版限免的 v4.1-flash，`credit: 0`）
- `reasoning_tokens` **计入** `completion_tokens`：思考内容与正文共享同一额度，
  故思考开到 `max` 时正文更早撞上限。「单次请求」≠「单轮」——每 step 独立预算，
  超长文件仍需拆多步写
- 排查脚本（均为**只读 GET**，零模型额度）：`scripts/dump-max-output.mjs`
  导出全模型 `id → maxOutputTokens`；`scripts/probe-max-output.mjs` 打印原始条目

## ⚠️ 持久化：DSH 0.1.7 移除 `settings.register()` 之后（Issue IKI7WT）

**真实缺陷**：升级到 DSH **0.1.7-rc.1** 后，Jet Hub 的**账号列表与模型黑名单
无法持久化**（重启即回到空列表，等于所有 provider 都"未登录"，模型目录也因
门控被隐藏）。

**根因**：0.1.7 把 `ctx.settings` 从 `SettingsProvider` 换成 **`SettingsForms`**：

| | ≤0.1.6 | 0.1.7-rc.1 |
|---|---|---|
| 注册方式 | `settings.register(ns, schema)` → owner scope（`get`/`replace`） | **没有 `register`**；命名空间 = **profile 条目 id** |
| 可见字段 | 该 namespace 的全部字段 | 只投影本条目 Config 中标了 **`.volatile()`** 的字段 |
| 写入路径 | provider 文档（旧 `settings.yaml`） | `update/replace/mutate` → profile 的 `cordis.patch.yml` |

因此 `if (typeof settings.register !== 'function')` 这条**看似安全的降级分支**
恒成立：账号池退化为纯内存。启动日志实证
`[jet-hub] settings 服务不可用，账号列表仅存在于内存中`（旧文案有误导性，
实际是"API 没了"而不是"服务没挂"）。

**修法**（`src/jet-hub-store.ts` + `src/settings-compat.ts`）：

- 持久化后端按**能力探测**：`settings.register` 可用 → 沿用老契约（数据仍在
  settings 文档，行为与 ≤0.1.6 完全一致）；否则 → 插件自有文档
  **`$DSH_HOME/jet-hub/state.json`**（同步读 + 原子写 tmp+rename）。
- ⚠️ **不要把这类运行时状态塞进插件 Config 的 volatile 字段**：限流每命中一次
  就要写一次，而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader
  协调 —— 把易变数据混进用户手写的配置层，代价与风险都不划算。
- **`settingsNs` 必须跟着改**：0.1.7 起它只能是 profile 条目 id，故
  `settingsNamespaceFor(ctx, 'llm-<id>')` 解析为**本插件条目 id**
  （官方适配器同做法：`ctx.fiber.entry?.options.id`）。拿不到条目 id 时退回旧名，
  此时该 provider 在模型设置页显示为「未配置」，**不影响路由与收发**。
- **必须导出带 `.volatile()` 字段的 `Config`**：`SettingsForms.describe()` 只收录
  「有 volatile 字段」的条目，否则模型设置页把本插件的 provider 判为既非
  "已配置"也非"可添加"。本插件自带 Jet Hub 页面，故同时调
  `settings.configure({ auto: false }, ctx.fiber)` 关掉自动生成的表单。
- ⚠️ **`.volatile()` 需要 schemastery ≥ 3.18.4**（本地曾是 3.18.2，只有
  3.18.4 才有该方法）；且 `volatile()` 会把 cosmokit 的 `Volatile<T>` 带进
  `Config` 的公开类型，故 `@deepseek-ai/cosmokit` 必须是本包依赖，否则
  `tsc` 报 TS2742。

**老数据恢复**（0.1.7 把 `$DSH_HOME/settings.yaml` 改名为 `.imported`，并按
「section id = 条目 id」导入；`jet-hub` 不对应任何条目 → 该段**导入失败、成为
孤儿**）：

- 插件在状态文档**缺失**时，会从 `.credentials.yaml` 的 `refs:` 反推账号
  （只读键名，不引 YAML 依赖 —— 运行时不保证能解析 `yaml`/`js-yaml`）。
  这是**保底**：能还原"有哪些账号/用哪个 credentialRef"，
  但**拿不回昵称、顺序、enabled 与限流标记**。
- 精确还原用一次性脚本 `scripts/import-jet-hub-legacy-settings.mjs`
  （默认**预演**，`--write` 才落盘）：直接解析旧文档的 `jet-hub` 段，
  保留昵称/顺序/enabled/限流与黑名单；有任何条目缺
  `id`/`provider`/`credentialRef` 就整体拒绝写入（不导入半截数据）。
  ⚠️ 模型 id 含 `.` 与 `-`（如 `deepseek-v4.1-flash`），字段正则必须放行，
  早期写成 `[\w]*` 会让限流标记**静默全丢**。
- 排查脚本：`scripts/verify-jet-hub-persistence.mjs`（用**已构建 lib/** 以 0.1.7
  契约验证落盘与跨实例读回）、`scripts/preview-jet-hub-recovery.mjs`
  （只读预演凭据反推）。回归用例：`tests/unit/jet-hub-store.spec.ts`、
  `tests/unit/account-pool.spec.ts`（「0.1.7 契约」段）。
- ⚠️ 单测必须隔离状态目录：`vitest.config.ts` 把 `DSH_JET_HUB_STATE_DIR`
  指向一次性临时目录，否则文件后端会污染真实 `~/.dsh`。

## ⚠️ 「锁定永久积分」三家**共用一张表与一个端点**，但判据必须各算

**用户需求**：为 codebuddy 与 workbuddy 加入永久积分锁定，类似 loomy 的锁定/解锁
永久积分；差别是 loomy 的到期积分是**当日**到期，两个 buddy 的到期是**一个月或更久**，
且「区分永久积分的方法可能稍有差异」。

**用户 2026-09-29 定下的四条口径**（不要擅自改）：

| 项 | 规则 |
|---|---|
| 判据 | 距**扣费截止**不足 **15 天** ⇒ 临时（优先烧）；≥ 15 天 ⇒ 永久 |
| 余额口径 | `CycleCapacityRemain`（本计费周期剩余，= IDE 顶部 `Credits Balance` 口径） |
| 开关粒度 | **provider 级**（CodeBuddy 与 WorkBuddy 各一份，互不影响） |
| 选号策略 | 与 loomy 同构：有临时积分的号优先 → 只剩永久 → 无/查不到；**档内保持手动顺序** |

### 区分永久积分**只能看 `DeductionEndTime`**（实测 2026-09-29，两站真实账号）

| 包 | `ExpiredTime` | `CycleEndTime` | **`DeductionEndTime`** | 归入 |
|---|---|---|---|---|
| WorkBuddy「Bonus Pack」 | `''` | 9 天后 | **9 天后** | 临时 |
| WorkBuddy「Free Plan Subscription」 | `''` | **2 天后** | **3008 天后** | 永久 |
| CodeBuddy「个人体验版」 | `''` | 已过期 | 3008 天后 | 永久（本周期已无余额） |
| CodeBuddy「拉新权益包 / 国内运营裂变包」 | `''` | 同下 | **17～208 天后** | ≥15 天者永久 |

⚠️ **三个看着像判据、其实都不能用的字段**（每一条都足以让功能静默失效）：

- **`ExpiredTime` 没有区分力**：有效包**一律是空串** —— 它是包**真正失效之后**
  由服务端回填的动作时间（此时 `Status` 已变 3、余额已归零），不是「预定失效时间」。
  既有的 `parseCreditPackage` 本来就把它用于失效判定，但**不能**反过来用它分池。
- **`CycleEndTime` 会把套餐误判成「马上作废」**：订阅包的计量周期是月度的
  （WorkBuddy Free Plan：周期 9-01→9-30，只剩 2 天），而扣费截止在 8 年后。
  用它 ⇒ 套餐被划进临时桶 ⇒ 锁定**形同虚设**（该保的照烧）。
- **终身口径 `CapacityRemain` 会虚增可用额度**：实测体验版**终身**剩 500 而
  **本周期**剩 0，那 500 实际扣不到（`TotalCycles=1 / RemainCycles=0`，周期不刷新）。
  用它 ⇒ 账号「看起来有钱却用不了」，锁定期间的可用判定也会错。

⇒ 实现：`CreditPackage` 新增**可选** `deductionEndTime?: number`（由
`parseCreditPackage` 从 `DeductionEndTime` 带出；`> 0` 才写，缺失 = 未知），
`splitBuddyCreditsByExpiry()` 据此现算两桶。顺带把「扣费截止已过」并入 `active`
失效判定（实测有效包的该字段都在未来，故这条只会捞出真正作废的包）。

⚠️ **到期时间未知（缺失 / 0 / NaN）归入永久桶**：保守方向 —— 最坏是少用一个号，
而不是把长期积分当快到期烧掉（不可逆损失）。

### 为什么不复用 loomy 那份（`loomy-balance-rank.ts`）

loomy 的两个池是**服务端直接给的字段**（`dailyBalance` / `balance`），buddy 要
**从包列表按到期时间现算**。压成一份代码得把「什么叫临时」参数化成回调，
那会让本文件最有价值的东西（**15 天这条线怎么来的**）从注释里消失。
⇒ 新增 `src/buddy-balance-rank.ts` + `src/buddy-balance-selector.ts`，
**同构但独立**；两站各持一个 selector 实例（余额缓存不串味）。

### ⚠️ 锁定表必须住**独立文档**，不能住 `state.json`（同机多 profile 会抹掉它）

**用户 2026-09-29 定案**（我先放错位置，被这条真实约束纠正）。

关键事实：`$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、同机多 profile 共享**的
（`resolveJetHubHome` 只看 home，不看 profile），而本机现状是两个工作区并存 ——
`desktop` profile link 到 `dsh-codearts`（本仓库，带锁定功能），
`web` / `tui` / `headless` profile link 到 `deepseek-harness-codearts`
（另一条 minimax 工作区，**不认识锁定表**）。用户刻意让它们互不影响。

于是把 `permanentLocks` 放进 state.json 会这样失效：

| 步骤 | 发生什么 |
|---|---|
| 1 | desktop 写入 `permanentLocks: { buddy: true }` |
| 2 | 用户在 web 侧触发**任意一次**整体写入（加删账号 / 改模型开关 / 命中限流标记） |
| 3 | 旧代码 `store.save(全量 state)` 只带它认识的三个键 ⇒ `permanentLocks` **被抹掉** |
| 4 | desktop 读回 ⇒ CodeBuddy / WorkBuddy **静默解锁** ⇒ 继续消耗永久积分（**不可撤回**） |

⇒ 表落在 **`$DSH_HOME/jet-hub/permanent-locks.json`**（`src/permanent-lock-store.ts`），
旧代码从不读写它。**新增任何"跨版本共存"的字段时都要过一遍这个判断**：
共享文档 + 整体替换语义 ⇒ 只有对方也认识的字段才安全。

- ⚠️ `state.json` 里仍写 `loomyPermanentLocked`，但它是**镜像**不是权威：
  旧代码读它、也原样写回它，保持一致才能让另一侧的 Loomy 面板不显示错值，
  且回退版本时不会"锁定悄悄失效"。由 `AccountPool.lockFields()` 同源写出。
- ⚠️ **迁移判据必须是「独立文档不存在」**（`load()` 返回 `exists: false`），
  不能是「表里缺该键」。缺键的语义是**用户明确解锁了**；此时若回看镜像里那个
  陈旧的 `true`，就会出现**解不掉的开关**（比丢状态更难排查）。
  迁移出的内容要**立即固化**，否则每次冷启动都重新读那个会被改动的镜像。
- ⚠️ 文档损坏时按「存在但空表」处理，**不**回落到镜像 —— 同上理由。
- ⚠️ 写入顺序：**先权威、再镜像**；镜像失败只 warn 不上抛（否则一次 settings
  后端抖动会让面板按钮报错，而开关其实已生效）。
- ⚠️ 解锁是**删键**而不是写 `false`（与黑名单同款约定：只认显式 `true`）。
- ⚠️ **备份**：表不在 `getStateSnapshot()` 里了，导出必须走
  `permanentLocksSnapshot()`（漏改 = 备份里的锁定永远是空表）。导入侧
  `locksFromPayload()` 三态仍需分清：有表 = 整体替换；只有老字段 = 恢复/解锁
  Loomy 那一项（`false` 是**明确的**不锁，传 `{}`）；两者都没有 = 传
  `undefined` 让池**保持当前值**（否则导入老备份会静默解锁）。
- ⚠️ **测试必须隔离 home**：`vitest.config.ts` 已全局设
  `DSH_JET_HUB_STATE_DIR` 到临时目录，但**用例间的清理钩子要注册在模块顶层** ——
  本文件有多个**平级**的顶层 `describe`，钩子挂在某个 describe 内部时其余
  describe 拿不到，于是 `permanent-locks.json` 在用例间残留，"默认未锁定"
  会被前一条用例写入的值污染（实测踩过：9 条莫名失败）。

**怎么复核这条风险是真的**（不是推演）：`scripts/probe-cross-profile-overwrite.mjs`
（本地、零网络）用**另一条工作区的真实编译产物**当"旧代码"跑一次 `addAccount`，
实测：塞在 `state.json` 里的表**被抹掉**，而 `permanent-locks.json` 里的
`buddy` / `workbuddy` / `loomy` 三把锁全部健在。自动触发条件也不是"用户主动加账号"：
旧代码有 **每 30 分钟的续期定时器**（`REFRESH_INTERVAL_MS`）与 8 处
`updateModelRateLimit` 调用（一次对话命中限流即写）；且覆盖是**整份文档级、不分
provider** —— web 侧 qoder / trae / loomy 等账号被写一次，同样会抹掉 desktop 侧
给 CodeBuddy 上的锁。

### ⚠️ 分类是时间的函数：**缓存原料，绝不缓存分类结果**

**用户 2026-09-29 提出**：dsh 宿主长期开着，时间向前流动 —— 现在不是临时积分的包，
过一阵（距扣费截止跌破 15 天）就变成临时积分。所以分类**不能算一次就固定**。

⇒ 两处都按「只缓存原料」实现：

| 位置 | 缓存什么 | 每次做什么 |
|---|---|---|
| `BuddyBalanceSelector`（选号） | `get-user-resource` 的**原始 `CreditBalance`**，TTL 60 秒 | 命中缓存也调 `classify()` 重新分桶 + 定档，并**重读窗口 env** |
| `CreditBalanceRow`（面板） | 不缓存分类 | 每次渲染传 `Date.now()` 现算（`splitCreditsByExpiry` 是纯函数） |

⚠️ **TTL 的唯一职责是抑制网络请求**，绝不能顺手把 `split` / `tier` 一起缓存住。
一笔距到期 15 天 + 30 秒的余额，在 60 秒 TTL 内就越过了线 —— 冻结分类会让选号
继续按「永久」处理一笔其实马上作废的积分（锁定时更糟：本该可用的号被判成不可用）。
⇒ `balanceOf` 拆成 `fetchSource()`（网络，缓存）+ `classify()`（纯计算，每次做）。

⚠️ **Loomy 那份（`loomy-balance-selector.ts`）缓存的是服务端给的两个数字**
（`dailyBalance` / `balance`），里面不含「按 now 现算」的成分，所以它没有这个问题
—— **不是漏改，不要"顺手统一"**。

⚠️ 前端**不需要常驻定时器**：渲染节拍由「挂载 / 切 provider / 点刷新积分」提供，
而数字本身也正是这些时刻才重拉。分类只是渲染时现算的派生值，页面活着就自动跟上。

### ⚠️ 展示与选号的判据必须**逐条一致**（用对账用例锁，不是靠"看起来一样"）

前端 `plugin-src/client/credit-expiry.js` 是后端 `src/buddy-balance-rank.ts`
`splitBuddyCreditsByExpiry()` 的**展示侧复刻**。两者一旦漂移，用户就会看到
「面板说还有 250 临时积分，选号却说没号可用」——**任何单侧用例都发现不了**。

⇒ `tests/unit/credit-expiry.spec.ts` 用同一组 fixture（含恰好 15 天的边界、
失效包、到期未知、脏值、浮点尾数、时间前进 40 秒越线）喂两侧并断言结果相同。
⚠️ 已做**反向验证**：把前端边界从 `<` 改成 `<=` → 2 条变红（其中 1 条正是对账）。

⚠️ 窗口天数只能**由后端回传**（`credits.balances` 与 `credits.permanentLock` 都带
`windowDays`，前端存进同一个 state），不能在前端写死 15 —— 否则用户设了
`DSH_BUDDY_EXPIRING_WINDOW_DAYS=31` 后，面板说「只烧 15 天内的」而实际按 31 天筛号。

⚠️ 前端归一化窗口要显式挡 `null`/`undefined`：`Number(null) === 0`，而**非 buddy
provider 后端不带该字段**，不挡住就会在它们的卡片上凭空渲染一行假的
「临时 0 · 永久 N」。窗口实际恒为 15（或经 env 放宽），不存在"设成 0"的用法。

⚠️ tooltip 的到期天数取 `deductionEndTime`，**不是 `cycleEndTime`**：套餐的计量
周期是月度的（月底清零），拿它显示会让用户以为"永久积分只剩 2 天"。

### RPC：一条实现 + 一个历史别名

`credits.permanentLock { provider, locked? }`（`locked` 省略 = 只读）。
`loomy.permanentLock` 保留为**别名**（老客户端 bundle 仍调它，删了会让 Loomy
面板按钮静默失效），且该别名**忽略载荷里的 provider**（固定 loomy，否则老前端
能借它越权改别的 provider）。白名单 `PERMANENT_LOCK_PROVIDERS`
= `{loomy, buddy, workbuddy}`，与前端 `supportsPermanentLock` **必须一致** ——
单测 `credits-capabilities.spec.ts` 逐个 provider 对账两边。

⚠️ **不要**为每个 provider 各加一条 case：本仓库已经因此坏过
（「WorkBuddy 的刷新按钮一直坏着」就是漏接平行分支）。

### ⚠️ 文案必须按 provider 取，且**天数由后端回传**

- `permanentLockCopy(provider, windowDays)`：loomy 说「每日赠送额度」，
  两个 buddy 说「N 天内到期的积分包」。把 loomy 那句套到 buddy 上是**实质性误导**
  —— buddy 没有每天刷新的额度池（签到得来的也是 14/30 天后到期的包）。
- ⚠️ 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，故响应带 `windowDays`
  回传、前端据此渲染。写死 15 会出现「提示说只烧 15 天、实际按 31 天筛号」。
- ⚠️ 前端归一化要区分 `null/undefined`（回落默认，**不能**当 0 ——
  `Number(null) === 0`）与数字 `0`（合法，语义是「没有临时积分」）。
  写 `|| 默认值` 会吞掉 0，与 Qoder 排队超时那条同一个坑。

### ⚠️ 中国版在默认窗口下的必然结果（**不是缺陷**，但要说清）

实测 CodeBuddy 中国版账号的赠送包**按 30 天发放**，「距到期」天然落在 17～30 天
⇒ 默认 15 天下**整池 10064 积分全算永久** ⇒ 锁上立刻「无可用账号」。
这是用户定的判据的直接推论。逃生门：`DSH_BUDDY_EXPIRING_WINDOW_DAYS=31`
（实测改后 6264.61 划为临时、3799.99 仍永久，锁定可正常选号）。
报错文案用 `buddyExpiringWindowDays()` **运行时解析**，不写死常量。

### ⚠️ 锁定时绝不可落到 `getAvailableAccount` 兜底

`pickBuddyAccount()` 返回 `kind:'locked'` 时 `index.ts` 必须**抛明确错误**
（告诉用户去哪个面板解锁）。落到既有的池兜底会绕过锁定、照样消耗永久积分，
使锁定形同虚设 —— loomy 当初就是这条，单测里也专门钉住「编排函数体内不出现
`getAvailableAccount`」。未锁定时的 `exhausted`（凭据都坏了）才允许兜底，
且必须把 `tried` 传给 `getAvailableAccount` 的排除集合，否则会原地打转。

### 回归用例

- `tests/unit/buddy-balance-rank.spec.ts`（37 条）：窗口边界（14d / 恰好 15d /
  差 1ms）、失效包跳过、到期未知归永久、本周期口径、锁定降档、稳定排序、
  环境变量解析（含 **0 合法**）、脏值。
- `tests/unit/buddy-balance-selector.spec.ts`（25 条）：TTL 缓存与 invalidate、
  凭据失败/异常/null 三种失败形态、锁定不被选中、解锁保持既有行为、
  编排换号循环、`locked` vs `exhausted`、env 窗口生效。
- `tests/unit/credits.spec.ts` 的「DeductionEndTime 解析」段（5 条）：带出毫秒、
  缺失不编造、过期判 `active:false`、脏值。
- `tests/unit/jet-hub-store.spec.ts` / `account-pool.spec.ts`：表与老字段同源、
  三处整体写入不互相抹掉、跨实例读回、脏表按空、replaceAll 三态。
- `tests/unit/buddy-permanent-lock.spec.ts`（12 条）：`index.ts` **接线**源码断言
  （两个 selector 各绑自己的 product、候选先过滤再分档、锁定分支不兜底、
  兜底传 `tried`）+ 行为级「两站不串味」。
- `tests/unit/loomy-client.spec.ts` / `loomy-rpc-dispatch.spec.ts` /
  `credits-capabilities.spec.ts`：通用端点 + 别名、provider 白名单两边对账、
  文案带 windowDays。
- ⚠️ 已做**反向验证**：阈值改 7 天 ⇒ 9 条变红；去掉锁定降档那一行 ⇒ 6 条变红；
  把 `locked` 的 throw 改成兜底 ⇒ 接线用例变红。
- 排查脚本（只读、零额度、**不入库**）：`scripts/probe-buddy-resource-raw.mts`
  （打印两站资源包原始形状与到期分布，判据的取证来源）、
  `scripts/probe-buddy-permanent-lock.mts`（用真实凭据跑一遍拆分与选号，
  可加 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 看放宽窗口的效果）。

## 积分领取（每日签到）

### ⚠️ 默认实现的签名必须**显式适配**，不能用 `as unknown as` 硬转

**真实缺陷**（用户报障）：CodeBuddy 一键领取 4 个账号**全部失败**，错误是
**`fetcher is not a function`**。

根因：`claimDailyCheckin` / `fetchCheckinStatus` / `fetchCreditBalance` 的真实
签名是 **`(credential, product, fetcher)`**，而 `CreditsEndpointDeps` 把 `claim`
声明为 `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
`collectClaimResults` 里历史写法是

```ts
const claim = deps.claim ?? (claimDailyCheckin as unknown as NonNullable<…>)
```

那个 `as unknown as` 把签名不匹配**压了过去** —— TypeScript 不再报错，但调用点
`claim(credential, product, entry)` 的第三个实参是 `entry`，它落进 **`fetcher`
的位置**，运行时 `fetcher(...)` 就抛 `TypeError: fetcher is not a function`。

修法：**显式包装**默认实现，把 `deps.fetcher`（或全局 `fetch`）送进第三参
（`CreditsEndpointDeps.fetcher`）。**加新的默认实现时必须照此办理** ——
一旦用 `as unknown as` 掩盖签名差异，就会重演这个 bug。

⚠️ **为什么长期没被发现**：`makeDeps()` **总是注入 `claim` / `fetchStatus`**，
于是真实的默认实现路径**从未被任何用例覆盖**。回归用例
（`jet-hub-rpc.spec.ts` 的「第三参必须是 fetcher」）刻意**不注入** deps，
走真实默认实现并断言请求真的发出去了。

⚠️ 只有 **buddy / workbuddy** 走这条默认路径（其余三个 provider 都在自己的分支里
显式注入 `claim`），所以故障面恰好是 CodeBuddy 系。

**五套协议完全不同**的实现，各自独立：

**Qoder** —— `src/qoder-credits.ts`（2026-09-21 由 keylog 解密抓包解出）：

- 状态查询：`GET /sash/api/v1/me/campaigns`
  （**必需 Bearer + `Cosy-ClientType:'10'` + `Cosy-MachineToken`/`Cosy-MachineType` 成对**；
  ⚠️ 少了 machine 头只会拿到 1 条 `VIEW_DETAILS`，**看不到可领活动** —— 见上「Qoder 每日领取」）
- 领取：`POST /sash/api/v1/me/campaigns/{campaignId}/claim`（**body 空**）
- 幂等：重复领取返回 **HTTP 200 + `replayed:true`**（且不含 `benefit`、
  `claimedAt` 是旧时间）—— 判定**以响应体 `replayed` 为准**，不能只看 HTTP 状态
- 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`
- 活动每日 10:00（UTC+8）刷新，领取后 30 天有效

**CodeBuddy** —— `src/credits.ts`（国际版 WorkBuddy 后端无签到接口）：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`（「今天已签到」），判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖

**LobsterAI** —— `src/lobsterai-credits.ts`（三步，见 `lobsterai2api/sigin.py`）：

- 槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`
- 幂等是**客户端**保证的：请求带 `idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`
- `clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`
- `platform=win32` 等参数是**客户端形态伪装**，非 Windows 上也照发

**CodeArts** —— `src/codearts-credits.ts`（四步，华为云「每日签到得积分」）：

- 账户类型 `GET /snap-manager/v1/statistics/plugin` → 活动列表 `GET /v1/ops/delivery?channel=IDE` → 领取 `POST /v1/ops/claim` `{campaignId, channel:'IDE'}` →（响应 `id !== null` 时）确认 `POST /v1/ops/confirm` `{campaignId}`
- **认证是 `SDK-HMAC-SHA256` 签名**（复用 `src/sign.ts`），base = `https://snap-access.cn-north-4.myhuaweicloud.com`（与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` **同域**）
- ⚠️ **`Agent-Type` / `X-Language` 必须在签名之后追加，绝不能参与签名**。实测把它们作为 `signRequestHuawei` 的 `extraHeaders` 传入（进入 canonical request 与 SignedHeaders）会得到 `401 APIG.0301 verify ak sk signature fail`；签名后追加则 200 并返回真实数据。正确做法与 `src/models.ts` 的 `fetchSignedGet` 一致（其参数注释写明「签名后追加的头（不参与签名计算）」）。**真实缺陷**：本模块早期误当作签名头，界面显示「积分：账户信息查询失败」。⚠️ 注意 `src/llm-adapter.ts` 的 `maas_type: benefit` 是**反例**——那个头确实需要参与签名，不要据此推断
- ⚠️ **非 2xx 必须带出服务端 `error_code` / `error_msg`**（`describeHttpFailure`）：只报 `HTTP 401` 会让「签名头位置错」「AK 限流（`AK access failed to reach the limit`）」「凭据过期」这些处置方式完全不同的问题看起来一模一样
- ⚠️ **官方文档给的 portal 路径不可用**：`codearts.huaweicloud.com/portal/...` 是 BFF 接口、依赖浏览器 Cookie，实测带 AK/SK 签名也只会返回 IAM 登录跳转 HTML。协议逆向自本机码道 IDE（`out/main.js` 的 `PackageInfoService`、workbench 的 `ActivityWelfarePane`）
- **账户类型检测**：`package.is_credit_package === true` 即积分账户（文档要求「已升级到积分计费模式」）。领取第一步就判它，非积分账户回 `inactive` 而非 `failed`
- **幂等**：本协议无幂等键、无「今天已签到」业务码，唯一保护是活动列表的 `claimable` / `status` 预检（`status` ∈ {CLAIMED, CONFIRMED, CONSUMED} → `already-claimed`）
- ⚠️ **`refresh_token` 一次性轮换**：用一次即作废（`STS5.1806 the refresh token has been used`）。任何刷新都必须**立刻回写**新凭据；E2E 凭据读取（`tests/e2e/codearts-credential.ts`）**只读不刷新**
- `statistics/plugin` 是**裸对象**响应（无 `{code,data}` 包装），而 `ops/*` 有 —— 解析必须兼容两种信封
- ⚠️ **`/v1/ops/delivery` 的字段类型/名字与直觉不符**（实测 2026-09-18，两个坑叠加导致「1 个失败」）：
  - **`campaignId` 是数字**（`1`），不是字符串 → 必须用 `readIdentifier`（兼容数字/字符串），用只收字符串的 `readString` 会得到空串并判 `failed`「活动缺少 campaignId」
  - **可领积分字段是 `benefitAmount`**（`1000`），不是 `amount` → 读错会恒为 0
  - 不可领取的活动 `status` 是 **`null`**（不是字符串），`readString` 要能容忍
  - 完整真实 item 字段：`campaignId` / `title` / `type` / `benefitAmount` / `benefitUnit` / `displayConfig` / `pageUrl` / `claimable` / `hooks` / `extra` / `description` / `status` / `pendingCount` / `pendingTotalAmount`
- ⚠️ **单测必须用真实响应形状**：早期用例喂的是**编造的** `campaignId: 'c-1'` 与 `amount: 1000`，因此完全没抓到上面那个 bug。新用例直接用实测字段集合

**TRAE** —— `src/trae-credits.ts`（两步，字节 TRAE；详见上「TRAE 签到」小节）：

- 状态查询 `POST /trae/api/v2/ug/checkin_credits/status`（body `{}`，读 `checked_in` / `credits` / `enable`）
- 领取 `POST /trae/api/v2/ug/checkin_credits/claim`（body **`{}`**）
- 认证走 **`traeCheckinHeaders`**（`Cloud-IDE-JWT` + 约 20 个客户端头 + **基于 `uid` 派生**的
  `X-Device-Id` / `X-Market-User-Id` / `Vscode-Sessionid`），**不带** SOLO 专属头
  （`X-Ide-Version` / `X-Machine-Id` 等）
- ⚠️ 设备身份**每个账号必须互异**（由 `uid` 确定性派生保证）：同一天两账号共用会被
  「该设备已签到」拦截；为空则报 9004
- 幂等：重复领取返回非零业务码（实测 `9074` 为「签到人数过多」），判定以响应体 `code` 为准
- 失败时经 `classifyTraeCheckinError` 带上 `errorType` / `cooldownSecs`（见上小节的分类表）

四套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 两套协议共用

**积分余额（Credits Balance）** 也是**四套端点**，但语义一致（「查不到」与「余额为 0」严格区分）：

**CodeBuddy 系（buddy / workbuddy）** —— `POST /v2/billing/meter/get-user-resource`：

- body `{}`；响应**双层嵌套**：`data.Response.Data.Accounts[]`（签到是单层 `data`，此处最易解析错）
- 总额用各包 `CapacityRemainPrecise` 相加（实测 247.87+100=347.87），**不用**截断过的 `TotalDosage`（347）
- 包名回退链：`PackageName` → `SubProductName` → `PackageCode`
- 该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），静态搜索找不到，靠真实凭据实测发现

**LobsterAI** —— `GET /api/user/profile-summary`：

- 取 `data.totalCreditsRemaining`
- **不要**用 `/api/user/quota`：它只有 `freeCreditsTotal=300`，不含活动积分

**CodeArts** —— `GET /snap-manager/v1/statistics/plugin`（与账户类型检测**同一响应**）：

- 取 `metrics[]` 中 `usageTotalPackageCredit` 的 `package_credit_remain`；**不累加**基础/按需/赠送分类明细（它们是总额的构成项，相加会重复计算）
- 非积分账户的文案是「Token 计费账户，无积分余额」而非「查询失败」——账户类型差异不是故障。实现走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因

**TRAE** —— `POST /trae/api/v2/pay/ide_user_ent_usage`（body **`{"require_usage": true, "req_source": 2}`**）：

- 响应 `user_entitlement_pack_list[]`，每项 `entitlement_base_info.quota.credits_limit` 为额度、`usage.credits_amount` 为已用
- 余额 = `∑(credits_limit - credits_amount)`；`credits_limit <= 0` 的条目跳过（与 Go 端 `EntUsage` 同口径）
- ⚠️ **必须带 `require_usage: true`**：不带时上游不返回 `usage` 明细，`credits_amount` 恒缺省为 0，余额会等于额度总额（虚高）。头同样走 `traeCheckinHeaders`

四者共同的约定：

- 累加后 `roundCredits` 规整两位小数（多包浮点噪声会放大成 655.67000031）
- 失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0
- RPC：`credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断：

| provider | `balance` | `dailyCheckin` |
|---|---|---|
| `codearts` | ✓ | ✓（华为云签名四步流程） |
| `buddy` | ✓ | ✓ |
| `workbuddy` | ✓ | ✗（国际版后端无签到接口） |
| `lobsterai` | ✓ | ✓（`client-activities` 三步流程） |
| `qoder` | ✓（`sash/api/v2/me/usage`，只需 Bearer） | ✓（`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`） |
| `trae` | ✓ | ✓（`checkin_credits` 两步流程） |

> ⚠️ `qoder` **必须显式登记**，不能省略：上面那条「能力矩阵与 `PROVIDERS` 条目集合相等」的断言要求两者同步，而 qoder 必然要进 `PROVIDERS`（否则面板不渲染）。
>
> ⚠️ **早期把 qoder 误判为两项皆无**（登记成 `balance:false`），根因有二，都值得记住：
> 1. **只按 `/api/` 前缀搜端点**，而余额挂在 **`/sash/`** 下 → 漏检；
> 2. **误以为用量端点也需要 WASM 签名** —— 实测只需 `Bearer` + `Cosy-ClientType`
>    （**活动端点还额外需要成对的 machine 头**，用量端点则不需要：
>    实测它对这两个头不敏感）。
>
> **余额与签到彼此独立**：不能因为「没有签到接口」就推断「也查不到余额」。

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，当时 CodeArts 无积分能力，面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障。**门控机制保留至今**，用于挡住真正未登记的 provider
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期 workbuddy 指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

⚠️ **一律用 `||` 而非 `??`**：domain 经 `readStringField`（`src/buddy.ts`）读取，
字段缺失/类型不符时它返回的是**空串而不是 `undefined`**，`??` 对空串不生效 →
`X-Domain` 以**空值**发出（服务端视作身份缺失，且日志里看不出原因）。
这是 PR!19 定位的共同根因（2026-09-30）。

**四处发 `X-Domain`，判据一致（空串必回退），但「兜底值取谁」按语境分工**：

| 位置 | 表达式 | 为什么 |
|---|---|---|
| `src/credits.ts` `checkinHeaders` | `product.apiDomain \|\| credential.domain \|\| ''` | 凭据 domain 是登录时快照 → **产品优先** |
| `src/buddy-adapter.ts` `send()`（chat 头） | `this.product.apiDomain \|\| credential.domain \|\| ''` | 同上：baseURL 取 `product.endpoint`，两者必须一致 |
| `src/buddy.ts` `credentialRequestHeaders` | `credential.domain \|\| API_DOMAIN` | **凭据级**基础头，调用方 `buddy-oauth.ts`（`refreshToken` / `fetchModels`）随后按产品覆盖 domain 与 UA，此处只需把空串兜回默认域 |
| `src/buddy-oauth.ts` `getAccount`（登录轮询） | `token.domain \|\| product.apiDomain` | 登录流程中该值是服务端**本次刚下发**的权威值（非历史快照）→ 非空时**不被产品覆盖**，只兜空串 |

⚠️ 四处**不是同一判据的四种写法，而是两种语境**（「凭据是历史快照」→ 产品优先；
「登录即时值权威」→ 服务端优先）。改其中任何一处前，先确认它属于哪种语境。
⚠️ 反向验证：把某处的 `||` 改回 `??`（`getAccount` 处改回裸 `token.domain`），
`tests/unit/buddy.spec.ts` / `buddy-adapter.spec.ts` / `buddy-oauth.spec.ts` 里
对应那条「空串」用例立刻变红 —— 故那些用例不是同义反复。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。

## ⚠️ 本机 OpenAI 网关：两个协议端点**同时可用**，不要做「格式开关」（2026-10-03）

出口在 `src/openai-gateway/`，对外两个端点：

```text
POST /v1/chat/completions   ← OpenAI Chat Completions（`server.ts` + `messages.ts` + `stream.ts`）
POST /v1/responses          ← OpenAI Responses API（`responses.ts`）
GET  /v1/models             ← 两套协议共用同一份目录
```

⚠️ **用户 2026-10-03 的决定：加 Responses API，但明确否掉了「格式切换开关」** ——
两个端点**始终都在**，客户端用哪套协议由它请求的 URL 决定。互斥开关只会让「另一个
协议的客户端在切换后突然失效」，而网关侧面本来就没有互斥的理由。

⚠️ **凡是两套协议共有的东西，只允许有一份实现**（各写一份必然漂移，且漂移的症状是
「同一件事在 /v1/chat/completions 对、在 /v1/responses 错」这种极难归因的差异）：

| 关注点 | 唯一实现 | 谁在用 |
|---|---|---|
| 图片入站（data URL → 附件 → `ImageBlock`） | `messages.ts` 的 `partsFromContent` | 两个端点（Responses 先经 `chatPartsFromResponses` 改写外壳） |
| 纯文本提取 / 「工具结果不能带图」 | `messages.ts` 的 `textFromContent` | 同上 |
| 工具 schema 校验 | `messages.ts` 的 `convertTools` | Responses 先经 `toChatTools` 把**扁平**工具写成 Chat 的嵌套形状 |
| 输出预算校验 + 钳制 | `tokenValue` / `normalizeMaxTokens` | `max_tokens` 与 `max_output_tokens` 走同一判据 |
| 思考档位归一化（三态） | `normalizeReasoningEffort` | `reasoning_effort` 与 `reasoning.effort` |
| **用量口径**（DSH 互斥 → OpenAI 含缓存） | `usage.ts` 的 `toOpenAiUsage` | `stream.ts` 与 `responses.ts` 各自的 `usageJson` **只改字段名** |
| 取消、错误翻译、CORS、SSE 头 | `server.ts` 的 `withRequest` / `writeSseHead` | 两个端点 |

⚠️ 改这些共享件时**必须同时想两个端点**：`openai-gateway-server.spec.ts` 的
「Responses API 出口」段里有几条**跨端点**用例（钳制、404 翻译、鉴权）专门锁这件事。

### 两处与 Chat 端点**有意不同**（改 `responses.ts` 前先读文件头）

1. **文本以 `block-end` 的组装块为权威**（`finalText`）。DSH 的正文死循环截断与泄漏
   清洗**只在 `block-end` 上生效**（`openai-compat.ts` / `buddy-adapter.ts` 的注释、
   `scripts/verify-blockend-override.ts`）。Chat 端点只累加 delta，触发死循环时会把重复
   正文交给客户端；Responses 端点取 `block-end`。⚠️ **不要去「顺手统一」Chat 端点** ——
   那会改动一个已被线上流量验证过的端点，属于本次任务之外的越界重构（与
   `openai-compat.ts` 那条「只服务 qoder」的约定同因）。
2. **失败事件的 `error.code` 只放官方枚举值**（`server_error` / `rate_limit_exceeded`）。
   Responses 的 `Response.error.code` 在官方 SDK 里是 **Literal 枚举**，把 DSH 的内部码
   （`SERVER` / `QUOTA_EXCEEDED` / `incomplete_stream`）塞进去，客户端会在**解析失败事件**
   时抛校验错误 —— 用户看到「客户端崩了」，而真实原因是上游错误。
   精确码放 `error.dsh_code`、本该返回的 HTTP 状态放 `error.status`（Chat 端点的 SSE 错误
   帧里也有同名字段，口径一致）。

### ⚠️⚠️ 用量口径：`input_tokens` / `prompt_tokens` **必须含缓存命中**（真实报障，2026-10-04）

**用户报障**：接入 Codex 后，「raccoon 的上下文显示好像不太对 —— 搞半天就占了 5%，
一换成 trae 就正常显示占了 300k 多」。

**根因是两种「缓存算不算输入」的口径冲突**：

| | DSH `TokenUsage` | OpenAI `usage` |
|---|---|---|
| 输入 | `inputTokens` **只含未命中缓存**；命中单列 `cacheReadTokens` | `prompt_tokens` / `input_tokens` 是**含缓存**的总输入 |
| 明细 | 无 | `prompt_tokens_details.cached_tokens` 是上者的**子集**（不是并列项） |

DSH 侧口径见 `src/types.ts` 的注释，以及各适配器统一在做的那一步减法
（`openai-compat.ts:892`、`buddy-adapter.ts:1988`、`lobsterai-adapter.ts:1488`、
`llm-adapter.ts:1797`、`gemini-messages.ts:455`）—— 它们把上游**含缓存**的
`prompt_tokens` 减成 DSH 的互斥口径。**网关这一跳必须减回去**。

旧实现原样发 DSH 口径，Codex 再按官方口径算 `input_tokens - cached_tokens`
（`saturating_sub`）⇒ 夹到 **0** ⇒ 总数只剩 output。实测（rollout
`…01a0fc83….jsonl` 的 `token_usage_record`，逐帧对得上）：

| 时刻 | 真实上下文 | 修复前 | 修复后 |
|---|---|---|---|
| raccoon 会话中 | 56,225 | **5.56%** ← 用户看到的「5%」 | 5.99% |
| raccoon 会话末 | 208,258 | **0.15%** | 21.99% |
| trae 会话末 | 326,134 | 34.39% ← 用户看到的「300k多」 | 34.39% |

⚠️ **trae 之所以「正常」不是它被修好了，而是它不报缓存** ——
`trae-adapter.ts` 的 `token_usage` 只读 `prompt_tokens` / `completion_tokens`，
从不算 `cacheReadTokens`，旧公式恰好等于完整上下文。
⇒ **受影响的是所有开前缀缓存的 provider**，只有 trae 幸免。

⚠️ **这不只是显示问题**：Codex 判断该不该自动压缩用的就是同一个数
（`tokens_in_context_window()`）。计量恒定在 0.1%~5% ⇒
`model_auto_compact_token_limit` **永远不会触发**，真实上下文会一路涨到撞上
模型硬限直接报错，而不是优雅地压缩。

**Codex 的权威判据**（`agcodex_protocol::protocol::TokenUsage`，与 openai/codex 同源）：
```rust
pub fn non_cached_input(&self) -> u64 {
    self.input_tokens.saturating_sub(self.cached_input())   // ← 它要减，说明 input_tokens 含缓存
}
pub fn tokens_in_context_window(&self) -> u64 {
    self.total_tokens.saturating_sub(self.reasoning_output_tokens.unwrap_or(0))
}
```

**修法**：转换抽成**唯一一份** `src/openai-gateway/usage.ts` 的 `toOpenAiUsage()`，
两端各自的 `usageJson` **只改字段名**（这正是「共享判断只留一份」那条规矩的又一次应用 ——
本缺陷的成因就是两端各写一份且都写错）。三条实现要点：

1. `inputTokens + cacheReadTokens + cacheWriteTokens` —— 缓存写入同样是这一轮真实发出的输入
   （Anthropic 的 `cache_creation_input_tokens`），但**不是**「命中」，故不进 `cachedTokens`；
2. `total` 取 `max(上游报的, 自己拼的)` —— 上游报的数若**不含缓存**（14 个 provider 无法穷举验证）
   直接采信就会原样重现本缺陷。**只会多算、绝不漏算**，因为漏算的代价是自动压缩永不触发；
3. Chat 端点补发官方的 `prompt_tokens_details.cached_tokens` /
   `completion_tokens_details.reasoning_tokens`，**并保留** `prompt_cache_hit_tokens` /
   顶层 `reasoning_tokens` 这两个私有字段（本仓库多个适配器在**读**它们，删掉会破坏既有消费者）。

⚠️ 回归用例 `tests/unit/openai-gateway-usage.spec.ts`（12 条，含「两端对同一份用量给出
相同数字」「cachedTokens 是 inputTokens 的子集而非并列项」「上游 total 不含缓存也不得采信」）。
⚠️ 已做**反向验证**（`mutate-usage.mjs`，7 个变异 **7/7 全被杀死**）：还原缺陷行、
把 cached 当并列项、漏掉 cacheWrite、直接采信上游 total、只改一个端点、漏发官方明细字段。

⚠️ 这是 `6f352ca`（Chat 出口）与 `c19917a`（Responses 出口）就带着的既有缺陷，
**不是**第 7、8 轮引入的；只是**接入 Codex 用 Responses 端点之后才暴露** ——
在那之前没有消费者会这样解读这两个字段。

### ⚠️⚠️ Codex 的 `namespace` / `custom` / `tool_search` 工具**不能报错**（真实报障，2026-10-03）

**用户报障**：Codex App 接本网关后整轮对话直接失败，界面上只有一句
`tool type namespace is not supported（网关只提供 function 工具）`
（`toChatTools` 的第一版实现）。

**根因**：Codex 0.142+ 用它私有的 Responses 扩展声明工具 ——
`{type:'namespace', name:'mcp__files__', tools:[{type:'function', name:'read', …}]}`
外加 `{type:'custom'}`（自由文法工具，如 `apply_patch`）与 `{type:'tool_search'}`。
这一批形状在第三方网关上普遍翻车（ollama / llama.cpp / xAI 都有对应 issue）。
而 **namespace 只是分组容器** —— 里面的 function 完全可以表达给模型。

**修法与理由**（`responses.ts` 的「工具」一节有完整注释）：

| 形状 | 处理 |
|---|---|
| `function`（顶层） | 原样转 `ToolSchema` |
| `namespace` 里的 `function` 子工具 | **摊平成 `<namespace>__<child>`**（含 `defer_loading` 的） |
| `custom` / `tool_search` / `web_search` / `mcp` … | **丢弃 + `onDrop` 上报**（server 侧记 warning） |

⚠️ **判据是「代价与收益是否对等」**：报错的收益只是「让用户知道某个工具没被转发」，
代价却是**整个会话不可用**。故「无法表达的工具」一律降级为丢弃 + 记日志，
**绝不 400**。（这与本仓库「不静默丢弃用户显式设置」并不冲突：那条针对的是
**语义会变**的标量字段 —— `previous_response_id` / `text.format` / 非 1 的 `top_p`，
它们一旦被忽略，用户以为生效了的设置会给出**错的结果**。）

⚠️ **必须「摊平 + 还原」成对做，且两侧算法同源**：
- 摊平名只有一份实现 `flatNamespaceToolName()` = `<namespace>__<child>`，
  超 64 字符截断 + 8 位 sha256 后缀（纯截断会让长名字碰撞）。
  命名法与 Codex 自己（PR #29602）及 cc-switch / sub2api 一致。
- **响应侧必须还原**成 `{name: <child>, namespace: <ns>}`（`output_item.added` /
  `function_call_arguments.done` / `output_item.done` / `response.completed` 四处都要）：
  Codex 的工具表按 `(namespace, name)` 索引，只回扁平名它会认为
  「模型调用了一个不存在的工具」。
- **历史里的 `function_call` 也要换回扁平名**：否则上游看到「工具以 `ns__child`
  声明、历史却调了 `child`」，等于调了一个没声明过的工具。
- `tool_choice: {type:'namespace'}` **降级为 `auto`**（DSH 只认 auto/none；降级后
  模型仍能从已摊平的工具里挑）。
- ⚠️ 还原表**不靠跨函数状态传递**：`responsesNamespaceToolMap(request)` 从请求体
  独立重算（cc-switch 同款思路），比让 server 把 map 一路穿进来更不容易漏。

回归用例（`openai-gateway-responses.spec.ts` 6 条 + server spec 1 条）：namespace 摊平、
`custom`/`tool_search` 丢弃且上报、`tool_choice` 降级、扁平名确定性（含 80 字符长名
不碰撞）、历史 `function_call` 换名、非流式与流式两处还原、HTTP 层回 200。

### 明确**报 400** 的字段（不静默忽略）

`previous_response_id`（网关无状态、不存响应，`GET /v1/responses/{id}` 一律 404）、
`background`、`text.format`（DSH 没有结构化输出通道，**不假装**按 schema 约束）、
非 1 的 `top_p`（`GenerateOptions` 没有 topP）、`item_reference`、
`input_image.file_id`。
**接受但忽略**：`store` / `include` / `prompt_cache_key` / `metadata` / `user` /
`truncation` / `service_tier` / `safety_identifier` / `parallel_tool_calls`。
⚠️ 判据是「**语义会不会变**」：会变的必须报错（否则用户以为设置生效了），
不会变的（无状态转发下本就无处安放）接受即可。
⚠️ **工具类型不属于这一类**（见上一节）：它要按「代价与收益」判，丢弃 + 记日志。

### 其它必须记住的点

- **连续的 assistant item 必须合并成一条消息**（`toMessages`）：Responses 把「助手说
  一句话」与「助手发起工具调用」拆成两个 item，照 item 一一映射会让**每个用过工具的
  会话**都给上游留下两条连续 assistant 消息 —— Anthropic 系适配器要求 user/assistant
  交替，这类历史会被上游拒绝。
- **`function_call` 的 item 延迟到第一帧 delta 才打开**：`call_id` / `name` 只出现在
  delta 里，而 `output_item.added` 必须带上它们，否则客户端配不上 call_id。
### ⚠️⚠️ 块**可以并行开启**，一个块也只能收尾一次（真实报障，2026-10-04）

**用户报障**：在 Codex 里用本机网关接 CodeBuddy，第一轮就整轮失败：

```
stream disconnected before completion: buddy: 工具记录不完整，请新建任务
tool calls and tool results do not match, please start a new conversation and retry
```

⚠️ 前半句是**网关上游**（buddy）的话，后半句才是 **Codex 自己的判据** —— 别把整句
当上游错误去查上游；**判据是后半句**，它说的是「工具调用与工具结果对不上」。

**根因不在适配器，在网关的响应侧**（`src/openai-gateway/responses.ts`）。
早先的实现把 `block-start` 当成「块切换」的信号，收到它就 `closeAll()` 把**还开着的**
项全部收尾（理由写的是「协议要求项按 `output_index` 顺序闭合」，那个前提是错的）。
可各适配器的 `block-end` **全部集中在流末尾补发**（见 `buddy-adapter.ts` 的
`toolOrder` 段：先发全部工具块、再发正文/思考块）。于是：

1. `block-start[0] tool-call` → 开项；
2. `block-start[1] tool-call` → **把 [0] 提前收尾并从 `open` 删除**（此时 [0] 的参数
   只有 delta 累积的过程量，`block-end` 的权威覆盖**还没到**）；
3. 流末尾 `block-end[0]` 到达 → `open` 里找不到它 → **又新建了一个同索引项**。

⇒ 同一次工具调用发出**两个** `function_call`、**共用同一个 `call_id`**，客户端据此
判定「调用与结果对不上」并终止整轮。会话日志里的铁证（`~/.codex/sessions/` 的 rollout
jsonl，同一 `call_id` 两个不同 `id`）：

| ordinal | type | id | call_id |
|---|---|---|---|
| 13 | function_call | `fc_0b93c794…` | `call_00_KBnaF3NJZEpUhky4QjDE8134` |
| 14 | function_call | `fc_68918ef8…` | `call_00_KBnaF3NJZEpUhky4QjDE8134` ← **重复** |
| 15 | function_call | `fc_5aa68279…` | `call_01_btOPnboew8O1tFdmA7st8674` |

同一形态也复制了正文与 reasoning（ordinal 12/17、10/19 逐字相同）。
⚠️ **不是边角**：只要**并行两个工具调用**就必然触发，而 Codex 默认就爱并行调用。

**修法（两条是一对，缺一条就会重复）**：

| 规则 | 做法 | 少了它会怎样 |
|---|---|---|
| 块**可以并行开启** | `block-start` **什么都不做**（不 `closeAll`），只有 `block-end` 收尾；流末尾仍未收尾的才由 `closeAll()` 兜底 | 提前收尾 ⇒ 丢 `block-end` 的权威参数、且真正的 `block-end` 会新建重复项 |
| 一个块**只能收尾一次** | `closed: Set<number>` 闸门，挡在 `block-end` 与三个 delta 分支上 | 重复的 `block-end` / 已收尾后又来的散帧 ⇒ 又是重复项 |

⚠️ **这两条正是 DSH 权威实现 `BlockAssembler` 的语义**（`packages/llm/llm/src/assembler.ts`）：
`block-start` 只在**索引首次出现**时登记（`if (!this.partials.has(chunk.index))`），
`block-end` 是「**first close wins**」（`if (partial.block) return`），
已收尾块的散帧一律忽略。**改响应侧前先读它** —— 网关只是把这套语义搬到 HTTP 边界上，
不要自己发明。

⚠️ **`outputOf` 必须按 `outputIndex` 排序**：`output_index` 的语义就是「本项在
`output` 数组里的下标」，而项落进数组的顺序取决于**收尾顺序**（工具块先收尾、正文块后
收尾），与模型真实产出顺序相反。不排序时客户端会把助手这一轮读成「先调工具、后说话」。
⚠️ 这也是**上面那个 bug 的另一半成因**：一开始只观察到「顺序不对」，若当时只加排序，
重复项依然存在 —— 两者必须一起修。

**反向验证**（`mutate-dup-callid.mjs`，7 个变异全击杀 / 0 存活）：

| 变异 | 变红的用例 |
|---|---|
| `block-start` 恢复 `closeAll` | ★ 并行工具调用：每个调用只能有一个 function_call 项 |
| 去掉流式 `block-end` 的 `closed` 闸门 | 畸形流：重复的 block-end（工具 / 正文两条） |
| 去掉非流式 `block-end` 的 `closed` 闸门 | 畸形流（非流式）：重复的 block-end 不得变成两个项 |
| 去掉流式 text/reasoning delta 的闸门 | 畸形流：block-end 之后的正文 delta 不得再开一个新项 |
| 去掉流式 tool-call delta 的闸门 | 畸形流：block-end 之后又来的 delta 不得再开一个新项 |
| 去掉非流式 delta 的闸门 | 畸形流（非流式）：block-end 之后的 delta 不得再开一个新项 |
| 去掉 `outputOf` 的排序 | ★ 并行工具调用（同时锁顺序与唯一性） |

⚠️ **写这套用例时踩到的坑，下次别重犯**：第一版只加了「并行工具调用」一条用例，
反向验证直接暴露 **2 个存活变异**（`closedDeltaStream` / `closedDeltaNonStream`）——
「block-end 之后又来的 delta」这类畸形流此前**没有任何用例覆盖**，那两处闸门等于**没被锁住**。
**判据：每条防御性分支都要有一个专门打破它的变异**，否则「加了防御」只是观感。

⚠️ **端到端证据必须包含阴性对照**：`verify-live-dup-callid.mjs` 对**部署前的网关**
发一次真实的双工具并行请求，得到 **3 个** `function_call`、`call_00` 重复
（与用户会话日志逐字同形）；部署修复后同一脚本得到 **2 个**、无重复。
⚠️ 该脚本**要求真的拿到 ≥ 2 个调用**，只拿到 1 个时它报「本次证据无效」并退出码 2 ——
因为单调用形态**根本不会触发**这个缺陷，拿它当证据是自证。

- **`block-end` 的块必须能被单独收下**（无 delta 时也要建项）：Chat 端点会整段丢掉它，
  Responses 端点按块内容补齐一个完整项（用例「只发 block-end 的块不会被丢掉」）。
- **不发 `data: [DONE]`**：那是 Chat Completions 的收尾约定，Responses 以
  `response.completed` / `response.failed` 结束。
- 面板（`openai-gateway-panel.js` 的 `gatewayStatusLines`）在**运行中**时会说明
  「协议支持：OpenAI Chat Completions 与 OpenAI Responses API」（⚠️ 措辞不得写成
  「可切换」，两个端点同时都在、没有互斥开关，用例会红）。该段文案在 2026-10-04
  按用户要求**精简过**（原三句「网关正在运行 / 把外部客户端的… / 地址：…」合并为
  三行短句：推荐 CC Switch、协议支持、API 请求地址）—— 精简**不减信息**，
  「两种协议都点名」与「地址带真实端口」两条仍有独立用例锁着。
- 回归用例：`tests/unit/openai-gateway-responses.spec.ts`（转换 + 流式/非流式事件序列）
  与 `tests/unit/openai-gateway-server.spec.ts` 的「Responses API 出口」段（HTTP 层）。

### ⚠️⚠️ 工具结果**可以带图**：`textFromContent` 不能用在 tool 结果上（真实报障，2026-10-04）

**用户报障**：在 Codex 里走本机网关接 **TRAE**，一让模型看图就整轮失败：

```
{"error":{"message":"tool 消息的内容不能包含图片","type":"unsupported_content","code":"unsupported_content"}}
```

用户当场就问「trae 是可以发送图片的啊？」—— **这个怀疑是对的**：TRAE 确实支持图片，
而且它**支持工具结果内嵌的图片**（`read_image` 那类）。这句报错**不是 trae 说的**，
是**本网关自己抛的**（`messages.ts` 的 `textFromContent`）。

**根因**：工具结果（Chat 的 `role:'tool'` / Responses 的 `function_call_output`）
原先都只走 `textFromContent`，而它对 `image_url` **一律抛错**。于是：

- Codex 的 `view_image` 工具把读到的图**直接放进 `function_call_output.output`**
  （`[{type:'input_image',image_url:'data:image/png;base64,…'}]`）；
- 网关解析该 item 时立刻 400 ⇒ **整轮对话失败**；
- ⚠️ 更糟的是**坏报文已落进会话历史**，之后每次请求原样重放 ——
  用户连点两次「继续」都是同一个错（实测 ordinal 2748 与 2758 逐字相同）。

**会话证据**（`~/.codex/sessions/2026/10/02/rollout-…-01a0fc83….jsonl`）：

| ordinal | 内容 |
|---|---|
| 2736 | `function_call_output`，`call_id=call_7ec7d6b4…`，output = `[{type:'input_image'}]` |
| 2738 | `function_call_output`，`call_id=call_e1a02c4f…`，output = `[{type:'input_image'}]` |
| 2748 | `task_complete` ← **`tool 消息的内容不能包含图片`** |
| 2758 | `task_complete` ← 同一错误（重放历史） |

⚠️ **同一会话里 ordinal 920/921 也有带图的 `view_image` 结果却没失败** ——
别被它误导。那两轮跑的是 `gpt-6.1-sol`（**没有 `provider/` 前缀**），
根本没过本网关（`parseModelRoute` 对无前缀的 model 直接抛错，走的是另一条路径）。
**判据：只有 `provider/model` 形态的请求才会到达本网关**，对照时先看模型名。

**修法**（两条协议路径必须**同时**改，判据只有一份）：

| 位置 | 修法 |
|---|---|
| `messages.ts` 的 `role:'tool'` | content 改走 **`partsFromContent`**（与 user 消息同一份图片入站实现） |
| `responses.ts` 的 `function_call_output` | 新增 `outputParts()`，同样走 `partsFromContent` |

⚠️ **`textFromContent` 的图片分支保留但改文案**：仍会走到它的只剩
`assistant` / `system`（这两种角色的 content 本就**没有**图片通道，适配器只声明文本
输出）。**必须继续明确报错**——静默压成空串会让用户以为图发出去了。

⚠️ **适配器侧早已支持，缺陷只在网关**：`trae-adapter.ts` 的 `collectImages` /
`userContentParts` 会**递归**消费 `tool-result` 的内层图片，并把它挂到 `role:'tool'`
**之后**的独立 user 消息（`pendingToolImages`）—— 那是上游 `code=4027` 那条真实缺陷的
修法（见 `tests/unit/trae-adapter.spec.ts` 的「工具结果内嵌图片不得插在 role:tool 之前」）。
**所以这里不需要动适配器**，网关只要把图正确放进 `tool-result` 的内层即可。

**判据不能只是「不报错」**：图片必须**真的落进 `tool-result` 的内层 content**。
静默压成文本或丢掉同样是缺陷（用户以为模型看到了图，答案却是凭文本猜的）。

**反向验证**（`mutate-tool-image.mjs`，5 个变异全击杀 / 0 存活）：

| 变异 | 变红的用例 |
|---|---|
| Responses 退回 `textFromContent` | ★ 工具结果的 output 带图时…（两条） |
| Chat 退回 `textFromContent` | ★ role=tool 的内容带图时… |
| Responses **静默丢弃**图片 | ★ 工具结果的 output 带图时…（两条） |
| Chat **静默丢弃**图片 | ★ role=tool 的内容带图时… |
| assistant 带图改为静默丢弃 | assistant 带图仍明确报错 |

⚠️ **「静默丢弃」那两个变异是本次最关键的一条**：只断言「不抛错」的用例会被它们
放过，必须断言**内层块类型数组**（`['image']` / `['text','image']`）与
**附件服务 `saveImage` 的调用次数**。

## ⚠️ 思考档位有**两套词汇表**：网关必须翻译，客户端表达不出私有 id（真实报障，2026-10-03）

**用户报障的形态**：在 CC Switch（给 Codex 生成模型目录的那一层）里按 DSH 界面显示的
名字填「思考等级」，之后 Codex 每一轮都失败 ——
`400 reasoning effort "max" is not supported by the selected DSH model`。
用户从两端都看不出为什么，只能一档一档试。

**根因**：各 provider 的档位 `id` 就是**上游 wire 值**，与客户端能表达的词汇不是一套：

| provider | DSH 界面上显示（= adapter 的 `name`） | wire id（网关校验的） | 客户端照填 → 旧行为 |
|---|---|---|---|
| LobsterAI | 关闭 / 高 / **Max** | `off` / `high` / **`xhigh`** | `max` → 400 |
| Cline | None / … / **Extra** | `none` / … / **`max`** | `xhigh` → 400 |
| TRAE | **Light** / High / **Extra High** | **`light`** / `high` / **`extra_high`** | `low` / `xhigh` → 400 |
| Raccoon | **开启 / 关闭** | **`on`** / `off` | 恰好能用 |

⚠️ **`id` 与 `name` 不是同一个概念**，仓库里已有两处同款教训：
`lobsterai-adapter.ts` 的 `reasoningFor`（Issue #IKHCZF：最强档显示成 XHigh，而产品侧
叫 Max）、`cline-product.ts` 的 `CLINE_REASONING_EFFORTS`（`{id:'max', name:'Extra'}`）。
DSH 的选择器渲染 `name`、发请求用 `id`；**网关校验的也是 `id`**。

⚠️ **客户端侧是硬约束**：OpenAI 协议只有固定 8 档（`none minimal low medium high xhigh
max ultra`）。CC Switch 把那 8 个（连英文描述）**硬编码在自己的产物里**
（`cc-switch.exe` 里可抠出这张表，它写进 `cc-switch-model-catalog.json` 再交给 Codex 的
`model_catalog_json`），它**表达不出** `light` / `extra_high` / `on` / `off`。
⇒ 「让客户端来查我们对齐」这条路走不通，**只能网关翻译**。

**实现（强度序的唯一权威：`src/reasoning-ladder.ts`）**：

- `REASONING_EFFORT_RANK` 是强度序的**唯一副本**（`trae-adapter.ts` 挑默认档也读它，
  不再自带一份表）；`CANONICAL_REASONING_EFFORTS` 就是客户端那 8 个。
- `translateReasoningEffort` 三条规则：① **精确命中**声明的 id → 原样（私有 id 与
  上游新冒出来的名字都靠这条通过）；② **登记过**的名字 → 同族就近，**同距取更强的一档**
  （与 raccoon 那条「宁可多思考，不可静默关掉」同因）；③ 没有同族候选 →
  `unexpressible`，完全不认识 → `unknown`。
- `normalizeReasoningEffort`（`messages.ts`）：`unknown` **仍然 400**（拼错不该被静默
  翻译，且报错里带上该模型可用档位）；`unexpressible` **不下发 + 记 warning**；
  翻译成功记 **info** —— 这是加了翻译层之后的**正常路径**（CC Switch 给 TRAE 的 `low`
  每一轮都会被翻译），用 warn 会把日志刷满、反而掩盖真正的异常。
- ⚠️ **只在同族内翻译**：`off`/`none`（rank 0）与其余各档**互不翻译**。
  把「少想一点」翻译成「完全不想」= 静默关掉功能，比 400 更糟。
- ⚠️ **未登记强度的声明 id 不参与就近匹配**（不知道强度就不猜）。
- `provider === 'codearts'` 的短路保留：该 provider 只有开/关两态，任何名字都等价。

**可查询（三个出口，必须同源）**：

| 出口 | 内容 |
|---|---|
| `GET /v1/models` 的 `reasoning` | `efforts`（带 `canonical`）+ `default` + `openai_efforts` |
| `GET /v1/reasoning-efforts` | 逐模型 + 8 个规范名**逐一的结局**（exact / mapped / unexpressible / ignored） |
| 设置页弹窗「思考档位对照表」 | 同一份数据（`gatewayEffortRows` 纯函数 + RPC 的 `models[].reasoning`） |

⚠️ **`ignored`（模型没声明档位）与 `unexpressible`（声明了但没有这一族）必须分开报**：
前者网关什么都没做（按模型默认走），后者是用户明确要的档位没生效。合并会让排查看不出差异。

⚠️ **判据（与工具那条同源）**：拒绝的收益（让用户知道某档没生效）远小于代价
（整轮不可用，且客户端**没有**能表达私有 id 的写法 ⇒ 用户无从修复）。

⚠️ 反查 `canonicalReasoningEffortFor` **只在单个模型的声明集合内**保证往返自洽
（`translate(canonicalFor(id), declared) === id`）；把几个渠道的档位混成一个集合再反查
没有意义 —— 用例里按渠道分别验。

⚠️⚠️ **面板对照表不复用模型清单的行样式**（用户反馈，2026-10-03：「你这对照表字符过长
都被省略了」）：`dim-jh-modelId` / `dim-jh-modelName` 带 `max-width: 46%` +
`text-overflow: ellipsis` + `white-space: nowrap`（模型清单要紧凑，那是刻意的），
而对照表那两行**正是用户要抄走的内容** —— 截断等于让这个功能失效。
故对照表用自己那套 `dim-jh-effortRow` / `dim-jh-effortHead` / `dim-jh-effortModel` /
`dim-jh-effortLine`（`overflow-wrap: anywhere`，**不得**出现 `ellipsis` / `nowrap`）。
`openai-gateway-panel.spec.ts` 的「排版（不截断）」段锁死了这两点（样式不得截断 +
渲染处不得用 `dim-jh-modelName`）。

### ⚠️ 两处清单都按**供应商折成卡片**（用户要求，2026-10-03）

**用户报障**：「`deepseek-account/deepseek-flash` 和 `deepseek-account/deepseek-v4-pro`
这是同一家供应商 `deepseek-account` 的，却分为了两个卡片」（当时是**一个模型一行**的平铺）；
同一条反馈还要求「模型 ID 这里显示各模型名也很乱，希望能像对照表一样改进下」。
⇒ **模型清单与思考档位对照表都改成一个供应商一张卡片**，卡内子项是它的模型。

判据全在纯函数里（单测环境是 `node`、**react 不在依赖内**，组件渲染不了）：

| 函数 | 作用 |
|---|---|
| `groupGatewayEntries(entries, countFold)` | 按 provider 折卡片（模型清单与对照表**共用**，口径不可能漂移） |
| `groupGatewayModels(models)` | 上面那个的模型清单版本，`counts.fold` = 可发图片条数 |
| `gatewayProviderOf(entry)` | 取供应商 key：**优先宿主的权威 `provider` 字段**，缺失才按首个 `/` 兜底 |
| `gatewayModelKeyOf(entry)` | 卡内**短名字**（去掉 `<provider>/` 前缀）；拿不到就退回完整 id |
| `gatewayCardExpanded(card, {toggled, searching})` | 折叠规则：点过 > 搜索中展开 > 超阈值折叠 |
| `gatewayCardLabel(provider, labelOf)` | 卡片标题（走 `providerLabel`，查不到退回 key） |

⚠️⚠️ **`provider` / `model` 必须由宿主侧给出，前端不得自己切 `id`**：模型名里**允许带
斜杠**（实测 `cline/anthropic/claude-sonnet-5.5`），反推在正常数据上恰好也对，但那是**巧合**
而非契约。故 `toGatewayModelIds` 回传权威拆分，RPC 类型 `RpcGatewayModel` 带上
`provider` / `model` 两个字段；`openai-gateway-models.spec.ts` 锁死
`provider + '/' + model === id`（逐字，三种形态）。

⚠️ **卡片头两个数字都必须如实**：总数与第二类计数。对照表的第二类计数是「需对照」
（`lossy`），模型清单的是「可发图片」—— 故 `GatewayCards` 用 `foldLabel` 参数区分，
**不能**把「可发图片」写死在组件里（否则对照表会显示「8 个可选档位 · 2 个可发图片」）。

⚠️ **对照表的分组必须发生在「筛出来的行」上**（`groupGatewayEntries(visibleEffortRows…)`），
不是先分组再筛：否则搜索时卡片头会出现「写着 8 个、卡里只有 1 行」的自相矛盾读数。
用例里有一条专门用 `expect(source).not.toContain('groupGatewayEntries(effortRows')` 把它锁住。

⚠️ **行内显示短名字，复制出去的永远是完整 ID**：`formatModelIdList(card.entries)` 用的是
`id` 字段。搞反的症状是「照着卡片复制了一个短名字进客户端 ⇒ 必然 404」。
卡片头已写明供应商，行内再重复前缀只会把整行挤成省略号。

⚠️ 已做**反向验证**（8 个变异，全部变红）：分组退化成「一个模型一张卡」（= 用户报障原形态）、
行内改回完整 id、折叠忽略用户点击、搜索时不强制展开、宿主不回传权威拆分、
对照表分组建在全量行上、复制本组改复制短名字、未知供应商标题给空串。

⚠️ 供应商 key 拿不到时归入 `''` 那张卡（标题「（未标注供应商）」），**不丢行** ——
少一个 ID 会让用户照着一份不完整的清单去配客户端。也**不去重**：同一 id 出现两次是上游的事，
去重会掩盖上游缺陷。

⚠️ **对照表的搜索比模型清单多匹配「档位名」**（`matchesEffortQuery` 复用
`matchesModelQuery` 之后**再补**真实档位名与该填的规范名）：最常用的查法就是
「哪个渠道有 `xhigh`」「界面上的 Max 到底是哪个 id」—— 后者正是用户踩过的坑。
**别**为了「统一」把它换成只认 id/name（用例里有一条专门锁这个差异）。
空搜索词 = 未搜索（原样返回、不复制）这条约定与模型清单共用 `model-filter.js` 的
`isFilterActive`，不要各写一份。

⚠️ 对照表**只含已开启的模型**（数据来自适配器 `listModels` 的黑名单过滤，
与对话框模型选择器同源）。文案必须点明「已开启的 N 个模型里…」——
否则用户看到「14 个」会以为网关只认得 14 个模型（他实际这么反馈过）。

### ⚠️ 网关弹窗第四批：文案再精简 + 搜索移进展开区 + 胶囊不截断（用户要求，2026-10-04）

四条要求**一次提出**（原话）：

> ①「下面的四个按钮，也按 `复制密钥` `显示明文` 的大小来统一。」
> ② 模型 ID 描述改为 `共开启 14 个可用模型，来自 12 个供应商，ID 区分大小写。`
> ③ 思考档位对照表描述改为「已开启的 N 个模型里，有 N 个可选思考档位（N 个不同名，标「需对照」）。」
> ＋「「客户端该填」为 CC Switch 需配置的映射档位，未登记的档位名称将被拒绝。」
> ④「搜索功能应当在展开后才可用，而不是像现在这样放在外面，模型 ID 的展开清单里也应该加个搜索栏。」
> ⑤「网关这里面的所有胶囊内容都没有完整显示，应当修正使其完整显示内容。」

**① 按钮尺寸统一 —— 判据是「同一条 CSS 规则」而不是「两处都写了 2px 8px」**

`.dim-jh-btn` 是通用按钮（`padding: 4px 12px` + `line-height: 18px` ⇒ 约 28px 高），
30+ 处调用点（页头 / 模型面板 / 卡片头 / 对照表），**绝不能直接改它**。
密钥行那套小号尺寸（`2px 8px` / 11px / 16px / 圆角 6px ⇒ 约 22px）抽成
**一条合并规则**：

```css
.dim-jh-gatewayKeyRow .dim-jh-btn,
.dim-jh-gatewayModal .dim-jh-gatewayActions .dim-jh-btn { padding: 2px 8px; font-size: 11px; line-height: 16px; border-radius: 6px; }
```

两处操作行挂同一个钩子类 `dim-jh-gatewayActions`（与 `dim-jh-modelPanelActions`
并存）。⚠️ 用例必须同时锁**样式**与**接线**：只锁样式时「类名忘了挂」照样绿
（变异「四个按钮的钩子少挂一个」就是为它准备的）；只锁接线时样式被改小/改大也看不出来。

**②③ 文案精简到一句 / 两句 —— 但删掉的信息必须**换位置**，不能丢**

| 删掉的句子 | 移到了哪里 |
|---|---|
| 「必须带供应商前缀」 | 卡片头 tooltip：`供应商 key：xxx（模型 ID 的前缀就是它）` |
| 「行内显示短名，复制出去的始终是完整 ID」 | 复制按钮 tooltip：`每行一个完整 ID` + `disabled: visibleModels.length === 0` |
| 「关掉的模型不在表里」 | 模型清单那句的「**已开启**」已表达同一约束 |

⚠️ 故「精简」的回归用例**不能只断言「旧句子不在了」**，还要断言新位置仍在
（`openai-gateway-panel.spec.ts` 里那条「前缀规则与短名差异必须仍在面板里能找到」）。
否则下次有人「顺手再精简一轮」时，信息是真的消失了，而用例全绿。

⚠️ **对照表说明里的举例（如 `turbo`）被删掉了，但边界照旧**：强度序只登记 12 个名字
（8 规范名 + 上游私有的 off/light/on/extra_high），未登记的写法**真会 400**。
用例锁的是「未登记的档位名称将被拒绝」这半句，**不要**因为旧用例里有 `toContain('turbo')`
就把它加回去（长度预算已收到 85 字）。

⚠️ 写这类「同一句话在正文与注释里各出现一次」的变异时，**锚点必须带行首的 `+ '`**：
`String.replace` 只替换**第一处**，只写那句话会把**注释**改掉、真正的 UI 文案原样存活
⇒ 变异假存活。本次实测踩到过（`mutate-gateway-text.mjs` 的「未登记…会被拒绝」那条）。

**④ 搜索移进展开区 —— 两处都要，且收起时必须清空搜索词**

- 两处搜索框都渲染在 `xxxOpen ? React.createElement(React.Fragment, null, …)` **之内**
  （不是挂在外面常驻占位）；新增了模型清单的搜索（`modelsQuery` / `visibleModels` /
  `gatewayModelsEmptyHint`），判据复用 `model-filter.js` 的 `filterModels`
  —— ⚠️ **不能**换成对照表那套 `filterEffortRows`（它还会匹配档位名，「搜 max」
  会命中一堆没这个功能的模型）。
- ⚠️ **收起时必须清空搜索词**（`if (modelsOpen) setModelsQuery('')`）：搜索框一收起就
  不可见，筛子却还在生效 —— 下次展开会莫名其妙少掉一半行，而用户完全无从察觉。
- ⚠️ 用户说「按 `复制密钥` 的大小统一」时，「复制全部 N 个 ID」的 **N 必须同步改成
  `visibleModels.length`**：按钮上写着 N、复制出的却是全量，用户会以为搜索没生效。
  用例要连**插值**一起锁（只锁 `复制全部` 时把 N 改回全量会假绿，实测踩到）。
- ⚠️ 两处搜索都要给卡片传 `searching`（`{ toggled, searching: … }`），否则命中的行
  藏在默认折叠的大卡片里 ⇒ 用户以为「搜不到」。
- ⚠️ 「搜索框在展开区之内」的回归用例必须**锚定展开分支本身**
  （`/modelsOpen\s*(?:\/\/[^\n]*\n\s*)*\?\s*React\.createElement\(React\.Fragment/`）：
  只取第一个 `modelsOpen` 是不够的 —— 操作行里的 `'aria-expanded': modelsOpen`
  也在它前面，那样写会退化成「搜索框在操作行之后」这种弱判据。

**⑤ 胶囊不截断 —— 必须加 `.dim-jh-gatewayModal` 前缀覆盖，且只覆盖该覆盖的**

用户报障的「胶囊」= `.dim-jh-modelId`（行内 ID 块）/ `.dim-jh-modelBadge`
（「可发图片」「需对照」）/ `.dim-jh-effortModel` / `.dim-jh-gatewayCardToggle`
（卡片标题）。前三个**天生带截断**（`max-width: 46%` + `ellipsis` + `nowrap`），
而那是给**模型列表**设计的（一行里还要塞下开关，紧凑是刻意的；见 `model-filter.js`
的模块注释）。修法：

```css
.dim-jh-gatewayModal .dim-jh-gatewayModelRow .dim-jh-modelId,
.dim-jh-gatewayModal .dim-jh-gatewayKeyRow .dim-jh-modelId,
.dim-jh-gatewayModal .dim-jh-gatewayCardBody .dim-jh-modelId { max-width: none; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
```

⚠️ **两处例外，刻意保持截断**：
- 弹窗顶部那行开关说明的胶囊（「打开（在 127.0.0.1 监听，供 Pi / Continue / Cline…）」）
  —— 它是全弹窗最长的单行文本，不截断会独占两三行；完整信息在「API 请求地址」里已有；
- 卡片标题**改为换行**而不是去掉截断了事：`.dim-jh-gatewayCardHead` 改成
  `align-items: flex-start; flex-wrap: wrap`，标题 `overflow-wrap: anywhere`，
  计数与「复制本组」`flex: 0 0 auto; margin-left: auto` 落到第二行。
  长供应商名此前被吃成 `deepseek-accou…`，而标题正是用户**唯一**能确认「这一家是谁」的地方。

⚠️⚠️ **不要靠「我把记得的几个类都覆盖了」来收工 —— 要用机械审计**
（`audit-gateway-pills.mjs`，本地脚本、不入库）：**枚举**网关弹窗渲染区间里用到的
全部 `dim-jh-*` 类，与样式表里**带截断属性**（`text-overflow: ellipsis` /
`white-space: nowrap` / `max-width: N%`）的规则求**交集**，交集里每一项必须是
「有 `.dim-jh-gatewayModal` 覆盖」或「在 EXPECTED 里写明保留理由」，否则退出码非 0。
当前结果：**39 个类 / 28 个带截断 / 交集 5 个 / 未覆盖且未声明 0 个**。

这次审计**真的抓出两个我漏掉的类**，别删这个脚本：
- `.dim-jh-btn` —— 它的 `white-space: nowrap` 也在交集里。**它不是内容截断**
  （防的是按钮内文字折行），但它在窄容器里的真实风险是「按钮被整体推出容器、点不到」，
  而这两个操作行的文案带**动态计数**（「复制全部 1234 个 ID」）。故给
  `.dim-jh-gatewayModal .dim-jh-gatewayActions` 加 `flex-wrap: wrap`。
  ⚠️ 这条**不能**靠「我实测 364px 下没溢出」收工 —— 那是**当前数据（15 个模型）**的结论，
  换成 1234 个模型就不成立。要按「任意计数都成立」来设计。
- `.dim-jh-gatewayCardCount` —— 它的 `nowrap` 是**刻意保留**的：它是一行读数，
  折成两行比占宽更难看；`overflow` 是 visible，真放不下时由卡片头的 `flex-wrap`
  把它**整块**挪到第二行，而不是切掉文字。

⚠️ **例外条目要在审计脚本里写明依据，且依据必须是实测而非印象**：脚本末尾的 NOTES
记着三组数字 —— 560px 下 12 个受关注胶囊元素 `scrollWidth - clientWidth` 全为 0；
320px 下弹窗无横向溢出、操作行子元素右边界均未越出容器；
长 provider key 让卡片头子元素 top 由 `[367,367,367]` 变 `[367,393,393]`（整块换行）。

### ⚠️⚠️ 上面那套「胶囊不截断」**第一次是没修好的** —— 选择器夹了中间祖先

用户第二次截图框出**三处仍在截断**的地方（我在同一轮里报了「全部修好」，是错的）：

| 位置 | 实际祖先链 | 我第一版的选择器 |
|---|---|---|
| 开关行胶囊 | modalBody > modelRow > modelInfo > code.modelId | 要求 .dim-jh-gatewayModelRow ❌ |
| curl 代码块（模型目录） | modalBody > code.modelId | 要求上面三类之一 ❌ |
| curl 代码块（档位对照表） | modalBody > code.modelId | 同上 ❌ |

三条规则写成了「弹窗 + **中间祖先** + 类名」，**只覆盖到卡片内**那一处。
症状与用户看到的一致：`供 Pi / Cont…`、`curl … -H "…"` 被吃掉。

**修法**：覆盖规则只写**两级通配**（弹窗 + 类名），这样对弹窗内该类的**任何**祖先链都生效。

⚠️⚠️ **两条比代码更值钱的教训**：

1. **审计判据必须落到「元素」而不是「类名」**。第一版审计脚本枚举的是
   「弹窗里用到的**类名**有没有被某条网关规则覆盖」—— modelId 在卡片那条规则里
   「有覆盖」，于是**整体判通过**，而用户框出的三处一个都没被覆盖。
   **同一个类名在弹窗里可以有多种祖先链**，「类名出现过」推不出「每个实例都被覆盖」。
   ⇒ 现在的判据：**覆盖规则必须是两级通配**（"对任意祖先链都生效"的充分条件，
   可纯静态判定）；「每个实例是否真的完整」交给真实 DOM 逐个量 `scrollWidth`。
   ⚠️ 同理，**量测也必须逐个元素遍历**，不能按选择器挑着量 ——
   `measure-gateway-v3.mjs` 第一版的 `watch` 列表里**根本没有 curl 那两条选择器**，
   于是它一直报「0 个被截断」而用户看到的是被切掉的文本。
   **改这里的量测时，遍历 `modal.querySelectorAll('.dim-jh-modelId')` 全量，别写白名单。**
2. **用户说"还是没修好"时，先把"我上次的验证是否真的覆盖了症状"当成第一嫌疑**。
   我上次的证据（DOM 量 12 个元素、0 截断）本身是**真的**，但它量的元素集合是
   **我自己挑的** —— 挑漏了用户实际看的那三处。**证据为真 ≠ 覆盖了症状。**

⚠️ **顺带删掉的一条会"骗人"的规则**：原有一条
`.dim-jh-gatewayModelRow .dim-jh-modelId { max-width: 52% }`
（把模型列表的 46% 放宽到 52%）。它与两级通配**优先级完全相同 (0,2,0)**，
于是谁生效**只取决于源码先后**。已删除 —— 保留它就是留一个「靠写在对的位置才不出事」
的地雷（有人把新规则贴到它后面，截断就回来了）。
用例里有一条专门堵这个洞：**弹窗内不得再有第二条给 `.dim-jh-modelId` 设上限的规则**。

⚠️ **修截断顺带引入过的第三次退化（渲染截图才发现，务必回归）**：
去掉胶囊的 `max-width` 后它把开关行整行宽度吃光，而 `.dim-jh-modelName` 是
`flex: 0 1 auto`（可收缩）⇒ 标题「启用本机网关」被压成「启用本机网」「关」两行。
修法：`.dim-jh-gatewayModal .dim-jh-modelInfo > .dim-jh-modelName { flex: none; }`
（**只**钉开关行的标题，用**直接子选择器** —— 卡片行里展示名的收缩是刻意的，
写成通配会让长展示名横向溢出）。

⚠️ **本仓库的 CSS 解析陷阱（写用例时踩到）**：`jet-hub-styles.js` 整个 CSS 在一条模板串里，
想按规则遍历**不能**用 `/([^{}]+)\{([^}]*)\}/g` —— 它可以从任意位置起匹配，
选择器组会跨过前一条规则的 `}` 吃掉前文，selector/body **角色互换**
（实测解析出 `SEL="A { x: 1 }" BODY="A "`），判据永远不命中 ⇒ **变异假存活**。
必须按花括号深度**扫描**（见 `openai-gateway-panel.spec.ts` 里的 `rulesOf`），
并在解析后加一条「解析出的规则数 > 100」的反向自检 —— 否则「没找到违规」可能只是
「什么都没解析出来」。

⚠️ **反向验证已扩到 30 个变异（全红）**，本轮新增 4 个都是这次返工的直接回归点：
覆盖规则退回带中间祖先、把 52% 写回通配之后、整条覆盖删掉、开关行标题退回可收缩。

### ⚠️ 网关弹窗第四批（第二轮）：胶囊文案 / 按钮顺序 / 删 curl / **三段分隔**

用户 2026-10-04 的第二轮四条要求（原话）：

> ①「修改『启用本机网关』右边的那个胶囊为『在 127.0.0.1 监听，供客户端调用』。」
> ②「思考档位对照表里的『展开对照表』与『复制对照表』两个按钮位置互换。」
> ③「删掉这两段：命令行查看同一份目录/对照表 + 那两条 curl。」
> ④「这三个红框框起来的不同的功能段，能明显的区分开来，现在的效果就是这三坨字全混在一起有点难看清。」

**① 胶囊只留「在 127.0.0.1 监听，供客户端调用」**：原先列了 Pi / Continue / Cline /
OpenCode 四个客户端名，窄面板下折成两行，还把「打开/关闭」那个动作词挤到很后面。
客户端列举属于 README 的内容。⚠️ **动作词没丢** —— 它由开关的 `aria-label`
（`action + '本机网关'`）承担；用例里有一条专门锁它没被一起删掉。

**② 对照表两个按钮互换**（复制在前、展开在后）：与模型清单那段统一，三段里按钮位置
可预期。⚠️ 用例锁的是**顺序**（`indexOf(copy) < indexOf(toggle)`），不只是「两个都在」。

**③ 删掉两段 curl**：`gatewayModelsCurl` / `gatewayEffortsCurl` **两个纯函数保留**
（有独立价值，README 与将来的 CLI 入口可能用），只是不再出现在面板上；
`jet-hub.js` 里对应的三个 import（连同 `gatewayEndpoint`）一并移除。
⚠️ 「地址栏直接打开会 401」这句是 curl 段标题的一半，也一并删了 ——
**但那个事实不能丢**，它由 README 承担（用例里有一条断言 README 仍含 `401`）。

**④ 三段分隔（这是本轮最容易做错的一条）**：
做法是每段包一个 `.dim-jh-gatewaySection`，段间用
`border-top` + 更大间距切开，并给后两段加 `.dim-jh-gatewaySectionTitle`（13px/600 深色）。

⚠️⚠️ **三个必须记住的点**：

1. **分隔规则必须写相邻兄弟选择器**（`.dim-jh-gatewaySection + .dim-jh-gatewaySection`）：
   写成 `.dim-jh-gatewaySection { border-top }` 会给**第一段**也加上边框 ——
   它紧贴弹窗标题，那条横线看起来像多出来的分隔条。
2. **段标题不能沿用 `.dim-jh-modalHint` 那套 12px 灰字**：段标题与段内说明同为灰色时，
   分隔线的效果会被抵消（用户仍然分不清哪一行是标题）。用 13px/600 深色。
3. **脚注（安全提示）不属于任何一段**，单独一个 `.dim-jh-gatewayFootnote`。

⚠️⚠️ **量测要量「分隔是否真的生效」，不能只看 CSS 里有 border-top**：
选择器写错（例如 DOM 中间夹了别的兄弟节点）时规则**根本不生效**，而静态检查照样绿。
`measure-sections.mjs` 在真实 DOM 里读每段的 `getComputedStyle().borderTopWidth`
与几何位置，并断言「后两段里真的有可见上边框的 = 2/2」。当前实测：
第 1 段 `border-top = 0px none`，第 2/3 段各 `1px solid` + `padding-top 10px` + 段间距 12px。

⚠️ **mockup 自身会出错，而且会被误读成产品缺陷**（本轮实测踩到）：
`measure-gateway-v3.html` 少了一个 `</div>`，第 3 段被**嵌进**第 2 段里，
于是量测报「第 3 段 border-top = 0px」—— 看起来像 CSS 写错了，实际是 mockup 的问题。
⇒ 加了 `check-mockup-balance.mjs`：按行统计 `<div>` 开闭，要求**最终深度 = 0 且过程中
最小深度 = 0**，不配平就退出码非 0。**改 mockup 后先跑它，再跑量测。**

⚠️ **改渲染代码后必须重跑变异测试**：本轮因为「整段包进 section（缩进 +2）+ 段分界
注释改名 + 按钮调序」，一次性**失效了 7 条锚点**，而锚点失配在工具里的表现是
**「存活」**（像锁失效了，其实是脚本没跟上源码）。已逐条按新缩进修正，
并把「第 2/3 段」写进分界注释 —— ⚠️ **改动那两处分界注释就必须同步改单测里的锚点**
（`openai-gateway-panel.spec.ts` 有两处 `indexOf('// ── 第 2 段：模型目录 ──')`）。
本轮的**新变异**：胶囊退回客户端列举、按钮顺序换回「展开在前」、把 curl 段加回来、
删掉段间分隔规则、段标题退回灰字。**现共 35 个变异，全红。**

### ⚠️⚠️ 网关弹窗第四批（第三轮）：对照表说明**按行**给出（品牌名被行尾切开）

用户原话：
> 「『客户端该填』为 CC Switch 需配置的映射档位，未登记的档位名称将被拒绝。」
> 这句话换行显示吧，现在这样接在上一句后面的话，CC Switch 这个单词会被截断。

**根因不是字符串写错，而是「交给浏览器断行」**：两句原先拼成一整串放进**同一个 `<p>`**，
浏览器在行尾按**空格**断行 —— `CC` 留在上一行、`Switch` 落到下一行。
⚠️ 所以 `toContain('CC Switch')` 在**修复前后都成立**（文案字符串一直是完整的），
**任何基于字符串的断言都测不出这个缺陷**。判据只能是**行结构**。

**修法**（与本报文既有 `gatewayStatusLines` 完全同款，弹窗顶部那三行就是这么给的）：
- 纯函数改为 `gatewayEffortsHintLines(models)` → **返回字符串数组**（空表时 1 行，正常 2 行）；
- 渲染层 `gatewayEffortsHintLines(models).map(...)` → **一行一个 `<p>`**；
- 保留 `gatewayEffortsHint(models)` = `lines.join('')`，只为不动既有断言/README 的一整串口径。
  ⚠️ **面板渲染绝不能调它** —— 一调就退回「拼成一整段交给浏览器断行」，
  正是本次缺陷的形态（用例里有 `source).toContain('gatewayEffortsHintLines(models)')`
  与 `.map(` 两条同时守着这一点）。

⚠️⚠️ **量测这种缺陷时踩到的两个坑（都会让检查「永远绿」）**：

1. **探针选错了元素 → 自证通过**。第一版用
   `querySelectorAll('.dim-jh-gatewaySection .dim-jh-modalHint').find(p => p.textContent.includes('CC Switch'))`
   选目标，而**第 1 段顶部那句「推荐使用 CC Switch 进行网关配置。」也含 `CC Switch`** ——
   `find` 命中的是它，量的是那句短文案（实测 `offsetWidth` 191、行矩形 1 个），
   于是第 3 段无论怎么排都报「未断开」。⇒ 判据必须**同时**锁「第 3 段」与「客户端该填」。
2. **块级元素的 `getClientRects()` 只返回外框一个矩形**，不是每行一个 ——
   用 `p.getClientRects().length` 判「占几行」是错的，会得到恒为 1 的假象。
   逐行矩形必须对 **Range** 取（`range.selectNodeContents(node)`）。

⚠️ **证明「修好了」必须同时给出修复前后的对照**，且要找到**真的会断开**的形态：
单点量测（560px）在**修复前后都不断开** —— 那样即使通过也证明不了任何事。
`measure-brand2.mjs` 的负向对照（`measure-brand-wrap-old.html`，把两句拼回一段）当前实测：

| | 含品牌名那行 | `CC`→`Switch` 的字符 top |
|---|---|---|
| 旧版（拼成一整段） | 高 **36px**（2 行） | **562 → 580（跨行）** |
| 新版（一行一个 `<p>`） | 高 **18px**（1 行） | 584 → 584（同一行） |

这正是用户截图里「CC Switch 被截断」的机制 —— 字符级证据比「看起来好了」可靠。

⚠️ **改动返回值形态必须同步改变异锚点**：`gatewayEffortsHint` 由「拼接字符串」改为
「行数组」后，`mutate-gateway-text.mjs` 里三条锚点（`+ '…';` → `'…',`）全部失配，
而失配在工具里的表现是**「存活」**（像锁失效，实为脚本滞后）。已修正，并新增两条变异：
「两句被拼回一整段」「渲染层把说明行 join 回一整段」。**现共 37 个变异，全红。**

⚠️ 写这种「同一句话在正文与注释里各出现一次」的变异时，**锚点必须带行首引号与行尾逗号**：
`String.replace` 只替换**第一处**，只写那句话会把**注释**改掉、真正的 UI 文案原样存活
⇒ 变异假存活。

⚠️ 另外两个本轮踩到的工具坑：
- 源码是 **CRLF**，锚点按 `\n` 写会全部「未命中」。既不能直接拿 `\n` 锚点匹配，
  也不能命中后整篇写成 LF（那会让**每一行**都变成「已修改」，diff 被污染成几千行）。
  做法：把锚点自身转成 CRLF，在**原始文本**上替换，行尾一律不动。
- 一次性反向验证脚本用完要 `--restore` 还原，并确认 `git diff --stat` 只有预期文件。

⚠️ **回归用例**（`openai-gateway-panel.spec.ts`）锁的是**行结构**而不是关键词：
`expect(lines).toHaveLength(2)`、`lines[1]` 含完整「「客户端该填」为 CC Switch 需配置的映射档位」、
`lines.some(l => l.includes('CC Switch'))`、且 `lines` 里不得有单独成行的 `'CC'` 或
以 `'Switch'` 开头的行。**反向验证过**：退回单行 → `toHaveLength(2)` 变红；
渲染层 join 回一段 → `.map(` 那条变红。

⚠️ 用例要**同时**锁「网关弹窗内不截断」与「模型列表那份紧凑样式没被顺手改坏」
（`.dim-jh-modelId` 仍须有 `max-width: 46%` + `ellipsis`、`.dim-jh-modelBadge` 仍须 `flex: none`）
—— 只锁前者的实现可以简单到「把全局那三条删掉」，那会把 478 条的模型列表撑坏。

⚠️ **写取规则体的 `rule()` 辅助函数时两个坑**（本次都踩到）：
1. 选择器里的 `.` 必须**全部**转义：`.dim-jh-modelId` 不转义会匹配 `Xdim-jh-modelId`；
2. 选择器必须锚定**行首或逗号之后**（`(?:^|[,\n])[ \t]*<sel>[ \t]*(?=[,{])[^{}]*\{…\}`）——
   `jet-hub-styles.js` 的注释里也会提到类名（如「`.dim-jh-modelId` 是 max-width 46%…」），
   不锚定就会把**注释**当成规则、取到下面那条无关规则体而给出假绿。

⚠️ **`jet-hub-styles.js` 整体是一个 JS 模板字符串，注释里不能出现反引号** ——
本次差点因此构建失败（新写的 9 处注释里都用了反引号括类名，已全部改成裸写）。
改完用 `Select-String -Pattern '\`'` 数一下：**全文只应有首尾那 2 个**。

⚠️ 已做**反向验证**（25 个变异，全部变红，见 `mutate-gateway-text.mjs`）：
两条文案各退旧版、丢「已开启」、丢「大小写」、丢边界句、删「需对照」图例、
空结果不给提示、两处搜索框各挪出展开区、两处收起不清搜索词、按钮 N 退回全量、
卡片建在全量模型上、少传一个 `searching`、少挂一个钩子类、胶囊退回截断、标题退回省略号。

**回归用例**：`tests/unit/reasoning-ladder.spec.ts`（强度序 / 三条规则 / 同族约束 /
反查往返）、`openai-gateway-messages.spec.ts`（翻译 + 通知 + 未知仍 400 + 不下发）、
`openai-gateway-models.spec.ts`（档位视图 + 容错 + 两处同源）、
`openai-gateway-server.spec.ts` 的「思考档位」段（HTTP 层实测那三条雷 + 对照表端点）、
`openai-gateway-panel.spec.ts`（对照表行与文案 / 搜索判据 / 不截断排版 / 按钮尺寸 / 胶囊）。

## ⚠⚠ RPC 的 `catch` **不得**把失败包成 `ok:true`（Issue IKJOZA）

**真实缺陷**（Gitee issue IKJOZA，外部用户报障 2026-10-05）：RPC `account.refresh`
续期失败时**不抛 RPC 错误**，而是回 `ok:true` + `value.success:false`。只判 `ok`
的调用方会把失败读成成功。报告方一个工具首版因此报出 **18 个「✅」而 17 个实为失败**，
真实错误是 `codearts 400 STS5.1806 invalid refresh token: 'the refresh token has been used'` /
`minimax refresh_token 已失效` / `raccoon 登录态已过期`。

**根因在客户端**：`plugin-src/management-rpc.mjs` 的 `unwrapRpcResult` 只判
`result.ok === true` 就返回 `value` ⇒ `ok:true` 就等于「成功」。

⚠ **全文件唯一的一处**：把 `jet-hub-rpc.ts` 里 37 个 `catch` 逐个核对过，另有 4 处
catch 后仍 `ok:true`，但它们**都带额外的判别字段**（或干脆不在 catch 里），
调用方不判就会误读 —— 本端点没有：

| 位置 | 形态 | 为何安全 |
|---|---|---|
| `login.poll` | `{done:false}` | 「用户尚未授权完」是正常中间态（catch 只包 `JSON.parse`，其余是 early-return） |
| `login.submitSms` | `{done:false, error}` | 验证码输错可重试，前端必判 `done` |
| `credits.permanentLock` | 广播失败仍 `ok:true` | 广播失败不影响已落盘 |
| `credits.claimAll` | 单号失败进 `results[]` | 「单个失败不中断整体」是设计语义 |

⇒ **判据**：`catch` 里的失败**若没有**额外的状态/结果字段，就是业务终态，必须回
`ok:false + error:{code, message}`（本仓库约定 `code:'bad-request'`）。
⚠ `reply()`（`jet-hub-rpc.ts` 末尾）只对 `ok:false` 补 `error.details: {}`。

⚠⚠ **`account.refresh` 是全仓库零调用方的端点**（取证：面板
`plugin-src/client/jet-hub.js` 的 42 处 `rpcCall(` 里没有它，另两处 `rpcCall(变量)`
的实参经追溯只有 `opencode.*` 四个方法；账号卡片按钮只有
测试/重测/重置/停用/代理/指纹/删除，**没有「刷新」**）。⇒ 改成 `ok:false` 是
**对仓库外调用方的破坏性契约变更**，仓库内零影响；原先误判的调用方会从「静默错」
变成 `unwrapRpcResult` **抛错**（`error.message` 即原异常文案），属预期的「提前炸」。
成功路径**未变**（仍是 `ok:true + value.success:true`），故不会误伤成功侧。
⇒ `RpcRefreshAccountResponse` 里的 `error?: string` 已**删掉**（失败不再有 value）。
⚠ **该类型目前仍是死类型**（`jet-hub-rpc.ts` import 了却没用，成功路径返回的是
无标注字面量，`tsconfig` 又没开 `noUnusedLocals`）⇒ 删字段**没有编译期保障**，
将来谁写回 `value.error` 也不会被 tsc 拦。收紧方式见 P4 的最小修法。

⚠⚠⚠ **本节写下的取证命令，在本节落地后即失效**：`git log -S "rpcCall('account.refresh'"`
会**自匹配修复提交本身**（本节与 `jet-hub-rpc.ts` 的注释都引用了该字面量），
实测返回 `68fb567`。这正是本文件反复强调的「判据里的注释必须与实测一致」的违反。
⇒ 复核该结论请用**只搜客户端源码**的形式：
`Select-String -Path plugin-src\client\*.js -Pattern "rpcCall\('account\."`（应零命中；
`account.refreshable` 是另一个字段名，不是端点）。在 `origin/master`（修复前）上
`-S` 零命中，这本身是它曾有效的证据。

⚠⚠ **既有测试为什么没抓住**：旧用例断言的是 `value.success === false` ——
**修复前的行为照样绿**。因为它锁的是「value 里能看到失败」，而缺陷的实质是
「失败被包装成了成功」。⇒ **新增失败路径用例必须断言顶层 `ok`，并额外断言
「失败时 `value` 根本不存在」**，否则又写出一条同义反复的用例。
回归用例在 `tests/unit/lobsterai-rpc-dispatch.spec.ts` 的「issue IKJOZA」段
（22 条：三条报告里出现的真实错误各锁 `ok:false` + `error.message` 原文、
**全部 13 个 provider 逐个覆盖**、`error.code` 约定、成功路径不受影响）。
⚠ 已做**反向验证**：把 catch 改回 `{ok:true, value:{success:false}}` → **22 条变红**。
⚠⚠ **provider 与文案必须对位**：初版把 raccoon 的报错挂在 `trae` 上，因为
`makeThrowingStub` 当时只造了 7 个桩 —— 挂错 provider 就等于**该分支根本没被走到**，
零覆盖。`registerJetHubRpc` 有 **13 个必填 provider 形参**（位置传参，历史上因
少传/插队错位复发 6 次），替身**必须传满**，否则 `undefined` 会被真调用。

⚠⚠ **「账号卡片刷新按钮」这个失实说法散布在约 25 处**（`README.md`、
`AGENTS.md`、11 个 `*-auth.ts` 的签名注释、`expiry-sync.ts`、`types.ts`、
`docs/adding-a-new-provider.md`、6 处测试注释）—— 该按钮**从来不存在**。
首轮只订正了 4 处就被审计打回（其中 3 处就在被改的 handler 内部、与新写的
「没有刷新按钮」上下打架）。⇒ **这类订正要一次做完**：先
`Select-String -Path src,tests,docs -Pattern "账号卡片.{0,6}刷新|用户点[「『]刷新"`
全量枚举再逐条改，别只改搜到的头几处。⚠ `docs/superpowers/plans/` 下的是历史
设计快照（记录当时的过程），**不必**订正；`plugin-src/` 里的「点刷新」多指
模型列表/额度/徽标的**真实**刷新按钮，**不要**误改。
## ⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IKITT9）

**真实缺陷**（用户报障）：带截图的会话攒到 **36 张**后**每轮都失败且不可恢复**，
自动压缩试 3 次全灭，只能新建会话：

```
buddy: 内容过长，请精简或新建任务 prompt is too long: 100001 tokens > 100000 maximum
```

⚠️ **这个 `100000` 不是上下文窗口**（`src/product.ts` 给 `deepseek-v4.1-flash`
声明的是 **1,000,000**）。报障者同一会话**纯文本 prompt 到 345,687 仍被正常接受**，
且本机 11,351 次成功请求的图片 token **无一越过 10 万**（最大 96,537 = 35 张，
36 张正好顶穿）。它是网关对**单次请求图片视觉 token 总量**的另一道限制，
计价 ≈ **617 px / token**（1721×997 ≈ 2,781 token/张）。

⇒ **排查这类"内容过长"先看数字对不对得上上下文窗口**：对不上就是别的预算，
别去改 `contextWindow`（那只会让 DSH 更早触发压缩，反而更糟）。

### 三条修复与其理由

1. **按预算缩放**（`src/image-budget.ts`）：每张固定 **640,000 px**（≈1,037 token，
   约 96 张才撞墙，且 1051×608 上 UI 小字仍可辨认 —— **不要调更小**）。
   ⚠️ **为什么是"每张固定"而不是"按本次张数分摊"**：附件服务的请求版本
   **按目标尺寸缓存**（`readImageRequest` 的缓存身份含附件 id、变换版本、
   目标尺寸、字节目标）。尺寸若随"这条会话现在有几张图"浮动，
   同一附件每次派生不同 `variantId` → 缓存反复击穿、每轮重编码，
   而且用户无法预测一张图被缩成多大。
2. **桥接 `ctx.attachments.readImageRequest(ref, target)`**（`src/index.ts` 的
   `makeReadImageRequest`）：缩放/编码交给附件服务（alpha→WebP、不透明→JPEG、
   85/75/60 质量阶梯），插件只选目标。
   ⚠️ **不可用一律返回 `undefined` 而不是抛错**，适配器据此**回退原图**：
   服务没装、老宿主没有该方法、后端拒绝投影
   （`ATTACHMENT_PROJECTION_UNSUPPORTED`）、附件引用缺 `width`/`height` ——
   四种都必须发原图。缩放是优化，**绝不能变成新的故障源**。
   ⚠️ **两层都要兜异常**：写用例时实测到"只靠桥接层吞异常"不够
   （桥接是运行时约定、类型系统不保证），适配器的 `projectRequestImage`
   自己也 `try/catch` 返回 `undefined`。
   ⚠️ 但**不得削弱原有护栏**：`readImage` 读不到字节仍必须抛
   `UNSUPPORTED_CONTENT`（那是"静默丢图"回归防线）。
3. **11115 的分类不得依赖 `extError` 是否存在**：harness 的
   `isContextWindowExceededError` 五个分支都要求出现 `context` / `for this model`
   之类字样，实测对以下三种形态**全部返回 false**（只有带
   `extError.code=context_length_exceeded` 的那份才命中）：
   `prompt is too long: N tokens > M maximum`／拼上中文文案的整行／
   `{code,msg,displayMsg}` 三件套。于是报障者同一会话里逐字相同的错误
   一会儿 `CONTEXT_WINDOW_EXCEEDED`、一会儿 `INVALID_REQUEST`。

   ⚠️ **漏判的代价是不对称的**，所以方向取"宁可多判一次溢出"：
   `INVALID_REQUEST` **不在** `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
   更关键的是 `dsh-compaction-basic` 的 request-error listener
   **第一行就是** `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
   → 连"试一次压缩"的机会都没有，会话每轮直接报废。归成溢出的最坏结果
   只是一次无效的压缩尝试。
   ⚠️ 补的判据必须**窄**：同时要求「prompt is too long」与「N tokens > M」，
   只认前者会把别的内容类 400 误判成溢出（有用例锁着）。

### 范围与**有意未做**项（别当成漏改）

**实测过的九家**（2026-09-28，用 `tests/fixtures/test.png` 2560×1600 = 4.10M px/张
≈6,639 token/张，逐级加张数、每次只加图片、文本固定）：

| provider | 边界 | 失败形态 | 撞的是什么 |
|---|---|---|---|
| **buddy / workbuddy** | **15 张** | `prompt is too long: 100001 tokens > 100000 maximum` | **图片视觉 token 预算** |
| **raccoon** | **4 张** | `HTTP_413: request body exceeds 10MB` | **请求体字节**（10 MB 硬限）→ 缩放后 **24 张全过** ✅ |
| **qoder** | 8 张过 / **15 张** | `TRANSPORT: fetch failed`（≈57 MiB） | **请求体体积** → 缩放后 **24 张全过** ✅ |
| **lobsterai** | 12 张过 / **13 张** | `SERVER code=500`（≈50 MiB） | **请求体体积**（不是预算 —— 500 不是准入报文）→ 缩放后 **24 张全过** ✅ |
| **cline** | 24 张（≈159K token）全过 / **32 张** | `TRANSPORT` | **请求体体积** → 缩放后 **32 张全过** ✅ |
| **loomy** | **24 张全过** | — | 未撞墙（本 fixture 下），故未接缩放 |
| **trae** | **未探到边界**（本轮只测了 1 张，通过） | — | ⚠️ **上一轮的「1 张即 4001 仅可见但不可调用」已被推翻**，见下 |
| codearts | 未测 | — | 其 `deepseek-v4` 系是华为云免费福利额度，非用户候选模型 |

⚠️ **trae 那格是本轮最该记住的教训**：上一轮同一账号对
`deepseek-v4.1-flash` 与 `glm-5.3-flash` 都回 `4001 param is invalid`
（适配器诊断「仅可见但不可调用」），据此登记成「探测无效、拿不到阈值就不定值」。
**本轮同一账号、同一模型，1 张直接成功，缩放后 24 张也全过** ——
说明那是**账号/服务端的临时状态**，不是模型的固有属性。
⇒ 与 Qoder「无签到」（!IKIRTT 之前的误判）同型：**「某次实测没看到」不能推广成
「不存在」**。引用一条否定性结论时，必须带上「何时、哪个账号、什么形态」，
并在下次探测时**先重验这条否定结论本身**，而不是把它当前提。
⚠️ 但**也不要因此就给 trae 定预算值**：它的原图边界仍未探（本轮只测 1 张原图），
**拿不到阈值就不定值**这条规矩不变。

⇒ **只有腾讯系真有「图片 token 预算」这道约束**，其余各家撞的都是
**请求体体积**（各家阈值不同：raccoon 10 MB、lobsterai ≈50 MiB、
qoder ≈57 MiB、cline ≈122 MiB）。两种约束**只有缩放图片这一个共同解法**，
但**旋钮不同**：token 预算看**像素**，体积限制看**编码字节**。所以：

- **已接缩放的七处**：buddy / workbuddy（像素 640,000，字节默认 2 MiB）、
  raccoon（像素 + **字节 512 KB**，因它硬限 10 MB）、
  qoder 与 qodercn（**同一个 `QoderAdapter` 类**，像素 + 字节 1 MiB —— 改一处两站同时受益）、
  lobsterai、cline（各 像素 + 1 MiB）。
- ⚠️ **字节目标各不相同是有意的**：raccoon 512 KB（10 MB 配额要撑到 14 张）、
  qoder / lobsterai / cline 1 MiB、buddy 2 MiB。**别合并成一个常量**，
  也别把 buddy 的 640,000 当全局像素预算推给别家 ——
  这正是本仓库 `endpoint` 那条教训的形状。
- **未接的两家**：loomy（实测 24 张全过，无证据说明它有约束）、
  trae（⚠️ **理由已变**：原来说「探测被『仅可见但不可调用』挡住」，
  而本轮该账号同一模型已能正常收图 —— 旧理由失效，但**新理由仍然成立**：
  它的**原图边界从未探过**（本轮只测了 1 张原图就通过），
  **拿不到阈值就不定值**这条规矩不变）。
  ⚠️ 别"为了统一"给它们塞一个猜出来的预算。
- ⚠️ **接线漏改的教训**：本轮先改了适配器**却没在宿主桥接**，
  结果 qoder / qodercn / lobsterai / cline 四家的修复**静默不生效**
  （适配器有 `readImageRequest` 选项但 `index.ts` 没传 = 永远走原图路径）。
  是 `tests/unit/image-budget.spec.ts` 里那条「宿主侧桥接计数」断言抓出来的。
  ⇒ 接新 provider 时**适配器 + 宿主桥接两处都要改**，用例两处都锁。
- ⚠️ **探针自身的接线错误会被「回退原图」掩盖**（本轮真踩到，代价是一轮 90 秒的
  真机探测得出**错误结论**）：e2e 里把 `makeScaleBridge(fixture)`（一个
  `{bridge, stats}` 包装对象）误当函数注入 `readImageRequest`，适配器调用它必然抛错，
  而 `projectRequestImage` 的 `try/catch` 把异常兜成「**回退原图**」——
  症状于是是「**缩放后照样 413**」，看起来像字节目标定小了，实际是根本没缩放。
  ⇒ 因此 `makeScaleBridge` 返回 `stats` 记录每次派生，
  **用例必须先断言 `stats.length > 0` 再断言结果**。
  推而广之：**任何"回退到旧行为"的兜底都会把接线错误伪装成产品缺陷**，
  这类兜底旁边必须有一条「兜底是否被触发」的可观测证据。

⚠️ **探测方法论**（这轮踩出来的，重测时必须保持）：
- **必须先跑 0 张基线**。第一版探针直接上 15 张，qoder 报 `TRANSPORT`、
  raccoon 报 `AUTH 200003` —— 两个都不是图片问题（raccoon 那个账号缺
  `office_identity`，qoder 是凭据过期），却被读成「撞墙了」。
- **只有 `prompt is too long: N tokens > M maximum` 这种报文才算图片预算**；
  `413` / `TRANSPORT` / `500` 都是体积或稳定性问题（`classifyFailure` 已分类）。
- **要逐个账号验号**：实测本机 8 个 qoder 账号里 4 个 refresh_token 已失效、
  3 个当日额度耗尽，只有 1 个可用 —— 拿 `[0]` 就用会得到假的「探测失败」。
- **0 张基线的结论必须驱动「跳过」而不是「失败」**（`assertBaselineUsable`）。
  本轮为省额度把几个用例改造成「只测缩放后」，**顺手把 0 张基线删了** ——
  于是 cline 的当日免费额度耗尽（`429 Daily free limit reached … 19h 55m`）
  被记成「缩放后仍被拒」，看起来像产品缺陷。基线一条请求几乎不花额度，
  却能把「账号不可用」与「图片链路有问题」彻底分开。
  ⚠️ 判据**只看基线**：基线通过后任何失败都算真失败，不许「一失败就跳过」
  （那就成了静默空测，比误报更糟）。
- ⚠️ **「失败就回退到旧行为」的兜底会把接线错误伪装成产品缺陷**（本轮真踩到）：
  e2e 里把 `makeScaleBridge(fixture)`（`{bridge, stats}` 包装对象）误当函数注入
  `readImageRequest`，适配器一调用就抛错，`projectRequestImage` 的 `try/catch`
  把异常兜成「回退原图」→ 症状是「**缩放后照样 413**」，看着像字节目标定小了，
  实际是**根本没缩放**，白跑一轮 90 秒真机探测并得出错误结论。
  ⇒ 探针必须先断言 `stats.length > 0`（缩放真被调用），再断言结果。

### ⚠️ 待观察：`cline-auth.spec.ts` 的一次无法复现的失败（别忽略，也别当成已修）

本轮某次 `pnpm test` 出现过 2 条失败，都在
`tests/unit/cline-auth.spec.ts > ClineAuth refreshAll`：

- 「只按 refreshable 过滤，**不看 enabled**」
- 「按需续期（RPC account.refresh）成功后把新 expiresAt 写回账号池」

**当时的现场**：同一轮我正在并发跑真机图片 e2e（长跑、重负载）。
**之后的验证**：单独跑该文件 26 条全过；全量连跑 3 次均 2833 全过；
`--no-file-parallelism` 连跑 5 次全过。**未能复现**。

**已排除的解释**（都查过，不成立）：
- 不是本轮改动引起 —— `git status` 显示未触碰 `cline-auth.ts` 及其 spec；
- 不是「5 分钟凭据到期」—— `shouldRefreshNow` 对 `now+300_000` 恒为「该刷」，
  该值不会随墙钟翻转；且 `isClineRefreshable` 只看 `refresh_token` 存在性；
- 不是文件系统/环境依赖 —— 该用例用全内存 `Context` + `FakeCredentials`
  + `AccountPool`（`store.kind === 'memory'`）；
- 不是 `services` 数组泄漏 —— 已有 `afterEach` 的 `splice(0)` 清理。

**下次复现时要看的东西**（别再从零猜）：
① 失败时 `fetcher` 的**实际调用次数**（期望 2，推测会得到 0）；
② 两条失败是否**同时**出现（若是，指向 `refreshAll` 早退而非断言问题）；
③ `pool.listAccounts('cline')` 返回的条目数；
④ 当时是否在并发跑 e2e —— 若只在重负载下出现，方向是**测试的时序假设**
   而非产品逻辑（该 spec 的 `AccountPool` 用 `void credentials.set(...)`
   预热，见 `makeCtx`，这是目前唯一可疑但未证实的点）。

⚠️ **不要因为"跑几次都过"就删掉这条记录**，也不要假装修好了 ——
它可能是重负载下才暴露的真实竞态，记着现场比假装干净更有价值。
  ⚠️ 且**不能强制续期才肯用**（第一版的 bug）：刚登录的新号续期反被拒，
  于是被跳过，最后落到一个签名有效但额度耗尽的旧号上。判据是
  「**先看是否过期**，未过期直接用；再用一次无图请求验号」。
- **张数必须互不相同的 `attachmentId`**：`collectImages` 按 id 去重，
  复用同一 id 会把 15 张压成 1 张，探针「顺利跑完」却一点压力没造出来。

⚠️ **未实现 `imageRequestPricing`**（issue 建议的第 4 步，仍然不做）：
它需要「网关每张图的视觉 token 计价公式」，而我们**只有从失败点反推的
≈617 px/token**（buddy 15 张撞 100,000 时估算 99,579，差 0.4% —— 已足够
用来定预算，但**不足以**用来喂压缩器：猜错方向会让压缩过早或过晚触发）。
缩放已让 15 张从 100,038 降到约 46,903，触发条件本身消失了。
⚠️ 顺带记一条已核实的机制：不实现它时 `dsh-token-meter` 对图片走
`estimateStructuralBlock`（**只按引用 JSON 的字符数**计价，一张大图 ≈56 token），
而压缩阈值是 `min(contextWindow×0.8, …)` = 800,000 —— 所以「图片压力」
在 token meter 眼里几乎不可见，**指望自动压缩兜底是不成立的**
（这正是报障会话里"压缩试了 3 次全失败"的机制解释）。

测试：`tests/unit/image-budget.spec.ts`（29 条：几何含"小图不放大/细长图/非法输入"、
四种回退路径、产品级预算、三条分类护栏、`projectRequestImage` 共用投影、
raccoon 用**自己的** 512 KB 而非 buddy 的 2 MiB、**七处接线断言**）。
⚠️ 已做**反向验证**：去掉 cline 缩放 → 接线断言变红（报「未走共享投影」）；
去掉新增分类判据 → 1 条变红（报 `expected 'INVALID_REQUEST' to be
'CONTEXT_WINDOW_EXCEEDED'`，非同义反复）。
e2e：`tests/e2e/image-burst-cross-provider.e2e.spec.ts`（跨家探测 + 腾讯两站的
复现/修复/可辨认性验证），**消耗真实积分**；闸门与 fixture 说明见
`tests/e2e/README.md`。
⚠️ 曾有一个 `image-request-probe.e2e.spec.ts` 专测腾讯系，已**并入**上面那个文件 ——
它的 fixture 加载、YAML 凭据解析、缩放桥接与张数序列与后者**完全重复**
（两份实现必然漂移，是本仓库反复告诫的形状），而它两条独特断言
（buddy 的 `CONTEXT_WINDOW_EXCEEDED` 归类、缩放后仍可辨认）都已搬过去，
且现在两站都覆盖（原来只测 buddy，**workbuddy 从未被端到端验证过**）。

## 单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤

腾讯系两个端点（scoped `/console/enterprises/personal/models` 与 `/v3/config`）
**都下发 `data.models[].maxOutputTokens`**。它是权威的单次请求输出额度，适配器
**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`（DSH 只在调用方未显式给值时用声明的默认值兜底）。

**真实缺陷**（用户报障）：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被
截断，`turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。
根因不是「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当作
`isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关
默认值，而网关默认恰好就是 **32000**（远端 `auto` / `glm-4.6` 等声明的即为此值）。
远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。

要点：

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值（编大被上游拒、编小无谓截断）
- ⚠️ **远端是外部输入，非法值必须过滤**：`positiveMaxTokens` 只放行安全正整数。
  DSH 对 `defaultMaxTokens` 有硬校验，`0` / 负数 / `NaN` 会直接抛
  `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）
- 实测（2026-09-19）各端点值不完全一致：`deepseek-v4.1-flash` 在 scoped 端点
  为 128000、`/v3/config` 为 131072。与 `maxInputTokens` 同策略 —— 采信实际
  命中的那个端点，**不做跨端点取大**
- 网关**确实接受且精确生效**：`max_tokens: 64` 会精确截断在 64
  （`finish_reason=length`、`completion_tokens=64`）。验证脚本
  `scripts/verify-max-tokens.mjs`（用国际版限免的 v4.1-flash，`credit: 0`）
- `reasoning_tokens` **计入** `completion_tokens`：思考内容与正文共享同一额度，
  故思考开到 `max` 时正文更早撞上限。「单次请求」≠「单轮」——每 step 独立预算，
  超长文件仍需拆多步写
- 排查脚本（均为**只读 GET**，零模型额度）：`scripts/dump-max-output.mjs`
  导出全模型 `id → maxOutputTokens`；`scripts/probe-max-output.mjs` 打印原始条目

## 单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤

腾讯系两个端点（scoped `/console/enterprises/personal/models` 与 `/v3/config`）
**都下发 `data.models[].maxOutputTokens`**。它是权威的单次请求输出额度，适配器
**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`（DSH 只在调用方未显式给值时用声明的默认值兜底）。

**真实缺陷**（用户报障）：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被
截断，`turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。
根因不是「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当作
`isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关
默认值，而网关默认恰好就是 **32000**（远端 `auto` / `glm-4.6` 等声明的即为此值）。
远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。

要点：

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值（编大被上游拒、编小无谓截断）
- ⚠️ **远端是外部输入，非法值必须过滤**：`positiveMaxTokens` 只放行安全正整数。
  DSH 对 `defaultMaxTokens` 有硬校验，`0` / 负数 / `NaN` 会直接抛
  `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）
- 实测（2026-09-19）各端点值不完全一致：`deepseek-v4.1-flash` 在 scoped 端点
  为 128000、`/v3/config` 为 131072。与 `maxInputTokens` 同策略 —— 采信实际
  命中的那个端点，**不做跨端点取大**
- 网关**确实接受且精确生效**：`max_tokens: 64` 会精确截断在 64
  （`finish_reason=length`、`completion_tokens=64`）。验证脚本
  `scripts/verify-max-tokens.mjs`（用国际版限免的 v4.1-flash，`credit: 0`）
- `reasoning_tokens` **计入** `completion_tokens`：思考内容与正文共享同一额度，
  故思考开到 `max` 时正文更早撞上限。「单次请求」≠「单轮」——每 step 独立预算，
  超长文件仍需拆多步写
- 排查脚本（均为**只读 GET**，零模型额度）：`scripts/dump-max-output.mjs`
  导出全模型 `id → maxOutputTokens`；`scripts/probe-max-output.mjs` 打印原始条目
## ⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IKITT9）

**真实缺陷**（用户报障）：带截图的会话攒到 **36 张**后**每轮都失败且不可恢复**，
自动压缩试 3 次全灭，只能新建会话：

```
buddy: 内容过长，请精简或新建任务 prompt is too long: 100001 tokens > 100000 maximum
```

⚠️ **这个 `100000` 不是上下文窗口**（`src/product.ts` 给 `deepseek-v4.1-flash`
声明的是 **1,000,000**）。报障者同一会话**纯文本 prompt 到 345,687 仍被正常接受**，
且本机 11,351 次成功请求的图片 token **无一越过 10 万**（最大 96,537 = 35 张，
36 张正好顶穿）。它是网关对**单次请求图片视觉 token 总量**的另一道限制，
计价 ≈ **617 px / token**（1721×997 ≈ 2,781 token/张）。

⇒ **排查这类"内容过长"先看数字对不对得上上下文窗口**：对不上就是别的预算，
别去改 `contextWindow`（那只会让 DSH 更早触发压缩，反而更糟）。

### 三条修复与其理由

1. **按预算缩放**（`src/image-budget.ts`）：每张固定 **640,000 px**（≈1,037 token，
   约 96 张才撞墙，且 1051×608 上 UI 小字仍可辨认 —— **不要调更小**）。
   ⚠️ **为什么是"每张固定"而不是"按本次张数分摊"**：附件服务的请求版本
   **按目标尺寸缓存**（`readImageRequest` 的缓存身份含附件 id、变换版本、
   目标尺寸、字节目标）。尺寸若随"这条会话现在有几张图"浮动，
   同一附件每次派生不同 `variantId` → 缓存反复击穿、每轮重编码，
   而且用户无法预测一张图被缩成多大。
2. **桥接 `ctx.attachments.readImageRequest(ref, target)`**（`src/index.ts` 的
   `makeReadImageRequest`）：缩放/编码交给附件服务（alpha→WebP、不透明→JPEG、
   85/75/60 质量阶梯），插件只选目标。
   ⚠️ **不可用一律返回 `undefined` 而不是抛错**，适配器据此**回退原图**：
   服务没装、老宿主没有该方法、后端拒绝投影
   （`ATTACHMENT_PROJECTION_UNSUPPORTED`）、附件引用缺 `width`/`height` ——
   四种都必须发原图。缩放是优化，**绝不能变成新的故障源**。
   ⚠️ **两层都要兜异常**：写用例时实测到"只靠桥接层吞异常"不够
   （桥接是运行时约定、类型系统不保证），适配器的 `projectRequestImage`
   自己也 `try/catch` 返回 `undefined`。
   ⚠️ 但**不得削弱原有护栏**：`readImage` 读不到字节仍必须抛
   `UNSUPPORTED_CONTENT`（那是"静默丢图"回归防线）。
3. **11115 的分类不得依赖 `extError` 是否存在**：harness 的
   `isContextWindowExceededError` 五个分支都要求出现 `context` / `for this model`
   之类字样，实测对以下三种形态**全部返回 false**（只有带
   `extError.code=context_length_exceeded` 的那份才命中）：
   `prompt is too long: N tokens > M maximum`／拼上中文文案的整行／
   `{code,msg,displayMsg}` 三件套。于是报障者同一会话里逐字相同的错误
   一会儿 `CONTEXT_WINDOW_EXCEEDED`、一会儿 `INVALID_REQUEST`。

   ⚠️ **漏判的代价是不对称的**，所以方向取"宁可多判一次溢出"：
   `INVALID_REQUEST` **不在** `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
   更关键的是 `dsh-compaction-basic` 的 request-error listener
   **第一行就是** `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
   → 连"试一次压缩"的机会都没有，会话每轮直接报废。归成溢出的最坏结果
   只是一次无效的压缩尝试。
   ⚠️ 补的判据必须**窄**：同时要求「prompt is too long」与「N tokens > M」，
   只认前者会把别的内容类 400 误判成溢出（有用例锁着）。

### 范围与**有意未做**项（别当成漏改）

**实测过的九家**（2026-09-28，用 `tests/fixtures/test.png` 2560×1600 = 4.10M px/张
≈6,639 token/张，逐级加张数、每次只加图片、文本固定）：

| provider | 边界 | 失败形态 | 撞的是什么 |
|---|---|---|---|
| **buddy / workbuddy** | **15 张** | `prompt is too long: 100001 tokens > 100000 maximum` | **图片视觉 token 预算** |
| **raccoon** | **4 张** | `HTTP_413: request body exceeds 10MB` | **请求体字节**（10 MB 硬限）→ 缩放后 **24 张全过** ✅ |
| **qoder** | 8 张过 / **15 张** | `TRANSPORT: fetch failed`（≈57 MiB） | **请求体体积** → 缩放后 **24 张全过** ✅ |
| **lobsterai** | 12 张过 / **13 张** | `SERVER code=500`（≈50 MiB） | **请求体体积**（不是预算 —— 500 不是准入报文）→ 缩放后 **24 张全过** ✅ |
| **cline** | 24 张（≈159K token）全过 / **32 张** | `TRANSPORT` | **请求体体积** → 缩放后 **32 张全过** ✅ |
| **loomy** | **24 张全过** | — | 未撞墙（本 fixture 下），故未接缩放 |
| **trae** | **未探到边界**（本轮只测了 1 张，通过） | — | ⚠️ **上一轮的「1 张即 4001 仅可见但不可调用」已被推翻**，见下 |
| codearts | 未测 | — | 其 `deepseek-v4` 系是华为云免费福利额度，非用户候选模型 |

⚠️ **trae 那格是本轮最该记住的教训**：上一轮同一账号对
`deepseek-v4.1-flash` 与 `glm-5.3-flash` 都回 `4001 param is invalid`
（适配器诊断「仅可见但不可调用」），据此登记成「探测无效、拿不到阈值就不定值」。
**本轮同一账号、同一模型，1 张直接成功，缩放后 24 张也全过** ——
说明那是**账号/服务端的临时状态**，不是模型的固有属性。
⇒ 与 Qoder「无签到」（!IKIRTT 之前的误判）同型：**「某次实测没看到」不能推广成
「不存在」**。引用一条否定性结论时，必须带上「何时、哪个账号、什么形态」，
并在下次探测时**先重验这条否定结论本身**，而不是把它当前提。
⚠️ 但**也不要因此就给 trae 定预算值**：它的原图边界仍未探（本轮只测 1 张原图），
**拿不到阈值就不定值**这条规矩不变。

⇒ **只有腾讯系真有「图片 token 预算」这道约束**，其余各家撞的都是
**请求体体积**（各家阈值不同：raccoon 10 MB、lobsterai ≈50 MiB、
qoder ≈57 MiB、cline ≈122 MiB）。两种约束**只有缩放图片这一个共同解法**，
但**旋钮不同**：token 预算看**像素**，体积限制看**编码字节**。所以：

- **已接缩放的七处**：buddy / workbuddy（像素 640,000，字节默认 2 MiB）、
  raccoon（像素 + **字节 512 KB**，因它硬限 10 MB）、
  qoder 与 qodercn（**同一个 `QoderAdapter` 类**，像素 + 字节 1 MiB —— 改一处两站同时受益）、
  lobsterai、cline（各 像素 + 1 MiB）。
- ⚠️ **字节目标各不相同是有意的**：raccoon 512 KB（10 MB 配额要撑到 14 张）、
  qoder / lobsterai / cline 1 MiB、buddy 2 MiB。**别合并成一个常量**，
  也别把 buddy 的 640,000 当全局像素预算推给别家 ——
  这正是本仓库 `endpoint` 那条教训的形状。
- **未接的两家**：loomy（实测 24 张全过，无证据说明它有约束）、
  trae（⚠️ **理由已变**：原来说「探测被『仅可见但不可调用』挡住」，
  而本轮该账号同一模型已能正常收图 —— 旧理由失效，但**新理由仍然成立**：
  它的**原图边界从未探过**（本轮只测了 1 张原图就通过），
  **拿不到阈值就不定值**这条规矩不变）。
  ⚠️ 别"为了统一"给它们塞一个猜出来的预算。
- ⚠️ **接线漏改的教训**：本轮先改了适配器**却没在宿主桥接**，
  结果 qoder / qodercn / lobsterai / cline 四家的修复**静默不生效**
  （适配器有 `readImageRequest` 选项但 `index.ts` 没传 = 永远走原图路径）。
  是 `tests/unit/image-budget.spec.ts` 里那条「宿主侧桥接计数」断言抓出来的。
  ⇒ 接新 provider 时**适配器 + 宿主桥接两处都要改**，用例两处都锁。
- ⚠️ **探针自身的接线错误会被「回退原图」掩盖**（本轮真踩到，代价是一轮 90 秒的
  真机探测得出**错误结论**）：e2e 里把 `makeScaleBridge(fixture)`（一个
  `{bridge, stats}` 包装对象）误当函数注入 `readImageRequest`，适配器调用它必然抛错，
  而 `projectRequestImage` 的 `try/catch` 把异常兜成「**回退原图**」——
  症状于是是「**缩放后照样 413**」，看起来像字节目标定小了，实际是根本没缩放。
  ⇒ 因此 `makeScaleBridge` 返回 `stats` 记录每次派生，
  **用例必须先断言 `stats.length > 0` 再断言结果**。
  推而广之：**任何"回退到旧行为"的兜底都会把接线错误伪装成产品缺陷**，
  这类兜底旁边必须有一条「兜底是否被触发」的可观测证据。

⚠️ **探测方法论**（这轮踩出来的，重测时必须保持）：
- **必须先跑 0 张基线**。第一版探针直接上 15 张，qoder 报 `TRANSPORT`、
  raccoon 报 `AUTH 200003` —— 两个都不是图片问题（raccoon 那个账号缺
  `office_identity`，qoder 是凭据过期），却被读成「撞墙了」。
- **只有 `prompt is too long: N tokens > M maximum` 这种报文才算图片预算**；
  `413` / `TRANSPORT` / `500` 都是体积或稳定性问题（`classifyFailure` 已分类）。
- **要逐个账号验号**：实测本机 8 个 qoder 账号里 4 个 refresh_token 已失效、
  3 个当日额度耗尽，只有 1 个可用 —— 拿 `[0]` 就用会得到假的「探测失败」。
- **0 张基线的结论必须驱动「跳过」而不是「失败」**（`assertBaselineUsable`）。
  本轮为省额度把几个用例改造成「只测缩放后」，**顺手把 0 张基线删了** ——
  于是 cline 的当日免费额度耗尽（`429 Daily free limit reached … 19h 55m`）
  被记成「缩放后仍被拒」，看起来像产品缺陷。基线一条请求几乎不花额度，
  却能把「账号不可用」与「图片链路有问题」彻底分开。
  ⚠️ 判据**只看基线**：基线通过后任何失败都算真失败，不许「一失败就跳过」
  （那就成了静默空测，比误报更糟）。
- ⚠️ **「失败就回退到旧行为」的兜底会把接线错误伪装成产品缺陷**（本轮真踩到）：
  e2e 里把 `makeScaleBridge(fixture)`（`{bridge, stats}` 包装对象）误当函数注入
  `readImageRequest`，适配器一调用就抛错，`projectRequestImage` 的 `try/catch`
  把异常兜成「回退原图」→ 症状是「**缩放后照样 413**」，看着像字节目标定小了，
  实际是**根本没缩放**，白跑一轮 90 秒真机探测并得出错误结论。
  ⇒ 探针必须先断言 `stats.length > 0`（缩放真被调用），再断言结果。

### ⚠️ 待观察：`cline-auth.spec.ts` 的一次无法复现的失败（别忽略，也别当成已修）

本轮某次 `pnpm test` 出现过 2 条失败，都在
`tests/unit/cline-auth.spec.ts > ClineAuth refreshAll`：

- 「只按 refreshable 过滤，**不看 enabled**」
- 「按需续期（RPC account.refresh）成功后把新 expiresAt 写回账号池」

**当时的现场**：同一轮我正在并发跑真机图片 e2e（长跑、重负载）。
**之后的验证**：单独跑该文件 26 条全过；全量连跑 3 次均 2833 全过；
`--no-file-parallelism` 连跑 5 次全过。**未能复现**。

**已排除的解释**（都查过，不成立）：
- 不是本轮改动引起 —— `git status` 显示未触碰 `cline-auth.ts` 及其 spec；
- 不是「5 分钟凭据到期」—— `shouldRefreshNow` 对 `now+300_000` 恒为「该刷」，
  该值不会随墙钟翻转；且 `isClineRefreshable` 只看 `refresh_token` 存在性；
- 不是文件系统/环境依赖 —— 该用例用全内存 `Context` + `FakeCredentials`
  + `AccountPool`（`store.kind === 'memory'`）；
- 不是 `services` 数组泄漏 —— 已有 `afterEach` 的 `splice(0)` 清理。

**下次复现时要看的东西**（别再从零猜）：
① 失败时 `fetcher` 的**实际调用次数**（期望 2，推测会得到 0）；
② 两条失败是否**同时**出现（若是，指向 `refreshAll` 早退而非断言问题）；
③ `pool.listAccounts('cline')` 返回的条目数；
④ 当时是否在并发跑 e2e —— 若只在重负载下出现，方向是**测试的时序假设**
   而非产品逻辑（该 spec 的 `AccountPool` 用 `void credentials.set(...)`
   预热，见 `makeCtx`，这是目前唯一可疑但未证实的点）。

⚠️ **不要因为"跑几次都过"就删掉这条记录**，也不要假装修好了 ——
它可能是重负载下才暴露的真实竞态，记着现场比假装干净更有价值。
  ⚠️ 且**不能强制续期才肯用**（第一版的 bug）：刚登录的新号续期反被拒，
  于是被跳过，最后落到一个签名有效但额度耗尽的旧号上。判据是
  「**先看是否过期**，未过期直接用；再用一次无图请求验号」。
- **张数必须互不相同的 `attachmentId`**：`collectImages` 按 id 去重，
  复用同一 id 会把 15 张压成 1 张，探针「顺利跑完」却一点压力没造出来。

⚠️ **未实现 `imageRequestPricing`**（issue 建议的第 4 步，仍然不做）：
它需要「网关每张图的视觉 token 计价公式」，而我们**只有从失败点反推的
≈617 px/token**（buddy 15 张撞 100,000 时估算 99,579，差 0.4% —— 已足够
用来定预算，但**不足以**用来喂压缩器：猜错方向会让压缩过早或过晚触发）。
缩放已让 15 张从 100,038 降到约 46,903，触发条件本身消失了。
⚠️ 顺带记一条已核实的机制：不实现它时 `dsh-token-meter` 对图片走
`estimateStructuralBlock`（**只按引用 JSON 的字符数**计价，一张大图 ≈56 token），
而压缩阈值是 `min(contextWindow×0.8, …)` = 800,000 —— 所以「图片压力」
在 token meter 眼里几乎不可见，**指望自动压缩兜底是不成立的**
（这正是报障会话里"压缩试了 3 次全失败"的机制解释）。

测试：`tests/unit/image-budget.spec.ts`（29 条：几何含"小图不放大/细长图/非法输入"、
四种回退路径、产品级预算、三条分类护栏、`projectRequestImage` 共用投影、
raccoon 用**自己的** 512 KB 而非 buddy 的 2 MiB、**七处接线断言**）。
⚠️ 已做**反向验证**：去掉 cline 缩放 → 接线断言变红（报「未走共享投影」）；
去掉新增分类判据 → 1 条变红（报 `expected 'INVALID_REQUEST' to be
'CONTEXT_WINDOW_EXCEEDED'`，非同义反复）。
e2e：`tests/e2e/image-burst-cross-provider.e2e.spec.ts`（跨家探测 + 腾讯两站的
复现/修复/可辨认性验证），**消耗真实积分**；闸门与 fixture 说明见
`tests/e2e/README.md`。
⚠️ 曾有一个 `image-request-probe.e2e.spec.ts` 专测腾讯系，已**并入**上面那个文件 ——
它的 fixture 加载、YAML 凭据解析、缩放桥接与张数序列与后者**完全重复**
（两份实现必然漂移，是本仓库反复告诫的形状），而它两条独特断言
（buddy 的 `CONTEXT_WINDOW_EXCEEDED` 归类、缩放后仍可辨认）都已搬过去，
且现在两站都覆盖（原来只测 buddy，**workbuddy 从未被端到端验证过**）。