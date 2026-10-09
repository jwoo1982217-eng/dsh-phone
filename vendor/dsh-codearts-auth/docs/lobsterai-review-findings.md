# LobsterAI 接入的对抗性审查报告

> **状态：全部已修复（本文件保留为审查追溯记录）**
>
> S1 / S2 / S3 / S4 / M1 / M3 / M4 / U2 均已修复并有回归测试；
> 每项修复都做过**反向验证**（把缺陷改回去、确认测试确实失败后再撤回）。
> 修复详情与「为什么首批 763 项测试全绿却漏掉这些」的分析，见
> `docs/lobsterai-integration-plan.md` §7.4「第二轮：独立审查发现的缺陷」。
>
> 未采纳的一项：**M2**（提交信息/文档失准）—— 属一次性事实陈述，
> 已在 §7.4 里如实记录为「修复曾无声丢失」的流程教训，不再回改历史提交信息。

审查对象：`feat/lobsterai` 分支
初始审查基线：`a0319d5`（当时 HEAD）
审查方式：逐函数对比 `lobsterai2api` 参考实现；对可疑点**写临时测试实跑验证**，不靠阅读推断
结论：**发现 4 个严重、4 个中等问题**

> **审查期间有其他 agent 并行提交**（`9e34754` 清理死代码、`915545e` 补换号回归测试），
> HEAD 已前移。**S1/S3/S4 三个严重问题已在最新 HEAD（`915545e`）上逐条复核，
> 依然存在**。S2 因并行提交而状态变化，见该条说明。
>
> 本文档中 L1/L2 两条死导出已被 `9e34754` 清理，保留记录仅为追溯。

---

## 严重（会直接导致功能失效或数据错误）

### S1. 适配器从账号池取凭据，却刷新单凭据 ref —— 过期凭据被反复重发

**位置**：`src/index.ts:259-272`（接线）+ `src/lobsterai-adapter.ts:420-424`（消费）

```ts
// index.ts
resolveCredential: async () => {
  const available = await pool.getAvailableAccount('lobsterai', '')   // ① 从池取
  if (available) return available.credential as LobsteraiCredential
  ...
},
refresh: () => lobsterai.refresh(),   // ② 刷新的是 LOBSTERAI_ACCESS_TOKEN
```

`LobsteraiAuth.refresh()`（`lobsterai-auth.ts:321-343`）只读写 `this.credentialRefName`
= `LOBSTERAI_ACCESS_TOKEN`。而 ① 在账号池非空时返回的是**账号卡片的凭据**
（`LOBSTERAI_ACCOUNT_XXX`）。二者是不同的 ref。

**触发条件**：Jet Hub 里通过「+ 新建账号」登录（凭据落在 `LOBSTERAI_ACCOUNT_*`），
且该凭据过期。适配器检测到过期 → 调 `refresh()` → 刷新并回写 `LOBSTERAI_ACCESS_TOKEN`
→ 再次 `resolveCredential()` **仍从池取到那条未更新的过期凭据** → 带着过期 token 发请求。

**实跑验证**（临时测试）：
```
refresh 被调用 = 1 次；目标是 ref = LOBSTERAI_ACCESS_TOKEN
池凭据的 access_token 仍是 = POOL-AT
=> 刷新后 resolveCredential 返回的 access_token 仍为池凭据的旧值 POOL-AT
```

**后果**：每次请求都白跑一次续期，然后仍以过期凭据发请求 → 401。用户看到的是
「账号明明刚登录却一直认证失败」，而续期日志显示成功。这是最难排查的一类不一致。

**建议修法**：让适配器的 `refresh` 感知**它正在用哪个凭据**。最小改动是给
`LobsteraiAdapterOptions.refresh` 传入当前凭据或 ref：

```ts
// index.ts
refresh: async () => {
  const available = await pool.getAvailableAccount('lobsterai', '')
  if (available) return lobsterai.refreshAccountCredential(available.entry.credentialRef)
  return lobsterai.refresh()
},
```
`BuddyAdapter` 侧存在同构隐患，但本次不扩大范围。

---

### S2. `latest_keyfrom` 的「已对齐 Go」修复曾在 `e2d9362` 生效，但被后续提交覆盖后又恢复

**位置**：`src/lobsterai.ts:239`

`e2d9362` 的 diff 里明确含：
```
-  nowMs: number = Date.now(),
-    latestKeyfrom: String(nowMs),
+    latestKeyfrom: credential.latest_keyfrom ?? '',
```
且提交信息写着「另修正一处有意分歧，改回与 Go 一致」。实测各提交该行取值：

