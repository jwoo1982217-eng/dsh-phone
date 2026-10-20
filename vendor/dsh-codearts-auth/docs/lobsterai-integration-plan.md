# LobsterAI 接入方案（feat/lobsterai）

> 目标：把有道 LobsterAI 作为第四个 LLM provider 接入本插件（`dsh-codearts-auth`），
> 复用现有的账号池、Jet Hub 设置页、限流切换、模型黑名单等全部能力。
>
> 参考实现：`E:\Workplace\APP\dsh-plugin\lobsterai2api`（Go，反向桥接服务）
> 签到参考：`E:\Workplace\APP\dsh-plugin\lobsterai2api\sigin.py`
>
> 分析基线：本插件 `feat/lobsterai` 分支（起点 `fff95bb`）。

---

## 0. 结论速览

### 0.1 先把问题回答掉

前期调研提了 4 个问题，**全部能从 `lobsterai2api` 仓库里得到答案**：

| # | 问题 | 答案 | 证据 |
|---|------|------|------|
| 1 | 官方登录接口是什么？ | 本地回调服务器模式：`{portal}/portal#/login?source=electron&redirect_uri=http://127.0.0.1:{port}/auth/callback&state={state}`，回调 `?code=X&state=Y`，再 `POST {base}/api/auth/exchange` 换 token | `cmd/login/main.go:160-244,263-354`；**portal 实测见 §0.2b** |
| 2 | 签到接口与签名方式？ | **无签名**，纯 Bearer。三步：`GET /api/client-activities/slot` → `GET /api/client-activities/{code}/context` → `POST /api/client-activities/{code}/actions/check_in` | `sigin.py:51-67` |
| 3 | 聊天接口是否 OpenAI 兼容？ | **是**，但**只支持 SSE**：`POST {base}/api/proxy/v1/chat/completions`，`stream:false` 上游返回 500，桥接层强制改写 `stream=true` | `internal/upstream/client.go:168-195`、README:100-103 |
| 4 | 官方接口列表在哪？ | 没有公开文档，全部在源码里（§4 已完整整理） | 全仓库 |

> 注：问题 1 里的 portal URL 本该走 `login.sh` 那条路得到 —— 而正如 §0.2-2 所述，
> **那条路当前是断的**，所以 portal 只能靠域名推导 + 实测确认（§0.2b）。

### 0.2 五个「意外发现」

1. **签到端点其实已经找到了**，只是没被 git 跟踪。
   `internal/upstream/client.go:315-321` 的 `DailyCheckin` 是 no-op，README:102 也写着
   "Daily checkin endpoint not yet identified"。但同目录的 `sigin.py`（`git status` 显示
   为未跟踪文件 `?? sigin.py`）**完整实现了签到**。Go 侧与 Python 脚本之间没有同步。
   → 本方案以 **`sigin.py` 为签到逻辑的权威来源**。

2. **`login.sh` 依赖的两个关键 env 从未被任何脚本设置** —— 这条路当前**根本跑不通**。
   `cmd/login/main.go:41-56` 的 `serverBase()` / `loginPortalURL()`
   **只读 env、没有编译期默认值**，读不到就 `fatal("... env not set")` 退出：

   ```go
   func loginPortalURL() string {
       if v := os.Getenv("LB2A_LOGIN_PORTAL"); v != "" { return v }
       fatal("LB2A_LOGIN_PORTAL env not set — cannot determine login portal URL")
       return ""
   }
   ```

   而 `login.sh` **只设了一个变量**（第 17 行 `PORT="${LB2A_LISTEN:-8367}"`）。
   全仓库 grep `LB2A_UPSTREAM_BASE` / `LB2A_LOGIN_PORTAL`，在
   `login.sh` / `credit.sh` / `sigin.py` 里**零命中**。
   且 `cmd/login` **不读 `config.json`**（该文件里没有 `flag` / 配置加载，
   只有 `os.Getenv`），仓库里也不存在 `config.json`（已 gitignore）。
   → **`./login.sh` 在当前仓库状态下必然在 `login.exe url` 一步 fatal 退出。**

3. **脱敏 commit 自己引入了两处不一致**。commit `fe299f1` 声称
   "Replace all hardcoded upstream server URLs with env-driven config"，但：

   | 问题 | 详情 |
   |---|---|
   | `config.example.json` 的 `upstream.base_url` **是死配置** | 该 commit 给它加了 `"base_url": ""`，但 `cmd/server/config.go:32-34` 的 `Upstream` struct **只有 `TimeoutSeconds` 字段**，没有 `BaseUrl`。JSON 里那一项被静默丢弃，`ServerBase()` 仍然只认 env |
   | **漏改 `login.sh`** | 它恰恰是最需要这两个 env 的入口之一（`credit.sh` 同样不设 `LB2A_UPSTREAM_BASE`） |

   → 这不是「设计如此」，是**脱敏重构没做完**。

4. **登录 portal 的 URL 已经确定**（详见 §0.2b）。
   `https://lobsterai.youdao.com/portal` 实测 HTTP 200，页面标题
   「LobsterAI - 全场景个人助理 Agent」，与 `main.go:226` 拼出的
   `{portal}/portal#/login?...` 路径完全吻合。

5. **`clientVersion` 实测是 `2026.9.4`**，不是 Go 里写死的 `0.1.0`。
   直接请求 `sigin.py:11` 的更新接口实测返回
   `{"data":{"value":{"version":"2026.9.4","date":"2026-9-4",...}}}`，
   且能拿到 Windows/macOS 安装包地址（`LobsterAI-Setup-x64-2026.9.4-official.exe`）。
   → 印证了 §3.1-A 提到的「Go 侧硬编码 `0.1.0` vs `sigin.py` 动态取值」这个不一致：
   **`0.1.0` 是假值**，真实版本是 `2026.9.4` 这种日期式版本号。

### 0.2b 附：登录 portal URL 的确定过程

`lobsterai2api` 把两个域名都 env 化了，唯一线索是 `sigin.py:10` 的
`BASE = "https://lobsterai-server.youdao.com"`（API 基址）。portal 需要从 API 域名推。

DNS 解析实测：

```
lobsterai.youdao.com         -> 220.197.31.38  (CNAME pub-g1-gz.alb.ntes53.netease.com)
lobsterai-server.youdao.com  -> 220.197.31.38  (CNAME pub-g1-gz.alb.ntes53.netease.com)
```

**两个域名同一 IP、同一 CNAME 目标**（网易广州区域的 ALB），说明是同一套服务、
同一张证书、同一条路由 —— portal 与 API 只是**同域不同路径**。

访问验证：

| URL | 结果 |
|---|---|
| `https://lobsterai.youdao.com/portal` | **HTTP 200**，标题「LobsterAI - 全场景个人助理 Agent」 |
| `https://lobsterai.youdao.com/` | 连接不通（根路径未暴露） |
| `https://lobsterai-server.youdao.com/` | 连接不通（根路径未暴露） |
| `https://lobsterai-server.youdao.com/api/models/available` | 连接不通（**无 Bearer token 时**被拒，符合预期） |

`main.go:226-228` 的拼接逻辑是：

```go
loginURL := fmt.Sprintf("%s/portal#/login?source=electron&redirect_uri=%s&state=%s",
    loginPortalURL(), urlQueryEscape(redirectURI), state)
```

代入 `LB2A_LOGIN_PORTAL = https://lobsterai.youdao.com` 得到：

```
https://lobsterai.youdao.com/portal#/login?source=electron
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback
  &state={state}
```

与实测 200 的 `https://lobsterai.youdao.com/portal` 是同一个 SPA 的 hash 路由。

> **结论**：`LobsteraiProduct.portalBase = 'https://lobsterai.youdao.com'`、
> `apiBase = 'https://lobsterai-server.youdao.com'`。
> 两者虽同 IP，但**建议保持两个独立字段** —— Go 侧本就是两个 env，
> 且 API 域名已被 `sigin.py` 独立验证过，不排除未来分离部署。

> ⚠️ **仍待人工确认**（§7.1 R1 降级为「已定位，待端到端验证」）：portal 的
> `#/login` hash 路由**需要真实浏览器点击登录才能验证完整闭环**。
> 静态探测只能确认页面存在与路径形态，不能确认：
> `source=electron` 是否被接受、`redirect_uri` 是否被校验为必须
> `http://127.0.0.1:{port}/auth/callback`、微信/手机号登录后是否真的带
> `code` 跳回。这一步需要 T2 的真实 E2E。

### 0.3 核心判断：不需要跑那个反代

`lobsterai2api` 的定位是**给任意 OpenAI SDK 客户端用的独立 HTTP 服务** —— 所以它必须
自己实现一层 `/v1/chat/completions`（`internal/server/handler.go`）。

而本插件运行在 DSH 宿主进程内，`ctx.llm.registerAdapter()` **已经就是那一层**。
`BuddyAdapter` 直接对 `https://copilot.tencent.com/v2/chat/completions` 发请求，
背后并没有任何反代进程。

所以推荐做法是：**把 `lobsterai2api` 的 Go 代码当作协议说明书，翻译成本插件的
TypeScript 适配器**，而不是把 Go 二进制作为前置依赖跑起来。

收益：
- 少一个进程、少一个端口、少一份配置（`config.json` / `auths/` 目录 / `state.json`）；
- 账号池与 Jet Hub 复用现成实现，不出现「两套账号池各管一半」；
- 凭据进 `ctx.credentials`（走 DSH 的凭据服务），而不是散落在 `auths/*.json`；
- 签到不再依赖 `python3`（`sigin.py`）与 shell（`login.sh`/`credit.sh`）；
- Windows 上 `login.sh` 本来就跑不了（bash + `docker ps` + `python3`）。

### 0.4 一个必须澄清的边界

**不要**把 LobsterAI 硬塞进 `BuddyProduct`。`src/product.ts:67-137` 的 `BuddyProduct`
是**围绕 CodeBuddy 系协议**设计的，里面这些字段对 LobsterAI 毫无意义：

- `productCode`（`X-Product-Code` 头）、`attributionName`、`clientVersion`、`cliVersion`
  —— LobsterAI 不带这套归属头，只带 `X-LobsterAI-Client-*`；
- `appendSessionParams` / `pluginVersion` —— 那是 WorkBuddy 登录 URL 的后缀参数；
- `apiDomain`（`X-Domain` 头）—— LobsterAI 没有这个头；
- `userAgentByModelFamily` —— 腾讯后台的 UA 归因机制，LobsterAI 无此概念；
- `fallbackModels` 的字段结构（`reasoningEfforts` 等）—— 可复用但语义不同。

而且 `id` 的类型是字面量联合 `'buddy' | 'workbuddy'`，加第三个值会牵动
`productById`、`registerBuddyLlm`、`reconcileWithFallback` 等一串调用点。

**正确做法**：新增独立的 `src/lobsterai-product.ts`（仿 `product.ts` 的**模式**），
与 `BuddyProduct` 平行。共用的是**架构模式**，不是那个类型。

---

## 1. 两个项目的定位差异

| 维度 | `lobsterai2api`（Go） | `dsh-codearts-auth`（本插件，TS） |
|------|----------------------|--------------------------------|
| 形态 | 独立 HTTP 服务，监听 `:8367` | DSH 宿主内插件，进程内 `ctx` 服务 |
| 对外协议 | 自己实现 OpenAI 兼容 `/v1/chat/completions` | 由 `ctx.llm` 承担，插件只注册 Adapter |
| 凭据存储 | 文件系统 `auths/lobsterai-{uid}.json` | `ctx.credentials`（ref 索引）+ `ctx.settings`（账号索引） |
| 多账号 | 自建 `internal/pool`，按积分选号 | `src/account-pool.ts`，按限流重置时间选号 |
| 登录 | 独立 `login.exe url` / `login.exe poll` 两个子命令 + 状态文件 | `src/login.ts` 进程内本地回调服务器 |
| 配置 | `config.json` + `LB2A_*` env | DSH profile layer + `ctx.settings` |
| 定时任务 | `internal/scheduler`（签到 9/21 点、keepalive 22 点） | `src/index.ts` 的 30 分钟 `refreshAll` |
| 使用者 | 任意 OpenAI SDK | DSH（本插件自己的 provider 路由） |
| 语言/依赖 | Go 1.22，零外部依赖 | TypeScript，`jose`（CodeArts DPoP 用） |

**一句话**：Go 项目是「协议 + 账号池 + HTTP 门面」三合一；本插件把「HTTP 门面」交给
DSH，「账号池」已有现成的，只需要补**协议**这一块。

---

## 2. 模块对照总表

