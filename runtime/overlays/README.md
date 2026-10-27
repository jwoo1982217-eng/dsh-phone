# DSH 0.2.1-rc.2 Android 增量适配

基于官方 dsh-v0.2.1-rc.2 发布产物；保留上游新版API、依赖和MIT许可，不使用alpha.1整包覆盖。官方手机对照提交为1a8f9fb309580c8c1a3c826272c8da17c9e4877b。

- 保留Android内置loader、Bionic Bash、native flock/no-replace发布、附件图像IPC、文件工具、技能目录、长会话分段压缩和故障恢复；非Android仍使用官方实现。
- 保留新版claims/AgentPreset/runtime-context生命周期与完整消息语义。conversation/edit为required事件，旧格式编辑冷读不复活；任意/多选/范围/局部删除及复制、分享、显式归入记忆保持。
- rc.2 browser/node双connection入口保留本机离线恢复；Host RPC兼容旧插件无webServer声明但使用真实子注入上下文注册，认证/Origin/owner销毁约束不变。
- 模型搜索/收藏/最近/来源与rc.2 label slot保持；附件codec/策略拒绝展示/Team选模保持；SAF只扩展选择flow，保留官方DirectoryBrowser。
- 模型界面由runtime/client-src/model-picker.jsx与scripts/build-model-picker.mjs生成；会话动作由scripts/build-conversation-actions.mjs刷新。生成器拒绝未审SDK或混版本，不能靠替换版本字符串升级。
- 用户已启用的社区私有SDK另走hash识别、完整依赖闭包与同一恢复事务；私有策略不得混入公共默认包。迁移旧required编辑、rewind、额外插件与旧备份时遵循docs/phone-upgrade-contract.md。

测试、打包、Android覆盖升级、正式安装与实际加载分别验收；源码通过不代表正式手机已升级。原alpha.1源码及测试回执留在本机私有备份。
