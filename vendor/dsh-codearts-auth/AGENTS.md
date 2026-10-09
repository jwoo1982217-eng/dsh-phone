# 项目指令：dsh-codearts-auth
## 深细节索引（按需读，不进每轮注入）

以下主题的**事故史与逐项规则**已搬到 `docs/agent-notes/`（每节逐字节原样保留）。
**触发条件命中时才读对应文件**——改某 provider 前先读它的笔记；做 UI 前读 client-ui；
动协议/网关/积分前读 protocol-wire。别凭印象改：这里的每一条都是踩过坑的。

- `docs/agent-notes/dev-tasks.md`：「常见开发任务」的**调试与协议排障**细节（主文件只留导航表）
- `docs/agent-notes/misc.md`（8 节）：⚠️ 两条通用判据：一文件两套同义判据 / `String(undefined)`（PR !62）；⚠️ 包装适配器时必须包 `prepareCall`，不是 `stream`（PR !66）；项目概述（十个 provider 的协议源流与差异总览）；⚠⚠️ 客户端**不得**注册 `settings.models.provi；⚠️ dsh peer 范围必须**枚举并集**，不能用 `^0.1.2-r；LobsterAI 模型列表（三个易踩的坑）；…
- `docs/agent-notes/providers-qoder.md`（1 节）：⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 
- `docs/agent-notes/client-ui.md`（20 节）：⚠⚠️ 一键签到的汇总**必须按单位分列**，不得跨单位求和（2026-10-04）；⚠ 「通用面板」里的按钮与弹窗**必须按 provider 分支**（Iss；账号池与多账号（含模型饱和 14003 不许换号）；模型黑名单（Jet Hub「显示列表」开关）；目录门控：没有已登录账号就隐藏整个 provider；…
- `docs/agent-notes/protocol-wire.md`（14 节）：⚠⚠ RPC 的 `catch` **不得**把失败包成 `ok:true`（Issue IKJOZA）；⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IK；单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤；⚠️ 持久化：DSH 0.1.7 移除 `settings.register；⚠️ 「锁定永久积分」三家**共用一张表与一个端点**，但判据必须各算；…
- `docs/agent-notes/providers-buddy.md`（5 节）：模型计费倍率与同名模型（必须写进 `name`，不是 `descriptio；⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不；⚠⚠️ 腾讯系内容级风控：system 里的客户端模板句会被**整轮拦死**
- `docs/agent-notes/providers-cline.md`（3 节）：⚠️ Cline provider：`workos:` 前缀不可剥、免费集合；⚠️ Cline 限流：倒计时用**报文里的人类可读时长**，402 不许倒
- `docs/agent-notes/providers-trae.md`（2 节）：TRAE（字节跳动）协议要点（五个易踩的坑）
- `docs/agent-notes/providers-loomy-raccoon-minimax.md`（3 节）：⚠️ Loomy（讯飞）provider：五个不能凭直觉改的点；⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的；⚠️ MiniMax Code（中国版）provider：不能凭直觉改的点
- `docs/agent-notes/providers-zcode.md`（4 节）：⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根；⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，20；⚠️⚠️ `3012` 的 HTTP 状态码是 **405**（不是 403；⚠️ ZCode captcha 的真实形状（2026-10-01，3.14

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。
## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证
  git 安装时两侧产物齐全。
  ⚠️ **`tsc` 不清理「源文件已删除」的产物**：改名/删文件后 `lib/` 会留着旧的
  `.js` / `.d.ts` / `.map`（2026-10-01 把 `cline-modalities.ts` 换成
  `cline-models-dev.ts` 时实测到，`lib/cline-modalities.*` 四个文件仍在，
  并随文件拷贝式安装一起进了 profile）。**删改源文件后手动清一次 `lib/`**
  （或整目录重建），否则残留模块虽无人 import 却会一直跟着发布。
  ⚠️ **`plugin-src/client/jet-hub-styles.js` 里的 `STYLES` 是模板字符串 ——
  CSS 注释内绝不能出现反引号**。用它给属性名加强调（`` `min-width: 0` ``）会
  **提前闭合模板**，esbuild 报 `Expected ";" but found "min"` 并把指针指到注释那一行，
  看起来像 CSS 写错了，实际是 JS 语法问题（2026-10-01 改页头样式时踩过，
  一次引入 6 对）。注释里要强调就直接裸写 `min-width: 0`。
  改完这个文件**必须跑一次 `pnpm build:client`** —— 单测只读源码文本，不会因此失败。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy`、`test:e2e:workbuddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致
## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |
## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明
## 工作方式

### ⚠️ 子任务优先用 **inline** 执行，不要新开 subagent

处理多任务计划（如 `docs/superpowers/plans/*.md` 的 Task 1..N）时，**新子任务直接在
当前会话 inline 做**，不要为每个子任务再新开 subagent。用户 2026-09-29 明确要求。

理由（本项目实测的代价）：
- **同一工作区无法安全并行**：subagent 做「反向验证」时会在源码里注入**临时变异**
  （未提交状态）。此时若另一个 subagent 跑全量测试，会看到 2~3 条**不属于它的**失败，
  容易误判为自身缺陷；更糟的是若它执行 `git stash` / `git checkout -- .` /
  `git restore` / `git add -A`，会**毁掉**前者的变异验证（丢未提交的变异体与还原基线）。
- **subagent 会长时间空转**：本项目已有两次复审 subagent 跑到超时仍无产出
  （Task 2 的复审者被 `interrupt_agent` 中止、Task 4 的复审者未输出即结束）。
- **context 更可控**：inline 做时前面已建立的实测事实（协议细节、坑点、
  既有范例行号）都在手边，不必每次重新交代，也不会因为表述遗漏而让子代理
  重新踩已知的坑。

若确实要用 subagent（例如任务之间**没有文件重叠**且**都不做变异验证**），必须：
1. 预先告知它「工作区可能有他人未提交改动，**只 `git add` 自己的文件**」；
2. **明令禁止** `git stash` / `git checkout -- .` / `git restore` / `git add -A`；
3. 告诉它判断成败要用**自己的**测试文件，全量测试只作参考。

### `ctx.xxxAuth` 服务统一接口

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`qoderCnAuth`、`traeAuth`、`clineAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName, pool?, accountId?)` — 按凭据 ref 续期**指定账号**（账号卡片「刷新」按钮）。⚠️ 后两个参数**必须传**：只有拿到池与账号 id，续期后的新 `expiresAt` 才能回写账号池（见下）
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：十个 provider 的登录/状态/续期**全部**在 Jet Hub 设置页完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**（用户要求）：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `login`/`startLogin` 的 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`（后两者当时就没有调用方）。
  `refreshModels()` **签名改为接收 `pool`** —— 它原先直接读固定 ref，
  移除单凭据后会恒返回空列表。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （注意代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 十个 provider 的门控判据因此**完全一致**：都只看账号池，
  `providerCatalogVisible` 的 `extraCredentialRefs` 参数已随之删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次
  （用户已确认接受该行为，不做自动迁移）。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

⚠️ **「不看 `enabled`」这条仍然有效；「按 `refreshable` 过滤」这条已被推翻**
（2026-10-02，见下文「账号池的 `refreshable` 只是凭据材料的镜像」）：
那个布尔当过滤条件用会把一次瞬时失败固化成单向门，账号从此永不自愈。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号同样会出现在 Jet Hub 里并参与积分领取。

**真实缺陷**（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
点「一键领取积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
根因是两处都按 `enabled` 过滤：

- `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
  → 停用期间 refresh_token 一路放到失效；