| `lobsterai2api` 模块 | 职责 | 本插件对应物 | 处置 |
|---|---|---|---|
| `cmd/login/main.go` | OAuth 登录 + 本地回调 | `src/login.ts`（CodeArts 本地回调） | **新建** `src/lobsterai-oauth.ts` |
| `internal/auth/auth.go` | 凭据解析 / 原子写回 | `ctx.credentials` + `src/types.ts` | **新建** 凭据类型，存储改用 `ctx.credentials` |
| `internal/upstream/client.go` | 全部上游 HTTP 调用 | `src/buddy-oauth.ts` + `src/buddy-adapter.ts` | **新建** `src/lobsterai.ts` + `src/lobsterai-auth.ts` |
| `internal/upstream/classify.go` | 错误分类（驱动冷却） | `src/llm-adapter.ts:isRateLimited` | **新建** `src/lobsterai-errors.ts` |
| `internal/upstream/sse.go` | SSE 聚合 / 透传 | `src/sse.ts` + `BuddyAdapter.consumeSse` | **复用** `src/sse.ts` 工具函数 |
| `internal/pool/pool.go` | 账号池 + 冷却状态机 | `src/account-pool.ts` | **复用**（选号策略差异见 §3.7） |
| `internal/scheduler/scheduler.go` | 定时签到 / keepalive | `src/index.ts` 定时器 | **扩展** |
| `internal/server/handler.go` | OpenAI 门面 + 模型表 | `ctx.llm` + `product.fallbackModels` | **不需要** |
| `cmd/credit/main.go` | 积分查询 CLI | `src/credits.ts` + `credits.balances` RPC | **新建** `src/lobsterai-credits.ts` |
| `sigin.py` | 每日签到 | `src/credits.ts`（CodeBuddy 版） | **新建** `src/lobsterai-credits.ts` |
| `config.example.json` | 冷却时长等配置 | 硬编码常量（跟随 buddy 风格） | 常量 |
| `login.sh` / `credit.sh` | 驱动脚本（编译 + 人在环 + docker 重启） | 不需要（见 §3.2 逐行拆解） | **不需要** |

---

## 3. 逐模块详解

每个模块统一按三段展开：
**A. lobsterai2api 怎么做的** → **B. 当前项目对应模块怎么做的** → **C. 推荐做法**。

---

### 3.1 产品配置（Product Config）

#### A. lobsterai2api 怎么做的

**没有**产品配置层。所有常量散落在各文件顶部：

```go
// internal/upstream/client.go:19-22
const (
    clientVersion = "0.1.0"
    clientUA      = "LobsterAI/0.1.0"
)
```

上游基址走 env（`ServerBase()`，`client.go:26-31`），没有编译期默认值。
`cmd/server/config.go` 只管运行时参数（监听地址、冷却时长、调度小时），与产品身份无关。

> 这里有**两处已知不一致**：
>
> 1. **地址来源**：`sigin.py:10` 硬编码了真实 API 域名，Go 侧却只有 env
>    （且 `config.example.json` 里那个 `upstream.base_url` 是死配置，见 §0.2-3）。
>    `sigin.py` 是整个仓库里唯一保留了真实域名的文件。
>
> 2. **`clientVersion` 取值**：`client.go:20` 硬编码 `clientVersion = "0.1.0"`，
>    而 `sigin.py:21-29` 会去 `api-overmind.youdao.com` 动态查真实版本号。
>    **实测（见 §0.2-5）真实版本是 `2026.9.4`（日期式版本号），`0.1.0` 是假值。**
>    这意味着 Go 侧的 `X-LobsterAI-Client-Version` 头与 refresh 请求体里的
>    `version` 字段**一直在发错误的值**，只是后端未强校验（否则早该失败）。
>    → 本插件必须**动态拉取**，不能用 `0.1.0`。

#### B. 当前项目怎么做的

`src/product.ts` 是**单一真相源**，`BuddyProduct` 接口（67-137 行）承载一个 CodeBuddy
系产品的全部差异：`endpoint` / `apiDomain` / `platform` / `productCode` / `userAgent`
/ `userAgentByModelFamily` / `attributionName` / `clientVersion` / `cliVersion` /
`defaultCredentialRef` / `fallbackModels` / `appendSessionParams` / `pluginVersion`。

```ts
// src/product.ts:202-218
export const CODEBUDDY: BuddyProduct = {
  id: 'buddy',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  displayName: 'CodeBuddy (腾讯)',
  productCode: 'codebuddy',
  userAgent: 'CodeBuddyIDE/1.106.1',
  // ...
  fallbackModels: CODEBUDDY_FALLBACK_MODELS,
}
```

配套工具函数：
- `productById(id)`（327-329）—— 按 id 查配置；
- `ALL_PRODUCTS`（324）—— 遍历注册用；
- `resolveUserAgent(product, model)`（341-346）—— 按模型族分档选 UA。

消费点（全部靠 `product` 驱动，不写死）：
- `BuddyAuth` 构造时 `super(ctx, `${product.id}Auth`)`（`buddy-auth.ts:126`）
  → 服务名随产品派生，两个实例互不覆盖；
- `registerBuddyLlm` 用 `product.id` / `displayName` / `llm-${product.id}` 注册路由
  （`buddy-adapter.ts:1119-1124`）；
- `BuddyAdapter` 用 `product.endpoint` 拼 URL、`product.userAgent` 设头
  （`buddy-adapter.ts:859`）。

#### C. 推荐做法

**新建 `src/lobsterai-product.ts`**，定义独立的 `LobsteraiProduct`。

```ts
export interface LobsteraiProduct {
  id: 'lobsterai'
  /** 展示名（Jet Hub 面板标题 / 模型设置页） */
  displayName: string
  /** 登录 portal 基址（实测 https://lobsterai.youdao.com，见 §0.2b） */
  portalBase: string
  /** 上游 API 基址（sigin.py:10 实测 https://lobsterai-server.youdao.com） */
  apiBase: string
  /** 客户端版本号查询端点（sigin.py:11） */
  clientVersionApi: string
  /** 无法动态取版本号时的兜底版本（实测真值形态如 '2026.9.4'） */
  fallbackClientVersion: string
  /** User-Agent（client.go:21 实测 LobsterAI/0.1.0） */
  userAgent: string
  /** X-LobsterAI-Client-Capabilities（client.go:99 实测 kimi-k3-agentic-v1） */
  clientCapabilities: string
  /** 默认凭据 ref（单账号回退） */
  defaultCredentialRef: string
  /** 兜底模型目录（handler.go:94-114 实测 19 个） */
  fallbackModels: readonly LobsteraiFallbackModel[]
}
```

**关键差异点（必须与 `BuddyProduct` 分开）**：

| 项 | 理由 |
|---|---|
| 无 `apiDomain` | LobsterAI 不发 `X-Domain` 头 |
| 无 `productCode` / `attributionName` | 不发 `X-Product` / `X-Product-Code` / `X-IDE-*` |
| 无 `userAgentByModelFamily` | 单一 UA，无按模型分档需求 |
| 无 `appendSessionParams` | 登录 URL 参数形态完全不同 |
| 有 `portalBase` + `apiBase` | LobsterAI 的**登录门户与 API 服务器是两个不同域名**（腾讯系是同一个 `endpoint`） |
| 有 `clientVersionApi` | 版本号是**运行时从第三方接口拉取**的，不是编译期常量 |

> ⚠️ **注意 `userAgent` 与 `clientVersion` 是两回事**：`clientUA = "LobsterAI/0.1.0"`
> 里的 `0.1.0` 是 UA 字符串的一部分，而 Go 里另有一个 `clientVersion = "0.1.0"`
> 被塞进 `X-LobsterAI-Client-Version` 头。实测真实版本是 `2026.9.4`，
> 两者在 Go 里**数值恰好相同但语义无关**。是否该把 UA 也改成
> `LobsterAI/2026.9.4` **需要实测确认**（见 §7.2 R13）。

---

### 3.2 登录（Login）

#### A. lobsterai2api 怎么做的

**本地回调服务器 + 授权码换 token**，由两个子命令 + 一个状态文件串联
（`cmd/login/main.go`，`login.sh` 顺序驱动）。

```
┌─ login.exe url ────────────────────────────────────────────┐
│ 1. 绑定 127.0.0.1:0（随机端口）                            │
│ 2. 生成 state = randomHex(16)、uuid = UUID4、              │
│    firstKeyfrom = 当前毫秒时间戳                            │
│ 3. 打印登录 URL：                                          │
│    {portal}/portal#/login?source=electron                  │
│      &redirect_uri=http://127.0.0.1:{port}/auth/callback   │
│      &state={state}                                        │
│ 4. 状态落盘 /tmp/lb2api-login-state.json（含 port/state/   │
│    uuid/firstKeyfrom）—— 供 poll 子命令读取                 │
│ 5. 轮询 .result 文件出现（或 10 分钟超时）                  │
└────────────────────────────────────────────────────────────┘
                     ↓ 用户在浏览器完成登录（手机号/微信）
┌─ 回调 /auth/callback?code=X&state=Y ───────────────────────┐
│ 1. 校验 state 一致（不一致返回 400）                        │
│ 2. 立即在该进程内完成 exchange                              │
│ 3. 结果写 /tmp/lb2api-login-state.json.result              │
│ 4. 返回"登录成功，可以关闭此窗口了"                          │
└────────────────────────────────────────────────────────────┘
┌─ login.exe poll ───────────────────────────────────────────┐
│ 读 .result → 打印 JSON → 清理状态文件                       │
└────────────────────────────────────────────────────────────┘
```

`exchange` 的关键细节（`main.go:263-354`）：

```go
body := map[string]any{
    "authCode":      code,
    "firstKeyfrom":  ls.FirstKeyfrom,   // 毫秒时间戳字符串
    "latestKeyfrom": nowMillis(),
    "uuid":          ls.Uuid,
    "version":       "0.1.0",
}
POST {serverBase}/api/auth/exchange
→ { code:0, data:{ accessToken, refreshToken, expiresIn,
                    user:{ id, yid, userId, nickname }, quota } }
```

- `uid` 回退链：`user.id` → `user.userId` → `user.yid` → `sha256(accessToken)[:16]`
  （`main.go:297-306`）；
- `expiresAt` 优先用 `expiresIn` 换算，缺失时解 JWT 的 `exp`（`jwtExpiry`，
  `main.go:102-119`）—— 注释说明「实测 HS512 access token 30 天」；
- 落盘 `auths/lobsterai-{uid}.json`，**嵌套形** `{auth:{...},account:{...}}`。

> **两个进程通过 `/tmp` 文件通信**是这套设计最脆弱的地方：`runUrl` 必须在
> 用户按 `y` 之前就一直活着（`login.sh:44` 那个 `read -rp`），而且明确写了
> 要清理上一轮残留（`main.go:162-164`），否则旧 `.result` 会让等待循环立刻误判完成。

**`login.sh` 是这套流程的编排层**（89 行），逐段拆解：

| 行 | 做什么 | 备注 |
|---|---|---|
| 12 | `set -euo pipefail` | 任一命令失败即退出 |
| 14 | `cd "$(dirname "$0")"` | 切到脚本目录（因为要读 `./auths`） |
| 15-17 | `AUTH_DIR="./auths"`、`CONTAINER="lobsterai2api"`、`PORT="${LB2A_LISTEN:-8367}"` | **全文唯一一处读 env，且只读 `LB2A_LISTEN`** |
| 22-26 | `LOGIN_BIN="./login"`，不存在才 `go build -o login ./cmd/login` | **按文件存在性决定是否编译** —— 源码改了不会自动重编（注释里明说了「源码改动后手动 go build」） |
| 33-36 | `AUTH_URL=$("$LOGIN_BIN" url)` | 这一步就依赖 `LB2A_LOGIN_PORTAL`，**未设则 fatal** |
| 38-42 | 打印 URL 让用户去浏览器打开 | 真正的登录动作在浏览器里（手机号/微信） |
| 44-48 | `read -rp "完成登录后按 y 继续"` | **人在环的关键点**：阻塞等待用户确认 |
| 53-59 | `RESULT=$("$LOGIN_BIN" poll)` | 读 `.result` 文件取结果 |
| 61-68 | 用 **`python3`** 解析 JSON 取 `uid`/`nickname`/`auth_file` | **引入 Python 依赖**（只为读三个 json 字段） |
| 74-82 | `docker ps` 判断容器在不在，在则 `docker restart` 并 curl `/status` 数账号 | **引入 Docker 依赖**，且重启是「加载新账号」的唯一手段 |
| 85-89 | 打印 UID / Nickname | 收尾 |

**这套编排在本方案里全部不需要**，逐条对应：

| `login.sh` 依赖 | 本插件等价物 | 是否还需要 |
|---|---|---|
| `go build` 编译 login.exe | 无（TS 直接由 `tsc` 编译） | ❌ |
| `/tmp/lb2api-login-state.json`（跨进程状态） | 进程内 `Promise`（`src/login.ts:165-168` 的 `result`） | ❌ |
| `python3` 解析 JSON | JS 原生 `JSON.parse` | ❌ |
| `docker restart` 加载账号 | `ctx.credentials.set()` 即时生效，账号池读的是进程内副本 | ❌ |
| `read -rp` 人工确认「按 y」 | Jet Hub 弹窗轮询 `login.poll`（`jet-hub-rpc.ts:478-488`） | ❌ |
| `LB2A_LOGIN_PORTAL` / `LB2A_UPSTREAM_BASE` env | 写进 `LobsteraiProduct` 常量（§3.1-C） | ❌ |

→ 这正是 §0.3「不需要跑那个反代」在**具体依赖**层面的体现：
`login.sh` 的 89 行里有 40 行左右是在处理「两个进程 + 两个容器 + 两种语言」
带来的协调成本，而这在本插件里**根本不存在**。

