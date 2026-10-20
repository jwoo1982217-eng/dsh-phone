<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠ 「通用面板」里的按钮与弹窗**必须按 provider 分支**（Issue IKJLK3）

**真实缺陷**（Gitee issue IKJLK3，用户报障，2026-10-03）：Jet Hub 的
`ProviderPanel`（`plugin-src/client/jet-hub.js`）按 `provider` prop 复用**同一个组件**，
于是「+ 新建账号」按钮存在于**全部 13 个 provider 的面板**里，而 2026-10-03 刚搬进去的
**登录渠道弹窗是 zCode 专用**的（标题硬编码「添加 ZCode 账号」+ 一个渠道 `<select>`）。
二者没有分支，后果是**三个同源缺陷**：

| 现象 | 根因 |
|---|---|
| 在 CodeArts / Qoder 等面板点「+ 新建账号」，弹出的是「添加 ZCode 账号」 | 按钮无条件 `setPendingLogin(false)` |
| 弹窗里选 bigmodel / z.ai **没有落点** | 载荷构造 `provider === 'zcode' ? {provider, zcodeProvider} : {provider}`，非 zcode 那一支不传 |
| opencode 要点**两层**弹窗 | 按钮先弹 ZCode 渠道窗，点「确定」才走到 `setKeyModal` 的 API key 表单 |

⇒ 修法是**判据收进纯函数**，不写在组件里：
`plugin-src/client/new-account.js` 的 `newAccountAsksChannel(provider)` 与
`buildCreateAccountPayload(provider, zcodeProvider)`（与 `account-model-link.js` /
`model-bulk.js` 同样做法：单测环境是 `node`、**react 不在依赖内**，
组件渲染不了，判据必须抽出来才能**真跑**覆盖）。语义定为
**「只有 zcode 先问渠道，其余 provider 点按钮即登录」**。

⚠ **三条同源教训**（下次在通用面板加 provider 专属 UI 前先过一遍）：

1. **判据方向要选失败安全的那边**：`newAccountAsksChannel` 写成**白名单**
   （`provider === 'zcode'`）而不是「排除法」。将来新增 provider 忘了改这里，
   后果是「少问一次」而非「弹错窗」—— 少一次确认是降级，弹错窗是破坏。
2. **「通用组件里的 provider 专属 UI」是接线 bug，不只是漏一个 `if`**：
   按钮 `onClick` 与弹窗渲染处**两处都要接**（渲染处那道是防御性的），
   回归用例也分两条守 —— 只锁纯函数会被「判据还在但没人调用」绕过。
3. ⚠ **既有测试会贴死写法**：`tests/unit/zcode-channel-dialog.spec.ts` 原本断言
   `onClick: () => setPendingLogin(false)` 与 `pendingLogin === undefined ? null :`，
   分支化后全部变红。⚠ 那**不是**要改实现去迁就测试 —— 要把断言改成锁**意图**
   （「zCode 面板仍必须先弹窗」「条件仍挂在 `pendingLogin` 上」），
   并在注释里写明为什么放宽，否则下一个改写法的人会照着把分支删回去。

⚠ **同类问题还有服务端那一半**（E2）：`account.create` 的 `zcodeProvider`
原先只有 `?? 'bigmodel'` 兜底、**无白名单** —— RPC 载荷是**客户端自报**的
（入口无 schema 校验），`ZcodeLoginProvider` 只是 TS 联合类型，运行时任何字符串都能进来，
未登记值会被原样送进 `startZcodeLogin` 打到不存在的授权端点（表现为「授权页打不开 /
轮询超时」这类极难定位的失败）。现由 `normalizeZcodeLoginProvider()` 归一，
**回落**（与既有缺省兜底同向，不报错，老客户端照常能登录）+ 非缺省时 `console.warn`。

⚠ **提单人对 E1 的判断有误，别照抄**：「`account.create` 未校验 provider，会一路走到链尾」
—— 链尾**本来就有**兜底 `else { return unknown provider }`，且 `id` 只在分支内使用，
未知 provider **不会**被写进账号池。不必再加一道重复校验。

⚠ **`dim-jh-zcDialog*` 类名已经不准**了：它是**通用弹窗样式**，只服务 Jet Hub 页
的登录渠道弹窗。曾想改名，但样式表一起动、收益仅是可读性，故保留名字 —— 别再据类名
判断「这段 UI 只属于 zCode」。
⚠ 它原先还有第二个使用方（官方模型卡片里的 ZCode 账号区，`zcode-card.js`），那份已随
Gitee issue IKJLHQ 整体移除（见上一节）。

⚠ 另两条同 issue 的低频项：登录重入闸门 `if (pollRef.current !== 0) return`
**不能静默 return**（弹窗确定按钮是「先关弹窗再调 createAccount」，
早退时用户只看到「点了没反应」，要复用 `probeNotice` 给提示）；
`console.log('account.create response =', res)` 会把**含 OAuth state 的 loginUrl**
打进控制台（用户截图求助时外泄），只记 `provider` 与本地 `accountId`。

回归用例 `tests/unit/new-account-dialog.spec.ts`（14 条，做过 8 个变异的反向验证）。
⚠ 写这类源码级断言时**必须先定位再匹配**：`jet-hub.js` 里有 **3 处**
`pollRef.current !== 0`（另两处在 `stopPoll` 的清理里），只按字面量找第一个
会命中无关代码；且断言要对**剥掉注释**的文本做，否则文件头为记录旧实现写下的
那行字就能喂绿（本轮修的正是「登录渠道选择」，注释里必然提到它）。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### ⚠️⚠️ 全部账号被**模型限流**时，必须报限流，不能报成「未登录」（真实缺陷，2026-10-03）

**用户报障**：`/compact` 连续四次失败，UI 只显示通用文案
「Compaction could not produce a useful summary」。解出会话日志后，`compaction/end`
携带的真实错误是：

```
buddy: no usable credential; log in from the Jet Hub panel first
```

而当时 Jet Hub 里 buddy 账号**已登录、已启用、凭据完好** —— 真实原因是它被
`deepseek-v4.1-flash` 的**模型级限流**挡住（解禁时刻就存在 `modelRateLimits` 里）。
用户被指去「重新登录」，方向完全错。

**链路**（四个环节都正确，合起来却报出假原因）：

1. 唯一的启用账号带该模型的未过期限流标记 → `pickBuddyCredential`
   （`src/index.ts`）的候选筛成**空集**；
2. `select()`（`src/buddy-balance-selector.ts`）对空候选只能回一个笼统的
   `{kind:'exhausted'}`，**未锁定时 `reason` 被丢弃**；
3. 调用方退到**单凭据 ref** `BUDDY_ACCESS_TOKEN` —— 而 Jet Hub 登录只写
   `BUDDY_ACCOUNT_XXX`，该 ref **从未存在过** → `resolveCredential` 返回 `undefined`；
4. 适配器据此抛 `MISSING_CREDENTIAL`（`src/buddy-adapter.ts`）。

⇒ 与 qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判是**同一个病根**：
**用默认归类代替了对业务语义的判断**。

**修法**：新增纯判据 `allAccountsRateLimitedForModel()`（`src/account-pool.ts`），
在「候选为空、即将退到单凭据 ref」这一刻**证明**失败原因。位置必须是
`getAvailableAccount` **之后**、`ctx.credentials.resolve` **之前**：
池里还有号时不该报限流，而退到单凭据之后就来不及了。

- ⚠️ **只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败仍然失败；
  修的是「用户看到的原因」。**绝不静默换模型**（那是替用户做决定），
  **绝不绕过限流标记**（那会让标记形同虚设）。
- ⚠️ **判据必须窄**，与选号侧严格同口径（缺标记 / `0` / `now >= resetAt` 都算不受限），
  且空 `modelId` 直接不判定 —— 选号侧约定空 modelId 不做限流过滤
  （`if (modelId.length === 0) return true`），不同口径会把「未登录」误报成「限流」。
  ⚠️ 该空串守卫**不是**冗余：`updateModelRateLimit` **不校验** modelId，
  理论上可落下 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报。
- ⚠️ **只统计启用账号**（`.filter(a => a.enabled)`）：停用账号本就不参与自动选号，
  把它们算进来会让「有一个号被停用」的普通情况被误报成「全部限流」。
- ⚠️ **错误码取 `QUOTA_EXCEEDED`**（本仓库既有惯例，且**不在**
  `DEFAULT_RETRYABLE_CODES` 里）；**不可取 `AUTH`** —— 那会把整条 message
  换成「API 密钥无效」（判据见下文「安全策略拦截」那条的取证），
  精心写的解禁时刻在 UI 上一个字都看不到。
- ⚠️ **文案必须带解禁时刻与「无需重新登录」**：只说「限流」而不给时间，
  用户仍会去重登或干等。
- ⚠️ **两处都要接**（`CODEBUDDY` / `WORKBUDDY` 各一处），否则两个 provider 行为不一致。
- 测试：`tests/unit/buddy-ratelimit-misreport.spec.ts`（19 条：行为级判据 + 源码级接线
  + 回归保护）。⚠️ 已做**反向验证**：移除两处判定调用 → 3 条变红；
  逐条破坏判据（去 `modelId` 空串守卫 → 1 条、去 `resetAt===undefined` → 2 条、
  去 `now>=resetAt` → 2 条、去 `resetAt===0` → 1 条、最早解禁改最晚 → 1 条）。
  ⚠️ 写用例时注意：断言「判定先于单凭据兜底」**不能只搜 ref 名** ——
  `BUDDY_CREDENTIAL_REF` 在文件更早处（import 与注册）也出现，会命中错位置
  （实测 `check=12308` 反而大于 `fallback=751`）；锚点要用**完整的兜底调用语句**。

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，而正处于限流期的
  账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

### ⚠️ 安全策略拦截（11140）：三条通道都要换号 / 标冷却，错误码**绝不能**取 `AUTH`