- `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
  → **所有账号都停用时续期定时器根本不启动**。

用户重新启用后拿到的是死凭据，只能重新登录。十个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

⚠️ Qoder 中国版**复用同一个 `QoderAuth` 类**（`src/qoder-auth.ts`），故它的
`refreshAll` 判据**天然与国际版一致** —— 不存在「CN 那份实现忘了改」的可能，
这正是「差异收敛到产品配置」这个模式的价值。

### ⚠️ 续期三件事缺一不可：启动先跑一轮、lead-time 判据、回写账号池

**真实缺陷**（Gitee issue !IKIRTT，用户报障）：重启后 cline / codearts / raccoon
的账号卡片**最长 30 分钟**显示红色「有效期：已过期 · 自动续期」，积分行报
`账户信息查询失败：HTTP 401`，而凭据其实是好的（`refresh_token` 到 10 月）。
点「刷新」按钮凭据续成功了、**界面纹丝不动**，点「重测」也不救急
（`src/account-probe.ts` 的 `refresh` 是**刻意**的 no-op，探测不该触发全局续期）。

根因是多账号改造丢了三条语义，三者**必须同时在**（缺任何一条都还会看到症状）：

1. **启动首轮**：`src/index.ts` 的调度器原先只有 `setInterval`，第一次处理要等满
   一个周期。短寿命令牌（cline 1h / codearts 约 2h / raccoon 3h，对照 buddy 系 720h）
   在宿主关闭期间早已到期 → 只有这三个 provider 会暴露出来。
   现在 `pool.listAllAccounts()` 门控通过后**立刻** `void refreshAllCredentials()`。
   ⚠️ 那条链原本**没有 `.catch()`**：`listAllAccounts()` 一 reject，定时器永不武装
   且日志零字 —— 「30 分钟」会恶化成「永不自愈」。
2. **lead-time 判据**：`shouldRefreshNow()`（`src/expiry-sync.ts`）复用单凭据时代
   `REFRESH_LEAD_MS`（1 小时）—— 距过期不足 1 小时才发续期请求。
   这既让启动首轮只打 0~3 个请求（39 账号的池不会在启动时突发几十个请求），
   也终结了「八个 provider 的 `refreshAll` 没有任何过期判据、每 30 分钟全量轮换」。
   ⚠️ **判据必须用凭据自己的 `exp`，不能用账号池的 `expiresAt`** ——
   池值正是本缺陷里可能陈旧的那份数据，拿它当尺子会漏刷真正快过期的账号
   （读凭据只是本地存储访问，不花网络也不花模型额度）。
   ⚠️ **raccoon 保留更严的「已过期才刷」**（`isRaccoonExpired`，lead=0）：
   它 3 小时寿命 + 30 分钟定时器已足够，提前 1 小时刷只会多打请求 ——
   lead-time 的目的是**减少**请求，不是增加。别「为统一」把它改成 1 小时。
3. **回写账号池**：UI 读的**只**是池里的 `expiresAt`
   （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）。
   原先十个 provider 里只有 raccoon 回写，其余八个（含 `createPoolRefresh` ——
   CodeBuddy 系**发消息途中**按需续期的路径，触发频率远高于点按钮）
   只 `credentials.set` → 「数据源分叉」，功能完全正常但界面永远错。
   现统一走 `src/expiry-sync.ts` 的 `syncAccountExpiry` / `refreshAccountWithReconcile`。

⚠️ **`refreshAll` 里「本轮不刷」的分支绝不能直接 `continue`** —— 必须仍做一次
有效期对账。只修「续期时回写」是不够的：**存量账号**的凭据早已在别处（IDE /
上一轮）续好，判据必然为「不用刷」，池里的旧值就**永远无人更正**。
判据用「与凭据不一致」（不是「池值已过期」），否则漏掉「池值偏小但尚未过期」。
一致时不写盘（账号列表是整体落盘的），容差 1 秒（JWT 的 `exp` 是秒级）。

四个必须记住的实现约束：

- ⚠️ **`isLoomyRefreshable` 恒为 `false`**（Loomy 没有 refresh 端点，是诚实标记）。
  故 `ExpiryAccessors.refreshableOf` 是**可选**的，Loomy 那份不提供 ——
  否则共享实现会把池里的 `refreshable` 写成 false，与该产品的设计自相矛盾。
- ⚠️ `findAccountIdByCredential` 的第二参是**凭据内容**不是 ref 名（传 ref 名会
  恒匹配失败且**静默**）；且 codearts 比对的字段是 **`access_key_id`**（它的凭据里
  根本没有 `access_token`）；它还**跳过 `enabled === false`** 的账号。
  ⇒ 调用方已知 `entry.id` 时**必须显式传**，反查只是兜底。
- ⚠️ 回写失败**只记日志、不上抛**：凭据已经续期成功了，因写索引失败而报错会让
  用户以为续期失败、甚至触发无谓的重新登录。
- ⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值：`updateAccount` 做的是
  `{ ...entry, ...patch }`，写 `undefined` 落盘会被 `JSON.stringify` 整个丢弃，
  UI 于是从「已过期」变成「未知」—— 保留旧信息更有价值。

⚠️ 边界（别夸大这类缺陷）：**功能一直是好的** —— 适配器发现凭据过期会按需
`refresh()` 再发请求；定时器跑过一轮后 UI 也会自愈。受影响的是「启动到首轮之间」
的界面与积分行，以及窗口内点「刷新」看不到变化。

可观测性（同一 issue 的第 5.4 条）：`src/index.ts` 原先有**十个**
`catch { /* 静默 */ }`，把 provider 内部告警与异常一起吞掉。现收成
`refreshTargets` 表驱动 + 一处 `ctx.logger.warn`。
⚠️ `src/service.ts`（codearts）此前**整份文件零 logger**，而它的令牌最短命 ——
续期失败将完全无痕，现已补 `refreshAll` 两个分支的日志。

测试：`tests/unit/expiry-sync.spec.ts`（19 条：lead 边界含 `<=`、一致不写盘、
1 秒容差、不传 refreshableOf、反查传凭据内容、回写失败不反噬、
「有效期内仍须对账」、续期返回 undefined 时绝不落盘）+
`tests/unit/refresh-bootstrap-wiring.spec.ts`（19 条：启动首轮排在定时器前、
十个 provider 都在表里、九个 auth 的 `refreshAccountCredential` 都带
pool/accountId 且真调共享回写、RPC 与 `createPoolRefresh` 都传 id）。

### ⚠️ 账号池的 `refreshable` 只是**凭据材料的镜像**，绝不能当续期门禁

**真实缺陷**（用户报障 2026-10-02）：「我们插件的 codearts 账号池出现 2 个 401 未认证，
自动续期没有工作吗？重启也还是 401」。

本机取证（只读 `~/.dsh/jet-hub/state.json` + `~/.dsh/.credentials.yaml`）：

| 事实 | 值 |
|---|---|
| 两个 codearts 账号在池里 | `refreshable: **false**`（9-25 的快照里同两条还是 `true`）|
| 凭据本体 | **完好**：`refresh_token` 还剩 18 天寿命（到 10-18）、`code_verifier` 64 位、`dpop_private_key_jwk` 都在 |
| 凭据的 `expires_at` | 停在 12 小时前那次成功续期上，此后**再没被写过** |
| 整个池 | 36 条里 **33 条** `refreshable:false`（loomy 4 + zcode 2 是诚实的 false）|

⇒ 旧实现 `refreshAll()` 第一行 `if (!entry.refreshable) continue` 把这个布尔变成了
**单向门**：任何一次把它写成 false 的事件之后，该账号**永不进入续期循环** ——
定时那轮跳过它、启动首轮也跳过它，于是「自动续期没工作、重启也没用」，
而凭据明明还能用。**这正是上一节「只按 `refreshable` 过滤」那条约定的代价**，
该约定已被本节修订，见下文。

**三条已落地的规则**（`src/service.ts` 的 `CodeArtsAuth.refreshAll`）：

1. **调度判据读凭据，不读池值**。`isCodeArtsRefreshable(credential)`
   （`refresh_token` + `code_verifier` + `dpop_private_key_jwk` 三样齐全）
   才是「能不能续」的权威；池里的 `refreshable` 是**每轮由凭据对账出来的结果**，
   不是「曾被服务端拒绝过」的案底。误标会在下一轮自动改回 true（自愈）。
   只有**凭据确实缺材料 / ref 下没有凭据**才写 `false`，且写前先比现值
   （`if (entry.refreshable)`）—— 定时器每 30 分钟一轮，别重复整体落盘。
   ⚠️ 读凭据只是**本地存储访问**，不花网络也不花模型额度 ——
   拿它当门禁来「省请求」是**错省**，省下的是自愈能力。
2. **判终态前先重读凭据**：续期被拒（`invalid_grant`）时，先看磁盘上那份
   `refresh_token` 是否**已经不等于**本次用来续期的那一份。并发下服务端烧掉的是
   **旧的**一份，而磁盘上此刻躺着一份**新的、可用的**凭据 —— 那是「他处已续成功」，
   不是「本账号不可续期」。少了这层判据，一次交错就把好账号永久标死。
   命中时改用**最新凭据**对账（`syncAccountExpiry`），不发终态标记。
3. **`InvalidDPoPHeader` 不算 refresh_token 失效**（`src/oauth.ts` 的 `requestToken`）。
   旧判据把它与 `invalid_grant` 并列为终态，注释写的理由是「避免每 10 分钟无限重试」，
   实际代价是一个**材料完好**的账号被标死、用户只能重新登录。DPoP proof 没过校验
   说的是「**这一次**证明不合格」（时钟偏差让 `iat` 落在窗口外 / proof 被判重放 /
   网关抖动），与「refresh_token 还能不能用」无关；归为可重试的代价只是 10 分钟后再发
   一个 HTTP 请求。终态只留 `invalid_grant` 与 `ExpiredRefreshToken`。

4. **调度器的武装门也不能读 `refreshable`**（`src/index.ts`）：原先是
   `accounts.some(a => a.refreshable)` 才武装定时器 —— 用**可能被误标的字段**
   决定「要不要启动修误标的机制」是循环依赖。本次事故实测 36 条账号只剩
   3 条 `true`（raccoon / minimax / cline 各一），再少三条，
   **codearts 的自愈与启动首轮会一起消失且日志零字**。现改为「池里有账号就武装」；
   各家 `refreshAll` 内部本就按凭据材料 / 是否过期过滤，放宽这里最多多一次本地遍历，
   不会白发请求。⚠️ 仍然**不看 `enabled`**（上一条铁律未变）。

**为什么会被标死：三条续期入口并发消费同一份 `refresh_token`。**

① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」，
   而 DSH 本身会**并发**发多条请求：主回复 + 标题生成 + 上下文压缩）；
③ Jet Hub 账号卡片的「刷新」按钮（`account.refresh`）。
华为 STS 在签发新凭据时**旧的那一份 refresh_token 即失效**，
并发下必然「1 个成功、其余 `invalid_grant`」，而失败方把它读成「账号不能续期」。

⇒ 已加 **per-`credentialRef` 的 `SerialQueue`**（`CodeArtsAuth.refreshQueues`）：
三条入口在同一进程内必然串行，且**锁内重读**凭据 —— 仍在有效期内就直接对账返回，
不再发第二次请求（少烧一次 token）。
⚠️ **该锁只在单进程内有效**：同一台机器上 dsh web 与 desktop 两个实例各自持锁，
跨进程互踩只能靠上面第 2 条兜 —— **两处都得有，少一个就会复发**。
（用户环境实测就是 web + desktop 两个 profile 都装了本插件。）

**可观测性**：真终态时日志带上**服务端原文**（`…；服务端原文：CodeArts token request failed: 400 {…}`），
且同一 ref 同一原因**只告警一次**（`terminalWarned`）—— 真失效时用户要做的是重新登录，
每 30 分钟重复同一行只会把有用信息埋掉。

⚠️ **本条修订「续期不得按 `enabled` 过滤」一节里的说法**：那句
「`refreshAll()` 只按 `refreshable` 过滤」现已不成立 —— `refreshable` **不再是过滤条件**，
而是被对账的字段。「不看 `enabled`」这条**仍然有效**（停用账号照旧要续）。

⚠️ **其余八个 provider 仍有同一个单向门**：buddy / workbuddy / lobsterai / qoder /
qodercn / trae / cline / minimax 的 `refreshAll` 第一行都还是
`if (!entry.refreshable) continue`，而取证时它们的账号**同样**大面积被标 false
（buddy 4/4、lobsterai 4/4、trae 4/4、qoder 5/5、qodercn 3/3、workbuddy 5/5 ——
凭据里 `refresh_token` 全都在）。本次只修了用户报障的 codearts；
推广时**三条规则要一起带**（读凭据对账、判终态前重读、per-ref 串行），
只搬第一条会继续误标。

测试：`tests/unit/service.spec.ts` 的「CodeArtsAuth refreshAll：以凭据为准的自愈」
（7 条：误标后自愈且**只回写一次**、缺材料才标 false、已 false 不重复写盘、
并发重放不误标且用最新凭据对账、真终态照标 false 且不损坏凭据、
单账号失败不中断其余、同一 ref 并发续期只发一次请求）+
`tests/unit/oauth.spec.ts`（`InvalidDPoPHeader` 归可重试、`ExpiredRefreshToken` 仍终态）。
⚠️ 已做**反向验证**：加回 `if (!entry.refreshable) continue` → 自愈用例变红；
队列改 `new SerialQueue({ enabled: false })` → 并发串行用例变红（实测 2 次请求）；
去掉「判终态前重读」→ 并发重放用例变红；把 `InvalidDPoPHeader` 加回终态判据 →
oauth 用例变红。四条各自独立锁死，**别把它们当同义反复删掉**。
⚠️ 已做**反向验证**：去掉 lead 过滤 + 去掉「一致不写盘」→ 7 条变红；
去掉启动首轮 + 去掉 cline 回写 → 3 条变红（含行为用例「刷新后池内
`expiresAt` 指向未来」，非同义反复）。
⚠️ 接线类断言一律用 `(pool|p)` / `[^)]*` 容忍重构与签名扩展 ——
写死整串会让每加一个 provider 或每补一个参数都假失败（该教训已记在
`cline-adapter.spec.ts` 的注释里）。


服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，两个 `QoderAuth` 实例（同一类、不同 `product`）分别注册为 `qoderAuth` 与 `qoderCnAuth`，`TraeAuth` 注册为 `traeAuth`，`ClineAuth` 注册为 `clineAuth`，互不覆盖。

⚠️ 服务名撞车会**在构造时抛** `service "..." has been registered`，故新增同族产品时
**provider id 必须互不相同** —— 这也是 `qodercn` 这个 id 不带连字符的原因
（`qoder-cnAuth` 不符合 camelCase 惯例）。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。
## ⚠️ DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息（消息形状双兼容）

**真实缺陷**（用户报障）：升级到 DSH **0.1.7** 后，带工具调用的会话出现
「**没有工具调用就认为对话结束**而提前停止」或「**模型陷入循环思考**」。

### 根因：`tool-result` 包裹块被删除，工具调用被整体剔除

0.1.7 重构了消息模型：

| | ≤0.1.6 | 0.1.7 |
|---|---|---|
| 工具结果承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **一等 `role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
| `ContentBlockMap` | 含 `'tool-result'` | **删除 `'tool-result'`**，新增 `'tool-addition'`/`'tool-removal'` |
| 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
| `StreamChunk`（插件产出） | — | **逐字节未变** |

