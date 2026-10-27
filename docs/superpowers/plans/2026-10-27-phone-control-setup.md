# Phone Control Setup Implementation Plan

> Inline execution of the user-approved design with the executing-plans skill; preserve unrelated work and the index.

**Goal:** 一个入口检查并引导修复手机控制后端，复用已有授权，不增加任务批准。

**Architecture:** `ControlSetup.kt` 负责只读状态与下一配置步骤；`ControlActivity.kt` 渲染独立状态并执行由本人点击发起的配置流程。保持原有 NativeControlBridge、ControlLease 及工具动作逻辑。

**Tech Stack:** Android SDK 36, Kotlin, Robolectric, 已验证 alpha.1 维护包。

- [x] 在 `app/src/test/java/com/dshphone/control/ControlSetupTest.kt` 验证旧页面缺少“开启并检查”；实际运行并保留失败证据。
- [x] 新建 `app/src/main/java/com/dshphone/control/ControlSetup.kt`，将受限设置、无障碍未开启/等待连接、Shizuku 未运行/未授权、Termux 未安装/未授权区分，保留未知状态。
- [x] 修改 `app/src/main/java/com/dshphone/control/ControlActivity.kt`；配置按钮自动跳过已完成步骤，返回后复查，取消不重弹，立即停止不变。
- [x] 新建 `scripts/prepare-control-apk.py`，只从验证的 122 APK 和稳定源码重建 native UI；资源保持 122，应用升级 123。未知输入零覆盖拒绝。
- [x] 在本任务 `generated/project` 复用共享 Gradle 缓存执行 `testDebugUnitTest --tests com.dshphone.control.ControlSetupTest --tests com.dshphone.control.PhoneControlNativeTest`，再构建 arm64 Debug APK。
- [x] 验证签名、运行 tar/原生库保持、独立 Android UID 设置页面及失败回退。正式安装只在目标会话 running=0 时执行，并核对无障碍/受限设置、用户数据和 MCP 基线。
- [x] 保存回执、必要恢复材料与 APK；记录真实问题，不把模拟测试冒称生产功能验收；结束时按任务产物规范收尾。

实机验收：联想 local-user，0.2.18/code123，资源122 与 SDK alpha.1 保持。原生按钮调用实际 Shizuku UserService 恢复受限设置及无障碍；随后直接走 native execute/read 路径自动重连并完成计算器界面读取，原聊天授权不变、无新增批准。没有发模型请求。54 会话、12 账号、5 组 MCP 配置和工具列表保留。回执：`/Users/example/.codex/work/dsh-phone-control-recovery-20261027/verification.json`。