腾讯侧业务码 `11140`（`request illegal`，文案写「内容未通过安全审核」）**服务端嘴上说是
内容问题，实测是账号级拦截**：同一份请求体发往池里 7 个账号得到「2 通 / 4 拦 / 1 限流」，
连「你好」都被拦，换新会话照样拦（排除上下文累积）。因此它的正确出路是**换号**，
不是让用户改内容。该结论由 !15（认证路径）与 !16（限流路径）先后确立，本次补齐剩下两处。

- ⚠️ **错误码不能取 `AUTH`，也不能取 `QUOTA` / `ACCOUNT_QUOTA`**（通用教训，不限本 provider）。
  DSH 聊天 UI 的判据是（取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`）：
  ```js
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
  return code === "AUTH" ? t("message.failure.auth") : message;
  ```
  即 `AUTH` 会**把整条 message 换成「API 密钥无效」**（`displayFailure()` 那里甚至强制
  `message: ""`）。!15 精心写的「全部账号均被服务端安全策略拦截…」在 UI 上**一个字都看不到**，
  还把用户引向检查密钥（实测 7 个 token 全有效、2027-09 才过期）。
  ⇒ **凡是要把自定义文案送到用户眼前，码必须避开这三个**。
  现取 `PERMISSION_DENIED`：与本仓库 `cline-adapter.ts` 的地域限制分支同码（见下文惯例），
  且**不在** `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）
  里 → 确定性结论不会被 harness 白退避 5 次。
  ⚠️ 也别顺手改回 `AUTH`「与其余 401/403 口径一致」：口径一致不该以吞掉文案为代价。
- ⚠️ **被拦账号必须打冷却标记**（`markPolicyBlockedAccount`，`src/buddy-adapter.ts`）。
  !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：候选顺序是用户拖拽定的
  （见上文「账号顺序」），实测那池前 4 个被拦 → 每次请求固定先发 4 次失败。
  复用账号池的 `modelRateLimits` 载体（它是**唯一**的「账号×模型暂时不可用」映射，没有 reason 字段），
  代价是账号卡片显示「限额重置 · 模型 · 30 分钟后」而非「安全策略拦截」；
  收益是 `getAvailableAccount` 的过滤、UI 的「重测 / 重置」两条人工解禁路径**全都现成生效**。
  ⚠️ **时长是自己定的 30 分钟（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），不要复用
  `parseRateLimitError` 解析不到时那个 1 小时兜底** —— 11140 报文里根本没有时间字段，
  走那条兜底等于把「策略拦截」冒充成「服务端限流」。也别与 cline / lobsterai / trae 的
  `*_RATE_LIMIT_FALLBACK_MS` 合并成一个常量（语义不同，调一个不该动另一个）。
  ⚠️ 标记**只随时间到期失效**：`sweepExpiredRateLimits` 在生产代码里**没有任何调用方**，
  别指望它来清过期项（判据是 `account-pool.ts:578` 的 `Date.now() >= resetAt`）。
  ⚠️ **只标该模型**（同 qoder 额度那条口径）：跨模型无实测依据，标全部模型会误伤本可用的组合。
  ⚠️ 写标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 惯例一致）：本次的准确错误才是主线。
- ⚠️ **流内（HTTP 200 + SSE 帧）那条通道原先整帧被静默丢掉**：buddy 的帧类型里**没有**
  `code` / `msg` 字段，而 11140 恰好是顶层 `{code,msg,displayMsg}`、无 `error` 无 `choices`
  → 一路走到循环末尾，既没内容也没报错，UI 表现成「干净地停止、无任何失败」
  （与 qoder 的 10605、TRAE 的流内错误同型）。
  ⚠️ **判据必须带「这一帧没有 `choices`」这层门禁**：正文里出现「安全审核」
  /`request illegal`/字面 `11140` 是常态（模型在讨论审核策略就会说），只看 payload 字样
  会把一个合法回答判成拦截并连带标冷却。
  ⚠️ 判据与 HTTP 层**共用** `isContentRejection()`，别在流内另写一套 —— trae 那次缺陷的成因
  就是流内分支当年自己写了一套判据。
  ⚠️ 本通道按定下的口径是「**标记 + 如实报错**」，本轮不重发（重发需要「尚未产出内容」判据
  + 外层循环，那是 `3823133 fix(trae)` 那种结构改造，不在本次范围）；下一轮选号会自动绕开。
  故报错文案取「当前账号…」而非「已逐个换号重试」——**文案必须与是否真换过号一致**。
- ⚠️ **单账号池 + 续期失败**时，`credential expired and refresh failed` 那条早退分支
  **也必须先排 11140**：单账号池必然满足「没换到号」，修复前真实原因是拦截时报的却是
  `AUTH` + 一句与凭据有关的话（写用例时实测到）。
- ⚠️ 文案里的 HTTP 状态取**最后一次拦截**的，不是首发的：「首发 401 + 途中 403/11140」
  若沿用首发状态会报出一个对不上的「HTTP 401」，把人引向「token 过期」。
- 测试：`tests/unit/buddy-adapter.spec.ts` 的
  「安全策略拦截（11140）：账号冷却 + 流内错误帧」段（7 条）。
  ⚠️ 已做**反向验证**：错误码退回 `AUTH` → **7 条**变红；禁用冷却标记 → **5 条**变红
  （含认证 / 限流 / 流内三条通道各自那条）；禁用流内识别 → **2 条**变红。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **十个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## 供应商级一键开关（左侧 rail 分组 + 页头弹窗开关）

**需求**：「因该提供左侧供应商的一键开关，开关逻辑和账号的开关逻辑一致（但是如果不关闭
模型就不关闭供应商），应该分组显示打开和关闭的供应商」。

### 语义（用户逐项确认）

| 决策 | 取值 |
|---|---|
| 关闭某供应商 | **关闭它的全部模型** + **停用它的全部账号** |
| 「已关闭」判据 | **该供应商的全部模型都已关闭**（不新增持久化字段，由模型黑名单推导） |
| 重新打开 | 清空该供应商的模型黑名单 + **启用它的全部账号** |
| 右侧账号面板 | **保持既有逻辑不变**；仅在其后重新加载一次列表（见下） |

⚠️ **没有新增任何持久化字段**：`state.json` 仍只有 `accounts` 与 `disabledModels`。
供应商的开关状态是**推导值**（`closed = total > 0 && disabled === total`），故无迁移、
无一致性维护成本。代价是「手动单独打开某个模型」会让该供应商回到「已打开」——
这正是判据的字面含义。

### 端点：`provider.status`（读）+ `provider.setEnabled`（写）

- `provider.status` 一次返回**全部**供应商的状态。⚠️ 全程只用**同步内存副本**：
  目录取 `modelAdapters[id].listAllModels()`（同步；不触发远端拉取），账号取
  `pool.listAccountsByProvider()`（同步读内存）。
  **不得**改用 `pool.listAccounts()` —— 它逐账号调 `credentials.describe()`（异步 IO），
  8 个供应商会把设置页首屏拖慢，而我们**只需要计数**。
- ⚠️ `listAllModels()` **不带 `disabled` 字段**，必须另取 `pool.listDisabledModels(id)`
  按 id 计数。
- ⚠️ 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：保守判为「未关闭」，
  让用户可以尝试操作，而不是误报成已关闭。

### ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号

「是否已关闭」的判据是**模型是否全关**。先关模型可保证即使随后停账号失败，状态判定
依然自洽（该供应商确实已关闭），用户重试一次即可补齐账号。反过来先停账号、再关模型，
中途失败会留下「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
却没有任何可用账号。`tests/unit/jet-hub-rpc.spec.ts` 有专项用例锁死写入顺序。

### ⚠️「不关闭模型就不关闭供应商」

关闭方向必须拿到模型目录；**读失败**或**目录为空**时**整个操作失败、不落盘、不广播**。
绝不能「关不掉模型就只停账号」—— 那会让供应商显示成已关闭而模型其实还在，
用户按「已关闭」的预期却仍能选到它。前端把这种情形表现为**开关禁用**并给出原因
（`providerSwitchState` 的 `reason`），而不是让用户点下去只得到一句错误提示。

### ⚠️ 开关**不在**左侧行尾（2026-10-01 用户要求搬到页头弹窗）

!25 最初的形态是把开关挂在左侧每个供应商行的右侧。用户随后要求改：
「提供商开关是直接显示在 provider 右侧的，把它单独抽出来到 Jet Hub 上面的一个按钮里，
点开始列表和开关，可以选择关闭，**和模型列表中那套打开/关闭按钮的显示逻辑一样**」。

现在的形态：页头 `dim-jh-headerActions` 里的**「供应商开关」按钮** → 点开
`ProviderSwitchPanel` 弹窗（一个供应商一行、行尾一个开关）。

**为什么这个改法是对的**：关闭一个供应商是**破坏性批量操作**（一次改动几十个模型 +
全部账号），把它挂在承担导航的窄栏行尾，等于让误点代价最高的控件离高频无害动作
（选要看哪个供应商）最近。搬进弹窗后必须"点进去 → 看清影响面 → 再决定"。

⚠️ **搬走的是控件，不是判据**：`providerSwitchState`（三形态）与
`groupProviders`（分组）原样复用，新增的 `providerSwitchRows` /
`providerToggleSummary`（`plugin-src/client/provider-toggle.js`）只是把
「定义 × 状态表」拼成行数据与计数 —— **判定仍然只在纯逻辑层一处**。
弹窗与左侧 rail 读的是同一份 `provider.status`，故不可能出现
「左侧说它关了、弹窗里它还是开的」。

⚠️ **弹窗行的约束换了一套**：行容器是 `<label>` 且**内部只能有 1 个 checkbox**
（与 `ModelToggle` 同因：插入第二个 checkbox 会让「点行内文字」激活第一个可标记控件）。
原先那条「开关必须是 `<button role="tab">` 的兄弟节点」随开关一起失效 ——
现在左侧行里**只有一个 button**，`provider-toggle.spec.ts` 改为断言这一点
（行内不得出现 `React.createElement('input'`）。

