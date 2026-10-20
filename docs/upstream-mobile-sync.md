# DSH 手机端：官方参考仓库兼容吸收

参考仓库：[kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk/tree/c8a53338e192dbe90b6ba7c49272c7f37feb5d60)。固定提交 `c8a53338e192dbe90b6ba7c49272c7f37feb5d60`，对照日期 2026-10-20。

## 原则与基线

这是能力级移植，不是替换 APK、包名、签名、运行目录或整套 Termux 快照。保留本项目的账号、QQ、Noema、技能、人设、MCP、远程连接及已有手机控制权限边界。

参考仓库 `app/build.gradle.kts` 的源码版本为 **0.14.8/code52**，`scripts/contract.json` 的引擎迁移目标为 **0.2.1-rc.2**。其 README 仍显示 0.14.6 与 0.2.0-rc.2，不能据此判断当前源码或已发布 APK。这里不声称上游目标已构建、已发布或已运行。本项目固定核心 **0.2.1-alpha.1**，本批不改核心、资源解压版本或应用版本。

## 第一批已实现的源码改动

1. **图片与普通附件分流**：显式纯图片 accept 使用 Android 13+ 系统照片选择器；旧 Android 和照片选择器不可用时使用图片内容选择器。空 accept、Markdown、ZIP、混合类型仍使用完整文档选择器。无新增存储权限；保留单选/多选、取消与重试语义。两个请求不能抢同一个系统结果，跳转或 renderer 销毁后取消旧回调。
2. **主界面恢复**：渲染进程退出后只销毁并重建主 WebView，同一 Activity 保留目标会话 URL 与已有原生队列；不重启引擎、不重新处理分享 Intent。后台驱逐延迟至前台恢复，未成功加载前反复退出停止自动重建，提供“服务 → 重新加载界面”。前后台代次拒绝过期探测结果，成功加载取消过期重载。已有账号弹窗同样消费 renderer 退出。
3. **浏览器唯一元素引用**：`read` 元素保留 `selector` 字段，新增 `ref`；把返回的 selector 原样传给现有 click/type 即可精确指向对应节点。引用来自最近一次快照，DOM 替换、导航或新快照后拒绝旧引用。唯一 CSS 仍可用，匹配多个节点时明确报错，不再静默操作第一个。保留原有 tabId、标签归属、会话权限及停止语义；不增加任意 JS 执行工具。
4. **确认死亡后的重启退避**：仅真实退出或启动失败进入 5/10/20/40/80 秒退避；第 12 次连续失败暂停自动恢复，界面显示原因。稳定运行两分钟或用户明确“启动服务/重启”后恢复预算，停止及维护操作取消已排队重启。活进程、慢 HTTP 和长推理都不触发强杀，也不自动回滚用户配置。

WebView renderer 已丢失时，仅存在于其内存、未由原前端持久化的未发送草稿无法保证恢复。以上自动恢复预算仅覆盖当前应用进程生命周期。

## 后续独立适配项（本批未实现）

- **核心追版到 0.2.1-rc.2**：需逐包核验现有 SDK/前端覆盖及私有 SDK 副本，不得整套覆盖；继续执行 `phone-upgrade-contract.md`。
- **官方虚拟屏工作台**：需移植 Shizuku UserService、displayId 注册、坐标与截图认屏、输入和回收契约，并保持本项目会话及用户授权边界。
- **SAF 工作区目录桥**：本项目已有共享存储权限与附件选择，但不等价于官方一次性目录 token / pickDirectory 桥；需连接现有工作区 API，不能把 content URI 假装为可执行路径。
- **独立原生交互终端/离线修复页**：现有工具环境、日志及备份恢复不等价于引擎离线时的独立终端。
- **APK / 运行时在线更新**：必须指向本项目的版本、签名、依赖闭包及发布渠道；不能安装官方不同包名/签名 APK，或把官方快照换进本项目。
- **分享即建隔离临时工作区与 TTL**：已有分享/打开文件接收保留；官方强制新建会话与七天清理不直接移植，避免改变当前附件归属或删除用户记录。
- **浏览器视口/身份档及额外工具**：当前固定视口和既有 12 个浏览器工具保持，不冒称已移植官方完整工作台。

## 验证入口

```sh
./gradlew :app:testDebugUnitTest
node scripts/browser-dom-ui.test.mjs
node --test peer/mcp-manager/manager.test.mjs peer/mcp-manager/upgrade.test.mjs phone-control/control.test.mjs scripts/gateway-policy-error.test.mjs scripts/adaptive-compaction.test.mjs scripts/compaction-recovery.test.mjs
```

使用 Android Studio 自带 JDK 17+ 或本机匹配的 JDK。浏览器测试沿用现有测试环境中的 Playwright，可通过 `DSH_PLAYWRIGHT_MODULE` 指定模块文件。JVM/Robolectric 和 Chromium 回归不能代替真实 Android WebView、系统照片选择器或 APK 覆盖升级验收；未连接设备时不进行安装或启动服务。

## 来源及许可

`ForegroundPageRecoveryPolicy` 和其基础测试直接适配上游对应文件；照片分流、浏览器引用与退避按上游能力在本项目接口内实现。MIT 全文随 APK 位于 `assets/licenses/dsh-mobile-apk-MIT.txt`。所有新增能力继续遵守本项目维护契约。
