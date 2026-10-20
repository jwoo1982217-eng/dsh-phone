# DSH Purge 1.1.67 社区适配 community.2

基于 YuJunZhiXue 的精确正式发行包 v1.1.67，保留名称、版本、署名与 MIT 授权。适配由 DeepSeek Stream 社区维护。作者原目标为官方 0.2.0-rc.2，未声明支持社区版，本包不能代表作者支持承诺。

目标为社区版 0.2.1-alpha.1。一键安装使用客户端现有协议与插件管理器，安装位置来自当前 DSH_HOME/profileContext，不固定盘符。Web 使用当前 profiles/web。安装本身不会自动执行 Apply。

Apply 将实际当前宿主模块和第一方 bundle 复制到当前 profile 的 .dsh-purge-runtime，先备份再对私有副本执行可匹配的作者补丁。仅改动当前 profile 必需的 bundle 槽、私有 alias 依赖和对应 name guard；原插件 ID、配置与 !!js 表达式保持。共享宿主、其他 profile、用户会话和证据文件不改写。补丁失败时不挂载。Apply 与 Revert 后必须完全退出当前客户端再重新打开，界面不会自动重启。

Revert 撤销本适配拥有的配置字段并恢复私有原件，保留用户后续配置和额外插件依赖；私有副本与审计记录保留。请先 Revert 再通过社区插件管理器更新或卸载。若配置提交被中断、界面不能启动，可运行：

```
dsh-purge-community-recover --home <绝对DSH_HOME> --profile web
```

恢复命令不启动用户 profile、不扫描全机宿主，只操作明确指定 profile 的本适配私有状态；没有主目录或 profile 时不会猜测默认路径。

保留提示词面板、规则与 Skill 管理、重试/续答/回退接口和演练台服务。提示词、规则、Skill 与演练台数据使用当前 DSH_HOME，因此相同主目录下的多个 profile 可能共享这些文件。启动保留自定义提示词、既有演练台 preset、技能、setup 和 anchor；演练台自动迁移只补缺列/缺默认项，不删除旧阶段、历史得分、旧列或重写既有记录。所有允许的用户写入拒绝链接、junction 和越界路径。

已在隔离主目录中使用实际 0.2.1-alpha.1 源码验证：发行包接收；真实 Web/base/preset 组合、Cordis Loader、Apply/Revert、私有模块 render 改变；48 个私有行保留原 ID，30处 !!js 求值保留；ConfigEditor/Settings 编辑后恢复和另装插件后的 alias 持久性；失败前撤销、崩溃状态恢复；实际 UI factory、规则/Skill 操作；演练台服务/工具/HTTP 路由、旧 SQLite 数据和自定义资产保护。

真实 Web 组合结果为34项 applied、11项 already、0项 failed、30项未匹配。未匹配项包括桌面专用、缺少可选第三方模块与不同版本布局，结果会显示；这不代表所有作者补丁都生效。宿主全局 deny-hook 修改、官方 ASAR、全局 CLI、原生自更新/自卸载及自动重启禁用。完整 Electron、模型 API、每种 preset 和回退业务未进行端到端执行。

精确发行包 SHA256、全部代码修改清单及验证边界见 COMMUNITY-ADAPTATION.json。

## community.2 安装修复

修复社区客户端临时安装试运行目录识别：接受启动器提供的、UUID 一致的隔离候选 profile 和独立试运行主目录。候选阶段仍禁止 Apply/Revert 和共享宿主修改；原生安装不需要 AI 适配。修复包使用新的不可变 SHA256，原包与用户数据保留。

桌面启动器自身拥有的默认模块不能由插件私有 bundle 替换。仅对已核实来自当前真实启动器 defaults/overlays 的行保留原模块、ID 与配置，并通过 unsupportedRows 报告具体未挂载项；无法证明来源的行继续拒绝。可挂载补丁仍需 Apply 后完全退出并重开客户端。