⚠️ **`StreamChunk` 没变，所以产出侧（`stream()`）完全不用改** —— 坏的只是
**消费**方向（harness 传给适配器的 `options.messages`）。

各适配器都按 `type === 'tool-result'` 识别工具结果，该判据在 0.1.7 下**恒不命中**：

1. 工具输出被当成普通 user 消息下发，`tool_call_id` 关联丢失；
2. `resolveToolPairing` 的 `allResultIds` 恒为**空集**
   → `usable.every(block => allResultIds.has(...))` 恒 false
   → **assistant 的 `tool_calls` 被整体剔除**。

wire 上于是完全没有工具调用记录，模型看到的是「我说了段话，用户回了段工具输出」。

**实测**（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
修复前保留 **0** 条工具调用，修复后 **512** 条，与 0.1.5 形状对照完全一致。

⚠️ **0.1.7 没有任何协议协商机制**：`packages/llm` 里 `LlmAdapter` / `GenerateOptions`
都没有版本协商字段（搜到的 `protocolVersion` 全属 ACP，与 LLM 适配器无关）。
所以**不能靠协商规避**，必须让代码同时认两种形状。

### 修法：形状归一化层，不改五个序列化实现

新增 **`src/message-shape.ts`**，把 0.1.7 形状**降级**为既有代码已理解的 0.1.5
形状，各入口只插一次调用：

