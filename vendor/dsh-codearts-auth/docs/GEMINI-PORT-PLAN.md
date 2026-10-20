# Gemini 线轻量移植进 dsh-codearts-auth 插件 —— 实施计划与审计记录

> 状态:**七步全部执行完毕**(2026-10-02 夜审定计划,2026-10-03 落盘,2026-10-03 夜执行)
>
> 执行结果:7 个 `src/gemini*.ts` + 8 个 `tests/unit/gemini-*.spec.ts` 全部落盘;
> 接线六处(index.ts)/ 三处(jet-hub-rpc.ts)/ 分派表(account-probe.ts)/ 三处客户端面板全部补齐。
> `tsc --noEmit` exit 0;9 个相关 spec 合计 **172 例全绿**;`tsc` + `copy-assets` + `build.mjs`
> 三步构建 exit 0,`lib/` 下 7 个 gemini 模块 21 个产物文件齐备。
> 全量 `vitest run` 仅 `tests/unit/opencode-proxy-live.spec.ts` 2 例红(自建代理 harness 与
> undici 8.11.2 的环境性不兼容,**移植前基线同红**,与本次改动无关)。
> §九 的真机验证(thinking 显示 + 签名回填)仍留给用户。
>
> **2026-10-03 追补(用户「不要 lite 模型」)**:真机探针实测 `gemini-3.8-flash-lite`
> 在两端点上**恒 404**(`{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`,
> 与是否传档位无关)⇒ 该模型名不在本账号准入表内。已**整体移除** lite:
> 删 `GEMINI_UPSTREAM_FLASH_LITE` 常量、静态表缩为 1 条(`gemini-3.8-flash`)、
> `geminiModelSpec` 去掉 lite 分支(模型名**恒**带档位后缀),相关 spec 同步改写。
> 现暴露 **1 个模型 + 4 档 efforts**。
>
> **2026-10-03 追补(用户「为什么显示的是积分不是额度」)**:§3.3 承诺过
> 「面板会显示『5 小时窗口 99% / 周窗口 99%』而非『N 积分』」,但实现层违背了它 ——
> `credits-format.js` 的 `unitLabel` / `formatUnits` 是二值函数(只认 `token` 与
> 「其余」),`%` 落进兜底分支 ⇒ 面板把配额读成「**积分 94.50**」。而 94.5 本身
> 还是宿主 `toGeminiCreditBalance` 把两个窗口剩余比例取的平均值,**上游根本没有这个数**。
> 修复(客户端四处,host 侧一行未动):
> `credits-format.js` 新增 `QUOTA_UNIT = '%'`、`formatQuota`、`formatQuotaLine`、
> `formatQuotaDetail`,`unitLabel` 对 `%` 返回**「额度」**;`jet-hub.js` 的
> `CreditBalanceRow` 主行/hover 明细改走逐窗口百分比;`badge-model.js` 的
> `creditGroupsOf` 对配额单位**不求和**、改收 `quotaLines`,折叠态文案与色调改用
> **最紧张的窗口**;`usage-badge.js` 的 `balanceLine` 同样逐窗口、`splitLine` 改显示
> 各窗口重置倒计时。其它 provider 的文案与色调逐字不变(回归用例锁定)。
>
> **2026-10-03 追补(用户「不要渲染 / 2/2 个资源包有效」)**:配额单位下再补一道门控 ——
> `jet-hub.js` 的 `CreditBalanceRow` 把「N/M 个资源包有效」那句从三重门控改为四重
> (新增 `quotaText === null &&`)。理由:Gemini 的两个「包」是 **5 小时窗口 / 周窗口**,
> 不是资源包;窗口读数已由 `quotaText` 逐条列出,再补一句「2/2 个资源包有效」既无信息量
> 又误导。非配额单位恒 `quotaText === null` ⇒ 行为**逐字不变**。
>
> **2026-10-03 追补(用户「重测按钮你确认过会发请求吗，为什么响应这么快？可以移除吗」)**:
> 响应快是因为**当时该账号没有 `modelRateLimits` 标记**,`retestAccount` 在
> `modelIds.length === 0` 处提前返回,一次请求都没发。但这不代表按钮无害:Gemini 的限流是
> **服务端配额窗口制**(5 小时 + 周窗口),不是「等一会儿就好」的临时冷却 —— 本地标记清掉、
> 重测通过,配额一点没恢复。故在 `RATE_LIMIT_CAPABILITIES` 里给 `gemini` 登记
> `rateLimit: false`,与 Loomy 同处但**理由不同**(Loomy 是根本不返回限流错误)。
> 登记判据随之重写:「**该渠道的限流不由这组按钮的语义管辖**」,落地问法 =
> 「这个按钮点下去,能不能让用户**少**受限一次?」答否即 `false`。
> 客户端调用点一行未动(`supportsRateLimit(provider)` 仍是唯一门控),故
> `loomy-client.spec.ts` 的源码字符串断言全部照旧通过。
> 源项目:`F:\project\cmdc-pak-align-wb`(Go,本仓库,gemini 线原型)
> 目标项目:**当前工作区** `F:\project\dsh-codearts-plugin`(TypeScript,DSH 插件 `dsh-codearts-auth`)

---

## 〇、修订记录(2026-10-03 对齐当前插件形式)

初版计划有三处与当前插件最新约定脱节,照初版执行会复现已记过的缺陷。本次修订:

1. **目标项目改为当前工作区**。初版写 `F:\project\deepseek-harness-codearts_1`,实际就是
   `F:\project\dsh-codearts-plugin`。这四个文档是放在当前工作区 `docs/` 下当背景材料的。
2. **分工方式改为 inline**。初版第五节写 `[子代理 hy4-preview]` 派发。AGENTS.md「工作方式」明确:
   子任务优先用 inline 执行,不要新开 subagent(用户 2026-09-29 拍板)。理由是同工作区 subagent
   做反向验证时互相踩坏未提交状态、且已有两次空转到超时。已把四步 `[子代理]` 改成 `[主模型 inline]`。
3. **`refreshAll` 范式改为照 codearts(`src/service.ts:406`),不照 minimax**。初版写「照 minimax 惯例」,
   但 minimax-auth.ts:281 是旧范式(`if (!entry.refreshable) continue`),正是 AGENTS.md
   「账号池的 `refreshable` 只是凭据材料的镜像」一节**已被推翻**的写法。codearts 才是最新范式:
   读凭据本体判材料、不按池值跳过、判终态前重读、走 `refreshAccountWithReconcile` 共享实现。
