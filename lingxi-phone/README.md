# 灵犀手机适配版

在手机 DSH 内本地运行的灵犀工具接口。使用手机已有 Node，不需要电脑、Python、Termux 服务或额外监听端口。Markdown 笔记沿用“知识库”页面的同一份持久数据和已有离线索引；只有附件另存于 `$DSH_HOME/storage/lingxi-phone/`。

这是面向 DSH 的手机适配实现，不是桌面灵犀 Python/Flask 的原样移植。不提供原版独立 Web/PWA 面板、全部 REST 路由、桌面规则表迁移、外部向量服务和设备令牌管理。长期开机要求与 DSH 本身相同，Android 后台限制仍适用。

## 接入

代码进入 `$DSH_HOME/extensions/mcp/lingxi-phone/`；MCP 管理器以 `node` 及 `--home $DSH_HOME` 启动 `server.mjs`。不保存 APK 中会变化的 Node 路径，按现有 MCP 启动器解析。扩展依赖手机 profile 内已有 `yaml` 解析器，通过本机签名 Cookie 调用 DSH。认证只从现有凭据库读取，不写到配置、源码或日志。连接失败不修改原服务，配置保存前先完成工具发现。

维护者部署入口：

```sh
node scripts/deploy-lingxi-phone.mjs --serial DEVICE_SERIAL --adb-port ADB_PORT
```

该入口先只读盘点；已有同名不同配置/代码则拒绝覆盖；仅安装本扩展并新增 MCP 配置。不会重启后端、重装 APK、迁移核心或关闭已有工具。

## 日常使用

- 用 `kb_search` 搜索，`kb_read` 打开原文；精确全库提及用 `kb_mentions`。
- `kb_create` 新建笔记，原知识库页面可见。同名不同正文默认拒绝覆盖；更新必须先读 `path` 和 `revision`，过期版本会被原 DSH 笔记服务拒绝。
- `kb_upload` 将 Markdown/TXT 导入同一个笔记库；其他文件只保存为本地附件，不假称已全文检索。文本上限 2 MiB、附件上限 5 MiB。
- `kb_ask` 返回带编号的本地证据，由当前聊天模型回答；不另开云端模型请求。
- `kb_index_status` 查看原索引；`kb_index_rebuild` 启动原索引更新并返回真实任务状态。保存后沿用原自动索引设置，不新增定时器或独立索引库。
- `kb_note_hygiene` 只报告问题；`kb_memory_boundary_check` 只产生长期记忆候选。

## 记忆与权限

`memory_search` 明确返回“未配置独立长期记忆”；聊天历史、Noema 和各窗口记忆范围继续由 DSH 原工具管理。`kb_dual_search` 同时返回本地笔记命中及这个集成状态。扩展不通过工具接口读取聊天或 Noema。

四项写入工具（创建、项目日志、上传、索引更新）沿用当前 MCP 管理器的会话权限检查；只读工具在普通模式可用。QQ、云端和子代理仍受原 MCP 管理器的入口限制。

笔记路径为 `knowledge/n-UUID.md` 等分类/ID，不是桌面原库的中文物理目录。分类支持 knowledge、project、record、archive、writing、diary。状态 draft/active/archived 映射为原笔记页面的 none/doing/done。原版 dream 分类不做静默映射。

扩展不会自动同步电脑资料或凭据。覆盖升级保留依赖现有独立 MCP 保留流程；下一次 APK/核心升级仍须按手机维护契约验证本扩展实际发现和调用，不能仅凭目录存在认定兼容。

## 验证

```sh
node --test lingxi-phone/tests/*.test.mjs
```

测试使用真实 DSH Knowledge/Notes 类与本机签名 RPC、真实 stdio 子进程。手机端另外执行相同源码的独立目录验收，以及正式 MCP 工具发现/只读调用。测试目录和报告使用登记任务的 generated/，不复制整套工程。
