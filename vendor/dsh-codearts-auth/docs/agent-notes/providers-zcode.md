<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根因（真实缺陷，2026-09-29）

**用户报障原文**：

> zcode 执行任务会卡住……显示「**深度求索中，用时 5分27秒...**」，
> 还没有继续输出推理或者思考……此时**停止按钮点击都没反应**，
> 我重启后才能让这个任务停止。

### 一、先记住这条判据：日志里的收尾事件可能是**伪造的**

排查时**不要**看到 `turn/end{kind:'interrupted'}` 就以为「turn 正常结束过」。
`dsh-session` 的 `openTurnClosers()`（`lib/types/repair.js`）会在加载会话时给
**打开的 turn** 补一份合成收尾，并且**复用最后一个真实事件的时间戳**
（原文：*"The last real event supplies the seq base and the timestamp for the
synthetic closers"*）。

⇒ **判据：`step/end` 与 `step/start` 同一毫秒 + `turn/end{kind:'interrupted'}`**
= 那不是真收尾，**这个 turn 从未结束**（适配器的 generator 挂在某个 `await` 上）。

本机实测三次（全是 `zcode/GLM-5.3-Flash`）：

| 会话 | `step/start` | 最后一个真实事件 | 无输出时长 |
|---|---|---|---|
| `session-a77ed457` | 17:20:57.353 | 17:38:14.442 | **1018.7 秒**（用户看到的「5分27秒」正在其中） |
| `session-fe7a9979` | 20:00:25.179 | 20:00:25.179（即 start 本身） | 直到重启宿主 |
| `session-2271311d` | 20:10:59.738 | 20:10:59.738 | 直到切换模型 |

### 二、根因 A（本次直接原因）：流式读取阶段**既无超时、也失了中断通道**

`src/zcode-adapter.ts` 旧实现把清理放在 **`fetch` 的 `finally`** 里 ——
那个 `finally` 在「响应头一到」就执行：

```ts
try { response = await this.fetchImpl(..., { signal: controller.signal }) }
finally {
  clearTimeout(timer)                                    // ← 流还没读，超时就被清了
  options.signal?.removeEventListener('abort', onAbort)  // ← 中断通道也被摘了
}
yield* consumeAnthropicSse(response.body, ...)           // ← 这一段无超时、无中断
```

而 `src/zcode-anthropic.ts` 的 `iterateSseFrames` 里是裸的
`await reader.read()`，且 `finally` 只有 `releaseLock()`。

⇒ 上游（免费通道首字节实测有 20 秒以上长尾，也会整段静默）一旦不吐数据：
`read()` 永远挂着、**`abort` 唤不醒它**、180 秒的 `requestTimeoutMs` 形同虚设、
用户点「停止」也到不了 controller —— **只能重启宿主**。

**修法**（三处，缺一不可）：

1. `iterateSseFrames(body, { signal })`：abort 时**主动 `reader.cancel()`**
   （取消底层流会让挂起的 `read()` 立刻以 `{done:true}` 收尾，这是**唯一**能唤醒
   它的手段）；循环顶部再判一次 `aborted` 兜底。
2. `finally` 里**先 `await reader.cancel()` 再 `releaseLock()`** ——
   `releaseLock()` **不关闭底层流**，上游连接会继续生成并**白扣额度**。
3. `zcode-adapter.ts`：把超时/中断的作用域提升到**整轮**
   （`stream()` 负责建 `AbortController` + 计时器，`streamScoped()` 干活），
   并把 `controller.signal` 一路传进 SSE 消费；超时收尾抛 **`TIMEOUT`**
   （可重试），**但用户中断必须原样上抛**（否则用户主动取消会被白重试）。