- `normalizeHarnessMessages(messages)` —— 一等 `tool` 消息 → 包回
  `{role:'user', content:[{type:'tool-result',...}]}`；`developer` 消息**丢弃**
  （它只承载工具增删元数据，不是对话内容）；其余原样透传。
- `detectMessageShape(messages)` —— 判据用**形状**而非版本号（沿用
  `settings-compat.ts` 的能力探测先例），且**同时出现两种形态时以 `tool-role` 为准**
  （升级期会话可能混合；判成 legacy 会让新形态结果被漏掉，等于没修）。

⚠️ **`content` 数组必须整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。

⚠️ **`developer` 的剥离与形状探测相互独立**：`detectMessageShape` 只回答「工具
结果长什么样」，而 `developer` 是 0.1.7 专有角色，**无论有没有工具结果都要剥离**。
两者必须分别求值，否则「无工具结果的会话」会把 `developer` 当普通 user 消息下发。

⚠️ **无需改动时返回原数组引用**（`===`），保证 0.1.5 路径**逐字节**不受影响。

落点（6 处）：`sse.ts` 的 `resolveToolPairing`（共享防线，须自身独立正确）、
`llm-adapter.ts` / `openai-compat.ts` / `buddy-adapter.ts` /
`lobsterai-adapter.ts` / `trae-adapter.ts` 的 `serializeMessages`。
`qoder-adapter.ts` 复用 `openai-compat.serializeMessages`，自动受益。