| 提交 | `lobsteraiKeyfromBody` 的 latestKeyfrom |
|---|---|
| `bb9cc92` | `String(nowMs)` |
| `e2d9362` | `credential.latest_keyfrom ?? ''` ✅ |
| `a0319d5` | `String(Date.now())` ❌（回归） |
| `9e34754` | `credential.latest_keyfrom ?? ''` ✅（已恢复） |
| `915545e`（当前 HEAD） | `credential.latest_keyfrom ?? ''` ✅ |

`a0319d5` 的 `--stat` 只删了一个临时文件（`.git-commit-msg2.txt`），**没有**碰
`src/lobsterai.ts` —— 说明那次回归是**工作区被覆盖后一并带入**的，而非有意改动。
`9e34754` 又恢复了正确值。

**这条的价值不在于「现在错了」，而在于它揭示了一个流程缺陷**：
`e2d9362` 声称的修复曾在某轮编辑中**无声丢失**，且丢失后 **763 项测试全部通过**
（因为当时 parity 断言与实现**同时**处于 `Date.now()` 状态？不——见下）。
实际更可能的原因是：丢失发生在一次**未跑测试**的编辑中，
而后续 `9e34754` 的清理恰好把它改回。

**已由 `tests/unit/lobsterai-parity.spec.ts` 覆盖**：实跑验证——把该行改回
`String(Date.now())` 后，该文件 **3 项测试失败**（`latestKeyfrom 用存储值`、
`缺 first/latest 时以空串占位`、`refresh body = keyfrom + refreshToken`）。
即**现在有保护了**。

**遗留建议**：`a0319d5` 这类「只删文件」的提交应当先 `git diff` 确认无意外夹带；
本次它夹带了 `src/lobsterai.ts` 的回归（还是工作区本就是脏的，无法从历史判定）。

---

### S3. 换号耗尽后的错误码与状态码**跨账号错配**

**位置**：`src/lobsterai-adapter.ts:546-551`

```ts
throw new LlmError(
  `lobsterai: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`,
  kind === 'hard-credit' ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status),
  { status: response.status },
)
```

`kind` 在 **498-499 行**由**第一个**账号算出后**再未更新**；而 `errorText`（539 行）
与 `response`（534 行）在循环里被**每个后续账号**覆盖。

**触发条件**：首账号错误类别 ≠ 末账号错误类别。

**实跑验证**：
```
A=402(积分不足) B=503(服务器错) → 最终 code = SERVER     ← 丢失了「积分不足」语义
A=401(会话死)   B=503           → 最终 code = SERVER
A=429(限流)     B=400(client)   → 最终 code = INVALID_REQUEST
```

第一例最严重：首账号是**积分不足**（`hard-credit`，是最需要用户看到的失败模式），
但末账号是 503 → `kind === 'hard-credit'` 为 false → 错误码变成 `SERVER`，
**用户完全看不到「积分不足」这个真实原因**，只能看到无意义的服务器错误。

**建议修法**：`kind` 与 `errorText`/`response` 同步更新（在循环内重算并记录
「最后一次的 kind」），或分别保存 `lastKind`/`lastStatus`/`lastText` 三者：

```ts
let lastKind = kind, lastStatus = response.status
...
errorText = await response.text().catch(() => '')
lastKind = classifyLobsteraiError(response.status, errorText)
lastStatus = response.status
...
throw new LlmError(msg, lastKind === 'hard-credit' ? 'QUOTA_EXCEEDED' : httpErrorCode(lastStatus), { status: lastStatus })
```

---

### S4. 换号循环给**错误的账号**写限流徽章

**位置**：`src/lobsterai-adapter.ts:513-528`

`currentAccountId` 在 533 行被更新为下一个账号，但 `kind` 停留在**前一个账号**的分类。

**实跑验证**：
```
A=429(限流) 失败 → 换到 B ；B 返回 404
updateModelRateLimit 调用 = [acc-A, acc-B]   ← 两次都写
```
`acc-B` 是 404（`recordsLobsteraiRateLimit('not-found') === true`），
所以**写 B 是正确的**——但纯属巧合：`kind` 是 A 的 `soft-rate`，
仅因为 `soft-rate` 与 `not-found` 恰好都返回 true 才没出错。

**若 B 是 5xx/client**：`kind` 仍是 A 的 `soft-rate`（true）→ **会给 B 写上
「该模型限流 1 小时」的徽章**，而 B 的真实错误是服务器故障。这正是
`recordsLobsteraiRateLimit` 的注释里声称要避免的「虚假信息」，却在循环里真实发生。

**建议修法**：与 S3 同修——在循环内用**当前账号自己的**分类判定是否记徽章。