4. **字母序信封序列化补实现方式**。初版只列「逐层字母序序列化,353 字节金标准」,但 Go 的
   `encoding/json` 对 map 键自动字母序排,TypeScript 的 `JSON.stringify` 按 V8 插入序不保证字母序。
   直接 `JSON.stringify` 大概率对不上 353 字节。已补实现路径。
5. **`resolveModel` 补 `contextWindow` 与 efforts 的 `name`**。初版完全没给 `contextWindow`,
   且 efforts 只给 value 没给展示名。已补。
6. **图片接 `projectRequestImage` + `image-budget`**。初版只列 `makeReadImage`,但缩放走
   `makeReadImageRequest` + `projectRequestImage`。已补。
7. **错误归类拆细**。初版写「429/5xx→LlmError」,会把 quota 当 SERVER 白重试。已拆成三类。
8. **Auth Service 方法列表对齐统一接口**。初版列了 10 个方法,但 AGENTS.md 统一接口只列四个。
   已对齐。
9. **配额查询(§3.3)从「可砍项」提为第一期范围**。用户要求面板「刷新积分」按钮可见。
   新增 `gemini-credits.ts`(约 100 行),移植自 cmdc-pak `quota.go`,调 `retrieveUserQuotaSummary`
   拿 5h/weekly 两桶,映射到 `CreditBalance`。`credits-capabilities.js` 改成 `balance:true`。
9. **开放问题从 5 条缩到 1 条**。原项目 `model.go` 查过后,tiered 档（独立模型名）、
   efforts name（中文）、listModels（静态表）、contextWindow（1M 估值）都能定掉,
   不再开放。只剩 `claude-*` 别名这 1 条插件侧特有的问题待用户拍板。
10. **身份头与 sessionId 的「常量 vs 随机」边界写实**（2026-10-03 用户补口径）。§2.2 第 1 条原只列
    头名没写值,第 4 条只写了推理档 sessionId。已补:五个身份头的逐字值、冒烟 sessionId
    `"-6686302828062879362"`,并强调这些与 `project` 一样全是**预置常量**,只有 `requestId`
    每请求随机——不要"为了更像真实客户端"生成随机值,固定常量才是原项目实测能跑的值
    (依据:`F:\project\cmdc-pak\internal\upstream\gemini\client.go:39-54` 常量区 +
    `pojie/analyze/mitm_2026-10-01/capture*.jsonl` 跨会话恒定 + wb 副本 client.go:229 证据链注释)。
    ⚠️ **2026-10-05 更正**:这条对 `sessionId` 与 `project` 的判断已被真机对照实验推翻 ——
    两者**都不是常量**(sessionId 内容派生、project 探测自 LCA)。**五个身份头仍然不变**,
    那条结论对头成立、对信封字段不成立。详见 README 与 §2.2 第 4 条。

---

## 一、已确认的决策(用户拍板)

1. **通道:只做 OAuth**(Cloud Code 免费线,`daily-cloudcode-pa.googleapis.com`)。
   API key / AI Studio(`generativelanguage.googleapis.com`)通道**不做**。
2. **thoughtSignature:要保签名质量** —— 本地缓存 + 下一轮回填 + 被拒时去签重试,
   对齐 cmdc-pak 完整行为,而不是"只透传文本"的简化版。
3. **体量控制**:新增产品代码约 1300 行,严格走插件
   `docs/adding-a-new-provider.md`「路径 B(全新脉系)」惯例,骨架参照 **minimax**(最轻先例,422 行适配器)。

## 二、两侧摸底结论(审计)

### 2.1 cmdc-pak gemini 线的可移植面