⚠️ **rail 宽度 243px 是当时的遗留**：那张实测表里 243px 是为了**容纳行尾开关**
（无开关时 200px 就够）。开关搬走后左侧已有约 40px 富余，收窄回 200px 属独立的
视觉决策，本次**没做**（样式断言 `.dim-jh-rail { width: 243px; }` 仍在，
改宽度时要一起改）。

### 弹窗与模型列表弹窗共用同一套结构与类名（用户明确要求）

`ProviderSwitchPanel` 复用 `dim-jh-modalOverlay--top` / `dim-jh-modalHead`
（标题 + 计数 + 刷新 + 完成）/ `dim-jh-modalHint` / `dim-jh-modalBody` /
`dim-jh-modelList` / `dim-jh-modelRow` / `dim-jh-modelInfo` / `dim-jh-modelName` /
`dim-jh-modelId` / `dim-jh-switch`，并沿用 ESC 与点遮罩关闭、
**关闭即不挂载**（避免常驻一份开关列表）。**没有为它新写一条样式规则**。

两个容易做错的细节：

- `data-disabled` 在模型列表里的语义是「**这一项已被关闭**」（整行淡出），
  这里保持一致：`row.checked ? 'false' : 'true'`。「这行点不动」由 `input` 的
  `disabled` 表达，**两件事不能混成一个属性**。
- **busy 只锁被点的那一行**，不锁整表（与 `ModelListPanel` 的 `busyIds` 同取向）。
- ⚠️ 状态没读回来时**不显示计数**：`providerToggleSummary` 的 `known: false`
  让界面显示「正在读取状态…」/「状态读取失败」，而不是「已打开 0、已关闭 0」——
  后者会被读成「一个供应商都没有」。为此 `JetHubPage` 新增了 `providerStatusFailed`，
  用来区分「还没回来」与「回来是失败」（`providerStatuses === null` 一个值担不起两义）。

### ⚠️ `.dim-jh-providerLabel` 曾是「已定义但从未被应用」的死样式

真实代码渲染的是 `<span><strong>{label}</strong></span>`（span **没有** className），
于是长供应商名一直在**折行**（用户最初的截图里「WorkBuddy (国际 / 版)」就是两行）。
该类（含 `min-width: 0` 与 `strong` 的 `nowrap + ellipsis`）在样式表里早已存在却无人使用。

本次**启用**它，把折行改为单行省略号。这是左侧的一处**可见变化**，故用实测数据定了
rail 宽度：实测（无头 Edge + 真实源码 STYLES，rail 高 446px、纵向滚动条出现时）

| 方案 | rail 宽 | 标签可用 | 结果 | 列表总高 |
|---|---|---|---|---|
| 现状（无开关、真实标记） | 200px | 119px | 4 行折成 2 行，无截断 | 384px |
| 行尾开关 + 省略号类 | 200px | 77px | **6/8 行超宽**（最多 -64px） | 384px |
| 行尾开关 + 省略号类 | 236px | 113px | 3/8 行超宽 | 384px |
| **行尾开关 + 省略号类** | **243px** | **120px** | **3/8 行超宽（-3 / -4 / -21px）** | 384px |
| 行尾开关，**不启用**省略号类 | 243px | 120px | 4 行折成 2 行 | **424px**（行高 48→58px） |

故取 243px：与现状几乎逐像素持平，且列表总高不变。

⚠️ **测量方法上的两个坑（都踩过）**：
- **inline 元素的 `clientWidth` 恒为 0**，用 `scrollWidth - clientWidth` 判截断会得到
  「没有截断」的**假阴性**。要用 `Range.getBoundingClientRect().width` 取文本真实宽度，
  与父容器 `clientWidth` 比较。
- **不能靠行高判断折行**：2 行 × 20px = 40px 仍小于 `.dim-jh-provider` 的 `min-height: 48px`，
  行高恒为 48px，折行被完全掩盖。要用 `Range.getClientRects().length`。
- **纵向滚动条会再吃掉约 15px** 标签宽度（Windows 经典滚动条），是否出现取决于 rail 高度
  （即用户窗口高度）。测量必须同时报告「纵向滚动条 = 有/无」，否则同一宽度两次测得不同
  标签宽度会被误读成测量错误。

### 状态读取失败时退化为不分组（不阻断主功能）

`provider.status` 失败时把状态置为 `null`，rail **按 `PROVIDERS` 原顺序平铺、不分组**，
并在页头提示一句。⚠️ 此时**弹窗里的**所有开关都被 `providerSwitchState(undefined)`
判为**禁用**（`reason: '状态尚未读取'`）—— 状态未知时让用户点一个状态不明的开关比
禁用更糟。**绝不**因为左侧这个装饰性功能而让整个设置页白屏。
⚠️ 但「`null` 一个值」担不起「加载中」与「读取失败」两义 —— 弹窗计数需要分开显示，
故另有 `providerStatusFailed`（见上一节末条）。

### 右侧账号面板：只重新加载，不改逻辑

供应商开关会改掉账号的 `enabled`，故提交成功后递增 `version` 让 `ProviderPanel` 重挂载
并重新拉一次账号列表（用户已确认接受这一处刷新）。**除此外右侧一律不动**：不新增字段、
不改按钮、不改积分行、不改拖拽排序、不改账号级 `toggleAccount` 联动。

### 回归用例

- `tests/unit/provider-toggle.spec.ts` —— 纯逻辑（分组 / 三形态 / 结果文案 /
  **弹窗行数据 `providerSwitchRows`** / **计数 `providerToggleSummary`**）+ 源码级守卫
  （⚠️ **左侧行内不得出现 `input`**、页头按钮点开弹窗且关闭即不挂载、
  弹窗行是 `<label>` + **恰好一个** checkbox、弹窗与模型列表共用同一套类名、
  `data-disabled` 只表达「已关闭」、状态没读回来不显示计数、分组标题带计数、样式约束）。
  ⚠️ 源码级断言**不能跨行**：本仓库源文件是 CRLF，`'a\nb'` 形式的字面量匹配不上。
- `tests/unit/jet-hub-rpc.spec.ts` —— `provider.status` 的 `closed` 判据（含「只关一部分」
  与「空目录」两条边界）、`provider.setEnabled` 的写入顺序 / 不落盘 / 广播 / 参数校验。
- `tests/unit/account-pool.spec.ts` —— `setAccountsEnabled` 的 provider 隔离、幂等不落盘、
  不破坏黑名单、写前 `ensureLoaded`、跨实例读回。
- ⚠️ **反向验证 5 组**（证明用例非同义反复）：`closed` 改判据 → 1 条失败；空目录仍落盘 →
  1 条失败；写入顺序颠倒 → **4 条失败**；去掉「无模型即禁用」→ 3 条失败；去掉分组计数 →
  1 条失败。
- ⚠️ **测试替身必须补齐 `credentialRef`**：`sanitizeAccounts` 会把缺该字段的账号**整条丢弃**，
  于是「停用全部账号」返回 0、用例假失败（本次踩过）。
- ⚠️ **追加测试段时要确认落在哪个 `describe` 作用域**：本次一度把新段落追加进
  `TRAE 签到设备轮换代次` 的 describe 内，引用了该作用域不存在的工厂，8 条用例全部
  ReferenceError。新增段落应显式写明它所属的顶层 describe。

### 安装闸门（用户要求：确保不影响客户端启动才安装）

`verify-client-boot.mjs`（工作区根目录）是安装前的**强制闸门**，任一失败即拒绝安装：

1. **语法层**：`node --check` 每个产物 js。
2. **加载层（冒烟）**：无头 Edge 注入 `window.__ModuleLoader__`，捕获
   `load({id, factory})` → 断言 id；以 stub react 执行 `factory` → 断言导出
   `apply` / `inject`；再调 `apply(fakeCtx)` → 断言注册了 `settings.section` 且未抛错。
   这一步直接验证「插件能加载并注册设置页」，是 tsc 与单测都覆盖不到的一层。
3. **产物层**：新能力在、旧能力未被破坏、源码与部署产物哈希一致。

### 十、captcha 改为「要了才取」：先探后取 + 2 分钟需求记忆（2026-10-01）

**上游并非每次都要验证头**：外部仓库 `bonus-plan-4-open-zcode`（提交 `52b6389`）
的抓包显示官方壳在 `access.mode = normal` 时全程零验证、只有 `off-peak` 才强制；
本仓库 2026-10-01 深夜窗口的实测同向 —— **不带验证头 8/8 全 HTTP 200，连非法
param 也 200，`3007` 命中 0 次**（10 发真实请求；探针
`scripts/probe-zcode-captcha-need.mjs` 与设计稿
`docs/superpowers/specs/2026-10-01-zcode-captcha-lazy-mint-design.md` 都是
**本地文件、不入库**，需按本节思路自行重写）。
⇒ 推理路径改为：默认**不带**验证头发一次，被 `3007` 拒才 mint 并重发，
并按「账号 × 模型」记 2 分钟（真实 key 格式见 `src/captcha-requirement.ts` 的
`captchaRequirementKey`，形如 `` `${accountId}|${model}` ``；策略与 TTL 同文件）。

⚠️ **三条不可回退的口径**：
1. `3007` 必须在**适配器内部**补产重发，不能走到 `throw` —— 它映射 `RATE_LIMIT`
   且在 harness 可重试集合里，抛出去会让用户先看到一次我们**预期到**的失败；
2. 不带也成功 ⇒ **必须清记忆**（否则在不需要验证的窗口里持续白产，白扣设备信誉）；
3. 记忆只在**进程内**，不落 `jet-hub-store`（`state.json` 是同机多 profile 共享的
   home 级文档，落盘会互相传染验证结论）。