> ⚠️ **但 `login.sh` 有一个不可替代的价值**：它是**当前唯一能产出真实
> `auths/lobsterai-*.json` 样本**的路径（`login.exe` 拿不到 portal 就起不来，
> `sigin.py` 只消费不生产）。在做 T2 时，先给它补上两个 env 跑一次，
> 就能拿到权威的字段形态 —— 见 §7.1b R10 与 §7.1 R1。

**关于 `credit.sh`**（15 行）：只是 `go build -o credit ./cmd/credit` 后
`./credit -pretty` 的包装。它读 `LB2A_AUTH_DIR`（`cmd/credit/main.go:106-108`）
但**同样不设 `LB2A_UPSTREAM_BASE`** —— 与 `login.sh` 是同一类遗留问题。

#### B. 当前项目怎么做的

本插件有**两套**登录，模式不同：

**① CodeArts —— 本地回调服务器（与 lobsterai 最接近）**
`src/login.ts:274-334` `startOAuthCallbackServer`：

```ts
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', ...)
  if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
    response.writeHead(404).end('Not found'); return
  }
  // ... 处理 code → exchangeAuthorizationCode → resolveResult
})
return listenOnCallbackPort(server).then((port) => ({ port, server, result }))
```

特点：
- **进程内** `Promise` 收结果（`result: Promise<LoginFlowResult>`），**不落状态文件**；
- PKCE（`generatePkcePair`）+ DPoP（`generateDpopKeyPair`）；
- 端口有下限要求（`MIN_CALLBACK_PORT = 10_000`，`login.ts:339,342-364`）；
- 回调后 307 重定向到 portal 结果页（`buildPortalLoginResultUrl`）；
- 总超时 180 秒（`OAUTH_CALLBACK_TIMEOUT_MS`，`login.ts:337`）。

**② CodeBuddy 系 —— 轮询式（无本地服务器）**
`src/buddy-oauth.ts:468-508` `runBuddyLoginFlow`：
`fetchAuthState` → 打开浏览器 → `loopGetToken`（1 秒间隔轮询）→ `getAccount`。

**Jet Hub 的两步式封装**（`src/jet-hub-rpc.ts:376-438` `account.create`）：
- 第一步：同步取 `state` + `loginUrl` 返回给前端弹窗；
- 第二步：用**同一个 state** 后台异步跑完 `runBuddyLoginFlow`，
  成功写 `ctx.credentials`、失败则删除占位账号。

#### C. 推荐做法

新建 `src/lobsterai-oauth.ts`，**以 CodeArts 的本地回调模式为骨架**
（而非 lobsterai2api 的双进程 + `/tmp` 文件模式）：

```ts
export interface LobsteraiLoginFlowOptions {
  fetcher?: typeof fetch
  openBrowser?: OpenBrowser
  timeoutMs?: number          // 默认 10 分钟（对齐 main.go:36 callbackTimeout）
  signal?: AbortSignal
}

export interface LobsteraiLoginFlowResult {
  access: string              // JSON.stringify(LobsteraiCredential)
  expires: number             // 毫秒时间戳
  loginUrl: string
  refreshable: boolean
}
```

关键实现点：

1. **用 `crypto.randomUUID()` 生成 state**（对齐 `main.go:165` `randomHex(16)` 的随机性意图），
   `uuid` 用 `crypto.randomUUID()`（对齐 `newUuid`），
   `firstKeyfrom` 用 `String(Date.now())`（对齐 `nowMillis`）。

2. **回调路径 `/auth/callback`**（对齐 `main.go:35` `callbackPath`），
   监听 `127.0.0.1:0`（随机端口即可，**无** CodeArts 那样的 ≥10000 限制）。

3. **state 校验**：`gotState !== state` 时返回 400（对齐 `main.go:184-189`）。

4. **进程内完成 exchange**（不需要 `/tmp/.result` 中转）：
   回调处理里直接 `await exchange(code)`，然后 `resolveResult(...)`。

5. **exchange 必须带全部 5 个字段**：`authCode` / `firstKeyfrom` /
   `latestKeyfrom` / `uuid` / `version`。缺 `firstKeyfrom`/`uuid` 会不会失败未实测，
   但**原实现是必带的，照抄**。其中 `version` 用**动态拉取的真值**（§0.2-5）。

6. **uid 回退链**必须照抄四级（`id → userId → yid → sha256 前 16 位`），
   否则不同账号形态下可能拿到空 uid，账号池会重名。

7. **响应信封**：`{code, msg, data}`，`code !== 0` 或 `data` 非对象即失败
   （对齐 `main.go:147-149` 与 `sigin.py:44-48` 的双重校验）。

8. **Jet Hub 集成**：LobsterAI 走**同步**执行（像 CodeArts 那样）：

   ```ts
   } else if (provider === 'lobsterai') {
     const loginResult = await lobsterai.login({ refName, accountId: id, pool })
     return { ok: true, value: { accountId: id, loginUrl: loginResult.loginUrl } }
   }
   ```

   缺点：前端要等用户完成登录（CodeArts 现在就是这样，`jet-hub-rpc.ts:430-434`）。
   照它做，改动最小、语义最直白。

---

### 3.3 凭据存储与解析（Credential）

#### A. lobsterai2api 怎么做的

`internal/auth/auth.go` 定义一个归一化的 `Auth` 结构（15-26 行）：

```go
type Auth struct {
    AccessToken   string
    RefreshToken  string
    ExpiresAt     int64  // Unix 秒
    UID           string // 用户唯一 ID
    UserId        string // 有道 yid
    Nickname      string
    Uuid          string // 安装 UUID（exchange/refresh 用）
    FirstKeyfrom  string // 首次登录时间戳
    LatestKeyfrom string // 最近活动时间戳
    FilePath      string // 来源文件；refresh 后原子写回此处
}
```

三个设计点值得注意：

1. **兼容两种磁盘形态**（`Parse`，56-126 行）：
   嵌套形 `{auth:{...},account:{...}}`（登录工具输出）与
   扁平形 `{accessToken,uid,...}`（手建）。靠探测 `probe["auth"]` 是否存在来分流。

2. **`NeedsRefresh(within)`**（29-34 行）：`ExpiresAt <= 0` 时**返回 true**（视为需刷新）——
   没有过期时间就当过期处理。

3. **`KeyfromBody()`**（37-50 行）：refresh/exchange 共用的身份载荷：

```go
body := map[string]any{
    "firstKeyfrom":  a.FirstKeyfrom,
    "latestKeyfrom": a.LatestKeyfrom,
    "version":       "0.1.0",
}
if a.Uuid != ""   { body["uuid"]   = a.Uuid }
if a.UserId != "" { body["userId"] = a.UserId }
```

   注意 `userId` 会被带上（换 token 时不带），所以 refresh 请求体是
   「keyfrom body + refreshToken」。

4. **`SaveAtomic()`**（129-157 行）：写 `.tmp` 再 `os.Rename`，权限 `0o600`。

#### B. 当前项目怎么做的

凭据**不落文件**，走 `ctx.credentials`：

```ts
// src/service.ts:104
await this.ctx.credentials.set(ref, flow.access)   // flow.access 是 JSON 字符串

// src/buddy-auth.ts:198-199
const ref = credentialRef(this.credentialRefName)
const info = await this.ctx.credentials.describe(ref)
```

- **ref 命名**：单账号用固定名（`CODEARTS_ACCESS_TOKEN` / `BUDDY_ACCESS_TOKEN` /
  `WORKBUDDY_ACCESS_TOKEN`）；多账号用 `{PROVIDER}_ACCOUNT_{UUID_SHORT}`
  （`jet-hub-rpc.ts:380-381`）。
- **值**：JSON 字符串。
- **解析**：每个 auth 模块自带一个 `parseCredential()`（`buddy-auth.ts:75-84`），
  失败返回 `undefined` 而不是抛错。
- **过期判定**：集中在 `src/buddy.ts:150-178`（`credentialExpiresAtMs` 兼容
  毫秒/秒级时间戳与 ISO 字符串，缺失时回退解 JWT `exp`）。

#### C. 推荐做法

**新建 `src/lobsterai.ts`**（放常量 + 纯函数）与凭据类型：

```ts
export interface LobsteraiCredential {
  access_token: string
  refresh_token: string
  /** 过期时间：统一存毫秒时间戳字符串（复用 credentialExpiresAtMs 风格工具） */
  expires_at?: string
  /** 用户唯一 ID（账号池 dedupe 用） */
  uid?: string
  /** 有道 yid */
  user_id?: string
  nickname?: string
  /** 安装 UUID —— refresh/exchange 必带，丢失会导致续期失败 */
  uuid?: string
  /** 首次登录时间戳 —— refresh 必带 */
  first_keyfrom?: string
  /** 最近活动时间戳 —— refresh 必带，每次刷新后更新 */
  latest_keyfrom?: string
}
```

**必须遵循 `BuddyCredential` 的命名风格**（`snake_case`），这样
`AccountPool.findAccountIdByCredential`（`account-pool.ts:352-364`）拿
`identifierKey = 'access_token'` 就能直接匹配上，无需改那个函数。

**必须持久化 `uuid` / `first_keyfrom` / `latest_keyfrom`** —— 这是 LobsterAI 与
CodeBuddy 最大的结构差异：它的 refresh 请求体**不是**只带 refreshToken，还要带
这三个身份字段（`auth.go:37-50` + `client.go:112-147`）。丢了就续期失败、
只能重新登录。

`latest_keyfrom` 的更新语义（`client.go:112-147` + `main.go:262-354`）：
- 登录时 = 当前毫秒时间戳；
- refresh 后**也应更新为当前时间**（`auth.go:37-50` 每次从字段读，所以调用方要在
  refresh 成功后写回）。

---

### 3.4 续期（Refresh）

#### A. lobsterai2api 怎么做的

`internal/upstream/client.go:112-147` `RefreshToken`：

```go
POST {ServerBase}/api/auth/refresh
Headers: Content-Type/Accept: application/json, User-Agent: LobsterAI/0.1.0
         （注意：authHeaders（104-108 行）不设 Authorization —— 换 token 不需要旧 token）
Body: KeyfromBody() + {"refreshToken": a.RefreshToken}
→ { code:0, data:{ accessToken, refreshToken, expiresIn } }
```

成功后**就地更新** `a` 的字段（缺省值保留旧值），原子写回由调用方负责：

```go
a.AccessToken = tok.AccessToken
if tok.RefreshToken != "" { a.RefreshToken = tok.RefreshToken }
if tok.ExpiresIn > 0 {
    a.ExpiresAt = time.Now().Add(...).Unix()
} else if exp := jwtExpiry(tok.AccessToken); exp > 0 {
    a.ExpiresAt = exp          // 响应缺 expiresIn 时从 JWT 解
}
```

**失败判定是粗粒度的**：只区分「没拿到 accessToken」→ `refresh_failed: no accessToken
in response — re-login required`（134-136 行）。**没有** CodeBuddy 那样区分
「refresh_token 失效」与「瞬时网络错误」。

#### B. 当前项目怎么做的

`src/buddy-auth.ts:220-258` `refresh()`，配套 `src/refresh.ts` 的 `RefreshScheduler`：

1. **终态识别**：`RefreshTokenExpiredError`（名字作判据）。
   `refresh.ts:21-25` 的 `isRefreshTokenExpired` **刻意不用 `instanceof`** ——
   因为 `oauth.ts` 与 `buddy-oauth.ts` 各自导出一个同名类，跨模块 identity 不同，
   用 `instanceof` 会让某一侧失效信号被当成「可重试」而无限重试。

2. **调度语义**（`refresh.ts:43-113`）：
   - `arm(expiresAtMs)`：提前 1 小时触发（`REFRESH_LEAD_MS`），叠加 0-59 秒随机偏移；
   - 失败重试：普通错误 10 分钟（`REFRESH_RETRY_MS`），
     异常网络 1 分钟（`REFRESH_ABNORMAL_NETWORK_RETRY_MS`，
     靠 `isAbnormalNetworkError` 正则判定）；
   - `generation` 代号防止**登出后调度器复活**（93-96 行）；
   - `expiresAtMs` 距过期 ≤1h 时 delay 为 0（立即刷）。

3. **登出竞态保护**：`refresh()` 内 `if (!this.active) return` ——
   在途刷新期间已 `logout()` 时跳过凭据回写与调度武装（`buddy-auth.ts:236`）。

4. **批量续期** `refreshAll(pool)`（`buddy-auth.ts:265-309`）：
   遍历 pool 中 `enabled && refreshable` 的**本产品**账号，逐个续期，
   单账号失败不中断循环；凭据缺失或不可刷新时把 `refreshable` 置 false。

#### C. 推荐做法

新建 `src/lobsterai-auth.ts`，`LobsteraiAuth extends Service`，**完整照抄
`BuddyAuth` 的结构**（这是本插件已经被验证过的模式）：

- `RefreshScheduler` 直接复用；
- `markRefreshTokenInvalid()` + `refreshTokenInvalid` 标志复用；
- `active` 登出竞态保护复用；
- `refreshAll(pool)` 复用（把 `this.product.id` 传成 `'lobsterai'`）。

