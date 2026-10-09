# 添加一个新的 LLM Provider

> 版本：v1.0 · 基于 `dsh-codearts-auth` 插件架构
> 对应源码入口：`src/index.ts` · 项目 AGENTS.md

## 概述

本插件已集成了四个 LLM Provider，属于**两种不同的架构脉系**：

| 脉系 | Provider | 特点 |
|------|----------|------|
| **CodeBuddy 系** | `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy 国际版） | 同源：共用同一 CLI 内核、同一认证协议（external-link 轮询式）、同一 chat 端点格式，差异全部收敛在 `BuddyProduct` |
| **LobsterAI 系** | `lobsterai`（有道龙虾） | 不同源：完全独立的登录协议（本地回调 + authCode 换 token）、独立请求头（`X-LobsterAI-Client-*`）、独立签到协议 |

因此你要添加的 provider 如果属于**已有脉系**（比如再加一个腾讯系产品），只需加一份 `BuddyProduct` 配置并注册实例；如果是**全新的脉系**（全新的API协议、认证方式、签到流程），需要仿照 LobsterAI 创建一套独立但遵循相同架构模式的实现。

---

## 两种路径速览

### 路径 A：添加同源产品（已有脉系加点）

如果你要添加的 provider 与 CodeBuddy/WorkBuddy **共用同一协议**（例如另一个腾讯系IDE产品），只需：

```
┌─ 加 product.ts 的产品常量 → 在 index.ts 注册实例 → 在 jet-hub-rpc.ts 加分派分支
```

详见 §「路径 A：同源产品」。

### 路径 B：添加不同源产品（全新脉系）

如果你要添加的 provider **协议完全不同**（自定义认证、自定义请求头、自定义签到），需要：

```
┌─ product.ts (或 xxx-product.ts)       ← 产品配置唯一真相源
├─ xxx.ts                              ← 协议常量、凭据结构、纯函数
├─ xxx-auth.ts                         ← 认证服务 (Service 子类)
├─ xxx-adapter.ts                      ← LLM 适配器 (LlmAdapter 子类)
├─ xxx-oauth.ts                        ← 登录流程
├─ xxx-credits.ts                      ← 签到/积分（可选）
├─ xxx-errors.ts                       ← 错误分类（可选）
├─ index.ts                            ← 注册入口
├─ jet-hub-rpc.ts                      ← RPC 分派
├─ 单测 + E2E
└─ 客户端更改 (credits-capabilities.js)
```

详见 §「路径 B：不同源产品」。

---

## 架构核心概念

在动手之前，先理解本插件的**架构骨架**。

### 1. 三层模型

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│ 产品配置层   │────→│  认证服务层   │────→│  LLM 适配器 │
│ product.ts  │     │  xxx-auth.ts │     │ xxx-adapter│
│（差异收敛）  │     │（登录/续期）  │     │（对话转发） │
└─────────────┘     └──────────────┘     └────────────┘
                           │
                           ↓
                     ┌──────────────┐
                     │  账号池      │
                     │ account-pool │
                     │（多账号管理） │
                     └──────────────┘
```

- **产品配置层**：把不同产品的差异收敛到唯一的配置对象中（如 `BuddyProduct` 的 endpoint、userAgent、productCode）。这是"为什么两个同源产品只用一套代码"的秘密。
- **认证服务层**：继承 `cordis/Service`，管理登录流程、凭据存储、静默续期（`RefreshScheduler`）、批量续期（`refreshAll`）。
- **LLM 适配器层**：继承 `LlmAdapter`，负责模型目录播报（`listModels`）、模型解析（`resolveModel`）、流式对话转发（`stream`）。

### 2. 双文档系统与凭据分离

```
凭据本体: ctx.credentials (加密存储)    ← 令牌/refresh_token
账号索引: ctx.settings → jet-hub ns    ← 账号列表/黑名单/顺序
```