⚠️ **注释与文档的口径是双向的**（本仓库评审反复打回的就是这类）：
- **不许**把「缺 captcha 必回 `3007`」写成无条件事实（上面那次实测一次都没发生）；
- 也**不许**反过来写成「上游永不校验」，据此删掉 `3007 → 补产重发` 分支或改成
  复用 param —— 历史上确实强制索要过，而**本次只采了深夜一个窗口、跨时段未复测**。
  ⚠ 别据此造一条「读 `access.mode`」的逻辑：那是**那个壳**的 provider 配置开关，
  我们的直连路径上没有它（依据是**本机取证、不在仓库**：本机那个壳的
  `provider_config.json` 里只有 `{type:"api-key"}`）。

⚠️ **收益不是常数，别写成「省 1.2 秒」**：省下的是「不需要验证的那些请求」的一次
mint + 一份设备级验证配额与信誉；上游要验证时那一发照付。mint 的真实量纲：
**稳态（复用常驻页面）0.4–0.5 秒**（同一组 5/5 样本：中位 426ms / 平均 546ms，
两个统计量仓库里都有记载）、
**首次 mint 含 chromium 冷启动实测 4.2 秒**（Task 1 那发的 4200ms 就是这个，
不是稳态；⚠ 别与 `zcode-captcha.ts` 记的**浏览器进程**冷启动约 690ms 混为一谈 ——
后者只是起进程，不含建页与阿里云 SDK 首次加载）。

⚠️ **别把本节与本章 7.2 互相引用为依据**：7.2（「官方确实每请求一个 captcha」）
是从**官方闭源版** `app.asar` 逆向出的**那个客户端的生产行为**（每个 model request
都重新产 param）；本节说的是**上游服务端的校验行为**（深夜窗口不校验）+ 外部
**开源壳**的抓包。两者是两个层面 —— 我们新逻辑跟随的是**后者**（服务端要不要），
`mintCaptcha` 何时被调由探测结果决定，与 7.2 那条官方实现细节无关。

⚠️ **TTL 与记忆键的依据是**外部仓库**那次提交 `52b6389`，不是本仓库实测** —— 那次采样一次都没命中
「要验证」，所以 2 分钟 TTL 在本仓库**没有被证明过**。写注释时别记成「我们实测」，
否则将来按它调参的人找不到依据就会随手改。

⚠️ 与预取池是**对立**的：预取会让我们在不需要的窗口里也耗配额（同设备 150/小时），
故 `DSH_ZCODE_CAPTCHA_POOL` 默认关闭保持不变，别「为了削峰」把它打开。

⚠️ **`claim`/签到路径的 mint 语义不变**：`src/zcode-auth.ts` 里每个 plan 必单独
mint（那是确定要带的），不走先探后取。

⚠️ 载体（壳内 WebContentsView / CDP / 浏览器档）本期**一个都没做**：取证结论是
DSH 桌面版里「只改配置就能拿到内部载体」不成立 —— 插件宿主是**以
`ELECTRON_RUN_AS_NODE=1` 单独 spawn 的子进程**（`require('electron')` 拿不到
`app`/`WebContentsView`）、全 bundle **零** `remote-debugging` 开关、自建 webview
被主进程的 `will-attach-webview` 租约治理 `preventDefault()` 拒绝、而
`cordis.patch.yml` 只是**配置包补丁**不是代码注入通道。
⚠ 这四条的取证对象是 DSH 桌面版的 `app.asar`（**外部产物、不在本仓库**），
记录在上面的本地设计稿 C 段 —— 要复用结论请先重取一遍，别当常量。

回归：`tests/unit/captcha-requirement.spec.ts`（8）+
`tests/unit/zcode-captcha-lazy.spec.ts`（17 = 判据 3 + 行为 8 + 观测 5 + 探测 1）。
⚠️ 已做反向验证（均实跑）：把内层门控 `knownRequired || probeRejected` 改回
**无条件 mint** ⇒ 行为段 5 条变红；去掉 `clearCaptchaRequirement()` 那一行 ⇒
**只有**「不带也能成功 ⇒ 清记忆」变红；把 `httpErrorCodeForZcode` 的 `3007`
改归 `SERVER` ⇒ **只有**「补产后仍 3007 仍抛 `RATE_LIMIT`」那条变红
（它锁住的是「探测侧归**仍受限**、不标坏账号」，见 `isRateLimitFailure()`）。


## ⚠️⚠️ 用量徽标折叠态：渠道名与读数**必须是两个元素**（真实报障，2026-10-03）

**报障**：胶囊显示成 `LobsterAI (有道) · 合计 …` —— **数字被截掉**，而渠道名完整。

**根因不在宽度，在结构**：原先整句是**一个** `overflow: hidden; text-overflow: ellipsis`
的 span，省略号从右往左吃，被吃掉的恰好是用户唯一想看的东西（还剩多少）。
⇒ 把 `badgeView()` 的返回拆成 `name` / `detail` / `reading` **三个字段**
（`plugin-src/client/badge-model.js`），渲染层再给**不同的收缩权重**
（`usage-badge.js` 的三段式 `collapsed` + `jet-hub-styles.js` 的三条规则）：

| 段 | 类 | flex-shrink | 让位顺序 |
|---|---|---|---|
| 渠道名 | `.dim-jh-badgeName` | 99 | 第二 |
| 包名（仅套餐模式） | `.dim-jh-badgeDetail` | 999 | 第一 |
| 读数 | `.dim-jh-badgeReading` | **`flex: none`** | **不让位** |
| `•` | `.dim-jh-badgeSep` | `flex: none` + `margin: 0 3px` | 不参与 |

### ⚠️ 读数必须 `flex: none` —— 这是第二个、更隐蔽的成因

给读数留 `flex-shrink: 1`（哪怕幅度极小）时，加权分配仍会分给它**不到 1px** 的收缩
（实测 78.23 宽 / 内容 79），而 `text-overflow: ellipsis` 的触发条件是
`scrollWidth > clientWidth` —— **亚像素级收缩就足以命中**，最后一个字被换成「…」，
视觉上和整段被截一样严重。故读数的 `flex` 是 `none`，**不是** `0 1 auto`。

### ⚠️⚠️ 这条缺陷**用 `clientWidth` 量不出来**（我因此假绿了一整轮）

`clientWidth` 与 `scrollWidth` **都取整**：
- `clientWidth` 把 53.97 报成 54 ⇒ `scrollWidth > clientWidth` 判为 **false**（漏判）；
- `scrollWidth` **向上**取整，内容 39.79 报成 40 ⇒ `rect < scrollWidth` 恒成立（误判）。

我第一次写的断言用 `scrollWidth > clientWidth` 判「数字是否完整」，**全部通过**，
而**截图里明写着 `347.87积…`**。⇒ **判定省略号只能靠截图**，或量一个
**同字体的自然宽度参照元素**再与元素实际宽度比（`tests` 里没做渲染测试，
故这一条只能靠改样式时人工截图复核 —— 见下）。

### 测量数据（Edge headless，宿主 UI 字体栈，dsf 1 与 1.5 都量过）

| 用例 | 自然宽度 | 186px 下 |
|---|---|---|
| `WorkBuddy (国际版) • 200积分` | 179.3px | 完整 |
| `LobsterAI (有道) • 842.06积分` | 172.3px | 完整 |
| `WorkBuddy (国际版) • 347.87积分` | 193.6px | 名字省略，**数字完整** |
| `CodeBuddy (腾讯) • Free Plan Subscription 300 / 500积分` | 309px | 包名+名字省略，**数字完整** |

⚠️ 宽度上限取 **186px**（原 150px）：对最宽的那个报障样例留 6.7px 余量。
⚠️ `<button>` **本来就是 `border-box`**（UA 默认样式表），故这次是**实打实多占 36px**，
不要按「只是写明 box-sizing」理解；多占的空间由 `.dim-jh-badge` 的 `flex: 0 1 auto`
（**不是 `none`**）兜底 —— 窄窗口下胶囊自己先让位，而不是把模型选择器挤出去
（后者正是 2026-10-02 那次报障的形态）。

### ⚠️ 两个静态陷阱（都有用例守着）

1. **类名不能复用 `.dim-jh-badgeValue`** —— 那个名字已被**浮层**里的读数占用，
   规则带 `font-weight: 600` 且排在样式表**更后面**（同特异性 ⇒ 后者胜），
   沿用同名会让胶囊里的数字被静默**加粗**。故胶囊用 `.dim-jh-badgeReading`。
2. **窄屏「只留状态点」的媒体查询必须排在 `.dim-jh-badgeText { display: flex }` 之后** ——
   两者特异性相同，胜负由**源顺序**决定；排到前面会让 `display: none` 被
   `display: flex` 覆盖，窄屏下文字重新出现并挤压模型选择器（宽窗口下完全看不出）。

### ⚠️ 分隔符的间距只能用 CSS，不能用字符串里的空格

`BADGE_SEP = ' • '`（带空格）**只用于 `title` / `aria-label` 那句整文**。
渲染层里 `•` 是独立 span，间距靠 `margin` —— 因为 **flex 容器把 span 之间只含空白的
文本节点渲染成零宽**（实测 gap=0：节点还在、看不见），空格会静默消失。

### ⚠️ `jet-hub-styles.js` 的注释**不能出现反引号**（本次又踩一次）

该文件的 `STYLES` 是模板字符串。我在标出「报障原文」时写了反引号，
`node --check` 直接报 `Unexpected identifier`。已有一条用例扫徽标那一段的注释块。
⚠️ 注意 `\``（转义）**也会**在产物里留下真反引号 —— 该用例照样会红。用「」代替。

⚠️ 这条只对**模板字符串所在的文件**成立：`badge-model.js` / `usage-badge.js` 是普通
JS，里面的 JSDoc 写反引号没问题 —— 但**从它们复制片段进 `jet-hub-styles.js` 就会炸**。
动手前先确认目标文件是不是模板字符串。
## ⚠️⚠️ 用量徽标折叠态：**余额优先**（口径反转，2026-10-03 用户要求）

