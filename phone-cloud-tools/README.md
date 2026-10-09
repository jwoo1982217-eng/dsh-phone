# 手机工具箱：外部 AI 通用接入包

0.2.1 接入包与手机 DSH 0.1.44 将入口统一为「手机工具箱」，附带 Codex、桌面 DeepSeek Harness 和 Hermes 配置示例。外部 AI 申请工具，手机本人批准后在本地执行，再把结果返回。连接使用标准 MCP stdio，不依赖某一种 Agent 或模型。

这份包连接 **外部 Agent 的 MCP 客户端 → 连接器 → 加密中继 → DSH 手机工具箱**。手机主动向中继连出；不用开放手机公网端口。Agent 可以运行在电脑或服务器上，负责理解任务、选择模型和安排步骤，手机提供选定的技能、文件、可信脚本和原生 App 操作。中继地址两端可达即可，无需同一局域网。它与现有电脑远程控制使用独立的配对密钥。

需要在手机上与自己部署的 Hermes 聊天时，可选用另一个「远程 Hermes」入口，见 [远程聊天接入说明](REMOTE.md)。仅让 Codex 或桌面 DSH 调用手机工具，无需配置该入口。

## 当前交付范围

手机 DSH 0.1.44 在「设置」和原生「服务」菜单提供「手机工具箱」；0.1.42/0.1.43 的旧名称是「云端工具集」，原有配对与共享设置保留。接入包包含 Node MCP stdio 连接器、中继、配对保存器、连接检查器、三种客户端配置与 TLS 代理示例。连接器所在电脑或服务器需要 **Node 22 或更高版本**，推荐 Node 24。发行 ZIP 已包含 `ws` 8.22.0 及其 MIT 许可证，不需要 `npm install`；从源码运行则先安装 `package.json` 的依赖。

可先安装手机包、查看页面和本地工具，准备好连接器与中继后再配对。真实桌面 DSH MCP 插件已在隔离环境调用工具箱、执行示例脚本并读取实际文件；未批准、重复执行及撤销后访问也已核验。这不代表已连接使用者的手机、调用过 Codex 模型或完成公网 TLS 联调。

## 按顺序接入

1. 将发行 ZIP 解压到运行 Agent 的电脑或服务器专用目录，例如 `/opt/dsh-phone-tools`，由该 Agent 的非 root 用户拥有。确认 `node --version`。发行包里不包含配对密钥、API key 或手机资料。
2. 在该目录运行 `node bin/relay.mjs`，中继只监听 `127.0.0.1:8789`。用有效域名和证书部署 HTTPS 反向代理；参照 `nginx-relay.example.conf`。手机要使用 `wss://你的域名/relay`，不能使用未加密公网 `ws://`。也可以使用已有兼容 DSH 中继的新房间。`relay.service.example` 是可选持久运行示例，先修改用户名与 Node 路径。
3. 手机打开 DSH 的 **服务 → 手机工具箱** 或 **设置 → 手机工具箱**，填入中继地址，点击「建立新配对」，然后「显示配对链接」。这是含密钥的私有连接信息，不要发到聊天群或公开仓库。
4. 连接器所在机器执行：

   ```sh
   cd /opt/dsh-phone-tools
   mkdir -m 700 private
   node bin/pair.mjs private/phone-pair.json
   ```

   在终端交互提示里粘贴手机链接。文件权限为 600；不把链接放在命令参数、环境变量或日志。重新配对时先删除旧的配对文件再保存新链接。
5. 手机勾选要共享的技能和工具，勾选「启用工具连接」，点击「保存共享范围与连接状态」。示例工具「整理本地笔记」默认没有启用。
6. 保持手机 DSH 服务运行，在连接器机器执行 `node bin/check.mjs private/phone-pair.json`。看到 `connected:true` 后结束检查器，再启动 Agent。一个配对房间同时只允许一个连接器；更换客户端前先关闭旧连接器。
7. 按下方客户端示例合并配置，调整连接器和私有配对文件的两个绝对路径，保留原模型、账号和其他插件配置。重启对应客户端，让它发现 `phone_*` 工具；再调用只读的 `phone_status` 确认手机在线。工具目录载入完成不代表加密连接已完成，离线时先排查连接，不重试有副作用的操作。

## 选择你的 AI 客户端

| 客户端 | 示例 | 配置位置 |
| --- | --- | --- |
| 本机 Codex 桌面端 / CLI | `codex-config.example.toml` | Codex 的 `config.toml` 中 `[mcp_servers.phone_tools]` |
| 桌面 DeepSeek Harness | `dsh-config.example.yaml` | 专用 profile 的 `cordis.yml` 插件列表 |
| 自己部署的 Hermes | `hermes-config.example.yaml` | 专用 profile 的 `mcp_servers` 配置 |
| 其他 MCP stdio 客户端 | `mcp-config.example.json` | 按该客户端的格式配置命令与参数 |

### Codex

Codex 支持启动本地 MCP stdio 进程。把 `codex-config.example.toml` 合并到 `~/.codex/config.toml`，或受信项目的 `.codex/config.toml`，两个路径改为你实际解压目录下的文件。连接器在 Codex 所在机器运行，通过中继访问手机；手机无需与电脑处于同一 Wi-Fi。

也可在改好路径后使用官方 CLI 注册：