- 凭据本体通过 `ctx.credentials.set(ref, JSON.stringify(credential))` 存储
- 账号索引（账号列表、模型黑名单、拖拽排序）存在 `ctx.settings` 的 `jet-hub` namespace 下
- 两者通过 `credentialRef` 字段关联

### 3. 续期不得按 enabled 过滤

```
refreshAll() 只看 refreshable，不看 enabled
停用只影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关
```

这是**真实缺陷**的教训。详见 AGENTS.md 的「续期不得按 enabled 过滤」章节。

### 4. 两步式登录（"+ 新建账号"）

```
account.create 必须在用户授权完成之前返回 loginUrl
前端立即 window.open，后台异步等回调
```

**不是风格偏好，是浏览器硬约束**：`window.open` 只在 transient activation 窗口内有效。详见 AGENTS.md。

---

## 路径 A：添加同源产品（如另一个腾讯系产品）

假设你要添加一个新产品 **`buddy-eu`**（腾讯 CodeBuddy 欧洲版），与现存的 CodeBuddy/WorkBuddy 同源。

### A1. 定义产品配置（`src/product.ts`）

```typescript
// 添加到 src/product.ts

export const BUDDY_EU: BuddyProduct = {
  id: 'buddy-eu',                          // provider 标识
  platform: 'ide',                          // auth/state 的 platform
  endpoint: 'https://copilot-eu.tencent.com', // 不同区域不同域名
  apiDomain: 'copilot-eu.tencent.com',
  displayName: 'CodeBuddy (欧洲版)',
  productCode: 'buddy-eu',
  userAgent: 'CodeBuddyIDE/1.200.0',
  attributionName: 'CodeBuddy EU',
  clientVersion: '1.200.0',
  cliVersion: '2.200.0',
  defaultCredentialRef: 'BUDDY_EU_ACCESS_TOKEN',
  appendSessionParams: false,              // 与 CodeBuddy 中国版一致
  fallbackModels: BUDDY_EU_FALLBACK_MODELS, // 欧洲版模型池（需实测）
}

export const ALL_PRODUCTS: readonly BuddyProduct[] = [CODEBUDDY, WORKBUDDY, BUDDY_EU]
//                                                 ↑ 加入此处
```

**要点**：
- `id` 不能与现有产品重复（`'buddy'` / `'workbuddy'`）
- `defaultCredentialRef` 用大写的 provider id 前缀（`BUDDY_EU_ACCESS_TOKEN`）
- `fallbackModels` 来自服务端 `/v3/config` 的实际模型池，**不要照抄中国版或国际版**
- `ALL_PRODUCTS` 数组必须包含新常量，否则 `productById()` 找不到它

### A2. 注册 provider 实例（`src/index.ts`）

```typescript
// 1. 注册 settings namespace（与 registerProviderSettings 的调用保持一致）
registerProviderSettings(ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai', 'llm-buddy-eu')

// 2. 创建认证服务实例
const buddyEu = new BuddyAuth(ctx, { product: BUDDY_EU })

// 3. 注册 LLM 适配器
registerBuddyLlm(ctx, {
  credentialRef: credentialRef(BUDDY_EU.defaultCredentialRef),
  resolveCredential: async () => {
    const available = await pool.getAvailableAccount('buddy-eu', '')
    if (available) return available.credential as BuddyCredential
    const resolved = await ctx.credentials.resolve(credentialRef(BUDDY_EU.defaultCredentialRef))
    if (!resolved) return undefined
    try { return JSON.parse(resolved.value) as BuddyCredential } catch { return undefined }
  },
  refresh: () => buddyEu.refresh(),
  fetchRemoteModels: () => buddyEu.fetchModels(pool),
  readImage: makeReadImage(ctx),
  accountPool: pool,
  product: BUDDY_EU,
})

// 4. 加入批量续期调度
async function refreshAllCredentials(): Promise<void> {
  // ... 现有代码 ...
  try { await buddyEu.refreshAll(pool) } catch { /* 静默 */ }
}
```