**报障**：CodeBuddy 胶囊显示「个人体验版 500 / 500积分」，而设置页里写着
**可用积分 2434.96**。用户原话：「图3里显示我能用的积分足足 2436.96 呢」。

### 口径（现在的默认）

| 偏好 | 折叠态显示 |
|---|---|
| **auto**（默认） | **余额** → 窗口 → 套餐（三级回落） |
| subscription | 窗口 → 套餐 → 余额 |
| credits | **只**余额（不回落） |

⚠️ **两个数都是真的，但回答的不是同一个问题**：套餐读数是「某一份包还剩多少」，
服务端还会下发「体验版」这类样板包 —— 它只是余额里的一份；余额才是「一共还能用
多少」。旧口径（窗口 > 套餐 > 余额）在这种渠道上**必然少报**，且看起来像数据错误。
⚠️ **窗口/套餐读数没删**：仍在浮层里，`subscription` 档可切回去。别以为是回归。

### 实现要点

- 模式选择从「嵌套三元 + 一个 `wantsSubscription` 布尔」改成**有序候选表 +
  `find`**：旧写法让一个布尔同时承担「是否看订阅」与「是否允许回落」两义，
  加一档就要重排整棵嵌套，极易写漏组合。
- ⚠️ **每个候选必须判「有内容」而不是「存在」**：账号 `ok:true` 但 `windows: []`
  或包全失效时订阅对象是在的、内容是空的 —— 直接选中会显示成 `Cline · `
  （只有渠道名、没有数字，比显示余额更没用）。
- 展示名跟着改：`credits` 从「优先积分」改成「**只看积分**」。⚠️ 语义反转后
  `auto` 与 `credits` **都显示余额**，差别只在「是否回落」—— 沿用「优先积分」
  会让两档读起来是同义词。差别写在容器 title 里。

## ⚠️ 徽标宽度：**内容自适应 + 216px 上限**（两次报障的两个不同成因）

**同一条链路、两次报障，别把第二次当成第一次没修好**：

| 报障 | 表象 | 根因 |
|---|---|---|
| 第一次 | 数字被截（`…合计 …`） | **结构**：整句一个 `overflow:hidden` 的 span，省略号从右往左吃掉余额 |
| 第二次 | 名字被截（`CodeArts (华为…`） | **尺寸**：结构修好后 186px 仍不够长名字 + 长余额，省略号落到名字上 |

**216px 是量出来的**：13 个渠道展示名 × 10 种现实读数（含 123456.78积分 /
9499.84积分 / 94.54MToken / 0积分）共 130 组，最宽需求 **209.34px**
（`WorkBuddy (国际版) • 123456.78积分`），留 6.7px 余量。

⚠️⚠️ **上限不能再往上放，「无上限」是错的**：实测把 `max-width` 去掉后，
极窄 composer（220px）下胶囊**溢出容器 8.3px** —— 那正是 2026-10-02
「模型选择器图标被挤没」的形态。**内容自适应与上限兜底缺一不可**：
宽度由内容撑开（`Cline • 5积分` 只有 93px），上限只防挤压右侧。

⚠️ 写用例时**别把 `.dim-jh-badgeBtn` 的 `max-width` 当成「胶囊实际宽度」**：
我第一版测量脚本忘了解掉类自带的上限，量到的永远是 186（被截断后的值），
于是「所需宽度」全部失真。测量时必须 `style.maxWidth = 'none'`。


## ⚠️ 多账号的胶囊：**分组键必须先归一单位**（2026-10-03 真实缺陷）

用户报障（WorkBuddy 国际版**两个**账号）：
`WorkBuddy (国际版) • 341.78积分 · 100积分` —— 读成「把所有号的积分都列出来了」，
并担心「以后五六个号会显示很长一串」。

**根因既不是账号数，也不是宽度，而是分组键**：服务端把**同一个单位**拼成两种
写法。逐包实测（`probe-workbuddy-units.mjs`，只打印单位/包名/数值）：

| 账号 | 包 | `unit` 原值 |
|---|---|---|
| `…01CC739A` | Bonus Pack 241.78 / Free Plan Subscription 100 | `credit` / `credits` |
| `…297957E1` | Free Plan Subscription 100 | `credits` |

折叠态按**原始字符串**分组（`credit` ≠ `credits`）⇒ 两个账号落进两个分组 ⇒
渲染出两个**一模一样**的「积分」标签（用户看到的就是这个）。名字同时被
216px 上限截成 `WorkBuddy (…`。

**红线：分组键必须与展示名同源。** 凡是 `unitLabel` 会显示成「积分」的单位串，
就必须落进**同一分组**；否则文案里必然出现 `A积分 · B积分` 这种把同一单位拆成
两段的形态。故分组前一律走归一：