```sh
codex mcp add phone_tools -- node /opt/dsh-phone-tools/bin/mcp.mjs --pair-file /opt/dsh-phone-tools/private/phone-pair.json
```

示例 TOML 将 Codex 工具确认设为 `prompt`；手机上的任务与逐次操作确认仍独立生效。查看配置用 `codex mcp get phone_tools --json`，重启客户端后查看已连接工具并调用 `phone_status`。安装接入包或修改示例文件不会让当前聊天自动获得手机权限。托管网页/云端聊天还需其平台提供对应工具接入能力，不能直接使用本机配置文件。

官方参考：[OpenAI MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

### 桌面 DeepSeek Harness

将 `dsh-config.example.yaml` 中的插件条目合并进专用 profile 的 `cordis.yml`，先确认已安装与当前 DSH SDK 兼容的 `@deepseek-ai/dsh-mcp-client`。示例使用 `serverName: phone_tools`、`transport: stdio`，关闭连接器进程的自动重启。工具在 DSH 中注册为 `mcp__phone_tools__phone_status` 等名称。模型需要支持工具调用；仍先检查状态，再申请具体任务。

### Hermes 和其他客户端

将 `hermes-config.example.yaml` 的 `phone_tools` 段合并到自己的 Hermes 专用 profile 配置，关闭并行工具调用。其他客户端可参考通用 JSON 的命令与参数；不同客户端的配置格式可能不同，以其文档为准。

官方参考：[Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)、[MCP 配置](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)。配置中的 `trust: full` 指本机自有连接器；手机仍独立验证每项授权，不由 Hermes 的信任标记跳过。

## 实际操作流程

对已接入的 AI 说「通过手机工具整理这段笔记」。它先 `phone_task_request`，你在手机工具箱确认任务；任务批准后，文件接口只能访问此任务独立目录。`phone_local_tools` 给出已启用工具的参数定义，`phone_local_run` 提出一次运行申请；你核对源码、参数与摘要并批准后，AI 用 `phone_operation_execute` 执行。示例产物是手机任务目录中的 `note.txt`，可以通过 `phone_workspace_read` 查看。

写文件也分为申请、手机逐次确认、执行三个步骤。执行返回回执，重复同一 `operationId` 不会再次写入或运行脚本；一个 `requestId` 不能改内容。文件若在批准后变化，写入拒绝。超时/中断可能已经产生副作用，应先查看产物，不更换编号自动重跑。

App 操作先从 `phone_status` 获取精确包名，任务申请限定 App 范围。手机工具箱批准任务后还须 `phone_app_request`，本人在 **服务 → 手机操作** 的原生页面确认并自行启用必要的无障碍权限。未知按钮、坐标、敏感动作继续原生逐次确认；系统授权、密码字段、桌面启动器和 DSH 自身界面不开放。真实跨 App 操作需要用户在目标 App 上验收。

完成后调用 `phone_task_stop`。手机可随时停止任务、暂停连接或撤销配对。断线、连接范围变更、服务重启和超时会撤销全部外部工具任务；重连不恢复旧授权、不重放动作。已有普通手机会话和 QQ 的权限规则保持独立。

## 加入自己的本地工具

在手机工具箱「导入可信工具 JSON」选择工具包；页面先展示内容与 App 权限说明，由本人确认导入。新工具默认不向外部 AI 开放，勾选保存后才能申请。现有 ID 不覆盖，更新用新 ID 保留旧版。

工具包格式见发行包 `note-normalize.tool.json`：`id/title/description/inputSchema/source/exampleArgs`。首版支持单文件 Node ES module 与内置模块，参数对象以 `process.argv[2]` 的 JSON 传入，工作目录是当前任务目录。源码最多128 KiB，参数支持对象、数组、字符串、整数、数字、布尔与枚举；不支持自动安装依赖、任意 shell、相对文件导入。每次确认后执行冻结源码，后续改文件不会偷偷换成本次批准之外的代码。参数 JSON 上限64 KiB，运行上限30秒，输出上限64 KiB。手机页面显示最近10项结果与当前服务的调用记录；重启后旧任务授权失效。

**可信工具具有 Android App UID 权限，工作目录不是操作系统沙箱。** 只导入自己审核或信任的代码，不能把恶意插件当作通过此机制隔离了。执行器不会继承模型密钥环境变量，但受信代码仍可能访问 App 私有文件。纯文字技能只共享正文；含脚本技能需要将可执行部分适配为本地工具，附件不会自动上传云端或变成执行授权。本地存放和执行也不保证云端平台允许该工具调用。

## 边界与排查

- 配对信任电脑或服务器上的专用 Agent 实例。MCP stdio 进程不提供不同 Agent 对话之间的独立身份认证；请勿把同一连接器和任务 ID 交给不可信的多用户服务。
- 文件接口仅当前任务的平面目录，普通文件最多128 KiB；拒绝路径越界和符号链接。技能只返回勾选的正文，角色卡、凭据、其他任务 ID 不在工具目录中。
- 「等待工具连接器」时检查手机服务、地址证书、代理 WebSocket 升级配置及是否重复启动连接器。连接离线没有自动任务重试。
- 重新配对后旧链接失效，服务器需重新保存。Android 升级要覆盖安装，保留原账号与资料；不要卸载或清数据。
- 中继只能转发端到端加密消息；仍能看到连接元数据，也能中断通信。它没有手机管理 RPC、模型 key 或脚本执行接口。