**要点**：
- `settingsNs` 格式为 `llm-${product.id}`，即 `llm-buddy-eu`
- 调用方显式传 `product: BUDDY_EU`，让 `BuddyAuth` 实例知道自己是哪个产品
- 服务名由 `BuddyAuth` 按 `product.id` 派生为 `buddyEuAuth`

### A3. 在 RPC 中加分派分支（`src/jet-hub-rpc.ts`）

在 `account.refresh` 的 switch 和 `account.create` 的分支中添加：

```typescript
// account.refresh
case 'buddy-eu':
  // ⚠⚠ **必须传 pool + entry.id**（issue IKIRTT）：续期后要把新的 expiresAt 回写
  // 账号池条目，否则凭据续好了、UI 一直显示「已过期」，用户没有自救手段。
  // 这两个参数是**可选**的，漏传**能编译、类型全绿**，但会静默丢回写 ——
  // `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 case 扫这条不变式。
  await buddyEu.refreshAccountCredential(entry.credentialRef, pool, entry.id)
  break

// account.create —— 与 buddy/workbuddy 共用 productById 分支，无需改动
// 但需在 registerJetHubRpc 签名中增加 buddyEu 参数，并传入
```

⚠ **不要**在 `account.refresh` 的 catch 里回 `ok:true` + `value.success:false`：
客户端 `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`，
只判 `ok` 的调用方会把续期失败读成成功（issue IKJOZA，真实代价是 18 次里 17 次失败
被显示成「✅」）。**判据**：catch 里的失败若**没有**额外的判别字段（`done` /
`results[]` 之类），就是业务终态，必须回 `ok:false + error:{code:'bad-request', message:<原异常文案>}`。

⚠ 本端点**没有面板入口** —— 账号卡片上并没有「刷新」按钮，调用方是仓库外的
脚本/手工 RPC（issue IKJOZA 取证）。

### A4. 客户端侧

`plugin-src/client/credits-capabilities.js` 中添加：

```javascript
buddy_eu: Object.freeze({ balance: true, dailyCheckin: true }),
```

并在 `jet-hub.js` 的 provider 渲染逻辑中加入新 provider 的面板（如果它在 UI 上有独立面板的话）。

---

## 路径 B：添加不同源产品（全新脉系）

假设你要添加一个全新的 provider **`deepseek-official`**（假设它有不同于现有协议的 API）。这是最完整的路径。

### B0. 目录结构

```
src/
├── deepseek-official-product.ts    ← 产品配置常量（参考 lobsterai-product.ts）
├── deepseek-official.ts            ← 协议常量、凭据结构、纯函数（参考 lobsterai.ts）
├── deepseek-official-auth.ts       ← 认证服务（参考 lobsterai-auth.ts）
├── deepseek-official-adapter.ts    ← LLM 适配器（参考 lobsterai-adapter.ts）
├── deepseek-official-oauth.ts      ← 登录流程（参考 lobsterai-oauth.ts）
├── deepseek-official-credits.ts    ← 签到/积分（可选，参考 lobsterai-credits.ts）
├── deepseek-official-errors.ts     ← 错误分类（可选，参考 lobsterai-errors.ts）
```

### B1. 定义产品配置（`src/deepseek-official-product.ts`）

```typescript
import type { LobsteraiProduct } from './lobsterai-product.js'  // 或自建接口

export interface DeepseekOfficialProduct {
  id: 'deepseek-official'   // provider 标识
  displayName: string
  apiBase: string           // API 基址
  portalBase?: string       // 登录门户（可选）
  userAgent: string
  defaultCredentialRef: string
  fallbackModels: readonly DeepseekOfficialFallbackModel[]
}