---

## 中等

### M1. SSE 的 `message` 回退缺失 `gotAnyContent` 守卫，会把内容**拼接重复**

**位置**：`src/lobsterai-adapter.ts:690-691`

```ts
const textDelta = delta?.content
  ?? (typeof choice?.message?.content === 'string' ? choice.message.content : undefined)
```

参考实现 `sse.go:98` 的条件是 `if msg, ok := c["message"]...; ok && !gotAnyContent`——
即**一旦通过 delta 收到过内容，就彻底忽略 message 字段**（`gotAnyContent` 在
`sse.go:72` 于每次写入 content 时置 true）。

我的实现没有等价的 `gotAnyContent` 标志，`??` 只在该帧**自身**没有 `delta.content`
时才回退到 `message`。

**实跑验证**：
```
流：data:{choices:[{delta:{content:"A"}}]} → data:{choices:[{message:{content:"M"}}]}
我的实现最终 text = 'AM'
Go 期望         = 'A'
```

**触发条件**：上游在流中途混发 `message` 形态的帧（`sse.go:97` 的注释表明这种
上游确实存在）。**后果**：正文内容被重复拼接，用户看到重复文本。

**建议修法**：加 `let gotAnyContent = false`，收到 `delta.content` 时置 true，
`message` 回退加 `&& !gotAnyContent`。

---

### M2. 提交信息声称「已记录的有意分歧」中，`latest_keyfrom` 一条与 HEAD 不符

`e2d9362` 的提交信息写：
> 另修正一处有意分歧，改回与 Go 一致：
> - applyLobsteraiRefresh 不再更新 latest_keyfrom（原更新为当前时刻）

但 HEAD 的 `lobsteraiKeyfromBody` 仍在用 `String(Date.now())`——这正是
「取当前时刻」的行为（只是从 `applyLobsteraiRefresh` 挪到了 body 构造处）。
即**修复被搬了个位置又改回去了**。与 S2 同源。

`docs/lobsterai-integration-plan.md` §7.4 的 D-a 行也据此声称「同样**不更新**」，
**文档与 HEAD 代码不符**。

---

### M3. `LOBSTERAI_PROFILE_SUMMARY_PATH` 重复定义且值可能漂移

**位置**：`src/lobsterai.ts:41` 与 `src/lobsterai-credits.ts:40`

两处都定义为 `'/api/user/profile-summary'`。`lobsterai.ts` 的那份是导出但
**无任何引用**（credits 用自己的那份）。将来若真实端点变更，改一处会导致
两处语义分叉且没有任何测试会失败。

**建议**：删掉 `lobsterai-credits.ts:40` 的本地定义，改为从 `lobsterai.ts` 导入。

---

### M4. `refreshAll` 的注释与实现细节：单账号失败静默吞掉，与 `BuddyAuth` 行为差异未说明

**位置**：`src/lobsterai-auth.ts:448-457`

```ts
} catch (error) {
  if (error instanceof RefreshTokenExpiredError) { ... }
  // 单账号失败不中断循环
}
```

非终态失败（网络抖动、5xx）**完全静默**——既不更新账号状态，也不记 `lastRefreshError`，
更不写日志。注释只说「不中断循环」，没说「静默」。用户在 UI 上看到账号
「可续期」却永远续不上，没有任何可诊断的线索。

**建议**：至少 `console.warn` 一行带账号 id 与原因的日志，或注入的 logger。

---

## 轻微

### L1. 死导出：`LOBSTERAI_DEFAULT_CLIENT_VERSION`

`src/lobsterai.ts:576`，全仓（src + tests + plugin-src）**零引用**。
其 docstring 声称「供测试与外部断言引用」，但测试根本没有引用它。

### L2. 死导出：`LOBSTERAI_MODELS_TIMEOUT_MS`

`src/lobsterai-adapter.ts:838`，除定义处外零引用。它就是
`LOBSTERAI_REQUEST_TIMEOUT_MS` 的别名，没有任何消费者。

### L3. `LOBSTERAI_CREDENTIAL_REF` 是纯别名

`src/lobsterai-auth.ts:53`，docstring 说「保留此导出仅为兼容既有导入方」——
但 LobsterAI 是**本次新增**的 provider，**不存在「既有导入方」**。
注释描述了一个不存在的历史。

### L4. `lobsterai-errors.ts` 文件头注释与实现范围不符