- 客户端 `plugin-src/client/credits-format.js` 的 `normalizeUnit()`
- 宿主 `src/credits.ts` 的 `normalizeCreditUnit()`
- 两者都只返回 `'token'` / `'credit'`，**必须逐字等价**（宿主算套餐读数、客户端
  算余额分组；不一致会让同一枚徽标里「套餐按一个单位、余额按另一个」自相矛盾）。
  契约由 `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
- 消费点三处：`creditGroupsOf`、`planGroupsOf`（客户端）、`badge-subscription.ts`
  的 `unitOf` / `badgePlanFor`（宿主）。

⚠️ **`token` 与积分不合并**：ZCode 是 token、其余是积分，不可折算，仍分两组
（`100积分 · 94.54MToken`）。归一化只收敛**同义拼法**，不跨量纲求和。

⚠️ **不要改写 `CreditPackage.unit`**：那里要保留服务端原值（设置页逐包明细依赖
它）。归一化只发生在「当分组键 / 当展示名」那一步。

修复后同一份真实数据：`WorkBuddy (国际版) • 441.78积分`，宽度 **193.56px**
（上限 216px 都没碰到）⇒ 名字也不再被截。六个号（单位拼法混着给）同样只有一个
数字：`2066.84积分`。

⚠️ **教训的普遍性**：这是本仓库第三次栽在「用外部下发的**字符串**当键」上
（另两次：qoder 的 `110` 用错误码默认归类、`10605` 排队被漏判）。外部字段的
**拼法不可假设**，当键用之前先归一到自己的语义等价类。

## ⚠️ 徽标的两条「账号多了」规则（2026-10-03 用户要求）

胶囊对**任意账号数**都只显示一个数字（前提是单位先归一，见上一节）。另两处随账号数
放大的地方已按用户要求整理：

| 位置 | 规则 | 理由 |
|---|---|---|
| 弹窗逐账号列表 | **按余额降序** | 账号是「用完一个换一个」的资源，先要看到「还有哪个号能用」；原顺序是池的插入顺序 |
| 同上 | 读不到数的**排最后** | 那格显示的是错误文案，夹在数字中间会被误读成「余额很小」。⚠️ 不能用 0 代替（0 会插进小余额里） |
| 同上 | 超过 **5 个**折叠 | 6 个号 = 12 行（每号两行），弹窗比窗口还高 |
| 胶囊 | 合计不完整时挂 **⚠ 角标** | 账号读不到时合计会**静默少报**，数字本身看不出异常（色调仍是 ok） |

⚠️ **排序与折叠是纯函数 `orderCreditRows`（`badge-model.js`）**，不是写在组件里：
`usage-badge.js` 依赖宿主注入的 react（本仓库装不了），**组件里的逻辑测不到** ——
凡是「错了用户也只会觉得别扭、不会报错」的规则，都必须住进能单测的模块。

⚠️ **角标的四条硬约束**（每条都有对应用例）：
1. 与读数同级 `flex: none` —— 它是补语，被省略号吃掉等于没标；
2. 排在读数**之后** —— 不干扰「先看数字」的阅读顺序；
3. **不进 `view.text`** —— 那是供 title / 读屏的纯读数，说明单独走 `incompleteNote`；
4. 标记自身 `aria-hidden`，同一句话并进按钮 `aria-label`（否则读屏念两遍）。

⚠️ **只在积分模式标**：只有它是跨账号的**合计**。窗口模式按设计只显示某一个账号的
窗口、套餐模式显示「最大的那份套餐」——它们不是合计，套这句话就是错的。
（判据 `mode === 'credits' && okCount > 0 && failedCount > 0`；`okCount > 0` 是必要的，
一个都没读到时模式已回落到 `empty`，读数本身就是「用量不可用」。）

⚠️ 弹窗脚注**复用同一句话**（`view.incompleteNote`），不另写一份措辞 ——
否则会出现「胶囊说 A、弹窗说 B」。

⚠️ 实测数值（无头浏览器，比较 `getBoundingClientRect` 的渲染宽度与自然宽度 ——
不能用 clientWidth / scrollWidth，两者会四舍五入）：带角标后 193.56px → **202.19px**，
名字与读数都不出省略号，仍在 216px 上限内。

## ⚠️⚠️ 一键签到的汇总**必须按单位分列**，不得跨单位求和（2026-10-04 真实报障）

用户报障原文：
> 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
> 正文「…ZCode（智谱）+100000000（共 +100000100）」
> 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」

**根因不在文案，而在数据模型**：`computeClaimSummary` 的 `totalCredit` 是
**跨单位求和的标量** —— ZCode 的 1 亿 token 与其余渠道的 100 积分加在一起得
`100000100`。单位信息**在汇总这一层就丢了**，下游无论怎么写文案都只能标一个
「积分」。故修法是**让单位一路传到渲染层**，而不是在文案里猜。

| 层 | 改动 |
|---|---|
| 宿主汇总 | `RpcCreditsClaimSummary.totalByUnit: Record<'token'\|'credit', number>`（**两键恒存在**） |
| 宿主累加 | `computeClaimSummary` 用 `claimUnitOf(outcome.unit)` 分桶；`RunTotals` 同步加 `totalByUnit` |
| 格式化 | 宿主 `src/credits.ts` 的 `formatClaimGains`；客户端 `credits-format.js` 的同名函数 |
| 消费点 | `auto-checkin.ts` 的 `describeChannel`/`describeRun`；`jet-hub.js` 的 `checkinAll`；`usage-badge.js` 的 `onClaimAll`/`summarizeClaim` |

**四条红线**：

1. **`totalCredit` 保留原语义（跨单位求和），但展示路径一律不得用它** ——
   它只对**单一单位**的渠道（其余 11 个）正确。改它才是破坏性改动，故新增字段而非替换。
2. **宿主与客户端的两份格式化必须逐字等价**。客户端 bundle 不能 import 宿主代码
   （esbuild 的客户端产物没有 Node 依赖），只能各写一份 —— 契约由
   `tests/unit/claim-unit-parity.spec.ts` 逐项比对锁死。不锁的话，**同一轮签到**
   在 Jet Hub 设置页（宿主产出并落盘的文字）与用量徽标（客户端现场拼）会显示成两种写法。
3. **每个单位各带一个 `+`**，不是整段共用一个。用户给出的期望文案就是
   `+100Mtoken, +100积分`；整段共用会渲染成 `+100Mtoken, 100积分`，第二个单位
   看起来像「不是本次领到的」。故 `+` 放在 `formatClaimGains` **内部**，
   而不是留给调用方拼（一旦各拼各的，两处界面必然漂移）。
4. **顺序固定 `token` → `credit`**，不依赖对象键序（用户期望文案就是 token 在前）。

⚠️ **积分不压缩、token 才压缩**：积分余额的现实量级是 `123456.78`（IDE 顶部就是这个
精度），压成 `123.46K` 会让用户无法与官方界面核对；而 token 动辄上亿，不压缩读不出量级。
`formatCreditAmount` / `formatTokenAmount` 与客户端的 `formatCredits` / `formatTokens` 同口径。

⚠️ **数值与单位之间不留空格**（`100.00MToken` / `800积分`）：这是本仓库既有的展示惯例
（用量徽标里 ZCode 余额就渲染成 `94.54MToken`），也与用户给出的期望文案同形。

⚠️ **旧响应兼容**：`totalByUnit` 缺失时回落到 `{ credit: totalCredit }`（行为与改动前
一致，只是多了单位名）。判据与 `coversToday` 的兜底同思路 —— 缺字段 ≠ 0。
⚠️ **但兜底只做一次，且做在「逐渠道累加」那一跳**：`jet-hub.js` / `usage-badge.js`
首版在 `let totalCredit = 0` 上留了一个标量，汇总行写
`totalByUnit.token > 0 || totalByUnit.credit > 0 ? totalByUnit : { credit: totalCredit }`
—— 而那个 `totalCredit` **再无任何累加**（全文只有声明行，恒为 0）⇒ 该三元分支
**永远走不到**，旧宿主的兜底实际发生在 `s.totalByUnit || { credit: s.totalCredit }`。
现已删掉该变量与那个分支（一个恒为 0 的变量配一句「保留只为兜底旧宿主」的注释，
比删掉它危险得多）。**新增同类兜底时先自问：这个分支有哪条真实路径能走到？**

### ⚠️⚠️ 承上：**`+` 在函数内部 ⇒ 调用点绝不能再拼**（2026-10-05 复审 PR !56 补记）

**真实缺陷**（本 PR 首版自身引入，用户可见）：`formatClaimGains` 的返回值**自带**
每个单位的 `+`（`+100.00MToken, +100积分`，这是它名字里 `Gains` 的含义，也是上面
红线 3 的结果），而客户端的 **4 个调用点**「顺手」又拼了一次 ⇒ 渲染出**双加号**：

```
jet-hub.js     bits.push(`+${amount}`)          →  "++100.00MToken"
jet-hub.js     `（共 +${totalAmount}）`          →  "（共 ++100.00MToken, +100积分）"
usage-badge.js bits.push(`+${amount}`)          →  "++800积分"
usage-badge.js `（共 +${totalAmount}）`          →  "（共 ++100.00MToken, +100积分）"
```

⚠️ **宿主侧 `auto-checkin.ts` 那两处反而是对的**（`（${amounts}）` / `个 ${amounts}`）
—— 恰好**只有两个客户端界面**是坏的，而它们正是用户报障盯着的界面。
⇒ 同一件事在 6 个调用点里出现两种写法，是「手写拼装」的必然结果。

⚠️⚠️ **比缺陷本身更值得记的是：全量 5448 条用例全绿也没抓到它。** 三个原因叠加：

1. 新增的 `claim-unit-parity.spec.ts` 把 `formatClaimGains` **这个纯函数**锁得很死，
   却**只 import 纯函数、从不看调用点** —— 纯函数层面的用例**结构上不可能**发现
   「函数被用错」（它测的是输出，bug 在使用上）；
2. 宿主侧有 `auto-checkin.spec.ts` 逐字断言，客户端侧**没有对等用例**；
3. 既有的源码级守卫 `zcode-claim-amount.spec.ts` 那条 `not.toMatch`
   （`/个账号领取成功（\+\$\{summary\.totalCredit\}/`）是**恒真**的 ——
   `jet-hub.js` 里从来没有过这个形态（真实代码当时是
   `` （共 +${totalCredit} 积分） ``，**没有**「个账号领取成功」这个前缀）。
   ⇒ 它修复前后**都命中 0 次**，等于空转，而它正是「防跨单位求和回归」的那道闸。

✅ **修法与新增的不变量**（`tests/unit/claim-unit-callsites.spec.ts`，16 条）：

- **正常锚点 + 反向断言成对写**：每条 `not.toMatch` 都必须配一条 `toMatch`，
  否则「锚点形态根本不存在」⇒ 反向断言**恒真**（上面第 3 条就是这么空转了几个月）。
- **断言必须剥注释**：本仓库源码注释里大量**逐字引用**曾经的错误写法，不剥注释
  则反向断言会被注释自己命中（写这个文件时首版实测红了 4 条，全因注释）。
- **断言一律单行**：CRLF + 跨行锚点会命中 0 次被静默跳过（见下文那条 CRLF 教训）。
- 覆盖 6 个调用点（4 客户端 + 2 宿主）+ 2 处**空格口径**，并含**元测试**
  （把错误形态喂给同一个正则，必须命中）证明断言非恒真。
- 反向验证 `scripts/mutate-claim-unit-callsites.mjs`：**9/9 全部杀死、0 跳过**
  （含 2 条空格变异），且断言每条锚点**命中次数恰为 1**。

⚠️ **顺手修掉的两处空格口径不一致**（同一轮签到不能像两种单位）：`jet-hub.js`
逐账号明细与 `usage-badge.js` 余额行原写作 `+100.00M Token`（**带空格**），
而汇总行是 `+100.00MToken` —— 两行并列显示成两种单位。本仓库口径是**不留空格**
（`badge-model.js` 的 `94.54MToken`、用户期望文案 `+100Mtoken` 同形）。

⚠️ **教训的普遍性**：**「同一个格式化函数有多个手写调用点」本身就是缺陷温床**。
函数内部已经保证的东西（`+`、单位名、空格），调用点每多一处就多一次重犯机会。
⇒ 要么让调用点**只贴函数返回值**（不在外面包任何修饰），要么再加一层
「拼好一整句」的函数；**不要**让 N 个调用点各自拼一半。

### ⚠️⚠️ 承上之二：**「展示路径写死『积分』」共有三处**（2026-10-05 同批复审）

同一批审计里又找出**第三处**同型缺陷 —— 它在**用量徽标浮层的「积分区」节标题**：

```js
// 修复前（usage-badge.js）
quotaGroup === undefined ? '积分' : unitLabel(quotaGroup.unit)
//                        ^^^^^^ 兜底分支假定「非配额渠道都是积分」
```

**ZCode 的额度单位是 token**（`src/jet-hub-rpc.ts` 的 zcode 分支如实标
`unit: 'token'`），于是浮层渲染成**自相矛盾的一屏**：

```
积分                                  ← 节标题（写死）
  ZCode 旅行者6665   94.54MToken       ← 同一屏的数值（按单位走）