export const DEEPSEEK_OFFICIAL: DeepseekOfficialProduct = {
  id: 'deepseek-official',
  displayName: 'DeepSeek Official',
  apiBase: 'https://api.deepseek.com',
  userAgent: 'DeepSeek/1.0.0',
  defaultCredentialRef: 'DEEPSEEK_OFFICIAL_ACCESS_TOKEN',
  fallbackModels: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000 },
  ],
}
```

**关键决策**：是否需要新建 `DeepseekOfficialProduct` 接口，还是可以复用 `LobsteraiProduct`？
- 如果新 provider 的 API 形态与 LobsterAI **非常相似**（如都是 Bearer 认证 + 无签名 + 无归属头），可以考虑复用 `LobsteraiProduct`（更名或泛化）
- 如果协议完全不同，**新建独立接口**更好（避免 `LobsteraiProduct` 里不需要的字段污染新 provider）

### B2. 协议常量与凭据（`src/deepseek-official.ts`）

```typescript
// 端点路径
export const DEEPSEEK_CHAT_PATH = '/v1/chat/completions'
export const DEEPSEEK_MODELS_PATH = '/v1/models'
export const DEEPSEEK_REFRESH_PATH = '/v1/auth/refresh'  // 如果有的话

// 请求超时
export const REQUEST_TIMEOUT_MS = 30_000

// ── 凭据结构 ──
export interface DeepseekOfficialCredential {
  access_token: string       // 与 AccountPool.findAccountIdByCredential 一致
  refresh_token?: string
  expires_at?: string
  uid?: string
  nickname?: string
  // 其他必要字段（如 session_id、api_key 等）
}

// ── 过期判定 ──
export function credentialExpiresAtMs(cred): number | undefined { /* ... */ }
export function isExpired(cred): boolean { /* ... */ }
export function isRefreshable(cred): boolean { /* ... */ }

// ── 请求头构造 ──
export function authHeaders(cred, product): Record<string, string> { /* ... */ }
```

**规则**（照此检查你的实现）：
- 凭据结构必须含 `access_token` 字段 —— `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider 统一取此字段作身份标识
- `expires_at` 统一存毫秒时间戳字符串（便于复用 `credentialExpiresAtMs` 的解析逻辑）
- 纯函数（无网络副作用），可完整单测

### B3. 认证服务（`src/deepseek-official-auth.ts`）

继承 `cordis/Service`，以 `lobsterai-auth.ts` 为模板：

```typescript
export class DeepseekOfficialAuth extends Service {
  readonly product: DeepseekOfficialProduct
  readonly credentialRefName: string
  private readonly scheduler = new RefreshScheduler(/* ... */)

  constructor(ctx, options?) {
    const product = options.product ?? DEEPSEEK_OFFICIAL
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  // 必须实现的核心方法：
  async login(flowOptions?): Promise<LoginResult>
  async startLogin(flowOptions?): Promise<{ loginUrl, result, close }>  // 两步式
  async status(): Promise<LoginStatus>
  async refresh(): Promise<void>
  async refreshAccountCredential(refName: string): Promise<void>
  async refreshAll(pool: AccountPool): Promise<void>  // 批量续期
  async logout(): Promise<void>
  async fetchModels(pool?): Promise<RemoteModel[]>
  async scheduleRefresh(): void
  async checkExpired(): Promise<boolean>
}
```

**必须遵守的契约**：
| 方法 | 要求 |
|------|------|
| `refreshAll` | **只看 `refreshable`，不看 `enabled`**（见 AGENTS.md「续期不得按 enabled 过滤」） |
| `startLogin` | 立即返回 `loginUrl`，后台异步 await 回调（见「两步式登录」） |
| `refreshAccountCredential` | 读写指定的 ref，不碰默认单凭据 ref |
| `login` / `startLogin` | 成功后必须调 `scheduleRefresh()` + `pool.addAccount()`（两步式先登记占位条目） |

### B4. LLM 适配器（`src/deepseek-official-adapter.ts`）

继承 `LlmAdapter`，以 `lobsterai-adapter.ts` 为模板：