- **必需移植**:
  - OAuth 全流程(`oauth.go` 883 行,移植后约 200 行):授权 `accounts.google.com/o/oauth2/v2/auth`,
    token 端点 `oauth2.googleapis.com/token`,userinfo `www.googleapis.com/oauth2/v2/userinfo`;
    内置 Cloud Code installed-app 公开 client_id/secret(``,
    env `CMDC_PAK_GOOGLE_CLIENT_ID/SECRET` 可覆盖);**无 PKCE**,授权 URL 参数
    `access_type=offline&prompt=consent&include_granted_scopes=true`(缺 consent 拿不到 refresh_token);
    scope 六项:`openid cloud-platform userinfo.email userinfo.profile cclog experimentsandconfigs`;
    凭据字段 `access_token/refresh_token/token_type/expires_in/expiry/sub/email/cloudaicompanionProject`,
    `Valid()` 留 60 秒余量,Ensure 语义 = 用前刷新;
    **refresh_token 轮换后必须立即回写**。
  - 推理协议(`client.go` 816 行 → 收敛进 adapter/纯函数层):
    端点 `POST https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent`
    与 `POST .../v1internal:streamGenerateContent?alt=sse`;
    403/404/400(quota/permission/project)时与 sandbox 端点
    `https://daily-cloudcode-pa.sandbox.googleapis.com` 轮换。
  - Anthropic/DSH⇄Gemini 翻译(`translate.go` 477 行 + `stream.go` 243 行 → 纯函数层)。
  - 模型档位(`model.go`):上游名 `gemini-3.8-flash` + 后缀 `-low/-medium/-high/-tiered`
    (+独立 `gemini-3.8-flash-lite`);thinkingBudget low=1000/medium=4000/high=10000/**tiered=-1 不传预算**;
    四档 `includeThoughts` 全 true;`GenerationConfig` 默认只带 `maxOutputTokens=64000 + thinkingConfig`。
    ⚠️ 原版 `model.go:161` 写 65536,用户 2026-10-03 定为 **64000**。
  - schema 白名单清洗 `SanitizeGeminiSchema`(多余关键字整请求 400;enum 含非字符串整删;
    `type:["string","null"]` 收敛为单 type+`nullable:true`)。
  - 签名缓存(`sigstore.go` 160 行)与 `IsSignatureError` → 去签重试兜底(`service.go`)。
- **可砍项**(第一期不带):`apikey.go`(用户已定)、`quota.go`、`stats.go`、
  `accounts.go` 多账号索引(插件有自己的 AccountPool)、
  cryptostore(插件走宿主 `ctx.credentials`)。
  ⚠️ **2026-10-05 更正**:`project.go` 原列在此处,注为「默认路径 project 用常量,
  探测结果不进信封」。真机对照实验证明该前提是**错的** —— 原版确实读
  `loadCodeAssist` 的 `cloudaicompanionProject`。现已补 `src/gemini-project.ts`
  (三级缓存 + 「探测失败不发推理」门控),故**不再是可砍项**。

### 2.2 必须保留的上游对齐细节(丢一条就会被拒/行为漂移)

1. 身份头:**五个值全部逐字写死,不许随机生成**(原项目 client.go:39-45 常量区;0.8.6.1 抓包
   capture.jsonl / session2 / session3 / session5 跨会话逐字恒定):
   `User-Agent: antigravity/4.3.0 (cmdc-pak)` + `x-client-name: antigravity` +
   `x-client-version: 4.3.0` + `x-machine-id: cmdc-pak` + `x-vscode-sessionid: proxy`,
   **不带** `x-goog-api-key`/`x-goog-api-client`。
   ⚠️ `x-machine-id`/`x-vscode-sessionid` 名字像设备指纹,但原版写死的就是 `cmdc-pak`/`proxy`
   两个占位串——UA 括号里也是原版自己的产品名,移植时**连 `(cmdc-pak)` 一起照抄**。
   别"为了更像真实客户端"生成随机值:固定常量是原项目实测能跑的值,随机反而造成同一账号
   前后请求 machine-id 不一致,可能触发服务端的设备指纹一致性校验;
2. **流式请求刻意不带 `Accept` 头**(Go 线;cmdc-pak 有字节级契约测试钉住)。
   ⚠️ TS 这边 `fetch` 默认不发 `Accept`,但有些 polyfill/拦截器会自动加 `Accept: */*`。
   实现时要确认 gemini 的 fetch 不被全局拦截器塞头;
3. **信封逐层字母序序列化**(marshal 后经 map 重排;353 字节金标准)。
   ⚠️ **Go 与 TS 语义差(必须提前点名)**:Go 的 `encoding/json` 对 map 键自动字母序排,
   TypeScript 的 `JSON.stringify` 按 V8 插入序,**不保证字母序**。直接 `JSON.stringify(envelope)`
   大概率对不上 353 字节。
   **实现路径**:手动按字母序构造对象字面量(依赖 V8 对字符串键保持插入序),
   或写一个 `sortedStringify` 先递归排序键。**子代理拿到这个任务大概率先 `JSON.stringify`,
   测试红了再懵——必须在在这点明**;
4. 信封里 `project` **默认** `"aicode-consumers"`（它是 `loadCodeAssist` 探测为空时的
   **兜底**，不是恒值 —— 原版读 `cloudaicompanionProject`）；`sessionId` 由
   `(project, contents[0].text, lane)` **确定性派生**，不是常量、也不是随机
   （`deriveGeminiSessionId`）。`requestId = agent/<unix_ms>/<8hex>` 每请求随机；
   `userAgent:"antigravity"`。
   ⚠️ 2026-10-05 更正：本节此前写"`sessionId` 是预置常量、禁止随机化"（推理
   `"3124275334370613369"` / 冒烟 `"-6686302828062879362"`）。真机对照实验推翻了它——
   那两个值只是**特定输入的输出**被反复抓包：同一 prompt 换 project 会变、换
   model / maxOutputTokens / 系统提示 / 对话轮数都不变。**常量化的后果是所有用户、
   所有对话共用一个会话**，而原版的会话归并与 `thoughtSignature` 回填都挂在这个字段上。
   实验同时确认 lane 进哈希（同 prompt 同预算下推理与冒烟取值不同），故两条路径
   必须用不同标签（`GEMINI_SESSION_LANE_INFER` / `_SMOKE`）。
   ⚠️ 原版哈希函数本体尚未反推出来（已否证 FNV-1a/1、murmur64A、MD5/SHA 系列等 50+ 种），
   故**取值不与原版逐字相同**，对齐的是"同输入同输出 + 依赖维度一致"。
   要复刻历史抓包/联调可用 `sessionId` 选项钉固定值。
5. SSE 解析:先试 `{"response":{…}}` 信封壳、再吃裸 Response;只有 usageMetadata 的收尾帧记用量;
   usage 取"见过的最大 totalTokenCount";`data:[DONE]` 结束;
6. token 交换必须带 client_secret,token 端点不伪装 UA。

### 2.3 插件侧接入契约(从既有代码核实,2026-10-03 复核)

- LlmAdapter 四方法:`providerInfo` / `listModels`(**无账号返回 `[]` 不能抛错**)/
  `resolveModel` / `stream`;建议 `prepareCall` + **同步** `listAllModels()`
  (Jet Hub ModelCatalogSource 是同步接口,写成 async 会抛 not iterable)。类型均来自 `@deepseek-ai/dsh-llm`。
- **`resolveModel` 必须声明 `context` + `reasoning`**(对照 `src/minimax-adapter.ts:273`):
  ```typescript
  resolved.context = { contextWindow: entry.contextWindow }  // ⚠️ 必须填真实值
  resolved.reasoning = {
    efforts: [{ id: ReasoningEffortId('low'), name: '低' }, …],
    defaultEffort: ReasoningEffortId('medium'),
  }
  ```
  - **`contextWindow`**:必须查清 `gemini-3.8-flash` Cloud Code 免费档的真实上下文窗口填进去。
    AGENTS.md 2.1 节(qoder)大篇幅论证了必须取档位表最大档、不能照抄 `max_input_tokens`,
    否则 DSH 上下文压缩会按错误阈值触发。
  - **efforts 的 `name`**:DSH 档位选择器直接渲染 `efforts[].name`、不本地化。给中文即中文界面
    (对照 minimax-adapter:141 的 `'关闭思考'`/`'开启思考'`)。
- Auth Service 契约(**对齐 AGENTS.md 统一接口,只列四个核心方法**):
  `login` / `startLogin` / `refreshAccountCredential(refName, pool, accountId)` / `refreshAll(pool)`。
  - `startLogin` **必须立即返回 loginUrl**(浏览器 transient activation 约 5 秒硬约束);
  - **`refreshAll` 必须照 `src/service.ts:406`(codearts)的最新范式,不要照 minimax-auth.ts:281 的旧范式**:
    - **不按 `entry.refreshable` 跳过**(`if (!entry.refreshable) continue` 是已被推翻的写法);
    - 读凭据本体判材料(gemini 这边判据是 `refresh_token` 在不在,比 codearts 简单——无 PKCE/DPoP);
    - 缺材料才写 `false`,误标下一轮自愈(写前先比现值,避免每轮重复整体落盘);
    - 判终态前先重读凭据(并发烧 token 场景:服务端拒的是旧的一份,磁盘上躺着新的可用的);
    - **必须走共享实现 `refreshAccountWithReconcile`**(`src/expiry-sync.ts`),不要手写对账;
    - **必须提供 `ExpiryAccessors`**:`expiresAtOf` / `refreshableOf` / `identityOf`(用 `access_token`);
    - **仍然不看 `enabled`**(停用账号照续)。
  - `RefreshTokenExpiredError` 以 `error.name` 结构化判定。
- 凭据必须含 `access_token` 字段(AccountPool 认号依据);ref 命名 `GEMINI_ACCOUNT_<suffix>`
  由 RPC 层生成,单凭据回退 `GEMINI_ACCESS_TOKEN`。
- 注册点(index.ts 六处):import、`new GeminiAuth(ctx)`、`registerGeminiLlm(...)`(resolveCredential 池+单凭据回退,
  refresh 必须传 `pool, available.entry.id` 续期才写得回)、**`refreshTargets` 表加一行**
  (`['gemini', (p) => gemini.refreshAll(p)]`,漏了这行续期定时器不武装)、ctx.effect cleanup、modelAdapters 表。
- **`registerProviderSettings` 调用要加 `'llm-gemini'`**(`index.ts:27F272` 那行 namespace 列表)。
- jet-hub-rpc.ts **五处**接线(见 §3.4 面板按钮全量核对):
  1. 函数签名加 `gemini: GeminiAuth` 参数;
  2. `account.create` 加 gemini 分支(占位条目→startLogin→result.then 回填
     nickname/expiresAt/refreshable,失败删幽灵账号——逐字仿 minimax 分支);
  3. `account.refresh` switch 加 `case 'gemini'`;
  4. `credits.balances` 加 gemini 分支(见 §3.3);
  5. **`account-probe.ts` 的 `probeWithAdapter` 分派表加 gemini 分支**(重测按钮,见 §3.4)。
- 客户端三小改:`jet-hub.js` PROVIDERS 加一行(label 与 product.displayName 逐字一致,rail 宽度断言跨文件依赖)+
  图标 data URI;`jet-hub-styles.js` 一个类;`credits-capabilities.js` 登记 `gemini: {balance:true, dailyCheckin:false}`(配额查询见 §3.3)。
- 门控/黑名单零成本:`providerCatalogVisible`(无登录账号整个 provider 隐藏)、
  `pool.disabledModelsFor` 按 provider 自动隔离。
- **网关注册后自动红利**:`gemini/*` 模型自动出现在 :8326 `/v1/models`,零额外代码。
- 标准两步式 provider **不需要特殊前端分支**(zcode 注释明确),面板复用通用「弹窗+loginUrl 轮询」。
- 凭据持久化独立文件的既有惯例:`src/permanent-lock-store.ts`
  (`$DSH_HOME/jet-hub/*.json`,tmp+rename)——**签名缓存放独立文档,不放 state.json**
  (state.json 是整体替换语义,同机旧 profile 代码全量重写会抹掉新键)。

## 三、实施设计(6 个新文件)

| 文件(目标项目 `src/`) | 内容 | 行数预算 |
|---|---|---|
| `gemini.ts` | 产品常量(GEMINI)、`GeminiCredential`、**字母序信封序列化**(`sortedStringify` 或手构字母序对象字面量)、模型档表、`SanitizeGeminiSchema`、DSH Message→Gemini contents 纯函数(systemInstruction、tool_use→functionCall 挂 pendingSig、tool_result→functionResponse、孤儿配对、图片→inlineData)、响应/分片→StreamChunk(thought part→reasoning、签名补发、usage 取 max total) | ~450 |

**`gemini.ts` 纯函数映射细节**(从 `translate.go` 源码核实):

- **systemInstruction**:Anthropic `system` block(字符串或块数组)→ 提取文本 → `{ role: "system", parts: [{ text }] }`。空 system 不设该字段。
- **tool_use → functionCall**:记 `id→name` 映射,挂 pendingSig(签名从 thought part 取)。
- **tool_result → functionResponse**:用 `id→name` 映射找名字,`{ name, response: { result: content } }`。
- **孤儿配对**:tool_result 找不到对应 tool_use 的 → 丢弃(上游 400)。
- **图片 → inlineData**:`{ type: "image", source: { type: "base64", media_type, data } }` → `{ inlineData: { mimeType: media_type ?? "image/png", data } }`。URL 形态跳过(SSRF)。
- **tools → functionDeclarations**:`{ name, description, parameters: SanitizeGeminiSchema(inputSchema) }`。
- **tool_choice → toolConfig**:`none`→`NONE` / `any`→`ANY`(+`allowedFunctionNames`)/ `tool`→`ANY`+指定名 / 默认→`AUTO`。
- **SanitizeGeminiSchema 白名单**(`translate.go:220`):`type/nullable/enum/items/properties/required/minLength/maxLength/pattern/anyOf/propertyOrdering/minimum/maximum/minItems/maxItems/minProperties/maxProperties`。不在白名单的键全删(如 `$schema`/`additionalProperties`)。`type` 为数组形态(`["string","null"]`)→ 收敛单 type + `nullable:true`。`enum` 含非字符串值 → 整个删掉。递归处理 `properties`/`items`/`anyOf`。
| `gemini-oauth.ts` | 本地回调登录(照 `login.ts` startOAuthFlow 骨架:createServer 127.0.0.1、端口≥10000 重试、180s 超时;但无 PKCE/DPoP、回调路径 `/oauth-callback`、Google 端点与参数)、token 交换/刷新(refresh_token 轮换立即回写)、`RefreshTokenExpiredError` | ~200 |
| `gemini-auth.ts` | `GeminiAuth` Service 类,**只实现统一接口四个核心方法**(`login`/`startLogin`/`refreshAccountCredential`/`refreshAll`)+ `fetchModels`(如需),凭据走 `ctx.credentials`,`refreshAll` 照 `src/service.ts:406` 范式 | ~250 |
| `gemini-sigstore.ts` | 签名缓存:独立 JSON `$DSH_HOME/jet-hub/gemini-sigs.json`;键=`sha256(role\0正文前512)[:8]`(name+CanonicalArgs);2000 条上限折半淘汰;tmp+rename 原子写 | ~120 |
| `gemini-adapter.ts` | LlmAdapter:providerInfo/listModels(门控+黑名单)/resolveModel(声明 `context`+`reasoning`,见 §2.3)/stream(reasoningEffort→thinkingBudget、签名 lookup 回填、IsSignatureError→去签重试一次、错误归类见 §3.1、图片接 `projectRequestImage` 见 §3.2) | ~300 |
| `gemini-credits.ts` | **配额查询**(见 §3.3):调 `retrieveUserQuotaSummary` 拿 5h/weekly 两桶,返回 `CreditBalance` | ~100 |

**复用插件既有设施(不重造)**:`normalizeHarnessMessages` + `resolveToolPairing`(工具配对)、
`readWithIdleTimeout`(SSE)、`AccountPool`、`providerCatalogVisible`、`registerAdapterIdempotent`、
`RefreshScheduler` + 30min 池调度器、`makeReadImage` + `makeReadImageRequest`、
`projectRequestImage` + `image-budget`、`refreshAccountWithReconcile` + `ExpiryAccessors`、
`LlmError` 体系。

**明确不做(防范围蔓延)**:API key 通道、token 统计、project 探测、
多账号切换 UI、e2e 真机用例(可后补 `DSH_GEMINI_E2E` 门)。

### 3.1 错误归类与重试层级(必须拆细,不能写「429/5xx→LlmError」)

**两层救场:换端点(廉价兜底) + 换账号(主救场)。**

#### 端点轮换(保留但降级预期)

两个端点是 cmdc-pak 原版 `client.go` 的 `baseFor` 就有的,忠实移植:
- `daily-cloudcode-pa.googleapis.com`(daily)
- `daily-cloudcode-pa.sandbox.googleapis.com`(sandbox)

⚠️ **降级预期(2026-10-03 用户澄清)**:代码注释声称的"入口差异"**没有得到实验支持**——
能测的两类(404、project)两端点行为完全一致,两个 host 背后大概率是同一套模型注册表和配额服务。
换端点**零成本无害**,赌的是"某入口临时抽风"这种小概率事件;**不能当成 quota 类错误的有效解法**。
这反过来加强了换账号的必要性:**429/401/quota-400 的主救场维度就是换账号**,
端点轮换只是顺手的廉价尝试。

#### 错误归类与处理策略

| 错误形态 | 归类 | 处理 | 冷却 |
|---|---|---|---|
| 429 限流(`five_hour`/`weekly`) | `RATE_LIMIT` | 连续 2 次 429 → 切下一个可用账号 | 原账号 60s |
| 401 凭据失效 | `AUTH` | 切下一个可用账号重试 | 原账号 300s |
| 400 quota/permission | `QUOTA_EXCEEDED` | 先换端点(低预期);端点也撞 → 换账号 | — |
| 403/404 | `SERVER` | 先换端点(低预期);端点也撞 → 换账号 | — |
| 签名错误(`IsSignatureError`) | 专用 | 去签重试一次 | — |
| 5xx/网络抖动 | `SERVER`/`TRANSPORT` | 走 harness 退避 | — |
| 切完仍失败 | — | 透传原错误(两个号都挂,用户能在面板看到) | — |

⚠️ 照「429/5xx→LlmError」实现,quota 会被当 `SERVER` 白重试 5 次(500/1000/2000/4000/8000 ≈ 15.5 秒)。
`QUOTA_EXCEEDED` 是既有惯例(`buddy-adapter.ts` / `cline-adapter.ts` 同用),**不在** `DEFAULT_RETRYABLE_CODES`。

#### 限流切号的三个坑(照既有七处惯例)

- `tried` 集合要跨重试保留(否则在两个账号之间无限来回);
- `activeAccountId` 是局部可变状态,不能每次问 `options.currentAccountId()` 回调(回调返回池当前默认账号,切号后不跟着变);
- 全部受限时如实抛 `QUOTA_EXCEEDED`,不无限切。

#### 端点轮换实现(约 10 行)

```typescript
// gemini-adapter.ts
private endpointIdx = 0
private readonly endpoints = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]
// 撞 403/404/400(quota 类) → endpointIdx ^= 1，重试同一账号
// 两个端点都撞 → 换账号
```

### 3.2 图片(两跳:插件侧缩放 + 原项目翻译忠实移植)

**原项目 cmdc-pak 的图片处理是纯 base64 透传,不做任何缩放**(`internal/proxy/translate.go:316` 的 `imagePart`):
收 Anthropic `{type:"image", source:{type:"base64", media_type, data}}` → 校验 base64 合法性
(带换行/空格先清洗)→ `media_type` 缺省填 `image/png` → 产出 `gemini.Part{InlineData:{MimeType, Data}}`。
URL 形态直接跳过(避免 SSRF)。**没有像素预算、没有请求版本派生、没有缩放**——Go 单体服务直接透传,
上游拒了就拒了。

移植后图片走**两跳**,职责分离:

**第一跳:插件侧缩放(新增防御,非原项目移植)** —— 照 `src/buddy-adapter.ts:900` 接 `projectRequestImage`:
```typescript
private async projectRequestImage(ref: unknown) {
  return projectRequestImage(ref, {
    readImageRequest: this.options.readImageRequest,
    pixelBudget: this.product.imagePixelBudget,  // 未配置时用 DEFAULT_IMAGE_PIXEL_BUDGET(640,000 px)
  })
}
```
- `GeminiProduct` 加 `imagePixelBudget` 字段(可选,未配置走默认);
- index.ts 注册时传 `readImage: makeReadImage(ctx)` + `readImageRequest: makeReadImageRequest(ctx)`(两者都传);
- ⚠️ 这是**当前插件侧的防御性接入**,不是从原项目移植来的行为。原项目没做缩放、也没探过
  Cloud Code 免费线的图片视觉 token 预算或请求体体积限制。照既有七处惯例(buddy/workbuddy/raccoon/
  qoder/qodercn/lobsterai/cline)先接上 640,000 px,撞墙再调——无害防御,最多图片质量略降。

**第二跳:翻译成 `inlineData`(原项目忠实移植)** —— `gemini.ts` 的 `imagePart` 照
`translate.go:316` 实现:base64 校验(清洗换行/空格)、`media_type` 缺省 `image/png`、URL 跳过、
产出 `InlineData`。缩放后的字节经这一跳进 `inlineData.data`。

### 3.3 配额查询(移植自 cmdc-pak `quota.go`,面板「刷新积分」按钮可见)

gemini 走 Cloud Code 免费线,有 **5 小时 / 周**两个配额窗口(不是充值制积分)。
cmdc-pak 原版 `quota.go` 已实现查询,忠实移植进 `gemini-credits.ts`。

**端点**:`POST {endpoint}/v1internal:retrieveUserQuotaSummary`,请求体空对象 `{}`(**不带 project**)。
身份头同推理请求(`antigravity/4.3.0` + `x-client-*`),Bearer 用 access_token。

**响应形状**(原版注释里的实测结论,普通 JSON 不是 protobuf):
```json
{"groups":[
  {"displayName":"Gemini Models","buckets":[
    {"bucketId":"gemini-weekly","window":"weekly","resetTime":"2026-10-08T07:54:35Z",
     "remainingFraction":0.99973387,…},
    {"bucketId":"gemini-5h","window":"5h","resetTime":"2026-10-01T17:54:35Z",
     "remainingFraction":0.9984369,…}]},
  {"displayName":"Claude and GPT models","buckets":[…]}]}
```

只取 `gemini-5h` / `gemini-weekly` 两个桶(第三组 `3p-*` 是 Claude/GPT 的,与本产品线无关)。

**映射到插件 `CreditBalance`**(对照 `src/cline-credits.ts:110` 的 `toClineCreditBalance`):
```typescript
// gemini-credits.ts
export function toGeminiCreditBalance(fiveHour?: QuotaWindow, weekly?: QuotaWindow): CreditBalance {
  const pkgs: CreditPackage[] = []
  if (fiveHour) pkgs.push(makePackage('5 小时窗口', fiveHour))
  if (weekly) pkgs.push(makePackage('周窗口', weekly))
  return { total: pkgs.length > 0 ? Math.round(avg) : 0, packages: pkgs, expiredTotal: 0 }
}
```
- `remainingFraction` → `remaining`(百分比);`resetTime` → `cycleEndTime`;
- ⚠️ **不是积分余额制**,是配额窗口剩余比例。面板会显示「5 小时窗口 99% / 周窗口 99%」
  而非「N 积分」——这是**如实**的,不要假装成积分数字。

**能力登记**(`plugin-src/client/credits-capabilities.js`):
```javascript
gemini: Object.freeze({ balance: true, dailyCheckin: false }),
```

**RPC 分派**(`src/jet-hub-rpc.ts` 的 `credits.balances` 分支加一个 case):
```typescript
if (req.provider === 'gemini') {
  const values = await collectCreditBalances(accounts, GEMINI, {
    resolve: (ref) => ctx.credentials.resolve(ref),
    fetchBalance: (credential) => fetchGeminiCreditBalance(credential),
    warn: (msg) => ctx.logger?.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } }
}
```

**60 秒缓存**:照原版 `quotaCacheTTL`,面板 30 秒刷一次,60 秒缓存既扛连续刷新又不至于让"快用完了"滞后太久。`?force=true` 跳过(面板「刷新」按钮)。

**无凭据时**返回 `{ balance: null, error: '尚未授权 Google 账号' }`(照原版 `MessageUnauthorized`),不报错——面板区分"未授权"与"查询失败"靠的就是这个。

### 3.4 面板按钮全量核对(2026-10-03 用户要求确认)

前端 `jet-hub.js` 里所有 `rpcCall()` 调用逐条核对,gemini 移植后的接线状态:

| 按钮 / RPC 方法 | 接线状态 | 说明 |
|---|---|---|
| **新建账号** `account.create` | ⚠️ **要加分支** | `jet-hub-rpc.ts:1252` 的 if-else 链,照 minimax 分支(占位条目→startLogin→回填,失败删幽灵) |
| **账号列表** `account.list` | ✅ 自动生效 | 按 `pool.listAccounts(provider)` 通用分派 |
| **登录轮询** `login.poll` | ✅ 自动生效 | 检查凭据是否已写入,与 provider 无关 |
| **刷新凭据** `account.refresh` | ⚠️ **要加 case** | `jet-hub-rpc.ts:1846` 的 switch,加 `case 'gemini': await gemini.refreshAccountCredential(ref, pool, id)` |
| **停用/启用** `account.update` | ✅ 自动生效 | 通用 `pool.updateAccount`,与 provider 无关 |
| **删除账号** `account.delete` | ✅ 自动生效 | 通用 `pool.removeAccount` |
| **拖拽排序** `account.reorder` | ✅ 自动生效 | 通用 `pool.reorderAccounts` |
| **模型列表** `model.list` | ✅ 自动生效 | 走 `ctx.llm.listModels('gemini')`,适配器注册后自动路由 |
| **模型黑名单** `model.setDisabled` / `setDisabledMany` / `setAllDisabled` | ✅ 自动生效 | 通用 `pool.disabledModelsFor(provider)`,按 provider 自动隔离 |
| **重测** `account.retest` / `retestAll` | ⚠️ **要加分支** | `account-probe.ts:241` 的 `probeWithAdapter` 分派表,加 `else if (entry.provider === 'gemini') adapter = new GeminiAdapter(...)`。**不加会落到 else 被 CodeArtsAdapter 用华为云 HMAC 签名发 gemini 凭据,必然失败**(该表已四次因新增 provider 没同步出缺陷) |
| **重置限流标记** `account.reset` / `resetAll` | ✅ 自动生效 | 通用 `pool.clearModelRateLimits`,与 provider 无关 |
| **配额查询** `credits.balances` | ⚠️ **要加分支** | 见 §3.3,调 `fetchGeminiCreditBalance` |
| **一键签到** `credits.claimAll` | ✅ 不渲染 | `dailyCheckin:false`,面板不渲染按钮 |
| **永久积分锁定** `credits.permanentLock` | ✅ 不渲染 | `supportsPermanentLock` 不含 gemini |
| **新手任务** `onboarding.claim` | ✅ 不渲染 | `supportsOnboardingTasks` 不含 gemini |
| **订阅额度** `cline.quota` / `cline.requestLog` | ✅ 不渲染 | `supportsSubscriptionQuota` 只有 cline |
| **备份** `backup.*` | ✅ 自动生效 | 与 provider 无关 |
| **网关开关** `gateway.*` | ✅ 自动生效 | 与 provider 无关 |
| **provider 开关** `provider.status` / `setEnabled` | ✅ 自动生效 | `PROVIDERS` 表加了 gemini 行就有 |

**三处必须加分支的**:`account.create`、`account.refresh`、`account-probe.ts` 的 `probeWithAdapter`。
**一处要加 credits 分支的**:`credits.balances`(§3.3)。
**其余全部自动生效或正确不渲染。**

⚠️ `account-probe.ts` 的分派表是**最容易漏**的:它不走 `productById` 查表,而是硬编码 if-else。
该表已四次因新增 provider 没同步出缺陷(workbuddy → trae → qoder/cline → zcode)。
gemini 必须显式加分支,并补 `tests/unit/account-probe-adapter.spec.ts` 的对应用例。
**同时 `ProbeCredential` 联合类型要加 `GeminiCredential`**,否则 TypeScript 编译不过。

**`credits.status` / `credits.claimAll` 不用加分支**:gemini `dailyCheckin:false`,前端不调这两个。
万一被调到会落到 `productById` 查表 → gemini 不在 buddy 系表里 → 返回 `unsupported provider` bad-request,
是安全失败模式,不会误用错协议。

## 四、测试方案(vitest,照 minimax 惯例:替换 globalThis.fetch + 构造器注入 stub)

`tests/unit/` 七个 spec:
1. `gemini-payload.spec.ts` —— 信封字节金标准(字母序)+ 档位 thinkingConfig 形状;
2. `gemini-messages.spec.ts` —— DSH→Gemini 序列化、pendingSig 挂载、functionResponse 拍平、孤儿配对;
3. `gemini-stream.spec.ts` —— SSE 消费:信封壳/裸 response 双吃、thought 分片→reasoning、
   usage 取 max、无内容块抛错(不静默结束);
4. `gemini-sigstore.spec.ts` —— 回填命中、淘汰、损坏文件容错;
5. `gemini-rpc.spec.ts` —— `account.create` 立即返回 loginUrl(「授权永不完成」替身);
6. `gemini-errors.spec.ts` —— **错误归类**:quota→`QUOTA_EXCEEDED` 不重试、429→切号、签名→去签重试。
7. `gemini-credits.spec.ts` —— 配额查询:`retrieveUserQuotaSummary` 响应解析、5h/weekly 两桶提取、
   `3p-*` 桶跳过、无凭据返回 null、60 秒缓存命中/`force` 跳过。
8. `account-probe-adapter.spec.ts` 补一条 —— gemini 在 `probeWithAdapter` 分派表里有独立分支
   (防第四次同型缺陷:新增 provider 漏加分派,落到 else 被 CodeArtsAdapter 签名失败)。

## 五、执行步骤与分工(待确认后执行,**全部 inline**)

1. **[主模型 inline]** 定稿六个新文件的导出骨架与 DSH↔Gemini 映射表(接口先行)。
2. **[主模型 inline]** `gemini.ts` 纯函数层 + 测试 1/2/3。
3. **[主模型 inline]** `gemini-oauth.ts` + `gemini-sigstore.ts` + 测试 4。
4. **[主模型 inline]** `gemini-auth.ts` + `gemini-adapter.ts` + `gemini-credits.ts`(与插件服务契约耦合最深、坑最密集,亲做)。
5. **[主模型 inline]** index.ts / jet-hub-rpc.ts / plugin-src/client 接线 + 测试 5/6/7。
6. **[主模型 inline]** 跑全量 `pnpm typecheck && pnpm test && pnpm build:all`,回报输出。
7. **[主模型 inline]** 逐条验收:门控返空数组、两步式立即返回 URL、refreshAll 照 codearts 范式、
   轮换立即回写、字母序金标准;通过后在目标项目本地提交(**不 push**,远端为他人仓库)。

## 六、真实 wire 样例(移植时的对齐基准)

### 非流式请求(POST /v1internal:generateContent,字母序键,353 字节金标准)

```json
{"model":"gemini-3.8-flash-high","project":"aicode-consumers",
 "request":{"contents":[{"parts":[{"text":"reply one word: ok"}],"role":"user"}],
            "generationConfig":{"maxOutputTokens":50,
                                "thinkingConfig":{"includeThoughts":true,"thinkingBudget":10000}},
            "sessionId":"3124275334370613369"},
 "requestId":"agent/1790868102000/f37baaa0","userAgent":"antigravity"}
```

tiered 档差异:thinkingConfig 只剩 `{"includeThoughts":true}`。

### 流式 SSE:thinking 与 thoughtSignature 的出现形态

```
data: {"response":{"candidates":[{"content":{"role":"model","parts":[
        {"text":"先看看目录","thought":true,"thoughtSignature":"SIG_A"}]}}]}}
data: {"response":{"candidates":[{"content":{"role":"model","parts":[
        {"text":"继续","thought":true}]}}]}}
data: {"response":{"candidates":[{"content":{"role":"model","parts":[
        {"functionCall":{"name":"read_file","args":{"path":"a.go"}},
         "thoughtSignature":"SIG_FC"}}]}},
       "usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,
                        "thoughtsTokenCount":2,"totalTokenCount":13}}}
```

代理侧规则:thought 分片→`reasoning-delta`;分片上首次出现的签名补 `signature`(去重);
functionCall 的签名进缓存;usage 映射 `input=prompt+cached`、`output=candidates+thoughts`。

### 非流式响应(信封壳,亦可能裸 Response)

```json
{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"finishReason":"STOP"}],
  "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":30,
                   "totalTokenCount":180,"cachedContentTokenCount":0}}}
```

## 七、已从原项目定掉的决策(不再开放)

1. **模型暴露方式:1 个模型 + efforts 下拉框(不暴露 4 个带后缀的模型名)**。
   原项目把 4 档暴露成 4 个模型名,是因为它的客户端是 Claude Code CLI——CLI 只有选模型这一个入口,
   没有「思考档位选择器」UI。插件面对的是 DSH 智能体界面,有 efforts 下拉框可用,该用下拉框。
   给用户 4 个几乎同名的模型（`-high`/`-medium`/`-low`/`-tiered`）反而让人困惑。

   **链路**:
   ```
   用户选模型「gemini-3.8-flash」(只一个) → 下拉框选「高」
   DSH 调 stream({ model: "gemini-3.8-flash", reasoningEffort: "high" })
   适配器拼信封: model = "gemini-3.8-flash-high"(带后缀,满足上游契约)
                 thinkingBudget = 10000, includeThoughts = true
   上游收到带后缀的完整名(不 404)
   ```

   **上游契约不变**(信封 `model` 字段仍带后缀),变的是对用户的暴露方式——后缀拼接在适配器内部完成,用户不可见。

   **三条实测事实定死的设计**(来自原项目 MITM 抓包 + 对照实验):
   - **模型名是准入钥匙**:发裸的 `gemini-3.8-flash` 上游直接 404,必须带后缀;
   - **思考预算是自由旋钮**:模型名叫 medium 但预算给 10000,上游真的按 10000 思考(213 token;
     对照组 4000 预算只有 164)——名字和预算互不干涉,客户端发 `thinking.budget_tokens` 就能任意调;
   - **「关闭思考」是假关**:把 `includeThoughts` 关掉,模型照样思考、照样计费(195 token),
     只是不把思考内容传回来。所以**没有「省钱的关闭档」**,只有「省流量的不显示」。

   ⇒ **不提供 `none`/关闭思考档**(假的,照样计费,不假装能省钱);`includeThoughts` 恒 `true`。

   `listModels` 返回 2 个条目:
   - `gemini-3.8-flash` —— 有 `reasoning.efforts`,4 档(低/中/高/自适应),`defaultEffort = 'medium'`。
   - `gemini-3.8-flash-lite` —— **无 efforts**(原版 `model.go:98` 按低档处理,`budget=1000`,
     不带档位后缀,信封 `model` 字段直接发 `gemini-3.8-flash-lite`)。额度紧张时的兜底模型。

   `resolveModel("gemini-3.8-flash")` 声明:
   ```typescript
   resolved.context = { contextWindow: 1_000_000 }
   resolved.reasoning = {
     efforts: [
       { id: ReasoningEffortId('low'), name: '低' },       // thinkingBudget 1000
       { id: ReasoningEffortId('medium'), name: '中' },    // thinkingBudget 4000
       { id: ReasoningEffortId('high'), name: '高' },      // thinkingBudget 10000
       { id: ReasoningEffortId('tiered'), name: '自适应' }, // 不传 thinkingBudget,上游按题难度自适应
     ],
     defaultEffort: ReasoningEffortId('medium'),
   }
   ```

   `stream()` 里 `reasoningEffort` → 查 thinkingBudget 表 → 拼信封 `model = "gemini-3.8-flash-" + effort`。
2. **efforts 的 `name`**:**中文**（`'低'`/`'中'`/`'高'`/`'自适应'`）。
   既有 provider（`minimax-adapter.ts:141`）已给中文,DSH 档位选择器直接渲染 `efforts[].name` 不本地化,照惯例。
3. **`listModels`**:**静态表**。
   原项目 `model.go` 的 `ModelNames` 就是固定四条 + `UpstreamFlashLite`,不发网络请求。
   照搬（与 qoder `fallbackModels` 同惯例,更稳、零额度）。
4. **`contextWindow`**:**填 1,000,000**(1M,用户 2026-10-03 确认)。
   原项目不记此值（它是代理,上下文窗口由上游管）,插件侧 DSH 要靠它决定何时压缩。
5. **5 小时限流切号**:**切账号**(用户 2026-10-03 确认)。
   限流维度(按账号/设备/项目)未实测确认,第一期照换账号实现(机制零成本)。
   若实测发现按设备/项目限(换号无用),改成「5 小时直接等、不切号」。
6. **图片像素预算**:**先按 640,000 px 接上**(用户 2026-10-03 确认)。
   Cloud Code 免费线的图片视觉 token 预算或请求体体积限制未探,
   照既有七处惯例先接上,撞墙再调。

## 八、已拍板的开放问题

1. **`claude-*` 别名:不做,只暴露 `gemini-3.8-flash-*`**(2026-10-03 定)。
   API.md 路由表把 `claude-*`（Sonnet/Haiku/Opus/Fable）映射到 Gemini 四档,那是 cmdc-pak
   作为代理服务器兼容 Claude Code CLI 的便利(CLI 发 `claude-sonnet`,它得认)。移植进插件后:
   - 插件不直接面对 Claude Code CLI,它面对 DSH harness,harness 自己管 model 路由,不需要这层兼容;
   - `claude-*` 是假名,DSH `/v1/models` 会合并所有 provider 的模型列表,认领 `claude-sonnet`
     会让用户选 claude 时走 gemini(「选了 claude 怎么是 gemini 在回答」);
   - 未来 DSH 生态里可能加真的 Claude provider(或用户自装 Anthropic API key provider),
     `claude-sonnet` 就真冲突——两个 provider 都认领同名,harness 分派不可预测。
   ⇒ gemini provider 只暴露 `gemini-3.8-flash`(+ `-low/-medium/-high/-tiered` 四档)
   与 `gemini-3.8-flash-lite`,不认领 `claude-*`。

## 九、遗留给用户的事项

- **v0.8.9 未取证**（2026-10-03）：`E:\Downloads\cmdc-pak v0.8.9.exe` 与前两版一样全量字符串加密,
  二进制里搜不到任何一条身份常量（`x-machine-id`/`antigravity`/两个 sessionId/
  `aicode-consumers`/`requestId`/`v1internal` 全部 0 命明文）,静态取证失效;其 Gemini 线
  也还没有 MITM 抓包（pojie/analyze 里 089 的产物只有面板 oracle 探针 home）。
  本计划全部常量基准 = **0.8.6.1（两轮 MITM）+ 0.8.8（oracle 61 探针）**,这两个版本已证实恒定;
  v0.8.9 是否同款要钉死只能 HTTPS_PROXY 引流对它做一轮 Gemini 线 MITM。前两版恒定 +
  字符串加密方案未变,大概率同款,但在取证前不当结论用。
- 真机验证:插件里「+ 新建账号」走完 Google 授权后,发一条带工具调用的多轮消息,
  确认 thinking 显示与签名回填(对照 cmdc-pak 面板日志);
- 目标项目从未安装过依赖,执行第 2 步前需先 `pnpm install`(node 22+)。
