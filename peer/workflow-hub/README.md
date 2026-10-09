# Preset 工作流广场与插件管理

设置中的「Preset 广场」提供 7 套上游工作流、9 个技能及完整参考资源。启用后在新对话的 Preset 选择器中使用；当前对话保留已绑定版本。停用只移除后续选择入口，不删除账号、人设、已导入技能、经验和聊天。

本版适配 DSH 0.2.1-alpha.1：Persona 使用 `prefix`，技能按 Preset 隔离，共用当前运行时已有的工具。没有复制 Studio 0.1.x 的 SDK、Electron 窗口或权限实现。原始技能、许可证和脚本保存在 `presets/`；固定来源与逐文件 SHA-256 在 `source.json`，根许可证见 `LICENSE.studio`。

工作流包括数据分析、产品开发、图文内容、飞书数字员工、LLM Wiki、动效演示和产品视频。飞书可在广场配置应用 ID、密钥和默认负责人，配置只写当前设备凭据库；权限和 API 结果须实际验证。图像生成需要已登录电脑的 Codex，视频渲染需要 FFmpeg、ffprobe、HyperFrames 及对应渲染依赖。手机可以完成材料准备，工具缺失时从设备连接页进入电脑处理。动效演示产物为离线 HTML，不是 PPTX。Excel 解析依赖按输入格式检查。

「插件管理」读取当前 SDK 的实际 Bundle 和运行插件清单。电脑支持固定 NPM 版本预检查、安装/更新、启停和卸载；安装确认有效期 10 分钟且仅可使用一次。更新安装使用 SDK 自带清单/锁文件恢复与 HMR；如 SDK 返回需要重启，界面明确显示。运行中的对话阻止变更。核心、账号、Noema、设备互联及手机控制组件受保护。此入口不安装任意 Git 仓库、替换核心或批准依赖构建脚本。

手机安装及更新继续使用「插件市场」的原生备份试装入口，固定版本/提交、校验平台与 SDK；管理页面可读取实际清单，空闲时切换或卸载可管理组件。原生恢复页用于撤回试装。目录标签和静态检查不表示第三方包已经经过真机任务验证。

状态独立保存到 `$DSH_HOME/workflow-hub/state.json`。设置页 RPC 仅允许当前认证的 loopback 会话，同源页面使用 CSP。恢复状态时保留本机凭据和经验库。

「外观皮肤」默认应用「小甜桃 · 桃云」，也可切换「薄荷手记」和原版。主界面及嵌入设置页跟随 DSH 的浅色、深色和系统模式。选择原版即可撤回颜色覆盖；主题选择独立保存到 `$DSH_HOME/appearance/theme.json`，不修改角色卡。颜色与主界面选择器按当前锁定 SDK 适配，升级 SDK 时须检查实际界面。

Android 发布时 `versionCode` 和 `NodeRunner.ASSET_VERSION` 必须同步递增，确保设备刷新内置程序。打包脚本会拒绝不匹配的版本，升级保留现有用户资料。

验证：`node --test peer/workflow-hub/hub.test.mjs`。桌面源码测试通过 `node --import ./scripts/desktop-test-imports.mjs --test peer/workflow-hub/hub.test.mjs` 解析锁定 SDK。