**新增一条**：refresh 的终态判定要**比 Go 版更精确**。
Go 版只判「响应里有没有 accessToken」，会把网络故障也当成终态。
推荐：抛出 `RefreshTokenExpiredError` 的条件收敛为
`HTTP 401/403` 或 `code` 属于 `{40100, 40101}`（对齐 `classify.go:62-63` 的
`sessionDeadMarkers`）或 message 含 expired/invalid；
其余错误走 `RefreshScheduler` 的可重试路径。

**refresh 请求体构造器**（放 `src/lobsterai.ts` 纯函数，便于单测）：

```ts
export function lobsteraiRefreshBody(
  credential: LobsteraiCredential,
  clientVersion: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    firstKeyfrom: credential.first_keyfrom ?? '',
    latestKeyfrom: String(Date.now()),   // 每次刷新更新
    version: clientVersion,              // 用动态真值，不用 '0.1.0'
    refreshToken: credential.refresh_token,
  }
  if (credential.uuid) body.uuid = credential.uuid
  if (credential.user_id) body.userId = credential.user_id
  return body
}
```

> ⚠️ `version` 字段在 Go 里是硬编码 `"0.1.0"`（`auth.go:41`），
> 而 `sigin.py` 用动态查到的真实版本。**落地时统一取「动态查到的版本，
> 失败回退 `fallbackClientVersion`」**，两处保持一致。

---

### 3.5 LLM 适配器（Chat 转发）

#### A. lobsterai2api 怎么做的

三层：`handler.go`（OpenAI 门面）→ `upstream.ChatStream`（转发）→ `sse.go`（聚合/透传）。

**关键约束：上游只支持 SSE**（`client.go:168-195` `prepareChatBody`）：

```go
// force stream for upstream SSE compat
body["stream"] = true
// normalize tool_choice
if tc, ok := body["tool_choice"]; ok {
    switch v := tc.(type) {
    case string:
        if v == "" || v == "none" { delete(body, "tool_choice") }
    case map[string]any:  // keep as-is
    case nil:             delete(body, "tool_choice")
    }
}
```

README:100-103 明确：「`stream:false` 返回 500」，`handler.go` 用 `peek.Stream`
记住客户端的原始意图，上游固定流式，最后自行聚合（`upstream.Aggregate`）。

**请求头**（`client.go:94-101`）：

```go
req.Header.Set("Authorization", "Bearer "+a.AccessToken)
req.Header.Set("Content-Type", "application/json")
req.Header.Set("Accept", "text/event-stream, application/json")
req.Header.Set("User-Agent", clientUA)                                    // LobsterAI/0.1.0
req.Header.Set("X-LobsterAI-Client-Capabilities", "kimi-k3-agentic-v1")
req.Header.Set("X-LobsterAI-Client-Version", clientVersion)               // 0.1.0（假值）
```

**端点**：`{base}/api/proxy/v1/chat/completions`（`client.go:201`）。

**SSE 消费**（`sse.go:17-150` `Aggregate`）—— 这份实现有几处很实用的兼容处理，
应该移植：

1. **容忍 `data:` 后无空格**：`strings.HasPrefix(line, "data:")` 后用
   `TrimSpace(TrimPrefix(...))`，注释写明「龙虾上游实测无空格」。
2. **`reasoning_content` 单独累积**（74-76 行）→ 说明**支持推理内容**。
3. **`tool_calls` 按 `index` 合并**（77-95 + `mergeToolCallDelta` 154-180）：
   首片带 `id`/`type`/`function.name`，后续只带 `arguments` 片段，
   `arguments` 字符串**拼接**而非覆盖。
4. **兼容 `message` 而非 `delta`**（97-102 行）：有的上游把完整消息放 `message` 里。
5. **`finish_reason` 及时更新**（63-65 行）。
6. **`[DONE]` 之后仍继续读到 EOF**（40-42 行注释写 `drain nothing; done`，
   实际是靠 `if err == io.EOF { break }` 退出）。
7. **透传模式** `Stream`（193-235）：逐行 flush，并在**没有见过 `[DONE]` 时补写一个**
   （226-233 行）—— 避免客户端因缺 `[DONE]` 而挂住。

#### B. 当前项目怎么做的

`src/buddy-adapter.ts`（1125 行）是范本。要点：

1. **`LlmAdapter` 子类**，实现 `providerInfo` / `listModels` / `resolveModel` /
   `stream`，并提供 `prepareCall` shim（`buddy-adapter.ts:641-657`，
   因为链接的 dsh-llm 副本基类还没有该方法，缺了会抛
   `registration.adapter.prepareCall is not a function`）。

2. **SSE 消费**（`consumeSse`，882-1101）比 Go 版更细致，产出 DSH 的 `StreamChunk`：
   - `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
     `usage` / `block-end` / `finish`；
   - **工具调用 id 按 wire index 缓存**（894, 998-1001）—— 首片带真实 id，
     后续分片只有 index，缺失时回退 `call_{index}`；
   - **`finish_reason` 映射顺序**（1083-1099）：
     `length` → `undefined && 有 tool` → `argsTruncated` 都归为 **`max-tokens`**，
     只有确认完整才报 `tool-calls`。理由写在注释里：报错会让 harness 执行
     残缺 JSON 参数并污染会话历史；
   - **`function.name` 只允许非空覆盖**（1013-1015）：
     后续分片带空字符串 `""`，直接覆盖会清空工具名 → `unknown tool ""`。

3. **空闲超时分两阶段**（`src/sse.ts:26-57` + `buddy-adapter.ts:346-351`）：
   首 token 120 秒、chunk 间 120 秒，均可用 env 覆盖。
   理由：半开 SSE 连接会让 `reader.read()` 永久挂起，会话卡在"运行中"。

4. **消息序列化**（`serializeMessages`，214-289）：
   - **孤儿工具调用清理**（`resolveToolPairing`，`src/sse.ts:91-123`）——
     OpenAI 协议要求 tool_call 与 tool 结果严格配对，缺一侧后端 400，
     而这条坏历史会被每次请求重放导致**整个会话永久报废**；
   - assistant 消息恒带 `reasoning_content`（推理模型缺失会 400）；
   - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`。

5. **限流切换**（788-828）：解析错误体重置时间 → `updateModelRateLimit`
   → `getAvailableAccount` 取下一个账号 → 重发，最多遍历完全部候选。

6. **401/403 时刷新一次再重试**（778-787）。

7. **图片输入**：`readImage` 桥接 `ctx.attachments.readImage`，
   转 base64 data URL（698-718）。

#### C. 推荐做法

**新建 `src/lobsterai-adapter.ts`**，以 `BuddyAdapter` 为骨架，删掉无关部分，
补上 LobsterAI 特有部分。

可以**直接复用**的：
- `src/sse.ts` 的 `readWithIdleTimeout` / `resolveToolPairing` /
  `normalizeToolArguments` / `isTruncatedArguments` —— **一行都不用改**；
- `resolveToolPairing` 那套孤儿清理对 LobsterAI **同样必要**
  （它的后端也是 OpenAI 兼容，同样会 400）；
- `prepareCall` shim；
- 限流切换 + 401 重试的控制流。

**必须新增/不同的**：

| 项 | 处理 |
|---|---|
| URL | `${product.apiBase}/api/proxy/v1/chat/completions` |
| 请求头 | 只设 `Authorization` / `Content-Type` / `Accept` / `User-Agent` / `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version`。**不设** `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` |
| `stream` | **恒为 `true`**（上游硬要求）；DSH 本来就是流式消费，无需 `Aggregate` |
| `tool_choice` | 归一化：`""` / `"none"` / `null` 时**删除该字段**（对齐 `prepareChatBody`） |
| `prompt_cache_key` | **不要发**。那是 CodeBuddy 的前缀缓存机制，LobsterAI 未实测支持；发了无益且有被拒风险 |
| `thinking` / `reasoning_effort` | **不要照抄 buddy 的逻辑**。buddy 那套（`isDeepSeekModel` + 强制补档位）是针对腾讯后端实测出来的；LobsterAI 只需**透传** `options.reasoningEffort`（如上游接受），是否支持待实测 |
| 图片输入 | **暂不支持**。Go 桥接层没有任何图片处理代码，`inputModalities` 返回 `['text']`；不要桥接 `ctx.attachments` |
| `usage` 缓存字段 | LobsterAI 的 `Aggregate` 直接透传整个 `usage` 对象，未做 `cached_tokens` 拆分。TS 侧先简单映射 `prompt_tokens` / `completion_tokens` |

**模型元数据**：`resolveModel` 的上下文窗口先用兜底表（`handler.go:94-114` 里
所有模型都标的 `context_length: 131072`，这个值来自桥接层的静态表，
**不是**远端权威值 —— 远端 `/api/models/available` 只返回
`modelId`/`modelName`/`provider`/`apiFormat`，**没有** context window）。
→ 兜底表标 131072，但**在注释里标明这是桥接层的猜测值**，待实测校正。

---

### 3.6 错误分类与限流（Error Classification）

#### A. lobsterai2api 怎么做的

`internal/upstream/classify.go` 定义 7 类错误（14-22 行）与两张关键词表：

```go
const (
    ErrNone        ErrKind = iota
    ErrHardCredit                 // 余额不足 → 长冷却
    ErrSoftRate                   // 429 软限流 → 短冷却
    ErrSessionDead                // 401 + 40100/40101 刷新被拒 → 禁用
    ErrNotFound                   // 404 上游偶发 → 短冷却不累计 errCount（防雪崩）
    ErrServer                     // 5xx
    ErrClient                     // 其他 4xx / 业务错误
)
```

**`hardMarkers`**（55-60 行）—— 中英双通道：

```go
"insufficient credit", "no credit", "credit exhausted", "out of credit",
"quota exceeded", "quota exhaust", "payment required", "credit not enough",
"not enough credit", "freecreditsused", "free credits used",
"积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分", "积分耗尽",
```

**`sessionDeadMarkers`**（63 行）：`"40100"`, `"40101"`,
`"token rejected"`, `"refresh token was rejected"`。

**`Classify(status, body)`**（66-93 行）判定顺序（**顺序即优先级**）：

1. `status == 402` → `ErrHardCredit`
2. body 含 hardMarkers（小写 + 原文双通道）→ `ErrHardCredit`
3. body 含 sessionDeadMarkers → `ErrSessionDead`
4. `status == 429` → `ErrSoftRate`
5. `status == 404` → `ErrNotFound`
6. `status >= 500` → `ErrServer`
7. `status >= 400` → `ErrClient`
8. 否则 `ErrNone`

**消费方式**（`handler.go:218-244`）：

| 类别 | 动作 |
|---|---|
| `ErrHardCredit` | `Cooldown(CoolHard, 12h)` + 换号 |
| `ErrSoftRate` | `Cooldown(CoolSoft, 60s)` + 换号 |
| `ErrSessionDead` | `Disable(uid)` + 换号 |
| `ErrNotFound` | `Cooldown(CoolSoft, 60s)` + 换号，**不累计 errCount** |
| 其他 | `NoteError`（连续 3 次 → 冷却 10 分钟）+ 换号 |

冷却时长来自 `config.example.json`（`hard_credit: 12h` / `soft_rate: 60s` /
`err_threshold: 3` / `err_cooldown: 10m`）。

#### B. 当前项目怎么做的

**只有限流一种分类**，且是**正则**（`src/llm-adapter.ts:1435-1437`）：

```ts
export function isRateLimited(body: string): boolean {
  return /频率限制|rate.?limit|使用量已超出|频率超出|重置/i.test(body)
}
```

配套 `parseRateLimitError(body, currentModel)`（1440-1465）从错误文本里**抠出重置
时间**（正则 `/将在\s+([\d-]+\s+[\d:]+)\s*UTC[+-]\d+/`），失败时回退
`Date.now() + 1h`。

其余错误靠 `BuddyAdapter.stream` 里的 `httpErrorCode()`（317-324）映射：
`401/403 → AUTH`、`429 → RATE_LIMIT`、`400 → INVALID_REQUEST`、`>=500 → SERVER`。

**关键差异**：本插件没有「硬冷却 12h / 会话死亡永久禁用」这套状态机。
`AccountPool` 只有 `modelRateLimits`（模型级重置时间）与 `enabled`（用户手动开关）。
`account-probe.ts` 的模块注释（4-7 行）明确说明：限流标记只是「一次 429 事件的快照」，
所以提供了「重测 / 重置」按钮让用户主动验证。

#### C. 推荐做法

**新建 `src/lobsterai-errors.ts`**，把 `classify.go` 的判定表逐条移植：

```ts
export type LobsteraiErrorKind =
  | 'none' | 'hard-credit' | 'soft-rate' | 'session-dead'
  | 'not-found' | 'server' | 'client'

export function classifyLobsteraiError(status: number, body: string): LobsteraiErrorKind
```

**设计取舍（重要）**：**不要**把 Go 的 `pool.Cooldown/Disable` 状态机搬过来。
本插件已有等价且更成熟的机制：

