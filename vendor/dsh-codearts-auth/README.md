# dsh-codearts-auth

> **使用声明**：本代码随便使用，但**不要转发到 GitHub** —— 免费的羊毛，中国人先享受。🐑

deepseek-harness 插件：执行 CodeArts（华为云）登录流程，默认走新式 IAM OAuth
（portal `/authorize` 授权 → 本地 `/oauth/callback` 回调 → STS token 端点换取含
`refresh_token` 的凭据），到期前静默续期，无需再次打开浏览器；旧 ticket 流程保留
为显式回退（`flow: 'ticket'`）。插件还注册一个 `codearts` LLM provider 路由，使该
凭证可直接用于 CodeArts 后端模型调用。

此外插件内置另外十个 provider 路由（完整清单见 [LLM provider](#llm-provider)），
外加一个**聚合**路由 `aggregate`（把同一个真实模型在各渠道的条目归到一个规范名下、
按临期积分自动选渠道，见 [聚合 provider](#聚合-provideraggregate同一个模型跨渠道按临期积分自动选)）；
其中带积分能力的几个：

- **buddy（腾讯 CodeBuddy）** — 见 [buddy provider](#buddy-provider)；
  另支持「一键领取积分」（每日签到）与「**锁定永久积分**」。
- **workbuddy（腾讯 WorkBuddy 国际版）** — 见 [WorkBuddy provider](#workbuddy-provider)；
  支持「**锁定永久积分**」。
- **lobsterai（有道 LobsterAI / 龙虾）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。
- **qoder（阿里系 Qoder）** — 见 [Qoder provider](#qoder-provider)；
  **支持积分余额与每日领取**（每日 100 Credits，10:00（UTC+8）刷新）；
  走**加密推理端点**，模型池与客户端一致（含 Qwen3.8 系列）。
- **loomy（讯飞 Loomy 办公助手）** — 见 [Loomy provider](#loomy-provider讯飞办公助手)；
  **唯一用短信验证码登录**、**唯一不能自动续期**的 provider；
  支持积分余额（两个池）、每日额度签到、**新手任务一键领取 10000 积分**，
  以及「**锁定永久积分**」（CodeBuddy / WorkBuddy 也有同名按钮，但判据不同）。
- **minimax（MiniMax Code 中国版）** — 见
  [MiniMax Code provider](#minimax-code-provider中国版)；
  **首个 Anthropic Messages 协议族**的 provider；
  支持积分余额与每日签到，**推理已启用**（Anthropic Messages，
  4 个模型实测通过；⚠️ 图片输入未实现）。

`codearts` 面板同样支持**积分账户检测、积分余额与「一键领取积分」**
（华为云「每日签到得积分」活动，走 `SDK-HMAC-SHA256` 签名）——
见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)。

十一个 provider 的 Jet Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
是否出现在对话框的模型选择里（黑名单制，默认全部显示）——
见 [模型列表开关](#模型列表开关黑名单)。
⚠️ 聚合路由 `aggregate` 的面板**是独立的**（它没有独立账号与凭据，故不套用上表那套
「显示列表」开关）—— 它有自己的「聚合」面板（rail 第 15 项），见
[聚合 provider](#聚合-provideraggregate同一个模型跨渠道按临期积分自动选)。

## 本机 OpenAI 网关（Chat Completions + Responses API）

插件启动后会在 `127.0.0.1:8326` 提供**两套**标准 OpenAI 接口，供 Pi、Continue、Cline、OpenCode、Codex 或其他兼容客户端使用。网关复用 Jet Hub 已登录账号和现有 provider 适配器，不把上游凭据复制到客户端。

⚠️ **两个端点同时可用，没有「格式开关」**：客户端用哪一套协议，由它自己请求的路径决定。做成互斥开关只会让「另一个协议的客户端在切换后突然失效」，而网关这边本来就没有互斥的理由 —— 两者共用同一份 provider 路由、账号池与图片入站。

接口：

```text
GET  http://127.0.0.1:8326/v1/models
GET  http://127.0.0.1:8326/v1/reasoning-efforts  ← 思考档位对照表（本网关特有）
POST http://127.0.0.1:8326/v1/chat/completions    ← OpenAI Chat Completions
POST http://127.0.0.1:8326/v1/responses           ← OpenAI Responses API
```

鉴权使用：

```text
Authorization: Bearer <网关 API Key>
```

优先从 `DSH_OPENAI_GATEWAY_API_KEY` 读取；未设置时，插件首次启动会在 DSH home 的 `openai-gateway/api-key` 生成并持久化随机密钥，重启后保持不变。端口被占用时不会随机切换。

配置项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_OPENAI_GATEWAY_ENABLED` | `1` | 设为 `0` / `false` / `off` / `no` 时**完全不启动**网关（连 API Key 文件都不会生成） |
| `DSH_OPENAI_GATEWAY_PORT` | `8326` | 监听端口，填非法值会记录错误并跳过网关启动，不会静默改用其他端口 |
| `DSH_OPENAI_GATEWAY_API_KEY` | 自动生成 | 网关的 Bearer 密钥，优先于文件 |

设置页里的开关状态存在 `$DSH_HOME/jet-hub/state.json` 的 `gatewayEnabled` 字段（缺省为启用）。它**不进**账号备份/恢复 —— 恢复一份旧备份不会顺手改变你本机的网关开关。

「供应商开关」弹窗里**拖动行**排出来的显示顺序存在同一文档的 `providerOrder` 字段（缺省为 `[]`，即按声明顺序）。同样是纯展示偏好：插件更新只替换包目录、不触碰该文档，顺序不会丢；把它删掉也只是回到默认顺序，重拖一次即可。已关闭的供应商恒按默认顺序沉在底部，**不参与**拖拽 —— 重新打开某个曾排序过的供应商，它会回到你当时给它排的位置。

### 拿到地址与密钥

两者都在 **Jet Hub 设置页 → 页头「网关」按钮**里：

- **地址**：弹窗顶部直接显示**实际监听地址**（`http://127.0.0.1:8326/v1`）。端口被
  `DSH_OPENAI_GATEWAY_PORT` 改过时显示的是真实端口，不会是写死的 8326。
- **密钥**：点「**复制密钥**」直接进剪贴板。出于安全考虑**默认不显示明文**
  （设置页会被截图/录屏/投屏）；若自动复制不可用（无 Clipboard API、非用户手势、
  权限被拒），点「显示明文」可手动选中复制。

弹窗顶部（网关运行中时）给出三行精简信息：推荐用 CC Switch 配置、两种协议各是什么、
以及 API 请求地址 —— 地址与密钥在弹窗里同在「API KEY：⌈复制密钥⌋⌈显示明文⌋」那一行。

弹窗内部分成**三段**（各有一条分隔线与标题，便于快速定位）：

1. **开关与连接信息** —— 启用/关闭开关、推荐配置方式、两种协议、API 请求地址、API KEY；
2. **模型 ID（可用的完整清单）** —— 全部可用模型 ID，按供应商折成卡片；
3. **思考档位对照表** —— 该填哪个档位，同样按供应商折成卡片。

末尾那条「只绑定 127.0.0.1」的安全提示是三段之外的脚注。

也可以自己取：

```text
%DSH_HOME%\openai-gateway\api-key        ← 首次启动时自动生成的 43 位密钥
```

> ⚠️ DSH home **未必**是 `%USERPROFILE%\.dsh`（换 profile、设过 `DSH_HOME` 都会变），
> 以弹窗里显示的实际路径为准。设了 `DSH_OPENAI_GATEWAY_API_KEY` 时密钥来自环境
> 变量、**没有文件**。

⚠️ 密钥文件被改坏时插件会**明确报错**而不是悄悄换一个 —— 静默更换会让所有已配置的
客户端同时返回 `unauthorized`，而客户端只给这一句提示，无从判断是自己的问题还是
服务端变了。恢复办法：删掉该文件后重启 DSH（重新生成），或改用环境变量。

### 关闭网关

网关是**旁路功能**：它启动失败或被关闭，都不会影响插件其余功能（登录、积分、模型目录照常）。三种关闭方式：

1. 设 `DSH_OPENAI_GATEWAY_ENABLED=0` 后重启 DSH（最直接，环境变量永久生效）；
2. 在 Jet Hub 设置页**页头的「网关」按钮**里关掉「启用本机网关」（立即生效，无需重启）；
3. 端口被别的程序占用时网关会跳过启动并在日志里记明原因，此时改 `DSH_OPENAI_GATEWAY_PORT` 即可。

⚠️ 两处开关的优先级：`DSH_OPENAI_GATEWAY_ENABLED` 是**停用**时，设置页里的开关会被**禁用**并明确提示「已被环境变量停用」—— 想重新打开必须先取消该环境变量。这样不会出现「页面显示已打开、实际连不上」的状态。

### 安全边界

- 只绑定 `127.0.0.1`，**不可**改成对外地址 —— 注意这只挡得住远程访问，**同机其它用户/进程仍可连到该端口**，真正的隔离靠 API Key。
- 密钥以明文写在 `$DSH_HOME/openai-gateway/api-key`。POSIX 下的 `0600` 权限在 **Windows 上不生效**，多用户机器请改用 `DSH_OPENAI_GATEWAY_API_KEY` 环境变量自行保管。
- 网关响应带 `Access-Control-Allow-Origin: *`，因此**不要**把密钥配置进任何浏览器端工具或扩展。

### 知道有哪些模型 ID

有些客户端**不会**主动扫描模型目录（ZCode 就是），必须由用户手工把 ID 填进它的
配置。获取途径：

- **设置页内嵌清单（推荐）** —— 同一个「网关」弹窗里，点「展开清单」看全部
  （展开后可用搜索框按模型 ID 或展示名筛），或点「**复制全部 N 个 ID**」每行一个
  复制走（有搜索词时只复制筛出来的那些，按钮上的 N 就是行数）。
- **命令行** —— 面板上**不再显示**这条命令（用户 2026-10-04 要求删掉：它与本节重复，
  且三条说明挤在一起难以分辨），需要时用下面这条（地址栏直接打开
  `http://127.0.0.1:8326/v1/models` 会返回 **401**，因为它需要 `Authorization: Bearer`
  头，而地址栏不会带）：

```powershell
$key = (Get-Content "$env:USERPROFILE\.dsh\openai-gateway\api-key" -Raw).Trim()
(Invoke-RestMethod http://127.0.0.1:8326/v1/models -Headers @{Authorization="Bearer $key"}).data.id
```

模型 ID 形式为 `provider/模型名`，三条容易踩的规则：

1. **必须带 provider 前缀**。只写 `deepseek-v4.1-flash` 会直接 400
   `model must use provider/model format`。
2. **模型名本身可以带斜杠**，按**第一个**斜杠切分 ——
   `cline/anthropic/claude-sonnet-5.5` 的 provider 是 `cline`、模型是
   `anthropic/claude-sonnet-5.5`。
3. **区分大小写，且同名模型跨 provider 不通用**。同一 provider 内大小写就是混的
   （`codearts/glm-5.3-flash` 与 `codearts/GLM-5.2` 并存）；而
   `deepseek-v4.1-flash` 在 `codearts` 与 `buddy` 各有一份，额度与限流规则不同。

> 💡 设置页的模型清单里，支持图片的模型会标上「可发图片」—— 判据取自各 provider
> 上报的 `inputModalities`（与 `/v1/models` 返回的 `input` 字段同一份）。
>
> 清单与「思考档位对照表」都按**供应商折成卡片**（一家一张卡，卡内是它名下的模型）。
> 卡片头给出该家的条数与可发图片数，卡内只显示**去掉前缀的模型名**（卡片头已经写明
> 是哪一家），但「复制」出去的始终是**完整的 `供应商/模型名`** —— 抄进客户端配置的
> 必须是完整 ID。
>
> 两处的搜索框都在**展开之后**才出现（收起时那个框既占位又无事可做）；**收起会清空
> 搜索词** —— 否则筛子不可见却仍在生效，下次展开会莫名其妙少掉一半行。
>
> 弹窗里的**每个 ID 胶囊都完整显示**（开关行那句说明、两处 curl 命令、卡片里的模型名
> 与「可发图片」标记）—— 这些正是要被读、被抄的内容，被省略号切掉等于功能失效。
> 卡片标题放不下时整块换行，而不是截成 `deepseek-accou…`。
>
> 网关**支持接收图片**，但有两个前提：
> - 宿主须装载附件服务（`@deepseek-ai/dsh-attachment-local`）。DSH 的图片是**附件
>   引用**（`ImageBlock.attachment`）而不是 OpenAI 的 data URL，所以客户端发来的
>   base64 需先经附件服务落盘才能构造。附件服务缺失时网关会明确报「未装载附件
>   服务」，**绝不静默丢图**。
> - **只接受 base64 内联的 data URL**。外部 http(s) 图片链接会被明确拒绝而不是由
>   网关去下载 —— 那需要在网关里发起出站请求，是一个真实的 SSRF 面（能打环回
>   地址、内网服务、云元数据端点）。
>
> 限制取自附件服务的 `imageLimits`：单张 ≤ 20MB、单条消息 ≤ 20 张 / 200MB、
> 边长 ≤ 8192，支持 `png` / `jpeg` / `webp` / `gif`。同一张图重复发送按内容寻址
> （`sha256:`）去重，不会重复占空间。
>
> **工具结果同样可以带图**（2026-10-04 修）：Codex 的 `view_image`、DSH 的 `read_image`
> 这类工具会把图片直接放进**工具结果**里（Chat 的 `role:"tool"` content /
> Responses 的 `function_call_output.output`）。网关把这类图片走**与 user 消息同一份**
> 入站实现落成 `ImageBlock`，再由各适配器挂到 `role:"tool"` **之后**的独立 user 消息
> （上游要求 tool 消息紧跟其 `tool_calls`，中间插消息会被拒）。
> ⚠️ 早先工具结果只走纯文本提取，遇到图片**直接 400**「tool 消息的内容不能包含图片」，
> 且坏报文会落进历史被每轮重放 —— 一让模型看图整条会话就废掉，只能换 provider 恢复。
> `assistant` / `system` 的 content **没有**图片通道（适配器只声明文本输出），
> 这两种角色带图仍会明确报错而不是静默丢弃。

> 💡 填错模型名时网关会返回 `404` + `model_not_found`（**不是** 502 —— 502 会被
> 客户端当成可重试故障白耗额度），并在消息里附上正确拼写，例如：
>
> ```text
> codearts: The model is not registered, please request other model（你是不是想用 codearts/glm-5.3-flash）
> ```
>
> 流式请求下 HTTP 状态码已经发出是 200，该信息会放进 SSE 错误帧的 `error.status` /
> `error.code`。网关**不会**在请求前用目录做白名单拦截 —— 有些 provider 支持目录
> 之外的模型，显式请求仍交给 DSH 路由处理。

### 思考档位：各 provider 的私有 id ↔ OpenAI 客户端的规范名

**这一节是给「在客户端里填思考等级」的人看的** —— 这里是本网关最容易踩、且踩了
完全看不出原因的地方（真实报障）。

各 provider 的档位 `id` 就是**上游的 wire 值**，彼此既不同名、也不同数量；而走
OpenAI 协议的客户端（Codex 的档位选择器、为它生成模型目录的 CC Switch）只有
**固定 8 档**词汇：`none / minimal / low / medium / high / xhigh / max / ultra`。
用户只能照 DSH 界面上显示的**名字**去填客户端，于是必然撞车：

| provider | DSH 界面上显示 | 客户端会照填 | 模型真实认的（wire id） | 修好前 |
| --- | --- | --- | --- | --- |
| LobsterAI | 关闭 / 高 / **Max** | `none, high, max` | `off` / `high` / **`xhigh`** | 选 Max → 400，整轮不可用 |
| Cline | None / Low / Medium / High / **Extra** | `none, low, high, xhigh` | `none` / … / **`max`** | 选 Extra → 400 |
| TRAE | Light / High / **Extra High** | `low, high, xhigh` | **`light`** / `high` / **`extra_high`** | 两个值直接 400 |
| Raccoon | **开启 / 关闭** | `none, high` | **`on`** / `off` | 恰好能用 |
| Qoder / Buddy / WorkBuddy / ZCode / deepseek-account | 与客户端同名 | — | 同名 | 正常 |

处理分两半，**缺一不可**：

**1. 网关按强度就近翻译**（`src/reasoning-ladder.ts` 是唯一的强度序权威）。
客户端那 8 个规范名总能落到该模型同族的某一档：`max → xhigh`、`xhigh → max`、
`low → light`、`xhigh → extra_high`。**填错不再导致失败**，只会被就近翻译
（记一条 `info` 日志）。

- ⚠️ **只在同族内翻译**：要「开思考」绝不会落到 `off`，要「关闭」不会落到 `high`
  —— 把「少想一点」翻译成「完全不想」等于静默关掉功能，比报错更糟。
- 模型**没有这一族**的档位（例如给只有 `high` 的 WorkBuddy 要 `none`）：
  **不下发该参数**、按模型默认走，并记一条 **warning**（你的设置确实没生效）。
- **完全不认识的写法**（拼错的 `banana`）仍然返回 **400**，并在报错里列出该模型
  可用的档位 —— 那不是「名字不通用」，是调用方写错了，静默翻译会让拼写错误
  变成「档位悄悄不生效」。
- **CodeArts 例外**：该 provider 只有开/关两态，任何档位名都等价（一律二值化）。

**2. 可查询「该填哪几个」**：

- `GET /v1/models`：每个模型多了 `reasoning` 字段（模型真实 id + 客户端该填的规范名）；
- `GET /v1/reasoning-efforts`（本网关特有）：逐模型对照表，把 8 个规范名**逐一的
  结局**都列出来 —— `exact`（原样） / `mapped`（就近成 `applied`） /
  `unexpressible`（模型没这一族，不下发） / `ignored`（模型不声明档位，一律不下发）；
- 设置页「网关」弹窗里的「**思考档位对照表**」是同一份数据（标「需对照」的行就是
  上面那张表里的前三个 provider）。表格**只列出已开启的模型**（在 Jet Hub 里关掉的
  不会出现，与对话框的模型选择器同源），展开后支持**按档位名搜索**（`xhigh` / `Max` /
  `Extra` 都能搜到），并可一键把「客户端该填」那一列复制走（有搜索词时只复制筛出来
  的行）。文本按需换行、**不做省略号截断** —— 那两行就是要抄的东西。
  ⚠️ 弹窗里那个面板的两个按钮顺序是**「复制对照表」在前、「展开/收起对照表」在后**，
  与上面的模型清单那段一致。
  ⚠️ 该面板的两句说明**各占一行**（「已开启的 N 个模型里…」与「「客户端该填」为 CC
  Switch 需配置的映射档位…」）—— 拼成一整段交给浏览器断行时，品牌名 `CC Switch`
  会在行尾被从中间切开（`CC` 在上一行、`Switch` 在下一行，看起来像把字写错了）。
- 对照表与上面的模型清单都按**供应商折成卡片**（一家一张卡，卡内是它名下的模型，
  卡片头给出条数与「需对照」的条数）；每张卡片可以单独折叠，也能「复制本组」——
  只复制这一家的行。有搜索词时卡片一律展开，免得命中结果藏在折叠卡里看起来像
  「搜不到」。

```json
{ "id": "trae/deepseek-v4.1-flash",
  "reasoning": {
    "efforts": [ { "id": "light",      "name": "Light",      "canonical": "low"   },
                 { "id": "high",       "name": "High",       "canonical": "high"  },
                 { "id": "extra_high", "name": "Extra High", "canonical": "xhigh" } ],
    "default": "high",
    "openai_efforts": [ "low", "high", "xhigh" ] } }
```

> ⚠️ **CC Switch 的档位多选器只有那 8 个固定值**（每个还带硬编码英文描述，写在它
> 自己的产物里），所以它**表达不出** `light` / `extra_high` / `on` / `off` 这类私有
> id —— 「让客户端自己查对」这条路走不通，**翻译层才是解法**。
> 填 `openai_efforts` 能精确对应；填别的（包括照 DSH 界面上的名字填）也不会失败。

### OpenAI Responses API（`/v1/responses`）

给**只认 Responses 协议**的客户端（Codex CLI 及同类 agent）用：它们发的是
`input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的 SSE 事件。

支持的字段：

- **`input`**：字符串，或 item 数组 —— `message`（`user` / `assistant` / `system` /
  `developer`，简写 `{role, content}` 也认）、`function_call`、
  `function_call_output`、`input_image`（内联 base64 data URL，走**与 Chat 端点同一份**
  附件入站）、`reasoning`（**刻意丢弃**：它承载的是上游加密的思考内容，网关没有可回放的等价物）。
- **`instructions`** → DSH 的 system 消息。
- **`tools`**：`function`（**扁平**（Responses 原生）与**嵌套**（Chat 形状）两种写法都认）、
  以及 Codex 0.142+ 的 **`namespace`** 分组容器 —— namespace 只是把相关工具分个组，
  里面的 function 子工具会被**摊平**成 `<namespace>__<child>` 交给模型（包括标了
  `defer_loading` 的），返回调用时再**还原**成 `{name, namespace}`（Codex 的工具表按
  `(namespace, name)` 索引，只回扁平名它会认为「模型调了个不存在的工具」）。
  见下「Codex 的 namespace 工具」。
  **无法表达的其它类型**（`custom` / `tool_search` / `web_search` / `file_search` /
  `computer_use` / `mcp`）会被**丢弃并在日志里记一条 warning** —— **不会**让你整轮对话失败。
- `tool_choice`（`auto` / `none`；`{type:'namespace'}` 降级为 `auto`）、
  `max_output_tokens`（与 Chat 端点**同一份**钳制规则）、
  `temperature`、`reasoning.effort`（与 Chat 端点**同一份**档位归一化）。
- 流式与非流式。流式事件顺序与官方一致：
  `response.created` → `response.output_item.added` / `response.output_text.delta` /
  `response.reasoning_summary_text.delta` / `response.function_call_arguments.delta` →
  `response.output_item.done` → `response.completed`（被截断时是 `response.incomplete`，
  失败时是 `response.failed`）。
  ⚠️ **不发 `data: [DONE]`** —— 那是 Chat Completions 的收尾约定，Responses 的流以
  `response.completed` 结束。

#### Codex 的 namespace 工具（真实报障修复，2026-10-03）

Codex App / CLI 0.142+ 用私有的 Responses 扩展声明工具：

```json
{ "type": "namespace", "name": "mcp__files__", "description": "…",
  "tools": [ { "type": "function", "name": "read", "parameters": {…} } ] }
```

`namespace` 对上游来说只是**分组**，真正的可调用工具是里面的 function。网关把它摊平成
`mcp__files____read`（`<namespace>__<child>`；超 64 字符时截断 + 8 位哈希后缀，避免长名字
碰撞），并在返回 `function_call` 时还原：

```json
{ "type": "function_call", "call_id": "call_1", "name": "read", "namespace": "mcp__files__", "arguments": "…" }
```

⚠️ 摊平前网关对 `namespace` / `custom` 是**直接回 400**，症状是 Codex 整轮对话都跑不起来
（`tool type namespace is not supported（网关只提供 function 工具）`）—— 「一个工具类型不认识」
的代价不该是「整个会话不可用」，故现在改成摊平或丢弃 + 记 warning。同款处理在
cc-switch / sub2api / Codex 自身（PR #29602）里也是这么做的。

**明确报 400**（不静默忽略，免得用户以为设置生效了）：`previous_response_id`
（网关无状态、不保存响应）、`background`、`text.format`（DSH 没有结构化输出通道，
不假装按 schema 约束）、非 1 的 `top_p`、`item_reference`。

**接受但忽略**（网关是无状态转发）：`store` / `include` / `prompt_cache_key` /
`metadata` / `user` / `truncation` / `service_tier` / `safety_identifier` /
`parallel_tool_calls`。

两处与 Chat 端点**有意不同**（理由写在 `src/openai-gateway/responses.ts` 的文件头）：

1. **文本以 DSH 的 `block-end` 组装块为权威**。DSH 的正文死循环截断与泄漏清洗**只在
   `block-end` 上生效**，而 Chat 端点只累加 delta —— 上游一旦触发正文死循环，Chat 端点会
   把重复正文一并交给客户端，本端点按协议本意取 `block-end`（`output_text.done` 与
   `output_item.done` 用的都是它）。
2. **失败事件的 `error.code` 只放官方枚举值**（`server_error` / `rate_limit_exceeded`）。
   精确的 DSH 错误码在 `error.dsh_code`、本该返回的 HTTP 状态在 `error.status` ——
   把 `SERVER` 这类内部码塞进 `code`，会让按枚举校验的官方 SDK 在解析失败事件时抛错，
   用户看到「客户端崩了」而不是上游的真实原因。

⚠️ **一个工具调用只能有一个 `function_call` 项**（真实缺陷，2026-10-04）：网关曾在每个
`block-start` 上把还开着的块提前收尾，而各 provider 适配器的 `block-end` 都集中在流末尾
补发 —— 于是**并行两个工具调用**时，先开的那个会用残缺的 delta 参数被收尾，真正的
`block-end` 到达时又新建一个同索引项，同一次调用发出两个共用 `call_id` 的
`function_call`。Codex 判定「工具调用与结果对不上」并**终止整轮对话**
（`tool calls and tool results do not match, please start a new conversation and retry`）。
现在块之间**可以并行开启**、各自由自己的 `block-end` 收尾，且一个块**只能收尾一次**
（与 DSH 内部 `BlockAssembler` 的语义一致）；`output[]` 另按 `output_index` 排序，
使顺序与模型真实产出顺序一致。

`GET /v1/responses/{id}` **不提供**：网关不存储响应，一律 404。会话状态由客户端自己维护
（把完整 `input` 一起发过来）。

#### 用量口径：`input_tokens` **含**缓存命中（真实报障修复，2026-10-04）

**现象**：接入 Codex 后，同一个会话用 `raccoon` 时上下文进度条「搞半天只占 5%」，
换成 `trae` 就「正常显示占了 300k 多」。

**根因**是两种「缓存算不算输入」的口径冲突：DSH 内部 `inputTokens` **只含未命中缓存**
的部分（命中单列 `cacheReadTokens`），而 OpenAI 官方的 `input_tokens` / `prompt_tokens`
**含缓存**。旧实现把 DSH 口径原样发出，Codex 再按官方口径算
`input_tokens - cached_tokens`（`saturating_sub`）⇒ 夹到 0 ⇒ 总数只剩 output。

| 时刻（真实会话） | 真实上下文 | 修复前显示 | 修复后 |
| --- | --- | --- | --- |
| raccoon 会话中 | 56,225 | **5.56%** | 5.99% |
| raccoon 会话末 | 208,258 | **0.15%** | 21.99% |
| trae 会话末 | 326,134 | 34.39%（本就正确） | 34.39% |

⚠️ **trae 之所以「正常」不是它被修好了，而是它不报缓存** —— 它的适配器从不算
`cacheReadTokens`，旧公式恰好等于完整上下文。**受影响的是所有开前缀缓存的 provider**
（raccoon / buddy / workbuddy / lobsterai / qoder / qodercn / cline / loomy /
opencode / minimax / zcode / gemini / codearts）。

⚠️ **这不只是显示问题**：Codex 判断该不该自动压缩用的就是同一个数，
计量恒定在 0.1%~5% ⇒ `model_auto_compact_token_limit` **永远不会触发**，
真实上下文会一路涨到撞上模型硬限直接报错。

两个端点现在都发**官方口径**（`input_tokens` 含缓存、命中量在
`input_tokens_details.cached_tokens` 里单列且**仍是它的子集**），转换只有一份实现
（`src/openai-gateway/usage.ts`），避免再次出现「只修了一个端点」。
Chat 端点同时补发官方的 `prompt_tokens_details.cached_tokens` /
`completion_tokens_details.reasoning_tokens`，并保留 `prompt_cache_hit_tokens`
等私有字段供本仓库既有消费者使用。

第一期支持流式/非流式文本、reasoning、工具调用、工具结果、用量和请求取消。图片暂不静默丢弃：当前网关无法把外部 OpenAI 图片引用安全转换为 DSH 附件时，会明确返回不支持错误。


## 安装

该包尚未发布到 npm registry。提供两种安装方式：**git 仓库安装**（推荐，自动拉取
并构建）和**源码目录安装**（本地开发联调）。

### 方式一：从 git 仓库安装（推荐）

`add` 以 `git+https` 方式安装，pnpm 会运行本包的 `prepare` 脚本自动构建 `lib/`，
无需手动 `pnpm build`。

⚠️ pnpm 10 起会拦截依赖的构建脚本，必须先在 profile 的 `pnpm-workspace.yaml`
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）里放行；而**放行键的写法
在 pnpm 10 与 pnpm 11 之间互不兼容**，写错就装不上（两种报错见本节末）。

**1. 先跑一次安装**（这一次必然失败，为的是让 pnpm 打印它期望的键）：

```sh
dsh plugin --profile <name> add "https://gitee.com/iJetLi/deepseek-harness-codearts.git"
```

**2. 按第 1 步的报错选一种写法，写进 profile 的 `pnpm-workspace.yaml`。**

报 **`ERR_PNPM_INVALID_VERSION_UNION`** 的（**pnpm 10.x**）—— 只认**纯包名**键：

```yaml
allowBuilds:
  dsh-codearts-auth: true
```

报 **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`** 的（**pnpm 11.x**，如本机实测的
一版 DSH Desktop 内置 pnpm 11.7.0）—— git 托管包**不认**纯包名键，必须用第 1 步
pnpm 打印的**完整键（含 `#<commit>`）**：

```yaml
allowBuilds:
  dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git#<第 1 步打印的 commit>: true
```

**两代通用（省事，但放宽了权限）**：

```yaml
dangerouslyAllowAllBuilds: true
```

它会放行该 profile 里**所有**依赖的构建脚本（不止本插件）。

**3. 重跑第 1 步的命令**：这次会拉取、构建并安装成功。之后每次升级重新 `add` 即可。

⚠️ **不要**写 `dsh-codearts-auth@git+https://gitee.com/…`（不带 `#<commit>`）——
这个"看起来最自然"的键在两代 pnpm 上都不工作：

- **pnpm 10.x**：解析该键即抛 `ERR_PNPM_INVALID_VERSION_UNION`（"Use exact versions
  only."），安装当场失败 —— issue IKJCOC 报的就是它；
- **pnpm 11.x**：不报错，但该键缺 commit，**永远匹配不上**真实依赖，表现为反复
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

⚠️ pnpm 11.x 的精确键里带 commit，因此**升级（重新 `add` 拉到新 commit）后该键
失效**，按新报错里的键替换即可；用 `dangerouslyAllowAllBuilds` 则不必改。

> 实测矩阵、判据与本仓库自身 `pnpm-workspace.yaml` 为什么不能出现同类键，
> 见 `AGENTS.md` 的「安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义互不兼容」。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再用 `dsh plugin install` 将本地检出安装为 pnpm `link:`
依赖（指向本目录）：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`，否则 dsh 启动时
> 报 `ERR_MODULE_NOT_FOUND: ... dsh-codearts-auth/lib/index.js`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

**登录入口：Jet Hub 设置页的 CodeArts 面板**（与其余五个 provider 一致）。

⚠️ **不注册任何斜杠命令**。早期的 `/codearts-login`、`/codearts-status`、
`/codearts-refresh` 三个命令已移除 —— 登录、状态查看与续期统一在 Jet Hub 完成。
编程式调用仍可用：`ctx.codeartsAuth.login()` / `startLogin()` /
`refreshAccountCredential(refName)` / `refreshAll(pool)`。

## LLM provider

插件在 `ctx.llm` 上注册了一个 `codearts` provider 路由（OpenAI 兼容端点
`https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`）。每个模型请求都使用
存储的 AK/SK/SecurityToken 按华为 `SDK-HMAC-SHA256` 方案签名，并附带
`Chat-Id`/`Session-Id` 请求头。默认广告的模型为 GLM-5.2、GLM-5.1、
GLM-5、GLM-5.3 Flash（`glm-5.3-flash`，1M 上下文）、盘古
openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
以及 DeepSeek V4 deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费
Tokens 福利）。
登录后在 dsh Models 页面选择该 provider 即可。

> 注 1：CodeArts Agent IDE 模型列表显示的 flash ID 为 `deepseek-v4-flash-0731`
> （带日期后缀），但后端实际注册的可用 ID 是 `deepseek-v4-flash`（无后缀）。
> 用 `deepseek-v4-flash-0731` 调用会返回 `InferHub.002002009.404 The model is
> not registered`，因此本插件只注册无后缀的 `deepseek-v4-flash`。
>
> 注 2：`glm-5.3-flash`（GLM-5.3 Flash，2026-08 加入，1M 上下文）是 benefit
> （免费额度）模型：其 chat 请求必须携带 `maas_type: benefit` 请求头且该头
> 参与 `SDK-HMAC-SHA256` 签名，否则后端返回 `InferHub.002002009.404 The model
> is not registered`。适配器已自动处理，无需手动配置。
> （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）

凭据来自默认的新式 IAM OAuth 流程（含 `refresh_token`）。请求发起时会解析最新
凭据，若已过期则先静默续期，再用新 AK/SK/SecurityToken 签名，无需重新打开浏览器。

除 `codearts` 外，插件另注册十三个独立的 provider 路由：`buddy`（见
[buddy provider](#buddy-provider)）、`workbuddy`（见
[WorkBuddy provider](#workbuddy-provider)）、`lobsterai`（见
[LobsterAI provider](#lobsterai-provider有道龙虾)）、`qoder`（见
[Qoder provider](#qoder-provider)）、`qodercn`（见
[Qoder CN provider](#qoder-cn-providerqoder-中国版)）、`trae`（见
[TRAE provider](#trae-provider字节跳动-trae)）、`cline`（见
[Cline provider](#cline-provider)）、`loomy`（见
[Loomy provider](#loomy-provider讯飞办公助手)）、`raccoon`（见
[Raccoon Work provider](#raccoon-work-provider商汤小浣熊)）、`minimax`（见
[MiniMax Code provider](#minimax-code-provider中国版)）、`zcode`（见
[ZCode provider](#zcode-provider智谱-zai-免费额度)）、`opencode` 与 `gemini`（见
[Gemini provider](#gemini-providergoogle-gemini-code-assist)）。
十四者互不覆盖，可同时使用。

### 思考死循环中止后的自动续跑（所有 provider 共用）

模型偶尔会陷入**病态重复**（思考里反复输出 `OK. / Hmm. / 让我写。/ 好。` 这类片段，
永远走不到正文），既烧额度又不产出内容。本插件自带**循环守卫**检测并**当场中止**
上游（`src/sse.ts` 的 `createReasoningLoopDetector`），再把真实原因作为错误显示出来
—— 不是「已达到输出 token 上限」那种误导文案。

中止之后，插件会**自动**替你补一句「继续」并重新开跑，不需要你手打：

| 行为 | 说明 |
|---|---|
| 触发条件 | 该轮**只有思考、没有任何正文或工具调用**（有可见产出时不中止、也不自动续跑，避免重复内容）|
| 续跑上限 | **连续 2 次**；第 3 次不再自动续跑，日志里给出「建议降低思考档位或更换模型」|
| 什么时候清零 | 任何**别人**投进会话的消息（你手打的、目标续跑的、子代理的）都会把连续计数清零 |
| 提示从哪里看 | 续跑会作为一条普通的用户消息出现在对话里（正文是「继续未完成的任务…」），不是隐形操作 |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_REASONING_LOOP_AUTO_RESUME` | 开启 | 设 `0` / `false` / `off` / `no` 时**不自动续跑**（守卫仍然生效，只是回到「需要你手打继续」）|
| `DSH_REASONING_LOOP_AUTO_RESUME_MAX` | `2` | 连续自动续跑上限；`0` 表示一次都不自动续跑；非法值回落到默认值（**不会**静默变成 0）；最大 `10` |
| `DSH_REASONING_LOOP_GUARD` | 开启 | 循环守卫总开关；关闭它等于连检测与中止都不要 |

⚠️ 自动续跑依赖宿主的 agent 服务（`ctx.agents`）。在**没有 agent 循环**的 profile
（纯 `ctx.llm` 的脚本）里这一功能整体不生效，其余能力不受影响。

### 聚合 provider（`aggregate`）：同一个模型，跨渠道按「临期积分」自动选

上面每个渠道各有一套模型 id 与展示名，同一个真实模型往往在**多个渠道**都能用
（例如 DeepSeek V4.1 Flash 在 buddy、codearts、cline 等都有）。插件额外注册一个
**聚合** provider 路由 `aggregate`，把「同一个真实模型」在**各渠道的条目归到一个
规范名下**，请求时自动挑一个渠道发出去。

**解决什么**：各家渠道送的免费额度**有到期时间**，用不完就作废。手动在渠道之间
挑来挑去既麻烦又容易浪费。聚合层按「**最快作废的额度优先用**」自动排序，把临期
积分先烧掉。

**怎么用**：

1. 在模型选择器里选 **`aggregate`** 分组；
2. 想**不挑模型**就选该分组下的 **`auto`** —— 它用**全部渠道的全部模型**当候选池；
3. 想**指定模型**就选该分组下的**具体规范名**（如 `Deepseek-V4.1-Flash`）——
   只在「承载这个模型的那些渠道」之间轮换。

选中后模型名旁会附一个 **`· <渠道>`** 后缀（如 `Deepseek-V4.1-Flash · buddy`），
那是**首选渠道**（临期最早的那个）。

⚠️ **它不是「本次实际发往的渠道」** —— `prepareCall` 在**发起请求之前**就要给出
模型名，而「实际发往哪个渠道」只有转发成功后才确定（首选可能失败并切换）。
真实历史由**用量徽标**显示（那条链路准确，见下文「用量徽标」）。

**自动切换**：某个渠道失败时，聚合层会**换下一个候选**重试。⚠️ 但只在**还没吐
出任何可见内容**时才切换 —— 已经流式输出过的内容收不回来，换候选会让两段回答
拼接成畸形内容（比直接报错更糟）。

**哪些渠道参与轮换**：目前**临期折算已接入**的是 `buddy` / `workbuddy` / `loomy` /
`codearts` / `zcode` / **`lobsterai`** / **`trae`** 七家（后两家有真实的资源包到期时间
`deductionEndTime`）。其余渠道（`qoder` / `qodercn` /
`gemini` / `raccoon` / `cline` / `minimax` / `opencode`）**暂不参与轮换** ——
插件对它们的额度到期时刻**没有可靠信息**，把它们当「永久积分」会让请求发到一个
可能早就用尽的渠道。**宁可少一个候选，不可把未知当可用。**
（这些渠道本身仍可**直连**正常使用，只是不参与聚合轮换。）

**思考档位**：聚合模型声明的是各渠道档位的**并集**（官方中文名），默认 `high` ——
与各渠道自己的默认一致。你选的档位会**逐候选翻译**到目标渠道的档位表上：
精确命中就原样下发；渠道用别的写法就**就近落到同族**（同距时取**更强**的那档，
宁可多想不可静默关掉）；目标渠道没有这一族就**不下发**该字段（让它走自己的默认）。

**图片**：带图的请求只会发给**声明支持图片**的候选；若一个都没有，会**如实报错**
而不是把图降级成文字占位。

**用量徽标**：聚合下徽标显示的是**上次实际转发到的渠道**的读数（余额 / 百分比 /
重置倒计时 / 一键签到），与单渠道完全一致，并**随聚合切换渠道而变**。
⚠️ 尚未发过任何请求（或插件刚重启）时**不显示**徽标 —— 取的是**真实历史**而不是预测
（预测的胜者可能因失败切换而实际未被使用，显示一个错的渠道比不显示更误导）。

**设置面板**：聚合有**自己的**设置面板（Jet Hub 左侧 rail 第 15 项「聚合」）——
说明区 + 按候选渠道数降序的模型列表 + 每个模型**可展开的渠道子列表**，
子列表里逐条开关「参与轮换」。⚠️ 它**没有**账号与凭据（复用各渠道的账号），
故不套用其它 provider 那套「显示列表」开关。

## Token 用量（Jet Hub 页头「Token 用量」按钮）

本插件在**每次模型请求结束时**记录 token 用量（记账点在注册收敛层，一处覆盖全部
provider；渠道由网关打标区分）。数据分**两份**，答的是不同的问题：

| 数据 | 来源 | 回答的问题 | 重启后 |
|---|---|---|---|
| **实时明细 + 汇总树** | 进程内存（上限 500 条） | 「每一笔长什么样、这次会话花了多少」 | 清空 |
| **历史日聚合** | `~/.dsh/jet-hub/token-ledger.json` | 「本周/本月用了多少」 | **保留**（按 UTC+8 日界，保留 90 天） |

弹窗自上而下三块：

1. **历史用量**：今日 / 近 7 天 / 近 30 天 / 全部 切换 + 每日柱状趋势图
   （点击某天下钻到该日的 渠道 → 供应商 → 账号 → 模型 聚合树）；
2. **实时汇总**：渠道（直连 / 网关）→ 供应商 → 账号 → 模型 四级树，各级带合计；
   账号层只在多账号（或含「未归属」）时展开；
3. **明细表**：时间 | 渠道 | 模型 | TOKEN | 首字 | 速率 | 耗时。

### 记账口径

- **计数是 wire 口径**：上游 usage 报什么记什么，不做本地 tokenizer 估算。
- **维度**：渠道（`direct` = DSH 宿主对话 / `gateway` = OpenAI 兼容网关）、
  供应商、账号、模型。账号归属以「凭据解析的起点账号」为准 —— 单账号精确，
  多账号流内换号为近似（详见 `src/token-ledger.ts` 的 `reportedAccounts` 注释）。
- **`—` 与 0 严格区分**：没收到 usage（失败 / 中断 / 秒回空）显示 `—`，
  给 0 会被读成「瞬间完成、没花 token」。
- **首字用时（TTFT）**：收到任何一块（含思考增量）的时刻 − 请求发起；
- **输出速率（tok/s）**：官方口径 —— 分子 = 全部输出 token（含思考），
  分母 = 全程 − 首块；不可测时省略。
- **均值**：只对有实测值的请求平均；父级小计按**全部样本**的 Σ/份数计算，
  不是「子级均值的均值」（3×100ms + 1×500ms = 180ms，先平均再平均会错成 300ms）。

## 用量徽标（模型选择器旁那枚胶囊）

会话输入区右侧、模型选择器左边有一枚薄胶囊，显示**当前渠道一共有多少可用额度**；
点开是完整浮层（逐账号明细 / 订阅窗口 / 刷新 / 签到 / 显示偏好）。
只在选中本插件渠道的模型时渲染，非本插件的模型**不渲染、不发请求**。

折叠态一行按 **`渠道 • 读数`** 两段显示（用户 2026-10-03 定）：

```
CodeBuddy (腾讯) • 2434.96积分
CodeArts (华为云) • 9499.84积分
WorkBuddy (国际版) • 347.87积分
ZCode (智谱) • 94.54MToken
Cline • 5积分
```

规则：`•` 分隔渠道名与读数（读数**内部**的多段仍用 `·`）；不写「合计」（那个词
占位却不提供信息，逐账号明细与合计都在浮层里）；数值与单位之间不留空格。

### 折叠态显示什么：**余额优先**

| 显示偏好 | 折叠态显示 |
|---|---|
| **自动**（默认） | **一共能用的余额**；没有余额读数才依次回落到窗口、套餐 |
| 优先订阅 | 窗口百分比 → 套餐包 → 余额 |
| 只看积分 | **只**显示余额（不回落到订阅；也是套餐判定不准时的兜底） |

⚠️ **2026-10-03 把默认口径从「窗口 > 套餐 > 余额」反转成「余额优先」**，起因是
用户报障：CodeBuddy 胶囊显示「个人体验版 500 / 500积分」，而设置页里明明写着
**可用积分 2434.96**。

两者都是真数据，但**回答的不是同一个问题**：套餐读数是「某一份套餐包还剩多少
/ 共有多少」（服务端还会下发「体验版」这类样板包，它只是余额里的一份），
余额读数才是「这个渠道**一共**还能用多少」。旧口径在这种「既有套餐包又有余额」
的渠道上必然**少报**，看起来就像数据错误。

⚠️ 窗口与套餐读数**没有删除**：它们仍在浮层里（逐账号明细 / 订阅额度区），
`优先订阅` 档可随时切回去看百分比。改的只是折叠态**默认**显示哪一个。

### 多账号：**永远只有一个数字**（单位必须先归一）

渠道下有多个账号时，折叠态显示的是**所有启用账号的余额合计**（与设置页的
「合计」同一口径），账号再多也只是这一个数字变大，不会变成一长串。

> ⚠️ **2026-10-03 的真实缺陷**：WorkBuddy 国际版有**两个**账号，胶囊却显示成
> `WorkBuddy (国际版) • 341.78积分 · 100积分` —— 用户读成「它把所有号的积分都
> 列出来了」，并担心号再多会拖成一长串。
>
> **根因不在多账号，也不在宽度，而在分组键**：服务端把**同一个单位**拼成两种
> 写法。逐包实测（`probe-workbuddy-units.mjs` 打印原值）：
>
> | 账号 | 包 | `unit` 原值 |
> |---|---|---|
> | `…01CC739A` | Bonus Pack 241.78 / Free Plan Subscription 100 | `credit` / `credits` |
> | `…297957E1` | Free Plan Subscription 100 | `credits` |
>
> 折叠态按**原始字符串**分组（`credit` ≠ `credits`）⇒ 两个账号落进两个分组 ⇒
> 渲染出两个**一模一样**的「积分」标签。名字同时也被 216px 上限截成
> `WorkBuddy (…`（两个数字把宽度吃掉了）。
>
> **修法**：归一后再当分组键 —— 客户端 `credits-format.js` 的 `normalizeUnit()`、
> 宿主 `credits.ts` 的 `normalizeCreditUnit()`，两者都只返回 `'token'` 或
> `'credit'`（**与展示名同源**：凡是会显示成「积分」的单位串，就必须落进同一组）。
> 修后同一份数据渲染成 `WorkBuddy (国际版) • 441.78积分`，宽度 **193.56px**，
> 连 216px 上限都没碰到 ⇒ 名字也不再被截。
>
> ⚠️ **`token` 与积分不合并**：ZCode 是 token、其余是积分，两者不可折算，仍分两组
> （`100积分 · 94.54MToken`）。归一化只收敛**同义拼法**，不跨量纲求和。
>
> ⚠️ **不要改写 `CreditPackage.unit` 本身**：那里要保留服务端原值（设置页逐包明细
> 依赖它）。归一化只发生在「当分组键 / 当展示名」的那一步。

### 一键签到：**按单位分列**，不跨量纲求和

签到结果的汇总**不把不同单位的额度加成一个数**。ZCode 的额度单位是 **token**、
其余渠道是**积分**，两者不可折算，故分列显示：

```
一键签到：ZCode（智谱） +100.00MToken，CodeArts（华为云） +100积分（共 +100.00MToken, +100积分）
```

> ⚠️ **2026-10-04 的真实报障**：用户看到的是
> `ZCode（智谱）+100000000（共 +100000100）` —— 1 亿 token 被显示成 1 亿**积分**，
> 而且与另一渠道的 100 积分**加在了一起**。
>
> **根因不在文案，而在数据模型**：宿主汇总的 `totalCredit` 是**跨单位求和的标量**，
> 单位信息在汇总那一层就丢了。下游拿到的是一个裸数字，无论怎么写文案都只能标一个
> 「积分」。故修法是**让单位跟着数字一起走**（新增 `totalByUnit` 分桶），
> 把「怎么显示」推迟到渲染层。
>
> **四条口径**：
>
> | 规则 | 为什么 |
> |---|---|
> | `totalCredit` 保留但**展示路径不得使用** | 它是既有契约，且对**单一单位**的渠道（其余 11 个）完全正确 |
> | 宿主与客户端两份格式化**必须逐字等价** | 客户端 bundle 不能 import 宿主代码，只能各写一份；不锁死会让同一轮签到在两个界面显示成两种写法 |
> | 每个单位**各带一个 `+`** | 整段共用会渲染成 `+100MToken, 100积分`，第二个单位看起来像「不是本次领到的」 |
> | 顺序固定 `token` → `credit` | 不依赖对象键序，渲染稳定 |
>
> ⚠️ **积分不压缩、token 才压缩**：积分余额的现实量级是 `123456.78`（IDE 顶部就是
> 这个精度），压成 `123.46K` 会让用户无法与官方界面核对；而 token 动辄上亿，
> 不压缩读不出量级。数值与单位之间**不留空格**（`100.00MToken`），与本仓库既有的
> 徽标展示惯例一致。
>
> ⚠️ **旧响应兼容**：`totalByUnit` 缺失时回落到「全部按积分」，行为与改动前一致
>（兜底发生在**逐渠道累加**那一跳，不是汇总行）。
>
> 回归用例 `tests/unit/claim-unit-parity.spec.ts`（含「用户给出的期望文案逐字成立」
> 与「宿主/客户端逐项等价」）；反向验证 8 条变异全部杀死。

#### ⚠️ `+` 在函数内部 ⇒ **调用点不得再拼**（2026-10-05 复审补）

`formatClaimGains` 的返回值**自带**每个单位的 `+`（`+100.00MToken, +100积分`），
而客户端 4 个调用点首版又各拼了一次，渲染出**双加号**：

```
++100.00MToken                       ← 逐渠道行
（共 ++100.00MToken, +100积分）       ← 汇总行
```

⚠️ **全量 5448 条单测全绿也没抓到它**：纯函数级用例测的是「函数的输出」，
而 bug 在「函数的**使用**」上 —— `claim-unit-parity.spec.ts` 只 import 纯函数、
从不看调用点，结构上不可能发现。

⇒ 故新增 `tests/unit/claim-unit-callsites.spec.ts`（16 条）守**调用点契约**：

| 不变量 | 说明 |
|---|---|
| 正向锚点 + 反向断言**成对写** | 每条 `not.toMatch` 都配 `toMatch`，否则锚点形态不存在时反向断言**恒真** |
| 断言前**剥掉整行注释** | 注释里会逐字引用曾经的错误写法，不剥则断言被注释自己命中 |
| 断言一律**单行** | 本仓库源码是 CRLF，跨行锚点会命中 0 次被静默跳过 |
| 覆盖 6 个调用点 + 2 处空格口径 | 含**元测试**证明断言非恒真（把错误形态喂给同一正则必须命中） |

反向验证 `scripts/mutate-claim-unit-callsites.mjs`：**9/9 全部杀死、0 跳过**。

⚠️ **同时统一了空格口径**：逐账号明细与徽标余额行原写作 `+100.00M Token`（带空格），
与汇总行的 `+100.00MToken` 并列时像两种单位 —— 现一律**不留空格**。

#### ⚠️ 第三处同型缺陷：徽标浮层的「积分区」节标题

同一批审计还找出第三处「展示路径写死『积分』」—— 它在**用量徽标浮层的节标题**：

```js
// 修复前（usage-badge.js）
quotaGroup === undefined ? '积分' : unitLabel(quotaGroup.unit)
//                        ^^^^^^ 兜底分支假定「非配额渠道都是积分」
```

**ZCode 的额度单位是 token**（`src/jet-hub-rpc.ts` 的 zcode 分支如实标
`unit: 'token'`），于是浮层渲染成自相矛盾的一屏：

```
积分                             ← 节标题（写死）
  ZCode 旅行者6665  94.54MToken   ← 同一屏的数值（按单位走）
```

⚠️ 它此前没被发现，是因为**只在「该渠道只发 token」时才显形** ——
12 个渠道里只有 ZCode 是这种形状。

修法：判据抽成纯函数 `creditSectionLabel(groups)`（`plugin-src/client/badge-model.js`），
有配额组用其标签（`'额度'`），否则用**第一个**单位的标签
（`creditGroupsOf` 已按 `unit` 排序 ⇒ 结果确定，不依赖对象键序）。

⚠️⚠️ **这处还带出一个方法论教训：纯函数级用例测不出「组件不调用它」。**
`badge-model.spec.ts` 为它加了 6 条用例，但都**只 import 纯函数** ——
若有人把组件改回内联三元，那 6 条**依然全绿**（实测确认）。故调用点契约文件里
**额外**加了两条源码级断言：组件**必须**调用 `creditSectionLabel(`、
**不得**再出现 `=== undefined ? '积分' : unitLabel(` 形态。

⚠️ **顺带修掉一条长期空转的断言**：`zcode-claim-amount.spec.ts` 里
`not.toMatch(/个账号领取成功（\+\$\{summary\.totalCredit\}/)` 的锚点
在 `jet-hub.js` 里**从未存在过**（真实代码是 `（共 +${totalCredit} 积分）`，
没有那个前缀）⇒ 修复前后都命中 0 次，等于空转。现已换成真实存在过的两种形态，
并配正向锚点。

⚠️ **教训**：同一个格式化函数有 **N 个手写调用点**，就是 N 次重犯机会 ——
函数内部已保证的东西（`+`、单位名、空格）不要让调用点各自拼一半；
**展示路径上一律不得写死「积分」**。

### 账号多了以后：胶囊不变量 + 浮层收纳

胶囊对**任意账号数**都只显示一个数字（见上）。浮层（点开胶囊）里另有两条针对
多账号的整理：

| 规则 | 为什么 |
|---|---|
| 逐账号列表**按余额降序** | 账号是「用完一个换下一个」的资源，用户先要看到的是「还有哪个号能用」；原顺序是账号池的插入顺序，与余额无关 |
| 读不到数的账号**排最后** | 它们那一格显示的是错误文案，夹在数字中间会被误读成一个很小的余额（不能用 0 代替） |
| 超过 **5 个**折叠成「展开其余 N 个」 | 6 个号本来是 **12 行**（每号两行），足够把弹窗撑得比窗口还高 |
| 合计与失败账号数**不在**折叠范围内 | 折叠只收明细，不隐藏结论 |

⚠️ **胶囊会在合计不完整时挂一个警示角标**（`441.78积分 ⚠`）：账号读不到时合计会
**静默少报**，而数字本身看不出任何异常（色调仍是正常色）。角标与读数同级
`flex: none`（被省略号吃掉等于没标），说明走 `title`，并已并进 `aria-label`
（标记本身 `aria-hidden`，避免读屏念两遍）。

⚠️ 角标**只在积分模式出现**：只有它是跨账号的**合计**。窗口模式按设计只显示某一个
账号的窗口、套餐模式显示的是「最大的那份套餐」，两者都不是合计 —— 套用
「未计入合计」这句话是不准确的，宁可不标也不说错。

实测（无头浏览器，`getBoundingClientRect` 比较渲染宽度与自然宽度）：带角标后胶囊
从 193.56px 增至 **202.19px**（角标 8.63px），名字与读数**都不出省略号**，仍在
216px 上限之内。

### 宽度：内容自适应，216px 是上限

胶囊按内容实际宽度渲染（`Cline • 5积分` 只有 93px），`max-width: 216px` 只在
内容过长时兜底，防止挤压右侧模型选择器。

⚠️ **渠道名与读数是两个独立元素，不是一个字符串**。宽度不够时按
**渠道名 → 读数** 的顺序让位，**余额一个字都不会少**。

> 两次报障、同一条链路的两个不同成因（都发生在 2026-10-03）：
>
> | 报障 | 表象 | 根因 |
> |---|---|---|
> | 第一次 | `LobsterAI (有道) · 合计 …` —— **数字**被截 | **结构**：整句塞进一个 `overflow: hidden` 的元素，省略号从右往左吃，吃掉的恰好是用户唯一想看的那个数 |
> | 第二次 | `CodeArts (华为…` —— **名字**被截 | **尺寸**：结构修好后 186px 仍不够长名字 + 长余额，省略号落到名字上 |
>
> 第一次的修法还抓到一个更隐蔽的成因：给读数留 `flex-shrink: 1` 时，它会被分到
> **不到 1px** 的收缩，而 `text-overflow: ellipsis` **亚像素级收缩就会触发** ⇒
> 读数的 `flex` 必须是 `none`。
>
> 216px 是量出来的：13 个渠道展示名 × 10 种现实读数共 130 组，最宽需求
> **209.34px**（`WorkBuddy (国际版) • 123456.78积分`）。
> ⚠️ **上限不能再往上放**：实测放到「无上限」时，极窄 composer（220px）下胶囊
> 会**溢出容器 8.3px** —— 那正是 2026-10-02「模型选择器图标被挤没」的形态。

⚠️ 这条缺陷**用 `clientWidth` 量不出来**：它取整（53.97 报成 54），
`scrollWidth > clientWidth` 判为 false，于是断言全绿而截图里明明是被截的。
判定省略号要用截图，或与「同字体的自然宽度」对比。

## 凭证

- ⚠️ **只支持账号池**：每个账号的凭据存储在 `CODEARTS_ACCOUNT_XXX`（Ref 为 POSIX
  标识符格式的凭证 ref），由 Jet Hub 设置页管理。
- **单凭据模式已移除**：早期那条「登录写固定 ref `CODEARTS_ACCESS_TOKEN`、
  适配器在账号池取不到时回退读它」的路径已删除。固定的
  `CODEARTS_ACCESS_TOKEN` 不再被写入或读取 —— 若你此前只用它登录过，
  模型列表会变空，请在 Jet Hub 的 CodeArts 面板重新登录一次。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。

### ⚠️ 免费额度（benefit）用尽：立即失败并报出解禁时间

`glm-5.3-flash` / `deepseek-v4.1-flash` 这类 **benefit（免费额度）模型**的额度
按 **UTC+8 自然日**结算。额度用尽时后端以 **HTTP 200 + SSE** 下发：

```
data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota", …}
```

处理方式（对齐 `qoder` 的 `110` / `zcode` 的 `1005`）：

| | 排队 / TPM 限流（`81111`、`TM.00001041`） | **额度用尽（`4291`）** |
|---|---|---|
| 语义 | **暂时**受阻，等一会儿就通 | 额度真的没了，**当天**不再恢复 |
| 处理 | 内部按 10 秒间隔重试，上限 30 分钟 | **立即失败**，抛 `QUOTA_EXCEEDED` |
| 账号池 | 换号重试 | 标记该账号 + 该模型受限，再换号；无号可换则如实报错 |
| 提示 | 无（排队期间刻意零输出） | 「预计 N 小时后重置（按 UTC+8 自然日结算，预计 <ISO 时刻>）」 |

> **真实缺陷（2026-10-02 修复）**：`isSseQueueErrorCode` 的判据里 `429` 是
> **无边界子串**匹配，而额度码 `InferHub.4291.200` 含 `4291` —— **`429` 前缀
> 命中了它**，于是额度错误被误判成「可重试的排队」，进入每 10 秒重试、上限
> 180 次（30 分钟）的循环。
>
> 后果是**界面完全无输出**（不是报错）：排队期间适配器刻意不产出任何内容块，
> 而它误以为自己在排队。实测真实适配器 25 秒内发出 4 次 chat 请求 + 3 次排队
> 探测、**产出 0 个 chunk**，只能由用户手动中止（会话记录里是
> `turn/end aborted` + `stream: []`，**没有任何 error 事件**）——
> 用户报障的「CodeArts Agent 没反应」就是这个。
>
> 修复：`429` 锚定为独立数字 `(^|[^0-9])429([^0-9]|$)`，额度码单独识别；
> 标记时限用 `nextUtc8DayStartMs()` 取 **UTC+8 当日 24:00**（**不能**复用
> `parseRateLimitError` 的「1 小时后」兜底 —— 那对按自然日结算的额度会让标记
> 过早失效，用户 1 小时后再撞一次同样的墙）。
>
> 回归用例见 `tests/unit/llm-adapter.spec.ts` 的「额度用尽（InferHub.4291.200）
> 与排队分流」段（8 条），已做**三项反向验证**：去掉额度分支 → 2 条变红；
> 把 `429` 改回裸子串 → 1 条变红；禁用 HTTP 额度分支 → 1 条变红。

## 续期（refresh）

- 默认登录流程为**新式 IAM OAuth**（PKCE + DPoP）：portal `/authorize` 授权 → 本地
  `/oauth/callback` 回调收取 `code` → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
  换取含 `refresh_token` 的凭据。
- 凭据在过期前 1 小时静默续期（`getFirstRefreshTime` 语义：距过期 ≤1h 立即刷，
  否则 `now+1h` 叠加随机秒偏移），全程无浏览器、无人工操作。
- 刷新失败后 10 分钟重试（异常网络 1 分钟）；`refresh_token` 失效后停止续期并提示
  重新登录。
- 旧 ticket 流程保留为显式回退：编程式调用
  `ctx.codeartsAuth.login({ flow: 'ticket' })`。ticket 凭据没有 `refresh_token`，
  其续期仍意味着重新运行浏览器登录流程。
- **续期按账号**：`refreshAccountCredential(refName, pool?, accountId?)` 与
  `refreshAll(pool)`（定时调度器）。早期的 `refresh()` / `logout()` /
  `status()` / `scheduleRefresh()` / `scheduleModelRefresh()` 只服务于单凭据路径，
  已随该模式一并移除。
  ⚠️ **账号卡片上并没有「刷新」按钮**（按钮是 测试/重测/重置/停用/代理/指纹/删除）。
  `refreshAccountCredential` 的两个调用方是 ① RPC `account.refresh`
  —— **仓库内零生产调用方**（`plugin-src/client/jet-hub.js` 的 42 处 `rpcCall(`
  里没有它，另两处 `rpcCall(变量)` 的实参只有 `opencode.*` 四个方法；调用方是
  仓库外的脚本/手工 RPC，issue IKJOZA 取证），与 ② 定时调度器。
  ⚠️ 经 RPC 调用时**必须**传 `pool` + `entry.id`（`src/jet-hub-rpc.ts` 的
  `account.refresh` switch 内每个 case 都这么传，`tests/unit/refresh-bootstrap-wiring.spec.ts`
  逐 case 扫这条不变式），否则续期后的 `expiresAt` 不回写账号池 —— 凭据续好了而
  UI 一直显示「已过期」（issue IKIRTT）。
  ⚠️ **端点契约**（issue IKJOZA）：成功回 `{ok:true, value:{success:true}}`；失败回
  `{ok:false, error:{code:'bad-request', message:<原异常文案>}}`。
  此前失败被包成 `ok:true` + `value.success:false`，而客户端 `unwrapRpcResult` 只判 `ok`
  —— 只判 `ok` 的调用方会把失败读成成功。**判失败只看顶层 `ok`。**
- 运行时依赖新增 `jose`（用于 DPoP JWS 签发，与 CodeArts Agent 插件实现一致）。

### ⚠️ 停用的账号同样会被续期

`refreshAll()` 与续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号仍然出现在 Jet Hub 里，也仍然参与积分领取。

> **真实缺陷**：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，点「一键领取
> 积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
> 根因是两处都按 `enabled` 过滤：
>
> - `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
>   → 停用期间 `refresh_token` 一路放到失效；
> - `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
>   → **所有账号都停用时，续期定时器根本不启动**。
>
> 用户重新启用后拿到的是死凭据，只能重新登录。四个 provider 的 `refreshAll`
> 与调度器都必须保持只看 `refreshable`。

### 凭据失效时不再抛 `Unexpected token '<'`

积分请求原本直接 `await response.json()`。凭据失效时腾讯网关返回的是
**HTML 错误页**，于是抛出 `Unexpected token '<', "<html> <h"... is not valid
JSON` —— 用户既不知道发生了什么，也看不出该重新登录。

现在先取文本再解析，非 JSON 时给出可读原因：

- HTTP 401/403 → 「凭据已失效（HTTP 401），请重新登录该账号」
- 其他状态 → 「服务端返回了非 JSON 响应（HTTP 502）：&lt;片段&gt;」

`src/credits.ts`（CodeBuddy 系）与 `src/lobsterai-credits.ts` 都已按此处理。

## 开发

- `pnpm test` — 单元测试（快速，无网络）。
- `pnpm test:e2e` — 针对华为线上端点的真实登录流程；需要在打开的浏览器中由人工
  点击授权按钮（续期为静默刷新，无需再次点击）。
- `pnpm typecheck`、`pnpm build:all`。

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`（生成 `.js`、`.d.ts` 和 source
  map）。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（Jet Hub 设置页的客户端 bundle，由 `exports["./client"]`
  引用）。它**不在** `tsc` 的编译范围内，必须单独构建。
- `pnpm build:all` — 依次执行上面两步（`build` + `build:client`），是完整的构建。
- `pnpm typecheck` — 只做类型检查（`tsc --noEmit`），不产出文件，可在构建前快速
  验证。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。只执行 `pnpm build`
会漏掉客户端 bundle，dsh 启动时会因 `exports["./client"]` 指向的文件不存在而
加载失败（Jet Hub 设置页不显示），请改用 `pnpm build:all`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 安装到 profile 之前先构建

详见「安装」小节。`dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:`
依赖运行 `prepare` 脚本，因此必须先 `pnpm build:all` 生成 `lib/`（含客户端
bundle）。

## 工作原理

默认登录流程（新式 IAM OAuth，PKCE + DPoP）：

1. 生成 PKCE 配对与 DPoP ES256 密钥对，并启动本地 `127.0.0.1` 回调服务器。
2. 构造 portal `/authorize` URL 并打开华为云授权页面。
3. 授权后浏览器回调本地 `/oauth/callback`，携带授权码 `code`。
4. 向 STS token 端点（`sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）用
   `code` 换取含 `refresh_token` 的凭据 JSON，并存储到 `CODEARTS_ACCESS_TOKEN` 下。
5. 凭据到期前静默续期（见「续期（refresh）」），无需再次打开浏览器。

旧 ticket 流程保留为显式回退（编程式调用 `ctx.codeartsAuth.login({ flow: 'ticket' })`）：
生成 `ticket_id`，打开 `devcloud.cn-north-4.huaweicloud.com/doer/redirect` 认证页，
回调后轮询 snap-manager ticket 端点（120 × 1 秒）获取临时凭证；此类凭据没有
`refresh_token`，其续期仍意味着重新运行浏览器登录流程。

## buddy provider

独立路由 `buddy`（腾讯 CodeBuddy，OpenAI 兼容端点
`https://copilot.tencent.com/v2/chat/completions`），Bearer `access_token` 鉴权。

登录采用 external-link-v2 轮询式（与 CodeArts 的本地回调服务器不同，CodeBuddy
不起本地端口，而是轮询后端 API）：

1. `POST /v2/plugin/auth/state?platform=ide` → 取得 `state` 与 `authUrl`。
2. 打开浏览器到 `https://www.codebuddy.cn/login/?platform=ide&state=...`。
3. 轮询 `GET /v2/plugin/auth/token?state=...`（1 秒间隔、5 分钟超时）→ 令牌；
   错误码 `11217` 表示 token 未就绪，继续轮询。
4. 轮询 `GET /v2/plugin/login/account?state=...` → 账户信息；错误码 `12151`
   表示账户信息未就绪，继续轮询。
5. 续期：`POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 头提交
   refresh_token。

- **登录入口：Jet Hub 设置页的 CodeBuddy 面板**（支持多账号与账号池自动切换）。
  已不再注册斜杠命令 —— 设置面板已覆盖登录、状态查看与续期，命令式入口冗余。
- 编程式调用：`ctx.buddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 模型列表：以内置的产品目录为准（`src/product.ts` 的 `fallbackModels`），
  远端 `GET /v3/config` 可用时优先采用其元数据。
- 请求头：除 `Authorization: Bearer` 外，还需 `X-Domain`、`X-Product`、
  `X-Product-Code` 以及伪装为 `CodeBuddyIDE/1.106.1` 的 `User-Agent`。
- 凭据 ref：`BUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
  `expires_at` 的 JSON 字符串。

> **流式工具调用 id 稳定性**：CodeBuddy 仅首个工具调用分片携带真实 id
> （`chatcmpl-tool-xxx`），后续参数分片只有 `index`。适配器按 index 缓存并沿用
> 真实 id（缺失时回退 `call_{index}`），保证同一工具的所有分片 id 一致——否则
> 跨轮次（每轮都从 `call_0` 重新编号）会把 `tool/result` 配对到错误的历史条目。

### 安全策略拦截（11140）：会自动换号，被拦账号冷却 30 分钟

腾讯侧业务码 `11140`（`request illegal`）的文案写的是「内容未通过安全审核，请调整后重试」，
但**实测是按账号生效**：同一份请求体（哪怕只有「你好」两个字）发往池里 7 个账号，
结果是「2 个正常、4 个被拦、1 个限流」，换一个会话照样被拦。所以它的出路是**换号**，
不是让用户改内容。

适配器对它的处理（CodeBuddy 与 WorkBuddy 共用同一实现）：

- **三条通道都会继续换号**：首发 401/403 的认证换号、首发限流的换号、以及
  HTTP 200 + SSE 流内的错误帧 —— 坏账号排在池里任何位置都不会中断这一轮。
- **被拦的账号会在「该模型」上冷却 30 分钟**，避免每一轮都重撞它
  （池的候选顺序由你在 Jet Hub 拖拽决定，排在前面的坏账号否则每次都会先吃一发）。
  ⚠️ 账号卡片因此会亮「**限额重置 · <模型> · 30 分钟后**」徽章 ——
  这个徽章现在同时承载两种原因（服务端限流 / 策略拦截冷却），
  因为账号池里只有「模型 → 解禁时刻」这一个「暂时不可用」的载体，没有单独的字段。
  若确认该账号是好的，点「重测」（它会真发一条最小消息，正常返回就清掉标记）
  或「重置」即可立即解禁。
- **报错不会显示「API 密钥无效」**：这类错误归 `PERMISSION_DENIED` 而不是 `AUTH`。
  DSH 客户端对 `AUTH` 一律替换成「API 密钥无效」并丢掉原文，会把用户引向重新登录
  —— 而实测这些账号的 token 全部有效。现在看到的是原文，例如：

  ```
  workbuddy: 全部账号均被服务端安全策略拦截（HTTP 403，已逐个换号重试）。
  该拦截按账号生效（同一请求在其他账号可正常返回），请在 Jet Hub 停用或更换被拦账号：
  内容未通过安全审核，请调整后重试。 request illegal
  ```

### 单次输出上限（`max_tokens`）

**远端下发 `maxOutputTokens`，适配器必须消费它并写进请求体。** 这是「回答被
截断、UI 报『已达到输出 token 上限』」的唯一根因修复。

- 请求体 `max_tokens` 取值优先级：
  **`options.maxTokens`（DSH 注入）→ 远端 `data.models[].maxOutputTokens` → 产品兜底表**。
  三者皆无则**不发该字段**，交回网关默认值（不编造数值）。
- `resolveModel()` 同时把该值声明为 `defaultMaxTokens`。DSH 只在调用方未显式
  给值时用声明的默认值兜底；适配器不声明就等于把上限永久交给网关默认。
- ⚠️ **远端非法值必须过滤**：DSH 对 `defaultMaxTokens` 有硬校验（非安全整数
  或 ≤0 直接抛 `INVALID_MODEL_MAX_TOKENS`，整轮对话起不来），故远端是外部
  输入，`0` / 负数 / `NaN` 一律视为未声明（见 `positiveMaxTokens`）。

实测（2026-09-19，`node scripts/dump-max-output.mjs`）：

| 模型 | 中国版 scoped 端点 | 中国版 `/v3/config` | 国际版 `/v3/config` |
|---|---|---|---|
| `deepseek-v4.1-flash` | 128000 | 131072 | 128000 |
| `deepseek-v4-pro` | 128000 | 131072 | — |
| `deepseek-v4-flash` | 50000 | 50000 | — |
| `hy4-preview` | 64000 | 64000 | 64000 |

⚠️ **网关默认值恰好是 32000**（远端 `auto` / `glm-4.6` / `kimi-k2.6` 等模型
声明的就是 32000），这正是未下发 `max_tokens` 时 `deepseek-v4.1-flash` 在
32000 处被截断的原因 —— 不是「网关固定上限」，而是上游声明的额度被适配器丢了。

网关**确实接受** `max_tokens` 且**精确生效**（`node scripts/verify-max-tokens.mjs`，
国际版 `deepseek-v4.1-flash`，当时处于官方限免期 `credit: 0`）：

| 请求 | 结果 |
|---|---|
| 不带 `max_tokens` | HTTP 200，`finish_reason=stop` |
| `max_tokens: 128000` | HTTP 200，接受 |
| `max_tokens: 64` | HTTP 200，**`finish_reason=length`、`completion_tokens=64`** |

第三行是关键证据：输出被精确截断在 64，证明该字段被服务端真实消费，而不是
被静默忽略。

> **单次请求 ≠ 单轮**：每个 step 都是独立请求、各有各的预算。因此
> 「拆多步写文件」仍是超出单次额度时最有效的手段；`max_tokens` 只是把单次
> 额度提升到上游声明的真实值。
>
> **思考档位与输出预算共享同一额度**：`reasoning_tokens` 计入
> `completion_tokens`（实测 `thinking` 内容与正文同池），故思考开到 `max`
> 时正文更早撞上上限。

### 模型计费倍率与同名模型

模型切换列表里每个模型后面会显示它的**计费倍率**：

```
Deepseek-V4.1-Flash · x0.03
GLM-5.3 · x0.79→x0.50          ← 有促销活动时显示 原价→促销价
```

倍率拼在**模型名**（`name`）后面，而不是说明（`description`）里 ——
composer 的模型切换菜单**只渲染 `name`**，`description` 仅用于 `/model` 弹窗。
`name` 纯属展示，DSH 的选择与持久化只用 `id`，所以附加价格不会影响会话。

各 provider 的倍率字段**形态互不相同**，实现里是分开解析的：

| provider | 远端字段 | 真实形态 |
|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | 字符串 `"x0.29"`（可为空串） |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | 字符串 `"0.50x"`（**x 在后**）；`factor: 0` = 免费。⚠️ **只由 `/v3/config` 下发**，企业模型端点没有；且须按 `schedule` 判时段 |
| `lobsterai` | `data[].costMultiplier` | 裸数字 `0.05` |
| `qoder` | 目录 `chat[].price_factor` | 裸数字，**`0` = 免费** |
| `trae` | `display_contact_config.consumption_rate.data.rate` | **裸数字** `0.08`；`0` = 免费（⚠️ `display_contact_config` 本身是 **JSON 字符串**，须二次解析） |
| `codearts` | 无 | 两个目录端点都不含计费字段 |

腾讯系的促销值带 `schedule`（每日时段 + 有效期 + 时区），**必须按当前时间本地
推算此刻是否生效**，不能只看 `enabled`；`factor: 0` 表示**免费**（如
`hy4-preview` 的夜间免费），只有**没有时间窗口**的 `"0x"` 才当作「已结束」占位。

TRAE 的活动折扣只用**当前确实生效**的那一档：`activity_discount.enable` 为
`true` 也可能是「无折扣」（`discount_type: "none"`、原价==折后价，实测 `off_peak`
型即如此），照显会得到 `x0.13→x0.13`；已过 `end_at` 的活动同样不展示。

Qoder 的免费模型（`price_factor: 0`）显示为「免费」而不是 `x0`；有错峰折扣的
模型在**折扣时段内**显示「原价→折后价」，时段外只显示原价：

```
Qwen3.8-Flash · 免费
Qwen3.8-Max · x0.5→x0.2          ← 22:00–08:00（UTC+8）内
Qwen3.8-Max · x0.5               ← 时段外
DeepSeek-V4-Pro · x0.5
```

> ⚠️ **折扣形态三个 provider 统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
> buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
> 中文角标」（`x0.2 错峰 4 折`），问题有二：① 看不出原价与折扣幅度；
> ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。

> ⚠️ `credits` 与 `discountedCredits` 的 `x` **位置相反**（`"x0.29"` vs
> `"0.50x"`）。早期版本只认前缀写法，导致促销价被静默丢弃。
>
> ⚠️ **腾讯系两个端点下发的模型 id 集合不同，必须取并集** —— 促销可能只挂在
> 其中一个端点独有的 id 上。实测 `hy4-preview-f`（新用户限时免费）**只由
> `/v3/config` 下发**且被 agent 引用，而 scoped 端点给的是 `hy4-preview`
> （无促销）。只采信 scoped 就会显示 `x0.29` 而 IDE 显示免费（用户报障
> 「hy4 preview 现在 ide 是免费我们还是 0.29」）。**不同账号下发的变体 id
> 也不同**，排查时须多账号对照。
>
> ⚠️ **腾讯系的促销只在 `/v3/config` 下发，企业模型端点没有** —— 而后者被优先
> 返回，所以早期实现**永远不显示促销**（用户报障「codebuddy 的倍率显示也是
> 没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。现补取促销表并合并。
> 且**必须按 `schedule` 判此刻是否生效**（`glm-5.2` 夜间/白天是两条互补活动，
> 不看时段会全天显示折扣价）；**`factor: 0` 是「免费」而非「已结束」**
> （`hy4-preview` 夜间免费，用户报障「夜间 0，现在显示 0.29」）。
> ⚠️ `/v3/config` **有 UA 校验**，UA 不对返回 HTTP 200 + `code:12403`，
> 极易误判为「该端点没有促销数据」。
>
> ⚠️ 产品兜底表是**白名单**（不在表里的 id 会被丢弃），但**被 agent 引用的
> 模型例外保留**（服务端自己的「可选」信号）—— 否则 `hy4-preview-f` 会被丢掉。
> 判据**不是**猜 id 后缀（`-f`/`-x`/`-sg` 含义各异，猜错会放进不可用的模型）。
>
> ⚠️ Qoder 的字段是 `price_factor`，**不是** `cost_multiplier`（后者是
> LobsterAI 的）。而 `price_factor: 0` 是**合法的免费值**，不能用 `> 0`
> 过滤掉。
>
> ⚠️ 倍率**不能**放进 `description`：那在切换模型列表里根本不可见
> （用户报障「消耗倍率没有显示在切换模型列表的后面」）。
>
> ⚠️ **Qoder 的错峰时段按 `windowStart`/`windowEnd` 本地推算，不采信目录的
> `promotion.active`** —— 后者是目录下发那一刻的快照，客户端长时间不重启
> 就会与真实时段脱节（用户在时段外看到折后价、或时段内看不到折扣）。
> 生效价由 `beforePromotionPriceFactor × discountFactor` 推出（实测三条全部吻合）。
> **真实缺陷**：早期表里存的是「采集时刻的生效价」却当成恒定值展示，
> 且 14 个模型的数值本身也是过期估值（`smodel` 写 3.2 实际 8），
> 用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。

#### 同名模型会自动区分

服务端会给**不同 id 配同一个展示名**，实测三组：

| 模型 id | 远端展示名 | 实际差异 |
|---|---|---|
| `deepseek-v4.1-flash` / `deepseek-v4.1-flash-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，倍率 x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

由于选择器按展示名渲染，这些会变成无法区分的重复条目（用户报障：
「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」——IDE 按展示名
归并，本插件按 id 列出）。二者是**不同区域的独立计费实体**，不能简单丢弃其一，
故对撞车的 id 求公共前缀、把剩余段追加到名字后：

```
Deepseek-V4.1-Flash · x0.00        (deepseek-v4.1-flash)
Deepseek-V4.1-Flash · x0.03 SG     (deepseek-v4.1-flash-sg)
Hy3 · x0.00                        (hy3)
Hy3 · x0.05 X                      (hy3-x)
```

用公共前缀而不是硬编码 `-sg`，是因为撞车组会随服务端上新变化（本次实测三组
里只有一组带 `-sg`）。LobsterAI 实测无同名（28 个模型 0 组重名），故不做消歧。

### 成长中心任务（仅 buddy / CodeBuddy 中国版）

`src/buddy-growth.ts` 提供成长中心任务的**纯 API 自动化**：接取任务 → 上报判据
事件 → 逐项领奖。原作只有每日签到，成长任务（22 项）完全没有实现。

⚠️ **只有 buddy（CodeBuddy 中国版）有成长中心**。`workbuddy`（国际版）后端
**根本没有该功能**（实测无任务列表、无 claim 端点），故不在
`GROWTH_CAPABLE_PROVIDERS`（宿主）与 `GROWTH_TASK_PROVIDERS`（客户端）里
—— 两处是**同一份清单，必须同时改**。

入口是 Jet Hub 设置页的「一键领取积分」按钮（buddy 下显示为
「一键领取积分 + 成长任务」）。**成长任务只在手点该按钮时执行** ——
`credits.claimAll` 同时是「每日首次启动自动签到」的执行体，而成长一轮单账号实测
90～270s 且全串行，默认开启等于每次开机自动打几十个上游请求。这条不变量由
`tests/unit/usage-badge-client.spec.ts` 的断言锁住。

⚠️ **重入闸门**（`claimInFlightRef`）：按钮的 `disabled: claiming` 依赖**异步**
state，同一 tick 内连点两次会穿透并起两轮并发（对同一账号同一批任务并发上报与
claim）。故用 `useRef` 做**同步**闸门，且拦住后必须给出提示（不能静默 return）、
闸门必须**无条件释放**（跟着 `mounted` 判会让它永久卡死）。

覆盖 22 项任务映射（对话类走六连事件链；`create_canvas` 走
`wbx_design_canvas_*` 遥测且**不**新建真实画布；`Library_read` 走 web 域
`web_element_click`；`Hp_Appearance` 走 `appearance/set` + 皮肤生效事件；
`skill_1` / `first_chat` 走真实 `fast-model` SSE 会话）。

三个容易踩空的判据细节（来自实测，改动前请先跑真实账号确认仍成立）：

- `requestModelId` 与 `requestModelName` **必须分离** —— `Model_chat_GLM5.2` 的
  判据是 `glm-5.2` / `GLM-5.2`（大小写不同）且只上报**单条** `chat_request_send`、
  `requestId` 回落 `conversationId`。按「事件链 JOIN 真实会话」的思路实现会长期 0/1。
- `Expert_team_use_3` 服务端按 `expert_id` **按天去重** ⇒ 必须跨**不同**专家轮换，
  固定 1 轮会永远卡在 2/3。
- 两个任务端点是**不同 schema，必须合并读**：`/v2/activity/growth/tasks`
  （`task_code` + `accept_status` + `progress`）与 `/activity/growth/tasks`
  （`code` + `status`，**无** progress）。只读前者 ⇒ 后者那 5 项永远进不了待办。
  ⚠️ **两族的码字段名也不同**（`task_code` / `code`），且**扫尾补领也有同样要求**
  —— `listAllGrowthTaskCodes` 与 `fetchGrowthTaskCodes` 必须同时满足
  「合并两端点」+「双字段读取」，任一处漏掉都会让任务**静默漏领**（不报错）。

#### 扫尾补领与逐项完成是**两条独立路径**（改动前必读）

「扫尾」补领的是**已达标未领取**的奖励，而这类任务按定义已是 `completed`、
**不在** `actionable` 里（后者只含 `not_accepted` / `in_progress`）。因此：

- `actionable` 为空**不能**提前 return —— 那会让扫尾永不执行，账号里所有
  已达标未领的奖励一个都领不到（实测修复前 claim 次数为 0）；
- 接取（accept）失败也**不能**短路扫尾 —— 接取只影响本轮新接的任务；
- 时间预算必须在**扫尾之前**算好，否则 `actionable` 为空时扫尾会绕过 deadline
  对全量任务逐个 POST。

这三条都由 `tests/unit/buddy-growth.spec.ts` 的「扫尾补领的覆盖面」段锁住。

#### `code 400` 必须**同时看 `msg`**（否则会把真失败谎报成「已领奖」）

成长端点用同一个 `code 400` 表达两种语义：

| msg | 语义 | 归类 |
|---|---|---|
| `no unclaimed travel` / `insufficient energy` / `please accept buddy adoption agreement first` | **没有可领对象** | `no-object` → `already-claimed`（幂等终态） |
| `task not completed` / 其它 | **真失败** | `failed` |

只认 `code` 会把 `task not completed` 一并归成「已领到积分」（用户看到成功、
实际一分没有）。白名单外的文案一律判失败 —— **宁可漏判不可误伤**：漏判只让正常
终态显示成失败（用户多点一次，无害），误伤会把真失败谎报成成功。

同理，**claim 端点的成功判据是显式 `code === 0`**，不能写
`code !== undefined && code !== 0` —— 那样「响应里没有 `code`」会被当成成功，
网关错误体（`{msg:'Unauthorized'}` 这类）就被谎报成「已领取奖励（+0 积分）」
并计入 `claimedCount`。

#### 全新账号需要点两次（服务端解锁，不是缺陷）

成长任务受新手任务解锁 gating。**全新账号第一轮只能领到极少数已开放项**
（实测一个全新白号第一轮仅 `RichMeow_Chat` 一项到账 +100 积分），
第二轮才开始出现成长任务并批量到账（实测同一新号第二轮
`Expert_team_use_3` 3/3、`template_5` 5/5、`automation_1` 1/1、
`skill_1` 1/1、`expert_5` 5/5）。

这不是本模块能修的：解锁条件在服务端，客户端只能把已开放的任务做完。
**看到第一轮只完成一两项属正常，再点一次即可继续。** 无产出账号的提示会折叠成
一行（`昵称：N 项判据只在客户端行为里记录，API 推不动（未领到积分）`），不铺陈列表。

#### 结构性不可达的任务（如实标 `clientOnly`，不谎报）

「养虾等级」任务族来自第二个端点，服务端只返回 `status`（`available` = 未达成）
而**不返回 progress**。事件上报不改变 `status` —— 实测 2 轮 × 3 个账号共 6 次，
`first_chat` / `template_used` / `expert_summoned` / `skill_installed` 的 `status`
始终 `available`。故这 4 项在本模块里是**结构性不可达**的，会跳过「真实会话 +
真 requestId」重试（那次重试要发一条真实对话并等 4s 结算，而结果已确定不会变），
合成事件仍照发一次以保留判据万一改版的可能。

`wechat_linked` 与 `wb_wechat_oa_subscribe_task` 是纯客户端动作（微信内完成），
直接归 `clientOnly`。

这不是「做不到」的断言，而是「当前服务端口径下事件不计数」。若日后 `status`
也接受事件驱动，`LEVEL_UNREACHABLE_TASK_CODES` 的短路应同步撤掉。

#### 时间预算：两个独立闸门

| 闸门 | 缺省 | 作用域 | 作用 |
|---|---|---|---|
| `budgetMs` | 10 分钟 | **每账号** | 单账号卡住时不拖住整轮 |
| `roundBudgetMs` | 30 分钟 | **整轮全部账号** | 账号很多时不撞宿主 RPC 超时 |

两者耗尽即**如实停住**并标出哪些项 / 哪些账号没执行，提示写「再点一次即可继续」——
而不是卡死到超时。宿主 RPC 的超时上界由 dsh 侧决定，本插件不可见也不可控，
故整轮预算是必要的兜底。非有限值（`NaN` / `Infinity`）归「不限时」并 `console.warn`
留痕：未显式区分时 `NaN > 0` 为 false 会静默变成不限时，恰是本预算要防的情况。

僵尸账号（凭据被外部删除 ⇒ 上游 401/403）归 `inactive` 语义、**不计 failed** ——
它的处置是「重新登录」，与「任务推不动」完全不同。签到侧与成长侧必须同时这样归类，
否则同一个僵尸条目在两处会给出互相矛盾的判定。

#### 平台适配

上报指纹的平台三元组（`os` / `arch` / `osVersion`）由**单一来源**同时喂给桌面域
与 web 域，各自按本域习惯命名 `os`（`win32` / `Win32`、`darwin` / `MacIntel`），
而 `arch` 与 `osVersion` 保持一致 —— 同一台机器在两个域报出不同的 OS 足以让整批事件
不计数。`arch` 取 `process.arch` 而非写死 `x64`（arm64 宿主上写死即撒谎），
`osVersion` 按平台取值（`win32` → `10.0.x`、`darwin` → `15.0`、`linux` → `6.8.0`），
不再出现 Linux 宿主配 Windows 版本号这类自相矛盾。


## WorkBuddy provider（国际版）

独立路由 `workbuddy`（腾讯 **WorkBuddy 国际版 / WorkBuddy AI**），与
[buddy provider](#buddy-provider) **同源**：共用同一 CLI 内核与同一认证协议
（cli-external-link 轮询式），Bearer `access_token` 鉴权。差异收敛在
`src/product.ts` 的产品配置里：

| 项 | CodeBuddy（中国） | WorkBuddy（国际版） |
|---|---|---|
| `endpoint` | `https://copilot.tencent.com` | **`https://www.workbuddy.ai`** |
| `platform` | `ide` | **`workbuddy-ai`** |
| 登录 URL 附加参数 | 无 | **`version` / `loginSessionId`** |
| `pluginVersion` | — | `5.5.2` |

**模型列表不能与中国版共用**：两者的路径与响应解析完全相同
（`GET /v3/config` → `data.data.models` / `data.data.agents`），差异只来自
`endpoint` —— 不同区域的后端返回不同模型池（中国版含 glm / hy / deepseek 系，
国际版含 claude / gpt / gemini / kimi 系）。因此 `endpoint` 必须随产品切换，
不能被当成全局常量。

登录流程与 CodeBuddy 一致（`auth/state` → 浏览器授权 → 轮询 `auth/token` →
轮询 `login/account`），仅身份标识与端点按上表区分。`X-Product-Code` 为
`workbuddy`，`X-Domain` 随 `apiDomain` 切换为 `www.workbuddy.ai`。

**没有每日签到积分**：国际版后端不提供**签到**接口（内核中只有
`/v2/billing/meter/get-dosage-notify` 用量通知），因此 Jet Hub 的 WorkBuddy
面板**不显示「一键领取积分」按钮**；签到领取在 CodeBuddy 面板完成。

> **但积分余额（Credits Balance）可以查。** 签到与余额是两项独立能力：国际版
> 确实没有签到，但**有**积分余额查询接口，见下节。不要因为"没有签到"就推断
> 也查不到余额。

- **登录入口：Jet Hub 设置页的 WorkBuddy 面板**（支持多账号与账号池自动切换）。
  同样不注册斜杠命令。
- 编程式调用：`ctx.workbuddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 凭据 ref：
  - 单账号：`WORKBUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
    `expires_at` 的 JSON 字符串（与 `BUDDY_ACCESS_TOKEN` 同构）。
  - 多账号：`WORKBUDDY_ACCOUNT_<UUID_SHORT>`，由 Jet Hub 设置页「+ 新建账号」
    登录时自动生成并登记到账号池；每条账号记录带 `provider: 'workbuddy'`，
    与 CodeBuddy 的 `BUDDY_ACCOUNT_*` 相互隔离，不会串用凭据或限流标记。
- **从中国版升级**：本插件早期版本把 `workbuddy` 指向中国版
  （`copilot.tencent.com`）。启动时会自动清理凭据 `domain` 与当前
  `apiDomain` 不符的旧账号（这类凭据在新端点必然失败），清理结果记入日志，
  请在 Jet Hub 重新登录。
- 续期：与 CodeBuddy 共用同一套机制，插件启动后每 30 分钟对可续期账号静默刷新
  （`refresh_token` 经 `X-Refresh-Token` 头提交），无需重新打开浏览器。
- 请求头、模型列表拉取与流式工具调用 id 处理均与 CodeBuddy 一致，详见上一节。

### 与 Jet Hub 设置页的关系

Jet Hub（设置页）的账号面板按 provider 分组展示，WorkBuddy 是其中一栏：

- 面板提供账号列表、新建账号（浏览器登录入池）、启用/停用、删除、**拖拽排序**，
  以及「重测 / 重测所有 / 重置 / 重置所有」限流标记操作，行为与 CodeBuddy
  面板一致，但只操作 `provider: 'workbuddy'` 的账号。
- 账号卡片展示 credentialRef、有效期（含「自动续期」标记）、限流状态与**积分
  余额**（见下节）。「一键领取积分」按钮**仅 CodeBuddy 面板提供**，结果来自
  RPC 端点 `credits.claimAll`（实现见 `src/jet-hub-rpc.ts`，签到客户端见
  `src/credits.ts`）。
- 后端另实现了 `credits.status`（查询某 provider 下全部启用账号的签到状态），
  但**前端尚无消费者**：`plugin-src/client/jet-hub.js` 只调用 `credits.claimAll`，
  `credits.status` 目前仅供外部脚本或直接 RPC 调用使用。
- 对应 LLM provider 的设置命名空间为 `llm-workbuddy`。

### 「+ 新建账号」必须走两步式登录（四个 provider 一致）

`account.create` 对**全部四个 provider** 都遵守同一契约：**在用户完成授权之前
就返回 `loginUrl`**，由前端立即 `window.open`，后台再异步等回调。

这不是风格偏好，而是浏览器安全模型的硬约束：`window.open` 只在用户点击后的
**transient activation** 窗口（约 5 秒）内被允许。若 `account.create` 阻塞到
用户授权完成才返回（数十秒），拿到 URL 时手势早已过期，弹窗必被拦截并返回
`null`，前端若兜底执行 `window.location.href = loginUrl`，就会把**整个设置页**
导航到外部登录页 —— 用户报障「codearts 新建账号应该弹出新的页面，现在主页面
直接跳转过去了」正是此因。

| provider | 后端实现 | 前端交互 |
|---|---|---|
| `buddy` / `workbuddy` | `runBuddyLoginFlow` 不 await，立即返回 URL | 弹小窗 + 轮询 `login.poll` |
| `codearts` | `CodeArtsAuth.startLogin()` | 同上 |
| `lobsterai` | `LobsteraiAuth.startLogin()` | 同上 |

- 两步式的入口在 `src/login.ts` 的 `startOAuthFlow` 与 `src/lobsterai-oauth.ts`
  的 `startLobsteraiLoginFlow`；原阻塞式 `runOAuthFlow` /
  `runLobsteraiLoginFlow` 保留（CLI、e2e 仍用），现由前者实现。
- 两步式路径**没有外层 `try/finally` 兜底**，故超时与「结果落定即关闭回调
  服务器」都收在 `start*` 内部，避免泄漏监听端口。
- 前端**不再**保留 `window.location.href` 兜底：弹窗被拦截时改为展示一个可点击
  的登录链接（`loginUrlForManual`），轮询照常进行，用户手动打开也能完成登录。
- 回归测试见 `tests/unit/jet-hub-rpc.spec.ts` 的
  「account.create 必须立即返回 loginUrl」：用「授权永不完成」的替身模拟用户
  尚未操作 —— 旧实现会超时失败，新实现立即返回。

### 账号拖拽排序（顺序 = 选号优先级）

Jet Hub 各 provider 面板的账号卡片可**拖动调整顺序**，卡片左上角显示序号。

**这不是纯 UI 装饰**：账号列表的数组顺序就是 `getAvailableAccount` 的候选
优先级 —— 自动选号、以及限流后换号重试，都按这个顺序取「第一个可用账号」。
把常用账号拖到前面，它就会优先被使用。

语义是「**手动顺序优先，限流豁免**」：

- 顺序完全由用户决定（不按任何服务端字段重排）；
- 但当前正处于**限流期**的账号会被跳过，不会选到 —— 即使它排在第一位。

> ⚠️ 早期实现有一个 `candidates.sort((a,b) => resetAtA - resetAtB)`（按限流
> 重置时间最早到期优先）。它会让拖拽形同虚设：用户把某账号拖到首位，只要
> 另一个账号的重置时间更早，实际选中的仍是后者。该排序已移除，
> `tests/unit/account-pool.spec.ts` 有回归用例锁死。

交互细节：

- 拖动整张卡片，或抓住左侧的 `⠿` 手柄；
- 插入位置按指针落在目标卡片的**上半 / 下半**决定（前插 / 后插），
  并以卡片上方或下方的蓝线指示。只支持「前插」时把卡片往下拖一格会变成
  空操作，因此必须区分方向；
- 顺序**乐观更新**（本地先变、再提交），失败则回滚并提示；
- 提交期间禁用拖拽，避免并发提交互相覆盖；
- 只有 1 个账号时不启用拖拽（排序无意义）。

实现：RPC `account.reorder` → `AccountPool.reorderAccounts()`
（只动本 provider 占用的下标，其他 provider 账号位置不变）；
前端拖拽逻辑在 `plugin-src/client/account-order.js`（纯函数，可单测）。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

两个 buddy 的卡片还会**额外显示「临时 X · 永久 Y」分桶**（与下方
[锁定永久积分](#锁定永久积分codebuddy--workbuddy)同一判据），tooltip 里每个包
标出「距到期 N 天」。这条也直接解释了"锁上为什么没号可用"——临时桶是 0。

⚠️ **分类在渲染的那一刻现算，不缓存**：它是「距扣费截止是否满 15 天」的判断，
而宿主长期开着、时间只向前流——一笔距到期 15 天 30 秒的余额，用户什么都不做，
半分钟后就越过了线。所以选号侧缓存的也只是 `get-user-resource` 的**原始包列表**
（TTL 60 秒只用于抑制网络请求），命中缓存同样重新分桶；面板侧每次渲染传当下的
`Date.now()`，不存分类、不设常驻定时器。

**两个产品通用**——CodeBuddy 中国版与 WorkBuddy 国际版都实现同一接口
（只是 baseURL 随 `product.endpoint` 切换）：

```
POST /v2/billing/meter/get-user-resource    body {}
```

### 锁定永久积分（CodeBuddy / WorkBuddy）

面板上的「锁定永久积分 / 解锁永久积分」按钮用来**保住不会马上作废的积分**，
语义与 [Loomy 的同名功能](#锁定永久积分)一致，但**判据必须自己算**——腾讯系
的响应里没有「永久 / 临时」这个字段。

**判定规则（用户定）：距扣费截止不足 15 天的积分算临时（优先烧掉），其余算永久。**

⚠️ 「到期」只能看 `DeductionEndTime`（毫秒时间戳）。实测 2026-09-29 两站真实账号：

| 包 | `ExpiredTime` | `CycleEndTime` | **`DeductionEndTime`** | 归入 |
|---|---|---|---|---|
| WorkBuddy「Bonus Pack」 | `''` | 9 天后 | **9 天后** | 临时 |
| WorkBuddy「Free Plan Subscription」 | `''` | **2 天后** | **3008 天后** | 永久 |
| CodeBuddy「个人体验版」 | `''` | 已过期 | 3008 天后 | 永久（本周期已无余额） |
| CodeBuddy「拉新权益包 / 国内运营裂变包」 | `''` | 同下 | **17～208 天后** | ≥15 天者永久 |

- `ExpiredTime` **没有区分力**：有效包一律是空串，它只在包**真正失效之后**才回填
  （此时 `Status` 已变 3、余额已归零）。
- `CycleEndTime` **会把套餐误判**：订阅包的计量周期是月度的（月底清零），但扣费
  截止在 8 年后。取前者会把每月刷新的套餐当成「马上作废」，锁定就形同虚设。
- 余额口径取 **`CycleCapacityRemain`（本计费周期剩余）**，与 IDE 顶部的
  `Credits Balance` 一致：实测体验版**终身**还剩 500 而**本周期**剩 0，
  那 500 实际扣不到，算进可用额度会出现「看起来有钱却用不了」。
- 到期时间**未知**（服务端没给 `DeductionEndTime`）的包归入永久桶——保守方向，
  最坏是少用一个号，而不是误把长期积分当快到期烧掉。

**选号策略**（与 Loomy 同构）：有 15 天内到期积分的号优先 → 只剩永久积分的号
→ 无余额 / 查询失败排最后；**档内保持你在 Jet Hub 拖拽的手动顺序**。余额查询带
60 秒缓存（该端点响应实测可达数百 KB，一个账号可能有 105 个资源包）。

| 状态 | 行为 |
|---|---|
| 解锁（默认） | 先烧快到期的积分，这类用完**继续用永久积分** |
| **锁定** | **只消耗 15 天内到期的积分**；只剩永久积分的账号视为不可用 |

锁定后若所有账号都没有 15 天内到期的积分，请求报**明确错误**提示你解锁，
而不是偷偷消耗永久积分。

⚠️ **中国版的一个直接推论**（实测，不是缺陷）：CodeBuddy 的赠送包按 30 天发放，
「距到期」天然落在 17～30 天区间 ⇒ 默认 15 天窗口下**整池都算永久**，锁上就立刻
「无可用账号」。想在这种池上用锁定，把窗口放宽即可（重启插件生效）：

```
DSH_BUDDY_EXPIRING_WINDOW_DAYS=31
```

实测（窗口 31 天）：该账号 10064 积分里 6264.61 改判临时、3799.99 仍是永久，
锁定后仍可正常选号。面板与报错文案会**跟随后端回传的实际天数**渲染，
不会出现「提示说 15 天、实际按 31 天筛号」。

开关是 **provider 级**（CodeBuddy 与 WorkBuddy 各一份，互不影响），持久化在独立文档
`$DSH_HOME/jet-hub/permanent-locks.json` 的 `locks` 表（形如 `{ buddy: true }`，
缺键即未锁定）；RPC 端点 `credits.permanentLock`（`loomy.permanentLock` 是同一
实现的历史别名）。

⚠️ **为什么不与账号池同放 `state.json`**：那份文档是 **dsh home 级、同机多 profile
共享**的，而本插件的存储是整体替换语义。若你像我一样把 desktop 与 web 分成两个
工作区（两份代码版本不同），另一侧的旧版本代码任何一次整体写入（加删账号、改模型
开关、命中限流）都会把它不认识的字段抹掉 —— 于是这侧的锁定**静默失效**，而失效的
后果是真把永久积分烧掉，不可撤回。拆成独立文档后旧代码从不碰它，两个工作区才真正
互不影响。Loomy 那一项仍会同步一份镜像到 `state.json` 的 `loomyPermanentLocked`
（旧版本只读它），所以另一侧的 Loomy 面板也不会显示错值。

### 模型列表开关（黑名单）

Jet Hub 面板标题栏的「**显示列表**」按钮展开该 provider 的**全部模型**，每个模型
后面带一个开关，**默认打开**。关闭后该模型不再出现在对话框的模型选择列表里。

采用**黑名单制**：只有被显式关闭的模型会被隐藏，未记录的模型（含服务端后续新增的
模型）一律默认显示。这与白名单制的关键差别在于——新模型上线时无需任何配置就会
自动出现在选择器里，不会被静默挡在门外。

- 开关状态持久化在 `jet-hub` settings 命名空间的 `disabledModels` 字段
  （形如 `{ buddy: { 'glm-5.2': true } }`），与账号池同处一个 namespace。
- 模型列表来自 `ctx.llm.listModels()`，**即对话框模型选择器读取的同一份目录**
  （会话控制器的 `buildModelCatalog`），因此设置页展示的模型与实际可选集合始终
  一致，不会出现「设置里有、选择器里没有」的错位。
- 过滤发生在适配器的 `listModels`（`src/llm-adapter.ts` / `src/buddy-adapter.ts` /
  `src/lobsterai-adapter.ts`），
  每次调用都直接读账号池的黑名单，因此**改开关后下一轮模型目录刷新即生效**，
  无需重启或重建适配器。
- **只影响目录播报，不改变路由能力**：被关闭的模型仍可被 `resolveModel` 解析、
  仍能正常收发请求。这是 DSH 对 `listModels` 的约定（目录是建议性的，缺省不构成
  请求拒绝）。好处是已有会话若正用着某个被关闭的模型，不会被强制中断。
- 开关按 provider 隔离，CodeArts / CodeBuddy / WorkBuddy / LobsterAI 四份黑名单互不影响。
- 相关 RPC 端点：`model.list`（列出模型并回填 `disabled`）、`model.setDisabled`
  （打开/关闭单个模型），实现见 `src/jet-hub-rpc.ts`。

### 没有已登录账号就不显示该 provider（目录门控）

**需求**：若某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。

**机制**：DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`
（注释 *"successful non-empty provider groups"*），所以适配器 `listModels`
返回**空数组**即可让整个 provider 分组从模型选择器消失 —— **无需任何前端改动**。

- **判据是「凭据能否解析」**，不是「有没有账号条目」：登出（`logout()`）只清凭据、
  保留条目，若只看条目则登出后模型仍会显示，门控形同虚设。
- **不看 `enabled`**：停用只影响自动选号，与「是否已登录」无关。把所有账号停用的
  用户仍能看到模型（与「续期只看 `refreshable`」是同一条约定）。
- ⚠️ **CodeArts 是唯一保留单凭据模式的 provider**：它额外把
  `CODEARTS_ACCESS_TOKEN` 计入判据，只用单凭据登录的老用户不会受影响。
  其余五个 provider 只看账号池。
- ⚠️ **返回空数组而非抛错**：抛错会被归入 catalog 的 `failures`，界面反而多出
  一条 provider 报错。
- ⚠️ **不影响路由**：`routableProviders` 单独生成（不经该 filter），已持久化的
  模型仍可正常收发 —— 与黑名单同一契约。
- ⚠️ **门控只作用于对话框目录**；Jet Hub 的「显示列表」（`listAllModels`）仍列出
  全部模型，否则用户关掉模型后连开关都看不到、无法重新打开。
- **判据不可用时保守放行**（无账号池 / 替身未实现 / 读凭据异常）：门控是展示优化
  而非安全边界，宁多勿少。
- 开关：`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`（**默认开启**，设 `0`/`false`/`no`/`off`
  可关闭）。实现见 `src/account-pool.ts` 的 `hasLoggedInAccount` /
  `providerCatalogVisible`。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**支持范围**：四个 provider 都支持，但**三套协议各不相同**：

**CodeBuddy 中国版与 WorkBuddy 国际版**（同一接口，只是 baseURL 随
`product.endpoint` 切换）：

```
POST /v2/billing/meter/get-user-resource    body {}
```

**LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`。

**CodeArts**（华为云，见 `src/codearts-credits.ts`）：

```
GET {snapEngineUrl}/snap-manager/v1/statistics/plugin
```

余额取自响应的 `metrics[]` 中 `usageTotalPackageCredit` 的
`package_credit_remain`（**不累加**基础/按需/赠送分类明细——它们是总额的
构成项，相加会重复计算）。非积分计费账户不显示「查询失败」，而是如实提示
「Token 计费账户，无积分余额」——那是账户类型差异，不是故障。

> 能力矩阵在 `plugin-src/client/credits-capabilities.js`，由客户端在
> **请求前**判定，而非等后端返回错误再吞掉。
>
> 历史缺陷：早期客户端在面板挂载时对所有 provider 无条件调用
> `credits.balances`，而当时 CodeArts 没有积分能力，于是每次打开 CodeArts
> 面板都会在控制台报 `unsupported provider: codearts`，并把每个账号卡片的
> 「积分」渲染成「查询失败」。修法是不发起该请求——后端 `productById()` 的
> 拒绝是正确的契约行为，不该被当作运行时故障展示。

### 一键领取积分（每日签到）

**四个 provider 中三个提供**该按钮（三套签到协议完全不同，实现各自独立）。
WorkBuddy 国际版后端没有签到接口，故其面板不显示。

在 Jet Hub 对应面板标题栏点击「**一键领取积分**」，插件会对该面板下
**全部账号**顺序执行每日签到领取：

> **含已停用账号。** 停用只影响账号池的自动选择与限流切换，不改变账号本身
> 是否已签到——用户点「一键领取」时期望所有账号都尝试一遍。

**CodeBuddy（两步）**：

1. 先查签到活动状态（`POST /v2/billing/meter/checkin-activity-status`）；
2. 活动未开启或今日已签到则跳过领取请求，只报告状态；
3. 否则调用领取端点（`POST /v2/billing/meter/daily-checkin`）领取当日积分。

**LobsterAI（三步，见 `src/lobsterai-credits.ts`）**：

1. 查活动槽位（`GET /api/client-activities/slot`，带固定的
   `placement` / `containerApiVersion` / `platform` 参数）；
2. 查活动上下文（`GET /api/client-activities/{code}/context`），
   读 `claimedToday` 与 `actions` 决定是否可领；
3. 领取（`POST /api/client-activities/{code}/actions/check_in`，
   请求带客户端幂等键 `idempotencyKey`）。

> LobsterAI 的 `clientVersion` 是签到**必填**参数，由插件动态拉取
> （`api-overmind.youdao.com` 的更新接口，缓存 12 小时）；
> 拉取失败时回退内置兜底版本并在日志告警 —— 比参考实现的
> 「取不到就完全放弃签到」更宽容。

**CodeArts（四步，见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)）**：
账户类型检测 → 活动列表预检 → `POST /v1/ops/claim` →（必要时）
`POST /v1/ops/confirm`。

完成后按钮下方给出结果摘要（如「3 个账号领取成功（+300 积分），1 个今日已领取」）。
领取按账号隔离：单个账号凭据缺失、损坏或请求失败不会中断整批，只计入失败数；
摘要**只显示各类计数**（如「1 个失败」），不展示每个账号的失败原因——原因保留在
`results[].outcome.message` 中，需要时请通过 RPC 响应或日志查看。

几点实现约定：

- 领取是**顺序执行**的，避免并发触发风控；账号较多时需要等待片刻。
- **CodeBuddy** 重复领取是幂等的：服务端返回 HTTP 400 + `code 10001`（「今天已签到，
  请明天再来」），插件把它识别为 `already-claimed` 而非失败。
- **LobsterAI** 的幂等由**客户端**保证：请求带 `idempotencyKey`，且领取前先读
  `context` 的 `claimedToday` 与 `actions`；重复领取会被识别为 `already-claimed`。
- **CodeArts** 的幂等由**活动列表预检**保证：没有幂等键、也没有「今天已签到」
  业务码可依赖，唯一的保护是 `claimable` / `status` 预检（见下节）。
- CodeBuddy 的状态查询用 `checkin-activity-status` 而非 `checkin-status`；后者返回
  占位数据（`active:false`、`checkin_dates:null`），会让人误判为活动未开启。
- CodeBuddy 的请求**不需要** `X-Device-Token`（图灵盾）——已实测验证。
- LobsterAI 的签到**不需要签名**，只用 `Authorization: Bearer`；也**不发**腾讯系的
  `X-Domain` / `X-Product` / `X-Product-Code` 头。

想单独验证领取闭环（会真实改动账号当日签到状态）可运行
`pnpm test:e2e:workbuddy-claim`、`pnpm test:e2e:lobsterai-claim` 或
`pnpm test:e2e:codearts-claim`，说明见 `tests/e2e/README.md`。

### CodeArts 积分（华为云「每日签到得积分」）

实现见 `src/codearts-credits.ts`。活动规则见
[华为云官方文档](https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.html)：
完成每日签到得 **1000 积分**，积分自发放起 30 天内有效；**活动参与者限定
「已经升级到积分计费模式的用户」**——这正是必须先做账户类型检测的原因。

#### 认证走签名，不走 Cookie（关键结论）

官方文档给出的是**网页版**路径（`https://codearts.huaweicloud.com/portal/...`），
那是 portal BFF 接口，**依赖浏览器会话 Cookie**：实测不带 Cookie 时，无论是否
携带 AK/SK 签名，都返回 IAM 登录跳转 HTML（HTTP 200 + `text/html`）。
本插件没有可用的浏览器会话，因此**不能**复用那条路径。

可用的是**码道 IDE 直连**的 `snap-access` 端点，它接受
**`SDK-HMAC-SHA256` 签名**——与本仓库 `src/sign.ts` 逐字一致，
凭据就是现有的 `CodeArtsCredential`，**无需任何新的登录流程**。
协议逆向自本机安装的码道 IDE（`out/main.js` 的 `PackageInfoService`、
`out/vs/workbench/workbench.desktop.main.js` 的 `ActivityWelfarePane`）：

| 用途 | 端点（base = `snapEngineUrl`） |
|---|---|
| **账户类型检测** | `GET /snap-manager/v1/statistics/plugin` |
| 活动列表 | `GET /v1/ops/delivery?channel=IDE` |
| 领取 | `POST /v1/ops/claim` `{ campaignId, channel: 'IDE' }` |
| 领取确认 | `POST /v1/ops/confirm` `{ campaignId }` |

`snapEngineUrl` = `https://snap-access.cn-north-4.myhuaweicloud.com`
（与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` **同域**）。

所有请求需带 `Agent-Type: PromptCenter` 与 `X-Language: zh-cn`，但
**这两个头必须在签名之后追加，绝不能参与签名计算**：

> ⚠️ **实测（2026-09-18）**：把它们作为 `signRequestHuawei` 的 `extraHeaders`
> 传入（即进入 canonical request 与 SignedHeaders），服务端会回
> `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；
> 改为**签名后追加**则同一端点返回 200 与真实数据。
>
> 这与 `src/models.ts` 的 `fetchSignedGet` 一致 —— 其参数注释明确写着
> 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。
> 本模块早期版本误当作签名头，界面因此显示「积分：账户信息查询失败」。
> 回归测试见 `tests/unit/codearts-credits.spec.ts` 的
> 「Agent-Type / X-Language 不得出现在 SignedHeaders 中」。
>
> 注意 `src/llm-adapter.ts` 的 `maas_type: benefit` 是**反例** —— 那个头确实
> 需要参与签名（见其注释），不要据此推断其他头也该签名。

非 2xx 响应会把服务端的 `error_code` / `error_msg` 带进提示文案
（`describeHttpFailure`）。这一点很关键：只报 `HTTP 401` 会让「签名头位置错」
「AK 调用超限（`AK access failed to reach the limit`）」「凭据过期」这些
**处置方式完全不同**的问题看起来一模一样。

#### 账户类型检测

```
GET /snap-manager/v1/statistics/plugin
  → package.is_credit_package === true   ⇒ 积分账户（可领取）
  → package.is_token_package   === true  ⇒ 旧的 Token 计费账户（活动范围外）
```

领取流程**第一步**就判它：非积分账户返回 `inactive`（正常业务状态），
而不是 `failed`——后者会让用户去排查并不存在的故障。

#### 领取流程与幂等

1. 查账户类型 —— 查询失败 → `failed`；非积分账户 → `inactive`；
2. 查活动列表，取 `type === 'USER_LOGIN'` 的那项（**不是** `INVITE_USER` /
   `NEW_USER_REGISTER` / `STUDENT_CERTIFIED`，那些不是每日签到）；
3. 不可领取且 `status` ∈ {`CLAIMED`,`CONFIRMED`,`CONSUMED`} → `already-claimed`；
   其余不可领取 → `inactive`；
4. `POST /v1/ops/claim`；响应 `id !== null` 时补 `POST /v1/ops/confirm`
   （漏掉会让积分停在「待确认」而不入账）；
5. 成功 → `claimed`。

第 3 步是**唯一的幂等保护**：本协议没有幂等键，也没有服务端「今天已签到」
业务码可依赖，故预检不能省。

#### ⚠️ 活动列表的字段类型/名字与直觉不符

实测（2026-09-18）`GET /v1/ops/delivery` 的一个 item：

```json
{ "campaignId": 1, "type": "USER_LOGIN", "title": "每日签到领1000 积分",
  "benefitAmount": 1000, "benefitUnit": "CREDIT", "claimable": true,
  "status": "ELIGIBLE", "pendingCount": 1, "pendingTotalAmount": 1000 }
```

三个与直觉不符之处，任一处理错都会导致**领取失败或金额为 0**：

| 字段 | 真实形态 | 踩坑后果 |
|---|---|---|
| `campaignId` | **数字** `1`，不是字符串 | 用只收字符串的解析会得空串 → 判 `failed`「缺少 campaignId」 |
| 可领积分 | 字段名是 **`benefitAmount`** | 读 `amount`（不存在）→ 恒为 0 |
| `status` | 不可领取时是 **`null`** | 解析必须容忍 null |

> **真实缺陷**：上述前两条叠加，导致点「一键领取积分」后显示
> 「1 个活动未开启，1 个失败」——**积分实际没有领到**。
> 第一个账号（Token 计费）判 `inactive` 是正确的；第二个（积分账户）
> 因 `campaignId` 解析为空而失败。
>
> 早期单测没抓到，是因为用例喂的是**编造的** `campaignId: 'c-1'` 与
> `amount: 1000`。现在的用例直接使用上面这份实测字段集合。

#### 领取结果会逐账号显示原因

面板的领取摘要除计数外，还会列出每个账号的**具体原因**
（如「xxx：失败 — 活动缺少 campaignId，无法领取」）。这不是装饰：
上述缺陷最初只能靠翻代码 + 抓包定位，就是因为 UI 只显示「1 个失败」。
后端一直返回 `results[].outcome.message`，前端不该丢掉它。

#### ⚠️ refresh_token 是一次性轮换的

华为的 `refresh_token` **用一次即作废**（服务端回
`STS5.1806 the refresh token has been used`）。因此：

- 任何刷新都必须**立刻回写**新凭据，否则该账号只能重新登录；
- `tests/e2e/codearts-credential.ts` 只读凭据、**绝不刷新**——探针消耗掉
  refresh_token 会让用户的账号失效。这个坑在开发本功能时已真实踩过一次。

## LobsterAI provider（有道龙虾）

独立路由 `lobsterai`（有道 **LobsterAI**），OpenAI 兼容端点
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，
Bearer `access_token` 鉴权。

该 provider 与腾讯系**协议完全不同**，因此实现是独立一套
（`src/lobsterai*.ts`），只共用架构模式（产品配置驱动、账号池、限流切换、
模型黑名单）。关键差异：

| 项 | 腾讯系（CodeBuddy / WorkBuddy） | LobsterAI |
|---|---|---|
| 登录方式 | 轮询后端 API（无本地服务器） | **本地回调服务器**收 `authCode` 后换 token |
| 登录/API 域名 | 同一个 `endpoint` | **两个域名**（portal 与 apiBase） |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` | 仅 `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` |
| 续期请求体 | 只带 `refreshToken`（走 `X-Refresh-Token` 头） | 还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid` |
| `clientVersion` | 编译期常量 | **运行时从第三方接口动态拉取** |
| 每日签到 | 两步（状态 + 领取） | **三步**（slot + context + check_in） |
| 图片输入 | 支持 | **不支持**（`inputModalities` 仅 `text`） |
| 思考等级 | 支持（按模型声明档位） | **不声明**（是否支持未实测） |

> 上表是 **LobsterAI 与腾讯系**的对照。第三个协议族 **CodeArts（华为云）** 的
> 差异见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)：它用
> `SDK-HMAC-SHA256` **签名**（无 Bearer）、领取为**四步**
> （账户类型 + 活动列表 + claim + confirm），且 `refresh_token` **一次性轮换**。

- **登录入口：Jet Hub 设置页的 LobsterAI 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.lobsteraiAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()` / `resolveClientVersion()`。
- 凭据 ref：
  - 单账号：`LOBSTERAI_ACCESS_TOKEN`；
  - 多账号：`LOBSTERAI_ACCOUNT_<UUID_SHORT>`，由 Jet Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` 外，
  还持久化 `uuid` / `first_keyfrom` / `latest_keyfrom` 三个**身份字段** ——
  它们是续期请求体的必填项，丢失会导致静默续期失败、只能重新登录。
- ⚠️ **账号展示名是手机号（只露末 2 位）**：服务端把**手机号本身**当
  `user.nickname` 下发，且只脱敏到「露末 4 位」（实测 `130****1100`）。
  按用户要求由 `maskLobsteraiPhoneTail` 归一化为只露末 2 位
  （`130******00`）—— 归一化对「完整号码」与「露 4 位」两种输入**幂等**，
  故老账号在启动时由 `repairAccountNicknames` 自动补正，无需重新登录。
  非手机号形态的昵称**原样保留**（不误伤真实昵称）。
- 模型列表：远端 `GET /api/models/available` 优先（它是权威来源），
  失败时回退 `src/lobsterai-product.ts` 的 19 个内置模型。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  **终态判定比参考实现更精确**：只有 HTTP 401/403 或业务码 40100/40101
  才判为 `refresh_token` 失效；网络抖动走可重试路径，不会误让用户重新登录。

> **已知待实测项**（见 `docs/lobsterai-integration-plan.md` §7.2）：
> 是否支持 `reasoning_effort`、各模型真实上下文窗口（内置表统一填 131072，
> 是桥接层的估计值）、图片输入、`prompt_cache_key`。这些在实现里都取了
> **保守默认**（不声明 / 不发送），不会因未知而失败。

## Qoder provider

独立路由 `qoder`（阿里系 AI 编程 IDE **Qoder**）。**推理走加密端点**
（请求体与签名头由客户端自带的 WASM 生成），因此能拿到与客户端
**完全一致**的模型池（含 Qwen3.8 系列）。详见下方「两条推理路径」。

该 provider 与其余四者**协议都不同源**，实现是独立一套
（`src/qoder*.ts` + `src/qoder-wasm.ts` + `src/qoder-envelope.ts`
+ 复用的 `src/openai-compat.ts`）：

| 项 | 其余四个 provider | Qoder |
|---|---|---|
| 登录方式 | OAuth 回调 / external-link 轮询 / 本地回调 | **PKCE 设备码轮询**（不开监听端口） |
| 续期请求体 | 只带 `refresh_token`（+ 各自身份字段） | 还要带 **`machine_id`** |
| 推理鉴权 | 华为 HMAC / 纯 Bearer | **请求体加密 + 签名头**（不能自行构造） |
| 模型列表 | 远端接口（权威） | **本地静态表**（远端需签名）+ 加密端点使用目录 key |
| 积分能力 | 余额 ✓（`sash/api/v2/me/usage`）/ 签到 ✗ |

### 登录（设备码轮询）

浏览器打开 `https://qoder.com/device/selectAccounts?...`（PKCE `S256` +
`client_id`），用户在网页完成授权后，插件轮询
`https://openapi.qoder.sh/api/v1/deviceToken/poll` 取回
`{ token, refresh_token }`。

- **`404` 表示「用户尚未完成授权」，不是错误**，必须继续轮询
  （官方客户端同样如此）。实测依据：该端点返回 404 而任意不存在的路径
  返回 401，说明它被网关豁免认证、由业务层报「会话未就绪」。
- **必须走两步式**：`account.create` 在用户授权**之前**返回 `loginUrl`，
  由前端立即 `window.open`（浏览器 transient activation 约束，
  见 [+ 新建账号](#-新建账号必须走两步式登录四个-provider-一致)）。

### 两条推理路径（**认两套不同的模型名**）

这是本项目**最容易踩的坑**。Qoder 有两个推理端点：

| 路径 | 端点 | 模型名 | 能力 |
|---|---|---|---|
| **加密（本插件使用）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；**能拿到 Qwen3.8 系列** |
| 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash` / `qwen-plus`） | 标准 OpenAI 格式；**目录 key 一律被拒** |

⚠️ **两个 host 不同**（`api2` vs `api2-v2`），混用会 404。

**真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后**没收到回复就终止**」。
根因是早期把**目录 key 发给了公开端点**（得到 `Unsupported model`，
且该错误帧又被解析器静默吞掉）。

随后又误判为「目录 key 不可用」，把模型表换成了通用名 —— 于是拿到的是
**Qwen3.5 / Qwen-2.5**，而不是目录里的 Qwen3.8 系列（用户再次报障）。

### 加密推理（`src/qoder-wasm.ts`）

Qoder 的**真实**推理链路要求请求体加密、并带一套服务端认可的身份签名头，
否则请求被拒。客户端把实现该协议的 WASM 内嵌在自身产物里，本插件按
wasm-bindgen 约定把它接起来**复用**（`src/qoder-wasm.ts`）。

- **不是「破解密码学」** —— WASM 自己就导出了成对的编解码函数，我们只是
  调用它，等同「用客户端自己的钥匙开自己的锁」。
- **响应不需要解密** —— 只在每帧外套一层信封，内层是标准 OpenAI chunk；
  `src/qoder-envelope.ts` 负责剥信封，剥完交给 `src/openai-compat.ts`。
- ⚠️ **签名头必须原样透传**，不能用 `Bearer <token>` 覆盖（会被判签名无效）。

> 实现细节（glue 约定、请求体字段、签名载荷、三个已踩过的坑）记录在
> **不入库**的内部文档 `docs/qoder-encryption-notes.md` 中 ——
> 该文档含逆向分析，刻意不随仓库分发。

### 工具调用（tools）

加密端点认 **OpenAI 风格**的工具描述，落在请求体**顶层** `tools`：

```jsonc
"tools": [{ "type": "function",
            "function": { "name": "read", "description": "…", "parameters": { … } } }]
```

assistant 的工具调用挂 `tool_calls`，工具结果用 `role:"tool"` + `tool_call_id`。

⚠️ **真实缺陷**（用户报障）：「使用本插件的 qoder 的 qwen3.8-flash，
执行任务出现任务调用 xml 泄露任务终止」。两处根因：

1. 适配器**从不消费 `options.tools`**（其余四个 provider 都消费），且
   `qoder-wasm.ts` 把请求体的 `tools` **硬编码为 `[]`** → 模型在 wire 上
   拿不到任何函数 schema，只能用**正文里的 XML 文本**臆造工具调用，
   harness 认不出 → 任务终止；
2. history 过滤器写成「只留 `content` 为字符串的消息」，而 assistant 带工具
   调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条被丢，`role:"tool"` 的
   `tool_call_id` 也被丢 → 模型看不到自己调用过什么，反复重调同一工具或
   凭空编造结果（与 TRAE 那条同型缺陷一致）。

⚠️ **别照抄 Anthropic 风格**：客户端另有 `tool_use` / `input_schema` /
`tool_use_id` 一套，那是给 **Anthropic BYOK** 用的分支，本端点不吃。

⚠️ **加密端点的请求体本地不可解**，无法靠抓包验证 —— 故 payload 构造抽成
纯函数 `buildQoderInferPayload()`，由 `buildQoderTools()` /
`buildQoderHistory()` 与端到端替身共同锁死（`tests/unit/qoder-tools.spec.ts`）。

### 「没有任何报错就中断」已修

症状：UI 上**看不到任何错误**，任务却停在了半路（`turn/end` 是 `completed`）。

**根因**：`consumeOpenAiSse` 把「**没收到 `finish_reason`** 且**没有工具调用**」
直接判成 `{kind:'stop'}` —— 而 `stop` 是「模型正常答完」的信号。于是**被掐断的
连接伪装成正常结束**，harness 认为本轮已完成，任务就此中断。

真实案例（2026-09-23，`qoder`/`qfmodel`）：某步的 chunk 流只有
`block-start(text) → text → usage → block-end → finish{stop}`，**没有任何
tool-call 分片**，而正文以冒号「：」结尾（模型正要调工具），`outputTokens=118`
远未触上限；相邻的**正常步**则多出 `block-start(tool-call) → tool-call-chunks`。

**修复**：判据改为「**连接结束的方式**」—— 既没有显式 `finish_reason`、
也没有 `[DONE]`，就报 `max-tokens`（不完整、可重试），不再报 `stop`。

同时修掉两个同族缺陷（都表现为「无报错中断」）：

- **网关形态错误帧被整帧丢弃**：`{"stackTrace":[…],"message":"…","statusCodeValue":400}`
  既没有 `code` 也没有 `error`、也没有 `choices`，早期解析器所有条件都不命中；
- **响应根本不是 SSE**（网关直接回了一段 JSON，没有任何 `data:` 帧）：
  早期静默空结束，现抛错并**带上原文片段**。

> 排查这类问题用 `node scripts/inspect-session.mjs`（只读）——它能把会话日志
> （zstd 压缩的 JSONL）里的**原始 chunk 流**还原出来。用法见 `AGENTS.md`。
> 回归用例 `tests/unit/qoder-silent-stop.spec.ts`。

### 模型列表：17 个目录 key（**实测数据**）

`listModels` 是**静态表**（不发网络请求）—— 远端目录需签名，运行时不做。

表里是客户端目录下发的 **17 个 key**，全部实测可用：

| 分组 | 模型 |
|---|---|
| Qoder 档位 | `auto` / `ultimate` / `performance` / `efficient` |
| 内部代号 | `smodel`(Sonus) / `cmodel`(Cantus) |
| **Qwen** | `qmodel_38max`(3.8-Max) / **`qfmodel`(3.8-Flash)** / `qmodel_latest`(3.7-Max) / `qmodel`(3.7-Plus) |
| Kimi | `kmodel_latest`(K3) / `kmodel`(K2.8-Preview) |
| GLM | `gmodel`(5.3) / `gfmodel`(5.3-Flash) |
| DeepSeek | `dmodel`(V4-Pro) / `dfmodel`(Flash) |
| MiniMax | `mmodel`(M3) |

⚠️ **请求体必须带 `business` 字段** —— 缺了服务端会把请求路由到故障节点，
而**其余模型恰好不受影响**，所以现象像「只有 `qfmodel` 一个模型坏掉」，
极易误判成「服务端故障」。**判据是「Qoder IDE 能否用同一模型」**：
IDE 能用即说明是我们的请求缺东西。

**免费额度模型**（`is_free=true`）：`qmodel_38max` 与 `qfmodel`。
e2e 探针默认用 `qmodel_38max` 以免消耗积分。

- 该表**会逐渐过时**（新模型上线后不会自动出现）；
- 按 DSH 约定「`listModels` 结果仅供参考」，**表外的 key 仍可手动指定**；
- 需要刷新时按下方「升级 WASM」流程重新采集，并**逐个验证可推理**再入库。

### 升级 WASM（Qoder 版本更新时）

Qoder 升级后签名协议可能变化，表现为**难以解释的 `Signature invalid`**
或 `[FAIL]node:...`。此时刷新：

```bash
pnpm qoder:wasm            # 自动取本机 Qoder 最新版本的内嵌 WASM
pnpm qoder:wasm 0.3.5      # 或指定版本
pnpm build:assets          # 同步到 lib/
```

脚本取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE
**实际运行**不同的版本。刷新后**务必实测一次对话**（`qfmodel` 或
`qmodel_38max`）确认签名仍被接受。

### 积分余额（Credits Balance）

`qoder` 面板**支持积分余额**：

```
GET https://openapi.qoder.sh/sash/api/v2/me/usage
Authorization: Bearer <token>
Cosy-ClientType: 5
```

⚠️ 两个易错点：

1. **路径前缀是 `/sash/`**，不是 `/api/`。早期因为只按 `/api/` 前缀搜索
   而误判「Qoder 无积分端点」。
2. **余额不只在 `userQuota` 里**。实测某账号 `userQuota.remaining = 0`
   而 `addOnQuota.remaining = 100`（资源包）；只读 `userQuota` 会显示 0。

该端点**只需 Bearer**，不需要模型列表那样的 WASM 签名。企业版账号
（`displayMode: "enterprise"`）不下发额度数字、只给外部链接，此时返回
「查询失败」而非 0。

### 每日领取（每日 100 Credits）

```
GET  https://openapi.qoder.sh/sash/api/v1/me/campaigns
POST https://openapi.qoder.sh/sash/api/v1/me/campaigns/{campaignId}/claim   ← body 空
```

活动**每日 10:00（UTC+8）刷新**，领取后 30 天有效。

⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样返回
**200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是上一次领取的
旧时间。只看状态码会把「今天已领」误报成「领取成功 +100」。

⚠️ 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'` ——
实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。

> **这段协议是抓包解出来的**：早期依据 `/sash/api/v1/me/campaigns` 返回
> `claimable:false` 判定「Qoder 无签到」，真相是**那天已领**。

### 凭据与续期

- **登录入口：Jet Hub 设置页的 Qoder 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 凭据 ref：单账号 `QODER_ACCESS_TOKEN`；多账号
  `QODER_ACCOUNT_<UUID_SHORT>`（由 Jet Hub「+ 新建账号」生成）。
- 凭据结构：`security_oauth_token` 与 `access_token` **双写同值**
  （服务端取用顺序是前者优先），外加 `refresh_token` / `expire_time` /
  `refresh_token_expire_time` / **`machine_id`**。
- ⚠️ **`machine_id` 必须持久化**：续期请求体需要它。本插件生成**随机 UUID**
  并随凭据保存（不复制官方客户端的硬件指纹逻辑 —— 那依赖 `@napi-rs` 原生
  模块取 SMBIOS UUID，属设备指纹且不可移植）。**这是本实现最大的未验证
  假设**：若服务端校验设备一致性，续期会被拒。`pnpm test:e2e:qoder-chat`
  的续期用例专门验证这一点。
- 续期：与其他 provider 同一调度器（启动后每 30 分钟对**可续期**账号静默
  刷新）。终态判定：HTTP 401/403 或响应缺 token → `RefreshTokenExpiredError`
  （停止重试）；网络抖动与 5xx 走可重试路径。

### 适用范围

本章节描述的是**国际版**（`qoder.com` / `qoder.sh`）。
中国版（`qoder.cn` / `qoder.com.cn`）的端点与 `client_id` 都不同，
已作为独立 provider 实现，见下一节
[Qoder CN provider](#qoder-cn-providerqoder-中国版)。

## Qoder CN provider（Qoder 中国版）

第九个 provider，id `qodercn`，面板显示为 **Qoder (中国版)**。
与国际版 `qoder` **共用同一套协议实现**（PKCE 设备码轮询 + 加密推理 + `/sash/` 积分，
含**同一份 WASM**），差异全部收敛在 `src/qoder-product.ts` 的 `QODER_CN`。
新增同族产品时**不要**复制 `src/qoder*.ts` —— 那会让 tools 不下发、工具历史丢
`tool_calls`、错误帧不抛错这类缺陷修两遍。

### 前提

装过 Qoder 中国版桌面端（`%LOCALAPPDATA%\Programs\Qoder CN`）**不是必需的** ——
登录与推理都由插件自给自足。
但**积分每日领取**依赖本机 `runtime-info.exe` 生成设备身份
（`~/.qoder/.bin/umid-*/` 或 `~/.qoder-cn/.bin/umid-*/`，**任一存在即可**，
两站同 `environment` 返回同一身份）。两者都没有时不带 machine 头，
服务端就不会下发可领取的活动 —— 症状是「报今日已领，但官方能领」。

### 与国际版的差异

| 项 | 国际版 | 中国版 |
|---|---|---|
| 授权 / 网站 | `qoder.com` | `qoder.cn` |
| OpenAPI | `openapi.qoder.sh` | `openapi.qoder.com.cn` |
| 加密推理 | `api2.qoder.sh` | `gateway.qoder.com.cn` |
| 公开推理 | `api2-v2.qoder.sh` | **无**（实测 503） |
| `client_id` | `e883ade2-…` | `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`（**不同**） |
| 模型数 | 17 | 14 |
| 凭据 ref | `QODER_ACCESS_TOKEN` / `QODER_ACCOUNT_*` | `QODERCN_ACCESS_TOKEN` / `QODERCN_ACCOUNT_*` |
| 服务名 / 路由 | `qoderAuth` / `llm-qoder` | `qoderCnAuth` / `llm-qodercn` |
| WASM | `src/qoder-auth-wasm.wasm` | **同一份**（实测可解 CN 目录、可签 CN 请求） |

### 中国版独有的模型

`q37fmodel`（Qwen3.7-Flash · x0.1）、`gm51model`（GLM-5.2 · x0.6）。

### 中国版没有的模型

`ultimate` / `performance` / `efficient` / `smodel`(Sonus) / `cmodel`(Cantus) ——
CN 目录不下发，故中国版面板里看不到也选不了。

另外几条同名模型在 CN 的参数**不同**，不是简单取子集：
`dmodel` 上下文 96K（国际版 1M）、`qmodel_latest` / `qmodel` / `dfmodel` / `kmodel`
都是 180K、`mmodel` 是 **MiniMax-M2.7**（国际版 M3）且不支持图片。

### 积分

与国际版同：`GET /sash/api/v2/me/usage` 查余额，
`GET /sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim` 每日领取。
活动每日 10:00（UTC+8）刷新，幂等判据是响应体的 `replayed`。
实测（2026-09-27）CN 账号余额由**套餐额度 + 资源包**两部分累加，
领取一次得 100 分且余额确实增加 —— 与国际版的多包累加口径一致。

### 验证命令

```bash
pnpm test:e2e:qodercn          # 只读：授权 URL 构造 + 四个端点存在性（零额度）
pnpm test:e2e:qodercn-chat     # 真实加密对话（默认免费模型 qfmodel）
pnpm test:e2e:qodercn-credits  # 余额 + 活动 + 真实领取一次
node scripts/verify-qodercn-live.mjs   # 一次性：登录→推理→积分，token 不落盘
```

设计依据与全部取证：`docs/superpowers/specs/2026-09-27-qodercn-provider-design.md`
（该目录按仓库约定不入库）。

## TRAE provider（字节跳动 TRAE）

独立路由 `trae`（字节跳动 **TRAE**），走 SOLO 免费对话通道，
端点 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`，
以 `Cloud-IDE-JWT <token>` 头鉴权。

该 provider 是**第三个独立协议族**（实现见 `src/trae*.ts`），与腾讯系、
LobsterAI 都不同源。它也是唯一一个**请求与响应都要转换**的 provider：

| 项 | 其它 provider | TRAE |
|---|---|---|
| 消息序列化 | 有（`tool-call` → `tool_calls`） | **必须有**（DSH 原生块 → OpenAI wire）；漏掉会让**模型看不到工具调用与结果**（真实缺陷，已修复） |
| 请求体 | 基本透传 OpenAI 格式 | **必须转换**为 SOLO 格式（`function: "solo_work_lite"`、`config_name`、`tools.parameters` 序列化为字符串、`tool_calls.function` → `function_call`） |
| 响应流 | OpenAI 标准 SSE | **SOLO 自定义事件**（`output` / `token_usage` / `done` / `error`），需转成 OpenAI chunk |
| 鉴权头 | `Bearer` / 签名 | `Cloud-IDE-JWT` + 十余个 `X-*` 身份头 |
| 换 token | 轮询 / authCode | **ExchangeToken**（`refresh_token` 会**轮换**） |
| 设备指纹 | 无 | **必须持久化** `machine_id` 与 `device_id`（均为 32 位 hex） |
| **登录回调** | 各不相同 | **老流程直接回传 token**（`refreshToken` / `userInfo` / `userJwt`）；**并存 PKCE 新流程**（带 `code` / `authCodeInfo`），两套都要认；参数名是 **`auth_callback_url`** |
| 回调端口 | 各不同 | 默认 `127.0.0.1:18080`，**被占用时自动回退随机端口** |
| 图片输入 | Buddy / LobsterAI 支持 | **支持**，但**逐模型**判定（远端 `display_config.multimodal`；本插件可见集里约 15/19 为 `true`） |
| 历史长度 | 无硬约束（只由 DSH 的压缩点决定） | **同样无硬约束** —— 曾经的「约 500K 字符上游会静默断流 → 自动裁剪」本地闸门**已删除**（依据是从别的项目抄来的、且会**静默丢历史**）。实测（常规档）**100 万字符 / 24.9 万 tokens** 仍正常返回，正中标记命中 ⇒ 那条传闻已被证伪到 2 倍 |
| 单次输出上限 | 采信远端声明 | 收敛到 **64000**（上游安全线，可配） |
| 模型列表 | `GET` | `POST /api/ide/v1/get_detail_param`（响应 `config_info_list[]`） |

> **图片输入（逐模型）**：判据是远端 `display_config.multimodal`。
> `true` → 声明 `['text','image']` 并把图片转成 `{type:'image_url',image_url:{url}}`
> 的 data URL 发出；`false` / 未声明 → 收到图片时明确报错且**不发请求**。
>
> 实测（2026-09-21）：直发纯红图答「红色」、纯蓝图答「蓝色」、不带图答「无法确定」
> —— 三次答案不同，证明模型真读到了像素。而 `multimodal: false` 的模型
> （如 `DeepSeek-V4-Pro-Official`）收到图后答「无法确定」、思考链明说「但没有图片」，
> 与不带图的回答一致 → 该标志是**权威准入判据**。
>
> ⚠️ **用户贴图**与**工具结果内嵌图**是两个独立字段
> （`multimodal` / `tool_response_multimodal`）：实测 `deepseek-v4.1-flash`
> 前者 `true`、后者 `false`，不可合并判断。

- **登录入口：Jet Hub 设置页的 TRAE 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.traeAuth.login()` / `startLogin()` / `status()` / `refresh()` /
  `logout()` / `fetchModels()`。
- 凭据 ref：
  - 单账号：`TRAE_ACCESS_TOKEN`；
  - 多账号：`TRAE_ACCOUNT_<UUID_SHORT>`，由 Jet Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` /
  `uid` 外，还持久化 **`machine_id`** 与 **`device_id`**（两者均为 32 位 hex）：
  - `machine_id` 是设备指纹，续期时**绝不可重新生成**（服务端按它标识设备）；
  - `device_id` 是签到设备号，**账号间必须互异** —— 同一天两账号共用会被
    「该设备已签到」拦截，为空则签到报 9004。
  另有可选的 **`phone` / `email`**（`GetUserInfo` 的脱敏形态，仅用于账号展示名，
  见下「账号展示名」）。
- 登录 URL 含 **18 个参数**（对齐唯一权威实现 `login.sh`），包括
  `auth_from=solo`、`login_channel=native_ide`、`plugin_version`、
  `login_trace_id` 与 `x_*` 客户端形态系列。少发参数会让登录页停在授权中。
- **两套回调流程都要认**：
  - **老流程**（当前 `auth_type=local` 实际走的）：直接回传 token，形如
    `?refreshToken=...&userInfo={...}&userJwt={...}`，不做授权码交换；
  - **新流程**（PKCE）：回带 `code` / `authCodeInfo`。本实现会**识别**它并给出
    「上游走了 PKCE 流程，暂不支持」的**精确报错**，而不是笼统地说
    「缺少 refreshToken」（把合法回调误判为无效会把排查方向带偏）。
  另外 `userInfo` 的中文昵称存在双重编码乱码，插件会自动回转修复。
- ⚠️ **账号展示名用脱敏手机号，不用 `ScreenName`**：`ScreenName` 是字节 passport
  **按 uid 自动生成的默认名**（实测四个账号全是 `用户26815487395` 这种形态），
  多账号在面板里**彼此无法区分**。`GetUserInfo` 会下发 `NonPlainTextMobile`
  （形如 `130******00`，中间打码），实测末两位互异、足以区分。
  取值顺序：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**。
  老账号在插件启动时由 `TraeAuth.repairAccountNicknames` 自动回填一次
  （幂等；**拿不到真实标识时不动昵称**，以免覆盖用户手动改过的名字）。
- ⚠️ **任何回调路径都必须落定登录结果 Promise**：早期实现里解析失败分支只
  `res.end()` 就 return，导致 `login.poll` 永远拿不到 `done:true`，
  前端**永久停在「认证中」**。这与「参数名写错」是两个独立根因、同一个症状。
- 模型列表：走**批量**端点 `POST /api/ide/v1/batch_get_detail_param`（真实 CN IDE
  的用法），**一次拉取多个「通道」（`function`）各自一套模型目录**；失败时回退
  `src/trae-product.ts` 的 32 个内置模型。
- ⚠️ **模型只在列出它的通道里可调用**。实测：`glm-5.1` 在 `solo_agent_remote`
  正常、在 `solo_work_lite` 回流内 `4001`。因此插件会**按每个模型所属通道分别
  下发 `function`** —— 旧实现把 `function` 写死 `solo_work_lite`，agent 专有模型
  一用就报 `trae: We're sorry, the param is invalid. (code=4001)`。
- ⚠️ **通道表同时是「可调用白名单」，不只是排序表**（Issue IKJOZ7）。上游下发的
  22 个 `function` 里**只有一部分**在本插件的推理端点下真正可用 —— 实测
  `chat` 回 `4023 the model is unknown`、`builder` 回 `4001 param is invalid`、
  `inline_chat` 回 `3003 model service is unavailable`。此前实现「目录声明了什么
  通道就照着发什么通道」，于是 38 条目录里 **19 条（50%）** 带着不可调用的通道，
  用户一选中就失败，而报错文案指向**模型**、极易误判成「这个模型坏了」。
  现在非白名单通道的条目在解析时**整组剔除**。逐通道实测可调用的 15 个：
  `solo_agent` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` /
  `solo_agent_lite` / `solo_design_lite` / `solo_design_remote` / `solo_coder` /
  `chat_v3` / `builder_v3` / `git_ai` / `code_reviewer` / `code_review_summary` /
  `multimodal` / `system_diagnosis`（可用 `DSH_TRAE_CHANNELS` 覆盖，⚠️ 覆盖的是
  整张白名单）。
  ⚠️ **剔除 vs 纠正通道要分清**：`glm-5.1` / `DeepSeek-V4-Flash` / `qwen-3.5` 等
  同时也在可调用通道里，故它们**不消失**，只是通道被纠正（如 `glm-5.1`：
  `chat` → `solo_coder`）⇒ 从「必然失败」变成「可用」；**只有**「仅见于不可调用
  通道」的条目才会被剔除（实测 38 → 36 条，被剔除的是 `doubao_1_8` / `kimi-k2`）。
  ⚠️ **`glm-5.1` 现在走 `solo_coder`**，旧文档里「走 `solo_agent_remote`」已过期
  （它在 `solo_agent*` 里全是 `is_invisible_to_user: true`，被既有硬过滤挡掉）。
- ⚠️ **两种「不可用」要分开看**：
  - `display_config.is_custom_model === true`（需在 IDE 内自行绑定供应商）
    → **必然 4001，插件剔除**。实测 2026-09-19 该账号有 5 个，但**该名单已过期**
    （复测 2026-09-20：3 个下架、2 个转为 `false` 可调用，全目录 custom 条目数为 0）
    —— 判据是**标志的值**而非模型名，别把某一刻的快照写成规则。
  - `is_invisible_to_user === true`（**官方 picker 不展示**）→ **硬性剔除**，
    使目录与官方 Auto Mode 选择器一致（代价是看不到 `glm-5.1` 等可调用模型）。
  - `function` 不在可调用白名单内（见上）→ **整组剔除**。
  - 若仍选中了不可调用的模型（如会话里持久化的旧 id），报错文案会直接点明
    「模型不被上游接受」，而不是让人去查参数格式。
- **远端参数会被消费**：`context_window_tokens.dev` → 上下文窗口
  （实测主流 **200000**；`max` 的 1M 需官方 max_mode，本插件不实现）；
  `model_detail_list[].max_tokens` → 输出上限（实测主流 **32000**）。
- **`4001` 还有一个自伤成因**：请求头里 `Content-Type` 与 `content-type`
  各写一次会被 `Headers` 合并成 `"application/json, application/json"`，
  上游回 HTTP 400 + `code=4001`。写探针时请用 `new Headers(base).set(...)`。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  终态判定有三条依据（HTTP 401/403、`session-dead` 分类、2xx 但无 `accessToken`）；
  网络抖动与 5xx 走可重试路径。
- 失败模式：`4008`（`ide_credits` 耗尽）与 `1005`（plan 权益不足）是最主要的
  两个，会被分类为需要冷却的类别并触发多账号轮换。
- **签到所得积分如实上报**：`checkin_credits/claim` 的响应**只有**
  `{"code":0,"message":"success"}`，**不含积分数** —— 故领取成功后会补查一次
  `checkin_credits/status`（其 `credits` 字段即所得，实测 `150`，与积分余额里
  「签到奖励」包的 `credits_limit` 吻合）。早期从 claim 响应读 `credits`，
  于是恒为 0，界面显示「领取成功 **+0 积分**」。
- **已签到必须靠状态判定**：claim 对「今天已签到」是**幂等**的，重复领取同样返回
  `code:0`，与真正成功**无法区分** —— 故 `claimAll` 的 TRAE 分支**必须开启状态
  预检**（`checked_in`），不能用 `precheckStatus: false`，否则已签到的账号会被
  报成「领取成功」。
- **签到 `9074`（人数过多）不再换设备号重试**：设备身份已由 `uid` 确定性派生、
  每账号独立，「换个 id 就能成功」的前提不成立。命中即归为业务错误（300s 冷却）
  并如实上报。
- **空响应（HTTP 200 但零事件）重试一次**，且**仅在首个模型事件之前** ——
  已有输出后绝不放，避免重复计费与重复执行工具。
- 可调环境变量：
  - `DSH_TRAE_CHANNELS`（默认 `solo_work_lite,solo_agent_remote`）要拉取的通道，
    **顺序即优先级**（前面的通道优先决定同名模型走哪个通道）；
  - `DSH_TRAE_HIDE_INTERNAL=1` 连官方隐藏的条目一并从目录剔除（与真实 CN IDE
    的选择器一致，代价是看不到 `glm-5.1` 等可调用模型）；
  - `DSH_TRAE_MAX_COMPLETION_TOKENS`（默认 `64000`，设 `0` 关闭收敛）；
  - `DSH_TRAE_ROTATE_MACHINE_ID=1`（**默认关闭**）启用机器指纹轮换以应对集中风控。

> ⚠️ **历史长度不设本地闸门**：早先那道「请求体字符预算」裁剪（`DSH_TRAE_MAX_HISTORY_CHARS`）
> 已**整体删除**。它抄自 `Trae2api-cn` 的 `TRAE_REMOTE_MAX_HISTORY_CHARS=480000`（那其实是
> **声明窗口的量级**，不是量出来的天花板），在引入 Max 档后与 DSH 的压缩点脱钩，导致每轮
> **静默丢弃**约四分之三的历史（用户报障：「trae 显示的上下文长度不对」）。现与其余 13 个
> provider 同形：**唯一的限制是 DSH 的压缩点**（`声明的窗口 × 0.8`）。
> 该闸门赖以存在的「约 50 万字符即静默断流」也没有站住：实测（常规档、请求体已抓下来
> 确认无 Max 字段）**700,404 字符 / 173,712 tokens** 与 **1,000,484 字符 / 249,351 tokens**
> 都是 HTTP 200 且**埋在正文正中间的标记被复述**（截断就命中不了），后者比该档声明的
> 200K 窗口还多 24%。依据与反向验证见 `AGENTS.md` 的「TRAE 历史闸门（已删除）」段。

> 尚未实现：真实 CN IDE 的 `llm_utils_chat` / `create_agent_task` **请求体是加密的**
> （配 `x-helios` / `x-medusa` / `x-neptune`）；实测仅换版本头解不开依赖它的模型
> （`deepseek-v4-flash` 等）。属独立工作量。
>
> 🚫 **2026-09-24 实测更正（勿据此去啃加密通道）**：上面这条与
> `docs/trae-integration-plan.md:235` 是**另一条协议**的描述——加密端点属 **CN IDE
> 3.3.94 新协议**，而本插件走**旧 SOLO 协议**，两者不是同一条路。
> **实测 `deepseek-v4.1-flash` 在现有 SOLO 链路上就已可用**：走现成的
> `traeSOLOHeaders` + `transformToSOLOBody`（`function:"solo_agent"`）真发请求
> ⇒ **HTTP 200**、`event:done` 正常、`token_usage` 正常回传，模型自报
> `deepseek-v4.1-flash`。⇒ **做 4.1 不需要实现 `x-helios`/`x-medusa`/`x-neptune`**。
> ⚠️ 若手工拼 body 报 `4001 expr_path=usage missing required parameter`，**不是缺
> `usage` 字段也不是加密问题**，而是没走 `transformToSOLOBody`（它注入 `config_name`
> 并规范化 content）；`traeSOLOHeaders` 第 3 参 `stream` 必须为 `true`。
> （对照：已知可用的 `glm-5.3` 用同样错误构造报**完全相同**的错。）

> 实现依据见 `docs/trae-integration-plan.md`（协议逆向自
> [`trae2api`](https://github.com/Sliverkiss/traework2api) 及其衍生项目）。

## Cline provider

Cline（[cline.bot](https://cline.bot)）桌面端的账号与模型路由。协议全部由本机
Cline 产物逆向 + 实测得出（2026-09-25），与其余六个 provider **都不同源**：

| 维度 | 本 provider 的取值 |
|------|-------------------|
| 登录 | **WorkOS 设备码轮询**（`api.workos.com`，不起本地监听端口） |
| 鉴权头 | `Authorization: Bearer workos:<jwt>` —— **前缀不可剥** |
| 推理 | **标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`） |
| 续期 | `POST {apiBase}/api/v1/auth/refresh`，body `{refreshToken, grantType}` |
| 积分 | 余额有；**签到无**（后端没有签到接口） |

### 登录（设备码轮询）

Jet Hub 的 Cline 面板点「+ 新建账号」→ 浏览器打开授权页并显示用户码 →
在浏览器完成授权 → 插件自动换取凭据。全程**不需要**本地回调端口。

⚠️ **`authorization_pending` 不是错误**：它是「用户还没在浏览器里点授权」，
插件会继续轮询（与 Qoder 的「404 表示尚未授权」同类语义）。`slow_down` 会
**累积退避**后再轮询。

### 免费模型

Cline 的免费模型由远端 `GET /api/v1/ai/cline/recommended-models` 的 **`free`
数组**动态下发，插件在模型列表里把它们的名字标成 `· 免费`，例如：

```
Space Bunny Alpha · 免费
MiMo-V2.6-Flash · 免费
Muse Spark 1.3 Contributor · 免费
```

⚠️ **兜底表是编译期快照，上游撤掉某个免费模型时它不会自己跟着变** ——
而陈旧条目会让用户看到一个标着「免费」的模型、选中却回
`404 {"error":"model not found"}`。已经发生过两次：`gemini-3.8-flash`
（2026-10-03）、`deepseek-v4.1-flash`（2026-10-05）。

为此 `mergeClineModels` **只在远端不可用时**整表兜底；远端成功下发目录时，
它会丢弃「远端已不认识」的兜底条目（**在线状态下不会把下架模型复活**）。
判定「某个兜底免费模型是否已被上游下架」用 `pnpm test:e2e:cline`（只读、零额度）。

⚠️ **免费与付费是两组不同的模型 id**，不是同一模型的两种档位：

| 免费（`free` 数组下发） | 按量计费（同名前缀不同） |
|---|---|
| `cline-free/mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` |

插件的判定基于**完整 id**（远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/`
前缀 ∪ 静态兜底），**不做名字模糊匹配** —— 否则会把付费条目误标为免费，
用户按免费预期使用却被计费。

### 限流与额度耗尽（429 / 402）：倒计时用**服务端给的时间**

Cline 的几种「暂时用不了」语义完全不同，处理也必须不同：

| HTTP | 官方语义 | 插件的处理 |
|---|---|---|
| **429 `Daily free limit reached`** | **当日免费额度**用尽（按天结算，且**按模型**单独计） | 记「限额重置」徽章，倒计时**用报文里那个时长**（如 `Try again in 19h 39m`）；文案只说「按天结算、按模型单独计 + 预计 N 小时后重置 + 可先改用其它免费模型」（**不复述英文原文**，见下） |
| **429** 其它 | Rate limit exceeded | 记徽章，倒计时按 `retry-after` 响应头 → 报文的 `Try again in …` → 通用绝对时刻句式 → 1 小时快照兜底；并换到下一个账号重试 |
| **402** | Insufficient credits（去 app.cline.bot 充值） | **不记倒计时** —— 等多久都不会恢复；仍会换号（别的账号可能有余额），全失败时报明「额度已用尽……请到 app.cline.bot 充值」 |

⚠️ **倒计时必须是服务端说的那个数**（真实报障 2026-10-03，报障两次）。第一版写死
`Date.now() + 60 分钟`；第二版改成读 `retry-after` 响应头 —— **实测该头根本不存在**：

```
POST https://api.cline.bot/api/v1/chat/completions   （model = cline-free/deepseek-v4.1-flash）
→ HTTP 429   no-retry: true                ← 没有任何 retry-after
  {"error":{"code":"INFERENCE_CAP_ERROR",
    "message":"Error 429: Daily free limit reached on model
               deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}
```

真实等待是 **19 小时 39 分**，而代码读到的是「没有时间」→ 退回 1 小时快照 ⇒ 用户
等满一小时再试当然还是 429，而每次失败又从当下重算一小时 ——「永远 60 分钟」可以无限
循环。现在的解析见 `src/cline-rate-limit.ts`（认 `19h 39m` / `1h 30m` / `45s` 等写法，
也认非 JSON 的错误页）。

⚠️ **免费额度是按「账号 + 模型」计的**（同一时刻实测，同一个账号）：

| 模型 | 结果 |
|---|---|
| `cline-free/deepseek-v4.1-flash` | 429 `Daily free limit reached … Try again in 19h 29m` |
| `cline-free/mimo-v2.6-flash` | **200**（正常出字） |
| `cline-free/muse-spark-1.3-contributor` | **200** |

⇒ 一个免费模型到顶时，**换同一个账号的另一个 `cline-free/*` 模型可立刻继续**。

⚠️ **别把 `cline-pass/*` 当成「有余额就能用」的备用通道**：它是**订阅**通道。实测该账号
（余额 `500000`）请求 `cline-pass/deepseek-v4.1-flash` 回
**403 `ENTITLEMENT_ERROR: the user is not subscribed to required model plan`**，其
`/plan/usage-limits` 也是 `404 no plan history found for user`。故错误文案里**不提**它。

⚠️ **全部账号都不可用时，报错只给「是什么 + 何时恢复 + 现在能做什么」**，例如：

```
cline: 模型 cline-free/deepseek-v4.1-flash 的所有账号均不可用 —— 当日免费额度已用尽（HTTP 429），
预计 19.7 小时后重置（2026/10/4 19:49:20）；额度按天结算、按模型单独计 —— 可先改用其它免费模型
```

⚠️ **不要在上面的文案里复述上游英文原文**（真实报障 2026-10-03：「这个报告和其它的供应商
比起来是不是太长了？改简短点吧」）。早先的写法把原文整句塞进 `（HTTP 429 Error 429: Daily free
limit reached on model … Try again in 19h 39m）`，**再用中文解释一遍**，于是同一件事说了两遍，
消息长约 270 字符（其它 provider 的同类文案是 60~110 字符）。现在的规则：

1. **识别出语义就不再复述原文**（免费额度 / 402 两种都识别得出），原文只在**没识别出语义**时
   才附上（那种情况它才是唯一的排障线索）；
2. **错误消息里不能写 markdown** —— 气泡不渲染它，`**加粗**` 会**原样显示星号**；
3. 长度有单测上限锁（建议 < 100 字符、整条 < 150 字符），改文案时别把它撑回去。

需要区分这几种失败是因为「限流」「免费额度用尽」「额度耗尽」在 UI 上原本长得一模一样，而用户的
动作相反（等 / 换模型 / 充值）—— 这也正是 Cline 客户端自己修过的那条
（cline/cline#10139 `WAIT vs STOP not distinguished`）。

⚠️ **每个失败的账号都会被记上标记**（含换号预算用尽时的**最后一个**）：早期实现把标记
写在「下一轮的开头」，于是最后一个账号永远不写 —— 下一次取号又会选中它，立刻再撞一次
同样的墙（单账号用户尤其致命）。

> 账号卡片亮着「限额重置 · x 分钟后」时，点卡片上的「**重置**」可立刻清掉标记再试
> （不发请求）。那个标记只是「上一次失败时的快照」，服务端常在它到期前就放行。
> ⚠️ 若账号确实只是被限流挡住，现在报的是「…的可用账号均在限流中，预计 … 解禁
> （**无需重新登录**）」，不再是误导性的「请先登录」。

⚠️ 免费资格是**服务端随时可撤销**的营销状态，故插件每次都从远端重新取，
不在代码里硬编码任何免费模型名。

### 思考强度

模型选择器旁提供 `None / Low / Medium / High / Extra` 五档，与 Cline IDE 一致，
默认 **High**。

- `None` = 不思考（实测不传 `reasoning_effort` 时模型本就不思考）
- `Extra` 对应上游的 `max` 档 —— 内嵌目录里的 `xhigh` 实测与 `high` 无可辨差异，
  故跳过它，把真正的最高档留给 `Extra`

⚠️ 档位数据来自 Cline 客户端内嵌的模型目录，**远端接口不下发**（`/api/v1/models`
只有 `{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`）。对不在该目录里的模型，五档是统一给的 ——
上游不认识的档位会被**静默忽略**（不会导致请求失败，最坏是「开关无效」）。

⚠️ 声明默认档位 High 意味着**默认会思考**：未手动选择时插件会带上
`reasoning_effort: 'high'`，思考 token 计入 `completion_tokens`。想要完全不思考，
在选择器里选 `None` 即可。

### Gemini 系模型的两个 400（已修）

> ⚠️ **2026-10-03 补记**：`cline-free/gemini-3.8-flash` 已被 Cline 下线（不在
> `recommended-models` 的 `free` 数组里，直连该 id 回 `404 model not found`），
> 故兜底表已删除该条目。本节保留为**历史记录** —— 两个修法都是通用的：
> `clampClineMaxTokens` 对任何模型都生效，`sanitizeClineToolParameters()` 是为
> **所有**模型服务的安全网（任何严格校验工具 `enum` 的上游都会踩到）。

`cline-free/gemini-3.8-flash` 曾「发消息即失败」。错误体里一次请求有**两个
provider 尝试、两个不同的错误**，是两个独立根因：

| provider | 错误 | 根因 |
|---|---|---|
| `vertex` | `maxOutputTokens 131072 超出 1..65537` | 兜底表数值填错，应为 **65536** |
| `google` | `tools[..].properties[permission].enum[3]: cannot be empty` | 工具 schema 的 `enum` 含空串 |

- **上限**：该模型不在客户端内嵌目录里，曾经照抄其它免费模型填了 `131072`；
  实测上限是 **65536**。适配器的 `clampClineMaxTokens` 也会把越界值收敛。
- **工具 schema**：harness 下发的工具集里某些 `enum` 带空字符串成员，Gemini 系
  严格校验直接 400。插件从不自己造 enum（原样透传 `tool.parameters`），
  但请求是我们发的，故由 `sanitizeClineToolParameters()` 递归清洗：
  只删空串、保留数值枚举、全空则丢弃 `enum` 键、递归下钻嵌套层。

⚠️ 故障**不是必现的** —— 上游会依次 fallback 多个 provider，命中哪个就暴露哪个
错误。别因为「重发一次就通了」而误判为偶发故障。

### 「API 密钥无效」不一定是真的凭据问题

部分模型（实测 `cline-free/muse-spark-1.3-contributor`）在该地区不可用，Cline 返回：

```
403 {"error":"access forbidden: … is not available in your region","success":false}
```

⚠️ 这条 403 与凭据无关，但 DSH 客户端对 `AUTH` 错误码一律显示「API 密钥无效」，
真实原因会被完全掩盖。

插件已按响应体文案识别地域限制（不能只看状态码 —— 同一批 403 里也有真凭据问题），
命中时**跳过无意义的续期**，并以 `PERMISSION_DENIED` 抛出真实原因，例如：

```
cline: access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region
```

这类模型无法在本地区使用，可在 Jet Hub 的「显示列表」里关掉，换用其它免费模型。

### 积分余额

Jet Hub 的 Cline 账号卡片会显示账户余额（`GET /api/v1/users/{accountId}/balance`）。
**没有「一键领取积分」按钮** —— Cline 后端没有签到接口（对 sidecar 做全量字符串
扫描，`checkin` / `campaign` 等均无业务端点命中）。

### 适用范围

- 需要**已登录 Cline 账号**（Jet Hub 面板登录，或用免费账号）；
- 模型列表**全部列出**（含付费模型），免费的带 `· 免费` 标记；
  可在 Jet Hub 的「显示列表」里逐个关闭不需要的；
- 图片输入按模型判定（内嵌目录 `capabilities` 含 `images`）。

### 图标

面板图标是**从本机 Cline 安装目录提取的官方图标**（`icons\app\macos\classic.png`，
品牌紫底），不是手绘的 —— 早期版本曾按印象画了个「C 形弧线」，与真实标志不符。

需要重新提取（例如 Cline 换了图标，或想换主题）时：

```bash
node scripts/extract-cline-icon.mjs                    # classic（默认），48×48
node scripts/extract-cline-icon.mjs --theme=midnight   # 换主题
node scripts/extract-cline-icon.mjs --dry-run          # 只报告不改文件
pnpm build:client                                      # 改完必须重建
```

官方提供 `classic` / `chip` / `hologram` / `midnight` 四套主题，脚本默认取
`classic`：`midnight`（exe 内嵌的默认主题）是近黑底，与 Qoder 图标在 20×20 下
难以区分；`chip` 的电路板纹理缩小后退化成噪点；`hologram` 在白底容器里对比度不足。

### e2e 探针

```
pnpm test:e2e:cline        # 只读：凭据/前缀证据/余额/免费集合，零 token 消耗
pnpm test:e2e:cline-chat   # ⚠️ 发一次推理：默认只发 cline-free/mimo-v2.6-flash
```

⚠️ 推理探针**默认只请求一个免费模型**。其余免费模型需显式设置
`DSH_CLINE_CHAT_E2E_ALL_FREE=1` 才遍历；**付费模型一律被拒绝**（避免免费资格
被撤销后按付费价刷 token）。详见 `tests/e2e/README.md`。

### 排查脚本（只读）

`scripts/probe-cline-endpoints.mjs`（按关键词提取 sidecar 二进制字符串窗口）、
`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
`probe-cline-balance.mjs`、`probe-cline-chat.mjs`。
## Loomy provider（讯飞办公助手）

`loomy` 是本插件第 8 个、也是**与其余七者都不同源**的 provider。生产环境：

| 用途 | base URL |
|---|---|
| 推理 / 模型列表 / 积分 / 新手任务 | `https://loomyad.xunfei.cn/api/v1` |
| 讯飞账号（CAccount） | `https://account.xfinfr.com` |

⚠️ 这两个域名是**生产**地址，不要改用测试环境。

### ⚠️ 五个与其余 provider 不同的地方

1. **登录是短信验证码**（唯一一个）。其余 7 个都是「返回 `loginUrl` →
   前端 `window.open` → 轮询 `login.poll`」；短信登录没有 URL 可打开，
   故 `account.create` 返回 `loginMode: 'sms'`（缺省视为 `'url'`，
   既有 provider 行为不变），前端渲染验证码表单，
   走 `login.sendSms` / `login.submitSms` 两个端点。

2. **不能续期**（唯一一个）。Loomy **没有任何 refresh 端点** ——
   `session` 是登录时向服务端声明 `expire: 1209600`（14 天）得来的。
   故 `isLoomyRefreshable()` 恒 `false`，`refresh()` /
   `refreshAccountCredential()` 只做**有效性探测**（失效即提示重新登录），
   `refreshAll()` 只探测**已过期**的账号。这是**诚实标记**，
   不是遗漏 —— 账号卡片会如实显示「凭证过期，请重新登录」。
   `scheduleRefresh()` / `stop()` 因此是**有意为之的空实现**。

3. **两套认证头**。`/chat/completions` **只认** `Authorization: Bearer <session>`，
   而 `/models`、`/points/*`、`/onboarding/*` **只认** `token: <session>`。
   带错的那个会得到 HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。
   `loomyChatHeaders()` 两个都发（官方客户端也如此）。
   实测交叉矩阵（`pnpm test:e2e:loomy` 会现场验证）：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

4. **新手任务是纯 API 直领**，不需要模拟真实用户行为。
   实测服务端**不校验任何前置行为**：直接对 8 个任务发
   `POST /api/v1/onboarding/tasks/complete`（body 只有 `{"key":...}`）即可拿满
   **10000 积分**，一个模型 token 都不花。
   ⚠️ 这与 WorkBuddy 相反（后者需要发对话、建定时任务、上报埋点事件链）。
   若将来服务端加了校验，降级路径是「用 `qwen3.8-flash`（x0.8，全表最便宜）
   模拟真实动作」。

5. **积分是两个池、分开计算**：
   - **永久积分**（`balance`）：注册奖励 5000 + 新手任务 10000
   - **每日赠送池**（`dailyBalance`）：每天 5000，**消耗后不回补**

   「一键签到」= `POST /api/v1/points/first-login`（官方在登录后立即调用它），
   语义是**触发每日额度重置**，**不是**「+5000 积分」。
   幂等判据是响应体的 `alreadyProcessed`，故已初始化时映射成
   `already-claimed` 而非虚报 `claimed`。
   余额查询走 `GET /api/v1/points/records`（**只读**，无副作用）——
   刻意不用 `first-login`，否则「打开面板」会悄悄触发签到。

### 模型与倍率

远端 `GET /api/v1/models` 返回 11 条，按 `type === 'chat'` 过滤得 **8 条**。
⚠️ 过滤判据必须是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
模型的输入模态含 `image`（能看图），那不是生图模型。

⚠️ **倍率在 `name` 字符串里**，没有独立字段（实测搜 `credit`/`multiplier`/
`price`/`factor`/`rate` 全部 0 命中），且三种括号风格混用，故由
`loomyDisplayName()` 规范化为 `MiniMax M3 · x4.0` 形态。

| 模型 | 倍率 | 上下文 |
|---|---|---|
| `deepseek-v4-flash-0731` | x3.0 | 1048576 |
| `MiniMax-M3` | x4.0 | 1048576 |
| `Kimi-k2.6` | x6.5 | 262144 |
| `qwen-3.8-max` | x12.0 | 1000000 |
| `GLM-5.3-Flash` | x0.8 | 1048576 |
| `qwen3.8-flash` | x0.8 | 1000000 |
| `spark-x` | x0.1 | 1048576 |
| `mimo-v2.5` | x3.3 | 1048576 |

⚠️ **`spark-x` 的上下文有已知分歧**：远端声明 `1048576`，而 Loomy 客户端用
本地表 `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
本插件**先采信远端**；若实测长上下文被拒，改兜底表的该值为 262144。

### 能力矩阵

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

`onboardingTasks` 是**第三项能力位**，与 `dailyCheckin` **语义独立**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

### 多账号负载均衡（按余额优先选号）

⚠️ Loomy **不会因积分耗尽而报错** —— 实测今日赠送额度（每天 5000）用完后，
服务端**继续扣永久积分且照常返回**（静默降级）。因此本插件既有的
「限流 → 自动换号」机制对它**无效**：会一直消耗同一个号。

故 Loomy 有一层**独立的选号策略**（在「未停用 + 该模型未受限」的候选内）：

| 优先级 | 判据 | 理由 |
|---|---|---|
| 1 | `dailyBalance > 0` | 今日额度**每天刷新、不用会浪费**，优先消耗它 |
| 2 | `permanentBalance > 0` | 只剩永久积分（不会过期，可继续用） |
| 3 | 其余（含**查询失败**） | 无可用余额 |

- **同档内保持你在 Jet Hub 拖拽的手动顺序**（不按余额大小重排）
- 余额查询**带 60 秒缓存**，避免每轮对话重复查所有账号
- 查询失败的账号归入**最后一档**（宁可先用能确认余额的号）

### 锁定永久积分

面板上的「锁定永久积分」按钮可**保住永久积分**（设置持久化，重启后仍生效）：

| 状态 | 行为 |
|---|---|
| 解锁（默认） | 今日额度用尽后**继续用永久积分** |
| **锁定** | **只消耗今日额度**；今日额度用尽的账号视为不可用 |

锁定后若所有账号的今日额度都用尽，请求会报**明确错误**提示你解锁或等明日
刷新 —— 而不是偷偷用掉永久积分。

⚠️ 同一功能在 **CodeBuddy / WorkBuddy** 上也有（见
[锁定永久积分（CodeBuddy / WorkBuddy）](#锁定永久积分codebuddy--workbuddy)），
但「临时积分」的判据**完全不同**：Loomy 直接读服务端给的 `dailyBalance`
（**当日**到期、次日重发），两个 buddy 没有现成字段，要按资源包的 `DeductionEndTime`
距今是否满 15 天现算。因此面板文案**按 provider 取**（`permanentLockCopy`），
不能把「只消耗每日赠送额度」这句话套到 buddy 上——它们根本没有每天刷新的额度池。

### ⚠️ 为什么 Loomy 没有「重测 / 重置」按钮

那组按钮用于清除**模型限流标记**，而 Loomy **不返回限流错误**（积分耗尽时
静默降级为扣永久积分），重测永远测不出限流、还会白烧积分，故对它隐藏。

### 思考档位

模型选择器里可选**思考强度**，共 5 档：

| 档位 | 显示名 |
|---|---|
| `none` | 关闭思考 |
| `low` | 低 |
| `medium` | 中 |
| **`high`** | **高（本插件默认）** |
| `xhigh` | 极高 |

**档位列表直接取自远端** `GET /models` 的 `reasoning_efforts`
（8 个 chat 模型实测完全一致），故服务端调整档位**无需改代码**。
远端整体不可用时回退兜底表的实测值。

⚠️ **默认档是本插件自己的「高」，不是远端声明的 `low`**（用户要求）：
远端 `default_reasoning_effort` 声明的是 `low`，而 DSH 的「用户没选时发哪个档」
完全取适配器声明的 `defaultEffort`，沿用 `low` 会让默认思考偏浅。
若某模型不提供 `high`（远端目录变化时可能发生），则不下发默认档、
退回「服务商默认」，而不是发一个非法值。

⚠️ 实测「关闭思考」**并不会真的消除思考内容**（服务端仍返回
`reasoning_content`）—— 这是服务端行为，不是配置问题。

### 账号卡片

两个积分池**分开显示**（用户要求）：`永久 15000 · 每日 4992`。
其余 provider 的多个同类资源包仍显示「N/M 个资源包有效」，两种形态互斥。

### e2e 探针

```
pnpm test:e2e:loomy        # 只读：凭据/两套头交叉验证/模型目录/任务/两池余额，零消耗
pnpm test:e2e:loomy-chat   # ⚠️ 发一次推理：默认 qwen3.8-flash（x0.8，最便宜）
```

⚠️ 对话探针的闸门是 `DSH_LOOMY_CHAT_E2E=1` **且**
`DSH_LOOMY_CHAT_E2E_CONFIRM=yes`，`max_tokens` 压到 16（单次约 1 积分）。

---

## Raccoon Work provider（商汤小浣熊）

`raccoon` 是本插件第 9 个 provider。生产环境：

### ⚠️ 与其余 provider 不同的地方

1. **登录：微信扫码 + 短信双路径，由本地页承载**（与 Loomy 同型）。

2. **短信登录需要阿里云滑块验证码**。手机号必须 **AES-128-CFB** 加密

3. **每日 300 积分没有端点**。实测「每日积分发放」是**服务端按日自动发放**的
   （账单 `biz_type: 'daily_grant'`，该账号 13:30 注册、13:31 即到账），
   **不存在可调用的签到接口**。故能力矩阵**不登记 `dailyCheckin`** ——
   登记了会让按钮每次点击都必然失败（与 CodeArts 早期「对不支持的 provider
   无条件发请求」是同一类缺陷）。

4. **一次性登录奖励是独立来源**：`POST /api/web/desktop/v1/login/points/grant`
   给 3000 分，**幂等一次性**（已领过返回 `granted:false`，
   且账单里能看到上一次记录）。语义与 Loomy 的新手任务同构，
   故登记为 `onboardingTasks`，复用同一套 `onboarding.status` / `onboarding.claim`
   端点与 UI。⚠️ 该端点**需要** `X-Client-Platform` 头
   （`desktop-windows` / `desktop-macos` / `desktop-linux`），猜错会被拒。

5. **`Raccoon-Auto` 不暴露**。它是客户端 i18n 条目（`modelPicker.auto`）渲染的
   **「自动选模」入口**，倍率写死为 `1 倍`，**不在远端 `model_catalog` 里** ——
   直接发给 `chat/completions` 会 404。其语义（按消息内容正则打标后从候选池
   选模型）与 DSH「模型选择是会话级固定」的模型相冲，且选出的模型不可预测、
   难排查。用户可直接选 `sn-deepseek-v4-1-flash`（`ability_level: 3`、
   带 `auto` 标签，即自动选模在复杂任务下最可能选中的那个）。

6. **⚠️ `tags` 里的 `vision` 不是图片能力契约**（2026-10-03 修复的真实缺陷）。

   远端 `model_catalog` **根本没有下发**模态字段：穷举 9 个条目的键并集，
   顶层 14 个键、`params` 只有 `context_window` 与 `max_tokens`，
   用 `/modal|vision|image|img|multimodal|…/i` 扫描**命中 0 个**。
   唯一信号是 `tags` —— 而 `sn-deepseek-v4-1-flash` 的 `tags` **不含** `vision`。

   早期实现据此判它「不支持图片」，于是 `inputModalities` 播报 `['text']`，
   **DSH 在 `LlmRuntime` 里把图片替换成文本占位符**（`[image omitted because this
   model accepts text only; …]`）—— **图片根本没发出去**，用户只看到模型说读不到图。

   实测（同一张随机 6 位数字图，模型无法猜）：**6 个可见模型全部能读图**，
   含 tags 不含 `vision` 的 `sn-deepseek-v4-1-flash`（**5/5**）与 `sn-glm-5-3-flash`（1/1）。
   `tags` 的真实用途是客户端「Raccoon-Auto 选模」的**偏好标签**，不是能力声明。

   修法：`RACCOON_IMAGE_CAPABILITY_OVERRIDES` 白名单（仅覆盖实测确认的个案），
   远端解析与本地兜底表两条路径都接。未改成「该家恒支持」——
   将来上架纯文本模型时那会放行后被上游 400，错误更晚更难懂。

   ⚠️ `sn-glm-5-3` 偶发读不到图（实测 3 次中 1 次），是**网关节点不一致**
   （部分 fallback 组是纯文本的），属 provider 侧缺陷；遇到时换模型即可。

### 模型目录（6 个 `visible:true`）

倍率取 `billing_effective_multiplier`（**当前生效价**，已含促销），
展示为 ` · x倍率` / ` · 免费` / ` · x原价→x折后价`：

| 模型 | 原价 | 生效价 | 展示 |
|---|---|---|---|
| `sn-sensenova-6-8-flash` | 0.5 | **0** | `SenseNova-6.8-Flash · 免费` |
| `sn-sensenova-6-8-flash-lite` | 0.5 | **0** | `SenseNova-6.8-Flash-Lite · 免费` |
| `sn-glm-5-3` | 0.75 | 0.75 | `GLM-5-3 · x0.75` |
| `sn-kimi-k3` | 1 | 1 | `Kimi-K3 · x1` |
| `sn-glm-5-3-flash` | 0.2 | **0.1** | `GLM-5-3-Flash · x0.2→x0.1` |
| `sn-deepseek-v4-1-flash` | 0.25 | 0.25 | `DeepSeek-V4.1-Flash · x0.25` |

另有 3 个 `visible:false` 的 `raccoon-*` 内部模型（自动选模的候选池），
**不在模型选择器中暴露**。

### ⚠️ 零客户端依赖（硬约束）

本 provider **运行时完全不读客户端数据** —— 不读
`%APPDATA%\office-raccoon\Local Storage\leveldb`、不读
`~/.box-agent/config/auth.json`、不解客户端 sqlite/leveldb。

### 能力矩阵

```js
raccoon: { balance: true, onboardingTasks: true }
```

⚠️ **没有 `dailyCheckin`**，理由见上文第 3 条。

### e2e 探针

```
pnpm test:e2e:raccoon        # 只读：凭据/模型目录/倍率/积分余额/账单，零消耗
pnpm test:e2e:raccoon-chat   # ⚠️ 发推理：验证标准 OpenAI SSE 与 reasoning_content
pnpm test:e2e:raccoon-tools  # ⚠️ 发推理：验证 **tools 被端点接受**（返回结构化 tool_calls）
```

⚠️ 后两个的闸门是 `DSH_RACCOON_{CHAT,TOOLS}_E2E=1` **且**
`..._CONFIRM=yes`，`max_tokens` 压到 64–256（单次消耗很小）。

⚠️ **`raccoon-tools` 的判据是「响应里有结构化 `tool_calls`」**，
不是「模型在正文里说它想调用工具」—— 后者正是 Qoder / TRAE 踩过的缺陷形态
（插件没把 `tools` 发出去，模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。

---

## MiniMax Code provider（中国版）

`minimax` 是本插件第 **10** 个 provider，也是**首个 Anthropic Messages 协议族**
的 provider（其余九个都是 OpenAI 兼容族或各自的自定义协议）。生产环境：
`https://agent.minimax.cn`。

### 登录：OAuth 设备码 + PKCE

与 Qoder 同型（**不起本地监听端口**），但协议族不同：

- `client_id = mcode-public`、`scope = agent.default`、`audience = agent-backend`
- 设备码端点拿到 `user_code` 后，`verification_uri` 是 `/oauth-authorize`
- **两步式**：`account.create` **先**返回 `loginUrl`（含 `user_code`），
  后台轮询换 token —— 不能阻塞等授权完成，否则 `window.open` 的手势窗口早已过期、
  弹窗必被拦截（与其余九个 provider 一致，见上文「+ 新建账号」小节）。

⚠️ **`pending` 是 HTTP 200，不是 OAuth 标准的 400。** 服务端用
**HTTP 200 + `status: "pending"`** 表达「用户还没完成授权」。只看 HTTP 状态码
会把「还在等你点授权」误判成「拿到 token 了」—— 实测表现为
`令牌响应缺少 access_token`。故轮询里**两种形态都要认**：
`200 + status`（本产品）与「非 200 + `error=authorization_pending`」（OAuth 标准）。

### 模型目录（远端 4 个）

⚠️ **目录必须走远端** `GET /mavis/api/v1/models?region=cn&buildEnv=prod`。
客户端 `config.js` 的**内置表只有 3 个**（`MiniMax-M3` / `MiniMax-M2.7-highspeed`
/ `MiniMax-M2.7`）—— **照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`**，
而它正是客户端界面上被选中的那个。

| 模型 id | 展示名 | 上下文窗口 | 思考档位 | 图片 |
|---|---|---|---|---|
| `MiniMax-M3.1-Flash-Preview` | `M3.1-Flash-Preview` | **1,000,000** | `default`/`low`/`medium`/`high`/`xhigh`/`max`（默认 `default`） | ✅ |
| `MiniMax-M3` | `M3` | **1,000,000** | 无 | ✅ |
| `MiniMax-M2.7-highspeed` | `M2.7-highspeed` | **200,000** | 无 | ❌ |
| `MiniMax-M2.7` | `M2.7` | **200,000** | 无 | ❌ |

⚠️ **只有 `MiniMax-M3.1-Flash-Preview` 有思考档位** —— 其余三个远端条目
**没有 `effort_options` 字段**（不是我们漏解析）。这与 Qoder 的 `qmodel`
「只有关闭思考」是同一类事实：**远端没给就是没有，不要补猜测的默认值**。
档位展示名直接用**远端原文**（`name === id`），不做本地化。

⚠️ **窗口口径是「档位表最大档」**，不是目录里的 `max_input_tokens`。

### 推理（**已启用**，2026-09-29 端到端实测通过）

走 **Anthropic Messages** 协议：

```
POST {apiHost}/mavis/api/v1/llm/v1/messages      # body 带 stream: true
```

⚠️ **只带 `Authorization` + `Content-Type` + `Accept: text/event-stream`**
即被接受 —— **不需要 `anthropic-version` 头**（实测；不照抄 Anthropic 官方文档
加未经验证的头）。

实测四个模型全部 HTTP 200，文本 / 思考 / 工具调用均正常：

| 测试项 | 结果 |
|---|---|
| `M2.7` | 文本「收到」，思考 230 字符，`finish=stop` |
| `M3.1-Flash-Preview` | 文本「收到」，`finish=stop` |
| 工具调用（M2.7） | 结构化 `tool-call` 块 `get_weather({"city":"北京"})`，`finish=tool-calls` |

#### ⚠️⚠️ 思考档位：**M3.1 必须 adaptive，传 `disabled` 是硬 400**

实测服务端响应（这是本项目第一条**来自服务端本身**的 M3.1 约束证据）：

```
POST /mavis/api/v1/llm/v1/messages
{model:"MiniMax-M3.1-Flash-Preview", thinking:{type:"disabled"}, ...}
→ HTTP 400
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, model \"MiniMax-M3.1-Flash-Preview\" requires
  adaptive thinking; thinking.type=\"disabled\" (including
  reasoning.effort=none) is not allowed (2013)"}}
```

⇒ 实现里 `MiniMax-M3.1*` **一律发** `thinking: {type:'adaptive'}`，
档位走 `output_config.effort`（照客户端 `requestPatch`）。

⚠️ **但不要推广成「所有 Anthropic 请求都必须 adaptive」**：
`M3` / `M2.7` / `M2.7-highspeed` 实测**不传 `thinking` 即 200**，
且服务端**默认就会思考**（M2.7 实测 `thinking_tokens: 250`）。
故实现里**只有 M3.1 前缀**发 adaptive —— 见
`MINIMAX_ADAPTIVE_ONLY_PREFIX`。

⚠️ 客户端取证里那个 `forceAdaptiveThinking: true` 出现在
`resolveModelThinkingProtocol` 的**通用 anthropic-messages 分支**，
而该函数**只在有 effort 值时**才返回（无 effort 提前返回 `undefined`）——
所以它**不是**「M3.1 专属」，也**不是**「所有请求都带」。
两处事实（客户端行为 + 服务端约束）是**互补**的，不冲突。

#### ⚠️ SSE 帧形状（实测）

`message_start`（含 `usage.input_tokens` / `cache_read_input_tokens`）→
`ping`（忽略）→ `content_block_start`（`thinking` / `text` / `tool_use`）→
`content_block_delta`（`thinking_delta` / `text_delta` / `signature_delta` /
`input_json_delta`）→ `content_block_stop` → `message_delta`
（`stop_reason` + `usage.output_tokens`）→ `message_stop`。

- ⚠️ **`signature_delta` 必须忽略**：它是 thinking 块的签名，
  当正文处理会往回答里注入一串十六进制。
- ⚠️ **`thinking` 块映射为 `reasoning` 块**（DSH 的 `ReasoningBlock`），
  否则思考内容污染正文。
- ⚠️ **`thinking_tokens` 是 `output_tokens` 的「子集」**，映射到
  `reasoningTokens`，**不累加**到 outputTokens。

#### ⚠️ 工具调用：`tool_use` / `tool_result`（Anthropic 形状）

- assistant 的 `tool-call` → `tool_use`（`id` / `name` / **`input` 是对象**）；
- **Anthropic 没有 `role:'tool'`** —— 工具结果必须是 **user 消息**里的
  `tool_result` 块（`tool_use_id`）。
- ⚠️ 参数是残缺 JSON 时退化为 `{}`，但**块必须保留** ——
  丢了会让后续 `tool_result` 变孤儿块、服务端 400。
- ⚠️ 历史里的 `reasoning` 块**不回传**：Anthropic 要求 thinking 块带签名，
  而我们不持久化签名，回传无签名 thinking 会被拒。

#### 验证命令

```
pnpm test:e2e:minimax-chat   # 双重闸门 DSH_MINIMAX_CHAT_E2E=1 且 ..._CONFIRM=yes
                             # 默认测 M2.7；加 DSH_MINIMAX_CHAT_E2E_ALL=1 测全部
```

⚠️ 该探针走**真实适配器**（不是手搓 fetch），故协议/档位形态被改坏时会拦住。

#### ⚠️ 未实现：图片

`M3.1` / `M3` 的目录条目声明支持图片，但**带图请求未实测**，
故序列化遇到 image 块**显式抛错**（不静默丢弃 —— 静默丢弃会让用户以为
图片被模型看到了）。

### 签到（每日领取）

```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   # body: {}
```

1. ⚠️ **`timezone_id` 是 query 参数且必填**。实测放到请求头会回
   `1406010011 invalid timezone_id` —— 而且**那也是 HTTP 200**，
   只看状态码会误判成成功。取值 `Intl.DateTimeFormat().resolvedOptions().timeZone`，
   读不到回退 `'UTC'`。

2. ⚠️⚠️ **`points` 是总数，`bonus_points` 是其中的「额外」部分，不得相加**
   （用户 2026-09-28 亲自纠正）。实测第 1 天 `points: 800` / `bonus_points: 400`：
   客户端按钮显示「签到得 **800**」、右上角另有「额外 400」角标。
   故 `dailyCredit === points`（**800**），**不是** `points + bonus_points`（1200）。
   相加会让展示金额**虚高一倍**。

3. **7 天契约**：面板 `days` 数组必须是**恰好 7 条**，且 `is_today` **至多一条**
   —— 不满足即判为非法响应（返回 `undefined`），不猜。

4. **业务码在 `base_resp.status_code`**（不是 `code`），`0` 为成功。

5. ⚠️ **幂等判据是响应体的 `claim_result`**（`1` = 真领取、`2` = 已领过），
   **不是 HTTP 状态码** —— 重复领取同样返回 200。故 `claim_result` 缺失 /
   `null` / 越界 / 字符串时一律判 `failed`，**不虚报成功**
   （虚报会让用户以为 +了积分，实际 +0）。

6. ⚠️ **今日已领的判据是 `is_today && status === 3`**，**不是**「没有 Claimable」
   —— 后者会把「服务端没下发数据」误报成「今天已领」。

### 积分余额

`GET /minimax-cloud/api/v1/credit/details`

- ⚠️ **该端点是平铺响应**（`details` / `total_count` 与 `base_resp` 同级、
  **没有 `data` 键**），与签到端点的信封结构**不同**。实现用
  `unwrapEnvelopeData` 兼容两种形状。
- ⚠️ **空明细时 `details` 字段整个缺失** —— 解析必须容忍缺失。实测
  `total_count: 0` 且无 `details`，那是**有效结果**（「真的为 0」），
  与「查询失败」（`null`）是两回事。
- ⚠️⚠️ **余额取 `details[].remaining_amount` 之和，`total_count` 是「记录条数」
  不是余额**（2026-09-29 修复的真实缺陷）。

  实测原始响应（领取 800 积分后）：
  ```json
  {"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
               "granted_amount":"800.00","credit_type":2,
               "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
   "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
  ```
  真实余额是 **800**（`remaining_amount`），而 `total_count` 是 **1**。

  ⚠️ **为什么初版没被发现**：余额为 0 时 `details` 缺失、`total_count` 也是 **0**
  —— 「条数 0」与「余额 0」在数值上**偶然重合**，那条单测因此是**同义反复**。
  领取积分后才分叉（条数 1 / 余额 800），用户界面会显示「1 积分」。

  ⚠️ `remaining_amount` 实测是**字符串**（`"800.00"`），故解析必须同时接受
  字符串与数字（上游改型不该让余额整块失效）；`Number('')` 是 0，
  空串必须**先挡掉**，否则会被误读成「0 积分」。
- ⚠️ **`expiredTotal` 仍为 0、`packages` 留空**：`details[]` 里没有区分
  「本周期有效」的标志（`credit_type` 语义未实测），故**不凭猜测分类**。

### 能力矩阵

```js
minimax: { balance: true, dailyCheckin: true }
```

余额与每日签到**都有**（与 raccoon 只有 `onboardingTasks` 不同）。

### 反向验证

四条，均为「注入变异 → 确认变红 → 逐字还原」（详见
`.superpowers/sdd/progress.md` 的 Task 8 记录）：

| 变异 | 变红条数 | 被守住的判据 |
|---|---|---|
| `MiniMax-M3` 加档位 + 无条件声明 `reasoning` | **4** | 「无 effortOptions 返回 undefined」「M2.7 系不声明 reasoning」 |
| 删掉 `200 + status=pending` 轮询分支 | **2** | 「HTTP 200 + pending 必须继续轮询」 |
| `dailyCredit = points + bonusPoints` | **1** | 「dailyCredit === 800（不是 1200）」 |
| `timezone_id` 改放请求头 | **2** | 「timezone_id 必须在 query」（status + claim 两条） |

### e2e 探针

```
pnpm test:e2e:minimax        # 只读：模型目录/签到状态/积分余额；**绝不领取**
pnpm test:e2e:minimax-claim  # ⚠️ **真实领取**当日积分（消耗当天唯一一次机会）
pnpm test:e2e:minimax-chat   # ⚠️ 发推理（真实适配器；默认测 M2.7，会消耗额度）
```

⚠️ 只读探针读的是 **MiniMax Code 客户端自己的登录态**
（`~/.minimax/auth/prod/cn/mcode-public/auth.json`），**不是**本插件的凭据存储
—— 该 provider 尚未在任何机器上完成过插件登录。

⚠️ **token 过期时探针自动 skip 并打印指引，不代客户端续期**：MiniMax 的 refresh
可能轮换 `refresh_token`，若我们刷一次却不写回客户端文件，用户的客户端登录态
就会被弄坏（代价远大于「探针跑不起来」）。实测过期 token 打只读端点返回
**HTTP 401 `invalid access token`**。


---

## ZCode provider（智谱 z.ai 免费额度）

第十个 provider，id `zcode`，面板显示为 **ZCode (智谱)**。

它把 **ZCode 官方客户端的免费额度通道**（智谱 z.ai Start Plan，
`GLM-5.3-Flash`）接进 DSH。实测本机账号额度 **1 亿 token / 日**。

### ⚠️ 与其余 provider 完全不同的四点

| 维度 | ZCode | 对照 |
|---|---|---|
| **凭据来源** | **只有插件自己的 OAuth 流程**（⚠ 2026-10-05 起**不再**读取本机 ZCode 客户端数据，见下） | 浏览器登录拿 token |
| **协议** | **Anthropic Messages**（非 OpenAI 兼容） | 其余多为 OpenAI 格式 |
| **按需前置** | 推理路径**已不需要**（3.14.4 起上游关闭了模型请求的验证码校验，2026-10-01 实测 6/6 均 200）；`3007` 防御分支保留以防回滚。**领取路径仍每次**要一个一次性 captcha（稳态复用页面 **0.4–0.5 秒**：中位 426ms / 平均 546ms；含 chromium 冷启动那次实测 4.2 秒） | 无 |
| **请求体准入** | 必须带**官方身份块**（否则 `3012`） | 无 |

### 凭据：**只有一条来源**（插件自己的 OAuth 流程）

1. **插件内登录** —— 走官方 CLI 设备授权流：

   ```
   ① POST /api/v1/oauth/cli/init        Bearer <自己生成的 32 字节 hex>
        body: { provider: "bigmodel" }
      → { flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }
   ② 用户在浏览器打开 authorize_url 完成授权
   ③ GET /api/v1/oauth/cli/poll/{flow_id}
      → { status: "pending" } 继续等
      → { status: "ready", token, user, bigmodel: { access_token } }
   ```

   ⚠️ 这是**纯 HTTP**，不经 `zcode://` 自定义协议回调 —— 普通 Node 进程就能
   走完（实测 ① 返回 200、③ 正常 `pending` 轮询）。它还**绕开了故障的**
   `POST /api/v1/oauth/token`（该端点自 2026-09-28 起稳定 500 / code 2007）。

⚠️⚠️ **本插件不读取本机 ZCode 客户端的任何数据**（2026-10-05 起）。

早期版本有一条「回退：解密 `~/.zcode/v2/credentials.json`」的旁路，
让「装了客户端并登录过」的用户零操作可用。**已整体删除**：

- **安全**：那条路等价于「任何本地进程都能解密 ZCode 的登录凭据」——
  官方用 `zcode-credential-fallback:<平台>:<家目录>:<用户名>` 过 `sha256`
  派生 AES-256-GCM 密钥，算法是**公开可复现**的。把它复制进 DSH，意味着
  DSH 具备读取用户**另一个应用**登录态的能力。
- **正确性**：它只认 bigmodel 渠道的 `oauth:bigmodel:user_info`，
  zai 渠道写的是 `oauth:zai:user_info` ⇒ 读出来 `user_id` 恒缺、账号名退化成
  「设备xxxxxxxx」（Gitee issue IKJNPZ）。且两个渠道的 `user_info` **结构也不同**
  （zai 的是 `{user_id, email, avatar, name}`，没有 `id`）——
  **只放宽键名片段是修不好的**。
- **一致性**：插件本来就有完整可用的 OAuth 流程，旧路径是条**功能更差的旁路**。

⇒ 代价是：只装了 ZCode IDE 的用户需要**自己点一次「添加账号」**。
防回退的回归锁在 `tests/unit/zcode-no-local-credential-read.spec.ts`
（它**扫源码字面量**，不是断言函数不存在 —— 后者对新写的读取函数无效）。

⚠️ **`device_mid` 由插件自己生成**（UUID v4），不读官方
`telemetry-state.json`。实测依据：同一 JWT 换
任意随机 UUID，`billing/balance` 都返回 200；而缺它才回
`400 {"code":3001,"msg":"parameter error"}`。故它的**值**不被绑定校验，
只需**稳定**（生成后持久化在凭据里，登录一次即固定）。

⚠️ 凭据形状校验必须做：凭据存储里可能有任何字符串（用户手填、旧版本残留），
`isUsableZcodeCredential()` 保证后续代码拿到的是完整对象。

### coding-plan（**付费订阅**）通道：登录时顺手换取

除免费积分通道（`start-plan`）外，ZCode 还有一条走**订阅额度**的
`coding-plan` 腿（承载 `glm-5.3` / `glm-5.3-flash`，端点 `api.z.ai`）。

⚠️ 它的 api-key **不是登录时下发的** —— 要用登录拿到的 OAuth
access_token **现换**（三个只读 GET，不在云上建 key）。本插件在
`startLogin` 成功后**顺手换一次**并写回凭据（`ZcodeAuth.resolveCodingPlanKey`）：

- 字段按「拿到哪个 token」落位：zai → `coding_plan_key_zai`，
  bigmodel → `coding_plan_key_bigmodel`；
- **换不到不报错**（没买订阅是常态）—— 只记日志，`start-plan` 照常可用；
- 带 8 秒超时，慢网不会把登录挂住。

⚠️ 这条链路此前是**断的**：那个换取函数建好了却没有任何调用方，而两个 key
字段的唯一写入点是已删除的「读本机凭据」⇒ **纯插件登录用户的付费通道一直
不可用**。本次一并接上。

### captcha：唯一还需要浏览器的地方

免费通道**按需**要阿里云 captcha：在索要的窗口里缺
`x-aliyun-captcha-verify-param` 时上游回
`400 {"code":3007,"msg":"captcha verify failed"}`（实测），但在另一些窗口里
连非法 param 都能过——见本节末「上游并非每次都要验证」。它是**网页 SDK**，
不是 Electron 专有 API：

```
script:  https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
配置:    GET /api/v1/client/configs?platform=unknown  →  {region, prefix, sceneId}
调用:    window.AliyunCaptchaConfig = { region, prefix }
         initAliyunCaptcha({ SceneId, element, button, getInstance, success, … })
取参:    getInstance 里调 instance.startTracelessVerification()（无感验证）
```

**三条实测得到的硬约束**：

1. **`--headless=new` 过不了**，必须 **headful**（窗口移到屏幕外
   `--window-position=-32000,-32000`，不进任务栏、不抢焦点，用户无感）。
   实测矩阵（同一份代码，只换一个变量）：

   | | `about:blank` | 真实 origin |
   |---|---|---|
   | **headless** | **0/3** | **0/3** |
   | **headful** | 3/3 | **3/3（811ms）** |

2. **页面必须是真实 https origin**（`https://zcode.z.ai/`），不能用 `about:blank`
   —— 后者的 origin 是字符串 `"null"`，阿里云风控据此拒绝：

   | origin | 同一页面连续 mint |
   |---|---|
   | `about:blank` | **1/3**（#2 起 `F001`） |
   | **`https://zcode.z.ai/`** | **5/5，中位 426ms** |

3. **可以复用同一个页面**（因为 origin 对了）+ 每次重置 DOM。
   比「每次新建 page」快 **2.9 倍**（1246ms → 426ms）。

⚠️ SDK 在**降级路径**下会产出**约 76 字符的垃圾 param**：**在索要验证的窗口里**发上游
**必然 `3007`**。⚠️ 这个限定不要写成两头过头的说法 —— 上游不要验证的那些窗口里它确实
能回 200（见本节末实测表），但那是「这一次没校验这个头」，**不是**「垃圾 param 也算合法」。
本地判据照旧：`validateCaptchaParam()` 会校验（长度 ≥200 且 `securityToken` ≥50），
不合格**不发请求**（省下的是「上游要验证时那次注定失败的往返」）。

#### 桌面版内部载体（DSH Desktop，无需外挂浏览器）

captcha 是**网页 SDK**，任何"有 DOM 能跑 JS"的浏览器都能产。桌面版下直接用
**桌面版自己的 Electron 内核**当载体——零 CDP、**零 DSH 本体源码改动**（用的就是官方
sidebar-browser 自己在走的那条 `dshDesktop.browser` 通道）：

```
server（ZcodeAuth 懒起，随插件启停）
  只监听 127.0.0.1:<随机可用端口> 的小 HTTP 服务   ← src/captcha-carrier-server.ts
  唯一路由 GET /carrier ⇒ buildCarrierPageHtml()  （只回静态 HTML，无凭据、无鉴权）
client（GUI 顶层上下文）
  dshDesktop.browser.acquire(workspace)          → { lease, partition }
  隐藏 <webview partition=… src="about:blank#<lease>">   ← 主进程凭这个 src 认租约
  captcha.carrierUrl → { url }                    ← ★ 每轮问一次（端口是 server 挑的）
  导航到那条独立端口的载体页（拿到 null 就安静退出，不建 guest）
  webview.executeJavaScript(读 window.__zcodeCaptcha)   ← bonus-plan 要靠 CDP+OOPIF 才拿到的能力
  captcha.contribute → server 供给槽（一次性 / 时效闸 / 质量闸 / 有界等待 / interactive 回传）
```

#### ⚠⚠ 为什么载体页**不能**挂在插件自己的 `/api/…` 上（2026-10-02 实测取证）

初版就挂在 `/api/jet-hub/captcha-carrier`，理由是"与 GUI 同源"。这个前提是**错的**，
在真机上收益恒为 0。取证来自 DSH Desktop 0.2.0-rc.2 的 `resources/app.asar/lib/main.js`：

| 主进程判据（原文） | 后果 |
|---|---|
| `allowedNavigation(v)` = http(s) + 无账号密码 + `!isApplicationHost(url)` | 命中即 `preventDefault` |
| `isApplicationHost(u)` = **`u.port === host.port`** 且（主机相同或回环） | 插件 API 与 Host **同端口** ⇒ 命中 |
| `configureSession().onBeforeRequest`：命中 `isApplicationHost` 就 `cancel` | 请求**根本发不出去** |
| `acquire()`：`partition = \`dsh-sidebar-browser-${randomUUID()}\`` | **无 `persist:`** ⇒ 内存 session，没有 Host 的会话 cookie |

⇒ 桌面版 GUI 的真实 origin 是自定义 scheme `dsh-app://app/`，插件 API 由主进程
`forwardWebRequest(request, hostUrl, hostCookie)` 转发到 `http://127.0.0.1:<host 端口>`；
载体页挂在那个端口上 ⇒ **每一轮都在 `allowedNavigation` 的第一个判断退出，guest 都不建**，
而失败被 `preventDefault` 吞掉，日志一切正常。
✅ **`isApplicationHost` 要求端口相同 ⇒ 换端口即不在判定内** —— 这就是那个小服务的由来
（只回环监听、一页静态、无账号数据 ⇒ 不需要鉴权；加了反而会让没有会话 cookie 的 guest 拿 401）。

✅ **真机已实测（2026-10-01，DSH Desktop 0.2.0-rc.2 真窗口，开机自检逐段通过）**：
```
carrierUrl → http://127.0.0.1:19469/carrier      ← 插件自起的独立随机端口
acquire    → partition dsh-sidebar-browser-f34495a3-…
navigated  → origin = http://127.0.0.1:19469      ← 异端口绕开 isApplicationHost 成立
mint       → len=280, interactive=false          ← 载体页在真 guest 里加载并产出合法 param
```
（更早那组 4/4 跑在探针自己的 `http://127.0.0.1:8791` 上，同一份 `buildCarrierPageHtml`；
两组合起来说明两件事：**换端口确实绕得开那道墙**，且 **UA 带 `Electron/44.0.0` 也能过阿里云风控**
⇒ **不需要伪装 UA、不需要 stealth 补丁**。）

⚠ 排查看日志里的 `reason=<分类码>`（`no-carrier-url` / `load-failed` / `origin-mismatch` …），
每一类的人话在 `plugin-src/client/zcode-carrier.js` 的 `CARRIER_FAILURE_LABELS`。

**降级链**：① 槽里有新鲜 param 就用 → ② 槽空且需求位为真则等 ≤1.5s → ③ 等不到用外挂
chromium → ④ 内部 param 被 `3007` 拒则**当次**改用 chromium 重发（**领取路径同样接上了这条**，
因为领取端点始终索要验证、内部 param 在那里被拒的概率最高），累计 3 次本次运行禁用内部载体。
关闭：`DSH_ZCODE_INTERNAL_CARRIER=0`；web 版**没有**这条通道，行为与以前逐字一致
（拿不到 `dshDesktop.browser` ⇒ 贡献循环整体 return，一个 RPC 都不发，也就没人会问地址）。

⚠ **收益口径要说准，别当提速宣传**：需求位只在**领取**路径置起（见下节：3.14.4 起模型请求
已不再索要 captcha），而领取是低频操作、且 client 产一个 param 要 2–4 秒 > 槽的 1.5 秒等待
⇒ **首个 plan 多数仍走 chromium**。它的真实价值是**去掉对 chromium 的依赖**
（机器上没装可用 chromium 的用户，从"领不了额度"变成可领），不是让领取变快。

⚠ **未实测项**（都由第 ④ 条兜住，不作为上线前提）：param 的真实时效
（`PARAM_MAX_AGE_MS=20s` 是保守值）、以及**上游在校验窗口是否接受内部载体的 param**
（claim 端点始终索要验证，但真拿它去领一次要**消耗用户额度**，故不代跑，留待人工验证）。

⚠ **设备信誉不跨启动**（2026-10-02 纠正）：主进程按 workspace 键缓存 partition，
但那张表在**进程内存**里，且 partition 名**没有 `persist:` 前缀** ⇒ **内存 session**。
所以：同一次运行内释放/重建 guest 仍是同一台设备（信誉不丢）；**DSH 一关，下次启动就是一台全新设备**。
这会**抬高**被降级成交互式验证的概率（该信号现在会随 `captcha.contribute` 的 `interactive` 字段
回传 host 并告警，见面板 `carrier.supply.interactive`）。

**兜底路径：外挂 chromium**（`ZCODE_CHROME_PATH` 可显式指定）——
web 版**必需**，桌面版仅在内部载体不可用时兜底：
自动探测 scoop `chromium` → Chrome → Chromium → Edge。**常驻一台 + 复用页面**；
并发 mint 会串行化（captcha param 一次性，共用页面会互相踩状态）；
插件卸载时 `dispose()`（否则留孤儿进程约 200-400MB）。

#### ⚠️ 上游的验证策略变过一次（3.14.4，2026-09-29 起）

**决定性实测**（2026-10-01，本插件直连上游，`scripts/probe-claim-gate.mjs` 等）：

| 路径 | 不带验证头 | 结论 |
|---|---|---|
| 模型请求 `/zcode-plan/anthropic` | **HTTP 200**（6 个采样点，正文正常） | **自 3.14.4 起不再索要**（官方更新说明同口径：「关闭模型请求验证码校验」）|
| 领取 `/zcode-plan/billing/claim` | **`400 / 3007`**（带非法 captcha 同样 3007） | **始终索要**，且校验**前置于** plan 校验 |

⇒ 推理路径的 mint 次数现在**恒为 0**（"按需"实际上等于"不需要"）；
仍在产 param 的只有**领取**路径（每日一次 / 手动点「一键领取」，每个 plan 一个）。
⇒ 也正因如此，桌面内部载体的需求位只挂在 claim 上（见上一节）。

⚠ **下面这段是 3.14.4 之前**的观察，保留作为背景，但**不要再拿它当"官方何时索要"的判据**
（它来自外部仓库对**开源壳**的抓包，而开源构建本来就不带 captcha 生产者）：

外部仓库 `bonus-plan-4-open-zcode`（提交 `52b6389`，**不是本仓库**）抓到：官方的
开源壳在 `access.mode = normal` 时**全程零验证**（32 秒 / 4674 个包里
`captcha` / `aliyun` / `alicdn` / `verify` 相关命中全为 0），只有
`access.mode = off-peak` 才强制索要运行时头。
⚠ 但 `access.mode` 是**那个壳的 provider 配置开关**，我们这条直连路径上不存在它
⇒ 本插件**不读** `access.mode`，只按实测决定要不要带验证头。

⇒ 现行策略是**先探后取**（`src/captcha-requirement.ts` + `src/zcode-adapter.ts`
内层循环）：默认**不带**验证头发一次，被 `3007` 拒才产出并重发，并按
`账号 × 模型` 记住「需要验证」**2 分钟**（免得后续每条消息都白吃一次 3007）；
一旦不带头也成功 ⇒ **清掉记忆**，回到最省的路径。

本仓库自己的对照实测（2026-10-01 02:30–02:36 UTC+8 深夜窗口、10 发真实请求；
探针 `scripts/probe-zcode-captcha-need.mjs` 与设计稿
`docs/superpowers/specs/2026-10-01-zcode-captcha-lazy-mint-design.md` **都是本地
文件、不入库**）：

| 形态 | 结果 |
|---|---|
| **不带**验证头 ×8 | **8/8 HTTP 200**、`3007` 命中 **0** 次 |
| 带**非法** param ×1（阴性对照） | 同样 HTTP 200 ⇒ 该窗口**根本没校验**这个头 |
| 带**合法** param ×1 | HTTP 200，mint **4200ms**（首次：chromium 启动 + 建页 + SDK 首次加载，**不是**稳态） |
| 稳态 mint（复用常驻页面） | **0.4–0.5 秒**（同一个 5/5 样本给了两个统计量：中位 426ms / 平均 546ms，别只挑一个数） |

⚠ 别把这两个「冷启动」混为一谈：`zcode-captcha.ts` 记的**浏览器进程**冷启动约
690ms，而上面的 4200ms 是**首次 mint 全流程**（含建页与阿里云 SDK 首次加载）。

⚠️⚠️ **两条不许写反的口径**（本仓库的注释与文档一律按这两条措辞）：

1. **不许**把「缺 captcha 必回 `3007`」写成无条件事实 —— 上面 10 发里一次都没发生；
2. 也**不许**反过来写成「上游永不校验」，据此删掉 `3007 → 内部补产重发` 分支
   或改成复用同一个 param —— 历史上它确实强制索要过，而本次只采了**深夜一个窗口**，
   **跨时段未复测**（白天高峰需人工复跑一次探针再校准）。

⇒ 收益因此**不是常数**：省掉的是「不需要验证的那些请求」的一次 mint
（稳态 0.4–0.5 秒 / 首次含冷启动 4.2 秒）+ 一份设备级验证配额与信誉；
上游要验证时那一发照付。

### ⚠️ 关于「更轻量的浏览器」：实测结论是**都不行**

试过三个 obscura 构建（obscura-node 自带 0.1.8 / scoop 0.2.3 /
官方 release `-stealth` 0.2.3）与 Lightpanda，**均无法跑通阿里云 captcha**：

| 方案 | 结果 |
|---|---|
| obscura 0.2.3（官方 stealth，最完整构建） | ✗ `getInstance` 从不触发，**零阿里云网络请求** |
| obscura 0.1.8（obscura-node 自带） | ✗ 与 0.2.3 **同样的**错误 |
| Lightpanda | ✗ 特性清单**明确无 canvas/WebGL** |

obscura 的根因是**引擎级缺口**（不是补几个 API 能解决）：

```
[error] Dynamic script fetch error: HTTP 0        ← 动态模块加载器失败
[error] Couldn't find a style target              ← CSSOM 注入不工作
[error] Dynamic script error: moveTo is not defined
[error] Timer error: TypeError: Cannot read properties of undefined (reading 'prototype')
```

我试过**拦截 `HTMLCanvasElement.prototype.getContext`**（给 SDK 自建的 canvas
注入带真实 VENDOR/RENDERER 的假 WebGL）+ 补 `Permissions` / `TouchEvent`：
补丁确实生效、错误也变了，但暴露出 `Dynamic script fetch error: HTTP 0`
这个**死结** —— FeiLin 无感引擎靠动态加载若干 JS 模块工作。

⇒ **继续用 chromium**（scoop 已装，零新增安装；或用系统 Chrome / Edge）。

`Playwright` 也能跑通（复用页面同样约 546ms），但它会引入依赖；
当前手写 CDP 版本**零第三方依赖**且已优化到同等水平，故不引入。

### 3012：判据是**请求体内容**，不是 HTTP 头

上游对 `zcode-plan` 通道做内容检查。实测矩阵：

| `system` 内容 | 字符数 | 结果 |
|---|---|---|
| 无 | 0 | ✗ **HTTP 405** + `code:3012` |
| 仅 `cliPrefix` | 42 | ✗ **HTTP 405** + `code:3012` |
| **`cliPrefix` + `stable`** | **2898** | **✓ 200** |

⇒ 身份块必须**逐字**为官方文本且**处在开头**，调用方的 prompt 追加在最后。
另外首轮 user 消息要带 `<system-reminder>` 日期块（官方称之为
「3012 的最后一个开关」）。

⚠️⚠️ **3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；**5 次停用**）。
故 `httpErrorCodeForZcode()` 把它映射为 `PERMISSION`（**不可重试**），
而 `3007` 映射为 `RATE_LIMIT`（可重试，换个新 param 就能过）。

#### 2026-10-03 复测（issue IKJI0Y 驱动）：身份块**之外**的变量全部排除

用户报「身份块已核对达标（2898 字符）仍 3012」。本机复测**复现了 3012**，
并逐项排除了身份块之外的变量。三个账号、17 次请求：

| 消融 | 结果 |
|---|---|
| 裸请求（无身份块·无日期块·极简头） | ✗ **405 + 3012** |
| 无身份块、其余官方头齐全 | ✗ **405 + 3012** |
| **有**身份块 + **极简**头（无任何 `X-*` 来源头） | ✓ 200 |
| 有身份块，**不带**日期块 | ✓ 200 |
| 有身份块 + `app_version` 声明 `3.14.4` / `4.0.0` | ✓ 200 |
| 三个账号各一发完整形态 | ✓ 200 / 200 / 200 |
| 多轮历史（`tool_use` / `tool_result`） | ✓ 200 |
| 带 `tools`（DSH 每步 24 个） | ✓ 200 |
| **单账号无间隔连发 6 发** | ✓ 200 ×6 |
| 无 `Authorization`（阴性对照） | 401（鉴权与身份块相互独立） |

⇒ **2026-10-03 这个窗口里，唯一的判据就是身份块。**
日期块、HTTP 头、版本头、频率、多轮历史、工具声明**均非判据**。

⚠️ **两条要修正的旧说法**（都据上面的实测）：

1. **HTTP 状态码是 `405`，不是 `403`。** 排查时别按 403 找（那会一路走到
   「风控 = 鉴权/权限」的错误分支）。响应体里还带 `logid`，**向用户索取时
   优先要它** —— 它是上游侧的排障凭据。
2. **日期块在这个窗口不是判据**（去掉照样 200）。它仍**照发**
   （`withContextPrefix` 幂等插入，官方如此且成本为零），但**别再把它写成
   「3012 的最后一个开关」当成唯一结论** —— 那条来自早期窗口，
   与「身份块」同属**必要非充分**。

⚠️ **因此「身份块达标仍 3012」目前没有已知解释**。若再遇到，
唯一能区分「账号自身被标记」与「共用出口 IP 被标记」的办法是**看诊断行**
（下一节）—— 这正是本次补可观测性的动机。

#### 3012 的错误文案带**可观测诊断行**（issue IKJI0Y）

`3012` 是唯一一个「用户什么都做不了、又完全看不出原因」的错误：
冷却惩罚不可逆 ⇒ 不可重试；而原文案只有固定句 + 原始响应。
故 `describeUpstreamError()` 现在接受一段可选诊断（`src/zcode-diagnostics.ts`），
实测输出：

```
zcode: 上游风控拦截（3012 unusual activity）。⚠ 该错误有账号冷却惩罚
（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。
本机诊断：账号#1 · 本进程 成功 1/失败 2 · 最近成功 1分29秒前 · 距上条 2.4s ·
身份块 2898 字符(42+2856) · 日期块 有 · HTTP 405
原始响应：request has been blocked due to unusual activity.
```

⚠️ **诊断行不含任何凭据**：账号只以**进程内自增序号**（`账号#N`）出现，
不含 accountId / JWT / device_mid 的任何片段（有单测用「逐子串排除」钉死）。

⚠️ **身份块字符数读的是「实际构造出来的 `system`」，不是常量** ——
真出现「身份块没进请求体」时会如实显示 `0 字符`，
而不会显示常量里的 2898 把问题盖住。

⚠️ 只给 `3012` 附诊断：`3009` / `1005` / `3007` 的文案**本身已说明原因**，
附加只会让它们变脏（且各有单测钉住措辞）。
不传诊断时行为与原来**逐字一致**（旧调用点不受影响）。

### 积分与签到

- **余额**：`GET /api/v1/zcode-plan/billing/balance`
  （⚠️ **需要** `Authorization: Bearer <zcodejwt>`，与 `preview` 不同）。
- **每日领取**：`event/report`（补 `app_launch` + `app_daily_active`）
  → `billing/preview` → `billing/claim`。

⚠️ **补激活上报不能省**：不补这两条事件，`preview` 恒为空 `plans: []`
（实测：补前空、补后立刻出现 plan）。「每日随机派发」不是随机推送，
而是**服务端按活跃信号决定要不要给**。

⚠️ **captcha 一次性** ⇒ 每个 plan 都要**重新 mint**（在索要验证的窗口里，复用会得 `3007`）。

⚠️ **`1003`（已领取）是幂等成功，不是错误** —— 当失败会让定时任务反复误报。

⚠️ 能力矩阵登记为 `{ balance: true, dailyCheckin: true }`，
但**额度单位是 token 而不是积分** —— 面板与 RPC 层如实标注量纲，不伪装。

### 模型表是**静态白名单**

上游模型池有 4 个，但 `GLM-5-Turbo` / `GLM-5.2` 实测**返回空响应**
（0/3 正确，而 `GLM-5.3` 是 3/3），故只暴露实测可用的两个：

| 模型 | 中位延迟 | 正确率 | 并发限流 |
|---|---|---|---|
| `GLM-5.3` | 4452ms | 8/14 | 撞过 21 次 3009 |
| `GLM-5.3-Flash` | 4915ms | 10/15 | **0 次** |

⚠️ `listModels` **不发网络请求**（枚举远端会列出用不了的模型）。

### 显式不支持图片

该通道的图片链路**未验证**，故适配器**显式拒绝**图片输入
（`UNSUPPORTED_CONTENT`）—— 比静默丢图好（丢图会让模型看到空内容）。

### 实测（本机，2026-09-29）

```
（凭据来自插件内登录）✓  device_mid=72c145cd…  app_version=3.14.3
fetchZcodeBalance()     ✓  GLM-5.3-Flash  remaining=99,999,344 / 100,000,000
fetchZcodeCaptchaConfig ✓  {"region":"cn","prefix":"no8xfe","sceneId":"11xygtvd"}
captcha mint            ✓  2339ms  len=280  securityToken=128
真实推理（GLM-5.3-Flash）✓  3685ms  可见文本="正常"
                            chunk 类型 = block-start, reasoning-delta, text-delta, block-end
额度扣减                 ✓  used: 656 → 1475
```

### ⚠️ 与「本机 HTTP 桥」方案的关系

PR 初版的实现是「读 `<dataBaseDir>/.zcode/v2/bridge-port.json` → 打本机桥
→ 由 ZCode 实例代发上游」。那条路依赖一个**被补丁注入过的开源版实例**，
而**官方闭源版不写那个发现文件** —— 故「装了 ZCode」并不等于「桥可用」。
本实现改为**直连上游**（凭据解密 + captcha 由普通浏览器产出 +
身份块满足准入），**不再需要任何实例常驻**。

### 协议层：`zcode-anthropic.ts`

ZCode 免费通道**只认 Anthropic Messages**（实测 `zcode-plan` 下的
`openai` / 裸 `v1/chat/completions` 路径一律 `404 page not found`）。
而 `openai-compat.ts` 的 `serializeMessages()` 产出 OpenAI 形态，
故需要一层转换：

| 维度 | OpenAI | Anthropic |
|---|---|---|
| system | `messages[0].role='system'` | **顶层 `system` 字段**（块数组） |
| 工具声明 | `tools[].function.{name,parameters}` | **`tools[].{name,input_schema}`**（扁平） |
| 工具调用 | `tool_calls[].function.arguments`（**字符串**） | `content[].{type:'tool_use',input}`（**对象**） |
| 工具结果 | `{role:'tool', tool_call_id}` | `{role:'user', content:[{type:'tool_result'}]}` |
| SSE 结束 | `data: [DONE]` | `message_stop` 事件（**无** `[DONE]`） |
| 思考 | `delta.reasoning_content` | `thinking_delta` |

⚠️ 两个最容易踩的：`tool_use.input` 是**对象**（不是 JSON 字符串）；
工具结果必须包成 `role:'user'` 里的 `tool_result` 块。

⚠️ **空响应必须显式抛 `EMPTY_RESPONSE`** —— Anthropic SSE 没有 `[DONE]`
可做锚点，若不检查就会「干净地停止、无任何报错」
（与 Qoder 那次静默失败的形态完全一致）。

## Gemini provider（Google Gemini Code Assist）

第 14 个 provider，走 **Google Cloud Code Assist 免费线**
（`daily-cloudcode-pa.googleapis.com`），浏览器回调式 OAuth 登录。

**登录入口：Jet Hub 设置页的 Gemini Code Assist 面板**（与其余 provider 一致）。
⚠️ 不注册斜杠命令。编程式调用见 `ctx.geminiAuth` 的
`login()` / `startLogin()` / `refreshAccountCredential(refName, pool, accountId)` /
`refreshAll(pool)` / `repairAccountNicknames(pool)`。

⚠️ **只做 OAuth 一条线**（用户 2026-10-03 拍板）：API key 与 AI Studio
（`generativelanguage.googleapis.com`）两条线都不做 —— 免费线是 Cloud Code 项目制，
凭据就是 Google OAuth 的 `access_token` + `refresh_token`。

实施计划与全部取证记录见 [`docs/GEMINI-PORT-PLAN.md`](docs/GEMINI-PORT-PLAN.md)。

### ⚠️ 与其余 provider 完全不同的五点

1. **请求体是双层信封，且每一层键都按字母序排列** ——
   `{model, project, request:{contents, generationConfig, sessionId}, requestId, userAgent}`。
   ⚠️ **这是 Go / TS 的语义差，不是风格问题**：上游 Go 用 `encoding/json` 序列化 map，
   键**自动**字母序；TypeScript 的 `JSON.stringify` 按 V8 插入序，**不保证字母序**。
   直接 `JSON.stringify(envelope)` 大概率对不上。实现走 `marshalAlphabetical()`，
   并由 `tests/unit/gemini-payload.spec.ts` 的**353 字节逐字金标准**锁死。
2. **五个身份头恒定**（`geminiHeaders()`，抓包跨会话逐字不变）：

   ```
   User-Agent: antigravity/4.3.0 (cmdc-pak)
   x-client-name: antigravity
   x-client-version: 4.3.0
   x-machine-id: cmdc-pak
   x-vscode-sessionid: proxy
   ```

   ⚠️ **一律不发** `x-goog-api-key` / `x-goog-api-client`；**流式请求刻意不带 `Accept`**。
   ⚠️ `x-machine-id` / `x-vscode-sessionid` 看着像设备指纹，但上游写死的就是
   `cmdc-pak` / `proxy` 两个占位串（UA 括号里也是原版自己的产品名）。
   **别「为了更像真实客户端」生成随机值** —— 同一账号前后 machine-id 不一致可能触发
   服务端的设备指纹一致性校验。
3. **`thoughtSignature` 是跨轮状态** —— 模型在 `functionCall` 上回签名，必须落盘、
   下一轮按「工具名 + 规范化参数」回填，否则多轮工具调用必被上游拒。落盘位置是
   `$DSH_HOME/jet-hub/gemini-sigs.json`（**独立文件**，不放 `state.json` —— 那是整体
   替换语义，会被别的写入覆盖掉）。签名被拒时做**一次去签重试**兜底。
4. **`project` 自动探测、`sessionId` 内容派生 + 升代自愈** —— `project` **不是恒值**：
   启动时探 `loadCodeAssist` 的 `cloudaicompanionProject`，`aicode-consumers` 只是
   探测**为空**时的兜底（免费档常态）。三级缓存：进程内 → 凭据字段 → 现探。
   ⚠️ **探测失败 ≠ 探测到空**：失败（网络/非 2xx）时**不发推理**，与原版一致
   （注入 500 实测：原版只在端点间重试 LCA + quota）。详见 `src/gemini-project.ts`。
   `sessionId` 由 `(project, 首条 user 文本, lane)` **确定性派生**
   （`deriveGeminiSessionId`）：同一对话内稳定（保住上游 prompt cache 命中），
   不同对话隔离；推理与冒烟用不同 lane。只有 `requestId = agent/<unix_ms>/<8hex>`
   是每请求随机的。
   ⚠️ 2026-10-05 更正：此处此前写"`project` 与 `sessionId` 都是预置常量"。
   真机对照实验证明 sessionId 的两个"常量"只是**特定输入的输出**。把它写死会让
   所有用户、所有对话共用一个会话，而原版的会话归并与 **`thoughtSignature` 回填**
   都挂在这个字段上 —— 共用的后果是它们全部错乱。
   注意：原版哈希本体未反推出来，故 sessionId 取值**不与原版逐字相同**，
   对齐的是依赖维度。
5. **会话升代自愈（1M 累计超限）** —— 上游按 `sessionId` 在**服务端**累计对话输入；
   长工具循环会把累计推过 1M，此后该 sessionId 的**每个**请求都 400
   `The input token count exceeds the maximum number of tokens allowed 1048576`，
   直到该服务端会话过期 —— 即**对话永久卡死**。削本地历史没用（累计在服务端、按
   sessionId 计），唯一出路是**升代换一个全新 sessionId**（`deriveGeminiSessionId` 的
   `generation` 入参）。判据与语义抄自 `Antigravity-Manager` 的 `[FIX session-1M]`，
   wb 独立实现同一机制（`SessionOverflowBump`）。**升代有界**（一次请求最多一代），
   显式钉住 `sessionId` 时不升代。
6. **上下文超限归 `CONTEXT_WINDOW_EXCEEDED`（触发自动压缩）** —— 上游回
   `The input token count (N) exceeds the maximum number of tokens allowed (M)` 时，
   ⚠️ **harness 的 `isContextWindowExceededError` 认不出这句话**（它要求出现
   `context` 字样，而这句一个都没有 —— 与 `buddy-adapter.ts` 当年漏判
   「prompt is too long」是同一类缺陷），故本仓库补了一条专属判据。
   归成 `INVALID_REQUEST` 的后果**不对称**：`dsh-compaction-basic` 的 listener
   第一行就是 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
   ⇒ 连一次压缩的机会都没有，长会话越过窗口后每轮报废。
   处置是**升级式**的：先升代（便宜），升过仍失败才归溢出交 harness 压缩。
7. **请求体上限发送前真检查** —— `GEMINI_MAX_REQUEST_BODY_BYTES`（64MB）此前
   **定义了但全仓零引用**（看着有防护，实际没有），现已接上，超限同样归
   `CONTEXT_WINDOW_EXCEEDED` 而不是死路 `INVALID_REQUEST`。
8. **签名 miss 按工具名兜底** —— 精确键吃逐字参数，长任务里参数漂移（路径/
   时间戳变化）是必然事件。miss 时回退取**该工具名最近一次**签名，避免走去签
   重试丢掉整条思考链。工具名随条目一起持久化（键是 sha256 不可逆，不存名字
   无法重建索引）。
9. **模型名是准入键** —— 裸 `gemini-3.8-flash` 直接 404，**档位后缀必需**
   （`-low` / `-medium` / `-high` / `-tiered`）。`modelId` 走**严格校验**：
   不在静态表里就抛错（此前写错模型名会**静默跑 3.8**）。

### 模型目录（1 个模型 + 4 档）

`listModels` **不发网络请求**（Cloud Code 没有模型列表端点），暴露静态表一条：

| 模型 id | 上下文窗口 | 档位（默认「中」） |
|---|---|---|
| `gemini-3.8-flash` | 1,000,000 | 低 / 中 / 高 / 自适应（默认中） |

⚠️ **只暴露主模型名，不暴露 4 个带后缀的名字** —— 档位走 DSH 的思考强度下拉框
（`resolveModel().reasoning.efforts`，展示名给中文即中文界面）。
上游名由 `geminiModelSpec()` 拼成 `gemini-3.8-flash-<tier>`；
`tiered` 档的 `thinkingConfig` **不带** `thinkingBudget`（其余三档为
low=1000 / medium=4000 / high=10000）。

⚠️ **不认领 `claude-*` 别名**（2026-10-03 定）：DSH `/v1/models` 会合并所有 provider 的
模型列表，认领 `claude-sonnet` 会让用户选 claude 时走 gemini（「选了 claude 怎么是
gemini 在回答」），且将来真加了 Claude provider 会撞名导致分派不可预测。
⚠️ **lite 不暴露**：上游恒 404（用户 2026-10-03 拍板移除）。

### 图片

图片走**两跳**，职责分离：

1. **插件侧缩放**（防御性接入，照 `buddy-adapter.ts` 的既有做法）—— 先按
   `imagePixelBudget` 预算（默认 `DEFAULT_IMAGE_PIXEL_BUDGET` = 640,000 px）取缩放版，
   拿不到才发原图。⚠️ 这**不是**从原项目移植的行为：原版是纯 base64 透传、
   不做缩放，也没探过 Cloud Code 免费线的视觉 token 预算。先接上无害防御，
   最多图片质量略降。
2. **翻译成 `inlineData`**（原项目忠实移植）—— base64 校验（清洗换行 / 空格）、
   `media_type` 缺省 `image/png`、**URL 形态直接跳过**（避免 SSRF），
   产出 `{ mimeType, data }`。

### 错误归类与救场（两层：换端点 + 换号）

⚠️ **不能写成「429/5xx → LlmError」** —— 那样 quota 会被当 `SERVER` 白重试 5 次
（500/1000/2000/4000/8000 ≈ 15.5 秒）。

| 错误形态 | 归类 | 处理 | 冷却 |
|---|---|---|---|
| 429 限流（`five_hour` / `weekly`） | `RATE_LIMIT` | 连续 2 次 429 → 切下一个可用账号 | 原账号 60s |
| 401 凭据失效 | `AUTH` | 切下一个可用账号重试 | 原账号 300s |
| 400 quota / permission | `QUOTA_EXCEEDED` | 先换端点；端点也撞 → 换账号 | — |
| 403 / 404 | `SERVER` | 先换端点；端点也撞 → 换账号 | — |
| 签名错误 | 专用 | 去签重试一次 | — |
| 5xx / 网络抖动 | `SERVER` / `TRANSPORT` | 走 harness 退避 | — |
| 切完仍失败 | — | 透传原错误（两个号都挂，面板可见） | — |

⚠️ **端点轮换的预期要压低**：`daily-cloudcode-pa.googleapis.com` 与
`daily-cloudcode-pa.sandbox.googleapis.com` 在能测的两类错误（404、project）上
**行为完全一致**，背后大概率是同一套模型注册表与配额服务。换端点**零成本无害**，
但**不能当 quota 类错误的有效解法** —— 主救场维度是**换账号**。

⚠️ 切号照既有七处惯例：`tried` 集合跨重试保留（否则在两个账号间无限来回）；
`activeAccountId` 是 `stream()` 内的局部可变状态，**不能**每次问
`options.currentAccountId()` 回调（回调返回池当前默认账号，切号后不跟着变）；
全部受限时如实抛 `QUOTA_EXCEEDED`，不无限切。

### 配额（5 小时 / 周两个窗口）

端点 `POST {endpoint}/v1internal:retrieveUserQuotaSummary`，**请求体是空对象 `{}`**
（不带 `project`），身份头同推理请求。

⚠️ 面板按**逐窗口百分比**显示（`5 小时窗口 99% / 周窗口 99%`），**不显示均值** ——
两个窗口的均值（如 94.5）既不是上游给的数，在「额度」标签下更会被读成 94.5 个积分
（用户 2026-10-03 报障：「为什么显示的是积分不是额度」）。同理，配额单位下**不渲染**
「N/M 个资源包有效」—— 它的两个「包」是时间窗口，不是资源包。
配额单位是 `'%'`（`QUOTA_UNIT`），`unitLabel()` 对它显示**「额度」**而不是「积分」，
且**不参与** `normalizeUnit()` 归一（归成 credit 会把窗口百分比混进积分合计里求和）；
`formatQuotaLine` / `formatQuotaDetail` 在非配额单位下返回 `null`，
调用方原样走积分 / token 的老分支，**零影响**。

账号规格（Pro / Free / Ultra）来自另一个端点 `loadCodeAssist`，与配额**搭同一次**
`credits.balances` 回来（`RpcCreditsBalanceExtra.accountTier`），取不到时整行不渲染。

⚠️ 能力矩阵登记为 `{ balance: true, dailyCheckin: false }` —— **没有签到接口**，
故面板不渲染「一键领取积分」；`rateLimit: false`（限流是服务端配额窗口制，
清本地标记毫无意义），故不渲染「重测 / 重置」；`test: true`，见下。

### 「测试」按钮（Gemini 独有）

面板的每个账号卡多一个**「测试」**按钮：无条件真实发一条最小消息，只回报
「这一发成功了吗」，**不写任何存储**。它与既有的「重测 / 重置」是**两件事**：

| | 触发条件 | 存储副作用 | 发请求 |
|---|---|---|---|
| **测试** | 不看限流标记，**无条件** | **一个字节都不写** | 是 |
| **重测** | 只测**已有标记**的模型（无标记即零请求） | 清除通过的标记、写回新重置时刻 | 是 |
| **重置** | — | 直接清除全部标记 | 否 |

⚠️ 被测模型由 `pickTestModel` 按「调用方显式指定 > 已有的限流标记 > 全量目录第一个」
决定；三者都拿不到时**如实报错而不猜一个模型名**（猜错会得到与账号无关的 404，
把「账号不可用」与「模型名不对」混成同一条报错）。

⚠️ 「测试」与「重测」**各用一个独立能力开关**（`ACCOUNT_TEST_CAPABILITIES` /
`RATE_LIMIT_CAPABILITIES`），不能绑在一起 —— Gemini 恰好只登记了测试、没登记重测，
绑同一个开关会让其中一个按钮消失。当前只有 Gemini 登记了测试。

### 凭据与续期

凭据字段 `access_token` / `refresh_token` / `token_type` / `expires_in` / `expiry` /
`sub` / `email` / `cloudaicompanionProject`；ref 前缀 `GEMINI_ACCOUNT_<HEX>`。
`Valid()` 留 60 秒余量，**Ensure 语义 = 用前刷新**；⚠️ **refresh_token 轮换后必须
立即回写**（`refresh` 回调传 `pool` + `entry.id` 回写 `expiresAt`，否则 UI 一直显示
「已过期」而实际能正常发消息）。

⚠️ **`resolveCredential` 用的凭据与 `refresh` 要续期的那一份必须是同一个账号** ——
否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。

⚠️ **昵称取令牌响应的 `id_token` 里的 `email`**，不再依赖 userinfo 调用
（`www.googleapis.com/oauth2/v2/userinfo` 是**可静默失败**的跨域请求，失败就让昵称
退化成池 id —— 用户报障「卡片显示 Gemini 10500520」/「显示 `gemini-6a53dbca`」）。
`index.ts` 在 apply 时跑一次 `repairAccountNicknames(pool)` 补修老账号，幂等且失败不阻塞启动。

⚠️ Gemini **可续期**（Google OAuth 的 refresh_token，且会轮换），所以
`refreshAll` 定时器里**必须**登记 `['gemini', …]` 那一行 —— 漏了定时器不武装，
凭据到期后不会自动续期，用户会看到「每隔一小时就要重新登录」且日志里一个字都没有。

### ⚠️ 附带的三处跨 provider 改动

本 provider 接线时顺手修的三处**影响全部 14 个 provider**，评审时须单独看：

1. **网关状态码穿透**（`src/openai-gateway/stream.ts`）——
   ⚠️ `LlmError` 的状态码**不在顶层**（`'status' in e === false`），只在
   `e.failure.status`（`@deepseek-ai/dsh-llm` 的 `LlmFailure`）。原实现只读顶层
   ⇒ 上游声明的 404 一路退化成 502，**确定性失败被 OpenAI 客户端白重试 5 次**。
   修后 `toOpenAiSse` / `collectOpenAiCompletion` / `failureToOpenAiError` 三处都优先
   用上游自带的状态码，无则才退 502。
2. **`MISSING_MODEL_PATTERNS` 加了一条自家文案**（`model-errors.ts`）——
   `/不在本\s*provider\s*目录中/i`（gemini 拒绝未知模型名时的措辞）。只有命中它，
   `type` 才会从硬编码的 `server_error` 变成 `invalid_request_error`、`code` 变成
   `model_not_found` 并触发「你是不是想用 X」。该条只匹配本插件自己的措辞，
   不会误伤其他 provider。
3. **`registerJetHubRpc` 多了第 14 个位置参数**（`zcode` 之后、`modelAdapters` 之前）——
   只有一个调用点，但「新 provider 一律**追加在末尾**」是硬约定（插队会让既有调用点
   静默错位），由 `zcode-wiring` / `minimax-rpc` / `gemini-rpc` 三个 spec 锁住实参顺序。

### ⚠️ 排查取证

`docs/GEMINI-PORT-PLAN.md` 是完整取证记录（两轮 MITM 抓包 + oracle 探针）。
⚠️ 常量基准是 **cmdc-pak 0.8.6.1 + 0.8.8**；**0.8.9 未取证**（全量字符串加密，
静态分析失效），在钉死前不要把「前两版恒定」推广到 0.8.9。

⚠️ **仓库内没有 `test:e2e:gemini` 探针**（14 个 provider 里 12 个有，
zcode 同样没有）—— 端点全部在 `*.googleapis.com`，无法在无 Google 通路的网络
环境下运行。本 provider 的验证手段是 9 个 `tests/unit/gemini-*.spec.ts`
（共 94 条，全部桩件、零网络、零额度）。真机验证请在有 Google 通路的机器上手动
走一遍：新建账号 → 发带工具调用的多轮消息 → 确认 thinking 显示与签名回填。