```typescript
export class DeepseekOfficialAdapter extends LlmAdapter {
  private readonly product: DeepseekOfficialProduct

  // 必须实现的 4 个方法：
  providerInfo(provider: string): LlmProviderInfo
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider: string, model: string, signal?): Promise<LlmResolvedModelInfo>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>

  // 建议实现（兼容新版 DSH）：
  prepareCall(provider, model, signal?): Promise<{ model, stream }>
}
```

**4 个关键决策点**（参照 lobsterai-adapter 与 buddy-adapter 的对比）：

1. **`stream()` 是否恒为 true**？上游是否只支持 SSE？
2. **图片支持**：按模型判定（`remoteMeta.get(model)?.supportsImage`）还是按 provider 一刀切？
3. **思考等级（reasoning_effort）**：是否主动补档（如 buddy 的 deepseek 系必须补档否则不思考），还是只透传？
4. **`prompt_cache_key`**：上游是否支持前缀缓存？

这些问题**不能从代码推理，必须凭实测回答**。在实现文档中应标注 `TBD` 并安排 E2E 验证。

**SSE 消费的共享工具**（`src/sse.ts`）：
- `readWithIdleTimeout` —— 带空闲超时的流读取（所有适配器共用）
- `resolveToolPairing` —— 孤儿工具调用清理（所有适配器共用）
- `normalizeToolArguments` —— 参数归一化（所有适配器共用）
- `isTruncatedArguments` —— 截断判定（所有适配器共用）

### B5. 入口注册（`src/index.ts`）

```typescript
import { DEEPSEEK_OFFICIAL } from './deepseek-official-product.js'
import { DeepseekOfficialAuth } from './deepseek-official-auth.js'
import { registerDeepseekOfficialLlm } from './deepseek-official-adapter.js'

// 1. 注册 settings namespace
registerProviderSettings(ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai', 'llm-deepseek-official')

// 2. 创建认证服务
const deepseekOfficial = new DeepseekOfficialAuth(ctx)

// 3. 注册 LLM 适配器
registerDeepseekOfficialLlm(ctx, {
  credentialRef: credentialRef(DEEPSEEK_OFFICIAL.defaultCredentialRef),
  resolveCredential: async () => {
    const available = await pool.getAvailableAccount(DEEPSEEK_OFFICIAL.id, '')
    if (available) return available.credential as DeepseekOfficialCredential
    // ... 回退到单凭据
  },
  refresh: async () => {
    // ... 先池后单凭据，与 lobsterai 同理
  },
  fetchRemoteModels: () => deepseekOfficial.fetchModels(pool),
  readImage: makeReadImage(ctx),
  accountPool: pool,
  product: DEEPSEEK_OFFICIAL,
})

// 4. 加入批量续期
async function refreshAllCredentials(): Promise<void> {
  // 现有...
  try { await deepseekOfficial.refreshAll(pool) } catch { }
}
```

**要点**：
- `settingsNs` = `llm-${product.id}` = `llm-deepseek-official`
- 服务名由 Service 构造时自动派生为 `deepseekOfficialAuth`
- `registerDeepseekOfficialLlm` 最终调用 `ctx.llm.registerConfigurableProviders(...)` + `ctx.llm.registerAdapter(...)`，与现有 `registerBuddyLlm` / `registerLobsteraiLlm` 格式一致

### B6. 注册 RPC 分派（`src/jet-hub-rpc.ts`）

`registerJetHubRpc` 需新增新 provider 的 auth 实例参数，并在以下位置加分派：

```typescript
// 1. 函数签名增加参数
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  deepseekOfficial: DeepseekOfficialAuth,  // 新增
): void { ... }

// 2. account.create —— 加新分支
if (provider === 'deepseek-official') {
  const started = await deepseekOfficial.startLogin({ refName })
  // ... 占位条目 + 异步回调
}

// 3. account.refresh —— switch 加新 case
//    ⚠ 必须传 pool + entry.id，否则 expiresAt 不回写账号池（issue IKIRTT，见 A3）
case 'deepseek-official':
  await deepseekOfficial.refreshAccountCredential(entry.credentialRef, pool, entry.id)
  break

// 4. credits.* —— 加新分支（如有积分能力）
//    credits.status / credits.claimAll / credits.balances 各加一个分支
```