⚠️ **`resolveToolPairing` 的 `content` 参数放宽为可选**（归一化层产出的类型允许
缺 content；函数内部本就按「非数组即视为空」处理）。这是**纯放宽**，不改变行为。

### 回归用例

- `tests/unit/message-shape.spec.ts` —— 探测/归一化/幂等/身份返回/真实字段布局
  （含 `source.callId` 回退：顶层 `toolCallId` 缺失时不能丢 id）。
- `tests/unit/message-shape-adapters.spec.ts` —— **核心不变式**：同一份语义数据按
  两种形状喂入，`serializeMessages` 输出**逐字节等价**。比逐个断言字段更强，
  且对实现方式中立。
- `tests/unit/session-replay.spec.ts` —— **真实会话回放**（离线只读，无网络）。
  自造 fixture 可能在真实数据上失效，故用真实会话锁死。需 `DSH_SESSION_FIXTURE`
  指向导出文件，未设则**干净 skip**（⚠️ 文件必须**惰性读取** —— `describe.skipIf`
  仍会执行回调体收集用例，顶层 `readFileSync(undefined)` 会让整份套件变成
  Failed Suite 而非 skip）。
- `scripts/export-session-messages.mjs` —— 只读导出真实会话消息。
  ⚠️ 必须用 `createSessionFormatCatalogWithChildren([])`（**不是**默认 catalog）：
  V3→V4 迁移要求显式提供子会话事实，无子会话时传**空数组**，否则 `createStage`
  抛 `SessionFormatUnsupportedMigrationError`。