| Go 状态机 | 本插件等价物 |
|---|---|
| `Cooldown(CoolSoft, 60s)` | `pool.updateModelRateLimit()`（模型级重置时间） |
| `Cooldown(CoolHard, 12h)` | 同上，但**重置时间**应从错误体的「将在 … 重置」解析；解析不到才用 +12h |
| `Disable(uid)` | `pool.updateAccount(id, { enabled: false })` |
| `NoteError` 连续 3 次 | **不移植**。本插件靠用户手动「重测/重置」 |
| `ReenableIfCredits` | 签到 RPC 里顺带更新；当前 `account-probe` 已有 reset 路径 |

理由：Go 的自动冷却会**静默停用账号**，用户看不见原因（只在 `/status` 的
`reason` 字段里）。本插件的哲学是「如实展示 + 用户可主动验证」，
Jet Hub 面板上有具体账号、限流徽章与重测按钮。把自动禁用搬进来会与这套
UI 语义冲突。

**但 `hard-credit` 的识别必须移植** —— 它是 LobsterAI 最主要的失败模式
（免费积分用尽）。识别出来后：
- 走现有 `updateModelRateLimit` 路径（这样徽章会亮）；
- 错误消息里如实带上「积分不足」原文，让模型/用户能看懂。

---

### 3.7 账号池与选号（Account Pool & Picking）

#### A. lobsterai2api 怎么做的

`internal/pool/pool.go` 自建池，**按积分选号**：

```go
// PickExcluding: 跳过 tried，跳过不健康，取 credits 最大者（131-151 行）
for uid, e := range p.byUID {
    if tried != nil && tried[uid] { continue }
    if !e.healthy(now)            { continue }
    if best == nil || e.credits > best.credits { best = e }
}
```

`healthy()`（58-66 行）：`!disabled && (until.IsZero() || !now.Before(until))`。

池的操作：`Add` / `SyncToDir`（对齐目录，剔除消失的账号但**保留状态**）/
`SetCredits` / `Cooldown` / `Disable` / `ReenableIfCredits` / `NoteError` /
`NoteSuccess` / `AuthByUID` / `List`。

持久化：`state.json` 只存 `{uid: {credits, disabled, reason, until}}`，
**不含凭据**（凭据在 `auths/*.json`）。`Add` 时对已存在的 uid
**只换凭证、保留状态**（94-103 行）。

#### B. 当前项目怎么做的

`src/account-pool.ts`（552 行），**索引与凭据分离**：

- 账号**索引**存 `ctx.settings` 的 `jet-hub` namespace（→ 配置文件）；
- **凭据本体**存 `ctx.credentials`（`credentialRef`）；
- `cache: ProviderAccountEntry[]` 是**进程内权威副本**（127-143 行）——
  理由：settings 的 resolved 快照在 `replace()` 后未必立即更新，
  若以滞后快照为读源，连续的 `updateModelRateLimit` 会互相覆盖；
- `modelCache: ModelDisableMap` 同理（模型黑名单）。

`ProviderAccountEntry`（`src/types.ts:42-61`）：

```ts
{
  id, provider, nickname, enabled, credentialRef, createdAt,
  expiresAt?, refreshable,
  modelRateLimits?: Record<string, number>   // key = 模型ID, value = 重置时间戳(ms)
}
```

选号 `getAvailableAccount(provider, modelId)`（453-506 行）：
1. 过滤 `provider === provider && enabled`；
2. `modelId` 非空时过滤掉「该模型仍在重置期内」的账号；
3. **按该模型的重置时间升序排**（早到期的优先）；
4. 逐个解析凭据，跳过占位/损坏条目（并记录失败原因，不静默失败）。

**没有积分字段**，也**不按积分选号**。

> ⚠️ 已发现的既有问题：`findAccountIdByCredential`（352-364 行）的 `identifierKey`
> 是 `provider === 'codearts' ? 'access_key_id' : 'access_token'` —— LobsterAI 用
> `access_token`，所以**不用改**。但它**只遍历 `entry.enabled` 的账号**，
> 停用账号的限流记录无法归属（已在 `buddy-adapter.ts:682-686` 用 `console.warn` 提示）。

#### C. 推荐做法

**直接复用 `AccountPool`，不新增池实现。** 需要做的只有：

1. `ProviderAccountEntry.provider` 加 `'lobsterai'`（类型上是 `string`，
   **无需改类型**）；
2. `AccountPool` 的所有方法都以 `provider` 字符串为参数，**零改动**即可支持；
3. 限流记录走现有 `updateModelRateLimit`。

**关于「按积分选号」—— 建议不做**。理由：

- Go 的积分来自每次请求前的 `QuotaUsage`（一次额外 HTTP 请求）或调度器定时刷新，
  是**滞后数据**（`scheduler.go:100-105`）。按滞后积分选号未必比「按限流状态选号」更优；
- 本插件的 `getAvailableAccount` 已经按**该模型的重置时间**排序，是**请求级精确**的；
- 引入积分字段会动 `ProviderAccountEntry` schema、`writeAccounts`（整体 replace）、
  UI 卡片渲染，改动面大而收益不确定。

**可选增强**（如果确实想要）：在 `ProviderAccountEntry` 上加
`creditsRemaining?: number`，由 `credits.balances` RPC 顺带回填，
在 `getAvailableAccount` 的排序里作为**次级**排序键
（先按重置时间，再按积分降序）。这样不破坏现有语义。

---

### 3.8 每日签到（Checkin）

#### A. lobsterai2api 怎么做的

**Go 侧是 no-op**（`client.go:315-321`）：

```go
// DailyCheckin 执行每日签到。目前龙虾签到端点未知，返回 nil（no-op）。
func (c *Client) DailyCheckin(a *auth.Auth) error {
    // TODO: LobsterAI daily sign-in endpoint TBD
    return nil
}
```

**真正的实现在 `sigin.py`（未跟踪文件）**。三步流程（51-67 行）：

```python
# 0) 版本号（首次）：GET {UPDATE_API} → data.value.version
#    失败则整个脚本退出（不做签到）—— 版本号是必填参数

# 1) 查活动槽位
GET {BASE}/api/client-activities/slot
      ?placement=desktop_sidebar
      &clientVersion={CLIENT_VERSION}
      &containerApiVersion=2
      &platform=win32
→ data: { slotState, activity: { activityCode, configRevision } }
   若 slotState != "available" 或无 activity → "无可用活动"，结束

# 2) 查活动上下文
GET {BASE}/api/client-activities/{activityCode}/context
      ?configRevision={rev}
→ data: { state: { claimedToday }, actions: [...] }
   若 claimedToday 为真，或 actions 里没有 "check_in" → "今天已签到，跳过"

# 3) 签到
POST {BASE}/api/client-activities/{activityCode}/actions/check_in
Body: { "configRevision": rev,
        "idempotencyKey": str(uuid.uuid4()),   # 幂等键
        "payload": {} }
→ data: { result: { creditsGranted | rewardCredits | credits } }
```

**`+100 积分/号/天`**（文件头 docstring 第 2 行）。

**认证**：纯 `Authorization: Bearer {accessToken}`，**无签名**
（32-48 行 `api()`）。响应信封 `{code, msg, data}`，`code != 0` 抛错；
`data` 非 dict 时抛「data 为空（accessToken 可能已失效）」（44-48 行）。

**版本号解析**（`resolve_client_version`，21-29 行）：
`GET https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update`
→ `data.value.version`，并用 `version_key()` 正则校验格式
（`^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$`），格式异常则拒绝签到。

**积分字段回退链**（65-66 行）：
`creditsGranted` → `rewardCredits` → `credits`。

#### B. 当前项目怎么做的

`src/credits.ts`（457 行）是 CodeBuddy 版签到，**协议完全不同**：

| 项 | CodeBuddy（`credits.ts`） | LobsterAI（`sigin.py`） |
|---|---|---|
| 状态查询 | `POST /v2/billing/meter/checkin-activity-status` body `{}` | `GET /api/client-activities/slot?placement=…` |
| 领取 | `POST /v2/billing/meter/daily-checkin` body `{}` | `POST /api/client-activities/{code}/actions/check_in` |
| 路径参数 | 无 | `activityCode` + `configRevision` 来自前两步 |
| 幂等 | 靠服务端 `code:10001` | 请求带 `idempotencyKey`（UUID4）+ 先查 `claimedToday` |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-User-Id` / `X-Enterprise-Id` / `X-Tenant-Id` | 仅 `Authorization` / `Accept` / `Content-Type` / `User-Agent` |
| 版本号 | 无此概念 | **必填参数**，需从第三方接口动态拉取 |

**可复用的模式**（`credits.ts` 里值得照搬的）：

1. `PostResult` 三态（228-261 行）：网络失败时**保留原始错误消息**
   （含 timeout / socket hang up），不吞诊断信息；
2. `ClaimOutcome` 判别联合（90-94 行）：
   `claimed` / `already-claimed` / `inactive` / `failed` ——
   把「业务正常状态」与「真失败」严格分开；
3. 判定**以响应体 code 为准**，不看 HTTP 状态（19-20 行注释）；
4. 解析工具 `readBool` / `readNumber` / `readString`（200-220 行）——
   逐字段安全读取，**绝不抛错**；
5. `REQUEST_TIMEOUT_MS = 30_000` + `AbortSignal.timeout`。

**RPC 层**（`src/jet-hub-rpc.ts`）：
- `collectCreditsStatus`（163-187 行）/ `collectClaimResults`（199-239 行）；
- **逐账号顺序执行**（避免并发触发风控）；
- **凭据解析在 try 之内**（158-162 行注释说明了原因：`credentialRef()` 会对
  名称做正则校验、非法名抛 TypeError，把它留在 try 外会让单账号异常
  冒泡成整批失败）；
- **包含已停用账号**（`pool.listAccounts(provider)` 不过滤 enabled）——
  停用只影响自动选择，与「今天领了没」无关；
- `computeClaimSummary`（95-127 行）纯函数，带 `never` 穷尽性检查。

#### C. 推荐做法

**新建 `src/lobsterai-credits.ts`**（而不是把 LobsterAI 塞进 `credits.ts`）——
两者协议没有一处共用，硬合并只会让 `credits.ts` 出现大量
`if (provider === 'lobsterai')` 分支。

```ts
// 三步签到，对齐 sigin.py:51-67
export async function fetchLobsteraiActivitySlot(
  credential: LobsteraiCredential, product: LobsteraiProduct,
  clientVersion: string, fetcher?: typeof fetch,
): Promise<LobsteraiActivitySlot | null>

export async function claimLobsteraiDailyCheckin(
  credential: LobsteraiCredential, product: LobsteraiProduct,
  clientVersion: string, fetcher?: typeof fetch,
): Promise<ClaimOutcome>     // 复用 credits.ts 的 ClaimOutcome 类型
```

**必须处理的点**：

1. **`clientVersion` 是前置依赖**。`sigin.py:73-76` 拿不到版本号就**整个脚本放弃签到**。
   推荐在插件里做**进程内缓存 + 定时刷新**：
   - 缓存 TTL 建议 6-12 小时（版本号变更频率极低）；
   - 拉到后用 `version_key` 同款正则校验；
   - 失败时**回退 `product.fallbackClientVersion`**（比 sigin.py 更宽容 ——
     宁可用一个稍旧的版本号试，也别完全不签到；但要在日志里警告）。
2. **`placement=desktop_sidebar` / `containerApiVersion=2` / `platform=win32`**
   三个 query 参数**全部硬编码照抄**（`sigin.py:52-53` 是用真实客户端观察到的值）。
3. **`platform=win32` 在非 Windows 上也照发** —— 这是伪装客户端形态，与运行环境无关。
4. **积分字段回退链**：`creditsGranted` → `rewardCredits` → `credits`。
5. **`idempotencyKey` 用 `crypto.randomUUID()`**（对齐 `str(uuid.uuid4())`）。
6. **两步预检查都要做**：`slotState === 'available'` 且有 `activity`；
   `!state.claimedToday` 且 `actions.includes('check_in')`。
7. **复用 `ClaimOutcome` 判别联合** —— 这样 `computeClaimSummary`
   与 Jet Hub 的结果摘要 UI **一行都不用改**。
8. **积分余额**：`GET {base}/api/user/profile-summary` →
   `data.totalCreditsRemaining`（`client.go:281-313`、`cmd/credit/main.go:56-101`）。
   注意注释里的坑（`client.go:282-283`）：

   > `/api/user/quota` 只显示 `freeCreditsTotal=300`，**不含 5000 活动积分**。
   > 必须用 `profile-summary` 的 `totalCreditsRemaining`。

   `cmd/credit/main.go:76-83` 还返回了 `creditItems[]`
   （`{type, creditsRemaining, expiresAt}`），可用于 UI 明细 ——
   对应本插件 `CreditBalance.packages` 的角色。
   → 建议在 `src/lobsterai-credits.ts` 里返回一个 `LobsteraiCreditBalance`，
   与 `credits.ts` 的 `CreditBalance` **结构对齐**，让 `CreditBalanceRow`
   组件能复用。

---

### 3.9 模型列表（Models）

#### A. lobsterai2api 怎么做的

**动态优先 + 静态兜底**（`handler.go:116-175`）：

```
动态：GET {base}/api/models/available?{keyfrom query}
  keyfrom 来自 a.KeyfromBody()（firstKeyfrom/latestKeyfrom/version/uuid/userId）
  注意：用了 keyfrom body 但 **不含 refreshToken**（client.go:229-241）