### B7. 积分能力（`plugin-src/client/credits-capabilities.js`）

在 `CREDITS_CAPABILITIES` 中登记新 provider 的两项能力：

```javascript
export const CREDITS_CAPABILITIES = Object.freeze({
  codearts: Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: true }),
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  'deepseek-official': Object.freeze({ balance: false, dailyCheckin: false }),  // 新增
});
```

**规则**：
- **默认关闭**：未登记的 provider 视为两项全无。忘登记时最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- 两个能力彼此独立，不能互相推断
- 如果新增 provider 有积分能力，请在 `src/` 下按 `lobsterai-credits.ts` / `codearts-credits.ts` 的格式实现

### B8. 模型黑名单（`AccountPool.disabledModelsFor`）

**不需额外操作**。`AccountPool` 的 `disabledModelsFor(provider)` 已按 provider 隔离，新 provider 的模型开关自动独立存储。

### B9. 单测与 E2E

| 测试 | 粒度 | 文件位置 |
|------|------|---------|
| 纯函数单测 | 验证 `credentialExpiresAtMs` / 请求头构造 / 信封解析 | `tests/unit/` |
| Auth 服务单测 | 登录 / 续期 / 状态 / 登出 | `tests/unit/` |
| 适配器单测 | 消息序列化 / SSE 解析 | `tests/unit/` |
| E2E 登录探针 | 打开浏览器 + 授权 + 验证 exchange | `tests/e2e/`（**默认跳过，需 DSH_*_E2E 环境变量**） |
| E2E 模型列表 | 远端模型目录 | `tests/e2e/` |
| E2E 签到探针 | 积分领取流程（可选） | `tests/e2e/` |

### B10. 文档

- 修改 `src/product.ts`（或新 product 文件）的 module header，记录新 provider 的数据来源与关键决策
- 在项目 `README.md` 的「工作方式」和「Provider」章节补充新 provider
- 如有特殊坑点（如 LobsterAI 的 `X-LobsterAI-Client-Capabilities` 头），在 AGENTS.md 中记录

---

## 通用检查清单

无论路径 A 还是路径 B，添加完成后对照以下清单自检：

### 编译构建

- [ ] `pnpm typecheck`（TypeScript 类型检查）通过
- [ ] `pnpm build:all`（tsc + esbuild 客户端打包）通过

### `src/index.ts` 

- [ ] settingsNs 已注册（`registerProviderSettings` 调用中加入了新 namespace）
- [ ] 认证服务已创建（`new SomethingAuth(ctx)`）
- [ ] LLM 适配器已注册（`registerSomethingLlm(ctx, ...)`）
- [ ] 批量续期已加入（`refreshAllCredentials` 中的 try/catch）
- [ ] Jet Hub RPC 已传入（`registerJetHubRpc` 参数）
- [ ] `ctx.effect` 的 cleanup 包含新服务的 `stop()`

### 续期与账号池

- [ ] `refreshAll()` **只按 `refreshable` 过滤，不看 `enabled`**（真实缺陷教训）
- [ ] `refreshAccountCredential(refName, pool, accountId)` 读写指定 ref，不碰默认单凭据 ref（否则 Jet Hub 续期刷错凭据）
- [ ] `getAvailableAccount` 调用时传入 `this.product.id`（而不是写死字面量；WorkBuddy 踩过坑）

### 两步式登录

- [ ] `account.create` 分支立即返回 `loginUrl`（不阻塞等待授权完成）
- [ ] 先登记**占位账号条目**（无凭据），使前端 `login.poll` 能检测到
- [ ] 异步回调完成后再回填真实凭据
- [ ] 异步回调失败时**删除占位条目**（不留幽灵账号）
- [ ] 前端**没有** `window.location.href = loginUrl` 作为兜底（弹窗被拦截时应展示可点击链接）