⚠️ **验证「修复有效」必须做反向验证**：临时让 `normalizeHarnessMessages` 恒返回
原数组（= 修复前行为），确认用例**会失败**。否则可能写出一组恒真的同义反复。
## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置
- ⚠️ **改完插件必须重建 `lib/` 并重启 DSH 才生效**：宿主侧代码在 DSH 启动时从
  `lib/index.js` 载入，不热重载（只有 `plugin-src/client/` 的客户端 bundle 有 HMR）。
  **排查「改了没效果」时先看这两个时间**：`lib/index.js` 的 mtime 与 DSH 进程的启动时间 ——
  进程早于产物就说明跑的是旧代码。

#### ⚠️ 「没有任何报错就中断」怎么查

这类现象**无法靠读代码推断**，必须回到会话记录。DSH 把每次请求的**原始 chunk 流**
也记进了 `assistant/message` 事件（`data.stream`），据此可还原真相：

```bash
node scripts/inspect-session.mjs list zed                      # 找会话（工作区关键字）
node scripts/inspect-session.mjs turns <会话文件>               # 每轮结束原因（先定位可疑轮次）
node scripts/inspect-session.mjs brief <会话文件> assistant/message 700
node scripts/inspect-session.mjs stream <会话文件> <seq>        # 该步的原始 chunk 流（关键证据）
```