→ { code:0, data:[{ modelId, modelName, provider, apiFormat }] }
  只取 modelId，缓存 1 小时（dynamicModelsTTL）
```

静态兜底 19 个模型（`handler.go:94-114`，注释：「2026-08-06 从
`GET /api/models/available` 实测拉取」）：

```
deepseek-v4-flash            MiniMax-M3                   qwen3.7-max
deepseek-v4-pro              MiniMax-M2.7                 qwen3.7-plus
qwen3.6-plus                 qwen3.5-plus-2026-04-20      kimi-k2.7-code
kimi-k2.7-code-highspeed     kimi-k2.6                    kimi-k2.5
doubao-seed-2-1-pro-260628   doubao-seed-2-1-turbo-260628 doubao-seed-2-0-code-preview-260215
glm-5.2                      glm-5.1                      glm-5v-turbo
glm-5
```

全部标 `context_length: 131072`（**桥接层的猜测值**，远端不返回窗口大小）、
`owned_by: "lobsterai"`。

#### B. 当前项目怎么做的

`src/product.ts` 的 `fallbackModels` + `BuddyAdapter.listModels/resolveModel`
三级查找（`buddy-adapter.ts:607-639`）：

```
远端 fetchRemoteModels 下发值  →  产品兜底表 product.fallbackModels  →  通用静态表 CONTEXT_WINDOWS
```

外加 `reconcileWithFallback`（511-535 行）—— **当产品有兜底表时以它为准**：
只保留兜底表声明的 id，远端缺失的补进来。理由（注释 500-509 行）：
服务端按认证上下文下发，插件 token 拿到的集合可能残缺甚至含不可用条目。

`ensureRemoteModels()`（475-495 行）懒加载一次，`listModels` 与 `resolveModel`
共用（否则直接进会话时远端 `maxInputTokens` 不生效）。

`listModels` 里应用黑名单（580-583 行）：
`this.options.accountPool?.disabledModelsFor(this.product.id)`。

#### C. 推荐做法

1. **`product.fallbackModels` 直接用上面那 19 个**（含 `name` 与
   `contextWindow: 131072`）。`name` 可用 `modelName` 的实测值，
   未实测的用 id 本身。
2. **`fetchRemoteModels`** → `GET {apiBase}/api/models/available` +
   keyfrom query（含 `uuid` / `userId`）。只需 `modelId`。
   → 返回 `LobsteraiRemoteModel[]`，与 `BuddyRemoteModel` 结构分开定义
   （字段更少）。
3. **不要做 `reconcileWithFallback` 那种「以兜底表为准」的裁剪** ——
   LobsterAI 的远端接口是**权威的**（19 个静态表就是从它实测来的），
   远端可用时应完全采信。兜底只在远端失败时整体替换。
4. `resolveModel` 的 `reasoning` 字段：**先不声明**。
   LobsterAI 是否支持 `reasoning_effort` 待实测（Go 桥接层完全没处理）。
   模型选择器会显示「当前模型未提供推理等级」，这是诚实的。
5. `inputModalities` 恒为 `['text']`（Go 层无图片处理代码）。

---

### 3.10 定时调度（Scheduler）

#### A. lobsterai2api 怎么做的

`internal/scheduler/scheduler.go`：

- `Run(ctx)` 主循环：算下一个整点触发时间（`nextFire`, 40-52 行），
  到点后按当前小时判断该跑哪个任务；
- 默认 `checkin_hours: [9, 21]`、`keepalive_hours: [22]`（`config.example.json`）；
- `RunCheckinNow()`（87-107 行）：遍历**非 disabled** 账号 →
  `DailyCheckin`（no-op）→ `QuotaUsage` → `ReenableIfCredits`（余额 > 0 则解冻）；
- `RunKeepaliveNow()`（110-131 行）：遍历账号 → `RefreshToken` →
  `SaveAtomic`，`ErrSessionDead` 则 `Disable`；
- 启动后延迟 5 秒跑一次 `RunCheckinNow()`（`main.go:71-75`）——
  立即刷新积分，不用等整点。

#### B. 当前项目怎么做的

`src/index.ts:246-275`：

```ts
const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

async function refreshAllCredentials(): Promise<void> {
  try { await service.refreshAll(pool) } catch { /* 静默 */ }
  try { await buddy.refreshAll(pool) } catch { /* 静默 */ }
  try { await workbuddy.refreshAll(pool) } catch { /* 静默 */ }
}