### `jet-hub-rpc.ts`

- [ ] `account.create` 有该 provider 的分支
- [ ] `account.refresh` 的 switch 有该 provider 的 case，且**每个 case 都传了 `pool` 与 `entry.id`**
- [ ] `account.refresh` 的 catch 回 `ok:false + error`，不是 `ok:true + value.success:false`（issue IKJOZA）
- [ ] `credits.*` 各端点有该 provider 的分支（如果它有积分能力的话）
- [ ] 没有写死字面量（如 `LOBSTERAI.id` 代替 `'lobsterai'`）

### 客户端

- [ ] `credits-capabilities.js` 已登记新 provider 的能力（两项能力彼此独立）
- [ ] 提供 `balance` 时实现 `fetchCreditBalance` 函数
- [ ] 提供 `dailyCheckin` 时实现 `claimDailyCheckin` 函数
- [ ] 没有时写 `false`（默认关闭）

### 凭据结构

- [ ] 非 `codearts` 的 provider 凭据含 `access_token` 字段（`AccountPool.findAccountIdByCredential` 的匹配依据）
- [ ] `expires_at` 统一存毫秒时间戳字符串（复用 `credentialExpiresAtMs` 的解析逻辑）
- [ ] 续期请求体所需的特殊字段（如 LobsterAI 的 `firstKeyfrom` / `latestKeyfrom` / `uuid`）在凭据中持久化，不每次重新生成

### 其他

- [ ] 如果没有签到功能：`credits.status` 如实返回 `null`（不是返回假的状态对象）
- [ ] 如果凭据结构包含签名参数/额外身份字段：确认续期后这些字段是否被正确保留
- [ ] 模型列表远端可用时完全采信远端（不做 Buddy 那样的「以兜底表为准」裁剪）
- [ ] 单元测试覆盖：过期判定、请求头构造、消息序列化、SSE 解析
- [ ] AGENTS.md 已更新（新 provider 行为、特有协议的注意事项）

---

## 附录：文件参考索引

| 你需要的实现 | 参考源文件（同源产品） | 参考源文件（不同源产品） |
|-------------|----------------------|------------------------|
| 产品配置接口 | `src/product.ts` → `BuddyProduct` | `src/lobsterai-product.ts` → `LobsteraiProduct` |
| 产品配置常量 | `src/product.ts` → `CODEBUDDY` / `WORKBUDDY` | `src/lobsterai-product.ts` → `LOBSTERAI` |
| 协议常量与凭据 | `src/buddy.ts` | `src/lobsterai.ts` |
| 认证服务 | `src/buddy-auth.ts` (Service) | `src/lobsterai-auth.ts` (Service) |
| LLM 适配器 | `src/buddy-adapter.ts` | `src/lobsterai-adapter.ts` |
| OAuth 登录 | `src/buddy-oauth.ts` | `src/lobsterai-oauth.ts` |
| 错误分类 | —（同源共用 buddy-adapter） | `src/lobsterai-errors.ts` |
| 积分签到你 | `src/credits.ts` | `src/lobsterai-credits.ts` |
| 注册入口 | `src/index.ts`（buddy/workbuddy 实例） | `src/index.ts`（lobsterai 实例） |
| RPC 分派 | `src/jet-hub-rpc.ts` | `src/jet-hub-rpc.ts` |
| 客户端能力矩阵 | `plugin-src/client/credits-capabilities.js` | 同上 |
| SSE 共用工具 | `src/sse.ts` | 同上 |
| 刷新调度器 | `src/refresh.ts` | 同上 |
| 账号池 | `src/account-pool.ts` | 同上 |
| 账号探测 | `src/account-probe.ts` | 同上 |
| 客户端构建 | `plugin-src/client/build.mjs` | 同上 |
