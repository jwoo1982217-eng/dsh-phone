# 独立原生终端

入口：服务菜单 → 独立终端；原生 Activity 为 `com.dshphone.terminal.TerminalActivity`，仅应用内显式跳转。不得导出 Activity、添加命令 Intent 或网页 JavaScript 执行桥。

## 官方能力对齐与边界

- 使用 APK 已带入 `nativeLibraryDir/libbash.so`，不依赖 DSH 核心/网页/本地 HTTP 端口存活。原生界面有执行、停止、重连、清屏、复制及文本选择。
- 与官方控制台一样是**非 PTY、按行执行**；不承诺 vim、top、密码输入或终端光标/颜色控制等完整 PTY 行为。当前不做 PTY 模拟。
- 单一 Bash 保留 `cd`、变量等会话状态，stdout/stderr 合流；单次输入最多 8192 个 UTF-16 单元，最多 8 条待写命令，展示最后 65536 个 UTF-16 单元。输出只存内存，不自动保存到文件或上传；复制才写系统剪贴板。
- 使用原有 `NodeRunner.prepareEnvironment` 的 HOME、DSH_HOME、PATH、库及工具路径；该函数会按既有方式准备 bin 符号链接、tmp，以及控制/图像 socket，**不会启动核心**。缺少 Bash 或工具环境时直接说明，不调用 `ensureExtracted`、资源迁移或重装，不覆盖 profile/插件/用户资料。
- 不执行自动诊断命令、模型调用、示例或 Intent 携带的命令；仅用户点“执行”时提交文本。Bash 不读取用户 `.bashrc`、profile 或继承的 `BASH_ENV`/`ENV` 启动钩子。用户主动输入的命令具有应用已有的权限，命令可能修改文件，不会新增系统权限。
- PID 由受控 Bash 启动脚本回报到应用私有临时文件，仅用于生命周期管理；不向 UI/网页暴露执行桥。停止、重连、页面销毁及旋转时，按真实 `/proc` 父子关系和启动时刻校验清理后代进程，再停止 Bash。后台 job 的 EXIT trap 同样按 job process group 发送 TERM；不扫杀其他应用或现有核心进程。此清理覆盖可追溯的会话子树，不保证追杀用户主动脱离/重挂父进程的守护程序。
- 页面切后台不立即杀命令；**关闭或旋转销毁页面会终止命令，不恢复旧命令，不自动重放**。输出不跨销毁保存。若 `/proc` 无法确认新 Bash 身份则拒绝打开，防止产生不可管理的命令会话。Android 权限仍限制其他应用的私有目录。

## 验证

纯 JVM 测试通过真实 `/bin/bash` 验证状态、按行执行、目录保持、stderr、UTF-8、无换行大输出限额、停止/重连/旧代输出隔离、关闭时迟到进程清理、启动失败及重试；`/proc` parser 与子树算法用确定性夹具验证。Android 原生 UI 测试覆盖不执行外部 Intent、输入限额、页面销毁清理。

JVM / Robolectric 证据不能替代 Android 真机原生 Bash、旧版覆盖升级或设备 `/proc` 可见性验收。最终 APK/安装/设备实测状态由本次总交付记录单独说明。