⚠️ 可作对照的实现：`D:\jet\code\js\dsh-free-glm\src\adapter.ts` 早已修过同型三处
（[L1897-1900](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 清理覆盖全流程、
[L712-729](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 把超时 signal 传进 SSE、
[L921-948](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) `cancel()` 再 `releaseLock()`），
注释原文就是「**`abort` 不会唤醒 `reader.read()`**」「超时失去全部作用，请求可无限挂起」。

### 三、根因 B（同型的第二颗雷）：captcha 侧有无超时的等待，且失败后**把闸门焊死**

`src/zcode-captcha.ts`：

| 位置 | 旧行为 | 后果 |
|---|---|---|
| `acquirePage` 取页 | `while (this.pageBusy) await sleep(50)` —— **无上限、不看 signal** | 一旦标志没被复位就**永久自旋** |
| `acquirePage` 建连 | `await new Promise(... ws 'open' ...)` —— **无超时** | Chromium 僵死时 `open`/`error` 都不来 ⇒ 永久挂起 |
| `acquirePage` 建页 | `await browser.send('Target.createTarget')` 在 try **之外** | CDP 抛错后 `pageBusy` 不复位 |
| `mint()` 的 `finally` | `if (this.reusablePage === page) this.releasePage(page)` | catch 里已 `discardPage()` 把 `reusablePage` 置空 ⇒ 条件**恒为假** ⇒ `pageBusy` **永不复位** |

最后一条是**致命**的：它让「一次 captcha 失败」升级成「此后每次 mint 都死锁」——
adapter 的 `await this.mintCaptcha()` 永不返回，请求根本不发出，UI 永远「深度求索中」。

**修法**：取页自旋加 `pageWaitTimeoutMs`（默认 30s）+ 判 signal；建连加
`connectTimeoutMs`（默认 10s）；`createTarget` 包进 try；`mint()` 的 `finally`
改成 **`else this.pageBusy = false`**（无条件复位）；`mint(config, { signal })`
与 `ZcodeAuth.mintCaptcha` / `index.ts` 的注入点**逐层透传 signal**。

⚠️ 超时**不**复位别人的 `pageBusy`（此刻它属于另一个持有者，越权复位会让两个
mint 共用同一页面 —— captcha 是一次性的，必串状态）。

### 四、回归用例与**反向验证**

`tests/unit/zcode-stream-hang.spec.ts`（8 条，全部毫秒级、零网络、零额度）：

| 用例 | 反向验证（改回旧行为 ⇒ 变红） |
|---|---|
| abort 唤醒挂起的 read | 去掉 abort→`cancel` 注册 ⇒ **红**（挂到用例超时） |
| 中断必须真的 cancel 底层流 | 同上 ⇒ 红 |
| 消费方 `break` 时必须取消底层流 | 去掉 `finally` 的 `reader.cancel()` ⇒ 红（仅此条红） |
| 200 + 整段静默 ⇒ `TIMEOUT` | 不把 signal 传进 SSE 消费 ⇒ **红（挂 5s 超时）** |
| 用户中断**不得**翻译成 `TIMEOUT` | 同上 ⇒ 红 |
| 取页等待有上限 | 去掉 deadline 判定 ⇒ **红（挂 5s 超时）** |
| `mintOnPage` 失败后 `pageBusy` 必须复位 | `finally` 改回条件式 ⇒ 红 |

⚠️ 写这类用例时**判据是「在有限时间内结束」**：唤醒/超时/复位任一失效，
用例呈**挂起直到 vitest 超时**，而不是干脆的断言失败 —— 那正是线上那条路径的形状。

### 五、其它必须记住的点

- **两次 checkout 都要改**：`D:\jet\code\js\dsh-codearts` 与
  `D:\jet\code\js\deepseek-harness-codearts` 是同一插件的两份链接目录，而
  `~/.dsh/profiles/web/pnpm-lock.yaml` link 的是**后者**（GUI 加载它）、
  `desktop` 用前者。改完两份 `src/` 都要 `pnpm build:all`，且**必须重启宿主**才生效。
- `requestTimeoutMs`（`zcode-product.ts`，180s）现在**覆盖整轮**（含 captcha 与流读取），
  不再是「只到响应头」。
- captcha **当时**每请求现 mint（每次新建 page，历史实测约 1.2 秒）**不是**本次卡住的原因：
  卡住前后的请求都正常，且 17:20 那次卡死后 19:59 的 zcode 请求又成功了 ——
  若是 `pageBusy` 死锁，后续请求会**全部**一起卡。⇒ 别把 `imageUrls`/captcha 配额当成第一嫌疑人。
  ⚠ 那个 1.2 秒是「每次新建 page」时代的数字，**现行两条都已变**：页面复用（中位 426ms /
  平均 546ms）+ 按需产出（不索要验证时一次都不 mint）。口径见本章第十节与 README 的 ZCode 章节。

---

## ⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，2026-09-30）

**起因**：`dsh-free-glm` 的作者指出我们的瓶颈是「每请求 +1.2s captcha」（**当时的形态**：
每请求都产、且每次新建 page；1.2 秒是那时的实测，现行口径见本章第十节）。
核对后确认：**这不仅对，而且还有第二处更大的漏算**（见第 4 条）。
本次把那边已验证的三套机制搬了过来，并顺手补上了 prompt caching 断点。

### 一、captcha **预取池**（`src/captcha-pool.ts`）

**要解决的问题**：`zcode-captcha.ts` 实测「页面空闲 <8s 复用约 0.5 秒，
更久（实测 15s 必 `F001`）要**新建页面约 3.7 秒**」，而 agent 多步循环的
两步间隔**通常大于 8 秒** ⇒ 现产路径几乎每步都付建页面的钱。

**关键依据（那边的实测，决定了「能提前产」这件事成立）**：

| 生成后经过 | 使用结果 |
|---|---|
| 0 / 10 / 30 / 60 秒 | ✅ 可用 |
| 120 秒 | ❌ 3007 |

⇒ 「一次性」只指**用一次就作废**，**不指必须立刻用**。

**实现要点（三条都是那边记过的坑）**：

1. **现产之后也要补池**。少了它，首次请求现产后池永远空，优化形同虚设。
2. **取走即补下一个**（不 await，不阻塞本次请求）。
3. **预取要 inflight 去重**，否则每轮请求都叠一个预取，白耗 captcha 配额。
4. ⚠ **`hasFresh()` 必须只读**（本次写单测时实测到的缺陷）：初版实现成
   「调一次 `takeFresh()` 看结果」，而 `takeFresh()` 会清空池 ——
   于是**看一眼就把预取好的 param 丢掉了**，池在诊断代码路过时静默失效。
   修法：拆出 `peekFresh()`（只判不删）+ `takeFresh()`（删）。

**开关**：`DSH_ZCODE_CAPTCHA_POOL=0` 关闭（关闭后与引入池之前逐字一致）；
`DSH_ZCODE_CAPTCHA_POOL_TTL_MS` 调 TTL（默认 **30 秒** —— 比那边的 45 秒保守，
因为**我们没有复测过**这个窗口，且两边的产出路径不同：它走壳内 renderer，
我们走普通 Chromium CDP。若实测无 3007 可放宽）。

**回归**：`tests/unit/captcha-pool.spec.ts`（9 条）。
反向验证：删掉 `take()` 里现产后的 `prefetch()` ⇒ 第 1 条变红。

### 二、上游**发车闸门**（`src/model-gate.ts`）

**依据（那边分模型实测）**：`429` 里的 `3009 model concurrency limit exceeded`
是**并发配额**（撞它时 token 还剩 299.4 万），且两个模型窗口明显不同：

```
GLM-5.3-Flash  605 次 200    0 次限流      ← 从未撞过
GLM-5.3         74 次 200   21 次重试     6 次最终 429
```

⇒ **串行**（不重叠）+ **按模型最小间隔**（不挨太近）。加了之后 `3009` 21 → 1 次。
参数落在 `zcode-product.ts`（`serializeUpstream` / `modelGapMs`：
`glm-5.3` 350ms、`glm-5.3-flash` 0），**不要在适配器里写死**。

⚠ **闸门只包 fetch，不包 captcha**：那边第一版把 mint 一起放进闸门，
`mintMs` 从 200-500ms 暴涨到 **2500-3100ms**（变成「排在 N 个人后面再 mint」）。

⚠ 与 `model-queue.ts` 分工不同：那个管**服务端指定的**排队时长（`10605`），
这个管**客户端自保**的发车节流。

**回归**：`tests/unit/model-gate.spec.ts`（8 条，含「等待期间中断必须生效」——
否则前面某个请求挂住会把后面全部拖死）。

### 三、额度用尽 / 无权益 → **标记 + 切号**

**两种 429 的处置必须分开**（`isZcodeConcurrencyLimited` / `isZcodeQuotaExhausted`）：

| 形态 | 判据 | 处置 |
|---|---|---|
| 并发限流 | `3009` | **退避重试**（`ZCODE.concurrencyRetryMax`=2，1500ms 线性退避），**不换号、不标记** |
| 额度用尽 | `1005 exceed quota limit` / `1113 余额不足` | **标记该账号+该模型到 UTC+8 当日 24:00**，换下一个账号重发 |
| 无权益 | **秒回空**（`EMPTY_RESPONSE` 且耗时 < `ZCODE_FAST_EMPTY_MS`=3 秒） | 同上（换号） |
| 链路卡住 | 慢回空（≈180s） | 重试 / 排查，**不换号**（换号解决不了） |

⚠ **`isZcodeQuotaExhausted` 必须先排除 `3009`** —— 否则会把一个完全可用的账号
误标成「当日用尽」（与 qoder 那次「把 rate_limit 当 billing」同型）。

⚠ **重试前必须重新 mint captcha**（一次性；在索要验证的窗口里，沿用旧的会回 `3007`）：
实现上把 `mintCaptcha()` 放在**内层循环第一行**，天然满足。

⚠ **`emitted` 闸**：一旦已向调用方 yield 过内容，就不许再切号/重试
（否则用户看到两份输出）。HTTP 层错误与空响应都发生在输出之前，不受此限。

⚠ **切号三件事**（与 `qoder-adapter.ts` 同因，缺一即空转）：
① 标记用的是**局部可变**的 `activeAccountId`（不是回调，回调切号后不跟着变）；
② 取号必须传 `tried`（池按手动顺序返回，刚失败的账号可能仍排第一）；
③ `tried` 跨重试保留。回调由 `index.ts` 的 `activeZcodeAccountId` 提供，
在 `resolveCredential` 里记录**实际返回的那个账号**。

⚠ 无法再切时抛 **`QUOTA_EXCEEDED`**（**不在** harness 的
`DEFAULT_RETRYABLE_CODES` 里）—— 不能落 `SERVER`，否则「今日额度已用尽」
这种确定性错误会被白退避重试 5 次（约 15.5 秒）。

**回归**：`tests/unit/zcode-throttle.spec.ts`（13 条：5 条纯函数 + 8 条行为，
含「3009 不标记账号」「秒回空切号」「已产出内容后不切号」「tried 传下去」）。

### 四、**prompt caching 断点**（本次额外发现的更大瓶颈）

**用户反馈**：`dsh-free-glm` 的作者说我们「每请求 +1.2s」（**当时的形态**：每请求都产、
每次新建 page；现行已改按需 + 复用，见本章第十节）。
captcha 只解释**一部分**；下面这条解释**每一步**的开销：

`toAnthropicTools()` **从不产出 `cache_control`**，而 `system` 此前**每块都打**
（3-4 块）—— 正好用满 Anthropic「单请求最多 4 个断点」的预算，
于是 `tools` 再也打不了点。而 DSH 每步带 24 个工具、约 19KB schema
（那边 P0-2 的实测原文），**每步全量重算这段 prefill**。

**修法（两处）**：

1. `zcode-identity.ts`：system **只在最后一块**打断点。前缀式缓存语义下，
   一个位于末块的断点**覆盖面等于（不小于）**每块各打一个；
   且「调用方 system（DSH 的 AGENTS.md，本仓库数十 KB）必须落在断点内」——
   只打末块天然满足。
2. `zcode-adapter.ts` 的 `withToolCacheBreakpoint()`：给**最后一个** tool 打断点
   （前缀式 ⇒ 覆盖「system + 全部 tools」整段）。总断点数 = 2 ≤ 4。

⚠ **不影响准入**：3012 的判据是身份块的**内容与结构**存在，
`cache_control` 只是缓存提示。用例断言了「断点总数 ≤ 4」。

**回归**：`tests/unit/zcode.spec.ts` 的「只在最后一块打 cache_control」等 3 条 +
`zcode-throttle.spec.ts` 的「tools 断点真的进了请求体」。

### 五、额度用尽时**必须说出真实原因**（用户报障，2026-10-01）

**用户看到的原文**：

> 本轮运行失败　`zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）`
> `EMPTY_RESPONSE`　（并伴随「已重试模型请求 (5/5)」）

**两处都不对**：

| 项 | 问题 |
|---|---|
| **文案** | 说的是**现象**（没收到内容），没说**原因**（额度用尽）—— 用户无从判断该等额度、换模型还是加账号 |
| **错误码** | `EMPTY_RESPONSE` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 这种**确定性**错误被白退避重试 5 次（约 15.5 秒，即截图里的 5/5） |

⚠ **这与 qoder「110 额度错误落 `SERVER`」是同型缺陷**：
**用错误码的默认归类代替了对业务语义的判断**（本文件 qoder 章节记过该教训）。

**上游为什么回「空」而不是报错**：额度耗尽时请求**根本没送达模型**
（对照那边的实测：`provider runtime headers` 请求从未出现），网关直接回
**HTTP 200 + 空内容** —— 所以它**看起来**像空响应，实际是权益问题。

**最可惜的地方：判据本来就是现成的**。`isFastEntitlementMiss()` 早就实现了
「**秒回空**（<3s）= 该账号对该模型无权益」（依据：150-200ms 空响应
vs 卡住形态的 ≈180000ms），但它此前**只用于决定「要不要切号」**，
判据本身从未进入文案 —— 于是「无法再切号」那一步抛出的还是通用裸错误。

**修法（`zcode-adapter.ts`）**：「秒回空」且**无法再切号**时 → 抛
`zcodeEntitlementErrorMessage()` 的文案 + **`QUOTA_EXCEEDED`**
（不在可重试集合里 ⇒ 立即失败）。

⚠ **文案措辞必须诚实**：不断言是「额度用尽」还是「无权益」—— 两者在 wire 上
**表现完全相同**（都是秒回空），我们**无法区分**。故写
「额度已用尽或没有可用权益」并给出两种都能解决的建议。

⚠ **不得在 `zcode-anthropic.ts` 的 SSE 层做这个分类**：那一层**拿不到耗时上下文**
（它不知道自己跑了多久），若在那里武断报「额度用尽」，**慢回空**那条路径
（链路故障，该重试）就会被误报成「换账号」。故该层保留通用文案与可重试的
`EMPTY_RESPONSE`，**分类交给适配器**（它持有 `consumeStartedAt`）。

**回归**：`tests/unit/zcode-throttle.spec.ts` 的
「额度用尽：文案必须说出真实原因、错误码必须不可重试」段（3 条：
无账号池时抛 `QUOTA_EXCEEDED` + 文案含真实原因且**不含**那句通用文案 +
慢回空不得被误判 + 多账号时才提账号数）。
反向验证：把错误码改回 `EMPTY_RESPONSE` ⇒ 第 1 条变红。

### ⚠ 改完这些要做的两件事（同 zcode 其它改动）

1. **两份 checkout 都要同步**（`D:\jet\code\js\dsh-codearts` 与
   `D:\jet\code\js\deepseek-harness-codearts`），并各自 `pnpm build:all`。
2. **必须重启宿主**才生效（插件模块在进程启动时读进内存）。

### 六、会话实证：额度耗尽 + **两个插件抢同一份 captcha 信誉**（2026-10-01）

**用户报障**：zcode 赠送额度用完后，界面报通用的「空响应」；并追问
「我们哪里设置 zcode 保活频率的？用我们的 zcode 执行任务后用 dsh-free-glm
执行会碰到错误，似乎我们保活频率太高了」。

#### 6.1 先纠正一个归属：那条 `503 降级冷却` **不是我们抛的**

用户贴的截图里的文案是 **`zcode-bridge:`** 开头 + 「降级冷却 / 连续 5 次失败 /
约 233 秒后可重试」。两处都对得上 **dsh-free-glm 的桥**：

- 前缀：我们的 provider 报错一律是 `zcode: `；`zcode-bridge:` 是它的 `PROVIDER` 名。
- 逻辑：`mintBackoffUntilMs` + `noteMintFailure()` + 指数冷却、出口在
  `dsh-free-glm/patches/zcodeBridgeServer.ts:3151`。

⚠ **顺带回答「滑块要在哪做」**：必须在**开源版实例窗口**里做。
dsh-free-glm 的桥只认源码检出的 `packages/desktop`（`appDirCandidates()`），
官方闭源版起不来桥 ⇒ 闭源版窗口**永远不会弹**它那个验证。
且**冷却期内桥直接返回 503、连 mint 都不发起**（`mintBackoffRemainingMs() > 0`），
所以要在**冷却结束后**主动发一次对话才会弹滑块。

#### 6.2 但用户的方向**成立**：确实在抢同一份设备信誉

**关键证据（两个 session，同一台机器，时间相差约 1 分钟）**：

| session | provider | 现象 |
|---|---|---|
| `session-eced01ed` | **`zcode`（我方）** | 14:26:53 起连续 **12 次**空响应失败（6 请求 × 2 turn），每次重试**都重新 mint 一个 captcha** |
| `session-b0e4eb3f` | **`zcode-bridge`（dsh-free-glm）** | 开局第 1 步就报 **`502 Failed to mint auth material`** |

⇒ captcha 信誉是**设备级**的（不是按插件算），我们多产的每个 captcha
都在消耗它的额度。**两个都开着就是在互相抢。**

⚠ **排查可复现**：会话内容在 `~/.dsh/sessions/<工作目录编码>/<session>/session.v4.jsonl.zstd`，
用 Node 内置 `zlib.zstdDecompressSync` 解压（**无需装 zstd**）。
字段是 `e.type` / `e.time` / `e.data`，**不是** `kind`/`timestamp` —— 我第一版按
猜的字段名取时间线，全部取到空值。

#### 6.3 修了什么（三处）

**① 空响应必须说出真实原因**（见上一节）：秒回空 → `QUOTA_EXCEEDED`
+ 「额度已用尽或没有可用权益」。

⚠ **判据用耗时是可行的，但要看对指标**：会话实测**单次请求耗时仅 125ms**
（`step/start 14:26:53.069` → `attempt .194`），命中 3 秒阈值。
⚠ 我一度把「重试间隔 6.858s」误当成「单次耗时」而以为修复失效 ——
**重试间隔 ≠ 单次请求耗时**，两者在日志里长得像（都是相邻 attempt 的时间差）。
`step/start → assistant/attempt` 的差才是单次耗时。

**② HTTP `body === null` 分支也是同一缺口**（本轮新发现）：

| 形态 | 分支 | 原先 |
|---|---|---|
| 200 + 空 SSE 流（0 帧） | `consumeAnthropicSse` 的 `!sawAny` | ① 已覆盖 |
| 200 + **`body === null`** | `zcode-adapter.ts` 的 `response.body === null` | ❌ 抛裸 `EMPTY_RESPONSE` |

后者**跳过整个 SSE 消费** ⇒ 哪怕 ① 修好，走这条路的用户仍看到通用文案
且白重试。现已同样改为「先换账号，换不动就 `QUOTA_EXCEEDED` + 真实文案」。

**③ captcha 产出失败退避**（`src/captcha-backoff.ts`，**本轮最重要**）：

此前我们**完全没有**这个机制 —— 额度耗尽时连 mint 12 个 captcha。
现按那边的做法（阈值 3、首次 1 分钟、指数翻倍、上限 30 分钟）加闸门：
连续产出失败达阈值后**直接抛错、不再发起 mint**。
那边的原话：「**继续请求不会让信誉恢复，只会更糟**」。

- ⚠ **`steps` 必须用 `streak - threshold`**：用 `streak` 会让第 3 次失败
  直接等到 `base × 8`（8 分钟），与「起步 1 分钟」的语义相反（用例守住了）。
- ⚠ 冷却到点**只清冷却、不清 `streak`**：否则退避重新从 1 分钟起步，
  达不到「指数」效果。
- ⚠ **只对「产出失败」计数**（`mintOnPage` 抛错），不对「上游回 `3007`」计数 ——
  后者归因不清（可能是服务端抖动），记成我们的信誉问题会误伤。
- ⚠ 闸门放在 `mintCaptcha` 的**取池之前**：这样池的 `prefetch()` 后台路径
  天然也被挡住，**不需要池自己判断退避**。
- 关闭：`DSH_ZCODE_CAPTCHA_BACKOFF=0`。

**回归**：`tests/unit/captcha-backoff.spec.ts`（7 条）+
`zcode-throttle.spec.ts` 新增 2 条（HTTP 空 body 的文案与换账号）。
反向验证：去掉 `remainingMs()` 的到点清零 ⇒ 「冷却到点后恢复」变红。

#### 6.4 仍未做的两件事（需要用户拍板）

1. **captcha 预取池默认值**：它让 mint 次数**翻倍**（每请求 1 次 + 后台预取 1 次），
   是**唯一主动加倍**信誉消耗的改动。在信誉紧张的设备上是净负面。
   建议把 `enabled` 默认值反转为 `false`（保留实现与开关）。
   ⚠ **已实测存在跨插件干扰，但未实测「预取池是否是压垮信誉的那一下」** ——
   不要把它当成已证结论。
2. **持久化 captcha profile**：我们每次 `mkdtempSync` 新建临时 profile
   （`zcode-captcha.ts:547`），而 dsh-free-glm 用 ZCode 实例的长期 profile
   ⇒ 它的信誉能跨会话累积，我们不能。**但阿里云的信誉究竟按 IP、
   按指纹还是两者加权，没有实测过** —— 若是按指纹，独立 profile 反而
   保护了对方的信誉（各算各的）；若是按 IP，我们就是在直接抢。**结论未定，勿凭推断动手。**

### 七、官方 ZCode 的 captcha 护栏（逆向 `app.asar` 实证，2026-10-01）

**起因**：用户追问「zcode 如果每一步都认证一样也会碰到上限吧，是否它不是
每步都用一个 captcha」。⇒ 去逆向**官方闭源版**安装目录核实。

#### 7.1 怎么读的（可复现）

官方安装版是 Electron 打包产物，源码在 `app.asar`（312 MB）：

```
C:\Users\Jet\AppData\Local\Programs\ZCode\resources\app.asar
```

⚠ **两个读取要点**（都踩过）：
1. asar 头是 `[u32=4][u32 headerSize][u32 jsonSize][u32 jsonStrSize]`，
   JSON 表从 **offset 16** 开始、长度 `headerSize - 8`。
2. ⚠ **JSON 表尾部有填充字节**，直接 `JSON.parse` 会报
   `Unexpected non-whitespace character after JSON` —— 必须
   `s.slice(0, s.lastIndexOf('}') + 1)` 再 parse。
3. 数据区起点 = `16 + jsonLen`；每个文件的 `offset` 是**相对数据区**的。

captcha 代码在 `/out/renderer/assets/styles-*.js`（5.8 MB）——
与 dsh-free-glm 记录的 `styles-S9_69L9k.js` 同一类产物。

#### 7.2 官方**确实是每请求一个 captcha**——但有三层我们没有的护栏

先回答用户的疑问：**不是复用**。证据：
- 每个 model request 都走 `Fnn()` → `Mnn()` 重新产出，再经 `lnn()` 注入
  `X-Aliyun-Captcha-Verify-Param` / `-Region` 两个头。
- `Snn`（param 表）**只有 `set` / `delete`，没有 `get`** ——
  它是**诊断记录表**，不是复用缓存。

但官方有三层护栏，**我们此前一条都没有**：

| 机制 | 官方实现（产物里的符号） | 我们此前 |
|---|---|---|
| **全局串行队列** | `wnn` promise 链 + `jnn()`，日志 `zcode-plan verification queue slot acquired`。同一刻只产一个 | ❌ 无（DSH 会并发发请求，每个都独立 mint） |
| **配置 TTL 缓存** | `f3()`：`expiresAt: t + 6e4`（**60 秒**）+ 在飞去重 `d3` | ❌ `index.ts` 用 `??=` 做**永久缓存** |
| **结果观测** | `mnn({result: 'traceless_passed' \| 'interactive_displayed'})` 上报 ARMS，并维护两个计数 | ❌ 完全没有 |

另有：**超时 120 秒**（`Htn = 12e4`，我们是 75 秒）；
**重复提交检测**（`Pnn()` 记住上轮 `certifyId`，相同就警告
`请求可能触发 F008 重复提交` —— 这正是 dsh-free-glm 里 `F008` 的来源）。

#### 7.3 阿里云的限流是**双维度**且有**默认阈值**（官方文档）

用户提供的文档
（[功能相关问题](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/function-related-issues)
与 [自定义策略](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/custom-policy)）：

| 维度 | 默认限制 |
|---|---|
| **同设备每小时** | **150 次** ← **最紧的一条** |
| 同设备每日 | 400 次 |
| 同 IP 每小时 | 4000 次 |
| 同 IP 每日 | 10000 次 |

⇒ 文档明确「**基于 IP 或者设备维度**的安全策略阈值」是**两个独立维度、
共同作用**。**设备维度 150/小时**才是我们真正的约束：
一次多步任务每步 1 次，**加上我此前默认开启的预取池就是 2 次/步**。

⚠ **这解释了实盘现象**：`session-eced01ed` 那种 246 步的长任务，
加上 dsh-free-glm 同期在跑，撞穿「设备每小时 150」是**大概率**而非偶然。

#### 7.4 本轮改了什么（四项，全部对齐官方）

1. **预取池默认关闭**（`captcha-pool.ts` 的 `CAPTCHA_POOL_DEFAULT_ENABLED`）。
   依据：① 官方根本没有预取；② dsh-free-glm 的池默认也是关的
   （`=1` 才启用，注释「先观察稳定性」）；③ 它让消耗**翻倍**。
   ⚠ **归因强度**：跨插件干扰有实证，但「预取池是压垮信誉的那一下」**未证实**——
   翻转的理由是①②，不是把③当结论。
2. **captcha 产出走全局串行队列**（新增 `serial-queue.ts`，接在
   `ZcodeAuth.mintCaptcha` 的**取池之前**，故池的 prefetch 后台路径也被挡）。
3. **captcha 配置改 60 秒 TTL 缓存**（新增 `ttl-cache.ts`，替换
   `index.ts` 的 `??=` 永久缓存）。⚠ 旧写法还有第二个缺陷：
   **首次失败会被永久固化**（`??=` 把回退兜底值也记住）。
4. **观测**（`ZcodeAuth.captchaObservability()`）：计数
   `tracelessPassed` / `interactiveDisplayed` / `failed`，
   并在**被要求交互式验证时显式告警**。
   ⚠ `interactive` 的判据是**轮询 DOM**（`#aliyunCaptcha-window-popup` 等
   四个 id，取自 dsh-free-glm 的实测记录）——因为官方文档 Q9 明说
   「该安全策略逻辑**不支持自定义，不对外透出**」，没有回调可用。
   用「**曾经出现**」而非「此刻存在」：交互元素在验证完成后会被移除，
   只在 success 那一刻查 DOM 会**漏报**（而那正是最需要知道的场景）。

**回归**：`serial-queue.spec.ts`（13）+ `captcha-backoff.spec.ts`（9）+
`captcha-pool.spec.ts`（9）+ **`zcode-captcha-guard.spec.ts`（6，接线验证）**。
⚠ 最后一类**不能省**：本仓库历史上多次栽在「原语写好了但没接上」
（`zcode-upstream.ts` 的 `fetchImpl` 曾是**死参数**）。
反向验证：把 `CAPTCHA_POOL_DEFAULT_ENABLED` 改回 `true` ⇒ 池用例变红；
去掉 `mintCaptcha` 的队列包装 ⇒ 接线用例的 `maxInFlight` 变 3（期望 1）。

⚠ **写这类用例的两个坑**（都踩过）：
- `ZcodeAuth extends Service`，构造时会调 `ctx.provide(...)` ⇒
  **必须用真实的 `new Context()`**，手写对象桩会在构造期抛
  `Cannot read properties of undefined (reading 'provide')`。
- 测队列时**必须先排除预取池的干扰**（池命中不调底层 mint）——
  默认已关闭，故天然走现产路径。

#### 7.5 仍未做

- **captcha 超时 75 秒 → 120 秒**（对齐官方 `Htn`）：官方值更长是给了
  交互式验证（真人拖动）留时间；我们是无感验证，75 秒对**无感**够用。
  若要支持「降级后让用户手动拖」，才需要调到 120 秒 —— 那是另一个功能。
- **持久化 profile**：见上一节，结论仍未定。
- **captcha 配置 TTL 的实盘验证**：60 秒取自官方同值，但我们**没有实测过**
  服务端配置的实际变化频率。若发现 `sceneId` 变更后仍有延迟，
  可下调 `CAPTCHA_CONFIG_TTL_MS`。

### 八、⚠️⚠️ 多账号凭据被**跨账号覆盖**（真实数据破坏缺陷，2026-10-02）

**这是本文件记录过的「构造全新对象抹掉字段」同型坑的第四次**，且这次
**破坏了用户数据**（不是显示错误）。

#### 8.1 用户报障

> 登录了 2 个账号（**两个不同微信各自收到 bigmodel 登录通知**）。
> 第二个账号有余额，但**插件里刷新积分显示 0**、发消息报
> 「额度已用尽或没有可用权益」；而 **IDE 里同一个账号发消息能收到回复**。

#### 8.2 根因（实测证据）

`refreshAll()` 与 `refreshAccountCredential()` 都拿 `this.current()` 的结果
**无条件写回目标 ref** —— 而 `current()` → `readCredentialFromPool()` 只取
**池里第一个凭据可用的账号**。于是 30 分钟一轮的续期定时器（或面板「刷新」）
把**账号 A 的凭据铺满了整个池**，抹掉账号 B 的真实凭据。

**实测证据**（用户机器 `~/.dsh/.credentials.yaml`，两个 `ZCODE_ACCOUNT_*`
逐字段比对，**ref 名与值均已脱敏**）：

| 字段 | 账号条目 #1 | 账号条目 #2 |
|---|---|---|
| 凭据 ref 名 | `ZCODE_ACCOUNT_<A>` | `ZCODE_ACCOUNT_<B>` |
| `zcode_jwt` 的 sha256 | `aa20f5d1…`（前 8 位） | **`aa20f5d1…`（相同）** |
| `device_mid` | `be4c6392…`（前 8 位） | **`be4c6392…`（相同）** |
| `account_label` | `<同一昵称>` | **`<同一昵称>`** |
| `bigmodel_access_token` 指纹 | `fe31a108…`（前 8 位） | **`fe31a108…`（相同）** |

⚠ **本文档刻意不写真实值**（ref 名会暴露账号编号、昵称是用户的微信账号名、
`device_mid` 是设备标识）。需要复核时按下方方法自行从本机取。

⇒ 两个条目**逐字节相同**，是**同一个账号占了两条**。
用户确认「是两个不同微信账号」，故**只能是覆盖所致**。

**症状为何极像服务端问题**：IDE 用它自己那份真实凭据（B）→ 正常；
插件池里两条都是 A → A 已耗尽 → 报额度用尽。
⚠ **排查要点：每当「IDE 能用而插件说没额度」，先怀疑凭据被覆盖，而不是配额。**

#### 8.3 修法：**绝不跨账号写**

ZCode **不可续期**（凭据是静态的、没有 refresh 端点），所以「刷新」唯一
正确的语义是「**逐账号重新解析自己的 ref，再写回自己**」——
与 `BuddyAuth.refreshAll` 的做法一致（那边也是逐账号读自己的 ref）。

⚠ **`refreshAll` 不再使用 `current()`**；每个账号 `readCredentialFromRef(自己的 ref)`，
解不出就**跳过并告警**，**绝不**用别的账号（或磁盘凭据）去填它。

⚠ **为什么不用磁盘 `~/.zcode/v2/credentials.json` 兜底**（听起来合理，实际不可实施）：
它是**单账号**格式，而池是**多账号**的 —— 我们**无法判断**那份磁盘凭据属于
池里**哪一个**账号。拿它去补任意一条，等于重犯同一个错误（换成「单体覆盖」）。

⚠ **旧注释的本意是错的**：「把磁盘上的最新凭据回写到每个账号的 ref，
这样用户在官方客户端重新登录后新凭据能铺开到所有条目」——
那个前提在**多账号池**下**不成立**：磁盘凭据只对应一个账号。

> 📌 **2026-10-05 更新**：上面这条「磁盘凭据」现在**根本不存在**了 ——
> 读本机 ZCode 数据的整套能力已被删除（见下方 §9）。本节保留这段推理，
> 因为它记录的仍是「为什么不能用**一份**凭据去填**多账号**池」的通用教训。

#### 8.4 回归与**反向验证**

`tests/unit/zcode-account-isolation.spec.ts`（6 条）：
「A 绝不写进 B」「池顺序颠倒时同样不串」「某账号凭据不可用时跳过而不填别的」
「`refreshAccountCredential` 只动目标 ref」「目标损坏时如实报错」
「单账号失败不影响其余」。

⚠ **已做反向验证**：把 `refreshAll` 改回「`current()` 一次然后写全部」⇒
**3 条变红**，其中一条直接复现用户症状（`expected 'account-A' to be 'account-B'`）。

⚠⚠ **反向验证本身踩了一次「假绿」**：第一次替换脚本因 **CRLF** 未匹配到方法结尾、
**静默失败**，测试全绿 —— 差点据此认为「用例抓不住旧实现」。
⇒ **改完代码做反向验证时，必须确认替换真的生效**（打印替换后的代码片段），
否则「全绿」可能是「什么都没改」。

#### 8.5 ⚠️ 两条既有测试此前**断言的是缺陷行为**（已改写）

`zcode-wiring.spec.ts` 里：

| 旧测试 | 问题 |
|---|---|
| `refreshAll 是「回写磁盘凭据」而不是续期，且逐账号隔离失败` | 测试名自称「隔离失败」，却断言 `REF_1` 与 `REF_2` **都被写入同一份磁盘凭据** —— 把 bug 固化成预期 |
| `refreshAccountCredential 无凭据时如实抛错` | 断言的文案要求用户「去官方客户端重新登录」，而多账号下那**解决不了**该账号的问题 |

⇒ 已改写为断言**正确语义**（逐账号各写各的；两个空 ref 保持空）。

⚠ **教训**：测试名里出现「…失败」「…不隔离」这类**消极措辞**时，要停下来问
「我是在断言**预期行为**，还是在记录**已知缺陷**？」后者应当写成 TODO
或直接修掉，不该固化成绿色。

#### 8.6 用户需要做的事（数据已被破坏，代码修复救不回来）

⚠ **B 的原始凭据在那次覆盖中已被抹掉，无法从残留数据恢复**。
用户需在 Jet Hub 里**重新登录**第二个微信账号。修复后的代码不会再覆盖它。

### 九、重复添加同一账号的去重（2026-10-02）

#### 9.1 ⚠⚠ 先纠正我写错过的判据：**`device_mid` 不能用来认账号**

我最初告诉用户「判据可用 `device_mid` 或 JWT 的 `user_id`」——**前半句是错的**，
写进文档会误导后来者。真相：

| 字段 | 来源 | 同一账号重新登录 |
|---|---|---|
| `device_mid` | **我们随机生成**（`generateDeviceMid()`） | **会变** ⇒ **不可作标识** |
| `user_id` | **服务端下发**（`user.data.user_id`） | **不变** ⇒ 正确判据 |

依据（`zcode-login.ts` 的实测注释）：「同一 JWT 换任意随机 UUID 都返回 200」
—— `device_mid` 的**值不被服务端绑定校验**，插件每次登录都会生成一个新的。

⚠ 若照错判据实现，**同一账号重新登录一次就会被判成新账号**，
去重功能**反向失效**（比不做还糟：用户以为去重了，实际每次登录都多一条）。
`tests/unit/zcode-dedup.spec.ts` 里有一条**专门的反例**把它钉住。

#### 9.2 `user_id` 此前**根本没被存进凭据**（去重的前提缺失）

`startLogin` 组装 `ZcodeCredential` 时**丢掉了 `loginResult.userId`** ——
登录响应里明明有（官方断言它是必需字段），但从未被搬进凭据。
故修去重必须**先补这个字段**（`src/zcode.ts` 的 `ZcodeCredential.user_id`）。

⚠ 该字段**可选**：2026-10-02 之前登录的凭据没有它。
`isUsableZcodeCredential` **不得**因缺它而拒绝（否则老用户突然无法用）——
已有用例锁住这点。

#### 9.3 判据查询：新增 `findAccountIdByIdentityField`

与既有的 `findAccountIdByCredential` **有意不同**（别合并）：

| | `findAccountIdByCredential` | `findAccountIdByIdentityField` |
|---|---|---|
| 用途 | **限流记录归属** | **通用去重** |
| 字段 | 写死两套（`access_key_id` / `access_token`） | 调用方指定 |
| `enabled` | **只看已启用** | **不看**（停用账号同样占位置） |

⚠ **必须容忍字段缺失**：读不到该字段的条目**跳过**（= 无法判断），
而不是当成「不匹配」或报错 —— 前者漏判，后者让老用户添加不了账号。

#### 9.4 时机与处置

- **时机必须在登录成功之后**：登录前只有占位条目（无凭据、无 `user_id`），
  无从判断。故去重在 `jet-hub-rpc.ts` 的 `started.result.then(...)` 里。
- **处置是「停用 + 改名」，不是删除**：
  前端 `login.poll` 靠「条目还在 + 凭据已写入」判断登录成功，
  **删掉条目会显示成「登录失败」**（事实恰恰相反），
  会误导用户反复重试。现在：`enabled: false`（⇒ 不参与选号，这就是去重的
  实际效果）+ 昵称标「（重复，已停用）」+ 日志。
- **保留原来那条不动**：它可能已被排序、改名或承载限流记录。

#### 9.5 回归与反向验证

- `tests/unit/zcode-dedup.spec.ts`（7 条）：`user_id` 能匹配 /
  **`device_mid` 不能匹配**（反例）/ 缺字段时跳过 / 空 identity /
  跨 provider 不误判 / 停用账号参与判重 / 老凭据仍可用
- `tests/unit/zcode-rpc-login.spec.ts` 新增 2 条**接线验证**：
  「同一账号添加两次 ⇒ 第二条被停用」「凭据里带上 user_id」

⚠ **已做两次反向验证**（这次特别注意确认替换**真的生效** ——
上一次因 CRLF 静默失败过）：
- 删掉 `user_id` 的搬运 ⇒ **2 条变红**（含「添加两次」那条）
- 短路 `findAccountIdByIdentityField` 调用（保留 user_id 存储）⇒
  **1 条变红**（「添加两次」那条）
⇒ 证明两类用例分别覆盖「字段没存」与「没做去重」两种失效。

⚠ **写这类用例的脚手架坑**：`AccountPool` 是**真实**实现、会读写磁盘，
必须 ① `mkdtempSync` + `DSH_JET_HUB_STATE_DIR` 隔离；
② 用 `ctx.provide('credentials', fake)`（**不是**属性赋值 ——
`AccountPool` 经 `ctx.credentials` 取服务）；
③ **不要**用 `replaceAll`（那是 Jet Hub 的导入路径，语义不同；
我第一版用它导致 3 条用例假失败）。

### 十、⚠️⚠️ **不再读取本机 ZCode 客户端的数据**（用户决策 2026-10-05，Issue IKJNPZ）

**用户决策**：「可否改成不读本机 ide 的数据，只用我们自己的 auth 流程」——
**已整体执行**。凭据现在**只有一条来源**：插件自己的 OAuth 流程
（`zcode-login.ts` → 写 `ctx.credentials`）。

#### 10.1 起因：Issue IKJNPZ 暴露了那条路的**双重失效**

用户报障（2026-10-04，issue IKJNPZ）：zai 渠道下读本机凭据得到的
`account_label` 退化成「设备xxxxxxxx」、`user_id` 缺失。

**本机实机复现**（`credentials.json` 实为 `oauth:zai:*` 一族，
`oauth:active_provider = "zai"`）：

```
zcode_jwt     ✅ len=255      device_mid  ✅ len=36
user_id       ❌ 缺失          account_label = 设备72c145cd
bigmodel_access_token ❌ 缺失   zai_access_token ❌ 缺失
```

⚠⚠ **issue 建议的修法不足以解决它自己描述的连带影响** ——
`KEY_FRAGMENTS.userInfo` 从 `'oauth:bigmodel:user_info'` 放宽成 `'user_info'`
**只能修好 `account_label`**。因为**两个渠道的 user_info 形状根本不同**：

| | 键名 | 实测形状 |
|---|---|---|
| bigmodel | `oauth:bigmodel:user_info` | `{id, username, displayName, rawProfile}` |
| **zai** | `oauth:zai:user_info` | `{user_id, email, avatar, name}` ← **没有 `id`** |

⇒ `readUserIdFromUserInfo()` 只认 `id` / `userId` / `rawProfile.user_id`，
**不认顶层 `user_id`**；`identityFromUserInfo()` 只认 `displayName` /
`username` / `rawProfile.name`，**不认 `name`** ⇒ 放宽片段后 `user_id` 与
`account_name` **仍然缺失** ⇒ `adoptOfficialCredential` 的**闸②**
（`user_id` 缺失 + 池里有其它账号 ⇒ 失败关闭）**照样拦下**。
⚠ **教训**：报障者只看了一层（键名匹配），没看下一层（**结构**不兼容）。
按建议改完仍会复现「连带影响」。

⚠ **issue 也漏了第 4 处**：`readZcodeCredential` 只填
`bigmodel_access_token`，**`zai_access_token` 是死字段**（全仓只有
`zcode-auth.ts` 的登录路径会填它）⇒ zai 账号走该路时
`fetchCodingPlanApiKey` 的 `zai ?? bigmodel` **两边都是 undefined**。

#### 10.2 删除范围（`git diff` 实测：src 净减约 700 行）

| 文件 | 删掉的东西 |
|---|---|
| `src/zcode.ts` | `readZcodeCredential` / `resolveZcodeCredential` / `readRawCredentials` / `credentialFileCandidates` / `resolveCredentialFilePath` / `decryptCredentialValue` / `deriveCredentialKey` / `pickCredential` / `KEY_FRAGMENTS` / `readDeviceMid` / `telemetryFileCandidates` / `detectZcodeAppVersion` / `labelFromUserInfo` / `identityFromUserInfo` / `readUserIdFromUserInfo` + 全部 `enc:v1:` 常量（597 → 178 行） |
| `src/zcode-auth.ts` | `ZcodeAuthOptions.readCredential` 注入点、`localCredential()`、`adoptOfficialCredential()`、`adoptIntoOrphanAccount()`、`hasStoredCredential()`、`hasOtherZcodeAccounts()`、`accountIdOf()`（−255 行） |
| `src/jet-hub-rpc.ts` | `account.create` 里的两段本机复用短路（孤儿收编 / 同 `user_id` 返回 `{reused:true}`） |

**保留**：`phoneFromUserId`（登录路径在用）、`isUsableZcodeCredential`、
`isZcodeExpired`、`ZCODE_APP_VERSION_FALLBACK`（`zcode-upstream.ts` 有 6 处用）、
`ZcodeCredential` 的全部字段、`source` 字段（**存量凭据**里可能写着 `'ide'`）。

#### 10.3 ⚠ 顺带修好 coding-plan：**一条早已断掉的链**

删除过程中发现的**既有**断链（与本次删除无因果关系）：

| | 状态 |
|---|---|
| `coding_plan_key_zai` / `_bigmodel` 的**唯一**写入点 | 上面被删的 `readZcodeCredential()` |
| 唯一能补 key 的 `fetchCodingPlanApiKey()` | **零调用方**（建好却没人调） |
| ⇒ 纯插件登录用户的 coding-plan（**付费**）通道 | **一直不可用** |

用户选择「顺手接线」后已修：`ZcodeAuth.resolveCodingPlanKey()` 由
`startLogin` 在组装凭据后调用，**best-effort + 8 秒超时 + 失败只记日志**
（没买订阅是常态，**绝不能**因此把用户挡在门外；`start-plan` 照常可用）。
⚠ **字段按「拿到哪个 OAuth token」落位**（zai → `_zai`，bigmodel → `_bigmodel`），
与 `zcode-transport.ts` 里 `zai ?? bigmodel` 的优先级一致。

⚠ **这次接线是删掉读本机凭据后**唯一**能让付费 plan 继续可用的路子** ——
不接它，装了 IDE 的用户会失去该通道（`glm-5.3` / `glm-5.3-flash`）。

#### 10.4 ⚠⚠ 防回退锁是**扫源码字面量**，不是「断言函数不存在」

`tests/unit/zcode-no-local-credential-read.spec.ts`（4 条）。理由：
删掉导出后，「有没有人重新加回读取逻辑」在运行时**无从断言** ——
新写的 `readZcodeCredentialFromDisk()` 不会让任何既有用例变红。
故改成扫 `src/*.ts`（先剥掉注释避免本文自身的说明文字误报），
命中 `.zcode/v2` / `credentials.json` / `telemetry-state.json` /
`zcode-install-manifest` / `zcode-credential-fallback` / `enc:v1:` /
`aes-256-gcm` 即失败。

⚠ **必须用词边界**：`zcode-auth.ts` 里仍有 `readStoredCredential` /
`readCredentialFromRef` / `readCredentialFromPool` 三个**合法**方法
（只读 `ctx.credentials`，不碰磁盘），裸 `/readCredential/` 会把它们一起误报 ——
我第一版就写错了，改成 `/\breadCredential\b/` 才绿。

⚠ **已做反向验证**：在 `zcode-transport.ts` 临时加回
`join(homedir(), '.zcode', 'v2', 'credentials.json')` ⇒ **1 条变红**并指出文件名；
还原后全绿。⇒ 不是同义反复。

#### 10.5 ⚠ 用户可见文案**必须同步改**，否则把用户引向无效操作

删的是能力，但**文案会留下来**。已改的三处（漏了任何一处都在误导人）：

- `zcode-adapter.ts` 的 401/1002 文案原写「请重新在**官方 ZCode 客户端**登录」
  ⇒ 现在去客户端登录**完全无效**（插件根本不读它），已改指 Jet Hub。
- `zcode-auth.ts` 的 `probe()` / `persistCurrent()` 原因文案原写
  「若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据」。
- `zcode-adapter.ts` 的 `MISSING_CREDENTIAL` 文案同款。

⚠ `types.ts` 的 `reused` 字段**保留**（当前已无 provider 会返回 `true`），
理由：它是**契约防御**（判据写成「后端声明复用则 `loginUrl` 为空是正常的」，
比反过来假设「空串必是错误」更稳），不必为一次能力下线去改前端渲染分支。
`forceNew` 则**已删**（前端 2026-10-02 起不再传、后端也不再读 = 无操作）。

#### 10.6 踩过的两个坑

1. ⚠ **反向验证脚本本身出错，比反向验证失败更危险**：第一次用
   `PowerShell -replace` 时把拼接表达式写进了参数位（`-replace` 只接 3 个参数），
   脚本在写入前抛错，`$mutated` 仍为空 ⇒ **把源文件清空了**，
   测试报的却是 `ZcodeAuth is not a constructor`（看着像接线坏了，其实是文件没了）。
   ⇒ 教训：**写回前必须校验**（`if ($mutated -eq $backup) { 还原; throw }`
   外加字符数变化量守卫）。第二次加守卫后又因阈值过严（403 > 400）主动中止并还原 ——
   守卫本身是对的。
2. ⚠ **mock `runZcodeLogin` 必须回调 `onAuthorizeUrl`**：`startLogin` 是两步式，
   它 `await` 一个**只由该回调 resolve** 的 `urlPromise` ⇒ 替身不回调就整条用例
   5 秒超时，症状看起来像「接线失败」。且**别用逐条 `mockImplementation`**：
   `() => fakeLogin(...)` 这个箭头函数**不接参数**，会把含 `onAuthorizeUrl` 的
   `options` 整个吞掉 —— 同一个坑的第二个入口。正确做法是**可变状态** +
   单一实现始终透传参数（`zcode-coding-plan-key.spec.ts` 即此写法）。

#### 10.7 回归与反向验证

- `zcode-no-local-credential-read.spec.ts`（4 条，防回退）——反向验证过（1 条变红）。
- `zcode-coding-plan-key.spec.ts`（6 条，coding-plan 接线）——**反向验证过**：
  摘掉 `startLogin` 里那 4 行接线 ⇒ **恰好 2 条**「换到 key」变红
  （`expected undefined to be 'AK-1.SECRET'`），另 4 条「不牵连登录」仍绿
  ⇒ 说明两类用例分别覆盖「接上了」与「失败不炸」两种失效。
- 5 个受影响的既有 spec 改用**真实 `ctx.credentials` 路径**注入凭据
  （不再用已删的 `readCredential` 注入点）—— 这反而是**更好的测试**：
  它们现在覆盖的是生产环境真正走的路径。

⚠ **子代理并发改测试时的竞态**：本次两个 agent 并行改测试，其中一个在跑全量时
撞上我正在用脚本改写 `src/zcode-auth.ts`，`readFileSync` 读到空串报
`expected '' to match /extends Service/`。**那不是缺陷，是写入竞态** ——
**改完必须整体重跑全量**再下结论。

## ⚠️⚠️ `3012` 的 HTTP 状态码是 **405**（不是 403），且身份块**之外**的变量已全部排除（Issue IKJI0Y，2026-10-03）

**用户报障**（issue IKJI0Y）：免费通道调用模型返回
`上游风控拦截（3012 unusual activity）`，但他**逐字核对了身份块**
（`2898` 字符 vs 声明的 `2900`），怀疑还有别的触发因素。
且他指出错误文案**没有任何可观测信息**，排查只能靠猜。

### 一、复测结论：**唯一的判据仍然是身份块**

本机**复现了 3012**（三个账号、17 次真实请求）。消融矩阵：

| 消融 | 结果 |
|---|---|
| 裸请求（无身份块·无日期块·极简头） | ✗ **405 + 3012** |
| 无身份块、其余官方头齐全 | ✗ **405 + 3012** |
| **有**身份块 + **极简**头（无任何 `X-*`） | ✓ 200 |
| 有身份块、**不带日期块** | ✓ 200 |
| 有身份块、`app_version` 报 `3.14.4` / `4.0.0` | ✓ 200 |
| 三个账号各一发完整形态 | ✓ 200 ×3 |
| 多轮历史（`tool_use` / `tool_result`） | ✓ 200 |
| 带 `tools`（DSH 每步 24 个） | ✓ 200 |
| **单账号无间隔连发 6 发** | ✓ 200 ×6 |
| 无 `Authorization`（阴性对照） | 401（鉴权与身份块相互独立） |

⇒ **频率、并发、多轮历史、工具声明、版本头、账号池**均**非**判据。

### 二、⚠️ 两条**必须修正**的旧说法（别再照旧口径排查）

1. **HTTP 状态码是 `405`，不是 `403`**。按 403 排查会一路走到
   「风控 = 鉴权/权限」的错误分支。响应体还带 **`logid`** ——
   向用户索取现场时**优先要它**（上游侧排障凭据）。
2. **日期块在这个窗口不是判据**（去掉照样 200）。它仍**照发**
   （官方如此、零成本），但它与身份块是**必要非充分** ——
   ❌ **不要再把「3012 的最后一个开关」当成唯一结论**（那句来自早期窗口）。

⚠ 顺带纠正一处**文档数字打架**：`zcode-identity.ts` 头注释曾写
「`cliPrefix + stable（前两块）= 2355`」与「完整四块 = 7599」，
而实际 `stable` 是**三段**、合计 **2856**，前缀后共 **2898**；
README 曾写 2900。⇒ 三处已统一为 **2898**，单测锁死 `42+2856`。
（`tests/unit/zcode.spec.ts` 那条「>2300 且 <3000」的量级断言保留，
但它**锁不住**逐段数字 —— 新增的诊断用例补上了逐段断言。）

⚠ **因此「身份块达标仍 3012」目前没有已知解释**。若再遇到，
唯一能区分「账号自身被标记」与「共用出口 IP 被标记」的办法是**看诊断行**。

### 三、本次新增：`3012` 的错误文案带**可观测诊断行**

新文件 **`src/zcode-diagnostics.ts`**（进程级，**不落盘** ——
与 `captcha-requirement.ts` 同口径：`jet-hub/state.json` 是同机多 profile
共享的 home 级文档，落盘会把一个 profile 的画像传染给另一个）。

实测输出：

```
zcode: 上游风控拦截（3012 unusual activity）。⚠ …请勿连续重试。
本机诊断：账号#1 · 本进程 成功 1/失败 2 · 最近成功 1分29秒前 · 距上条 2.4s ·
身份块 2898 字符(42+2856) · 日期块 有 · HTTP 405
原始响应：request has been blocked due to unusual activity.
```

⚠ **三条不能写错的设计**：

1. **诊断行绝不含凭据**。账号只以**进程内自增序号**（`账号#N`）出现，
   不含 accountId / JWT / device_mid 的任何片段。
   用例用「**逐子串排除**」（连 `1a2b` 这种半截都排除）钉死这条 ——
   防止将来有人「图方便」改成截前 8 位。
2. **身份块字符数必须读「实际构造出来的 `system`」，不是常量**。
   常量只能证明「源码里写了多少字」，证明不了「线上发出去多少字」。
   真出现「身份块没进请求体」时会如实显示 `0 字符`，
   而不会显示 2898 把问题盖住。⚠ 用例专门断言了这一条。
3. **`距上条` 的分母是 `previousSentAt`，不是 `lastSentAt`**。
   适配器的调用顺序是「先 `noteZcodeRequestSent` 记**本次**、再在失败时诊断」，
   两者用同一个 `sentAt` ⇒ 若诊断读 `lastSentAt`，算出来**恒为 `0ms`**。
   ⚠ 这个缺陷是**端到端脚本真的打印出 `距上条 0ms` 才暴露的** ——
   首版单测按「记一条旧的、直接诊断一条新的」写，**全绿但是假绿**。

⚠ **单测必须按适配器的真实调用顺序写**（先记本次、再诊断）。
这是本条最容易重犯的地方：写反了用例照样绿。

⚠ `formatGap` 的分钟/小时档要**逐档单独算**（初版写成
`${Math.floor(seconds % 60)}分` ⇒ 90 秒渲染成「30分30秒」，
同样是在**真实输出**里才发现的，纯函数单测当时没覆盖 ≥60 秒）。

⚠ 只给 **3012** 附诊断：`3009` / `1005` / `3007` 的文案**本身已说明原因**，
附加只会让它们变脏（且各有单测钉住措辞）。
**不传诊断时行为与原来逐字一致**（旧调用点不受影响）。

⚠ `noteZcodeRequestOk/Failed` 必须用**局部可变的** `activeAccountId`
（切号后会变），与额度切号那段是同一条纪律：标记要记在真正发出这条请求的
账号上，否则切到 B 之后失败会把账记到 A 头上。

**回归**：`tests/unit/zcode-diagnostics.spec.ts`（17 条）。
⚠ **已做四轮反向验证**：诊断改读常量 ⇒ 1 条红；诊断行塞 accountId ⇒ 2 条红；
间隔退回读 `lastSentAt` ⇒ 3 条红；`formatGap` 退回旧 bug ⇒ 2 条红。

取证脚本（**均只读、零额度**）：`scripts/probe-zcode-3012-issue.mjs`（身份块自检 +
消融）、`scripts/probe-zcode-3012-matrix.mjs`（负向对照矩阵，**会真的触发 3012** ——
⚠ 有冷却惩罚，跑前先想清楚）、`scripts/probe-zcode-3012-accounts.mjs`（账号/多轮/频率）、
`scripts/verify-zcode-3012-diagnostic.mjs`（用实测响应体做端到端文案组装，**零网络**）。

## ⚠️ ZCode captcha 的真实形状（2026-10-01，3.14.4 之后）

**官方 3.14.4（2026-09-29 发布）更新说明：「关闭模型请求验证码校验」。**
我们随后直连上游实测（`scripts/probe-claim-gate.mjs` 等）得到两个结论级的判据：

| 端点 | 不带验证头 | 结论 |
|---|---|---|
| `/api/v1/zcode-plan/anthropic`（模型请求） | **HTTP 200**（6 个采样点，正文正常） | **不再索要** ⇒ 推理路径 mint 次数**恒为 0** |
| `/api/v1/zcode-plan/billing/claim`（领取） | `400 / 3007`（带**非法** captcha 同样 3007） | **始终索要**，校验**前置于** plan 校验 ⇒ mint 只剩这条低频路径 |

⚠ **三条不许再犯的**：
1. **判据只能来自直连实测**。我们走的是 `zcode.z.ai` 的 HTTP，与客户端是哪种构建无关。
2. **静态取证用错基准会得出假结论**：我曾拿本机 3.14.3 与 scoop 3.14.4 的 renderer 产物
   做符号对比，想据此判断"官方是否索要" —— 但**两个都是开源构建**（`@zcode/desktop` +
   `workspace:*` 依赖），而**开源版本来就不带 captcha 生产者**（开源/闭源差异见 bonus-plan
   文档），于是 3.14.3 的"零命中"被误当成"官方不索要"的证据。真相来自上游实测。
3. **"窗口期不校验"这个说法已经作废**：此前 6 次采样"不带也 200"并不是时段现象，
   而是 3.14.4 之后的**常态**（模型请求）。别再为此挂哨兵等窗口。

**桌面内部载体（`src/captcha-supply.ts` / `captcha-carrier.ts` / `captcha-carrier-server.ts`
/ `zcode-carrier-page.ts` + `plugin-src/client/zcode-carrier.js`）**：
`dshDesktop.browser.acquire()` → 隐藏 `<webview src="about:blank#<lease>">` → 问
`captcha.carrierUrl` 要地址 → 导航到那个**独立回环端口**上的载体页 → `executeJavaScript` 读
`window.__zcodeCaptcha` → RPC 回传供给槽。**零 CDP、零 DSH 本体源码改动**（走官方
sidebar-browser 自己的通道）。

### ⚠⚠ 载体页**必须**另起一个回环端口（2026-10-02 真机取证，别再改回同源）
初版把页面挂在插件自己的 `/api/jet-hub/captcha-carrier`，理由是"与 GUI 同源"—— **这个前提是错的，
真机上收益恒为 0**。DSH Desktop 0.2.0-rc.2 的 `resources/app.asar/lib/main.js` 原文：

| 判据 | 后果 |
|---|---|
| `allowedNavigation(v)` = http(s) + 无账号密码 + `!isApplicationHost(url)` | 命中即 `preventDefault` |
| `isApplicationHost(u)` = **`u.port === host.port`** 且（主机相同或回环） | 插件 API 与 Host 同端口 ⇒ 命中 |
| `onBeforeRequest`：命中 `isApplicationHost` 就 `callback({cancel:true})` | 请求发不出去 |
| `acquire()`：`partition = \`dsh-sidebar-browser-${randomUUID()}\`` | **无 `persist:`** ⇒ 内存 session，没有 Host 会话 cookie |

⇒ 桌面 GUI 真实 origin 是自定义 scheme `dsh-app://app/`，插件 API 由 `forwardWebRequest(request,
hostUrl, hostCookie)` 转发到 `http://127.0.0.1:<host 端口>` ⇒ 载体页挂在那个端口上
**每轮都在第一个判断退出、guest 都不建**，且失败被 `preventDefault` 吞掉，日志一切正常。
✅ **`isApplicationHost` 要求端口相同 ⇒ 换端口即绕开** ⇒ server 侧懒起一个
**只监听 `127.0.0.1`、只有 `GET /carrier`、只回静态 HTML** 的小服务（`src/captcha-carrier-server.ts`），
client **每轮**问 `captcha.carrierUrl`（`null` ⇒ 记 `no-carrier-url` 并安静退出）。
⚠ 那条 `/api/jet-hub/captcha-carrier` 旧路由**保留**（web 版下手工诊断用），但**不许**再拿它当 guest 入口。

✅ **真机已实测通过**（2026-10-01，DSH Desktop 0.2.0-rc.2 真窗口，开机自检逐段）：
`carrierUrl` → `http://127.0.0.1:19469/carrier`（插件自起的独立随机端口）→ `acquire` 得
`dsh-sidebar-browser-f34495a3-…` → 隐藏 `<webview>` 导航 → 注入读回 `origin=http://127.0.0.1:19469`
⇒ **换端口确实绕开了 `isApplicationHost`** → guest 里成功产出 `len=280` / `interactive=false`。
⚠ **只剩「上游接不接受这个 param」未实测** —— 领取是真实操作、会消耗用户额度，不代跑；
它由降级链第 ④ 条兜住（当次换 chromium + 累计 3 次禁用内部载体）。
⚠ 排查看日志里的 `reason=<分类码>`（人话见 `CARRIER_FAILURE_LABELS`）。

⚠ **设备信誉不跨启动**（2026-10-02 纠正 I4）：主进程按 workspace 键缓存 partition，但那张表在
**进程内存**里、partition 名**没有 `persist:` 前缀** ⇒ 内存 session。
**同一次运行内**释放/重建 guest 仍是同一台设备；**DSH 一关，下次启动就是一台全新设备**
⇒ 跨启动信誉不保留，这会**抬高**被降级成交互式验证的概率。
那个信号现在会随 `captcha.contribute` 的 `interactive` 字段回传 host 并 `warn`
（`captchaSupplyStats().interactive` / `pendingInteractive`，见 `carrier.stats().supply`）。

⚠ **收益口径**：需求位只挂在 **claim** 入口（`ZcodeAuth.claimDailyWith` 的 try/finally），
而 client 产一个 param 要 2–4 秒 > 槽的 1.5 秒等待 ⇒ **首个 plan 多数仍走 chromium**。
内部载体的价值是**去掉对 chromium 的依赖**（没装可用 chromium 的用户从"领不了额度"变可领），
**不是提速**。降级链：槽内有就用 → 空则等 ≤1.5s → 等不到用 chromium → 内部 param 被 `3007` 拒
则当次改用 chromium 重发、累计 3 次禁用内部载体（`DSH_ZCODE_INTERNAL_CARRIER=0` 可全关）。
⚠ 这条降级链**领取路径也接上了**（`claimDailyWith` 内，评审 C4）：领取端点**始终**索要 captcha
且校验前置于 plan 校验，是内部 param 最容易被拒的地方；重发**上限一次**，
换 chromium 后仍被拒的文案要能让用户看出「这更像设备信誉问题」。

### ⚠⚠⚠ captcha 的 **region 必须与产 param 的那份配置同源**（Issue IKJNPS，2026-10-05）

**真实缺陷**（用户报障，Gitee issue IKJNPS）：z.ai 国际渠道账号点「一键领取」**恒失败**
`captcha 校验失败（zcode-v3-start-plan-trust-1004）`，15/15 全部 `400 / code 3007`；
同账号在 ZCode IDE 里正常。多账号 / web 版 / 桌面版 / 换浏览器链路都一样。

**根因**：region 与 param 是**两份真相**。

| | 修复前取自 | 值 |
|---|---|---|
| param（`mintCaptcha` 用的配置） | 调用方 `fetchCaptchaConfig()` → **服务端下发** | `sgp` |
| 请求头 `x-aliyun-captcha-verify-region` | `claimDailyFor` 的**默认参数** `ZCODE_CAPTCHA_FALLBACK.region` | `cn` |

阿里云验签把 param 与 region **成对**校验 ⇒ 不一致即 `3007`。
⚠ **作者本人在 cn 区**（本仓库兜底常量与 README 实测记录都是 `cn`），所以本地永远复现不到；
**非 cn 区账号 100% 复现**。⚠ 这类「本地默认值恰好等于服务端值」的缺陷具有**零本地症状**。

**修法（采纳 issue 的第 2 条：配置成为唯一真相源）**：
- `ZcodeAuth.claimDailyWith` 在 **plan 循环之前**解析**一次**配置
  （`fetchCaptchaConfig().catch(() => undefined) ?? ZCODE_CAPTCHA_FALLBACK`），
  同时落进 `this.captchaMintConfig`（`CaptchaCarrier` 那条 chromium 兜底腿读它），
  `region = captchaRegion ?? captchaConfig.region`；
- 注入回调的类型改成 `ZcodeClaimCaptchaMint = (config: ZcodeCaptchaConfig) => Promise<string>`，
  **实参就是那份配置**；`jet-hub-rpc.ts` 里改为 `async (config) => zcode.mintCaptcha(config)`
  （原来自己再拉一次 —— 那正是「两份真相」的来源）；
- `claimDailyFor` / `claimDaily` 的 `captchaRegion` **取消 `cn` 默认值**（可选覆盖仍保留）；
  `3007` 换链重发**沿用同一份配置**（换 param 不换 region）。

⚠⚠ **同型第二个实例（推理路径，别只修领取）**：`zcode-adapter.ts` 组头时原来恒写
`this.options.captchaRegion ?? 'cn'`，而 param 来自 `resolveZcodeCaptchaConfig()`（远端）。
现为 `this.captchaConfig?.region ?? this.options.captchaRegion ?? 'cn'` ——
`this.captchaConfig` 由 mint 回调里的 `setCaptchaConfig(remote)` 写入，且 **mint 先于组头**，
所以读到的一定是**本次 param 用的那份**。`index.ts` 里那个字面量降级为「连配置都没有」的兜底。

⚠ **`TtlCache` 连 `undefined` 也缓存**（`get()` 无条件 `write(value)`），
而 `fetchZcodeCaptchaConfig` 自己吞掉全部异常返回 `undefined`
⇒ **数「`/client/configs` 请求次数」判不出「配置是否被重复解析」**（实测把解析搬进
for 循环，用例仍全绿）。「只解析一次」只能锁**源码结构**（解析在 `for` 之前）。

回归用例 `tests/unit/zcode-captcha-region.spec.ts`（8 条：sgp 同源 / 失败一起退兜底 /
显式覆盖 / 循环前解析 / `3007` 重发仍同源 / 推理路径同源 / 两条源码看守）。
⚠ 已做**反向验证**：region 改回兜底常量 ⇒ 3 条红；适配器改回写死 `cn` ⇒ 推理那条红；
解析搬进循环 ⇒ 结构那条红。

⚠ **issue 附注的「web 版 3007 不重试」维持现状**（不是遗漏）：`source === 'chromium'`
本身就说明**载体链本轮没参与**（web 版拿不到 `dshDesktop.browser` ⇒ `supplied` 恒 0，
或 env 关了）⇒ **没有第二条链可换**；且重试只白扣同设备每小时 150 次配额，
面对同一个服务端判定期限期望收益极低。修好 region 后 chromium 侧残留的 `3007` 都是时效/信誉性质。

## ⚠️⚠️ 冷启动切号空转：代价是**硬失败**（不是「慢一发」），且 `tried` 有**三重冗余**（2026-10-06）

**用户报障**：「用完余额一个号就自动卡死了，不会切下一个号。」

### 一、根因与修法（`src/zcode-adapter.ts` 的 `streamScoped`）

`currentAccountId()` 读的是 `index.ts` 的 `activeZcodeAccountId` 那个 Map，
而它**只在 `resolveCredential` 内部被写入**。原先顺序是反的：

```ts
let activeAccountId = this.options.currentAccountId?.()      // ← 先读（冷启动时是空的）
let credential = await this.resolveCredentialOrThrow(options) // ← 后写
```

⇒ `activeAccountId === undefined` ⇒ `switchAccountOnQuota()` 的守卫整段跳过
（**既不标记、也不放进 `tried`**）⇒ 池按手动顺序返回的第一个候选正是刚失败的那个
⇒ 这次「切号」切回同一账号、同一份凭据，白发一发。
**修法：取凭据移到读 id 之前**，让两者指向同一账号。

### 二、⚠ 代价是**硬失败**，别再说成「空转一发」（复审实测，2026-10-06）

受 `quotaSwitchMax === 2` 限制，一次请求最多 3 发。「空转」那一发把切号预算吃掉一格：

| 池 | 修复前 | 修复后 |
|---|---|---|
| 2 账号（A 用尽、B 可用） | `[A, A, B]` **成功** | `[A, B]` 成功 |
| **3 账号（A、B 用尽、C 可用）** | **`[A, A, B]` ⇒ 抛 `QUOTA_EXCEEDED`，C 从未被尝试** | `[A, B, C]` 成功 |

⇒ **池里最后一个账号永远够不着**，用户看到「所有号都用完了」而那个号还有额度。
报障措辞「卡死」是**准确的** —— 把它降级描述成「慢一发」会让人低估修复价值。

⚠ **回归必须用 ≥3 账号池**：2 账号池下缺陷版也能成功（`[A,A,B]`），
**复现不出用户症状**。`tests/unit/zcode-rotation-coldstart.spec.ts` 第 1 条就是它，别改成 2 账号池。

### 三、⚠ `tried` 与限流标记是**三重冗余**，行为测试锁不住「谁负责排除」

排除刚失败的账号有三道防线：① `streamScoped` 顶部的 `tried.add`；
② `switchAccountOnQuota` 内部同一个 add；③ 写进池的 `modelRateLimits`
（`getAvailableAccount` 自己会过滤）。

⇒ **单点删除任一处，行为断言仍然全绿**（2026-10-06 复审实测：删 ① 绿、删 ② 绿、
删两处才红）。这不是缺陷而是 defense-in-depth，但它意味着**行为测试对接线零区分能力**。
故该 spec 第 4 条直接断言**契约**：首次切号传给池的 `tried` 必须含失败账号
（删两处 ⇒ 变空）、且必须写下该模型的限流标记（删写入 ⇒ `marks` 为空）。
⚠ 实测口径：删**两处** `tried.add` 时第 4 条变红而第 1~3 条仍绿；
删标记写入时第 4 条同样变红。

### 四、⚠ 兜底路径（`zcode.current()`）**不是**缺陷 —— 别「顺手修」

池被筛空时落 `index.ts` 的 `zcode.current()` 兜底（它不看 `enabled`/限流，照样返回凭据），
此时 `activeAccountId === undefined` ⇒ 守卫跳过 ⇒ **不标记任何账号**。

复审用 5 条独立探针实测后判定：**这是对的，不是漏修**。
`getAvailableAccount` 本身就按 `enabled` + `modelRateLimits` 过滤，
**能走到兜底就意味着已无「enabled 且未限流」的账号可切** —— 标记谁都不会让它被选中，
只会写一条永远不起作用的记录。正确行为是「只发 1 发、不写无效标记、如实报 `QUOTA_EXCEEDED`」，
spec 第 5 条把它钉住（防止将来有人「顺手补上标记」）。

### 五、⚠⚠ 教训：**「未经证实的修复」不得随同真修复夹带合入**

同批还有一个「边缘拦截页归不可重试」的改动，声称「48 小时实测 127 次」。
复审解压全部 577 个会话日志复核：**405+HTML 命中 100% 来自该 PR 自己的 diff 与测试代码**，
排除后真实会话里为 **0 处**；注释声称「与 `probe-jethub-models.mjs` 同口径」，
而该文件**在整个 git 历史中不存在**。

而它引入的是**真实可用性回归**（master vs 该改动）：

| 响应 | master | 该改动 |
|---|---|---|
| 502 nginx 页 `<html>…502 Bad Gateway…` | `SERVER`（可重试） | **`PERMISSION`** |
| **504 阿里云 ALB 页（2026-09-29 真实 zcode 响应）** | `SERVER` | **`PERMISSION`** |
| 429 被 CDN 包成 HTML（本仓库 `account-pool.ts` 自己记过的形态） | `RATE_LIMIT` | **`PERMISSION`** |

`PERMISSION` **不在** `DEFAULT_RETRYABLE_CODES`（`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）
⇒ 标准可重试的瞬态网关错误被降为不可重试。且该 PR 的描述**明确承诺「只含冷启动修复」**，
diff 里却带着这一整段 ⇒ 维护者按描述复审会放行一段未复审的改动。**已整体剔除。**

两条可复用的审查规则：
1. **「N 次实测」必须能定位到一手响应**；若统计口径命中的是**判据自己的字面量**
   （如 `data-spm` 出现在 diff/测试文本里），那是自我指涉的循环论证，不构成证据。
2. **凡新增「不可重试」判据，必须逐个验证既有可重试形态不被吞掉** ——
   只拿纯文本样本断言「普通 5xx 仍可重试」（`'service unavailable'`）会**恰好绕开 HTML 形态**，
   给出假保证。要拿 nginx/ALB 的**真实 HTML 页**当样本。

### 六、⚠⚠ 浏览器候选链：Windows 上 `homedir()` **恒等于** `USERPROFILE` ⇒ 行为判据不可用（PR #75，2026-10-06）

第三方（@Ghandi）提交 PR #75，指出「探测跟随 `os.homedir()`」那条用例
（`tests/unit/zcode-browser-detection.spec.ts`）**恒真**。本机复核后**结论要分两半**：

**✅ 成立的一半**：原用例**确实守不住目标**，但**根因与 PR 作者所述不同**，
且在 **Windows 上同样恒真**（他只验了 macOS）。原用例靠
`setEnv('USERPROFILE', dir)` 造家目录变化，而本机实测：

```
未变异：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-KGiOeH  found = undefined
变异后：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-RP5R3e  found = undefined
                                          ← 逐字相同 ⇒ 用例照样全绿
```

根因：**Windows 上 `os.homedir()` 本身就取自 `USERPROFILE`** ——
「读 `homedir()`」与「读死 `USERPROFILE`」算出**同一个值**，
任何基于「结论是否变化」的判据都**不可能**区分二者。
⇒ **别再用「改 env 看结论」判这一条**，跨平台都不可行。

**⚠️ 不成立的一半**：PR #75 把该用例改判「`home` 注入口被尊重」
（纯函数 + 钉平台 + `realHomeScoop()` 反向判据）。那条**本身是有效的**
（变异 `const home = homedir()` 确实变红，已复核），但它守的是
**另一个更弱的性质** —— 「注入口被尊重」**推不出**「没给注入口时回落到 `homedir()`」。
⇒ **PR 合入后，那条本文件头声称要守的性质一度完全无人看守**：
实测把实现改成 `input.home ?? process.env.USERPROFILE ?? homedir()`，
`zcode-browser-*.spec.ts` **43 条全绿**、全量 **6060 条全绿**。

**⇒ 已补结构判据**（同文件末尾两条）：剥注释后扫源码，
断言三个分支函数体内无 `USERPROFILE`、且 `home` 默认值仍为 `input.home ?? homedir()`。
范式取自 `raccoon-client-independence.spec.ts`（「不读取任何环境变量」）。
**三种绕过实测全部变红**：① 默认链加 `?? process.env.USERPROFILE`；
② 在 `windowsBrowserCandidates` 里偷读 `process.env.USERPROFILE`；
③ 拆成 `process.env['USER' + 'PROFILE']`。
⚠ 另加一条「扫描健壮性」护栏（证明真扫到了四个函数 + 代码正文），
否则「一个文件都没扫到」会让整条判据**静默恒真** —— 同 `raccoon` 那条的教训。

**三条可复用规则**：

1. **改断注入口的测试前，先问「被守的性质是否等价」** —— 新判据可失败 ≠ 原性质被守住。
   守「注入口被尊重」与守「默认值来自 `homedir()`」是**两条不同的断言**。
2. **`homedir()` 与 `USERPROFILE` 在 Windows 上不可区分** ⇒ 这类契约只能**结构判据**守，
   任何行为判据（改 env、看结论、比对路径）在 Windows 上都会恒真。
3. **扫描类断言必须自带「扫到了东西」的护栏**，否则空扫描 = 全绿。

⚠ 同批关联：IKJMQ5（CWD 竞态）与 IKJPBJ（墙钟定时器）由 PR #75 一并关联关闭。