pool.listAllAccounts().then(accounts => {
  const hasRefreshable = accounts.some(a => a.refreshable && a.enabled)
  if (hasRefreshable) {
    const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
    ctx.effect(() => () => { clearInterval(refreshTimer); ... }, '...')
  }
})
```

特点：
- **固定 30 分钟间隔轮询**（不做整点对齐）；
- **启动时先检查是否有可续期账号**，没有就不起定时器；
- `unref()` 避免阻塞进程退出；
- `ctx.effect()` 注册清理钩子。

**签到没有定时任务** —— `credits.claimAll` 只能由用户在 Jet Hub 点按钮触发。

#### C. 推荐做法

1. **续期**：把 `lobsterai.refreshAll(pool)` 加进 `refreshAllCredentials()`
   （`index.ts:250-260`）—— 零成本扩展。
2. **签到**：**建议 v1 不做自动签到**，保持与 CodeBuddy 面板一致
   （只有「一键领取积分」按钮）。理由：
   - 现有 UI 已有按钮与结果摘要，用户预期一致；
   - 自动签到要引入「整点调度」这套新机制（现有定时器是固定间隔轮询），
     而 `sigin.py` 本来就是独立脚本，用户已经习惯手动/外部定时跑。
3. **若确实要自动签到**，推荐做法：
   - 复用现有 30 分钟间隔定时器，**不做整点对齐**（简化）；
   - 每小时最多尝试一次（模块内记 `lastCheckinAttemptMs`）；
   - **只对 `enabled` 账号**执行（与 Go 一致），但 `claimAll` RPC 保持
     「含停用账号」的语义不变 —— 两者语义本就不同；
   - 失败静默（与 `refreshAllCredentials` 的 `catch { /* 静默 */ }` 一致）。

---

### 3.11 Jet Hub UI 与 RPC

#### A. lobsterai2api 怎么做的

**没有 UI**。只有 `GET /status` 返回 `{accounts: [pool.Status]}`（`handler.go:86-90`），
字段：`uid` / `nickname` / `credits` / `cooling` / `until` / `reason` /
`disabled` / `err_count`（`pool.go:38-47`）。用户靠 curl 或
`credit.sh -pretty` 看状态。

#### B. 当前项目怎么做的

**宿主侧**：`src/jet-hub-rpc.ts`（654 行）注册 `POST /api/jet-hub`，
方法分发在 `handleMethod`（368-645 行）：

| 方法 | 要点 |
|---|---|
| `account.list` | `pool.listAccounts(provider)` |
| `account.create` | `productById(provider)` 存在 → 两步式（取 state+authUrl 返回，后台跑完）；`codearts` → 同步 `login()`；否则报 `unknown provider`（**436 行**） |
| `account.update` / `account.delete` | 直接转 pool |
| `account.refresh` | ⚠️ **见下方 bug** |
| `login.poll` | 检查凭据是否已实际写入 |
| `account.retest` / `retestAll` / `reset` / `resetAll` | 转 `src/account-probe.ts` |
| `credits.status` / `claimAll` / `balances` | `productById(provider)` 取产品 → `collect*` |
| `model.list` | `ctx.llm.listModels(provider)` + **黑名单并集补回**（595-620 行，注释解释了「关掉后彻底找不到」的根因） |
| `model.setDisabled` | `pool.setModelDisabled` |

**客户端**：`plugin-src/client/jet-hub.js`（769 行，React）：
- `PROVIDERS`（10-14 行）驱动 tab 列表，每项 `{id, label, icon, logoClass}`；
- `CREDITS_PROVIDERS = ['buddy']`（24 行）决定是否渲染「一键领取积分」；
- `ProviderLogo`（26-32 行）按 `logoClass` 上 CSS class；
- `CreditBalanceRow`（113+ 行）三段状态：loading / error / 有值；
- `ModelListPanel`（260+ 行）模型开关。

**样式**：`plugin-src/client/jet-hub-styles.js:25-29` 为每个 provider 定义
`.dim-jh-providerIcon.{logoClass} { background: white; }`。

> ⚠️ **发现的既有 bug 1**（`jet-hub-rpc.ts:452-476`）：`account.refresh` 的分支
> 只处理 `codearts` 与 `buddy`，**`workbuddy` 会落到 `else` 抛
> ``Unknown provider: workbuddy``**。即该端点对 WorkBuddy 完全不可用。
> ⚠ 本文档初稿把它记作「账号卡片的『刷新』按钮是坏的」——**该说法不成立**：
> 账号卡片上并没有「刷新」按钮（按钮是 测试/重测/重置/停用/代理/指纹/删除），
> ``account.refresh`` 没有面板入口，调用方是仓库外的脚本/手工 RPC（issue IKJOZA 取证）。
>
> ⚠️ **发现的既有 bug 2**（同处）：分支里调的是 `codearts.refresh()` /
> `buddy.refresh()` —— 这两个方法刷新的是**默认单凭据 ref**
> （`BuddyAuth.refresh()` 用 `this.credentialRefName` = `BUDDY_ACCESS_TOKEN`），
> **不是该账号的 `entry.credentialRef`**。所以对账号池里的多账号发起续期，
> 刷的是另一个凭据。修法：按 `entry.credentialRef` 解析凭据后用该凭据刷新。

#### C. 推荐做法

**宿主侧**（`src/jet-hub-rpc.ts`）：

1. `account.create` 加 `lobsterai` 分支 —— 照 CodeArts 那样**同步**执行：
   ```ts
   } else if (provider === 'lobsterai') {
     const loginResult = await lobsterai.login({ refName, accountId: id, pool })
     return { ok: true, value: { accountId: id, loginUrl: loginResult.loginUrl } }
   }
   ```
2. `account.refresh` 顺带**修掉上面两个 bug**：改成按 `entry.provider` 找服务 +
   按 `entry.credentialRef` 刷新。这会同时修好 workbuddy。
3. `credits.status` / `claimAll` / `balances` 目前签名是
   `product: BuddyProduct`（`CreditsEndpointDeps`）—— LobsterAI 协议不同。
   → **最优解：复用 `collectCreditsStatus` / `collectClaimResults` /
   `collectCreditBalances`，只把 `product` 参数的类型从 `BuddyProduct`
   放宽成 `BuddyProduct | LobsteraiProduct`**，并在 RPC 层按 provider
   选择传入哪个 product 对象。三个 `collect*` 函数体**一行都不用改**
   （它们只用 `credentialRef` 和 `deps`，而 `deps.fetchStatus` / `deps.claim` /
   `deps.fetchBalance` **已经是注入的**，见 `CreditsEndpointDeps` 135-150 行）。

**客户端**（`plugin-src/client/jet-hub.js`）：

1. `PROVIDERS` 加一项：
   ```js
   { id: 'lobsterai', label: 'LobsterAI (有道)', icon: LOBSTERAI_ICON, logoClass: 'lobsterai' }
   ```
2. `CREDITS_PROVIDERS` 改为 `['buddy', 'lobsterai']` —— LobsterAI **有**签到接口
   （`sigin.py` 实测），这一步是必须的。
3. 新增 `LOBSTERAI_ICON`（base64 PNG，尺寸对齐现有：AI 图标 64x64、
   CodeBuddy 70x70、WorkBuddy 72x72 —— 显示时统一缩到 20x20）。
4. `plugin-src/client/jet-hub-styles.js` 加
   `.dim-jh-providerIcon.lobsterai { background: white; }`。

---

### 3.12 测试

#### A. lobsterai2api 怎么做的

**没有自动化测试**。仓库里没有 `_test.go` 文件。验证手段是 README 里的
curl 命令（55-71 行）。

#### B. 当前项目怎么做的

- **单元测试**：`tests/unit/**/*.spec.ts`（21 个文件），`pnpm test`，
  全 mock 无网络。`vitest.config.ts` 只 include `tests/unit/`。
  现有覆盖：`credits.spec.ts`（22.6 KB）、`buddy-adapter.spec.ts`（71.7 KB）、
  `account-pool.spec.ts`（30 KB）、`jet-hub-rpc.spec.ts`（32.4 KB）等。
- **E2E**：`tests/e2e/**`，`pnpm test:e2e:*`，**全部有闸门且默认 skip**
  （`describe.skip`），说明见 `tests/e2e/README.md`。
  README 里明确分了「消耗模型积分」与「不消耗」两张表，
  并说明为什么默认 skip（防止 CI 误跑消耗配额、
  以及 CodeBuddy 14 天试用期结束后产生真实费用）。

#### C. 推荐做法

1. **单元测试**（必做）：
   - `tests/unit/lobsterai.spec.ts` —— 凭据解析、`lobsteraiRefreshBody`、
     `credentialExpiresAtMs` 复用、uid 四级回退链、
     `classifyLobsteraiError` 全分支；
   - `tests/unit/lobsterai-oauth.spec.ts` —— 注入 `fetcher` 模拟
     exchange 响应（成功 / `code!=0` / `data` 缺失 / 无 accessToken）；
     回调服务器的 state 校验（不匹配 → 400）；
   - `tests/unit/lobsterai-credits.spec.ts` —— **重点**：
     三步流程的每种分支（无可用活动 / 今天已签到 / `actions` 无 `check_in` /
     领取成功 / 积分字段三种回退 / `code != 0` / 网络失败）；
     `clientVersion` 拉取失败时的回退行为；
   - `tests/unit/lobsterai-adapter.spec.ts` —— SSE 解析（含 `data:` 无空格、
     `reasoning_content`、tool_calls 分片合并）、`stream` 恒为 true、
     `tool_choice` 归一化、限流切换。
2. **E2E**：新增 `tests/e2e/lobsterai-*.e2e.spec.ts`，闸门 `DSH_LOBSTERAI_E2E=1`，
   在 `tests/e2e/README.md` 的表里**明确标注是否消耗积分**
   （签到会改动当日签到状态，但不消耗模型额度 —— 参照
   `workbuddy-claim-probe.e2e.spec.ts` 的标注方式）。
3. `package.json` 加 `test:e2e:lobsterai` / `test:e2e:lobsterai-claim` 脚本。

---

## 4. 完整接口清单（LobsterAI 上游）

从 `lobsterai2api` + `sigin.py` 整理。

- `BASE`（API）= `https://lobsterai-server.youdao.com`（`sigin.py:10`；Go 侧为 `LB2A_UPSTREAM_BASE`）
- `PORTAL` = `https://lobsterai.youdao.com`（实测，见 §0.2b；Go 侧为 `LB2A_LOGIN_PORTAL`）

### 4.1 认证

| 方法 | 路径 | 认证 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `{PORTAL}/portal#/login` | 无 | query: `source=electron`、`redirect_uri`、`state` | 浏览器页面；成功后跳转 `redirect_uri?code=X&state=Y` |
| POST | `{BASE}/api/auth/exchange` | 无 | `{authCode, firstKeyfrom, latestKeyfrom, uuid, version}` | `{code:0, data:{accessToken, refreshToken, expiresIn, user:{id,yid,userId,nickname}, quota}}` |
| POST | `{BASE}/api/auth/refresh` | 无（**不带 Authorization**） | `{firstKeyfrom, latestKeyfrom, version, uuid?, userId?, refreshToken}` | `{code:0, data:{accessToken, refreshToken, expiresIn}}` |

### 4.2 对话

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `{BASE}/api/proxy/v1/chat/completions` | `Bearer {accessToken}` | **仅 SSE**，`stream:false` → 500。头：`X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1`、`X-LobsterAI-Client-Version: {v}`、`User-Agent: LobsterAI/0.1.0`。**裸 SSE，不套信封** |

### 4.3 模型与账号

| 方法 | 路径 | 认证 | 响应 |
|---|---|---|---|
| GET | `{BASE}/api/models/available` | `Bearer` | query = keyfrom body（`firstKeyfrom`/`latestKeyfrom`/`version`/`uuid`/`userId`，**不含 refreshToken**）；`→ {code:0, data:[{modelId, modelName, provider, apiFormat}]}` |
| GET | `{BASE}/api/user/profile-summary` | `Bearer` | `→ {code:0, data:{totalCreditsRemaining, creditItems:[{type, creditsRemaining, expiresAt}]}}` |
| GET | `{BASE}/api/user/quota` | `Bearer` | ⚠️ **不用**：只有 `freeCreditsTotal=300`，不含活动积分（`client.go:282-283`） |

### 4.4 签到

| 方法 | 路径 | 认证 | 响应 |
|---|---|---|---|
| GET | `{BASE}/api/client-activities/slot?placement=desktop_sidebar&clientVersion={v}&containerApiVersion=2&platform=win32` | `Bearer` | `→ {code:0, data:{slotState, activity:{activityCode, configRevision}}}` |
| GET | `{BASE}/api/client-activities/{activityCode}/context?configRevision={rev}` | `Bearer` | `→ {code:0, data:{state:{claimedToday}, actions:[...]}}` |
| POST | `{BASE}/api/client-activities/{activityCode}/actions/check_in` | `Bearer` | body `{configRevision, idempotencyKey, payload:{}}` → `{code:0, data:{result:{creditsGranted\|rewardCredits\|credits}}}` |

### 4.5 客户端版本（第三方域名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update` | `→ {data:{value:{version, date, windowsX64:{url}, macIntel:{url}, macArm:{url}, changeLog:{...}}}, code:0, msg:"OK"}`；`code`/`msg` 在**外层**，`data.value` 才是载荷。版本号正则：`^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$` |

**实测响应**（本次探测，非推测）：

```json
{"data":{"value":{
   "date":"2026-9-4",
   "version":"2026.9.4",
   "windowsX64":{"url":"https://ydschool-video.nosdn.127.net/...LobsterAI-Setup-x64-2026.9.4-official.exe"},
   "macIntel":{"url":"https://ydschool-video.nosdn.127.net/...LobsterAI-darwin-x64-2026.9.4-official.dmg"},
   "macArm":{"url":"https://ydschool-video.nosdn.127.net/...LobsterAI-darwin-arm64-2026.9.4-official.dmg"},
   "changeLog":{"ch":{"title":"...","content":[...]},"en":{...}}
 },"code":0,"msg":"OK"}}
```

要点：
- 版本号形态是**日期式** `2026.9.4`（不是语义化版本），`version_key()` 的正则能正确解析；
- 同响应里**免费带安装包地址与更新日志** —— 如果做「版本过旧」提示可以直接用；
- 该域名（`api-overmind.youdao.com`）与业务域名是**不同的服务**，
  但这台机器上 `Invoke-WebRequest` 直连它曾失败（走 `web_fetch` 工具才成功），
  说明**存在网络层/证书层差异**，落地实现时**必须保留 `fallbackClientVersion` 兜底**
  （见 §3.8-C 第 1 点）。

### 4.6 统一信封

除下面两个例外，全部是 `{code, msg, data}`：

- `code !== 0` → 失败，`msg` 是原因；
- 签到/认证类接口：`data` 非对象 → 视为 `accessToken` 失效（`sigin.py:46-47`）。

**例外**：

1. `/api/proxy/v1/chat/completions` 返回**裸 SSE**，**不套信封** ——
   这是最容易搞错的一点（模型列表套信封，聊天不套）；
2. 版本接口的 `code`/`msg` 在**外层**（与 `data` 同级），成功时 `msg` 是 `"OK"`。

---

## 5. 需要改动的现有文件清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/lobsterai-product.ts` | **新建** | 低 |
| `src/lobsterai.ts` | **新建**（常量 + 凭据类型 + 纯函数） | 低 |
| `src/lobsterai-oauth.ts` | **新建**（登录） | 中 |
| `src/lobsterai-auth.ts` | **新建**（`LobsteraiAuth extends Service`） | 中 |
| `src/lobsterai-adapter.ts` | **新建**（`LobsteraiAdapter extends LlmAdapter`） | **高**（SSE/工具调用最易出错） |
| `src/lobsterai-credits.ts` | **新建**（签到 + 余额） | 中 |
| `src/lobsterai-errors.ts` | **新建**（错误分类） | 低 |
| `src/index.ts` | 注册 `llm-lobsterai` settings namespace；实例化 `lobsteraiAuth`；注册 LLM；加入 `refreshAllCredentials`；`registerJetHubRpc` 传参 | 低 |
| `src/jet-hub-rpc.ts` | `account.create` 加 lobsterai 分支；`account.refresh` 加分支（**并顺带修 2 个既有 bug**）；`registerJetHubRpc` 签名加 `lobsterai` 参数 | 中 |
| `src/types.ts` | `resolveCredentialForAccount` 返回类型加 `LobsteraiCredential`；`CreditsEndpointDeps` / `collect*` 的 product 参数放宽 | 低 |
| `src/account-pool.ts` | **几乎不用改**（provider 已是 `string`）。仅 `resolveCredentialForAccount` 的返回类型联合需要放宽 | 低 |
| `src/account-probe.ts` | **必须改**：`probeWithAdapter` 现在是 `productById(...) ? BuddyAdapter : CodeArtsAdapter`（122-134 行）—— lobsterai 会落进 **CodeArtsAdapter** 分支，用华为云 HMAC 签名去发 LobsterAI 请求，**必然失败**。加第三个分支 | **高**（正是 `account-probe.ts:118-121` 注释里记录过的同一类 bug） |
| `plugin-src/client/jet-hub.js` | `PROVIDERS` 加项 + 图标；`CREDITS_PROVIDERS` 加 `'lobsterai'` | 低 |
| `plugin-src/client/jet-hub-styles.js` | 加 `.dim-jh-providerIcon.lobsterai` | 低 |
| `package.json` | 加 `test:e2e:lobsterai*` 脚本 | 低 |
| `tests/e2e/README.md` | 加 LobsterAI 用例的消耗标注 | 低 |
| `README.md` / `AGENTS.md` | 补 LobsterAI provider 章节 | 低 |

---

## 6. 任务拆分（建议顺序）

每个任务**独立可验证**，前一个完成再开下一个。

1. **T1 — 协议层（纯函数，无网络）**
   `src/lobsterai.ts` + `src/lobsterai-product.ts` + `src/lobsterai-errors.ts`
   + `tests/unit/lobsterai.spec.ts`
   产出：凭据类型、`lobsteraiRefreshBody`、`classifyLobsteraiError`、
   19 模型兜底表。**可完整单测**。

2. **T2 — 登录**
   `src/lobsterai-oauth.ts` + `tests/unit/lobsterai-oauth.spec.ts`
   产出：`runLobsteraiLoginFlow()`，本地回调 + exchange。
   **前置**：portal 已定位为 `https://lobsterai.youdao.com`（§0.2b），可直接开工。
   **建议先做的事**：给 `lobsterai2api` 补上两个 env 跑一次 `login.sh`
   （见 §7.1b R10），拿真实的 `auths/*.json` 作为对照样本 ——
   这样 `exchange` 的响应字段（尤其 `user.id` / `user.yid` 的实际取值形态）
   就有权威参照，不必靠猜。

3. **T3 — 服务层**
   `src/lobsterai-auth.ts`（`LobsteraiAuth extends Service`）
   产出：`login` / `status` / `refresh` / `logout` / `refreshAll`。

4. **T4 — 适配器**
   `src/lobsterai-adapter.ts` + `src/index.ts` 注册
   产出：能在 DSH 里选到 LobsterAI 模型并发起对话。
   **最重的一个任务**，建议 T1-T3 全绿后再开。

5. **T5 — 签到与余额**
   `src/lobsterai-credits.ts` + RPC 接线
   产出：Jet Hub 面板的「一键领取积分」与积分余额行。

6. **T6 — Jet Hub UI**
   `plugin-src/client/jet-hub.js` + `jet-hub-styles.js`
   产出：第四个 provider tab。

7. **T7 — 收尾**
   修 `account-probe.ts` 分支 + `account.refresh` 的 2 个既有 bug；
   `tests/e2e/`；README / AGENTS.md 更新。

---

## 7. 风险与未决问题

### 7.1 原本需要人工确认的（**已基本解决**）

| # | 问题 | 状态 | 结论 |
|---|---|---|---|
| R1 | **登录 portal 的 URL 是什么？** | ✅ **已定位** | `https://lobsterai.youdao.com`（实测 200，标题「LobsterAI - 全场景个人助理 Agent」，与 API 域名同 IP）。推导过程见 §0.2b。**剩余风险**：`#/login` hash 路由需真实浏览器点击才能验证完整闭环（`source=electron` 是否被接受、`redirect_uri` 是否被校验、是否真带 `code` 跳回）—— 归入 T2 的 E2E |
| R2 | `clientVersion` 当前真实值 | ✅ **已实测** | `2026.9.4`（`api-overmind` 接口实测，见 §0.2-5 / §4.5）。**注意 Go 侧的 `0.1.0` 是假值**，本插件必须动态拉取 |
| R3 | 新版客户端是否改变了 `placement=desktop_sidebar` 等签到参数 | ⚠️ 待验证 | 不阻塞：先照抄 `sigin.py`，E2E 验证。客户端已更新到 `2026.9.4`，而 `sigin.py` 的观察时间更早，**这个风险是实打实的** |

### 7.1b 因为「回归分析」而新增的风险

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| R10 | `lobsterai2api` 的**登录链路当前跑不通**（`login.sh` 不设必需的 env），无法用它做「黄金路径」对照测试 | 中 | 临时 `export LB2A_UPSTREAM_BASE=https://lobsterai-server.youdao.com` + `export LB2A_LOGIN_PORTAL=https://lobsterai.youdao.com` 后，`login.sh` 应可运行。**建议先这样跑一次，得到真实的 `auths/*.json` 作为本插件 T2 的对照样本** |
| R11 | `clientVersion` 发错值（`0.1.0`）却未被后端拒绝 | 低（反向收益） | 说明后端对 `version` **不强校验**。本插件动态取真值即可，不必为兼容而保留假值 |
| R12 | `api-overmind.youdao.com` 存在网络层差异（本机直连失败、经代理成功） | 中 | 版本号拉取**必须有兜底**（见 §3.8-C 第 1 点），且失败不能阻塞签到以外的功能 |

### 7.2 需要实测才能定的（阻塞 T4 的完善，但不阻塞开工）

| # | 问题 | 保守做法 |
|---|---|---|
| R4 | 是否支持 `reasoning_effort` / 思考等级？ | **不声明** `resolveModel().reasoning`，等实测 |
| R5 | 各模型真实上下文窗口？ | 用 131072（桥接层静态值），注释标明是猜测 |
| R6 | 是否接受 `prompt_cache_key`？ | **不发** |
| R7 | `tool_choice` 归一化是否必需？ | **照做**（`prepareChatBody` 的做法，无害） |
| R8 | 图片输入是否支持？ | **不支持**，`inputModalities: ['text']` |
| R9 | 429 错误体的「重置时间」格式是否与 CodeBuddy 相同？ | 先复用 `parseRateLimitError`，实测后再调整 |
| R13 | `User-Agent` 该不该跟着真版本改成 `LobsterAI/2026.9.4`？ | **先照抄 `LobsterAI/0.1.0`**（Go 侧实测可用的值），只改 `X-LobsterAI-Client-Version` 头。UA 变更需单独实测，避免同时改两个变量导致无法归因 |
| R14 | 登录换来的 `accessToken` 是否 JWT（可否解 `exp`）？ | Go 注释说「实测 HS512 access token 30 天」，说明是 JWT。**但要有 `expiresIn` 优先、JWT 兜底的顺序**（对齐 `main.go:313-319`），且两者都拿不到时按「不可刷新」处理而非崩溃 |

### 7.4 与 `lobsterai2api` 的一致性审计（实施后回查）

实施完成后逐条核对了与参考实现的行为一致性，发现并修正了 **4 处实现层缺陷**
（均由本插件引入，非参考实现的问题），另有 2 处**保留的有意分歧**。

#### 已修正的缺陷（对齐 Go）

| # | 缺陷 | Go 依据 | 修正 |
|---|---|---|---|
| C1 | `resolveLobsteraiUid` 在 `yid` 与 `sha256` 之间多插了一级 **JWT `sub`** 回退 | `main.go:297-306` 只有四级 | 删除该级。否则「服务端 user 字段皆空」的账号在本插件得 `sub`、在 Go 得 16 位哈希，**同一账号两种 uid**，破坏与 `auths/lobsterai-{uid}.json` 对照的能力 |
| C2 | 适配器的换号条件只含 `hard-credit` / `soft-rate`，**404 / 5xx / client 直接抛给用户** | `handler.go:218-243` 的 switch **每个分支都以 `continue` 结尾**（含 `ErrNotFound`、default），注释明写「轮转下一个账号，不直接返回（防雪崩）」 | 改为 `shouldRotateLobsteraiAccount(kind)` = 「非成功即换号」，并把 exhausted 文案改为带真实原因 |
| C3 | `shouldRotateLobsteraiAccount` / `isLobsteraiCreditExhausted` 是**死代码**（零调用点），适配器走内联条件 —— 策略声明与实际行为分叉 | — | 适配器改为真正调用该谓词；删除无调用者的 `isLobsteraiCreditExhausted`；新增 `recordsLobsteraiRateLimit` 区分「换号」与「记徽章」 |
| C4 | 余额未 clamp 负值 | `client.go:303-308`、`cmd/credit/main.go:91-96` 都有 `if v < 0 { return 0 }` | `total` 与 `expiredTotal` 均 `Math.max(0, …)`，避免显示「-12.5 积分」 |

> **C2 的附带修正**：原实现给**所有**换号场景都写限流徽章，但 Go 只对三类
> 真正 `Cooldown`（`hard-credit` → 12h、`soft-rate` / `not-found` → 60s），
> `session-dead` 走 `Disable`、default 走 `NoteError`，**都不写冷却时间**。
> 现已收敛为 `recordsLobsteraiRateLimit` —— 否则一个 400 请求错误会被显示成
> 「该模型限流 1 小时」，那是**虚假信息**。

#### 保留的有意分歧（已在文档中标注理由）

| # | 分歧 | Go | 本插件 | 理由 |
|---|---|---|---|---|
| D-a | `latest_keyfrom` 是否随续期更新 | **不更新**（`client.go:137-145` 只改 token 与过期时间） | 同样**不更新**（原实现曾更新为当前时刻，现已改回） | 语义上「刷新即活动」更直觉，但 Go 是唯一生产验证过的实现。若服务端校验该字段，自作聪明地更新会让续期失败 —— 这需要实测支撑，不能从代码推导 |
| D-b | 续期终态判定 | 只判「响应里有没有 accessToken」，把网络抖动也当终态 | `HTTP 401/403` 或 `code ∈ {40100, 40101}` 才判终态 | 误判会让用户被迫重新登录；本插件的判定更窄，其余错误走可重试路径 |
| D-c | `version` 字段取值 | 硬编码假值 `0.1.0`（`auth.go:41`） | 动态真值（实测 `2026.9.4`） | `0.1.0` 是假值（`sigin.py` 会动态取），后端未强校验才未暴露 |
| D-d | 自动冷却 / 禁用状态机 | `Cooldown` / `Disable` / `NoteError` 计数 | 不移植，复用 `modelRateLimits` + 用户手动重测 | 见 D2；**注意「轮转」与「冷却」是两件事** —— 本插件采纳前者（对齐 Go）、不用后者 |

#### 第二轮：独立审查发现的缺陷（同一批次的更深问题）

首轮自查通过后，另起一个独立 reviewer 做对抗性审查，又发现 **4 个严重 + 4 个中等**。
这批问题**在首轮 763 项测试全绿的情况下依然存在** —— 其价值恰在于此。

| # | 缺陷 | 证据 | 修正 |
|---|---|---|---|
| S1 | 适配器从**账号池**取凭据，`refresh` 回调却刷**默认单凭据 ref** | 实跑：`refresh 目标是 LOBSTERAI_ACCESS_TOKEN；池凭据 token 仍是 POOL-AT`。症状：池凭据过期 → 刷新成功但回写到**另一个** ref → 再 resolve 仍拿到过期凭据 → 401；**续期日志全绿，用户却一直认证失败** | `index.ts` 的 `refresh` 改为先 `getAvailableAccount` 再 `refreshAccountCredential(该账号 ref)`；与 Go 一致（`handler.go:197-209` 也是 Pick 出账号后对该账号 `RefreshToken(acct)`） |
| S3 | 换号耗尽后**错误码跨账号错配**：`kind` 循环外只算一次，`errorText`/`response` 每轮覆盖 | 实跑：`A=402(积分不足) B=503 → 最终 code=SERVER`，用户完全看不到真实原因 | 循环内同步维护 `lastStatus`/`lastKind`/`errorText` 成组状态，最终错误用它们构造 |
| S4 | 换号循环给**错误的账号**写限流徽章（用循环外的 kind，而 `currentAccountId` 已推进到下一个账号） | 实跑：A=429 换成 B、B=404 → A、B 都写。B 写对**纯属巧合**（soft-rate 与 not-found 恰好都 true）；**若 B 是 5xx 就会给 B 写「该模型限流 1 小时」** | 改用**本轮**的 `lastKind`；测试锁定「A=429/B=500 只写 A」等三种组合 |
| S2 | `latest_keyfrom` 的对齐修复曾在 `e2d9362` 生效，被 `a0319d5` **无声丢失**，`9e34754` 才恢复 | 该行取值逐提交追踪：`bb9cc92`=Date.now() → `e2d9362`=存储值 → **`a0319d5`=Date.now()** → `9e34754`=存储值。`a0319d5` 只删了一个临时文件、没碰该文件，说明是**工作区被覆盖后夹带** | 已由 `lobsterai-parity.spec.ts` 覆盖（实跑：改回 `Date.now()` 会 3 项失败） |

**中等项**：

| # | 问题 | 修正 |
|---|---|---|
| M1 | SSE 的 `message` 回退缺 `gotAnyContent` 守卫 → 内容重复拼接（实跑 `'AM'`，Go 是 `'A'`） | 补 `gotAnyContent` 标志，对齐 `sse.go:72,98` |
| M3 | `LOBSTERAI_PROFILE_SUMMARY_PATH` 在两处重复定义，前者零引用 | 只保留 `lobsterai-credits.ts` 一处，并加断言防止重复定义回归 |
| M4 | `refreshAll` 对非终态失败**完全静默**（不记日志、不更新状态） | 补 `logger.warn`。注：`buddy-auth.ts` 有同样的静默问题，属既有实现，**本次不改动其行为** |
| U2 | 换号**无次数上限**，而 Go 有 `MaxRotate=3`（`handler.go:190` 防雪崩） | 加 `LOBSTERAI_MAX_ROTATE`；注意 Go 的循环**含首个账号**，而适配器在进入循环前已请求过一次，故实际取 `MaxRotate - 1` |

> **为什么首批测试全绿却漏掉这些**（这条比缺陷本身更有价值）：
> - **S1** 是**接线层**错配 —— 所有 adapter 测试都注入同一个固定
>   `resolveCredential`，从不模拟「resolve 从池取、refresh 动另一个 ref」。
>   需要**集成级**测试才能发现（已在 `lobsterai-wiring.spec.ts` 补齐）。
> - **S3/S4** 需要构造「首账号错误类别 ≠ 末账号错误类别」；原用例只让一个账号失败。
>   补的用例虽让两轮错误体不同（429/402），但**只断言了 `message`、没断言 `code`**
>   —— 而错配恰恰只在 code/status 上。**那个测试通过本身给了「此处已验证」的错觉**，
>   这是最值得记取的教训。
> - **M1** 只测了「仅有 message」，没测「delta 与 message 混发」。

#### 一致性契约测试

上述每一条都固化在测试里，且**每条都做过反向验证**（把缺陷改回去、确认测试确实失败）：

| 文件 | 覆盖 |
|---|---|
| `tests/unit/lobsterai-parity.spec.ts` | 24 项与 Go 的行为对齐契约（每条标注 Go 依据位置） |
| `tests/unit/lobsterai-review-fixes.spec.ts` | S3/S4/U2/M1（10 项），含跨账号错配与混发形态 |
| `tests/unit/lobsterai-wiring.spec.ts` | S1 接线层（3 项），走真实接线而非固定桩 |
| `tests/unit/lobsterai-rotation-exhaustion.spec.ts` | 耗尽路径的诊断完整性（2 项） |

### 7.5 架构层面的取舍（需要你确认）

| # | 取舍 | 推荐 |
|---|---|---|
| D1 | 是否把 LobsterAI 塞进 `BuddyProduct`？ | **不**。独立 `LobsteraiProduct`（§0.4） |
| D2 | 是否照搬 Go 的自动冷却/禁用状态机？ | **不**。复用现有 `modelRateLimits` + 用户手动重测（§3.6） |
| D3 | 是否按积分选号？ | **不**（v1）。可选增强见 §3.7 |
| D4 | 是否做自动签到？ | **不**（v1）。与 CodeBuddy 面板语义保持一致（§3.10） |
| D5 | 是否跑 Go 反代作为前置？ | **不**。翻译成 TS 适配器（§0.3） |
| D6 | 是否修 `account.refresh` 的 2 个既有 bug？ | **修**。顺路，且不加会误以为 lobsterai 刷新也坏 |

---

## 附：本次分析读过的文件

**`lobsterai2api`（全部源文件）**
`README.md`（含 `1c4cf41` 未脱敏原始版对照）/ `config.example.json` / `go.mod` /
`.gitignore` / `login.sh`（逐行拆解见 §3.2）/ `credit.sh` / `sigin.py`（未跟踪）/
`cmd/login/main.go` / `cmd/server/main.go` / `cmd/server/config.go` /
`cmd/credit/main.go` / `internal/auth/auth.go` / `internal/pool/pool.go` /
`internal/scheduler/scheduler.go` / `internal/server/handler.go` /
`internal/upstream/client.go` / `internal/upstream/classify.go` /
`internal/upstream/sse.go`

**另**：git 全历史 diff（`1c4cf41` / `734e3db` / `a08ce1f` / `fe299f1`）、
DNS 解析与 HTTP 实测（portal / API / 更新接口，见 §0.2、§0.2b、§4.5）。

**本插件**
`src/index.ts` / `src/product.ts` / `src/buddy.ts` / `src/buddy-auth.ts` /
`src/buddy-oauth.ts` / `src/buddy-adapter.ts` / `src/credits.ts` /
`src/account-pool.ts` / `src/account-probe.ts` / `src/jet-hub-rpc.ts` /
`src/types.ts` / `src/service.ts` / `src/login.ts` / `src/refresh.ts` /
`src/sse.ts` / `src/llm-adapter.ts`（节选）/ `plugin-src/client/jet-hub.js` /
`plugin-src/client/jet-hub-styles.js` / `plugin-src/client/index.js` /
`README.md` / `AGENTS.md` / `package.json` / `tests/e2e/README.md`