```

⚠️ **它此前没被发现，是因为只在「该渠道只发 token」时才显形** ——
12 个渠道里只有 ZCode 是这种形状。这与「某次实测没看到 ≠ 不存在」是同一类陷阱。

⚠️ **判据必须与分组口径同源**：修法是抽成纯函数 `creditSectionLabel(groups)`
（`plugin-src/client/badge-model.js`），有配额组用其标签（`'额度'`）、
否则用**第一个**单位的标签。⚠️ 取「第一个」是安全的，因为 `creditGroupsOf`
末尾按 `unit` 排序 ⇒ 结果确定、不依赖对象键序。

⚠️⚠️ **第三处还带出一个更重要的方法论教训：纯函数级用例测不出「组件不调用它」。**
`badge-model.spec.ts` 为 `creditSectionLabel` 加了 6 条用例，但它们**全部只 import
纯函数** —— 若有人把组件改回内联三元，那 6 条**依然全绿**（实测确认）。
故调用点契约文件里**额外**加了两条源码级断言：① 组件**必须**调用
`creditSectionLabel(`；② **不得**再出现 `=== undefined ? '积分' : unitLabel(` 形态。

⇒ **反向验证 11/11 全部杀死**（`scripts/mutate-claim-unit-callsites.mjs`），
其中两条**成对**存在、缺一不可：

| 变异 | 由谁杀死 | 说明 |
|---|---|---|
| `creditSectionLabel` 内部写死「积分」 | `badge-model.spec.ts`（1 红） | 纯函数自身有问题 |
| 组件回退到内联三元（不调用纯函数） | `claim-unit-callsites.spec.ts`（2 红） | **纯函数全绿**，只有调用点断言能抓 |

⚠️ **写变异脚本时还要注意「验证范围」**：该脚本首版只跑
`claim-unit-callsites.spec.ts`，于是第一条变异被判**幸存** —— 而它其实是被
`badge-model.spec.ts` 杀死的。**「范围没覆盖到」与「用例没抓住」在输出里长得一样**，
与本文件反复出现的那条 CRLF 教训同源。现在 `SPEC` 同时覆盖两个文件。

⚠️ **顺带**：验证脚本 `verify-claim-unit-callsites.mjs` 也踩了**同一个注释坑** ——
它检查错误形态时命中了自己注释里逐字引用的旧写法，对**已修好的产物**报假阳性
（9 通过 / 1 失败，那 1 项命中的全是注释）。**凡是对源码做形态断言的脚本，
都要剥注释再匹配。**

### ⚠️⚠️ 承上之三：空格口径要**穷举断言**，逐点断言挡不住新调用点

**真实教训（2026-10-05，复审收尾时的覆盖度自查）**：前两轮修复里，
空格口径只逐点钉住了**当时发现的那两处**（逐账号明细行、徽标余额行）。
收尾时用宽搜复查（列出全部含 `formatUnits(` 的可执行行），又抓到**第三处漏网**：

```js
// plugin-src/client/usage-badge.js 的**订阅套餐行**（修复前）
`${formatUnits(group.remaining, group.unit) ?? '?'} / ${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`
//                                                                                                     ↑ 多一个空格
```

它渲染的正是 `100.00M / 200.00MToken`，而**同一个弹窗**的积分区是**无空格**的
⇒ 两处并列像两种单位。

⇒ **修法升级**：把「数值与单位之间不留空格」改成**穷举断言**
（遍历三个客户端文件，凡「`formatUnits(...)` 的数值后跟空白再紧跟单位标签变量」
即判红），并配正向锚点防恒真。

⚠️ **判据必须只认单位标签变量名**（`unitLabel(...)` / `group.label` / `best.label`），
**不要**泛化成「所有 `${}` 前不得有空格」—— 那会误伤 `jet-hub.js` 的
**模型分组标题** `` `${expanded ? '▾' : '▸'} ${group.label}` ``（那里的
`group.label` 是「GLM 系列」这类**分组名**，本就该有空格）。

⚠️ **教训的普遍性**：**逐点断言的覆盖是「已知位置」，而缺陷可能出现在任何新调用点**。
凡是「N 个位置都该遵守同一条口径」的事，判据就应当是**穷举**的
（扫全部调用点 / 断言集合为空），而不是逐个列举。

⚠️⚠️ **还有一条元教训：自查脚本/断言自己也会写歪**。本次覆盖度脚本首版有**两处自伤**，
都导致「对**已修好**的代码报未覆盖」的**假阴性**：
① 用 `includes('…大量反斜杠…')` 判断旧锚点是否移除，**转义写歪** ⇒ 反复误报；
② 空格穷举只匹配两种后缀形态，漏掉标签是别的变量名的写法。
⇒ **凡断言，先确认它「在该红时真红」** —— 这与 `not.toMatch` 恒真、
变异脚本「跳过 vs 杀死」是同一类错误，本仓库已栽过三次。


**反向验证**（`mutate-claim-unit.mjs`，8 条变异**全部杀死**）：汇总不分桶 3 红、
格式化不按单位选压缩 6 红、单位标签恒为「积分」6 红、只列一个单位 6 红、
`describeRun` 回到裸标量 5 红、`describeChannel` 回到裸数字 5 红、
客户端少一个 `+` 3 红、客户端标签恒「积分」2 红。

⚠️ **写变异脚本时必须处理 CRLF**：本仓库源码是 CRLF（实测 `src/credits.ts`
CRLF=725 / LoneLF=0），而脚本里的锚点是用 `\n` 写的。不做归一化的话**多行锚点会
命中 0 次而被静默跳过** —— 第一版就这么漏掉了 3 条最关键的变异（全是多行的）。
故脚本统一把锚点转成目标文件实际的行尾，并**断言命中次数恰为 1**。
⚠️ 这**不是一次性教训**：2026-10-05 复审时新写的
`scripts/mutate-claim-unit-callsites.mjs` 依然按这条做（归一化 + 断言命中恰为 1），
结果是 `9/9 杀死、0 跳过`。**「跳过」与「杀死」在输出里长得像** —— 不打印
跳过数、不断言命中次数，就会把「锚点没匹配上」当成「验证通过」。

⚠️ **教训的普遍性**：这是本仓库第二次栽在「**跨量纲求和**」上（第一次是胶囊把
`credit`/`credits` 拆成两组，见上一节）。凡是把**带单位的量**累加成**裸数字**，
单位就一定会在那一层丢掉；正确做法是让单位**跟着数字一起走**（分桶 / 分组），
把「怎么显示」推迟到最后一层。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### ⚠️⚠️ 全部账号被**模型限流**时，必须报限流，不能报成「未登录」（真实缺陷，2026-10-03）

**用户报障**：`/compact` 连续四次失败，UI 只显示通用文案
「Compaction could not produce a useful summary」。解出会话日志后，`compaction/end`
携带的真实错误是：

```
buddy: no usable credential; log in from the Jet Hub panel first
```

而当时 Jet Hub 里 buddy 账号**已登录、已启用、凭据完好** —— 真实原因是它被
`deepseek-v4.1-flash` 的**模型级限流**挡住（解禁时刻就存在 `modelRateLimits` 里）。
用户被指去「重新登录」，方向完全错。

**链路**（四个环节都正确，合起来却报出假原因）：

1. 唯一的启用账号带该模型的未过期限流标记 → `pickBuddyCredential`
   （`src/index.ts`）的候选筛成**空集**；
2. `select()`（`src/buddy-balance-selector.ts`）对空候选只能回一个笼统的
   `{kind:'exhausted'}`，**未锁定时 `reason` 被丢弃**；
3. 调用方退到**单凭据 ref** `BUDDY_ACCESS_TOKEN` —— 而 Jet Hub 登录只写
   `BUDDY_ACCOUNT_XXX`，该 ref **从未存在过** → `resolveCredential` 返回 `undefined`；
4. 适配器据此抛 `MISSING_CREDENTIAL`（`src/buddy-adapter.ts`）。

⇒ 与 qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判是**同一个病根**：
**用默认归类代替了对业务语义的判断**。

**修法**：新增纯判据 `allAccountsRateLimitedForModel()`（`src/account-pool.ts`），
在「候选为空、即将退到单凭据 ref」这一刻**证明**失败原因。位置必须是
`getAvailableAccount` **之后**、`ctx.credentials.resolve` **之前**：
池里还有号时不该报限流，而退到单凭据之后就来不及了。

- ⚠️ **只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败仍然失败；
  修的是「用户看到的原因」。**绝不静默换模型**（那是替用户做决定），
  **绝不绕过限流标记**（那会让标记形同虚设）。
- ⚠️ **判据必须窄**，与选号侧严格同口径（缺标记 / `0` / `now >= resetAt` 都算不受限），
  且空 `modelId` 直接不判定 —— 选号侧约定空 modelId 不做限流过滤
  （`if (modelId.length === 0) return true`），不同口径会把「未登录」误报成「限流」。
  ⚠️ 该空串守卫**不是**冗余：`updateModelRateLimit` **不校验** modelId，
  理论上可落下 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报。
- ⚠️ **只统计启用账号**（`.filter(a => a.enabled)`）：停用账号本就不参与自动选号，
  把它们算进来会让「有一个号被停用」的普通情况被误报成「全部限流」。
- ⚠️ **错误码取 `QUOTA_EXCEEDED`**（本仓库既有惯例，且**不在**
  `DEFAULT_RETRYABLE_CODES` 里）；**不可取 `AUTH`** —— 那会把整条 message
  换成「API 密钥无效」（判据见下文「安全策略拦截」那条的取证），
  精心写的解禁时刻在 UI 上一个字都看不到。
- ⚠️ **文案必须带解禁时刻与「无需重新登录」**：只说「限流」而不给时间，
  用户仍会去重登或干等。
- ⚠️ **两处都要接**（`CODEBUDDY` / `WORKBUDDY` 各一处），否则两个 provider 行为不一致。
- 测试：`tests/unit/buddy-ratelimit-misreport.spec.ts`（19 条：行为级判据 + 源码级接线
  + 回归保护）。⚠️ 已做**反向验证**：移除两处判定调用 → 3 条变红；
  逐条破坏判据（去 `modelId` 空串守卫 → 1 条、去 `resetAt===undefined` → 2 条、
  去 `now>=resetAt` → 2 条、去 `resetAt===0` → 1 条、最早解禁改最晚 → 1 条）。
  ⚠️ 写用例时注意：断言「判定先于单凭据兜底」**不能只搜 ref 名** ——
  `BUDDY_CREDENTIAL_REF` 在文件更早处（import 与注册）也出现，会命中错位置
  （实测 `check=12308` 反而大于 `fallback=751`）；锚点要用**完整的兜底调用语句**。

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，而正处于限流期的
  账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

### ⚠️ 安全策略拦截（11140）：三条通道都要换号 / 标冷却，错误码**绝不能**取 `AUTH`

腾讯侧业务码 `11140`（`request illegal`，文案写「内容未通过安全审核」）**服务端嘴上说是
内容问题，实测是账号级拦截**：同一份请求体发往池里 7 个账号得到「2 通 / 4 拦 / 1 限流」，
连「你好」都被拦，换新会话照样拦（排除上下文累积）。因此它的正确出路是**换号**，
不是让用户改内容。该结论由 !15（认证路径）与 !16（限流路径）先后确立，本次补齐剩下两处。

- ⚠️ **错误码不能取 `AUTH`，也不能取 `QUOTA` / `ACCOUNT_QUOTA`**（通用教训，不限本 provider）。
  DSH 聊天 UI 的判据是（取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`）：
  ```js
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
  return code === "AUTH" ? t("message.failure.auth") : message;
  ```
  即 `AUTH` 会**把整条 message 换成「API 密钥无效」**（`displayFailure()` 那里甚至强制
  `message: ""`）。!15 精心写的「全部账号均被服务端安全策略拦截…」在 UI 上**一个字都看不到**，
  还把用户引向检查密钥（实测 7 个 token 全有效、2027-09 才过期）。
  ⇒ **凡是要把自定义文案送到用户眼前，码必须避开这三个**。
  现取 `PERMISSION_DENIED`：与本仓库 `cline-adapter.ts` 的地域限制分支同码（见下文惯例），
  且**不在** `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）
  里 → 确定性结论不会被 harness 白退避 5 次。
  ⚠️ 也别顺手改回 `AUTH`「与其余 401/403 口径一致」：口径一致不该以吞掉文案为代价。
- ⚠️ **被拦账号必须打冷却标记**（`markPolicyBlockedAccount`，`src/buddy-adapter.ts`）。
  !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：候选顺序是用户拖拽定的
  （见上文「账号顺序」），实测那池前 4 个被拦 → 每次请求固定先发 4 次失败。
  复用账号池的 `modelRateLimits` 载体（它是**唯一**的「账号×模型暂时不可用」映射，没有 reason 字段），
  代价是账号卡片显示「限额重置 · 模型 · 30 分钟后」而非「安全策略拦截」；
  收益是 `getAvailableAccount` 的过滤、UI 的「重测 / 重置」两条人工解禁路径**全都现成生效**。
  ⚠️ **时长是自己定的 30 分钟（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），不要复用
  `parseRateLimitError` 解析不到时那个 1 小时兜底** —— 11140 报文里根本没有时间字段，
  走那条兜底等于把「策略拦截」冒充成「服务端限流」。也别与 cline / lobsterai / trae 的
  `*_RATE_LIMIT_FALLBACK_MS` 合并成一个常量（语义不同，调一个不该动另一个）。
  ⚠️ 标记**只随时间到期失效**：`sweepExpiredRateLimits` 在生产代码里**没有任何调用方**，
  别指望它来清过期项（判据是 `account-pool.ts:578` 的 `Date.now() >= resetAt`）。
  ⚠️ **只标该模型**（同 qoder 额度那条口径）：跨模型无实测依据，标全部模型会误伤本可用的组合。
  ⚠️ 写标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 惯例一致）：本次的准确错误才是主线。
- ⚠️ **流内（HTTP 200 + SSE 帧）那条通道原先整帧被静默丢掉**：buddy 的帧类型里**没有**
  `code` / `msg` 字段，而 11140 恰好是顶层 `{code,msg,displayMsg}`、无 `error` 无 `choices`
  → 一路走到循环末尾，既没内容也没报错，UI 表现成「干净地停止、无任何失败」
  （与 qoder 的 10605、TRAE 的流内错误同型）。
  ⚠️ **判据必须带「这一帧没有 `choices`」这层门禁**：正文里出现「安全审核」
  /`request illegal`/字面 `11140` 是常态（模型在讨论审核策略就会说），只看 payload 字样
  会把一个合法回答判成拦截并连带标冷却。
  ⚠️ 判据与 HTTP 层**共用** `isContentRejection()`，别在流内另写一套 —— trae 那次缺陷的成因
  就是流内分支当年自己写了一套判据。
  ⚠️ 本通道按定下的口径是「**标记 + 如实报错**」，本轮不重发（重发需要「尚未产出内容」判据
  + 外层循环，那是 `3823133 fix(trae)` 那种结构改造，不在本次范围）；下一轮选号会自动绕开。
  故报错文案取「当前账号…」而非「已逐个换号重试」——**文案必须与是否真换过号一致**。
- ⚠️ **单账号池 + 续期失败**时，`credential expired and refresh failed` 那条早退分支
  **也必须先排 11140**：单账号池必然满足「没换到号」，修复前真实原因是拦截时报的却是
  `AUTH` + 一句与凭据有关的话（写用例时实测到）。
- ⚠️ 文案里的 HTTP 状态取**最后一次拦截**的，不是首发的：「首发 401 + 途中 403/11140」
  若沿用首发状态会报出一个对不上的「HTTP 401」，把人引向「token 过期」。
- 测试：`tests/unit/buddy-adapter.spec.ts` 的
  「安全策略拦截（11140）：账号冷却 + 流内错误帧」段（7 条）。
  ⚠️ 已做**反向验证**：错误码退回 `AUTH` → **7 条**变红；禁用冷却标记 → **5 条**变红
  （含认证 / 限流 / 流内三条通道各自那条）；禁用流内识别 → **2 条**变红。

### ⚠️⚠️ 模型饱和（`14003`）**不是**账号额度限流：不许换号、不许标记（真实报障，2026-10-05）

**用户报障**：第一次用 `buddy/space-bunny`（`reasoningEffort=max` / `maxTokens=128000`）就收到

```
本轮运行失败 buddy: 模型 space-bunny 所有账号均受限，请稍后再试
QUOTA_EXCEEDED
```

**而 4 个账号凭据全部有效、服务端对 `space-bunny` 实测完全可用**（4 个账号 × 小请求全 200；
长生成 417 秒 / 972 帧正常 `stop`；maxTokens/effort/system 65KB/41 个 tools 各种形状全 200）。

#### 根因：`14003` **也是 HTTP 429**，而 `isRateLimited` 对 429 **无条件**为 true

于是它落进了限流分支 → 给**每个**账号写一条 **1 小时**标记（报文里没有「将在…重置」，
故取 `RATE_LIMIT_FALLBACK_MS` 兜底）→ 整池被锁 → 用户看到「所有账号均受限」。

服务端原话（`scripts/probe-buddy-error-catalog.mjs`，4 MB 输入逼出）：

```json
{"code":14003,"msg":"too many requests",
 "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
```

⚠️ **报文自己就说明了这不是账号问题**：`actions` 里只有 `SWITCH_MODEL`，**没有**换号选项。

#### 四条实测证据（互相印证，缺一都不能定案）

| 观测 | 结果 |
|---|---|
| 账号池 4 条 | 是 **4 个不同腾讯 uid**（`612f07cc…` / `2f7d1c08…` / `c974deb7…` / `d694eca7…`） |
| 4 条标记的写入时刻 | 20 秒内**全部**被写 `space-bunny` |
| 4 条标记的解禁时刻 | 全 = 「写入 + **整 1 小时**」= 兜底值，**非**服务端给的时刻 |
| 小请求 30 发 | 全 200，但耗时 **841ms ~ 216s** ⇒ 上游是**时变**背压 |

⇒ 「4 个互不相干的账号同时中招」在**账号级**限流下无法解释，**只能**是**模型级**。

⚠️ **`space-bunny` 还有一个特殊性**（其余 buddy 模型都没有）：目录元数据是
`"onlyReasoning": true` + `defaultEffort: "max"` + `maxOutputTokens: 128000`
—— 它把额度**全部花在思考上**，是唯一会被压满的路径（长生成实测思考 70353 字才出正文）。
排查时别只盯「账号额度」。

#### 修复口径：与 zcode `3009` 同型（**留在本账号退避重试**）

| | 额度限流 `6004` | **模型饱和 `14003`** |
|---|---|---|
| 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
| 换号 | **有效**（各账号额度独立） | **无益**（所有账号撞同一堵墙） |
| 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会锁整池 1 小时） |
| 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |

- 判据：`src/llm-adapter.ts` 的 `isModelSaturationError(status, body)`
  （业务码 `14003` **或**窄文案 `模型繁忙|请求量饱和|model busy|currently saturated`）；
- 接线：`src/buddy-adapter.ts` 的 `stream()` 里，**必须插在 `isRateLimited` 分支之前**
  —— 顺序就是修复本体（`14003` 满足 `isRateLimited`，晚一步就整池被锁）；
- 动作：`BUDDY_SATURATION_MAX_RETRIES`（2 次）线性退避，**始终用同一个 `credential`**；
- 用尽仍饱和 → 抛 **`RATE_LIMIT`**（可重试），文案指向「换模型」，
  ⚠️ **不许**说成「账号额度受限」（那会让用户白等 1 小时、且期间连别的模型都受影响）。

⚠️ **判据必须窄**：泛词「繁忙」**不算** —— 模型正文里正常讨论「服务器繁忙时应当重试」
就会被误判。故 `status < 400` 时一律不认文案。
⚠️ 退避间隔取**短**（2s → 4s）：该错误**自身**就要跑 46~111 秒才返回，
再叠长退避会让 UI 长期停在「运行中」而无法区分「排队」与「卡死」（与 Qoder 排队 ≥10s 封顶同因）。
⚠️ 环境变量**不许**写 `parseInt(…) || 默认值`：`0` 是合法值（单测靠它把用例压到毫秒级），
会被 `||` 静默换成 2 秒 —— 与 `QODER_QUEUE_MAX_DELAY_MS` 那次同型。

回归用例：
- `tests/unit/buddy-model-saturation.spec.ts`（8 条：真实报文 / 6004 不误判 /
  **14003 同时满足 isRateLimited**（缺陷成因）/ 两种码值编码 / 裸文案 /
  正常正文不误伤 / 不误伤 11140 / 常量一致）；
- `tests/unit/buddy-adapter.spec.ts` 的「模型饱和（14003）不换号、不标记」段
  （3 条**行为级**：两处副作用必须为 0 + 恢复即产出 + 6004 既有换号行为不许回退）。

⚠️ **已做反向验证**：把饱和判定强制为 `false`（= 修复前行为）→ **2 条行为用例变红**，
且失败输出里**确凿地打印出** `{"accountId":"acct-1","modelId":"space-bunny"}` ——
即修复前真的会写那条标记，**不是同义反复**。

⚠️ 本缺陷与 Cline 那条（下面「429 有**三种**语义」）、qoder `10605`/`110`、
zcode `3009`/`1005` 是**同一个病根**：**用状态码的默认归类代替了对业务语义的判断**。
接新的 429/限流分支时，先把「这个码的正确动作是什么」问清楚再写。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **十个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。