模块头写「本模块**只有纯函数**，无副作用」——属实；但同段又称
「`hard-credit` 的识别尤其重要」，而该识别（`classifyLobsteraiError`）
的 **402 分支**与关键词表都依赖调用方正确传入 body。这不是错误，但
注释没提「body 必须是原文而非解析后的 msg」这一前置条件，而
`lobsterai-auth.ts:399` 用 `JSON.stringify(parsed)` 反序列化回文本传入——
对含中文的响应，`JSON.stringify` 会保留原字符，故可行，但这条依赖链没被记录。

### L5. 关于「假保护」的核查结论：**未发现**

审查 `tests/unit/lobsterai-parity.spec.ts` 全部 24 项，逐条判断是否恒真：

- `parity.spec.ts:74` `expect(body.latestKeyfrom).not.toBe(String(Date.now()))` —
  看似冗余（`latest_keyfrom` 是 `'111'` 时该断言恒真），**但它是冗余的冗余**：
  同用例 72 行的 `expect(body.latestKeyfrom).toBe('111')` 才是承重断言。
  实跑验证：把实现改回 `String(Date.now())` 后该文件**3 项失败**，说明保护有效。
- `shouldRotateLobsteraiAccount`: 断言覆盖全部 7 个取值，真实保护。
- `recordsLobsteraiRateLimit`: 断言覆盖全部 7 个取值，真实保护。
- `isLobsteraiTerminalError`: 只断言 3 个取值（`session-dead`/`soft-rate`/`client`），
  未覆盖 `none`/`hard-credit`/`not-found`/`server`。**若实现被改成 `return true`，
  现有断言仍会通过**（`soft-rate`/`client` 期望 false 会失败，故实际能抓住）。
  经核查该子集恰好能锁死行为，**不构成假保护**。

**结论：这一类未发现问题。**

---

## 与参考实现的分歧（未被 §7.4 记录）

除已记录的 4 项（D-a~D-d）外，本次审查又发现 **2 处既不对齐、也未记录**的分歧：

| # | 分歧 | Go | 本插件 | 评价 |
|---|---|---|---|---|
| **U1** | `message` 回退的守卫 | 有 `gotAnyContent` 守卫（`sse.go:98`） | **无**（`adapter.ts:690`） | **应修**，见 M1 |
| **U2** | 换号次数的上限 | `for i := 0; i < h.cfg.MaxRotate`（默认 3，`handler.go:190`） | **无上限**，靠 `tried` 集合 + `getAvailableAccount` 返回 null 自然终止 | 行为上等价（账号数有限），但 Go 的 3 次上限是**防雪崩**的显式保护；账号很多时本插件会逐个试完全部，延迟与额度消耗都更大 |

U2 值得在 §7.4 里补一行说明，因为它涉及**延迟**这一用户可感知的差异。

---

## 建议的处置顺序

1. **S1**（凭据来源与刷新目标错配）—— 真实功能失效，优先。
2. **S3**（耗尽错误码错配）—— 会让「积分不足」这一主要失败模式不可见。
3. **S4**（徽章写错账号）—— 虚假信息，与 `recordsLobsteraiRateLimit` 的注释自相矛盾。
4. **S2 / M2**（`latest_keyfrom` 历史漂移）—— 已有 parity 覆盖，记录流程教训。
5. **M1**（`gotAnyContent`）—— 内容重复，取决于上游是否混发 message 帧。
6. **M3 / M4** —— 清理项。

---

## 关于「为什么 763 项测试全绿却没抓到这些」

这一点值得单独说明，因为它决定了修补的优先级：

| 问题 | 现有测试为何没抓到 |
|---|---|
| S1 | 所有 adapter 测试都注入 `resolveCredential: async () => credential`（**同一个固定凭据**），从不模拟「resolveCredential 从池取、refresh 动另一个 ref」这种**接线层**错配。这是集成缺陷，单元测试天然看不见。 |
| S3 | 现有用例只让**一个**账号失败（`getAvailableAccount` 返回 null），从未构造「首账号类别 ≠ 末账号类别」。`915545e` 新加的用例让两轮错误体不同（429/402），但断言的是 `message` 含「余额不足」——而 `message` 用的是 `errorText`（**确实已更新**），故通过；**它没有断言 `error.code`**，而错配恰恰只在 code/status 上。 |
| S4 | 同上，没有「换号后新账号的错误类别与旧账号不同」的用例。 |
| M1 | `lobsterai-adapter.spec.ts` 有「仅有 message」的用例，但**没有**「delta 与 message 混发」的用例。 |

**建议**：S1 需要**集成级**测试（构造两个不同 ref 的真实 `LobsteraiAuth` + pool）；
S3/S4 只需在现有 adapter 用例里把两轮错误类别做成**不同**的，
并**断言 `error.code`** 而不只是 `message`。