会话日志位于 `~/.dsh/sessions/<工作区转义名>/<session-id>/session.v3.jsonl.zstd`
（**zstd 压缩的 JSONL**；工作区名把 `\` `/` `:` 换成 `-`，如
`D:\jet\code\rust\zed` → `--D-jet-code-rust-zed--`）。

判据（真实案例，2026-09-23，`qoder`/`qfmodel`）：同轮相邻两步对照 ——

| 步骤 | chunk 流 | finish |
|---|---|---|
| 正常步 | `block-start(text) → text → block-start(tool-call) → tool-call-chunks → block-end×2` | `tool-calls` |
| 中断步 | `block-start(text) → text →`（**无任何 tool-call**）`→ usage → block-end` | `stop` |

即：模型写完「让我检查 X：」后流就结束了。**`turn/end` 是 `completed`**，
UI 上完全看不到错误。

⚠️ 两个可能成因，**不要凭猜认定**：
1. **连接被掐断**（没有 `finish_reason`、也没有 `[DONE]`）→ 已由
   `consumeOpenAiSse` 的 `truncatedStream` 判定改为报 `max-tokens`（可重试）；
2. **模型确实输出了 `finish_reason: stop`** 却没产出工具调用（模型抖动）→
   本层无从强制，但此时**行为可与 (1) 区分**：修复后 (1) 会重试、(2) 仍是 `stop`。
   若重启后再现且仍不重试，说明是 (2)，需换思路（如减少单步工具数量）。

**其它已修的同族缺陷**（都表现为「无报错中断」，改 `openai-compat.ts` 时务必保留）：

- **网关形态错误帧被整帧丢弃**：帧形如
  `{"stackTrace":[...],"message":"...","statusCodeValue":400}` ——
  **既没有 `code` 也没有 `error`、也没有 `choices`**，早期解析器所有条件都不命中。
  现按 `statusCodeValue >= 400` 或带 `stackTrace` 判为错误并抛出。
> ▶ 本节其余内容见 `docs/agent-notes/dev-tasks.md`（按需读）。

## LLM Provider 约定

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**，不能自行构造；请求体加密。积分余额端点另走纯 `Bearer`。
  - `trae`：`Cloud-IDE-JWT <token>` + `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-Machine-Id` / `X-Device-Id` / `X-Ide-Version` 等十余个身份头（**无签名**，**不带** JSON-RPC 包装）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**
- `qoder` 用独立的 `QoderAdapter`（协议不同源，见项目概述）；产品配置是 `src/qoder-product.ts` 的 `QoderProduct`，同样**平行而非继承**。它的 OpenAI 协议层逻辑复用 `src/openai-compat.ts`
- `trae` 用独立的 `TraeAdapter`（协议不同源）；它的产品配置是 `src/trae-product.ts` 的 `TraeProduct`，同样**平行而非继承**。与其它三个 provider 最根本的差异是**载荷与响应都要转换**：请求体经 `transformToSOLOBody` 转成 SOLO 格式，响应经 `parseTraeSSELine` 从 SOLO 自定义 SSE 转成 OpenAI chunk

## ⚠️ 移植既有实现的轮换/重试语义：先抄「类别→动作」表，不是抄循环骨架

**真实事故**（2026-10-06，PR #64 的 raccoon/loomy 轮换）：照 `buddy-adapter.ts`
的**循环骨架**（tried 集合 + `getAvailableAccount(exclude)` + 换号重发）给两家补了
请求级轮换，但**漏抄了 buddy 的分支语义表** —— buddy 只在**限流类**失败写冷却标记，
认证类（401/403）只 `continue` 换号**不写标记**。初版写成「凡可换号就写冷却，
时长 `status===429 ? 1h : 24h`」⇒ 上游网关对全池回 401（`authorization_verify_error`）时，
**一个请求内 6 个号各被封 24h，整个 provider 死一天**（症状
`no usable credential; log in first`）。

**审查侧规则**（给 code-review 与自审）：看到「对齐/移植/参照既有实现」的 PR，先要
那张**类别→动作**表，再逐格对照源实现 —— 骨架长得像不代表语义抄全了：

| 问 | 为什么 |
|---|---|
| 源实现把失败分几类？判据是什么？ | 分类是语义的载体（quota/rate/auth/other 各自动作不同） |
| 每类**换不换**下一个候选？ | 换号无益的类别（400 参数错）不该换 |
| 每类**写不写**状态标记（冷却/黑名单）？ | 认证类写冷却＝把网关故障放大成全池不可用（本次事故格） |
| 每类**抛什么错误码**？ | 401 报成 `QUOTA_EXCEEDED` 会误导排障与重试策略 |
| 候选耗尽时报什么？带不带最后一次的真实原因？ | 笼统报错丢服务端原文（buddy 上同款教训） |

新实现必须配**逐格回归测试**（每格一条，先红后绿）；漏抄的那格就是将来的事故。

### ⚠️ 同族判据必须**逐格同构**，改一侧就要改另一侧（2026-10-06 同型复发）

`classifyRaccoonFailure` 与 `classifyLoomyFailure` 是**同一张判据表的两个实现**。
raccoon 在 `7b524ff` 收窄后 loomy **未同步**，于是同一报文在两个 provider 上被判成
**不同类别**，且危险方向恒定朝 loomy（多写冷却）—— 实测四例：

| 报文 | loomy（未同步时） | raccoon（已修） |
|---|---|---|
| `403 + insufficient permissions to access this resource` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `403 + 积分不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `401 + 余额不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `400 + context window is insufficient for this model` | `quota` ⇒ **写 24h** | `other` ⇒ 不换号 |

前两行与上面的「全池被封」是**同一事故形态**，只换了触发词。两条不变式：

1. **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时（网关侧故障常在报文里
   捎带余额提示）**以状态码为准**；
2. `insufficient` 单独出现**过宽**，必须与邻近的「钱」义词
   （`point` / `credit` / `balance` / `quota` / `token`）**共现**才算额度。
   方向是**宁可漏判不可误伤**：漏判只是不换号，误判会封可用账号 24h。

⚠️ **两侧各写一份用例挡不住复发**（单方面"改严"时两边各自的用例都能过）。
`tests/unit/loomy-adapter.spec.ts` 的「与 raccoon 对拍」段把**同一批真实报文
喂两个分类器、断言逐条同结论**，分叉即红 —— 这是防复发的真正闸门。

